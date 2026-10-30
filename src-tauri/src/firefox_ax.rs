//! Firefox website blocking on macOS over the Accessibility API.
//!
//! The Automation watcher (`crate::web_automation`) cannot serve Firefox:
//! Firefox ships no `tab` class, so the read script does not compile. This
//! watcher is the opt-in alternative to Firefox's extension, and it differs
//! from the Automation one in ways that follow from the API rather than from
//! taste:
//!
//! - **The active tab only.** Accessibility exposes the laid-out document,
//!   not every tab, so a blocked page in a background tab is caught when the
//!   user switches to it rather than beforehand. For a blocker that is the
//!   moment that matters.
//! - **No per-browser permission.** There is one system-wide Accessibility
//!   grant instead of Automation's per-browser TCC pairs, so there is no
//!   per-browser permission state to track, and no `-1743` to recover from —
//!   only "trusted" or not.
//! - **Redirects are user-shaped.** There is no `set URL`; the address bar is
//!   driven the way a person would drive it, which is why a redirect defers
//!   while the user is typing there.
//!
//! Decisions reuse `web_automation`'s helpers verbatim — `url_is_blocked`,
//! `build_blocked_url`, `is_block_page_url`, `original_url_from_block_page` —
//! so Firefox cannot drift into blocking a different set of URLs than the
//! other browsers. Only the transport differs.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::AppHandle;

use crate::native_host::{self, BlockInfo};
use crate::web_automation::{
    build_blocked_url, is_block_page_url, original_url_from_block_page, url_is_blocked,
    web_enforcement_active,
};

/// Same cadence as the Automation watcher: the user notices a redirect that
/// takes longer than about a second.
const TICK: Duration = Duration::from_millis(1000);

/// How often to re-nudge a Firefox whose accessibility engine has not come
/// up. The engine is instantiated lazily and the handshake is unsupported
/// (see `crate::accessibility::nudge_accessibility`), so the only recourse is
/// to ask again rather than to ask harder.
const NUDGE_INTERVAL: Duration = Duration::from_secs(5);

#[derive(Default)]
struct Shared {
    enabled: bool,
    /// Last read outcome, for the diagnostics UI: the grant can be revoked
    /// mid-session and the user deserves to be told enforcement has stopped.
    status: Status,
}

/// What the watcher can report about itself.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    /// Not selected as Firefox's blocking method.
    #[default]
    Inactive,
    /// Selected, but the Accessibility grant is missing.
    NotTrusted,
    /// Selected and granted, but Firefox is not running.
    BrowserNotRunning,
    /// Selected and granted, but the accessibility engine has not answered
    /// yet. Firefox is unenforced while this lasts.
    WaitingForEngine,
    /// Reading the active tab.
    Watching,
}

pub struct FirefoxAxHandle {
    shared: Arc<Mutex<Shared>>,
}

impl FirefoxAxHandle {
    pub fn set_enabled(&self, enabled: bool) {
        if let Ok(mut s) = self.shared.lock() {
            s.enabled = enabled;
        }
    }

    pub fn status(&self) -> Status {
        self.shared
            .lock()
            .map(|s| s.status)
            .unwrap_or(Status::Inactive)
    }
}

/// Everything the tick touches outside itself, so the decisions can be
/// tested without a browser, a grant, or a data file — the same shape
/// `web_automation` uses.
trait FirefoxIo {
    fn active_blocks(&mut self) -> Option<Vec<BlockInfo>>;
    fn uses_accessibility(&mut self) -> bool;
    fn trusted(&mut self) -> bool;
    fn firefox_pid(&mut self) -> Option<i32>;
    fn nudge(&mut self, pid: i32);
    fn active_tab_url(&mut self, pid: i32) -> Option<String>;
    /// `Ok(false)` means the redirect was deliberately deferred.
    fn redirect(&mut self, pid: i32, url: &str) -> Result<bool, String>;
}

struct ProductionIo<'a> {
    app: &'a AppHandle,
}

impl FirefoxIo for ProductionIo<'_> {
    fn active_blocks(&mut self) -> Option<Vec<BlockInfo>> {
        let path = crate::commands::canonical_data_path(self.app)?;
        let (_domains, blocks) = native_host::derive_payload(&path);
        Some(blocks)
    }

    fn uses_accessibility(&mut self) -> bool {
        crate::blocking_method::uses_accessibility(self.app, "firefox")
    }

    fn trusted(&mut self) -> bool {
        crate::accessibility::is_trusted()
    }

    fn firefox_pid(&mut self) -> Option<i32> {
        firefox_pid()
    }

    fn nudge(&mut self, pid: i32) {
        crate::accessibility::nudge_accessibility(pid);
    }

    fn active_tab_url(&mut self, pid: i32) -> Option<String> {
        crate::accessibility::active_tab_url(pid)
    }

    fn redirect(&mut self, pid: i32, url: &str) -> Result<bool, String> {
        crate::accessibility::redirect_active_tab(pid, url)
    }
}

