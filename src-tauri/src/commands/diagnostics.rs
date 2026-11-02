//! System diagnostics — single command that returns a structured
//! snapshot of the app's runtime state. Replaces the v1.x-era
//! `get_helper_diagnostics` which only reported `{version, "extension"}`.
//!
//! Surface area kept *small*: things a user or support engineer
//! would actually want to see when the app is misbehaving. We
//! deliberately avoid putting tray-state, window-position, or
//! other internals in here — they're noise.

use serde::Serialize;

use crate::website_policy;

#[derive(Debug, Clone, Serialize)]
pub struct AppInfo {
    pub version: String,
    pub build_mode: &'static str,
    pub os: &'static str,
    pub arch: &'static str,
}

#[derive(Debug, Clone, Serialize)]
pub struct MigrationInfo {
    /// Human-readable list of v1.x leftover items found on disk
    /// right now. Empty when fully clean.
    pub residue_items: Vec<String>,
    /// True if /etc/hosts.redd-backup (or Windows equivalent) exists,
    /// signalling this install ever ran v1.x. Kept around as a
    /// recovery copy by design — does NOT count as residue.
    pub came_from_v1x: bool,
    /// Last value the in-app migration stamped into settings.
    pub ran_at_version: Option<String>,
    /// Unix-millis of the last in-app migration completion. None
    /// when the .pkg preinstall did the cleanup (no in-app run).
    pub ran_at_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AutostartInfo {
    pub enabled: bool,
}

/// macOS Automation (Apple Events) permission snapshot for Safari and
/// Chromium-family browsers. Inert on other platforms so the JSON shape
/// is stable.
#[derive(Debug, Clone, Serialize)]
pub struct AutomationBrowserInfo {
    pub label: String,
    /// `granted`, `denied`, or `unknown`
    pub state: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AutomationInfo {
    pub applicable: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub browsers: Vec<AutomationBrowserInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[cfg(target_os = "windows")]
pub struct WatchdogInfo {
    pub task_present: bool,
}

/// Snapshot of what's actually being enforced right now. The
/// `domains` / `blocks` fields are produced by reusing
/// `website_policy::derive_payload` — i.e. literally the same function
/// used by the native website watchers. The `apps` list is read straight out of the in-process
/// app watcher's effective set. Both fields are derived data, never
/// recomputed from scratch in this module.
#[derive(Debug, Clone, Serialize)]
pub struct CurrentBlocking {
    /// Flat, deduplicated blocked-domain union.
    pub domains: Vec<String>,
    /// Per-block breakdown: which blocklist contributed the domains,
    /// whether the source is an `activeBlock` (one-off) or a
    /// `schedule`, and the segment's start/end timestamps. Sorted
    /// ascending by `endsAt`.
    pub blocks: Vec<website_policy::BlockInfo>,
    /// Effective blocked-app set the in-process watcher will kill on
    /// its next poll tick. Empty when no blocked apps are active or
    /// the watcher has not been started.
    pub apps: Vec<String>,
    /// Effective allowlist-mode allowed-app union (watcher snapshot or
    /// on-disk derivation when the watcher is not seeded yet).
    pub allowed_apps: Vec<String>,
    /// True when allowlist-mode app enforcement is active.
    pub allowlist_active: bool,
    /// Sorted union of allowed websites from active allowlist blocks.
    pub allowed_domains: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AppDataInfo {
    /// Canonical path of redd-block-data.json (for display).
    pub path: Option<String>,
    /// File contents reformatted via serde_json so the user sees a
    /// pretty, deterministic view (helps eyeball schedules / active
    /// blocks / pause state). Falls back to the raw file content if
    /// the file is not parseable JSON, and is None if the file could
    /// not be read.
    pub pretty_json: Option<String>,
    /// Populated only when reading the file failed.
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SystemDiagnostics {
    pub app: AppInfo,
    pub migration: MigrationInfo,
    pub autostart: AutostartInfo,
    pub automation: AutomationInfo,
    /// Observed native failures; an empty set does not prove watcher health.
    pub native_website_failures: serde_json::Value,
    #[cfg(target_os = "windows")]
    pub watchdog: WatchdogInfo,
    /// Last N lines of the rolling app log, newest last. Empty in
    /// release builds (we only enable tauri-plugin-log in debug).
    pub recent_log: Vec<String>,
    /// What's *actually* being enforced at the time this struct is
    /// built — effective native website rules and apps
    /// loaded into the watcher.
    pub current_blocking: CurrentBlocking,
    /// Snapshot of the on-disk app-data file. Surfaced so the user
    /// (or a support engineer) can sanity-check what blocklists,
    /// active blocks, schedules, and pause state are persisted right
    /// now without poking around in the filesystem.
    pub app_data: AppDataInfo,
}

#[tauri::command]
pub async fn get_system_diagnostics(app: tauri::AppHandle) -> SystemDiagnostics {
    // Build off the WebView thread. The collection path deliberately
    // avoids profile-tree walks, live TCC probes, and native-host
    // syncs — those can block forever behind a modal on macOS Sequoia.
    tauri::async_runtime::spawn_blocking(move || assemble_system_diagnostics(app))
        .await
        .unwrap_or_else(|_| assemble_system_diagnostics_minimal())
}

fn assemble_system_diagnostics(app: tauri::AppHandle) -> SystemDiagnostics {
    let app_info = AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        build_mode: if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        },
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
    };

    let migration = collect_migration_info(&app);
    let autostart = AutostartInfo {
        enabled: autostart_enabled(&app),
    };
    let automation = collect_automation_info_cached(&app);

    #[cfg(target_os = "windows")]
    let watchdog = WatchdogInfo {
        task_present: crate::watchdog::is_registered(),
    };

    let recent_log = read_recent_log_lines(50);
    let current_blocking = collect_current_blocking(&app);
    let app_data = collect_app_data_info(&app);

    SystemDiagnostics {
        app: app_info,
        migration,
        autostart,
        automation,
        native_website_failures: crate::native_failure::snapshot(),
        #[cfg(target_os = "windows")]
        watchdog,
        recent_log,
        current_blocking,
        app_data,
    }
}

/// Fallback when the blocking worker panics — still returns a valid
/// shape so the frontend can render an error section.
fn assemble_system_diagnostics_minimal() -> SystemDiagnostics {
    SystemDiagnostics {
        app: AppInfo {
            version: env!("CARGO_PKG_VERSION").to_string(),
            build_mode: if cfg!(debug_assertions) {
                "debug"
            } else {
                "release"
            },
            os: std::env::consts::OS,
            arch: std::env::consts::ARCH,
        },
        migration: MigrationInfo {
            residue_items: vec![],
            came_from_v1x: false,
            ran_at_version: None,
            ran_at_ms: None,
        },
        autostart: AutostartInfo { enabled: false },
        automation: AutomationInfo {
            applicable: false,
            browsers: vec![],
        },
        native_website_failures: serde_json::json!({"available":false,"reason":"diagnostics worker failed"}),
        #[cfg(target_os = "windows")]
        watchdog: WatchdogInfo {
            task_present: false,
        },
        recent_log: vec![],
        current_blocking: CurrentBlocking {
            domains: vec![],
            blocks: vec![],
            apps: vec![],
            allowed_apps: vec![],
            allowlist_active: false,
            allowed_domains: vec![],
        },
        app_data: AppDataInfo {
            path: None,
            pretty_json: None,
            error: Some("diagnostics worker failed".to_string()),
        },
    }
}

/// Build a snapshot of what's currently being enforced. Reuses
/// `website_policy::derive_payload` for domains (single source of truth
/// for native website decisions) and reads the in-memory app-watcher set
/// for apps — no re-derivation is done here.
fn collect_current_blocking(app: &tauri::AppHandle) -> CurrentBlocking {
    let (domains, blocks) = match super::canonical_data_path(app) {
        Some(p) => website_policy::derive_payload(&p),
        None => (Vec::new(), Vec::new()),
    };
    let apps = collect_current_blocked_apps(app);
    let allowed_apps = collect_current_allowed_apps(app);
    let allowlist_active = collect_allowlist_active(app, &allowed_apps);
    let allowed_domains = allowed_domains_from_blocks(&blocks);
    CurrentBlocking {
        domains,
        blocks,
        apps,
        allowed_apps,
        allowlist_active,
        allowed_domains,
    }
}

/// Sorted union of `domains` from active allowlist-mode blocks.
fn allowed_domains_from_blocks(blocks: &[website_policy::BlockInfo]) -> Vec<String> {
    let mut set = std::collections::BTreeSet::new();
    for b in blocks {
        if website_policy::blocklist_mode_is_allowlist(&b.mode) {
            for d in &b.domains {
                set.insert(d.clone());
            }
        }
    }
    set.into_iter().collect()
}

fn collect_current_allowed_apps(app: &tauri::AppHandle) -> Vec<String> {
    use tauri::Manager;
    let state = app.state::<super::app_blocking::AppWatcherState>();
    let from_watcher = match state.0.lock() {
        Ok(s) => s
            .as_ref()
            .map(|h| h.current_allowed_apps())
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    if !from_watcher.is_empty() {
        return from_watcher;
    }
    super::canonical_data_path(app)
        .map(|p| website_policy::derive_allowed_apps(&p))
        .unwrap_or_default()
}

fn collect_allowlist_active(app: &tauri::AppHandle, disk_allowed_apps: &[String]) -> bool {
    use tauri::Manager;
    let state = app.state::<super::app_blocking::AppWatcherState>();
    if let Ok(s) = state.0.lock() {
        if let Some(h) = s.as_ref() {
            return h.is_allowlist_active();
        }
    }
    !disk_allowed_apps.is_empty()
}

/// Read the watcher's currently effective blocked-app set. Returns
/// empty when the watcher has not been started yet (no app blocks
/// have ever been activated this session).
fn collect_current_blocked_apps(app: &tauri::AppHandle) -> Vec<String> {
    use tauri::Manager;
    let state = app.state::<super::app_blocking::AppWatcherState>();
    let from_watcher = match state.0.lock() {
        Ok(s) => s.as_ref().map(|h| h.current_apps()).unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    if !from_watcher.is_empty() {
        return from_watcher;
    }
    // Watcher not seeded yet — show what the on-disk data says should
    // be active so app-only schedules aren't reported as empty.
    super::canonical_data_path(app)
        .map(|p| website_policy::derive_blocked_apps(&p))
        .unwrap_or_default()
}

fn collect_app_data_info(app: &tauri::AppHandle) -> AppDataInfo {
    let path = super::canonical_data_path(app);
    let path_str = path.as_ref().map(|p| p.display().to_string());

    let p = match path {
        Some(p) => p,
        None => {
            return AppDataInfo {
                path: path_str,
                pretty_json: None,
                error: Some("canonical app-data path unavailable".to_string()),
            };
        }
    };

    let raw = match std::fs::read_to_string(&p) {
        Ok(s) => s,
        Err(e) => {
            return AppDataInfo {
                path: path_str,
                pretty_json: None,
                error: Some(format!("failed to read {}: {e}", p.display())),
            };
        }
    };

    let pretty = serde_json::from_str::<serde_json::Value>(&raw)
        .ok()
        .map(|mut v| {
            strip_diagnostics_only_execution_fields(&mut v);
            v
        })
        .and_then(|v| serde_json::to_string_pretty(&v).ok())
        .unwrap_or(raw);

    AppDataInfo {
        path: path_str,
        pretty_json: Some(pretty),
        error: None,
    }
}

/// Keep diagnostics focused on persisted user intent. Runtime execution caches
/// used by backend enforcement stay in `current_blocking`, not the app-data view.
fn strip_diagnostics_only_execution_fields(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(map) => {
            map.remove("resolvedSegments");
            for child in map.values_mut() {
                strip_diagnostics_only_execution_fields(child);
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                strip_diagnostics_only_execution_fields(item);
            }
        }
        _ => {}
    }
}

fn collect_migration_info(app: &tauri::AppHandle) -> MigrationInfo {
    let residue_items = current_residue_items();
    let came_from_v1x = super::migration::user_came_from_v1x();

    let settings_json = super::canonical_data_path(app)
        .and_then(|p| std::fs::read_to_string(&p).ok())
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|j| j.get("settings").cloned());
    let ran_at_version = settings_json
        .as_ref()
        .and_then(|s| s.get("migrationRanAtVersion"))
        .and_then(|v| v.as_str())
        .map(String::from);
    let ran_at_ms = settings_json
        .as_ref()
        .and_then(|s| s.get("migrationRanAt"))
        .and_then(|v| v.as_u64());

    MigrationInfo {
        residue_items,
        came_from_v1x,
        ran_at_version,
        ran_at_ms,
    }
}

/// Enumerate what v1.x leftovers are on disk RIGHT NOW. Returns a
/// list of human-readable item descriptions; empty when fully clean.
/// Mirrors the checks `migration::migration_pending_sync` makes but
/// reports specifics so the diagnostics UI can show the user exactly
/// what's still around.
fn current_residue_items() -> Vec<String> {
    let mut items = vec![];

    let hosts_path = if cfg!(target_os = "windows") {
        r"C:\Windows\System32\drivers\etc\hosts"
    } else {
        "/etc/hosts"
    };
    if let Ok(raw) = std::fs::read_to_string(hosts_path) {
        let has_markers = raw.lines().any(|l| {
            let t = l.trim();
            t == "# === BEGIN REDD BLOCK (reddfocus.org) ==="
                || t == "# === END REDD BLOCK (reddfocus.org) ==="
                || t == "# ReDD Block Start"
                || t == "# ReDD Block End"
        });
        if has_markers {
            items.push(format!("v1.x markers in {hosts_path}"));
        }
    }

    #[cfg(target_os = "macos")]
    {
        for path in [
            "/Library/LaunchDaemons/com.redd.block.helper.plist",
            "/Library/LaunchDaemons/org.reddfocus.redd-block-helper.plist",
            "/Library/PrivilegedHelperTools/com.redd.block.helper",
            "/var/lib/redd-block/helper-state.json",
        ] {
            if std::path::Path::new(path).exists() {
                items.push(path.to_string());
            }
        }
    }
    #[cfg(target_os = "windows")]
    {
        let mut dirs = crate::product_identity::windows_legacy_shared_dirs();
        dirs.push(crate::product_identity::windows_primary_shared_dir());
        for dir in dirs {
            let p = dir.join("helper-state.json");
            if p.exists() {
                items.push(p.display().to_string());
            }
        }
    }

    items
}

fn autostart_enabled(app: &tauri::AppHandle) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().unwrap_or(false)
}

/// Automation snapshot for diagnostics — watcher cache only. Live TCC
/// queries and full process scans can contend with the automation tick
/// and stall the modal on "Loading…".
#[cfg(target_os = "macos")]
fn collect_automation_info_cached(app: &tauri::AppHandle) -> AutomationInfo {
    use tauri::Manager;

    use crate::commands::web_automation::WebAutomationState;
    use crate::web_automation::{self, SupportedBrowser};

    let cached = app.try_state::<WebAutomationState>().and_then(|state| {
        state
            .0
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().map(|h| h.permission_status()))
    });

