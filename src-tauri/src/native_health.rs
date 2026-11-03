//! Diagnostic worker health and permission recovery; no browser termination.
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

static HEALTH: OnceLock<Mutex<HashMap<String, serde_json::Value>>> = OnceLock::new();
static PERMISSIONS: OnceLock<Mutex<HashMap<String, bool>>> = OnceLock::new();

pub fn record_health(transport: &str, status: &str, reason: Option<&str>) {
    if let Ok(mut health) = HEALTH.get_or_init(Default::default).lock() {
        health.insert(
            transport.into(),
            serde_json::json!({"status": status, "reason": reason}),
        );
    }
}

/// Refresh the recovery UI on a changed grant, without polling a second time
/// in the backend. Unknown readings must never be reported as granted.
pub fn permission_changed(app: &AppHandle, browser: &str, granted: bool) {
    let changed = PERMISSIONS
        .get_or_init(Default::default)
        .lock()
        .map(|mut permissions| permissions.insert(browser.into(), granted) != Some(granted))
        .unwrap_or(false);
    if changed {
        let _ = app.emit("native-permission-changed", browser);
    }
}

pub fn snapshot() -> serde_json::Value {
    let health = HEALTH
        .get_or_init(Default::default)
        .lock()
        .map(|health| health.clone())
        .unwrap_or_default();
    serde_json::json!({"workerHealth": health})
}
