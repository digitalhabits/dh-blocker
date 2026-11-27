// Tauri commands that control the in-process enforcer loop.

use std::sync::Mutex;

use tauri::{AppHandle, Manager, State};

use crate::enforcer::{self, EnforcerHandle};

pub struct EnforcerState(pub Mutex<Option<EnforcerHandle>>);

impl Default for EnforcerState {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

/// Start the enforcer loop if not already running. Idempotent.
#[tauri::command]
pub fn enforcer_start(app: AppHandle, state: State<EnforcerState>) {
    let mut slot = state.0.lock().expect("enforcer lock");
    if slot.is_none() {
        *slot = Some(enforcer::start(app));
    }
    let cross_app_ok = crate::cross_app_consent::should_run_enforcer();
    if let Some(h) = slot.as_ref() {
        h.set_enabled(cross_app_ok);
        if !cross_app_ok {
            log::info!("enforcer: enforcer_start ignored — EULA not accepted");
        }
    }
}

/// Pause the enforcer without tearing it down. Timers reset.
#[tauri::command]
pub fn enforcer_pause(state: State<EnforcerState>) {
    if let Some(h) = state.0.lock().expect("enforcer lock").as_ref() {
        h.set_enabled(false);
    }
}

/// Register the enforcer state on the app so commands can access it.
pub fn register<R: tauri::Runtime>(app: &tauri::App<R>) {
    app.manage(EnforcerState::default());
}

/// Auto-start the enforcer at app launch. The enforcer scans browsers
/// every 5 s for missing/disabled extensions and quits the browser if
/// the user doesn't fix it within the grace window.
///
/// IMPORTANT: we start the enforcer **paused** when either:
///   - a v1.x → 2.0 migration is pending (same rationale as before), or
///   - the EULA has not yet been accepted.
///
/// The enforcer's tick loop reads Firefox profile data to detect a
/// disabled extension — that read needs FDA and is skipped until the
/// user grants it. Safari/Chromium on macOS are judged via Automation
/// (no profile reads). Defer until the frontend calls `enforcer_start`
/// after EULA acceptance. See `runPostAcceptanceStartup` in app.js.
pub fn auto_start(app: &tauri::AppHandle) {
    use tauri::Manager;
    let h = enforcer::start(app.clone());

    let pending = crate::commands::migration::migration_pending_sync();
    let cross_app_ok = crate::cross_app_consent::should_run_enforcer();

    let enabled = !pending && cross_app_ok;
    h.set_enabled(enabled);
    if pending {
        log::info!("enforcer: starting paused (migration onboarding pending)");
    } else if !cross_app_ok {
        log::info!("enforcer: starting paused (EULA not accepted)");
    }

    let state = app.state::<EnforcerState>();
    if let Ok(mut slot) = state.0.lock() {
        *slot = Some(h);
    };
}
