use super::*;
use std::collections::VecDeque;

/// One planned tab action: `(window_index, tab_index, url)` — the tuple
/// `plan_actions` returns and `apply_actions` consumes.
type TabAction = (u32, u32, String);

struct FakeIo {
    blocks: Option<Vec<BlockInfo>>,
    events: bool,
    frontmost: Option<String>,
    running: Vec<SupportedBrowser>,
    methods: HashMap<SupportedBrowser, bool>,
    reads: HashMap<SupportedBrowser, VecDeque<Result<Vec<Tab>, AutomationError>>>,
    applies: HashMap<SupportedBrowser, VecDeque<Result<(), AutomationError>>>,
    read_calls: Vec<SupportedBrowser>,
    running_calls: usize,
    apply_calls: Vec<(SupportedBrowser, Vec<TabAction>)>,
    permissions: Vec<(SupportedBrowser, PermState)>,
}

impl FakeIo {
    fn new(blocks: Vec<BlockInfo>, running: &[SupportedBrowser]) -> Self {
        Self {
            blocks: Some(blocks),
            events: false,
            frontmost: None,
            running: running.to_vec(),
            methods: HashMap::new(),
            reads: HashMap::new(),
            applies: HashMap::new(),
            read_calls: Vec::new(),
            running_calls: 0,
            apply_calls: Vec::new(),
            permissions: Vec::new(),
        }
    }

    fn queue_read(&mut self, browser: SupportedBrowser, result: Result<Vec<Tab>, AutomationError>) {
        self.reads.entry(browser).or_default().push_back(result);
    }

    fn queue_apply(&mut self, browser: SupportedBrowser, result: Result<(), AutomationError>) {
        self.applies.entry(browser).or_default().push_back(result);
    }
}

impl AutomationIo for FakeIo {
    fn active_blocks(&mut self) -> Option<Vec<BlockInfo>> {
        self.blocks.clone()
    }

    fn events_active(&self) -> bool {
        self.events
    }

    fn frontmost_bundle_id(&self) -> Option<String> {
        self.frontmost.clone()
    }

    fn running_browsers(&mut self) -> Vec<SupportedBrowser> {
        self.running_calls += 1;
        self.running.clone()
    }

    fn uses_automation(&mut self, browser: SupportedBrowser) -> bool {
        self.methods.get(&browser).copied().unwrap_or(true)
    }

    fn read_tabs(&mut self, browser: SupportedBrowser) -> Result<Vec<Tab>, AutomationError> {
        self.read_calls.push(browser);
        self.reads
            .get_mut(&browser)
            .and_then(VecDeque::pop_front)
            .unwrap_or_else(|| Ok(Vec::new()))
    }

    fn apply_actions(
        &mut self,
        browser: SupportedBrowser,
        actions: &[(u32, u32, String)],
    ) -> Result<(), AutomationError> {
        self.apply_calls.push((browser, actions.to_vec()));
        self.applies
            .get_mut(&browser)
            .and_then(VecDeque::pop_front)
            .unwrap_or(Ok(()))
    }

    fn set_permission(
        &mut self,
        shared: &Arc<Mutex<Shared>>,
        browser: SupportedBrowser,
        state: PermState,
        denied_retry: Duration,
        now: Instant,
    ) {
        self.permissions.push((browser, state));
        let mut state_guard = shared.lock().expect("fake shared state");
        let runtime = state_guard.runtimes.entry(browser).or_default();
        runtime.state = state;
        if state == PermState::Denied {
            runtime.next_attempt = now + denied_retry;
        }
    }
}

fn tick_shared() -> Arc<Mutex<Shared>> {
    Arc::new(Mutex::new(Shared::default()))
}

fn parked_tab(base: &str, original: &str) -> Tab {
    Tab {
        window_index: 1,
        tab_index: 1,
        url: build_blocked_url(base, original, &[]),
    }
}

