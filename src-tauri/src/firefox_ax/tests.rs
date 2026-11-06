//! Decision tests for the Firefox Accessibility watcher.
//!
//! These cover what the tick *decides*, with the browser, the grant and the
//! data file all faked. The two things only a real browser can show — that
//! `AXURL` reads and that synthesised keys navigate — live as `#[ignore]`d
//! tests in `crate::accessibility`.

use super::*;

const BLOCK_PAGE: &str = "file:///Applications/Test.app/Contents/Resources/blocked/blocked.html";

fn block(domains: &[&str]) -> BlockInfo {
    BlockInfo {
        blocklist_id: "bl".to_string(),
        name: Some("Distractions".to_string()),
        emoji: None,
        color: None,
        mode: "blocklist".to_string(),
        domains: domains.iter().map(|d| (*d).to_string()).collect(),
        apps: vec![],
        source: "activeBlock",
        ends_at: None,
        started_at: None,
    }
}

#[derive(Default)]
struct FakeIo {
    accessibility: bool,
    trusted: bool,
    pid: Option<i32>,
    blocks: Vec<BlockInfo>,
    url: Option<String>,
    /// What `redirect` should return, in order; the default is accepted.
    redirect_results: Vec<Result<bool, String>>,
    redirects: Vec<String>,
    nudges: usize,
    /// `None` is "frontmost app unknown", as before workspace events install.
    frontmost: Option<bool>,
    pid_lookups: usize,
    url_reads: usize,
}

impl FakeIo {
    fn watching(url: &str, domains: &[&str]) -> Self {
        Self {
            accessibility: true,
            trusted: true,
            pid: Some(4242),
            blocks: vec![block(domains)],
            url: Some(url.to_string()),
            ..Default::default()
        }
    }
}

impl FirefoxIo for FakeIo {
    fn active_blocks(&mut self) -> Option<Vec<BlockInfo>> {
        Some(self.blocks.clone())
    }
    fn uses_accessibility(&mut self) -> bool {
        self.accessibility
    }
    fn trusted(&mut self) -> bool {
        self.trusted
    }
    fn firefox_frontmost(&mut self) -> Option<bool> {
        self.frontmost
    }
    fn firefox_pid(&mut self) -> Option<i32> {
        self.pid_lookups += 1;
        self.pid
    }
    fn nudge(&mut self, _pid: i32) {
        self.nudges += 1;
    }
    fn active_tab_url(&mut self, _pid: i32) -> Option<String> {
        self.url_reads += 1;
        self.url.clone()
    }
    fn redirect(&mut self, _pid: i32, url: &str) -> Result<bool, String> {
        self.redirects.push(url.to_string());
        if self.redirect_results.is_empty() {
            Ok(true)
        } else {
            self.redirect_results.remove(0)
        }
    }
}

fn tick(io: &mut FakeIo, state: &mut TickState) -> Status {
    tick_with_io(io, BLOCK_PAGE, state, Instant::now())
}

#[test]
fn does_nothing_when_firefox_is_on_the_extension() {
    let mut io = FakeIo {
        accessibility: false,
        ..FakeIo::watching("https://reddit.com/r/all", &["reddit.com"])
    };
    let mut state = TickState::default();
    assert_eq!(tick(&mut io, &mut state), Status::Inactive);
    assert!(io.redirects.is_empty(), "must not touch the extension path");
}

#[test]
fn reports_a_missing_grant_instead_of_enforcing() {
    let mut io = FakeIo {
        trusted: false,
        ..FakeIo::watching("https://reddit.com/r/all", &["reddit.com"])
    };
    let mut state = TickState::default();
    assert_eq!(tick(&mut io, &mut state), Status::NotTrusted);
    assert!(io.redirects.is_empty());
}

#[test]
fn reports_firefox_not_running() {
    let mut io = FakeIo {
        pid: None,
        ..FakeIo::watching("https://reddit.com/r/all", &["reddit.com"])
    };
    let mut state = TickState::default();
    assert_eq!(tick(&mut io, &mut state), Status::BrowserNotRunning);
}

#[test]
fn redirects_a_blocked_page_to_the_block_page() {
    let mut io = FakeIo::watching("https://reddit.com/r/all", &["reddit.com"]);
    let mut state = TickState::default();
    assert_eq!(tick(&mut io, &mut state), Status::Watching);
    assert_eq!(io.redirects.len(), 1);
    let target = &io.redirects[0];
    assert!(target.starts_with(BLOCK_PAGE), "redirected to {target}");
    // The original URL rides along so the restore pass can put the tab back.
    assert!(
        original_url_from_block_page(target).as_deref() == Some("https://reddit.com/r/all"),
        "block page lost the original URL: {target}"
    );
}

#[test]
fn leaves_an_unblocked_page_alone() {
    let mut io = FakeIo::watching("https://example.com/docs", &["reddit.com"]);
    let mut state = TickState::default();
    assert_eq!(tick(&mut io, &mut state), Status::Watching);
    assert!(io.redirects.is_empty());
}

