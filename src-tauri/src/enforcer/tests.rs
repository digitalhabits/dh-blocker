use super::*;
use crate::profile_scan::{BrowserStatus, ProfileStatus};

// The enforcer force-quits the user's browser. The two ways that goes
// wrong are quitting when it shouldn't (a browser judged non-compliant
// on unmeasurable state, or enforcement running without opt-in) and
// failing to quit when it should. Both verdicts come from the pure
// functions below.
//
// Not covered at this layer: `tick`, which needs a live `AppHandle`,
// and the process quit/kill primitives.

fn profile(name: &str, is_default: bool) -> ProfileStatus {
    ProfileStatus {
        name: name.to_string(),
        is_default,
        installed: true,
        enabled: Some(true),
        private_browsing: Some(true),
        website_access_all: None,
        note: None,
    }
}

fn status(profiles: Vec<ProfileStatus>) -> BrowserStatus {
    BrowserStatus {
        present: true,
        installed: true,
        profiles,
        ..Default::default()
    }
}

// ---- compliance verdict -----------------------------------------

#[test]
fn configured_install_default_is_not_hidden_by_a_stale_default() {
    let mut stale = profile("old-install", true);
    stale.installed = false;
    stale.enabled = Some(false);
    stale.private_browsing = Some(false);
    let current = profile("current-install", true);
    for profiles in [
        vec![stale.clone(), current.clone()],
        vec![current.clone(), stale.clone()],
    ] {
        assert!(default_profile_passes(&status(profiles)));
    }
}

#[test]
fn diagnosis_uses_the_best_configured_install_default() {
    let mut stale = profile("old-install", true);
    stale.installed = false;
    let mut current = profile("current-install", true);
    current.private_browsing = Some(false);
    assert_eq!(
        diagnose_issue(&status(vec![stale, current])),
        ExtensionIssue::Private
    );
}

#[test]
fn configured_non_default_does_not_hide_a_broken_default() {
    let mut broken = profile("default", true);
    broken.installed = false;
    let browser = status(vec![broken, profile("secondary", false)]);
    assert!(!default_profile_passes(&browser));
    assert_eq!(diagnose_issue(&browser), ExtensionIssue::Missing);
}

#[test]
fn a_healthy_default_profile_passes() {
    assert!(default_profile_passes(&status(vec![profile(
        "default", true
    )])));
}

#[test]
fn the_default_profile_decides_not_the_others() {
    // A second, broken profile the user never browses in must not
    // trigger a force-close.
    let mut broken = profile("other", false);
    broken.installed = false;
    assert!(default_profile_passes(&status(vec![
        profile("default", true),
        broken
    ])));
}

#[test]
fn the_first_profile_stands_in_when_none_is_marked_default() {
    assert!(default_profile_passes(&status(vec![profile(
        "only", false
    )])));

    let mut broken = profile("only", false);
    broken.enabled = Some(false);
    assert!(!default_profile_passes(&status(vec![broken])));
}

#[test]
fn a_missing_disabled_or_private_blocked_extension_fails() {
    for mutate in [
        (|p: &mut ProfileStatus| p.installed = false) as fn(&mut ProfileStatus),
        |p: &mut ProfileStatus| p.enabled = Some(false),
        |p: &mut ProfileStatus| p.enabled = None,
        |p: &mut ProfileStatus| p.private_browsing = Some(false),
        |p: &mut ProfileStatus| p.website_access_all = Some(false),
    ] {
        let mut p = profile("default", true);
        mutate(&mut p);
        assert!(!default_profile_passes(&status(vec![p])));
    }
}

#[test]
fn unmeasurable_state_is_treated_as_compliant() {
    // The bundled Safari extension legitimately reports None for
    // private browsing without Full Disk Access. Force-closing on
    // state we cannot read is hostile, so None must pass.
    let mut p = profile("default", true);
    p.private_browsing = None;
    assert!(default_profile_passes(&status(vec![p])));

    // Same for website access, which most browsers never report.
    let mut p = profile("default", true);
    p.website_access_all = None;
    assert!(default_profile_passes(&status(vec![p])));
}

#[test]
fn a_browser_with_no_profiles_fails() {
    assert!(!default_profile_passes(&status(vec![])));
}

#[test]
fn website_access_capable_browsers_are_judged_on_every_profile() {
    // Safari reports website_access_all, and there a single profile
    // with the extension restricted is enough to be non-compliant —
    // unlike the default-profile-only rule for Chromium/Firefox.
    let mut ok = profile("a", true);
    ok.website_access_all = Some(true);
    let mut restricted = profile("b", false);
    restricted.website_access_all = Some(false);

    assert!(default_profile_passes(&status(vec![ok.clone()])));
    assert!(!default_profile_passes(&status(vec![ok, restricted])));
}

// ---- issue diagnosis ---------------------------------------------

#[test]
fn the_reported_issue_matches_what_is_actually_wrong() {
    // The issue string drives the "Fix now" deep-link, so a wrong
    // diagnosis sends the user to the wrong settings page.
    let mut missing = profile("default", true);
    missing.installed = false;
    assert_eq!(
        diagnose_issue(&status(vec![missing])),
        ExtensionIssue::Missing
    );

    let mut disabled = profile("default", true);
    disabled.enabled = Some(false);
    assert_eq!(
        diagnose_issue(&status(vec![disabled])),
        ExtensionIssue::Disabled
    );

    let mut private = profile("default", true);
    private.private_browsing = Some(false);
    assert_eq!(
        diagnose_issue(&status(vec![private])),
        ExtensionIssue::Private
    );
}