/// Process-name match, like `web_automation::running_supported_browsers`.
/// Firefox's main process is plain `firefox`; its content and GPU children
/// carry other names, so this cannot match them by accident.
pub fn firefox_pid() -> Option<i32> {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};
    let mut sys = System::new();
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
    sys.processes()
        .values()
        .find(|p| p.name().to_string_lossy() == "firefox")
        .map(|p| p.pid().as_u32() as i32)
}

/// Per-tick state that outlives one call.
struct TickState {
    /// Set while enforcement is on, so a later pause/stop/expiry still
    /// restores a tab parked on the block page. Starts true to clear
    /// leftovers from a previous session, exactly as the Automation
    /// watcher does.
    needs_restore: bool,
    last_nudge: Option<Instant>,
}

impl Default for TickState {
    fn default() -> Self {
        Self {
            needs_restore: true,
            last_nudge: None,
        }
    }
}

/// Spawn the Firefox watcher. `block_page_url` is the `file://` base URL of
/// the bundled blocked.html, resolved by the caller just as for the
/// Automation watcher.
pub fn start(app: AppHandle, block_page_url: String) -> FirefoxAxHandle {
    let shared = Arc::new(Mutex::new(Shared::default()));
    let shared_thread = shared.clone();
    std::thread::spawn(move || {
        let mut state = TickState::default();
        loop {
            std::thread::sleep(TICK);
            let enabled = shared_thread.lock().map(|s| s.enabled).unwrap_or(false);
            if !enabled {
                continue;
            }
            // Displays off: nobody can see a blocked tab, and synthesising
            // keystrokes into a sleeping machine is worse than waiting.
            if crate::workspace_events::screen_asleep() {
                continue;
            }
            let mut io = ProductionIo { app: &app };
            let status = tick_with_io(&mut io, &block_page_url, &mut state, Instant::now());
            if let Ok(mut s) = shared_thread.lock() {
                s.status = status;
            }
        }
    });
    FirefoxAxHandle { shared }
}

fn tick_with_io<I: FirefoxIo>(
    io: &mut I,
    block_page_url: &str,
    state: &mut TickState,
    now: Instant,
) -> Status {
    if !io.uses_accessibility() {
        // Switching Firefox back to the extension leaves the latch armed, so
        // the next pass still restores anything parked on the block page —
        // but that pass can only run while this watcher is selected. The
        // extension path does its own restoring, so dropping the latch here
        // would not strand a tab.
        state.needs_restore = false;
        return Status::Inactive;
    }
    if !io.trusted() {
        return Status::NotTrusted;
    }
    let Some(blocks) = io.active_blocks() else {
        return Status::Watching;
    };
    let blocking_active = web_enforcement_active(&blocks);
    if blocking_active {
        state.needs_restore = true;
    } else if !state.needs_restore {
        return Status::Watching;
    }

    let Some(pid) = io.firefox_pid() else {
        return Status::BrowserNotRunning;
    };

    let Some(url) = io.active_tab_url(pid) else {
        // No answer: either the engine is still asleep or the tab is not
        // readable. Nudge at most every NUDGE_INTERVAL and make no decision
        // — guessing here would redirect a page we never identified.
        if state
            .last_nudge
            .map(|t| now.saturating_duration_since(t) >= NUDGE_INTERVAL)
            .unwrap_or(true)
        {
            io.nudge(pid);
            state.last_nudge = Some(now);
        }
        return Status::WaitingForEngine;
    };

    // Already parked on our block page: restore when the block that put it
    // there no longer applies.
    if is_block_page_url(&url, block_page_url) {
        if let Some(original) = original_url_from_block_page(&url) {
            if !blocking_active || !url_is_blocked(&original, &blocks) {
                match io.redirect(pid, &original) {
                    Ok(true) => state.needs_restore = false,
                    // Deferred, or failed: keep the latch armed and retry.
                    Ok(false) => {}
                    Err(e) => log::warn!("firefox_ax: restore failed: {e}"),
                }
            }
        }
        return Status::Watching;
    }

    if blocking_active && url_is_blocked(&url, &blocks) {
        let blocked_url = build_blocked_url(block_page_url, &url, &blocks);
        match io.redirect(pid, &blocked_url) {
            Ok(true) => log::info!("firefox_ax: redirected the active tab to the block page"),
            Ok(false) => log::debug!("firefox_ax: redirect deferred, the address bar has focus"),
            Err(e) => log::warn!("firefox_ax: redirect failed: {e}"),
        }
    } else if !blocking_active {
        // A full pass with nothing left to restore.
        state.needs_restore = false;
    }
    Status::Watching
}

#[cfg(test)]
mod tests;