fn block(id: &str, mode: &str, domains: &[&str], started_at: u64, ends_at: u64) -> BlockInfo {
    BlockInfo {
        blocklist_id: id.to_string(),
        name: Some(id.to_string()),
        emoji: None,
        color: None,
        mode: mode.to_string(),
        domains: domains.iter().map(|d| (*d).to_string()).collect(),
        apps: vec![],
        source: "activeBlock",
        ends_at: Some(ends_at),
        started_at: Some(started_at),
    }
}

#[test]
fn tick_arms_restore_latch_while_enforcement_is_active() {
    let shared = tick_shared();
    let mut io = FakeIo::new(
        vec![block("reddit", "blocklist", &["reddit.com"], 0, 999)],
        &[],
    );
    let mut needs_restore = false;
    let mut last_full_pass = None;
    tick_with_io(
        &mut io,
        &shared,
        "file:///blocked.html",
        &mut needs_restore,
        &mut last_full_pass,
        Instant::now(),
    );
    assert!(needs_restore);
}

#[test]
fn pause_restore_retries_until_a_pass_finds_nothing_left_parked() {
    let shared = tick_shared();
    let browser = SupportedBrowser::Brave;
    let base = "file:///blocked.html";
    let original = "https://reddit.com/r/test";
    let mut io = FakeIo::new(
        vec![block("reddit", "blocklist", &["reddit.com"], 0, 999)],
        &[browser],
    );
    io.queue_read(
        browser,
        Ok(vec![Tab {
            window_index: 1,
            tab_index: 1,
            url: original.to_string(),
        }]),
    );
    io.queue_read(browser, Ok(vec![parked_tab(base, original)]));
    io.queue_apply(browser, Ok(()));
    io.queue_apply(browser, Ok(()));
    let mut needs_restore = false;
    let mut last_full_pass = None;
    let start = Instant::now();

    tick_with_io(
        &mut io,
        &shared,
        base,
        &mut needs_restore,
        &mut last_full_pass,
        start,
    );
    assert!(needs_restore);

    io.blocks = Some(Vec::new());
    tick_with_io(
        &mut io,
        &shared,
        base,
        &mut needs_restore,
        &mut last_full_pass,
        start + Duration::from_secs(1),
    );

    // The restore was applied, but `apply_actions` cannot tell us that the
    // tab actually navigated — it wraps every `set URL` in its own `try`,
    // so a stale index is swallowed and still reports Ok. The latch stays
    // armed until a later pass observes that nothing is parked any more.
    assert!(needs_restore);
    assert_eq!(io.apply_calls.len(), 2);
    assert_eq!(io.apply_calls[1].1[0].2, original);

    // Third tick: the queue is empty, so the browser reports no parked
    // tabs. Only now may the latch clear.
    tick_with_io(
        &mut io,
        &shared,
        base,
        &mut needs_restore,
        &mut last_full_pass,
        start + Duration::from_secs(2),
    );
    assert!(!needs_restore);
    assert_eq!(io.apply_calls.len(), 2, "nothing left to restore");
    assert_eq!(io.running_calls, 3, "restore must scan background browsers");
}

#[test]
fn silently_dropped_restore_is_retried_on_the_next_pass() {
    let shared = tick_shared();
    let browser = SupportedBrowser::Brave;
    let base = "file:///blocked.html";
    let original = "https://example.com/";
    // No active blocks: this is the post-pause restore pass.
    let mut io = FakeIo::new(Vec::new(), &[browser]);
    // Both reads still show the tab parked on the block page even though
    // the apply reported success — the real failure mode when a window or
    // tab index goes stale mid-tick, because `apply_actions` swallows it
    // in a per-action `try` block.
    io.queue_read(browser, Ok(vec![parked_tab(base, original)]));
    io.queue_read(browser, Ok(vec![parked_tab(base, original)]));
    io.queue_apply(browser, Ok(()));
    io.queue_apply(browser, Ok(()));
    let mut needs_restore = true;
    let mut last_full_pass = None;
    let start = Instant::now();

    tick_with_io(
        &mut io,
        &shared,
        base,
        &mut needs_restore,
        &mut last_full_pass,
        start,
    );
    assert!(needs_restore, "tab is still parked; latch must stay armed");

    tick_with_io(
        &mut io,
        &shared,
        base,
        &mut needs_restore,
        &mut last_full_pass,
        start + Duration::from_secs(1),
    );
    assert_eq!(io.apply_calls.len(), 2, "restore must be retried");
    assert_eq!(io.apply_calls[1].1[0].2, original);
}

