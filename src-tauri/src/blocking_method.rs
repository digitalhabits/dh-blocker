//! Per-browser website blocking method on macOS (Automation vs extension).
//!
//! Chrome, Brave, Edge, and Safari default to Automation; power users may
//! opt into the ReDD Focus extension path for instant redirects.
//!
//! Firefox is the exception twice over. It has no AppleScript dictionary for
//! tabs, so Automation is not a choice it can offer, and it therefore
//! defaults to the extension. Its opt-in alternative is Accessibility
//! (`crate::accessibility`), which only Firefox may select — the other
//! browsers have Apple Events, which are faster, cover every tab rather than
//! the active one, and need no system-wide input-synthesis grant.

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
    #[cfg(not(target_os = "macos"))]
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

pub fn validate_mac_blocking_method_key(key: &str) -> Result<(), String> {
    if is_mac_blocking_method_key(key) {
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
