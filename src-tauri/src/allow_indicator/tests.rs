use super::*;
use crate::block_page::url_is_blocked;
use serde_json::json;

fn block(id: &str, mode: &str, domains: &[&str], apps: &[&str]) -> BlockInfo {
    BlockInfo {
        blocklist_id: id.to_string(),
        name: Some(id.to_string()),
        emoji: None,
        color: None,
        mode: mode.to_string(),
        domains: domains.iter().map(|d| d.to_string()).collect(),
        apps: apps.iter().map(|a| a.to_string()).collect(),
        source: "activeBlock",
        ends_at: Some(1_000),
        started_at: Some(0),
    }
}

fn names(state: &IndicatorState) -> Vec<&str> {
    state.spaces.iter().map(|s| s.name.as_str()).collect()
}

#[test]
fn inactive_without_an_allow_space() {
    assert!(!state_from_blocks(&[]).active);
    let blocks = [block("social", "blocklist", &["reddit.com"], &["Discord"])];
    assert_eq!(state_from_blocks(&blocks), IndicatorState::default());
}

#[test]
fn an_allow_space_that_lists_nothing_is_not_a_session() {
    assert!(!state_from_blocks(&[block("empty", "allowlist", &[], &[])]).active);
}

#[test]
fn concurrent_allow_spaces_union() {
    let mut later = block("essay", "allowlist", &["overleaf.com"], &["Word"]);
    later.started_at = Some(50);
    later.ends_at = Some(2_000);
    let blocks = [
        later,
        block(
            "research",
            "allowlist",
            &["wikipedia.org", "overleaf.com"],
            &["Zotero"],
        ),
    ];
    let state = state_from_blocks(&blocks);
    assert!(state.active);
    assert_eq!(state.websites, ["overleaf.com", "wikipedia.org"]);
    assert_eq!(state.apps, ["Word", "Zotero"]);
    assert!(!state.all_websites && !state.all_apps && !state.blocklist_also_active);
    // Earliest-started first; the session lasts until the last one ends.
    assert_eq!(names(&state), ["research", "essay"]);
    assert_eq!(state.ends_at, Some(2_000));
}

#[test]
fn blocklist_wins_on_overlap() {
    let blocks = [
        block(
            "work",
            "allowlist",
            &["docs.google.com", "wikipedia.org", "news.com"],
            &["Slack", "Word"],
        ),
        block(
            "no-google",
            "blocklist",
            &["google.com", "news.com"],
            &["slack"],
        ),
    ];
    let state = state_from_blocks(&blocks);
    // docs.google.com sits under blocked google.com; news.com is blocked outright.
    assert_eq!(state.websites, ["wikipedia.org"]);
    assert_eq!(state.apps, ["Word"]);
    assert!(state.blocklist_also_active);
    assert_eq!(names(&state), ["work"]);
}

/// The list must never promise a site that enforcement blocks, nor omit one
/// the user listed that enforcement lets through.
#[test]
fn listed_websites_agree_with_enforcement() {
    let blocks = [
        block(
            "work",
            "allowlist",
            &["docs.google.com", "wikipedia.org", "example.org"],
            &[],
        ),
        block("other", "allowlist", &["overleaf.com"], &[]),
        block(
            "no-google",
            "blocklist",
            &["google.com", "example.org"],
            &[],
        ),
    ];
    let state = state_from_blocks(&blocks);
    let listed_by_user = [
        "docs.google.com",
        "wikipedia.org",
        "example.org",
        "overleaf.com",
    ];
    for domain in listed_by_user {
        let enforced_open = !url_is_blocked(&format!("https://{domain}/"), &blocks);
        assert_eq!(
            state.websites.iter().any(|d| d == domain),
            enforced_open,
            "{domain}: indicator and enforcement disagree"
        );
    }
}

