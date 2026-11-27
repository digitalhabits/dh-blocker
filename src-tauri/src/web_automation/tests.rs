use super::*;
use crate::block_page::*;
use std::collections::VecDeque;

struct FakeIo {
    blocks: Option<Vec<BlockInfo>>,
    events: bool,
    selected: Option<u32>,
    frontmost: Option<String>,
    focus_during_next_read: Option<String>,
    running: Vec<SupportedBrowser>,
    methods: HashMap<SupportedBrowser, bool>,
    reads: HashMap<SupportedBrowser, VecDeque<Result<Vec<Tab>, AutomationError>>>,
    applies: HashMap<SupportedBrowser, VecDeque<Result<ApplyOutcome, AutomationError>>>,
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
            selected: None,
            frontmost: None,
            focus_during_next_read: None,
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

    fn queue_apply(
        &mut self,
        browser: SupportedBrowser,
        result: Result<ApplyOutcome, AutomationError>,
    ) {
        self.applies.entry(browser).or_default().push_back(result);
    }
}

impl AutomationIo for FakeIo {
    fn active_blocks(&mut self) -> Option<Vec<BlockInfo>> {
        self.blocks.clone()
    }

    fn read_completed_at(&self, tick_start: Instant) -> Instant {
        tick_start
    }

    fn events_active(&self) -> bool {
        self.events
    }

    fn frontmost_bundle_id(&self) -> Option<String> {
        self.frontmost.clone()
    }

    fn selected_tab_id(&mut self, _: SupportedBrowser) -> Option<u32> {
        self.selected
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
        if let Some(bundle_id) = self.focus_during_next_read.take() {
            self.frontmost = Some(bundle_id);
        }
        self.reads
            .get_mut(&browser)
            .and_then(VecDeque::pop_front)
            .unwrap_or_else(|| Ok(Vec::new()))
    }

    fn apply_actions(
        &mut self,
        browser: SupportedBrowser,
        actions: &[TabAction],
        _: Option<u32>,
    ) -> Result<ApplyOutcome, AutomationError> {
        self.apply_calls.push((browser, actions.to_vec()));
        self.applies
            .get_mut(&browser)
            .and_then(VecDeque::pop_front)
            .unwrap_or(Ok(ApplyOutcome::Complete))
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
        apply_permission(runtime, state, denied_retry, now);
    }
}

fn tick_shared() -> Arc<Mutex<Shared>> {
    Arc::new(Mutex::new(Shared::default()))
}

