//! Per-browser desktop website blocking method (Automation vs extension).
//!
//! Windows defaults to Extension, except confirmed native-messaging policy blocks.
//! Explicit choices override defaults. macOS supported browsers default to Automation,
//! and users may opt into the ReDD Focus extension path for instant redirects.
//!
//! Firefox is the exception twice over. It has no AppleScript dictionary for
//! tabs, so Automation is not a choice it can offer on macOS, and it therefore
//! defaults to the extension. Its opt-in alternative is Accessibility
//! (`crate::accessibility`), which only Firefox on macOS may select — the
//! other browsers have Apple Events, which are faster, cover every tab rather
//! than the active one, and need no system-wide input-synthesis grant.

use std::collections::HashMap;
use std::path::Path;

use serde_json::Value;
use tauri::AppHandle;

pub const METHOD_AUTOMATION: &str = "automation";
pub const METHOD_EXTENSION: &str = "extension";
pub const METHOD_ACCESSIBILITY: &str = "accessibility";

/// Browsers that let the user pick a method on macOS. Firefox joined this
/// list when Accessibility arrived; before that its method was fixed, so
/// anything reading this constant must not assume "can use Automation".
pub const MAC_BLOCKING_METHOD_KEYS: &[&str] = &["chrome", "brave", "edge", "safari", "firefox"];
pub const WINDOWS_BLOCKING_METHOD_KEYS: &[&str] = &["chrome", "brave", "edge", "firefox"];

pub fn windows_method(
    methods: &HashMap<String, String>,
    key: &str,
    policy_blocked: bool,
) -> Method {
    if !WINDOWS_BLOCKING_METHOD_KEYS.contains(&key) {
        return Method::Extension;
    }
    methods
        .get(key)
        .and_then(|s| Method::parse(s))
        // Accessibility is macOS-Firefox-only. `method_is_valid_for_key`
        // cannot be used here: it branches on the *host* OS, while this
        // resolver models Windows semantics wherever it runs (its test runs
        // on the macOS CI runner). Honouring a stored "accessibility" on
        // Windows would leave that browser with no working enforcement.
        .filter(|m| *m != Method::Accessibility)
        .unwrap_or(if policy_blocked && key != "firefox" {
            Method::Automation
        } else {
            Method::Extension
        })
}

/// Chromium browsers on macOS (native-messaging extension path).
pub const MAC_CHROMIUM_KEYS: &[&str] = &["chrome", "brave", "edge"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Automation,
    Extension,
    Accessibility,
}

impl Method {
    pub fn as_str(self) -> &'static str {
        match self {
            Method::Automation => METHOD_AUTOMATION,
            Method::Extension => METHOD_EXTENSION,
            Method::Accessibility => METHOD_ACCESSIBILITY,
        }
    }

    fn parse(s: &str) -> Option<Self> {
        match s {
            METHOD_AUTOMATION => Some(Method::Automation),
            METHOD_EXTENSION => Some(Method::Extension),
            METHOD_ACCESSIBILITY => Some(Method::Accessibility),
            _ => None,
        }
    }
}

/// Read `settings.blockingMethods` from the canonical data file.
/// Served from the shared mtime-keyed parse cache — the Automation
/// watcher calls this once per running browser on every 1 s tick.
pub fn read_map_from_path(path: &Path) -> HashMap<String, String> {
    match crate::data_cache::read(path) {
        Some(data) => read_map_from_value(&data),
        None => HashMap::new(),
    }
}

pub fn read_map(app: &AppHandle) -> HashMap<String, String> {
    crate::commands::canonical_data_path(app)
        .map(|p| read_map_from_path(&p))
        .unwrap_or_default()
}

fn read_map_from_value(data: &Value) -> HashMap<String, String> {
    data.get("settings")
        .and_then(|s| s.get("blockingMethods"))
        .and_then(|v| v.as_object())
        .map(|obj| {
            obj.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect()
        })
        .unwrap_or_default()
}

/// Effective blocking method for a browser key on this platform.
#[allow(clippy::needless_return)] // cfg dispatch: the return is load-bearing on the other platform
pub fn method_for_key_at_path(path: &Path, key: &str) -> Method {
    #[cfg(target_os = "windows")]
    {
        let policy_blocked = native_host_target(key)
            .and_then(crate::browser_policy::read)
            .is_some_and(|policy| policy.blocked);
        return windows_method(&read_map_from_path(path), key, policy_blocked);
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (path, key);
        return Method::Extension;
    }
    #[cfg(target_os = "macos")]
    {
        let stored = |default: Method| {
            read_map_from_path(path)
                .get(key)
                .and_then(|s| Method::parse(s))
                // A method the browser cannot actually use — Automation for
                // Firefox, Accessibility for anything else — falls back to
                // the default rather than silently disabling enforcement.
                .filter(|m| method_is_valid_for_key(key, *m))
                .unwrap_or(default)
        };
        match key {
            // Existing installs carry no `firefox` entry at all, and they
            // must keep working exactly as before: the extension stays the
            // default, and Accessibility is only ever chosen explicitly.
            "firefox" => stored(Method::Extension),
            k if MAC_BLOCKING_METHOD_KEYS.contains(&k) => stored(Method::Automation),
            _ => Method::Automation,
        }
    }
}