#[test]
fn makes_no_decision_without_a_url_and_nudges_the_engine() {
    // An unreadable tab must not be redirected: "no answer" is not "blocked".
    let mut io = FakeIo {
        url: None,
        ..FakeIo::watching("", &["reddit.com"])
    };
    let mut state = TickState::default();
    assert_eq!(tick(&mut io, &mut state), Status::WaitingForEngine);
    assert!(io.redirects.is_empty());
    assert_eq!(io.nudges, 1);
}

#[test]
fn does_not_nudge_on_every_tick() {
    let mut io = FakeIo {
        url: None,
        ..FakeIo::watching("", &["reddit.com"])
    };
    let mut state = TickState::default();
    let start = Instant::now();
    tick_with_io(&mut io, BLOCK_PAGE, &mut state, start);
    tick_with_io(&mut io, BLOCK_PAGE, &mut state, start + TICK);
    assert_eq!(io.nudges, 1, "a nudge per tick would hammer the browser");
    tick_with_io(&mut io, BLOCK_PAGE, &mut state, start + NUDGE_INTERVAL);
    assert_eq!(io.nudges, 2);
}

#[test]
fn a_deferred_redirect_is_retried_rather_than_dropped() {
    let mut io = FakeIo {
        redirect_results: vec![Ok(false)],
        ..FakeIo::watching("https://reddit.com/r/all", &["reddit.com"])
    };
    let mut state = TickState::default();
    tick(&mut io, &mut state);
    tick(&mut io, &mut state);
    assert_eq!(
        io.redirects.len(),
        2,
        "a redirect deferred while the user typed must come back"
    );
}

#[test]
fn restores_a_parked_tab_once_the_block_stops() {
    let parked = build_blocked_url(
        BLOCK_PAGE,
        "https://reddit.com/r/all",
        &[block(&["reddit.com"])],
    );
    let mut io = FakeIo {
        // No domains: enforcement is over, as after a stop or an expiry.
        blocks: vec![block(&[])],
        ..FakeIo::watching(&parked, &[])
    };
    io.url = Some(parked);
    let mut state = TickState::default();
    assert_eq!(tick(&mut io, &mut state), Status::Watching);
    assert_eq!(io.redirects, vec!["https://reddit.com/r/all".to_string()]);
}

#[test]
fn keeps_a_parked_tab_parked_while_the_block_is_live() {
    let parked = build_blocked_url(
        BLOCK_PAGE,
        "https://reddit.com/r/all",
        &[block(&["reddit.com"])],
    );
    let mut io = FakeIo::watching(&parked, &["reddit.com"]);
    io.url = Some(parked);
    let mut state = TickState::default();
    assert_eq!(tick(&mut io, &mut state), Status::Watching);
    assert!(
        io.redirects.is_empty(),
        "restoring mid-block would hand the user the site back"
    );
}

#[test]
fn restores_even_when_other_blocks_are_still_active() {
    // Matches the extension's restoreUnblockedTabs and the Automation
    // watcher: a tab parked for a block that no longer covers it comes back
    // even while unrelated enforcement continues.
    let parked = build_blocked_url(
        BLOCK_PAGE,
        "https://reddit.com/r/all",
        &[block(&["reddit.com"])],
    );
    let mut io = FakeIo {
        blocks: vec![block(&["news.ycombinator.com"])],
        ..FakeIo::watching(&parked, &["news.ycombinator.com"])
    };
    io.url = Some(parked);
    let mut state = TickState::default();
    tick(&mut io, &mut state);
    assert_eq!(io.redirects, vec!["https://reddit.com/r/all".to_string()]);
}

#[test]
fn stays_idle_while_firefox_is_in_the_background_and_nothing_is_blocked() {
    // The startup restore latch starts armed. Draining it must wait for
    // Firefox to come to the front, not scan processes and walk the
    // accessibility tree every second behind the user's back.
    let mut io = FakeIo {
        blocks: vec![],
        frontmost: Some(false),
        ..FakeIo::watching("https://example.com/", &[])
    };
    let mut state = TickState::default();
    for _ in 0..3 {
        assert_eq!(tick(&mut io, &mut state), Status::Watching);
    }
    assert_eq!(io.pid_lookups, 0);
    assert_eq!(io.url_reads, 0);
}

#[test]
fn restores_a_parked_tab_once_firefox_comes_to_the_front() {
    let parked = build_blocked_url(
        BLOCK_PAGE,
        "https://reddit.com/r/all",
        &[block(&["reddit.com"])],
    );
    let mut io = FakeIo {
        blocks: vec![],
        frontmost: Some(false),
        ..FakeIo::watching(&parked, &[])
    };
    let mut state = TickState::default();
    tick(&mut io, &mut state);
    assert!(io.redirects.is_empty());
    io.frontmost = Some(true);
    tick(&mut io, &mut state);
    assert_eq!(io.redirects, vec!["https://reddit.com/r/all".to_string()]);
}