fn parked_tab(base: &str, original: &str) -> Tab {
    Tab {
        window_id: "1".to_string(),
        tab_ref: 1,
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
    let mut scan = ScanState::default();
    tick_with_io(
        &mut io,
        &shared,
        "file:///blocked.html",
        &mut needs_restore,
        &mut scan,
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
            window_id: "1".to_string(),
            tab_ref: 1,
            url: original.to_string(),
        }]),
    );
    io.queue_read(browser, Ok(vec![parked_tab(base, original)]));
    io.queue_apply(browser, Ok(ApplyOutcome::Complete));
    io.queue_apply(browser, Ok(ApplyOutcome::Complete));
    let mut needs_restore = false;
    let mut scan = ScanState::default();
    let start = Instant::now();

    tick_with_io(&mut io, &shared, base, &mut needs_restore, &mut scan, start);
    assert!(needs_restore);

    io.blocks = Some(Vec::new());
    tick_with_io(
        &mut io,
        &shared,
        base,
        &mut needs_restore,
        &mut scan,
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
        &mut scan,
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
    io.queue_apply(browser, Ok(ApplyOutcome::Complete));
    io.queue_apply(browser, Ok(ApplyOutcome::Complete));
    let mut needs_restore = true;
    let mut scan = ScanState::default();
    let start = Instant::now();

    tick_with_io(&mut io, &shared, base, &mut needs_restore, &mut scan, start);
    assert!(needs_restore, "tab is still parked; latch must stay armed");

    tick_with_io(
        &mut io,
        &shared,
        base,
        &mut needs_restore,
        &mut scan,
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
    io.queue_apply(browser, Ok(ApplyOutcome::Complete));
    let mut needs_restore = true;
    let mut scan = ScanState::default();
    let start = Instant::now();

    tick_with_io(&mut io, &shared, base, &mut needs_restore, &mut scan, start);
    assert!(needs_restore);
    tick_with_io(
        &mut io,
        &shared,
        base,
        &mut needs_restore,
        &mut scan,
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
        &mut scan,
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
    let mut scan = ScanState::default();
    let start = Instant::now();

    tick_with_io(
        &mut io,
        &shared,
        "file:///blocked.html",
        &mut needs_restore,
        &mut scan,
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
        &mut scan,
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
        &mut scan,
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
    let mut scan = ScanState::default();
    let start = Instant::now();

    tick_with_io(
        &mut io,
        &shared,
        "file:///blocked.html",
        &mut needs_restore,
        &mut scan,
        start,
    );
    assert!(needs_restore);
    tick_with_io(
        &mut io,
        &shared,
        "file:///blocked.html",
        &mut needs_restore,
        &mut scan,
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
    let mut scan = ScanState::default();
    let start = Instant::now();

    tick_with_io(
        &mut io,
        &shared,
        "file:///blocked.html",
        &mut needs_restore,
        &mut scan,
        start,
    );
    assert_eq!(io.read_calls, vec![frontmost, background]);
    tick_with_io(
        &mut io,
        &shared,
        "file:///blocked.html",
        &mut needs_restore,
        &mut scan,
        start + Duration::from_secs(1),
    );
    assert_eq!(io.read_calls, vec![frontmost, background, frontmost]);
    tick_with_io(
        &mut io,
        &shared,
        "file:///blocked.html",
        &mut needs_restore,
        &mut scan,
        start + BACKGROUND_BROWSER_TICK,
    );
    assert_eq!(
        io.read_calls,
        vec![frontmost, background, frontmost, frontmost, background]
    );
    assert_eq!(io.running_calls, 2);
}

fn open_tab(tab_ref: u32, url: &str) -> Tab {
    Tab {
        window_id: "1".to_string(),
        tab_ref,
        url: url.to_string(),
    }
}

#[test]
fn cancelled_redirect_waits_five_seconds_from_the_return_to_the_original_url() {
    let shared = tick_shared();
    let brave = SupportedBrowser::Brave;
    let url = "https://mail.google.com/";
    let base = "file:///blocked.html";
    let mut io = FakeIo::new(
        vec![block("mail", "blocklist", &["mail.google.com"], 0, 999)],
        &[brave],
    );
    let start = Instant::now();
    let mut needs_restore = false;
    let mut scan = ScanState::default();
    let mut step = |ms, tabs| {
        io.queue_read(brave, Ok(tabs));
        tick_with_io(
            &mut io,
            &shared,
            base,
            &mut needs_restore,
            &mut scan,
            start + Duration::from_millis(ms),
        );
        std::mem::take(&mut io.apply_calls)
            .into_iter()
            .flat_map(|(_, actions)| actions)
            .map(|(_, tab, _)| tab)
            .collect::<Vec<_>>()
    };
    assert_eq!(step(0, vec![open_tab(1, url)]), [1]);
    // A swallowed set-URL error (or a very fast Cancel) leaves no observed
    // block page. The next pass must still enforce immediately.
    assert_eq!(step(1_000, vec![open_tab(1, url)]), [1]);
    assert!(step(30_000, vec![parked_tab(base, url)]).is_empty());
    // Cancel returns tab 1 to its original URL. Tab 2 visits the very same URL.
    assert_eq!(step(31_000, vec![open_tab(1, url), open_tab(2, url)]), [2]);
    assert!(step(35_999, vec![open_tab(1, url)]).is_empty());
    assert_eq!(step(36_000, vec![open_tab(1, url)]), [1]);
    assert_eq!(
        step(37_000, vec![open_tab(1, "https://mail.google.com/other")]),
        [1]
    );
}

#[test]
fn back_from_a_rendered_block_page_rearms_the_next_eligible_redirect() {
    for (background, observe_load) in [(false, true), (true, true), (true, false)] {
        let browser = SupportedBrowser::Brave;
        let base = "file:///blocked.html";
        let original = "https://video.example/watch";
        let mut io = FakeIo::new(
            vec![block("video", "blocklist", &["video.example"], 0, 999)],
            &[browser],
        );
        io.events = true;
        io.frontmost = Some(browser.bundle_id().into());
        io.selected = Some(1);
        let mut scan = ScanState::default();
        let start = Instant::now();
        let shared = tick_shared();
        let mut step = |io: &mut FakeIo, seconds, url: &str| {
            io.queue_read(browser, Ok(vec![open_tab(1, url)]));
            tick_with_io(
                io,
                &shared,
                base,
                &mut false,
                &mut scan,
                start + Duration::from_secs(seconds),
            );
            std::mem::take(&mut io.apply_calls)
        };
        let first = step(&mut io, 0, original);
        let target = &first[0].1[0].2;
        let document_url = target
            .strip_suffix("#pending")
            .expect("Chromium redirect marker");
        if observe_load {
            assert!(step(&mut io, 1, target).is_empty());
            // Only the loaded document can stamp this fragment.
            assert!(step(&mut io, 2, &format!("{document_url}#loaded")).is_empty());
        }
        if background {
            io.frontmost = Some("com.apple.TextEdit".into());
        }
        assert_eq!(
            step(&mut io, 5, original).len(),
            1,
            "Back, background={background}"
        );
    }
}

/// Redirecting a background Chromium tab whose page has a beforeunload
/// handler (Gmail) shows a "Leave site?" dialog that drags the browser in
/// front of the app the user is in. With no known selection, defer until
/// the next foreground tick.
#[test]
fn unknown_selected_tab_waits_until_browser_is_frontmost() {
    let shared = tick_shared();
    let brave = SupportedBrowser::Brave;
    let base = "file:///blocked.html";
    let gmail = "https://mail.google.com/mail/u/0/";
    let mut io = FakeIo::new(
        vec![block("mail", "blocklist", &["mail.google.com"], 0, 999)],
        &[brave],
    );
    io.events = true;
    io.frontmost = Some("com.apple.TextEdit".to_string());
    io.queue_read(brave, Ok(vec![open_tab(1, gmail)]));
    let mut needs_restore = false;
    let mut scan = ScanState::default();
    let start = Instant::now();

    tick_with_io(&mut io, &shared, base, &mut needs_restore, &mut scan, start);
    assert_eq!(io.read_calls, vec![brave], "background browser still read");
    assert!(io.apply_calls.is_empty(), "no redirect while in background");

    io.frontmost = Some(brave.bundle_id().to_string());
    io.queue_read(brave, Ok(vec![open_tab(1, gmail)]));
    tick_with_io(
        &mut io,
        &shared,
        base,
        &mut needs_restore,
        &mut scan,
        start + Duration::from_secs(1),
    );
    assert_eq!(io.apply_calls.len(), 1, "redirected once frontmost");
    assert!(is_block_page_url(&io.apply_calls[0].1[0].2, base));
}

#[test]
fn chromium_background_attempt_is_limited_to_the_selected_tab_and_does_not_repeat() {
    let brave = SupportedBrowser::Brave;
    let mut io = FakeIo::new(
        vec![block("video", "blocklist", &["video.example"], 0, 999)],
        &[brave],
    );
    io.events = true;
    io.frontmost = Some("com.apple.TextEdit".into());
    io.selected = Some(2);
    io.queue_apply(brave, Err(AutomationError::Other("timeout".into())));
    let mut scan = ScanState::default();
    let shared = tick_shared();
    let start = Instant::now();
    let base = "file:///blocked.html";
    let url = "https://video.example/watch";
    let mut tick = |io: &mut FakeIo, seconds, selected_url: &str| {
        io.queue_read(brave, Ok(vec![open_tab(1, url), open_tab(2, selected_url)]));
        tick_with_io(
            io,
            &shared,
            base,
            &mut false,
            &mut scan,
            start + Duration::from_secs(seconds),
        );
        std::mem::take(&mut io.apply_calls)
            .into_iter()
            .flat_map(|(_, a)| a)
            .map(|(_, id, _)| id)
            .collect::<Vec<_>>()
    };
    assert_eq!(tick(&mut io, 0, url), [2]);
    // An ambiguous failure or a quick Cancel can leave the original URL
    // visible on the next scan. Neither grants a second background attempt.
    assert!(tick(&mut io, 5, url).is_empty());
    assert!(tick(&mut io, 10, &build_blocked_url(base, url, &[])).is_empty());
    assert!(tick(&mut io, 15, url).is_empty());
    assert!(tick(&mut io, 25, url).is_empty());
    io.frontmost = Some(brave.bundle_id().into());
    assert_eq!(tick(&mut io, 26, url), [1, 2]);
    io.frontmost = Some("com.apple.TextEdit".into());
    io.selected = Some(2);
    assert!(tick(&mut io, 30, &build_blocked_url(base, url, &[])).is_empty());
    assert!(
        tick(&mut io, 35, url).is_empty(),
        "an observed pending foreground redirect counts too"
    );
    let blocks = io.blocks.replace(vec![]).unwrap();
    assert!(tick(&mut io, 40, url).is_empty());
    io.blocks = Some(blocks);
    assert_eq!(tick(&mut io, 45, url), [2], "a new block gets an attempt");
}

#[test]
fn a_definite_selection_skip_leaves_the_background_attempt_available() {
    let brave = SupportedBrowser::Brave;
    let mut io = FakeIo::new(
        vec![block("video", "blocklist", &["video.example"], 0, 999)],
        &[brave],
    );
    io.events = true;
    io.frontmost = Some("com.apple.TextEdit".into());
    io.selected = Some(1);
    io.queue_apply(brave, Ok(ApplyOutcome::BackgroundSkipped));
    let start = Instant::now();
    let shared = tick_shared();
    let mut scan = ScanState::default();
    for (seconds, expected_batches) in [(0, 1), (5, 2), (10, 2)] {
        io.queue_read(brave, Ok(vec![open_tab(1, "https://video.example/")]));
        tick_with_io(
            &mut io,
            &shared,
            "file:///blocked.html",
            &mut false,
            &mut scan,
            start + Duration::from_secs(seconds),
        );
        assert_eq!(io.apply_calls.len(), expected_batches);
    }
}

#[test]
fn background_safari_redirects_even_when_selected_tab_is_unknown() {
    let browsers = SupportedBrowser::all();
    let mut io = FakeIo::new(
        vec![block("mail", "blocklist", &["mail.google.com"], 0, 999)],
        &browsers,
    );
    io.events = true;
    io.frontmost = Some("com.apple.TextEdit".into());
    for browser in browsers {
        io.queue_read(browser, Ok(vec![open_tab(1, "https://mail.google.com/")]));
    }
    let base = "file:///blocked.html";
    tick_with_io(
        &mut io,
        &tick_shared(),
        base,
        &mut false,
        &mut ScanState::default(),
        Instant::now(),
    );
    assert_eq!(io.apply_calls.len(), 1);
    let (browser, actions) = &io.apply_calls[0];
    assert_eq!(*browser, SupportedBrowser::Safari);
    assert!(is_block_page_url(&actions[0].2, base));
}

#[test]
fn switching_focus_while_reading_brave_tabs_defers_only_redirects() {
    let brave = SupportedBrowser::Brave;
    let base = "file:///blocked.html";
    let original = "https://example.com/";
    let mut io = FakeIo::new(
        vec![block("mail", "blocklist", &["mail.google.com"], 0, 999)],
        &[brave],
    );
    io.events = true;
    io.frontmost = Some(brave.bundle_id().to_string());
    io.focus_during_next_read = Some("com.apple.TextEdit".to_string());
    io.selected = Some(2);
    io.queue_read(
        brave,
        Ok(vec![
            parked_tab(base, original),
            open_tab(2, "https://mail.google.com/"),
        ]),
    );

    tick_with_io(
        &mut io,
        &tick_shared(),
        base,
        &mut false,
        &mut ScanState::default(),
        Instant::now(),
    );

    assert_eq!(
        io.apply_calls,
        vec![(brave, vec![("1".into(), 1, original.into())])]
    );
}

/// Without a known frontmost app the watcher cannot tell whether the
/// browser is in the background, so it fails closed and redirects.
#[test]
fn unknown_frontmost_app_still_redirects() {
    let shared = tick_shared();
    let brave = SupportedBrowser::Brave;
    let base = "file:///blocked.html";
    for events in [false, true] {
        let mut io = FakeIo::new(
            vec![block("mail", "blocklist", &["mail.google.com"], 0, 999)],
            &[brave],
        );
        io.events = events;
        io.frontmost = None;
        io.queue_read(brave, Ok(vec![open_tab(1, "https://mail.google.com/")]));
        let mut needs_restore = false;
        let mut scan = ScanState::default();
        tick_with_io(
            &mut io,
            &shared,
            base,
            &mut needs_restore,
            &mut scan,
            Instant::now(),
        );
        assert_eq!(io.apply_calls.len(), 1, "events={events}");
    }
}

/// Mid-block restores (a site removed from the list) are not deferred:
/// the block page has no beforeunload handler to raise the browser.
#[test]
fn background_browser_still_restores_unblocked_tabs_while_blocking() {
    let shared = tick_shared();
    let brave = SupportedBrowser::Brave;
    let base = "file:///blocked.html";
    let mut io = FakeIo::new(
        vec![block("mail", "blocklist", &["mail.google.com"], 0, 999)],
        &[brave],
    );
    io.events = true;
    io.frontmost = Some("com.apple.TextEdit".to_string());
    io.queue_read(
        brave,
        Ok(vec![
            parked_tab(base, "https://example.com/"),
            open_tab(2, "https://mail.google.com/"),
        ]),
    );
    let mut needs_restore = false;
    let mut scan = ScanState::default();
    tick_with_io(
        &mut io,
        &shared,
        base,
        &mut needs_restore,
        &mut scan,
        Instant::now(),
    );
    assert_eq!(
        io.apply_calls,
        vec![(
            brave,
            vec![("1".to_string(), 1, "https://example.com/".to_string())]
        )]
    );
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
    let mut scan = ScanState::default();
    tick_with_io(
        &mut io,
        &shared,
        "file:///blocked.html",
        &mut needs_restore,
        &mut scan,
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
    io.queue_apply(browser, Ok(ApplyOutcome::Complete));
    let mut needs_restore = true;
    let mut scan = ScanState::default();
    let start = Instant::now();
    tick_with_io(&mut io, &shared, base, &mut needs_restore, &mut scan, start);
    assert_eq!(io.read_calls, vec![browser]);
    assert_eq!(io.apply_calls.len(), 1, "background browser was restored");

    // The verification pass is also frontmost-independent, so the latch
    // still clears while TextEdit is in front.
    tick_with_io(
        &mut io,
        &shared,
        base,
        &mut needs_restore,
        &mut scan,
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
        window_id: "1".to_string(),
        tab_ref: 1,
        url: parked,
    }];

    // No active website enforcement → restore.
    let actions = plan_actions(&tabs, &[], base);
    assert_eq!(actions, vec![("1".to_string(), 1, original.to_string())]);

    // Another blocklist still active for a different site → still restore youtube.
    let other = vec![block("other", "blocklist", &["reddit.com"], 10, 500)];
    let actions = plan_actions(&tabs, &other, base);
    assert_eq!(actions, vec![("1".to_string(), 1, original.to_string())]);

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
    // tabs come back as an empty third field. The first field is the
    // window's AppleScript id, kept as text.
    let tabs = parse_tab_rows(
        "7\t1\thttps://a.example/\n7\t2\t\nnot a row\n\t1\thttps://no-window.example/\n3\t1\thttps://b.example/?q=1",
    );
    let got: Vec<(&str, u32, &str)> = tabs
        .iter()
        .map(|t| (t.window_id.as_str(), t.tab_ref, t.url.as_str()))
        .collect();
    assert_eq!(
        got,
        vec![
            ("7", 1, "https://a.example/"),
            ("7", 2, ""),
            ("3", 1, "https://b.example/?q=1"),
        ]
    );
}

#[test]
fn chromium_reads_each_tabs_id_and_url_from_one_properties_record() {
    for browser in [
        SupportedBrowser::Chrome,
        SupportedBrowser::Brave,
        SupportedBrowser::Edge,
    ] {
        let script = read_tabs_script(browser);
        // A property list such as {id, URL} sends separate Apple Events. A
        // tab closed between those reads shifts the remaining URLs by one.
        assert!(script.contains("properties of every tab of window id _wid"));
        assert!(script.contains("(URL of _row)") && script.contains("(id of _row)"));
    }
}

#[test]
fn redirects_address_windows_by_id_not_stacking_position() {
    // `window 2` means "second in the stacking order right now", and each
    // `set URL` raises the window it navigates. Addressing by position
    // sent later redirects in a batch (and on later ticks) to whichever
    // window had moved into that slot, so multi-window Brave/Chrome kept
    // swapping the front window.
    let script = apply_actions_script(
        SupportedBrowser::Brave,
        None,
        &[
            ("12".to_string(), 3, "file:///blocked.html?a".to_string()),
            ("5".to_string(), 1, "file:///blocked.html?b".to_string()),
            ("12".to_string(), 1, "file:///blocked.html?c".to_string()),
        ],
    );
    assert!(
        !script.contains("of window 12") && !script.contains("of window 5"),
        "redirects must not address a window by position:\n{script}"
    );
    assert!(script.contains("id of every window"), "{script}");
    // Both of window 12's tabs sit under one id match, ahead of window 5's.
    let w12 = script
        .find("if _key is \"12\" then")
        .expect("window 12 matched by id");
    let w5 = script
        .find("if _key is \"5\" then")
        .expect("window 5 matched by id");
    assert!(w12 < w5);
    assert_eq!(script.matches("if _key is \"12\" then").count(), 1);
    let w12_block = &script[w12..w5];
    assert!(
        w12_block.contains("set URL of tab id 3 of window id _wid to \"file:///blocked.html?a\"")
    );
    assert!(
        w12_block.contains("set URL of tab id 1 of window id _wid to \"file:///blocked.html?c\"")
    );
    assert!(script[w5..]
        .contains("set URL of tab id 1 of window id _wid to \"file:///blocked.html?b\""));
}

#[test]
fn apply_script_resolves_window_ids_before_iterating() {
    // `repeat with _ref in (id of every window)` hands the loop lazy
    // references like `item 1 of id of every window`. Safari resolves
    // `contents of _ref`; Brave fails with -1700 ("Can't make item 1 of id
    // of every window into type specifier"), which aborted the whole batch
    // so no blocked tab was redirected. Binding the list to a variable
    // first makes the browser return concrete ids.
    let script = apply_actions_script(
        SupportedBrowser::Brave,
        None,
        &[("12".to_string(), 1, "file:///blocked.html".to_string())],
    );
    assert!(
        !script.contains("repeat with _ref in (id of every window)"),
        "{script}"
    );
    let bind = script
        .find("set _ids to id of every window")
        .expect("window ids bound to a variable");
    let repeat = script
        .find("repeat with _ref in _ids")
        .expect("loop iterates the bound list");
    assert!(bind < repeat, "{script}");
}

/// Live round trip against a real browser: `setup` opens two throwaway
/// windows (A at example.com, B at example.org, B in front) and returns
/// their ids joined by "|". `tab` inside a browser's `tell` block is its
/// tab class, not a tab character, hence the "|". The real read script
/// must report both windows by id, the real apply script must redirect
/// background window A only, and both windows are closed even when an
/// assertion is about to fail.
fn assert_live_background_redirect(browser: SupportedBrowser, setup: &str) {
    let app = browser.applescript_name();
    // Not `run_osascript`: its 8s limit is shorter than a cold browser
    // launch plus two page loads.
    let out = std::process::Command::new("osascript")
        .args(["-e", setup])
        .output()
        .expect("osascript runs");
    assert!(out.status.success(), "browser opens two windows: {out:?}");
    let out = String::from_utf8(out.stdout).expect("utf-8 ids");
    let (id_a, id_b) = out.trim().split_once('|').expect("two ids");
    let (id_a, id_b) = (id_a.to_string(), id_b.to_string());
    let read = run_osascript(&read_tabs_script(browser)).map(|o| parse_tab_rows(&o));
    let applied = read
        .as_ref()
        .ok()
        .and_then(|tabs| tabs.iter().find(|tab| tab.window_id == id_a))
        .map(|tab| {
            if browser == SupportedBrowser::Brave {
                // B is frontmost. Simulate selection changing after the
                // watcher selected A but before its Apple Event ran.
                let guarded = apply_actions_script(
                    browser,
                    Some(tab.tab_ref),
                    &[(
                        id_a.clone(),
                        tab.tab_ref,
                        "https://example.net/?guarded".into(),
                    )],
                );
                if run_osascript(&guarded)?.trim() != "skipped" {
                    return Err(AutomationError::Other(
                        "expected a definite selection skip".into(),
                    ));
                }
            }
            run_osascript(&apply_actions_script(
                browser,
                None,
                &[(
                    id_a.clone(),
                    tab.tab_ref,
                    "https://example.net/?redirected".to_string(),
                )],
            ))
        });
    std::thread::sleep(Duration::from_secs(2));
    // Windows are matched as text so the same script works whether the
    // browser types ids as numbers (Safari) or text (Chromium).
    let check = format!(
        r#"tell application "{app}"
  set _a to ""
  set _b to ""
  repeat with _w in (get every window)
    set _k to (id of _w) as text
    if _k is "{id_a}" then
      set _a to URL of tab 1 of _w
      close _w
    else if _k is "{id_b}" then
      set _b to URL of tab 1 of _w
      close _w
    end if
  end repeat
  return _a & "|" & _b
end tell"#
    );
    let urls = run_osascript(&check).expect("browser reports and closes the windows");
    let tabs = read.expect("read script runs against the browser");
    for (id, url) in [
        (&id_a, "https://example.com/?A"),
        (&id_b, "https://example.org/?B"),
    ] {
        assert!(
            tabs.iter().any(|t| &t.window_id == id && t.url == url),
            "read script reports window {id} at {url}: {tabs:?}"
        );
    }
    applied
        .expect("test window has a tab")
        .expect("apply script runs against the browser");
    let (url_a, url_b) = urls.trim().split_once('|').expect("two urls");
    assert_eq!(url_a, "https://example.net/?redirected");
    assert_eq!(url_b, "https://example.org/?B");
}

#[test]
#[ignore = "drives real Brave windows; run by hand on a Mac with Brave installed"]
fn live_brave_redirects_a_background_window_by_id() {
    // Iterating `(id of every window)` directly failed here with -1700.
    assert_live_background_redirect(
        SupportedBrowser::Brave,
        r#"tell application "Brave Browser"
  set wA to make new window
  set URL of active tab of wA to "https://example.com/?A"
  set wB to make new window
  set URL of active tab of wB to "https://example.org/?B"
  delay 2
  return ((id of wA) as text) & "|" & ((id of wB) as text)
end tell"#,
    );
}

#[test]
#[ignore = "drives real Safari windows; run by hand on a Mac"]
fn live_safari_redirects_a_background_window_by_id() {
    // Safari types window ids as integers, unlike Chromium's text ids.
    assert_live_background_redirect(
        SupportedBrowser::Safari,
        // A cold launch also opens Safari's own start window, so `front
        // window` is racy; each new window is the id that was not there
        // before.
        r#"on newWindowId(_before)
  tell application "Safari"
    repeat 20 times
      repeat with _i in (get id of every window)
        if _before does not contain (contents of _i) then return contents of _i
      end repeat
      delay 0.25
    end repeat
  end tell
  error "no new Safari window"
end newWindowId
tell application "Safari"
  launch
  delay 1
  set _before to id of every window
  make new document with properties {URL:"https://example.com/?A"}
end tell
set idA to newWindowId(_before)
tell application "Safari"
  set _before to id of every window
  make new document with properties {URL:"https://example.org/?B"}
end tell
set idB to newWindowId(_before)
delay 2
return (idA as text) & "|" & (idB as text)"#,
    );
}

#[test]
fn apply_script_escapes_the_window_id() {
    let script = apply_actions_script(
        SupportedBrowser::Safari,
        None,
        &[("a\"b".to_string(), 1, "https://x.example/".to_string())],
    );
    assert!(script.contains(r#"if _key is "a\"b" then"#), "{script}");
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
fn apply_script_runs_against_safari() {
    // Same guard as the read test: compiles the `window id` addressing
    // against a real dictionary without sending Safari an Apple Event.
    if running_supported_browsers().contains(&SupportedBrowser::Safari) {
        return;
    }
    let script = apply_actions_script(
        SupportedBrowser::Safari,
        None,
        &[("1".to_string(), 1, "https://a.example/?q=1&r=2".to_string())],
    );
    run_osascript(&script).expect("apply script compiles and runs against Safari's dictionary");
}

#[test]
fn a_successful_script_vouches_for_the_grant_only_briefly() {
    let start = Instant::now();
    let mut rt = BrowserRuntime::default();
    apply_permission(&mut rt, PermState::Granted, DENIED_RETRY, start);
    assert!(grant_is_fresh(
        rt.granted_at,
        start + BACKGROUND_BROWSER_TICK
    ));
    assert!(
        !grant_is_fresh(rt.granted_at, start + GRANT_CONFIRMATION_TTL + TICK),
        "a grant nobody has re-confirmed must not excuse the enforcer's probe"
    );
}

#[test]
fn a_denial_withdraws_the_confirmed_grant_at_once() {
    // Revoking Automation must reach the enforcer on the next tick, not
    // after the confirmation would have expired.
    let start = Instant::now();
    let mut rt = BrowserRuntime::default();
    apply_permission(&mut rt, PermState::Granted, DENIED_RETRY, start);
    apply_permission(&mut rt, PermState::Denied, DENIED_RETRY, start + TICK);
    assert!(!grant_is_fresh(rt.granted_at, start + TICK));
}

#[test]
fn an_unknown_answer_is_no_confirmation() {
    let mut rt = BrowserRuntime::default();
    assert!(!grant_is_fresh(rt.granted_at, Instant::now()));
    apply_permission(&mut rt, PermState::Unknown, DENIED_RETRY, Instant::now());
    assert!(!grant_is_fresh(rt.granted_at, Instant::now()));
}