#[test]
fn apps_only_allow_space_leaves_all_websites_open() {
    let blocks = [block("writing", "allowlist", &[], &["Word"])];
    let state = state_from_blocks(&blocks);
    assert!(state.active && state.all_websites && !state.all_apps);
    assert!(!url_is_blocked("https://anything.example/", &blocks));
}

#[test]
fn websites_only_allow_space_leaves_all_apps_open() {
    let state = state_from_blocks(&[block("reading", "allowlist", &["wikipedia.org"], &[])]);
    assert!(state.active && state.all_apps && !state.all_websites);
}

#[test]
fn open_ended_space_has_no_end_time() {
    let mut open = block("always", "allowlist", &["wikipedia.org"], &[]);
    open.ends_at = None;
    let blocks = [open, block("timed", "allowlist", &["overleaf.com"], &[])];
    assert_eq!(state_from_blocks(&blocks).ends_at, None);
}

#[test]
fn a_space_running_twice_is_named_once() {
    let mut scheduled = block("work", "allowlist", &["wikipedia.org"], &[]);
    scheduled.source = "schedule";
    let blocks = [
        scheduled,
        block("work", "allowlist", &["wikipedia.org"], &[]),
    ];
    assert_eq!(names(&state_from_blocks(&blocks)), ["work"]);
}

#[test]
fn settings_default_to_shown_but_wait_for_the_eula() {
    let none = settings_from_data(&json!({}));
    assert!(none.enabled && !none.eula_accepted);

    let accepted = settings_from_data(&json!({ "settings": {
        "eulaAcceptedRevision": 3, "language": "da", "themeMode": "dark",
    }}));
    assert!(accepted.enabled && accepted.eula_accepted);
    assert_eq!(accepted.language.as_deref(), Some("da"));
    assert_eq!(accepted.theme_mode.as_deref(), Some("dark"));

    let off = settings_from_data(&json!({ "settings": { "showAllowIndicator": false } }));
    assert!(!off.enabled);
}

#[test]
fn shown_only_when_active_enabled_accepted_and_not_dismissed() {
    let active = state_from_blocks(&[block("work", "allowlist", &["wikipedia.org"], &[])]);
    let on = IndicatorSettings {
        eula_accepted: true,
        enabled: true,
        ..Default::default()
    };
    assert!(decide(active.clone(), on.clone(), false).0);
    assert!(!decide(active.clone(), on.clone(), true).0, "dismissed");
    assert!(
        !decide(IndicatorState::default(), on.clone(), false).0,
        "idle"
    );
    let disabled = IndicatorSettings {
        enabled: false,
        ..on.clone()
    };
    assert!(!decide(active.clone(), disabled, false).0, "setting off");
    let no_eula = IndicatorSettings {
        eula_accepted: false,
        ..on
    };
    assert!(!decide(active, no_eula, false).0, "before the EULA");
}

#[test]
fn saved_corner_is_used_only_while_it_is_on_a_screen() {
    let one_screen = [(0.0, 0.0, 1440.0, 860.0)];
    assert_eq!(resolve_anchor(None, &one_screen), (1424.0, 844.0));
    assert_eq!(
        resolve_anchor(Some((700.0, 400.0)), &one_screen),
        (700.0, 400.0)
    );
    // Saved on a second monitor that is no longer connected.
    assert_eq!(
        resolve_anchor(Some((2600.0, 500.0)), &one_screen),
        (1424.0, 844.0)
    );
    let two_screens = [(0.0, 0.0, 1440.0, 860.0), (1440.0, 0.0, 1920.0, 1080.0)];
    assert_eq!(
        resolve_anchor(Some((2600.0, 500.0)), &two_screens),
        (2600.0, 500.0)
    );
}

#[test]
fn window_grows_up_and_left_from_its_corner() {
    assert_eq!(
        top_left_for((1424.0, 844.0), (260.0, 36.0)),
        (1164.0, 808.0)
    );
    assert_eq!(
        top_left_for((1424.0, 844.0), (280.0, 300.0)),
        (1144.0, 544.0)
    );
}
