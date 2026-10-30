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
    fn firefox_pid(&mut self) -> Option<i32> {
        self.pid
    }
    fn nudge(&mut self, _pid: i32) {
        self.nudges += 1;
    }
    fn active_tab_url(&mut self, _pid: i32) -> Option<String> {
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
    let parked = build_blocked_url(BLOCK_PAGE, "https://reddit.com/r/all", &[block(&["reddit.com"])]);
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
    let parked = build_blocked_url(BLOCK_PAGE, "https://reddit.com/r/all", &[block(&["reddit.com"])]);
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
    let parked = build_blocked_url(BLOCK_PAGE, "https://reddit.com/r/all", &[block(&["reddit.com"])]);
    let mut io = FakeIo {
        blocks: vec![block(&["news.ycombinator.com"])],
        ..FakeIo::watching(&parked, &["news.ycombinator.com"])
    };
    io.url = Some(parked);
    let mut state = TickState::default();
    tick(&mut io, &mut state);
    assert_eq!(io.redirects, vec!["https://reddit.com/r/all".to_string()]);
}
