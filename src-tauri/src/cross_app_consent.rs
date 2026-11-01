//! EULA gate for native desktop observation.

#[cfg(target_os = "macos")]
fn has_accepted_eula_in_data() -> bool {
    let path = crate::commands::canonical_data_path_static();
    let Ok(raw) = std::fs::read_to_string(path) else {
        return false;
    };
    let Ok(data) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return false;
    };
    let Some(settings) = data.get("settings") else {
        return false;
    };
    settings
        .get("eulaAcceptedRevision")
        .and_then(|v| v.as_u64().or_else(|| v.as_i64().map(|n| n.max(0) as u64)))
        .is_some_and(|n| n > 0)
        || settings
            .get("eulaAccepted")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
}

/// True when the macOS website-automation watcher may run (EULA only).
#[cfg(target_os = "macos")]
pub fn should_run_web_automation() -> bool {
    if !has_accepted_eula_in_data() {
        log::info!("tcc-probe: deferring web automation — EULA not accepted in data file");
        return false;
    }
    true
}

#[cfg(not(target_os = "macos"))]
pub fn should_run_web_automation() -> bool {
    true
}