pub fn method_for_key(app: &AppHandle, key: &str) -> Method {
    crate::commands::canonical_data_path(app)
        .map(|p| method_for_key_at_path(&p, key))
        .unwrap_or(Method::Automation)
}

pub fn uses_automation_at_path(path: &Path, key: &str) -> bool {
    method_for_key_at_path(path, key) == Method::Automation
}

pub fn uses_automation(app: &AppHandle, key: &str) -> bool {
    method_for_key(app, key) == Method::Automation
}

/// True when any browser blocks through Automation, i.e. the Apple Events
/// watcher has work to do. Without a data path this answers true:
/// Automation is the default, and parking the watcher on a guess would leave
/// Safari and Chromium unblocked.
pub fn any_uses_automation(app: &AppHandle) -> bool {
    crate::commands::canonical_data_path(app)
        .map(|p| any_uses_automation_at_path(&p))
        .unwrap_or(true)
}

pub fn any_uses_automation_at_path(path: &Path) -> bool {
    MAC_BLOCKING_METHOD_KEYS
        .iter()
        .any(|key| uses_automation_at_path(path, key))
}

pub fn uses_accessibility_at_path(path: &Path, key: &str) -> bool {
    method_for_key_at_path(path, key) == Method::Accessibility
}

pub fn uses_accessibility(app: &AppHandle, key: &str) -> bool {
    method_for_key(app, key) == Method::Accessibility
}

/// Which methods a browser can actually enforce with.
///
/// Firefox has no tab scripting, so Automation is meaningless for it; the
/// others have Apple Events, so Accessibility would be a strictly worse
/// choice — slower, active tab only, and it would ask the user for a
/// system-wide input-synthesis grant they do not otherwise need.
pub fn method_is_valid_for_key(key: &str, method: Method) -> bool {
    if cfg!(target_os = "windows") {
        return WINDOWS_BLOCKING_METHOD_KEYS.contains(&key) && method != Method::Accessibility;
    }
    match (key, method) {
        ("firefox", Method::Automation) => false,
        ("firefox", _) => true,
        (_, Method::Accessibility) => false,
        _ => true,
    }
}

pub fn validate_method_for_key(key: &str, method: Method) -> Result<(), String> {
    if method_is_valid_for_key(key, method) {
        Ok(())
    } else {
        Err(format!(
            "{} cannot use the {} blocking method",
            key,
            method.as_str()
        ))
    }
}

pub fn is_mac_blocking_method_key(key: &str) -> bool {
    MAC_BLOCKING_METHOD_KEYS.contains(&key)
}

pub fn validate_blocking_method_key(key: &str) -> Result<(), String> {
    let supported = if cfg!(target_os = "windows") {
        WINDOWS_BLOCKING_METHOD_KEYS.contains(&key)
    } else {
        is_mac_blocking_method_key(key)
    };
    if supported {
        Ok(())
    } else {
        Err(format!("unsupported browser for blocking method: {key}"))
    }
}

pub fn validate_method(method: &str) -> Result<Method, String> {
    Method::parse(method).ok_or_else(|| format!("invalid blocking method: {method}"))
}

#[cfg(not(target_os = "ios"))]
pub fn native_host_target(key: &str) -> Option<crate::native_host_install::BrowserTarget> {
    use crate::native_host_install::BrowserTarget;
    match key {
        "chrome" => Some(BrowserTarget::Chrome),
        "brave" => Some(BrowserTarget::Brave),
        "edge" => Some(BrowserTarget::Edge),
        "firefox" => Some(BrowserTarget::Firefox),
        _ => None,
    }
}

#[cfg(not(target_os = "ios"))]
pub fn extension_hint_target(key: &str) -> Option<crate::extension_install::BrowserTarget> {
    use crate::extension_install::BrowserTarget;
    match key {
        "chrome" => Some(BrowserTarget::Chrome),
        "brave" => Some(BrowserTarget::Brave),
        "edge" => Some(BrowserTarget::Edge),
        _ => None,
    }
}

#[cfg(all(test, target_os = "macos"))]
mod watcher_tests {
    use super::*;

    fn data_file(name: &str, body: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "redd-blocking-method-{name}-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("redd-block-data.json");
        std::fs::write(&path, body).unwrap();
        path
    }