#[test]
fn failed_restore_action_keeps_latch_for_a_later_retry() {
    let shared = tick_shared();
    let browser = SupportedBrowser::Chrome;
    let base = "file:///blocked.html";
    let original = "https://example.com/";
    let mut io = FakeIo::new(Vec::new(), &[browser]);
    io.queue_read(browser, Ok(vec![parked_tab(base, original)]));
    io.queue_read(browser, Ok(vec![parked_tab(base, original)]));
    io.queue_apply(browser, Err(AutomationError::Other("temporary".into())));
    io.queue_apply(browser, Ok(()));
    let mut needs_restore = true;
    let mut last_full_pass = None;
    let start = Instant::now();

    tick_with_io(
        &mut io,
        &shared,
        base,
        &mut needs_restore,
        &mut last_full_pass,
        start,
    );
    assert!(needs_restore);
    tick_with_io(
        &mut io,
        &shared,
        base,
        &mut needs_restore,
        &mut last_full_pass,
        start + Duration::from_secs(1),
    );
    assert_eq!(io.apply_calls.len(), 2, "the failure must be retried");
    assert!(needs_restore, "not yet verified clean");

    // Queue exhausted: the browser now reports no parked tabs, which is
    // the only evidence that the retry landed.
    tick_with_io(
        &mut io,
        &shared,
        base,
        &mut needs_restore,
        &mut last_full_pass,
        start + Duration::from_secs(2),
    );
    assert!(!needs_restore);
}

#[test]
fn permission_denial_is_backed_off_but_retried_while_blocking() {
    let shared = tick_shared();
    let browser = SupportedBrowser::Safari;
    let mut io = FakeIo::new(
        vec![block("reddit", "blocklist", &["reddit.com"], 0, 999)],
        &[browser],
    );
    io.queue_read(browser, Err(AutomationError::NotAuthorized));
    io.queue_read(browser, Ok(Vec::new()));
    let mut needs_restore = false;
    let mut last_full_pass = None;
    let start = Instant::now();

    tick_with_io(
        &mut io,
        &shared,
        "file:///blocked.html",
        &mut needs_restore,
        &mut last_full_pass,
        start,
    );
    assert_eq!(io.read_calls, vec![browser]);
    assert_eq!(
        shared
            .lock()
            .expect("shared state")
            .runtimes
            .get(&browser)
            .map(|r| r.state),
        Some(PermState::Denied)
    );

    tick_with_io(
        &mut io,
        &shared,
        "file:///blocked.html",
        &mut needs_restore,
        &mut last_full_pass,
        start + Duration::from_secs(1),
    );
    assert_eq!(
        io.read_calls,
        vec![browser],
        "denial should be rate-limited"
    );

    tick_with_io(
        &mut io,
        &shared,
        "file:///blocked.html",
        &mut needs_restore,
        &mut last_full_pass,
        start + DENIED_RETRY_WHILE_BLOCKING + Duration::from_millis(1),
    );
    assert_eq!(io.read_calls, vec![browser, browser]);
}

