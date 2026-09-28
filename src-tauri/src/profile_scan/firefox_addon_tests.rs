use super::*;
use std::fs;

fn test_profile_dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "redd_block_firefox_scan_test_{}_{name}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("mkdir");
    dir
}

fn addon_json(extra: serde_json::Map<String, Value>) -> Value {
    let mut m = serde_json::Map::new();
    m.insert("id".into(), Value::String(FIREFOX_ID.into()));
    m.insert("type".into(), Value::String("extension".into()));
    for (k, v) in extra {
        m.insert(k, v);
    }
    Value::Object(m)
}

fn setup_profile(
    name: &str,
    is_default: bool,
    installed: bool,
    enabled: bool,
    private: bool,
) -> ProfileStatus {
    ProfileStatus {
        name: name.to_string(),
        is_default,
        installed,
        enabled: Some(enabled),
        private_browsing: Some(private),
        website_access_all: None,
        note: None,
    }
}

#[test]
fn firefox_setup_selects_the_configured_install_default_in_either_order() {
    let old = setup_profile("old", true, false, false, false);
    let current = setup_profile("current", true, true, true, true);
    for profiles in [
        vec![old.clone(), current.clone()],
        vec![current.clone(), old.clone()],
    ] {
        let browser = BrowserStatus {
            profiles,
            ..Default::default()
        };
        assert_eq!(
            preferred_non_safari_profile(&browser).map(|p| p.name.as_str()),
            Some("current")
        );
        assert!(default_profile_compliant(&browser));
    }
}

#[test]
fn firefox_selection_ranks_installed_enabled_and_private_in_order() {
    let missing = setup_profile("missing", true, false, false, false);
    let disabled = setup_profile("disabled", true, true, false, false);
    let no_private = setup_profile("no-private", true, true, true, false);
    let ready = setup_profile("ready", true, true, true, true);
    for (profiles, expected) in [
        (vec![missing, disabled.clone()], "disabled"),
        (vec![disabled, no_private.clone()], "no-private"),
        (vec![no_private, ready], "ready"),
    ] {
        let browser = BrowserStatus {
            profiles,
            ..Default::default()
        };
        assert_eq!(
            preferred_non_safari_profile(&browser).map(|p| p.name.as_str()),
            Some(expected)
        );
    }
}

#[test]
fn firefox_selection_preserves_defaults_ties_and_first_profile_fallback() {
    let broken = setup_profile("first", true, false, false, false);
    let other = setup_profile("other", false, true, true, true);
    let browser = BrowserStatus {
        profiles: vec![broken.clone(), other.clone()],
        ..Default::default()
    };
    assert_eq!(
        preferred_non_safari_profile(&browser).map(|p| p.name.as_str()),
        Some("first")
    );
    assert!(!default_profile_compliant(&browser));

    let browser = BrowserStatus {
        profiles: vec![other.clone(), setup_profile("tie", false, true, true, true)],
        ..Default::default()
    };
    assert_eq!(
        preferred_non_safari_profile(&browser).map(|p| p.name.as_str()),
        Some("other")
    );

    let browser = BrowserStatus {
        profiles: vec![
            setup_profile("first", true, true, true, true),
            setup_profile("tie", true, true, true, true),
        ],
        ..Default::default()
    };
    assert_eq!(
        preferred_non_safari_profile(&browser).map(|p| p.name.as_str()),
        Some("first")
    );
    assert!(preferred_non_safari_profile(&BrowserStatus::default()).is_none());
}

#[test]
fn firefox_counts_disabled_addon_as_installed() {
    let dir = test_profile_dir("disabled");
    let addon = addon_json(serde_json::Map::from_iter([
        ("visible".into(), Value::Bool(true)),
        ("active".into(), Value::Bool(false)),
        ("userDisabled".into(), Value::Bool(true)),
    ]));
    assert!(firefox_addon_counts_as_installed(&addon, &dir));
    assert!(!firefox_addon_enabled(&addon));
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn firefox_ignores_pending_uninstall() {
    let dir = test_profile_dir("pending_uninstall");
    let addon = addon_json(serde_json::Map::from_iter([
        ("visible".into(), Value::Bool(true)),
        ("pendingUninstall".into(), Value::Bool(true)),
        ("active".into(), Value::Bool(false)),
        ("userDisabled".into(), Value::Bool(true)),
    ]));
    assert!(!firefox_addon_counts_as_installed(&addon, &dir));
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn firefox_ignores_invisible_catalog_row() {
    let dir = test_profile_dir("invisible");
    let addon = addon_json(serde_json::Map::from_iter([
        ("visible".into(), Value::Bool(false)),
        ("active".into(), Value::Bool(false)),
        ("userDisabled".into(), Value::Bool(true)),
    ]));
    assert!(!firefox_addon_counts_as_installed(&addon, &dir));
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn firefox_ignores_stale_path() {
    let dir = test_profile_dir("stale_path");
    let rel = "extensions/stale.xpi";
    let addon = addon_json(serde_json::Map::from_iter([
        ("visible".into(), Value::Bool(true)),
        ("path".into(), Value::String(rel.into())),
        ("active".into(), Value::Bool(false)),
        ("userDisabled".into(), Value::Bool(true)),
    ]));
    assert!(!firefox_addon_counts_as_installed(&addon, &dir));
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn firefox_accepts_path_on_disk() {
    let dir = test_profile_dir("on_disk");
    let rel = "extensions/redd.xpi";
    fs::create_dir_all(dir.join("extensions")).expect("mkdir");
    fs::write(dir.join(rel), b"xpi").expect("write");
    let addon = addon_json(serde_json::Map::from_iter([
        ("visible".into(), Value::Bool(true)),
        ("path".into(), Value::String(rel.into())),
        ("active".into(), Value::Bool(true)),
        ("userDisabled".into(), Value::Bool(false)),
    ]));
    assert!(firefox_addon_counts_as_installed(&addon, &dir));
    assert!(firefox_addon_enabled(&addon));
    let _ = fs::remove_dir_all(&dir);
}