#[test]
fn still_enforces_a_live_block_on_a_background_firefox() {
    // Redirects are posted to the pid, so a visible background window is
    // enforced too; only the idle restore pass waits for the front.
    let mut io = FakeIo {
        frontmost: Some(false),
        ..FakeIo::watching("https://reddit.com/r/all", &["reddit.com"])
    };
    let mut state = TickState::default();
    tick(&mut io, &mut state);
    assert_eq!(io.redirects.len(), 1);
}

#[test]
fn backs_off_the_idle_restore_when_the_tab_never_answers() {
    // A new-tab page has no content URL, so the read never answers. With
    // nothing blocked that must not keep the watcher reading every second.
    let mut io = FakeIo {
        blocks: vec![],
        frontmost: Some(true),
        url: None,
        ..FakeIo::watching("", &[])
    };
    io.url = None;
    let mut state = TickState::default();
    let start = Instant::now();
    for i in 0..(IDLE_RESTORE_ATTEMPTS + 5) {
        tick_with_io(&mut io, BLOCK_PAGE, &mut state, start + TICK * i);
    }
    assert_eq!(io.url_reads, IDLE_RESTORE_ATTEMPTS as usize);
    assert!(state.needs_restore);
    let retry = start + TICK * (IDLE_RESTORE_ATTEMPTS - 1) + IDLE_RESTORE_RETRY;
    tick_with_io(&mut io, BLOCK_PAGE, &mut state, retry);
    assert_eq!(io.url_reads, IDLE_RESTORE_ATTEMPTS as usize + 1);
    tick_with_io(&mut io, BLOCK_PAGE, &mut state, retry + TICK);
    assert_eq!(io.url_reads, IDLE_RESTORE_ATTEMPTS as usize + 1);
}

#[test]
fn restores_a_parked_tab_after_idle_reads_back_off() {
    let mut io = FakeIo {
        blocks: vec![],
        url: None,
        ..FakeIo::watching("", &[])
    };
    let mut state = TickState::default();
    let start = Instant::now();
    for i in 0..IDLE_RESTORE_ATTEMPTS {
        tick_with_io(&mut io, BLOCK_PAGE, &mut state, start + TICK * i);
    }
    io.url = Some(build_blocked_url(
        BLOCK_PAGE,
        "https://reddit.com/r/all",
        &[block(&["reddit.com"])],
    ));
    let retry = start + TICK * (IDLE_RESTORE_ATTEMPTS - 1) + IDLE_RESTORE_RETRY;
    tick_with_io(&mut io, BLOCK_PAGE, &mut state, retry);
    assert_eq!(io.redirects, vec!["https://reddit.com/r/all".to_string()]);
    assert!(!state.needs_restore);
}

#[test]
fn a_firefox_that_quits_during_the_idle_backoff_reports_not_running() {
    let mut io = FakeIo {
        blocks: vec![],
        url: None,
        ..FakeIo::watching("", &[])
    };
    let mut state = TickState::default();
    let start = Instant::now();
    for i in 0..IDLE_RESTORE_ATTEMPTS {
        tick_with_io(&mut io, BLOCK_PAGE, &mut state, start + TICK * i);
    }
    assert!(state.next_idle_read.is_some(), "back-off should be armed");
    io.pid = None;
    let quit = start + TICK * IDLE_RESTORE_ATTEMPTS;
    assert_eq!(
        tick_with_io(&mut io, BLOCK_PAGE, &mut state, quit),
        Status::BrowserNotRunning
    );
    // A relaunch reads straight away rather than waiting out the old
    // instance's back-off.
    io.pid = Some(4243);
    let reads = io.url_reads;
    tick_with_io(&mut io, BLOCK_PAGE, &mut state, quit + TICK);
    assert_eq!(io.url_reads, reads + 1);
}

#[test]
fn a_live_block_bypasses_the_idle_restore_backoff() {
    let mut io = FakeIo {
        blocks: vec![],
        url: None,
        ..FakeIo::watching("", &[])
    };
    let mut state = TickState::default();
    let start = Instant::now();
    for i in 0..IDLE_RESTORE_ATTEMPTS {
        tick_with_io(&mut io, BLOCK_PAGE, &mut state, start + TICK * i);
    }
    io.blocks = vec![block(&["reddit.com"])];
    io.url = Some("https://reddit.com/r/all".to_string());
    tick_with_io(
        &mut io,
        BLOCK_PAGE,
        &mut state,
        start + TICK * IDLE_RESTORE_ATTEMPTS,
    );
    assert_eq!(io.redirects.len(), 1);
    assert!(is_block_page_url(&io.redirects[0], BLOCK_PAGE));
}

#[test]
fn an_unanswered_tab_during_a_block_is_never_given_up_on() {
    let mut io = FakeIo {
        url: None,
        ..FakeIo::watching("", &["reddit.com"])
    };
    let mut state = TickState::default();
    let start = Instant::now();
    for i in 0..(IDLE_RESTORE_ATTEMPTS + 5) {
        tick_with_io(&mut io, BLOCK_PAGE, &mut state, start + TICK * i);
    }
    assert_eq!(io.url_reads, (IDLE_RESTORE_ATTEMPTS + 5) as usize);
}