#[test]
fn transient_tab_query_failure_does_not_clear_restore_latch() {
    let shared = tick_shared();
    let browser = SupportedBrowser::Brave;
    let mut io = FakeIo::new(Vec::new(), &[browser]);
    io.queue_read(
        browser,
        Err(AutomationError::Other("browser quitting".into())),
    );
    io.queue_read(browser, Ok(Vec::new()));
    let mut needs_restore = true;
    let mut last_full_pass = None;
    let start = Instant::now();

    tick_with_io(
        &mut io,
        &shared,
        "file:///blocked.html",
        &mut needs_restore,
        &mut last_full_pass,
        start,
    );
    assert!(needs_restore);
    tick_with_io(
        &mut io,
        &shared,
        "file:///blocked.html",
        &mut needs_restore,
        &mut last_full_pass,
        start + Duration::from_secs(1),
    );
    assert!(!needs_restore);
}

#[test]
fn frontmost_browser_runs_each_tick_background_runs_on_full_cadence() {
    let shared = tick_shared();
    let frontmost = SupportedBrowser::Chrome;
    let background = SupportedBrowser::Brave;
    let mut io = FakeIo::new(
        vec![block("reddit", "blocklist", &["reddit.com"], 0, 999)],
        &[frontmost, background],
    );
    io.events = true;
    io.frontmost = Some(frontmost.bundle_id().to_string());
    let mut needs_restore = false;
    let mut last_full_pass = None;
    let start = Instant::now();

    tick_with_io(
        &mut io,
        &shared,
        "file:///blocked.html",
        &mut needs_restore,
        &mut last_full_pass,
        start,
    );
    assert_eq!(io.read_calls, vec![frontmost, background]);
    tick_with_io(
        &mut io,
        &shared,
        "file:///blocked.html",
        &mut needs_restore,
        &mut last_full_pass,
        start + Duration::from_secs(1),
    );
    assert_eq!(io.read_calls, vec![frontmost, background, frontmost]);
    tick_with_io(
        &mut io,
        &shared,
        "file:///blocked.html",
        &mut needs_restore,
        &mut last_full_pass,
        start + BACKGROUND_BROWSER_TICK,
    );
    assert_eq!(
        io.read_calls,
        vec![frontmost, background, frontmost, frontmost, background]
    );
    assert_eq!(io.running_calls, 2);
}

#[test]
fn extension_method_browser_is_excluded_from_automation() {
    let shared = tick_shared();
    let extension = SupportedBrowser::Chrome;
    let automation = SupportedBrowser::Brave;
    let mut io = FakeIo::new(
        vec![block("reddit", "blocklist", &["reddit.com"], 0, 999)],
        &[extension, automation],
    );
    io.methods.insert(extension, false);
    io.methods.insert(automation, true);
    let mut needs_restore = false;
    let mut last_full_pass = None;
    tick_with_io(
        &mut io,
        &shared,
        "file:///blocked.html",
        &mut needs_restore,
        &mut last_full_pass,
        Instant::now(),
    );
    assert_eq!(io.read_calls, vec![automation]);
}

#[test]
fn restore_pass_scans_background_browser_even_when_frontmost_is_another_app() {
    let shared = tick_shared();
    let browser = SupportedBrowser::Brave;
    let base = "file:///blocked.html";
    let original = "https://example.com/";
    let mut io = FakeIo::new(Vec::new(), &[browser]);
    io.events = true;
    io.frontmost = Some("com.apple.TextEdit".to_string());
    io.queue_read(browser, Ok(vec![parked_tab(base, original)]));
    io.queue_apply(browser, Ok(()));
    let mut needs_restore = true;
    let mut last_full_pass = None;
    let start = Instant::now();
    tick_with_io(
        &mut io,
        &shared,
        base,
        &mut needs_restore,
        &mut last_full_pass,
        start,
    );
    assert_eq!(io.read_calls, vec![browser]);
    assert_eq!(io.apply_calls.len(), 1, "background browser was restored");

    // The verification pass is also frontmost-independent, so the latch
    // still clears while TextEdit is in front.
    tick_with_io(
        &mut io,
        &shared,
        base,
        &mut needs_restore,
        &mut last_full_pass,
        start + Duration::from_secs(1),
    );
    assert_eq!(io.read_calls, vec![browser, browser]);
    assert!(!needs_restore);
}