    #[test]
    fn defaults_want_the_automation_watcher() {
        let path = data_file("defaults", "{}");
        assert!(any_uses_automation_at_path(&path));
    }

    #[test]
    fn extension_everywhere_lets_the_watcher_park() {
        let path = data_file(
            "all-ext",
            r#"{"settings":{"blockingMethods":{"safari":"extension","chrome":"extension","edge":"extension","brave":"extension"}}}"#,
        );
        assert!(!any_uses_automation_at_path(&path));
    }

    #[test]
    fn one_automation_browser_keeps_the_watcher_running() {
        let path = data_file(
            "one-auto",
            r#"{"settings":{"blockingMethods":{"safari":"extension","chrome":"extension","edge":"extension"}}}"#,
        );
        assert!(any_uses_automation_at_path(&path));
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// Same shape as the other modules' temp helpers: a unique path under the
    /// system temp dir, no extra dependency.
    fn data_file(name: &str, methods: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!("redd-block-methods-{name}-{unique}.json"));
        std::fs::write(
            &path,
            format!(r#"{{"settings":{{"blockingMethods":{methods}}}}}"#),
        )
        .unwrap();
        path
    }

    #[test]
    fn firefox_defaults_to_extension_so_existing_installs_are_untouched() {
        let path = data_file("ff-default", "{}");
        assert_eq!(method_for_key_at_path(&path, "firefox"), Method::Extension);
    }

    #[test]
    fn firefox_can_opt_into_accessibility() {
        let path = data_file("ff-ax", r#"{"firefox":"accessibility"}"#);
        assert_eq!(
            method_for_key_at_path(&path, "firefox"),
            Method::Accessibility
        );
        assert!(uses_accessibility_at_path(&path, "firefox"));
        assert!(!uses_automation_at_path(&path, "firefox"));
    }

    #[test]
    fn firefox_never_resolves_to_automation() {
        // Firefox has no tab scripting, so a stored "automation" can only
        // come from a hand-edited file. Honouring it would put the Automation
        // watcher on a browser that cannot answer, and Firefox would stop
        // being blocked at all.
        let path = data_file("ff-auto", r#"{"firefox":"automation"}"#);
        assert_eq!(method_for_key_at_path(&path, "firefox"), Method::Extension);
        assert!(!uses_automation_at_path(&path, "firefox"));
    }

    #[test]
    fn other_browsers_cannot_opt_into_accessibility() {
        let path = data_file(
            "others-ax",
            r#"{"chrome":"accessibility","safari":"accessibility"}"#,
        );
        assert_eq!(method_for_key_at_path(&path, "chrome"), Method::Automation);
        assert_eq!(method_for_key_at_path(&path, "safari"), Method::Automation);
        assert!(!method_is_valid_for_key("chrome", Method::Accessibility));
        assert!(validate_method_for_key("edge", Method::Accessibility).is_err());
        assert!(validate_method_for_key("firefox", Method::Accessibility).is_ok());
        assert!(validate_method_for_key("firefox", Method::Automation).is_err());
    }

    #[test]
    fn chromium_and_safari_defaults_are_unchanged() {
        let path = data_file("defaults", "{}");
        for key in ["chrome", "brave", "edge", "safari"] {
            assert_eq!(method_for_key_at_path(&path, key), Method::Automation);
        }
    }
}

#[cfg(test)]
mod windows_tests {
    use super::*;

    #[test]
    fn windows_extension_default_policy_fallback_and_explicit_overrides() {
        let mut methods = HashMap::new();
        for key in WINDOWS_BLOCKING_METHOD_KEYS {
            assert_eq!(windows_method(&methods, key, false), Method::Extension);
            let fallback = if *key == "firefox" {
                Method::Extension
            } else {
                Method::Automation
            };
            assert_eq!(windows_method(&methods, key, true), fallback);
            methods.insert(key.to_string(), METHOD_EXTENSION.to_string());
            assert_eq!(windows_method(&methods, key, true), Method::Extension);
            methods.insert(key.to_string(), "invalid".to_string());
            assert_eq!(windows_method(&methods, key, false), Method::Extension);
            methods.insert(key.to_string(), METHOD_AUTOMATION.to_string());
            assert_eq!(windows_method(&methods, key, false), Method::Automation);
            // Accessibility exists only for Firefox on macOS. Stored here it
            // must fall back to the Windows default, not leave the browser
            // on a method this platform cannot enforce with.
            methods.insert(key.to_string(), METHOD_ACCESSIBILITY.to_string());
            assert_eq!(windows_method(&methods, key, false), Method::Extension);
            methods.insert(key.to_string(), METHOD_AUTOMATION.to_string());
        }
        assert_eq!(windows_method(&methods, "safari", true), Method::Extension);
    }
}