    let browsers = SupportedBrowser::all()
        .into_iter()
        .map(|b| {
            let state = cached
                .as_ref()
                .and_then(|list| list.iter().find(|i| i.browser == b).map(|i| i.state))
                .unwrap_or(web_automation::PermState::Unknown);
            AutomationBrowserInfo {
                label: b.label().to_string(),
                state: match state {
                    web_automation::PermState::Granted => "granted",
                    web_automation::PermState::Denied => "denied",
                    web_automation::PermState::Unknown => "unknown",
                }
                .to_string(),
            }
        })
        .collect();

    AutomationInfo {
        applicable: true,
        browsers,
    }
}

#[cfg(not(target_os = "macos"))]
fn collect_automation_info_cached(_app: &tauri::AppHandle) -> AutomationInfo {
    AutomationInfo {
        applicable: false,
        browsers: vec![],
    }
}

/// Read up to `max_lines` lines from the back of the tauri-plugin-log
/// rolling file. Path conventions vary slightly per platform; we
/// query a few candidate dirs and take the newest .log file.
fn read_recent_log_lines(max_lines: usize) -> Vec<String> {
    let candidates = log_dir_candidates();
    let mut log_files: Vec<std::path::PathBuf> = candidates
        .iter()
        .filter_map(|d| std::fs::read_dir(d).ok())
        .flat_map(|rd| rd.flatten())
        .map(|e| e.path())
        .filter(|p| p.extension().map(|e| e == "log").unwrap_or(false))
        .collect();

    log_files.sort_by_key(|p| {
        std::fs::metadata(p)
            .and_then(|m| m.modified())
            .ok()
            .unwrap_or(std::time::UNIX_EPOCH)
    });

    let newest = match log_files.last() {
        Some(p) => p.clone(),
        None => return Vec::new(),
    };

    let raw = match std::fs::read_to_string(&newest) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let lines: Vec<&str> = raw.lines().collect();
    let start = lines.len().saturating_sub(max_lines);
    lines[start..].iter().map(|s| s.to_string()).collect()
}

fn log_dir_candidates() -> Vec<std::path::PathBuf> {
    let mut out = vec![];
    if let Some(home) = dirs::home_dir() {
        #[cfg(target_os = "macos")]
        out.push(home.join("Library/Logs/com.reddblock"));
        #[cfg(target_os = "windows")]
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            out.push(std::path::PathBuf::from(local).join(r"com.reddblock\logs"));
        }
        let _ = &home;
    }
    out
}

#[cfg(test)]
mod tests;