#[test]
fn hostname_extraction() {
    assert_eq!(
        hostname_of("https://www.reddit.com/r/x").as_deref(),
        Some("www.reddit.com")
    );
    assert_eq!(
        hostname_of("http://user:pass@Example.COM:8080/p").as_deref(),
        Some("example.com")
    );
    assert_eq!(hostname_of("https://x.com").as_deref(), Some("x.com"));
    assert_eq!(hostname_of("file:///Users/me/x.html"), None);
}

#[test]
fn domain_matching_is_subdomain_aware() {
    assert!(domain_matches("reddit.com", "reddit.com"));
    assert!(domain_matches("www.reddit.com", "reddit.com"));
    assert!(!domain_matches("notreddit.com", "reddit.com"));
    assert!(!domain_matches("reddit.com.evil.com", "reddit.com"));
}

#[test]
fn blocklist_blocks_listed_hosts_and_their_subdomains() {
    let blocks = vec![block("b", "blocklist", &["reddit.com", "x.com"], 0, 999)];
    assert!(url_is_blocked("https://old.reddit.com/", &blocks));
    assert!(url_is_blocked("https://x.com", &blocks));
    assert!(!url_is_blocked("https://example.com", &blocks));
    // Non-http schemes are never redirected.
    assert!(!url_is_blocked("file:///x", &blocks));
}

#[test]
fn allowlist_blocks_non_allowed_hosts() {
    let blocks = vec![block(
        "mono",
        "allowlist",
        &["youtube.com", "ulriklyngs.com"],
        0,
        999,
    )];
    assert!(!url_is_blocked("https://ulriklyngs.com/blog", &blocks));
    assert!(!url_is_blocked(
        "https://www.youtube.com/watch?v=1",
        &blocks
    ));
    assert!(url_is_blocked("https://twitter.com", &blocks));
    assert!(!url_is_blocked("http://localhost:3000", &blocks));
}

#[test]
fn blocklist_still_blocks_listed_hosts() {
    let blocks = vec![block("social", "blocklist", &["reddit.com"], 0, 999)];
    assert!(url_is_blocked("https://old.reddit.com/", &blocks));
    assert!(!url_is_blocked("https://example.com", &blocks));
}

#[test]
fn web_enforcement_is_active_for_allowlist_only_website_blocks() {
    let blocks = vec![block("allow", "allowlist", &["github.com"], 10, 999)];
    assert!(web_enforcement_active(&blocks));
}

#[test]
fn concurrent_allowlists_union_allowed_domains() {
    let blocks = vec![
        block("docs", "allowlist", &["docs.rs"], 100, 500),
        block("code", "allowlist", &["github.com"], 200, 600),
    ];
    assert!(!url_is_blocked("https://docs.rs/", &blocks));
    assert!(!url_is_blocked("https://gist.github.com/", &blocks));
    assert!(url_is_blocked("https://reddit.com/", &blocks));
}

#[test]
fn allowlist_union_allows_hosts_not_on_blocklist() {
    let blocks = vec![
        block("blocked", "blocklist", &["reddit.com"], 50, 400),
        block(
            "allowed",
            "allowlist",
            &["github.com", "stackoverflow.com"],
            100,
            500,
        ),
    ];
    assert!(!url_is_blocked("https://github.com/redd", &blocks));
    assert!(!url_is_blocked("https://stackoverflow.com/q/1", &blocks));
    assert!(url_is_blocked("https://reddit.com/", &blocks));
    assert!(url_is_blocked("https://lobste.rs/", &blocks));
}

