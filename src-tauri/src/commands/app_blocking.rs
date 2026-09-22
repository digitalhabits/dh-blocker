// Tauri commands that drive the in-process app watcher.
// These replace the helper-mediated `set_blocked_apps_via_helper`
// path once the migration lands.

use std::collections::HashSet;
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager, State};

use crate::app_watcher::{self, Handle};

pub struct AppWatcherState(pub Mutex<Option<Handle>>);

impl Default for AppWatcherState {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

/// Replace the effective blocked-app set. Starts the watcher on first
/// call; subsequent calls update the set in place. The `AppHandle` is
/// captured so the watcher can emit warning events and pin the main
/// window — see `app_watcher::start`.
///
/// `newly_added` is the subset of `apps` that just transitioned from
/// "not blocked" to "blocked" (block start, schedule activation,
/// unpause, …). The watcher uses this list to decide which path a
/// first-sighting takes: names in `newly_added` raise the Let's-go
/// warning, names that were already blocked get the silent SIGTERM
/// mid-block path. The frontend is responsible for computing the
/// diff — `app_blocking.js` tracks the previous set across
/// `updateBlockedApps` calls.
#[tauri::command]
pub fn set_blocked_apps(
    app: AppHandle,
    apps: Vec<String>,
    newly_added: Vec<String>,
    allowed_apps: Vec<String>,
    allowlist_active: bool,
    allowlist_newly_started: bool,
    state: State<AppWatcherState>,
) {
    let mut slot = state.0.lock().expect("app-watcher lock");
    if slot.is_none() {
        *slot = Some(app_watcher::start(Some(app)));
    }
    if let Some(h) = slot.as_ref() {
        h.set_policy(
            apps,
            newly_added,
            allowed_apps,
            allowlist_active,
            allowlist_newly_started,
        );
    }
}

/// Stop the watcher and clear the blocked set.
#[tauri::command]
pub fn clear_blocked_apps(state: State<AppWatcherState>) {
    let mut slot = state.0.lock().expect("app-watcher lock");
    if let Some(h) = slot.take() {
        h.stop();
    }
}

/// User clicked the single “bring apps forward & quit again” control.
/// `pids` are the processes currently shown in the warning overlay.
#[tauri::command]
pub fn app_blocking_bring_forward_then_quit_again(pids: Vec<u32>) {
    crate::app_watcher::user_request_activate_then_polite_quit_round(&pids);
}

/// Frontend's "Let's go!" button. Two things happen:
///
/// 1. **Phase transition.** Every PID currently in `AwaitingUserAck`
///    moves to `PreQuit` (30-second wrap-up before polite Cmd-Q).
///    Handled by the watcher next sweep via `user_acknowledge_warning`.
///
/// 2. **Dismiss the full-screen overlay.** The window resizes back to
///    its previous size + drops always-on-top, even though the watcher
///    keeps the PIDs in flight. From here the in-app countdown banner
///    (rendered by JS) carries the wrap-up timer; the user can keep
///    using the rest of the system normally.
#[tauri::command]
pub fn lets_go_acknowledge(app: AppHandle) {
    crate::app_watcher::user_acknowledge_warning();
    crate::app_watcher::force_dismiss_warning_overlay(Some(&app));
}

/// User clicked "Snooze for 2 mins" on a schedule-block warning. Dismiss
/// the always-on-top overlay without transitioning awaiting PIDs to
/// PreQuit — the watcher keeps them in `AwaitingUserAck` until the user
/// clicks "Let's go!" (or the snooze timer re-shows the overlay).
#[tauri::command]
pub fn snooze_blocking_warning(app: AppHandle) {
    crate::app_watcher::force_dismiss_warning_overlay(Some(&app));
}

/// Re-enter panel mode after a schedule snooze expires. The frontend
/// re-renders the overlay DOM; this restores compact-window chrome and
/// brings the blocked apps forward again.
#[tauri::command]
pub fn reshow_blocking_warning(app: AppHandle, pids: Vec<u32>) {
    crate::app_watcher::blocking_warning_begin(Some(&app));
    crate::commands::show_blocking_warning_shell_without_stealing_focus(&app);
    for pid in pids {
        crate::commands::activate_external_process_by_pid(pid);
    }
}

/// Restore normal window geometry when the frontend has no warning overlay
/// to show but the native shell is still expanded (e.g. page reload or a
/// race before JS listeners attach).
///
/// If PIDs are still awaiting Let's go, leave the shell up — the frontend
/// should seed from [`list_pending_blocking_warnings`] rather than tear
/// chrome down underneath an in-flight ack.
#[tauri::command]
#[cfg(not(target_os = "ios"))]
pub fn reconcile_blocking_warning_shell(app: AppHandle) {
    if !app_watcher::pending_warning_acks().is_empty() {
        return;
    }
    if app_watcher::blocking_warning_shell_active() {
        // Refcount says the shell is up, but nothing is awaiting ack —
        // force a clean leave so geometry / traffic lights can't stick.
        app_watcher::force_dismiss_warning_overlay(Some(&app));
        return;
    }
    crate::commands::leave_blocking_warning_compact_window(&app);
}

#[tauri::command]
#[cfg(target_os = "ios")]
pub fn reconcile_blocking_warning_shell(_app: AppHandle) {}

/// PIDs still waiting on Let's go. The frontend calls this right after
/// attaching `warning-show` listeners so any events emitted during cold
/// start (before `listen` was ready) still populate the overlay.
#[tauri::command]
#[cfg(not(target_os = "ios"))]
pub fn list_pending_blocking_warnings() -> Vec<app_watcher::PendingBlockingWarning> {
    app_watcher::pending_warning_acks()
}

#[tauri::command]
#[cfg(target_os = "ios")]
pub fn list_pending_blocking_warnings() -> Vec<app_watcher::PendingBlockingWarning> {
    Vec::new()
}

/// Re-read `redd-block-data.json` and push the effective blocked/allowed
/// app sets into the watcher. Mirrors the frontend's `updateBlockedApps`
/// merge so allowlist enforcement survives periodic syncs and `save_data`.
pub fn sync_blocked_apps_from_disk(app: &AppHandle) {
    let path = super::canonical_data_path_static();
    let desired_blocked = crate::native_host::derive_blocked_apps(&path);
    let desired_allowed = crate::native_host::derive_allowed_apps(&path);
    let allowlist_active = !desired_allowed.is_empty();
    let state = app.state::<AppWatcherState>();
    let mut slot = match state.0.lock() {
        Ok(s) => s,
        Err(_) => return,
    };
    if slot.is_none() {
        *slot = Some(app_watcher::start(Some(app.clone())));
    }
    let Some(handle) = slot.as_ref() else {
        return;
    };
    let previous_blocked: HashSet<String> = handle.current_apps().into_iter().collect();
    let newly_added_blocked: Vec<String> = desired_blocked
        .iter()
        .filter(|a| !previous_blocked.contains(*a))
        .cloned()
        .collect();
    // No explicit block-start flag from disk sync: the watcher derives the
    // inactive→active transition from its own previous state (see
    // `app_watcher::allowlist_block_started`), so this sync arms the
    // warning sweep exactly when the file flips into an allow block.
    handle.set_policy(
        desired_blocked,
        newly_added_blocked,
        desired_allowed,
        allowlist_active,
        false,
    );
}

pub fn register(app: &tauri::App) {
    app.manage(AppWatcherState::default());
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let handle = app.handle().clone();
        std::thread::spawn(move || loop {
            sync_blocked_apps_from_disk(&handle);
            std::thread::sleep(Duration::from_secs(2));
        });
    }
}
