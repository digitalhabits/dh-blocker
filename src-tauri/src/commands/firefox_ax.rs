// Tauri commands for the Firefox Accessibility watcher (macOS only). The
// watcher lives in `crate::firefox_ax`; this mirrors
// `commands/web_automation.rs`, including reusing its block-page resolver so
// the two watchers can never disagree about where blocked.html is.

use std::sync::Mutex;

use tauri::{AppHandle, State};

use crate::firefox_ax::{self, FirefoxAxHandle, Status};

pub struct FirefoxAxState(pub Mutex<Option<FirefoxAxHandle>>);

impl Default for FirefoxAxState {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

/// Start the Firefox watcher if it is not already running. Idempotent, and
/// safe to call when Firefox is on the extension: the tick itself checks the
/// selected method every pass, so switching methods needs no restart.
///
/// Gated on EULA acceptance like the Automation watcher. It is *not* gated on
/// the Accessibility grant: the watcher reports `NotTrusted` so the UI can
/// say so, which is more useful than refusing to start.
#[tauri::command]
pub fn firefox_ax_start(app: AppHandle, state: State<FirefoxAxState>) {
    let mut slot = state.0.lock().expect("firefox_ax lock");
    if slot.is_none() {
        match super::web_automation::resolve_block_page_url(&app) {
            Some(url) => *slot = Some(firefox_ax::start(app.clone(), url)),
            None => {
                log::warn!("firefox_ax: not starting — no block page URL");
                return;
            }
        }
    }
    let ok = crate::cross_app_consent::should_run_web_automation();
    if let Some(h) = slot.as_ref() {
        h.set_enabled(ok);
        if !ok {
            log::info!("firefox_ax: start ignored — EULA not accepted");
        }
    }
}

#[tauri::command]
pub fn firefox_ax_pause(state: State<FirefoxAxState>) {
    if let Some(h) = state.0.lock().expect("firefox_ax lock").as_ref() {
        h.set_enabled(false);
    }
}

/// What the watcher is doing, for the settings and diagnostics UI. The
/// interesting values are `NotTrusted` (the user revoked the grant, so
/// Firefox is unenforced) and `WaitingForEngine`.
#[tauri::command]
pub fn firefox_ax_status(state: State<FirefoxAxState>) -> Status {
    state
        .0
        .lock()
        .expect("firefox_ax lock")
        .as_ref()
        .map(|h| h.status())
        .unwrap_or(Status::Inactive)
}

/// Whether this process holds the Accessibility grant.
///
/// Separate from `firefox_ax_status` because the settings screen asks before
/// the watcher is necessarily running — the user has to be able to grant
/// permission *and then* switch method.
#[tauri::command]
pub fn accessibility_trusted() -> bool {
    crate::accessibility::is_trusted()
}

/// Show the system prompt, then open the Accessibility pane.
///
/// Nothing in-process can grant this permission: the prompt only deep-links
/// to System Settings, where the user must find the app and flip a switch. So
/// the UI has to explain the manual step regardless of what this returns, and
/// the pane is opened to spare the user the hunt.
#[tauri::command]
pub fn accessibility_request() -> Result<bool, String> {
    let already = crate::accessibility::prompt_for_trust();
    if !already {
        crate::accessibility::open_settings()?;
    }
    Ok(already)
}

#[tauri::command]
pub fn accessibility_open_settings() -> Result<(), String> {
    crate::accessibility::open_settings()
}

/// Register the watcher state handle on the app.
pub fn register<R: tauri::Runtime>(app: &tauri::App<R>) {
    use tauri::Manager;
    app.manage(FirefoxAxState::default());
}

/// Auto-start at launch, paused until onboarding is done — the same gate as
/// the Automation watcher.
///
/// Starting unconditionally (rather than only when Firefox is set to
/// Accessibility) keeps method switching instant: the tick re-reads the
/// method every pass and goes idle in one tick when it is not selected. An
/// idle tick reads nothing and synthesises nothing.
pub fn auto_start(app: &AppHandle) {
    let url = match super::web_automation::resolve_block_page_url(app) {
        Some(u) => u,
        None => {
            log::warn!("firefox_ax: skipping auto_start — no block page URL");
            return;
        }
    };
    let handle = firefox_ax::start(app.clone(), url);

    let pending = crate::commands::migration::migration_pending_sync();
    let eula_ok = crate::cross_app_consent::should_run_web_automation();
    let enabled = !pending && eula_ok;
    handle.set_enabled(enabled);
    if pending {
        log::info!("firefox_ax: starting paused (migration onboarding pending)");
    } else if !eula_ok {
        log::info!("firefox_ax: starting paused (EULA not accepted)");
    }

    use tauri::Manager;
    let state = app.state::<FirefoxAxState>();
    // Bound rather than used as a tail `if let`: the guard must drop before
    // the `State` borrow it came from.
    let Ok(mut slot) = state.0.lock() else {
        log::warn!("firefox_ax: state lock poisoned, watcher handle dropped");
        return;
    };
    *slot = Some(handle);
}