#[test]
fn blocklist_precedence_overrides_allowlist_overlap() {
    let blocks = vec![
        block(
            "blocked",
            "blocklist",
            &["github.com", "reddit.com"],
            50,
            400,
        ),
        block("allowed", "allowlist", &["github.com"], 100, 500),
    ];
    assert!(url_is_blocked("https://github.com/redd", &blocks));
    assert!(url_is_blocked("https://reddit.com/", &blocks));
    assert!(url_is_blocked("https://lobste.rs/", &blocks));
}

#[test]
fn blocklist_block_metadata_wins_when_blocklist_and_allowlist_overlap() {
    let blocks = vec![
        block("blocked", "blocklist", &["reddit.com"], 10, 500),
        block("allow-one", "allowlist", &["github.com"], 200, 700),
        block("allow-two", "allowlist", &["docs.rs"], 100, 600),
    ];

    let info = block_info_for_url("https://reddit.com", &blocks).expect("blocklist metadata");
    assert_eq!(info.blocklist_id, "blocked");
}

#[test]
fn pct_roundtrip() {
    let original = "https://x.com/path?a=1&b=two words#frag";
    let encoded = pct_encode(original);
    assert!(!encoded.contains(' '));
    assert_eq!(pct_decode(&encoded), original);
}

#[test]
fn block_page_detection_and_original_recovery() {
    let base = "file:///Applications/ReDD%20Block.app/Contents/Resources/blocked/blocked.html";
    let original = "https://www.reddit.com/";
    let built = build_blocked_url(base, original, &[]);
    assert!(is_block_page_url(&built, base));
    assert_eq!(
        original_url_from_block_page(&built).as_deref(),
        Some(original)
    );
}

#[cfg(feature = "system-test")]
#[test]
fn system_test_restore_ownership_requires_fixture_blocklist_id() {
    let base = "file:///Applications/Digital%20Habits%20Blocker%20Test.app/Contents/Resources/blocked/blocked.html";
    let original = "https://example.com/";
    let owned = build_blocked_url(
        base,
        original,
        &[block(
            "system-test-owned",
            "blocklist",
            &["example.com"],
            10,
            500,
        )],
    );
    let production = build_blocked_url(
        base,
        original,
        &[block(
            "production-block",
            "blocklist",
            &["example.com"],
            10,
            500,
        )],
    );
    assert!(block_page_owned_by_system_test(&owned));
    assert!(!block_page_owned_by_system_test(&production));
}

#[test]
fn plan_actions_restores_parked_tab_when_original_no_longer_blocked() {
    let base = "file:///Applications/ReDD%20Blocker.app/Contents/Resources/blocked/blocked.html";
    let original = "https://www.youtube.com/watch?v=1";
    let parked = build_blocked_url(base, original, &[]);
    let tabs = vec![Tab {
        window_index: 1,
        tab_index: 1,
        url: parked,
    }];

    // No active website enforcement → restore.
    let actions = plan_actions(&tabs, &[], base);
    assert_eq!(actions, vec![(1, 1, original.to_string())]);

    // Another blocklist still active for a different site → still restore youtube.
    let other = vec![block("other", "blocklist", &["reddit.com"], 10, 500)];
    let actions = plan_actions(&tabs, &other, base);
    assert_eq!(actions, vec![(1, 1, original.to_string())]);

    // Youtube itself still blocked → do not restore.
    let still = vec![block("yt", "blocklist", &["youtube.com"], 10, 500)];
    let actions = plan_actions(&tabs, &still, base);
    assert!(actions.is_empty());
}

#[test]
fn allowlist_block_metadata_prefers_earliest_started_enforcement() {
    let blocks = vec![
        BlockInfo {
            source: "activeBlock",
            ..block("one-off", "allowlist", &["apple.com"], 11_00, 2_000)
        },
        BlockInfo {
            source: "schedule",
            ..block("schedule", "allowlist", &["google.com"], 10_00, 1_500)
        },
    ];

    let info = block_info_for_url("https://example.com", &blocks).expect("allowlist metadata");
    assert_eq!(info.blocklist_id, "schedule");
}