#[test]
fn restricted_website_access_is_diagnosed_separately() {
    let mut ok = profile("a", true);
    ok.website_access_all = Some(true);
    let mut restricted = profile("b", false);
    restricted.website_access_all = Some(false);
    assert_eq!(
        diagnose_issue(&status(vec![ok, restricted])),
        ExtensionIssue::WebsiteAccess
    );
}

#[test]
fn an_unreadable_browser_is_an_access_problem_not_a_missing_extension() {
    // No profiles plus a scan error means we could not read the
    // extension state — telling the user to reinstall would be wrong.
    let unreadable = BrowserStatus {
        present: true,
        installed: true,
        profiles: vec![],
        error: Some("permission denied".to_string()),
        ..Default::default()
    };
    assert_eq!(diagnose_issue(&unreadable), ExtensionIssue::Access);

    // No profiles and no error: the extension simply is not there.
    assert_eq!(diagnose_issue(&status(vec![])), ExtensionIssue::Missing);
}

#[test]
fn every_failing_profile_produces_some_issue() {
    // Whatever is wrong, the diagnosis must never come back clean —
    // that would start a grace timer with nothing to show the user.
    for mutate in [
        (|p: &mut ProfileStatus| p.installed = false) as fn(&mut ProfileStatus),
        |p: &mut ProfileStatus| p.enabled = Some(false),
        |p: &mut ProfileStatus| p.private_browsing = Some(false),
    ] {
        let mut p = profile("default", true);
        mutate(&mut p);
        let s = status(vec![p]);
        assert!(!default_profile_passes(&s));
        assert_ne!(diagnose_issue(&s), ExtensionIssue::Unknown);
    }
}

// ---- opt-in gate --------------------------------------------------

#[test]
fn enforcement_is_off_unless_explicitly_enabled() {
    // Default-off is the whole contract of this feature: anything
    // ambiguous must not authorise force-closing a browser.
    for data in [
        serde_json::json!({}),
        serde_json::json!({ "settings": {} }),
        serde_json::json!({ "settings": { "enforcementEnabled": false } }),
        serde_json::json!({ "settings": { "enforcementEnabled": "true" } }),
        serde_json::json!({ "settings": { "enforcementEnabled": 1 } }),
        serde_json::json!({ "settings": null }),
    ] {
        assert!(!enforcement_enabled_from(&data), "{data} must not opt in");
    }
    assert!(enforcement_enabled_from(
        &serde_json::json!({ "settings": { "enforcementEnabled": true } })
    ));
}

// ---- grace window -------------------------------------------------

#[test]
fn the_grace_window_is_clamped_to_a_usable_range() {
    assert_eq!(clamp_grace_secs(0), Duration::from_secs(GRACE_MIN_SECS));
    assert_eq!(clamp_grace_secs(1), Duration::from_secs(GRACE_MIN_SECS));
    assert_eq!(
        clamp_grace_secs(u64::MAX),
        Duration::from_secs(GRACE_MAX_SECS)
    );
    assert_eq!(clamp_grace_secs(60), Duration::from_secs(60));
    const _: () = {
        assert!(GRACE_MIN_SECS > 0 && GRACE_MIN_SECS < GRACE_MAX_SECS);
    };
}

#[test]
fn an_unset_grace_falls_back_to_the_default() {
    for data in [
        serde_json::json!({}),
        serde_json::json!({ "settings": {} }),
        serde_json::json!({ "settings": { "extensionGraceSeconds": "90" } }),
        serde_json::json!({ "settings": { "extensionGraceSeconds": -5 } }),
    ] {
        assert_eq!(grace_secs_from(&data), GRACE_DEFAULT_SECS, "{data}");
    }
    assert_eq!(
        grace_secs_from(&serde_json::json!({ "settings": { "extensionGraceSeconds": 90 } })),
        90
    );
}

// ---- browser identity ---------------------------------------------

#[test]
fn each_browser_maps_to_its_own_scan_slot() {
    // A mis-wired arm here would judge one browser by another's scan
    // and quit the wrong window, with nothing in the logs to show it.
    let tagged = |tag: &str| BrowserStatus {
        error: Some(tag.to_string()),
        ..Default::default()
    };
    let scan = profile_scan::ScanResult {
        firefox: tagged("firefox"),
        chrome: tagged("chrome"),
        brave: tagged("brave"),
        edge: tagged("edge"),
        safari: tagged("safari"),
    };
    for &key in BrowserKey::enforced() {
        assert_eq!(
            key.for_status(&scan).error.as_deref(),
            Some(key.setting_key())
        );
    }
}

#[test]
fn every_enforced_browser_is_identifiable_and_killable() {
    // An empty process-name list means the browser can never be
    // detected as running, so it is silently never enforced.
    for &key in BrowserKey::enforced() {
        assert!(!key.label().is_empty());
        assert!(!key.setting_key().is_empty());
        #[cfg(target_os = "macos")]
        assert!(
            !key.process_names().is_empty(),
            "{} has no process names",
            key.label()
        );
        #[cfg(target_os = "windows")]
        if key != BrowserKey::Safari {
            assert!(
                !key.process_names().is_empty(),
                "{} has no process names",
                key.label()
            );
        }
    }
}

#[test]
fn the_enforced_set_has_no_duplicates() {
    let mut seen = std::collections::HashSet::new();
    for &key in BrowserKey::enforced() {
        assert!(seen.insert(key), "{} listed twice", key.label());
    }
    assert_eq!(seen.len(), 5);
}