#[test]
fn block_info_for_blocklist_overlap_attributes_to_blocklist() {
    let blocks = vec![
        block("blocked", "blocklist", &["github.com"], 10, 500),
        block("allowed", "allowlist", &["github.com"], 20, 600),
    ];

    let info = block_info_for_url("https://github.com/redd", &blocks).expect("blocklist metadata");
    assert_eq!(info.blocklist_id, "blocked");
    assert_eq!(info.mode, "blocklist");
}

#[test]
fn build_blocked_url_includes_mode_metadata() {
    let base = "file:///Applications/ReDD%20Block.app/Contents/Resources/blocked/blocked.html";
    let original = "https://example.com/";
    let blocks = vec![BlockInfo {
        blocklist_id: "allow".to_string(),
        name: Some("Allow".to_string()),
        emoji: None,
        color: None,
        mode: "allowlist".to_string(),
        domains: vec!["github.com".to_string()],
        apps: vec![],
        source: "activeBlock",
        ends_at: Some(999),
        started_at: Some(100),
    }];

    let built = build_blocked_url(base, original, &blocks);
    assert!(built.contains("mode=allowlist"));
}

#[test]
fn applescript_string_expr_escapes_ampersands_in_query() {
    let url = "file:///Applications/ReDD%20Block.app/Contents/Resources/blocked/blocked.html?u=https%3A%2F%2Fx.com&id=abc";
    assert_eq!(
            applescript_string_expr(url),
            "\"file:///Applications/ReDD%20Block.app/Contents/Resources/blocked/blocked.html?u=https%3A%2F%2Fx.com\" & \"&\" & \"id=abc\""
        );
}

#[test]
fn file_url_encodes_spaces() {
    let p = std::path::Path::new(
        "/Applications/Digital Habits Blocker.app/Contents/Resources/blocked/blocked.html",
    );
    assert_eq!(
            path_to_file_url(p),
            "file:///Applications/Digital%20Habits%20Blocker.app/Contents/Resources/blocked/blocked.html"
        );
}

#[test]
fn parse_tab_rows_keeps_empty_urls_and_skips_malformed_rows() {
    // The joined output has no trailing linefeed, and Safari's empty
    // tabs come back as an empty third field.
    let tabs =
        parse_tab_rows("1\t1\thttps://a.example/\n1\t2\t\nnot a row\n2\t1\thttps://b.example/?q=1");
    let got: Vec<(u32, u32, &str)> = tabs
        .iter()
        .map(|t| (t.window_index, t.tab_index, t.url.as_str()))
        .collect();
    assert_eq!(
        got,
        vec![
            (1, 1, "https://a.example/"),
            (1, 2, ""),
            (2, 1, "https://b.example/?q=1"),
        ]
    );
}

#[test]
fn join_rows_handler_joins_with_linefeeds() {
    // Runs the same handler the read script uses, on synthetic rows, so
    // the join is checked without a browser.
    let script = format!(
        "{JOIN_ROWS_HANDLER}\non run\n  return joinRows({{\"1\" & tab & \"1\" & tab & \"https://a.example/\", \"1\" & tab & \"2\" & tab & \"\"}}, linefeed)\nend run"
    );
    let out = run_osascript(&script).expect("osascript runs a script with no Apple Events");
    assert_eq!(
        out.trim_end_matches('\n'),
        "1\t1\thttps://a.example/\n1\t2\t"
    );
    let empty = format!("{JOIN_ROWS_HANDLER}\non run\n  return joinRows({{}}, linefeed)\nend run");
    assert_eq!(run_osascript(&empty).unwrap().trim(), "");
}

#[test]
fn read_tabs_script_runs_against_safari() {
    // Safari ships with every macOS, so this compiles the real read
    // script against a real scripting dictionary and runs it. With Safari
    // closed the `is running` guard sends it no Apple Event, so no
    // Automation prompt is involved; skip rather than prompt if it is open.
    if running_supported_browsers().contains(&SupportedBrowser::Safari) {
        return;
    }
    let out = run_osascript(&read_tabs_script(SupportedBrowser::Safari))
        .expect("read script compiles and runs against Safari's dictionary");
    assert!(parse_tab_rows(&out).is_empty());
}

#[test]
fn in_process_script_returns_text_and_maps_errors() {
    // Pure AppleScript, so no Apple Event and no Automation prompt.
    let joined = format!(
        "{JOIN_ROWS_HANDLER}\non run\n  return joinRows({{\"1\" & tab & \"1\" & tab & \"https://a.example/\", \"1\" & tab & \"2\" & tab & \"\"}}, linefeed)\nend run"
    );
    let script = in_process::compile(&joined).expect("compiles in process");
    assert_eq!(
        in_process::execute(&script).unwrap(),
        "1\t1\thttps://a.example/\n1\t2\t"
    );

    let denied = in_process::compile("error \"no\" number -1743").unwrap();
    assert!(matches!(
        in_process::execute(&denied),
        Err(AutomationError::NotAuthorized)
    ));
    let other = in_process::compile("error \"boom\" number 42").unwrap();
    match in_process::execute(&other) {
        Err(AutomationError::Other(msg)) => assert!(msg.contains("boom"), "{msg}"),
        r => panic!("expected Other, got {r:?}"),
    }
    assert!(in_process::compile("return (").is_err());
}

#[test]
fn in_process_reads_wait_for_granted_permission_and_recheck_it() {
    let mut reads = in_process::Reads::default();
    let browser = SupportedBrowser::Safari;
    let t0 = Instant::now();
    let source = || "return \"read\"".to_string();
    let checks = std::cell::Cell::new(0);
    let check = |granted: bool| {
        checks.set(checks.get() + 1);
        granted
    };

    // Not granted: no in-process read, so the caller uses osascript.
    assert!(reads.read(browser, t0, source, || check(false)).is_none());
    // The answer is cached until the recheck interval passes.
    assert!(reads
        .read(browser, t0 + Duration::from_secs(1), source, || check(true))
        .is_none());
    assert_eq!(checks.get(), 1);

    let later = t0 + in_process::PERMISSION_RECHECK;
    let out = reads.read(browser, later, source, || check(true));
    assert_eq!(out.unwrap().unwrap(), "read");
    assert_eq!(checks.get(), 2);
    let out = reads.read(browser, later + Duration::from_secs(1), source, || {
        check(true)
    });
    assert_eq!(out.unwrap().unwrap(), "read");
    assert_eq!(
        checks.get(),
        2,
        "granted answer is reused within the interval"
    );
}

#[test]
fn in_process_denial_forces_a_permission_recheck() {
    let mut reads = in_process::Reads::default();
    let browser = SupportedBrowser::Chrome;
    let t0 = Instant::now();
    let denied = || "error \"no\" number -1743".to_string();
    let out = reads.read(browser, t0, denied, || true);
    assert!(matches!(out, Some(Err(AutomationError::NotAuthorized))));
    // Revoked in System Settings: the next read asks TCC again at once
    // instead of trusting the cached grant for the rest of the interval.
    assert!(reads
        .read(browser, t0 + Duration::from_secs(1), denied, || false)
        .is_none());
}

#[test]
fn in_process_compile_failure_falls_back_to_osascript_for_good() {
    let mut reads = in_process::Reads::default();
    let browser = SupportedBrowser::Edge;
    let t0 = Instant::now();
    assert!(reads
        .read(browser, t0, || "return (".to_string(), || true)
        .is_none());
    // Not recompiled on later ticks, even once the source would compile.
    assert!(reads
        .read(
            browser,
            t0 + Duration::from_secs(1),
            || "return 1".to_string(),
            || true
        )
        .is_none());
}
