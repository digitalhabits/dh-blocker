use super::*;
use serde::Deserialize;
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Deserialize)]
struct HostPayloadCompat {
    blocklist: Vec<String>,
    #[serde(default)]
    blocks: Vec<CompatBlockInfo>,
}

#[derive(Debug, Deserialize)]
struct CompatBlockInfo {
    #[serde(rename = "blocklistId")]
    blocklist_id: String,
    #[serde(default = "default_blocklist_mode")]
    mode: String,
    #[serde(default)]
    domains: Vec<String>,
}

fn temp_json_path(name: &str) -> PathBuf {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("redd-block-{name}-{unique}.json"))
}

fn write_temp_json(name: &str, data: &Value) -> PathBuf {
    let path = temp_json_path(name);
    fs::write(&path, serde_json::to_vec(data).unwrap()).unwrap();
    path
}

#[test]
fn match_schedule_now_prefers_resolved_one_shot_windows() {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let schedule = json!({
        "isPaused": false,
        "resolvedSegments": [{
            "startHour": 0,
            "startMinute": 0,
            "endHour": 0,
            "endMinute": 0,
            "days": [],
            "activeFromTimestampMs": now.saturating_sub(60_000),
            "activeUntilTimestampMs": now + 60_000
        }],
        "segments": [{
            "startHour": 0,
            "startMinute": 0,
            "endHour": 0,
            "endMinute": 0,
            "days": []
        }]
    });

    let matched = match_schedule_now(&schedule, now).expect("resolved one-shot should match");
    assert_eq!(matched.started_at, Some(now.saturating_sub(60_000)));
    assert_eq!(matched.ends_at, Some(now + 60_000));
}

#[test]
fn derive_blocked_apps_uses_resolved_one_shot_windows() {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let path = temp_json_path("resolved-one-shot");
    let data = json!({
        "blocklists": [{
            "id": "bl-1",
            "name": "Test",
            "websites": [],
            "apps": ["Notes"]
        }],
        "activeBlocks": [],
        "schedules": [{
            "id": "sch-1",
            "blocklistId": "bl-1",
            "repeatType": "no",
            "createdAt": now.saturating_sub(3_600_000),
            "segments": [{
                "startHour": 0,
                "startMinute": 0,
                "endHour": 0,
                "endMinute": 0,
                "days": [0]
            }],
            "resolvedSegments": [{
                "startHour": 0,
                "startMinute": 0,
                "endHour": 0,
                "endMinute": 0,
                "days": [],
                "activeFromTimestampMs": now.saturating_sub(60_000),
                "activeUntilTimestampMs": now + 60_000
            }]
        }],
        "settings": {}
    });

    fs::write(&path, serde_json::to_vec(&data).unwrap()).unwrap();
    let apps = derive_blocked_apps(&path);
    let _ = fs::remove_file(&path);

    assert_eq!(apps, vec!["Notes".to_string()]);
}

#[test]
fn derive_allowed_apps_uses_resolved_one_shot_windows() {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let path = temp_json_path("resolved-one-shot-allowlist-apps");
    let data = json!({
        "blocklists": [{
            "id": "bl-allow",
            "name": "Allowlist",
            "mode": "allowlist",
            "websites": [],
            "apps": ["Mail"]
        }],
        "activeBlocks": [],
        "schedules": [{
            "id": "sch-allow",
            "blocklistId": "bl-allow",
            "repeatType": "no",
            "createdAt": now.saturating_sub(3_600_000),
            "segments": [{
                "startHour": 0,
                "startMinute": 0,
                "endHour": 0,
                "endMinute": 0,
                "days": [0]
            }],
            "resolvedSegments": [{
                "startHour": 0,
                "startMinute": 0,
                "endHour": 0,
                "endMinute": 0,
                "days": [],
                "activeFromTimestampMs": now.saturating_sub(60_000),
                "activeUntilTimestampMs": now + 60_000
            }]
        }],
        "settings": {}
    });

    fs::write(&path, serde_json::to_vec(&data).unwrap()).unwrap();
    let apps = derive_allowed_apps(&path);
    let _ = fs::remove_file(&path);

    assert_eq!(apps, vec!["Mail".to_string()]);
}

#[test]
fn derive_payload_keeps_one_shot_allowlist_schedule_metadata() {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let active_from = now.saturating_sub(60_000);
    let active_until = now + 60_000;
    let path = temp_json_path("resolved-one-shot-allowlist-payload");
    let data = json!({
        "blocklists": [{
            "id": "bl-allow-web",
            "name": "Allow Websites",
            "mode": "allowlist",
            "websites": ["docs.example.com"],
            "apps": []
        }],
        "activeBlocks": [],
        "schedules": [{
            "id": "sch-allow-web",
            "blocklistId": "bl-allow-web",
            "repeatType": "no",
            "createdAt": now.saturating_sub(3_600_000),
            "segments": [{
                "startHour": 0,
                "startMinute": 0,
                "endHour": 0,
                "endMinute": 0,
                "days": [0]
            }],
            "resolvedSegments": [{
                "startHour": 0,
                "startMinute": 0,
                "endHour": 0,
                "endMinute": 0,
                "days": [],
                "activeFromTimestampMs": active_from,
                "activeUntilTimestampMs": active_until
            }]
        }],
        "settings": {}
    });

    fs::write(&path, serde_json::to_vec(&data).unwrap()).unwrap();
    let (domains, blocks) = derive_payload(&path);
    let _ = fs::remove_file(&path);

    assert!(
        domains.is_empty(),
        "allowlist domains should not leak into legacy flat blacklist payload"
    );
    assert_eq!(blocks.len(), 1);
    assert_eq!(blocks[0].blocklist_id, "bl-allow-web");
    assert_eq!(blocks[0].mode, "allowlist");
    assert_eq!(blocks[0].source, "schedule");
    assert_eq!(blocks[0].domains, vec!["docs.example.com".to_string()]);
    assert_eq!(blocks[0].started_at, Some(active_from));
    assert_eq!(blocks[0].ends_at, Some(active_until));
}

#[test]
fn derive_payload_keeps_allowlist_only_websites_out_of_legacy_blocklist() {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let path = write_temp_json(
        "allowlist-only-active-websites",
        &json!({
            "blocklists": [{
                "id": "bl-allow-web",
                "name": "Allow Websites",
                "mode": "allowlist",
                "websites": ["github.com", "docs.rs"],
                "apps": []
            }],
            "activeBlocks": [{
                "blocklistId": "bl-allow-web",
                "startTime": now.saturating_sub(60_000),
                "endTime": now + 60_000
            }],
            "schedules": [],
            "settings": {}
        }),
    );

    let (domains, blocks) = derive_payload(&path);
    let _ = fs::remove_file(&path);

    assert!(
        domains.is_empty(),
        "legacy flat blocklist stays empty for allowlist-only website sessions"
    );
    assert_eq!(blocks.len(), 1);
    assert_eq!(blocks[0].mode, "allowlist");
    assert_eq!(
        blocks[0].domains,
        vec!["github.com".to_string(), "docs.rs".to_string()]
    );
}

#[test]
fn derive_payload_keeps_legacy_flat_blocklist_for_blocklist_mode_only() {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let path = write_temp_json(
        "mixed-website-payload",
        &json!({
            "blocklists": [
                {
                    "id": "bl-block",
                    "name": "Block Social",
                    "websites": ["reddit.com"],
                    "apps": []
                },
                {
                    "id": "bl-allow",
                    "name": "Allow Work",
                    "mode": "allowlist",
                    "websites": ["github.com"],
                    "apps": []
                }
            ],
            "activeBlocks": [
                {
                    "blocklistId": "bl-block",
                    "startTime": now.saturating_sub(60_000),
                    "endTime": now + 60_000
                },
                {
                    "blocklistId": "bl-allow",
                    "startTime": now.saturating_sub(30_000),
                    "endTime": now + 60_000
                }
            ],
            "schedules": [],
            "settings": {}
        }),
    );

    let (domains, blocks) = derive_payload(&path);
    let _ = fs::remove_file(&path);

    assert_eq!(domains, vec!["reddit.com".to_string()]);
    assert_eq!(blocks.len(), 2);
    assert!(blocks
        .iter()
        .any(|b| b.blocklist_id == "bl-block" && b.mode == "blocklist"));
    assert!(blocks
        .iter()
        .any(|b| b.blocklist_id == "bl-allow" && b.mode == "allowlist"));
}

#[test]
fn derive_payload_strips_leading_www_from_stored_websites() {
    // Data saved before the input field normalized `www.` still carries it.
    // Matching is "host == entry or a subdomain of entry", so an entry kept
    // as `www.example.com` would never match `example.com` — the block would
    // silently not apply to the bare domain.
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let path = write_temp_json(
        "www-website-payload",
        &json!({
            "blocklists": [
                {
                    "id": "bl-block",
                    "name": "Block",
                    "websites": ["WWW.UlrikLyngs.com", "www2.example.com", "www.com"],
                    "apps": []
                },
                {
                    "id": "bl-allow",
                    "name": "Allow",
                    "mode": "allowlist",
                    "websites": ["www.github.com"],
                    "apps": []
                }
            ],
            "activeBlocks": [
                {
                    "blocklistId": "bl-block",
                    "startTime": now.saturating_sub(60_000),
                    "endTime": now + 60_000
                },
                {
                    "blocklistId": "bl-allow",
                    "startTime": now.saturating_sub(30_000),
                    "endTime": now + 60_000
                }
            ],
            "schedules": [],
            "settings": {}
        }),
    );

    let (domains, blocks) = derive_payload(&path);
    let _ = fs::remove_file(&path);

    assert_eq!(
        domains,
        vec![
            "ulriklyngs.com".to_string(),
            "www.com".to_string(),
            "www2.example.com".to_string()
        ]
    );
    let allow = blocks
        .iter()
        .find(|b| b.blocklist_id == "bl-allow")
        .unwrap();
    assert_eq!(allow.domains, vec!["github.com".to_string()]);
}

#[test]
fn current_payload_serializes_empty_legacy_blocklist_with_additive_allowlist_blocks() {
    #[derive(Serialize)]
    struct Msg<'a> {
        blocklist: &'a [String],
        blocks: &'a [BlockInfo],
    }

    let domains = Vec::<String>::new();
    let blocks = vec![BlockInfo {
        blocklist_id: "allow".to_string(),
        name: Some("Allow".to_string()),
        emoji: None,
        color: None,
        mode: "allowlist".to_string(),
        domains: vec!["github.com".to_string()],
        apps: vec![],
        source: "activeBlock",
        ends_at: Some(999),
        started_at: Some(111),
    }];

    let payload = serde_json::to_value(Msg {
        blocklist: &domains,
        blocks: &blocks,
    })
    .unwrap();

    assert_eq!(payload.get("blocklist").unwrap(), &json!([]));
    assert_eq!(payload["blocks"][0]["mode"], "allowlist");
    assert_eq!(payload["blocks"][0]["domains"], json!(["github.com"]));
}

#[test]
fn extension_payload_compat_accepts_legacy_flat_blocklist_only_shape() {
    let payload: HostPayloadCompat = serde_json::from_value(json!({
        "blocklist": ["reddit.com"]
    }))
    .unwrap();

    assert_eq!(payload.blocklist, vec!["reddit.com".to_string()]);
    assert!(payload.blocks.is_empty());
}

#[test]
fn extension_payload_compat_defaults_missing_block_mode_to_blocklist() {
    let payload: HostPayloadCompat = serde_json::from_value(json!({
        "blocklist": ["reddit.com"],
        "blocks": [{
            "blocklistId": "legacy-block",
            "domains": ["reddit.com"]
        }]
    }))
    .unwrap();

    assert_eq!(payload.blocks.len(), 1);
    assert_eq!(payload.blocks[0].blocklist_id, "legacy-block");
    assert_eq!(payload.blocks[0].mode, "blocklist");
    assert_eq!(payload.blocks[0].domains, vec!["reddit.com".to_string()]);
}

#[test]
fn derive_payload_includes_per_block_apps() {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let path = temp_json_path("per-block-apps");
    let data = json!({
        "blocklists": [{
            "id": "bl-apps",
            "name": "Work apps",
            "mode": "allowlist",
            "websites": [],
            "apps": ["Mail", "Notes"]
        }],
        "activeBlocks": [{
            "blocklistId": "bl-apps",
            "startTime": now.saturating_sub(60_000),
            "endTime": now + 60_000
        }],
        "schedules": [],
        "settings": {}
    });

    fs::write(&path, serde_json::to_vec(&data).unwrap()).unwrap();
    let (_domains, blocks) = derive_payload(&path);
    let _ = fs::remove_file(&path);

    assert_eq!(blocks.len(), 1);
    assert_eq!(
        blocks[0].apps,
        vec!["Mail".to_string(), "Notes".to_string()]
    );
}

/// A one-off block whose pause window has already elapsed must enforce
/// again on its own, exactly as `match_schedule_now` already does for
/// schedules (`paused && pause_end > now_ms`).
///
/// Derivation must not depend on the frontend having cleared `isPaused`
/// first: the sweep that clears it lives in a 1 s JS interval
/// (`src/render.js`), and macOS throttles WKWebView timers while the
/// window is hidden — which is the app's normal tray state. A stale flag
/// would otherwise leave the block silently unenforced past its pause.
#[test]
fn expired_one_off_pause_resumes_enforcement() {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let path = temp_json_path("expired-one-off-pause");
    let data = json!({
        "blocklists": [{
            "id": "bl-paused",
            "name": "Focus",
            "mode": "blocklist",
            "websites": ["example.invalid"],
            "apps": ["Mail"]
        }],
        "activeBlocks": [{
            "blocklistId": "bl-paused",
            "startTime": now.saturating_sub(60_000),
            "endTime": now + 60_000,
            // Paused, but the pause ended a minute ago.
            "isPaused": true,
            "pauseEndTime": now.saturating_sub(60_000)
        }],
        "schedules": [],
        "settings": {}
    });

    fs::write(&path, serde_json::to_vec(&data).unwrap()).unwrap();
    let (domains, blocks) = derive_payload(&path);
    let apps = derive_blocked_apps(&path);
    let _ = fs::remove_file(&path);

    assert!(
        domains.contains(&"example.invalid".to_string()),
        "expired pause should not keep the domain unenforced, got {domains:?}"
    );
    assert_eq!(
        blocks.len(),
        1,
        "expired pause should yield an active block"
    );
    assert!(
        apps.contains(&"Mail".to_string()),
        "expired pause should not keep the app unenforced, got {apps:?}"
    );
}

/// A one-off block with `isPaused` and no `pauseEndTime` enforces rather
/// than suppressing.
///
/// This is a deliberate choice, not a fallback: it fails in the safe
/// direction for a blocker. The app never writes this shape for a block
/// (switching a Manual space off deletes the block; timed pauses always carry
/// an end time), so it can only come from hand-editing the data file.
/// Schedules deliberately differ — see
/// `schedule_pause_without_end_time_is_switched_off`.
#[test]
fn pause_without_end_time_does_not_suppress_enforcement() {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let path = temp_json_path("pause-without-end-time");
    let data = json!({
        "blocklists": [{
            "id": "bl-paused",
            "name": "Focus",
            "mode": "blocklist",
            "websites": ["example.invalid"],
            "apps": []
        }],
        "activeBlocks": [{
            "blocklistId": "bl-paused",
            "startTime": now.saturating_sub(60_000),
            "endTime": now + 60_000,
            "isPaused": true
            // no pauseEndTime
        }],
        "schedules": [],
        "settings": {}
    });

    fs::write(&path, serde_json::to_vec(&data).unwrap()).unwrap();
    let (domains, _blocks) = derive_payload(&path);
    let _ = fs::remove_file(&path);

    assert!(
        domains.contains(&"example.invalid".to_string()),
        "a pause with no end time must not disable enforcement indefinitely, got {domains:?}"
    );
}

/// A schedule with `isPaused` and no `pauseEndTime` is switched off.
///
/// This is the one shape where schedules and one-off blocks deliberately
/// differ. The card switch turns a Daily / Weekly space off by writing
/// exactly this (through the override challenge), and the frontend engine,
/// iOS (`ScheduleData.swift`) all read it
/// as "paused until turned on again". Desktop must agree, or a space the
/// user switched off would keep blocking on macOS/Windows only.
#[test]
fn schedule_pause_without_end_time_is_switched_off() {
    let path = temp_json_path("schedule-pause-without-end-time");
    let data = json!({
        "blocklists": [{
            "id": "bl-off",
            "name": "Focus",
            "mode": "blocklist",
            "websites": ["switched-off.invalid"],
            "apps": []
        }],
        "activeBlocks": [],
        "schedules": [{
            "id": "s-off",
            "blocklistId": "bl-off",
            "repeatType": "forever",
            "segments": [{
                "startHour": 0, "startMinute": 0,
                "endHour": 23, "endMinute": 59,
                "days": [0, 1, 2, 3, 4, 5, 6]
            }],
            "isPaused": true
            // no pauseEndTime: off until the user turns it on
        }],
        "settings": {}
    });

    fs::write(&path, serde_json::to_vec(&data).unwrap()).unwrap();
    let (domains, _blocks) = derive_payload(&path);
    let _ = fs::remove_file(&path);

    assert!(
        !domains.contains(&"switched-off.invalid".to_string()),
        "a schedule switched off (isPaused, no pauseEndTime) must not enforce, got {domains:?}"
    );
}

/// The other half of the same rule: a pause that has *not* elapsed still
/// suppresses enforcement.
#[test]
fn live_one_off_pause_suppresses_enforcement() {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let path = temp_json_path("live-one-off-pause");
    let data = json!({
        "blocklists": [{
            "id": "bl-paused",
            "name": "Focus",
            "mode": "blocklist",
            "websites": ["example.invalid"],
            "apps": ["Mail"]
        }],
        "activeBlocks": [{
            "blocklistId": "bl-paused",
            "startTime": now.saturating_sub(60_000),
            "endTime": now + 60_000,
            "isPaused": true,
            "pauseEndTime": now + 30_000
        }],
        "schedules": [],
        "settings": {}
    });

    fs::write(&path, serde_json::to_vec(&data).unwrap()).unwrap();
    let (domains, blocks) = derive_payload(&path);
    let apps = derive_blocked_apps(&path);
    let _ = fs::remove_file(&path);

    assert!(
        domains.is_empty(),
        "live pause should suppress domains, got {domains:?}"
    );
    assert!(blocks.is_empty(), "live pause should suppress blocks");
    assert!(
        apps.is_empty(),
        "live pause should suppress apps, got {apps:?}"
    );
}

/// The predicate that decides allow mode is in force: any block in the
/// derived payload that is allowlist-mode and carries domains. This is
/// literally the `allowlist_active` test inside
/// `web_automation::url_is_blocked`, restated here because that module is
/// macOS-only (`lib.rs`) and the Windows job must still run these cases.
fn allow_mode_in_force(blocks: &[BlockInfo]) -> bool {
    blocks
        .iter()
        .any(|b| blocklist_mode_is_allowlist(&b.mode) && !b.domains.is_empty())
}

/// A paused allowlist one-off must stop allow enforcement, not merely stop
/// contributing domains.
///
/// Allow mode means "block everything except these", so a paused allowlist
/// left in the payload does not leak one blocklist — it blocks the entire
/// web for someone who just paused their focus space. That is the worst
/// direction a failure here can fall, so the pause has to suppress the
/// block itself rather than its domain list.
#[test]
fn live_pause_on_allowlist_one_off_stops_allow_enforcement() {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let path = temp_json_path("paused-allowlist-one-off");
    let data = json!({
        "blocklists": [{
            "id": "bl-allow-paused",
            "name": "Deep Work",
            "mode": "allowlist",
            "websites": ["work.invalid"],
            "apps": ["Mail"]
        }],
        "activeBlocks": [{
            "blocklistId": "bl-allow-paused",
            "startTime": now.saturating_sub(60_000),
            "endTime": now + 60_000,
            "isPaused": true,
            "pauseEndTime": now + 30_000
        }],
        "schedules": [],
        "settings": {}
    });

    fs::write(&path, serde_json::to_vec(&data).unwrap()).unwrap();
    let (domains, blocks) = derive_payload(&path);
    let allowed_apps = derive_allowed_apps(&path);
    let _ = fs::remove_file(&path);

    assert!(
        blocks.is_empty(),
        "a live pause should drop the allowlist block entirely, got {blocks:?}"
    );
    assert!(
        !allow_mode_in_force(&blocks),
        "a paused allowlist must not keep allow mode in force — every site outside it would stay blocked"
    );
    assert!(
        domains.is_empty(),
        "a paused allowlist should contribute nothing, got {domains:?}"
    );
    assert!(
        allowed_apps.is_empty(),
        "a paused allowlist should not keep an allowed-app set alive, got {allowed_apps:?}"
    );
    // The decision the macOS enforcement tick actually makes. Gated because
    // `web_automation` does not compile off macOS; the assertions above are
    // the same predicate and do run on Windows.
    #[cfg(target_os = "macos")]
    assert!(
        !crate::web_automation::url_is_blocked("https://unrelated.invalid/", &blocks),
        "an unrelated host must not be blocked once the allowlist is paused"
    );
}

/// The same fixture unpaused, so the case above cannot pass merely because
/// the fixture was malformed. An active allowlist one-off does put allow
/// mode in force: its own host stays reachable, everything else is blocked.
#[test]
fn unpaused_allowlist_one_off_puts_allow_mode_in_force() {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let path = temp_json_path("unpaused-allowlist-one-off");
    let data = json!({
        "blocklists": [{
            "id": "bl-allow-paused",
            "name": "Deep Work",
            "mode": "allowlist",
            "websites": ["work.invalid"],
            "apps": ["Mail"]
        }],
        "activeBlocks": [{
            "blocklistId": "bl-allow-paused",
            "startTime": now.saturating_sub(60_000),
            "endTime": now + 60_000
        }],
        "schedules": [],
        "settings": {}
    });

    fs::write(&path, serde_json::to_vec(&data).unwrap()).unwrap();
    let (_domains, blocks) = derive_payload(&path);
    let allowed_apps = derive_allowed_apps(&path);
    let _ = fs::remove_file(&path);

    assert_eq!(blocks.len(), 1, "unpaused allowlist should yield one block");
    assert_eq!(blocks[0].mode, "allowlist");
    assert!(
        allow_mode_in_force(&blocks),
        "an unpaused allowlist must put allow mode in force, got {blocks:?}"
    );
    assert_eq!(
        allowed_apps,
        vec!["Mail".to_string()],
        "an unpaused allowlist should expose its allowed apps"
    );
    #[cfg(target_os = "macos")]
    {
        assert!(
            crate::web_automation::url_is_blocked("https://unrelated.invalid/", &blocks),
            "allow mode should block a host outside the allowlist"
        );
        assert!(
            !crate::web_automation::url_is_blocked("https://work.invalid/", &blocks),
            "allow mode should leave an allowlisted host reachable"
        );
    }
}

/// The schedule path reaches the same decision through `match_schedule_now`
/// rather than `one_off_pause_active`, so a paused allowlist *schedule*
/// needs its own case. Failure falls the same way: allow mode left in force
/// blocks the whole web for someone who paused the space.
#[test]
fn live_pause_on_allowlist_schedule_stops_allow_enforcement() {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let path = temp_json_path("paused-allowlist-schedule");
    let data = json!({
        "blocklists": [{
            "id": "bl-allow-sched",
            "name": "Study",
            "mode": "allowlist",
            "websites": ["work.invalid"],
            "apps": []
        }],
        "activeBlocks": [],
        "schedules": [{
            "id": "sch-allow-paused",
            "blocklistId": "bl-allow-sched",
            "repeatType": "no",
            // Absolute window, so the case does not depend on the wall-clock
            // time the suite happens to run at.
            "resolvedSegments": [{
                "activeFromTimestampMs": now.saturating_sub(60_000),
                "activeUntilTimestampMs": now + 60_000
            }],
            "isPaused": true,
            "pauseEndTime": now + 30_000
        }],
        "settings": {}
    });

    fs::write(&path, serde_json::to_vec(&data).unwrap()).unwrap();
    let (domains, blocks) = derive_payload(&path);
    let _ = fs::remove_file(&path);

    assert!(
        blocks.is_empty(),
        "a live pause should drop the allowlist schedule entirely, got {blocks:?}"
    );
    assert!(
        !allow_mode_in_force(&blocks),
        "a paused allowlist schedule must not keep allow mode in force"
    );
    assert!(
        domains.is_empty(),
        "a paused allowlist schedule should contribute nothing, got {domains:?}"
    );
    #[cfg(target_os = "macos")]
    assert!(
        !crate::web_automation::url_is_blocked("https://unrelated.invalid/", &blocks),
        "an unrelated host must not be blocked once the allowlist schedule is paused"
    );
}

/// The schedule control, for the same reason as the one-off control: it
/// proves the fixture is otherwise live, so the case above would catch a
/// change in either direction.
#[test]
fn unpaused_allowlist_schedule_puts_allow_mode_in_force() {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let path = temp_json_path("unpaused-allowlist-schedule");
    let data = json!({
        "blocklists": [{
            "id": "bl-allow-sched",
            "name": "Study",
            "mode": "allowlist",
            "websites": ["work.invalid"],
            "apps": []
        }],
        "activeBlocks": [],
        "schedules": [{
            "id": "sch-allow-paused",
            "blocklistId": "bl-allow-sched",
            "repeatType": "no",
            "resolvedSegments": [{
                "activeFromTimestampMs": now.saturating_sub(60_000),
                "activeUntilTimestampMs": now + 60_000
            }]
        }],
        "settings": {}
    });

    fs::write(&path, serde_json::to_vec(&data).unwrap()).unwrap();
    let (_domains, blocks) = derive_payload(&path);
    let _ = fs::remove_file(&path);

    assert_eq!(
        blocks.len(),
        1,
        "unpaused allowlist schedule should yield one block"
    );
    assert_eq!(blocks[0].mode, "allowlist");
    assert!(
        allow_mode_in_force(&blocks),
        "an unpaused allowlist schedule must put allow mode in force, got {blocks:?}"
    );
    #[cfg(target_os = "macos")]
    assert!(
        crate::web_automation::url_is_blocked("https://unrelated.invalid/", &blocks),
        "allow mode from a schedule should block a host outside the allowlist"
    );
}

// ---- Classroom rooms -------------------------------------------------------
//
// A room is a one-off block whose `activeBlocks` entry carries a `roomId`.
// See docs/classroom-design.md.

fn now_ms_for_test() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// A room in allow mode plus the student's own allow-mode space, started
/// both as a one-off and through a schedule.
fn allow_room_with_own_allowlists(now: u64, room_block: Value) -> Value {
    json!({
        "blocklists": [
            {
                "id": "room-bl",
                "name": "Year 9 maths",
                "mode": "allowlist",
                "websites": ["school.invalid"],
                "apps": ["Calculator"]
            },
            {
                "id": "own-allow",
                "name": "My focus",
                "mode": "allowlist",
                "websites": ["videos.invalid"],
                "apps": ["Spotify"]
            },
            {
                "id": "own-allow-scheduled",
                "name": "My evenings",
                "mode": "allowlist",
                "websites": ["chat.invalid"],
                "apps": ["Discord"]
            }
        ],
        "activeBlocks": [
            room_block,
            {
                "blocklistId": "own-allow",
                "startTime": now.saturating_sub(60_000),
                "endTime": now + 60_000
            }
        ],
        "schedules": [{
            "id": "sch-own",
            "blocklistId": "own-allow-scheduled",
            "repeatType": "no",
            "createdAt": now.saturating_sub(3_600_000),
            "segments": [{
                "startHour": 0, "startMinute": 0, "endHour": 0, "endMinute": 0, "days": [0]
            }],
            "resolvedSegments": [{
                "startHour": 0, "startMinute": 0, "endHour": 0, "endMinute": 0, "days": [],
                "activeFromTimestampMs": now.saturating_sub(60_000),
                "activeUntilTimestampMs": now + 60_000
            }]
        }],
        "settings": {}
    })
}

/// Concurrent allow-mode spaces union. Left alone, a student's own allow-mode
/// space would widen the room: start "My focus" allowing a video site and the
/// classroom's allowlist allows it too. While an allow-mode room is in force,
/// the student's other allow-mode spaces must drop out of the derivation.
#[test]
fn allow_room_overrides_the_students_own_allow_mode_spaces() {
    let now = now_ms_for_test();
    let data = allow_room_with_own_allowlists(
        now,
        json!({
            "blocklistId": "room-bl",
            "roomId": "room-1",
            "startTime": now.saturating_sub(60_000),
            "endTime": now + 60_000
        }),
    );
    let path = write_temp_json("room-overrides-own-allowlists", &data);
    let (_domains, blocks) = derive_payload(&path);
    let allowed_apps = derive_allowed_apps(&path);
    let _ = fs::remove_file(&path);

    let ids: Vec<&str> = blocks.iter().map(|b| b.blocklist_id.as_str()).collect();
    assert_eq!(
        ids,
        vec!["room-bl"],
        "only the room's allowlist may be in force while the room is"
    );
    assert_eq!(
        allowed_apps,
        vec!["Calculator".to_string()],
        "the student's own allowed apps must not widen the room"
    );
    #[cfg(target_os = "macos")]
    {
        assert!(
            crate::web_automation::url_is_blocked("https://videos.invalid/", &blocks),
            "a site allowed only by the student's own space must be blocked in the room"
        );
        assert!(
            crate::web_automation::url_is_blocked("https://chat.invalid/", &blocks),
            "a site allowed only by the student's own schedule must be blocked in the room"
        );
        assert!(
            !crate::web_automation::url_is_blocked("https://school.invalid/", &blocks),
            "the room's own allowed site must stay reachable"
        );
    }
}

/// The same fixture with the room over, so the case above cannot pass because
/// the fixture never produced the student's blocks in the first place. Once
/// the room's end time passes, the student's own spaces are back in force.
#[test]
fn an_ended_room_gives_the_students_own_spaces_back() {
    let now = now_ms_for_test();
    let data = allow_room_with_own_allowlists(
        now,
        json!({
            "blocklistId": "room-bl",
            "roomId": "room-1",
            "startTime": now.saturating_sub(120_000),
            "endTime": now.saturating_sub(60_000)
        }),
    );
    let path = write_temp_json("room-ended", &data);
    let (_domains, blocks) = derive_payload(&path);
    let mut allowed_apps = derive_allowed_apps(&path);
    let _ = fs::remove_file(&path);
    allowed_apps.sort();

    let mut ids: Vec<&str> = blocks.iter().map(|b| b.blocklist_id.as_str()).collect();
    ids.sort();
    assert_eq!(ids, vec!["own-allow", "own-allow-scheduled"]);
    assert_eq!(
        allowed_apps,
        vec!["Discord".to_string(), "Spotify".to_string()]
    );
}

/// A room with no end time could never release, so it must not be enforced
/// at all. Failure here falls towards allowing, deliberately: the alternative
/// is a block on someone's own laptop that nothing ends.
#[test]
fn a_room_without_an_end_time_is_not_enforced() {
    let now = now_ms_for_test();
    let data = allow_room_with_own_allowlists(
        now,
        json!({
            "blocklistId": "room-bl",
            "roomId": "room-1",
            "startTime": now.saturating_sub(60_000)
        }),
    );
    let path = write_temp_json("room-no-end", &data);
    let (_domains, blocks) = derive_payload(&path);
    let _ = fs::remove_file(&path);

    assert!(
        blocks.iter().all(|b| b.blocklist_id != "room-bl"),
        "a room with no end time must not be enforced, got {blocks:?}"
    );
    assert_eq!(blocks.len(), 2, "the student's own spaces stay in force");
}

/// The override only narrows. The student's own blocklists keep applying
/// inside a room, and a block-mode room leaves their allow-mode spaces alone,
/// because those can only block more, never less.
#[test]
fn rooms_never_lift_the_students_own_restrictions() {
    let now = now_ms_for_test();
    let one_off = |id: &str| {
        json!({
            "blocklistId": id,
            "startTime": now.saturating_sub(60_000),
            "endTime": now + 60_000
        })
    };
    let room = |id: &str| {
        json!({
            "blocklistId": id,
            "roomId": "room-1",
            "startTime": now.saturating_sub(60_000),
            "endTime": now + 60_000
        })
    };
    let blocklists = json!([
        { "id": "room-allow", "mode": "allowlist", "websites": ["school.invalid", "games.invalid"], "apps": [] },
        { "id": "room-block", "mode": "blocklist", "websites": ["videos.invalid"], "apps": ["Steam"] },
        { "id": "own-block", "mode": "blocklist", "websites": ["games.invalid"], "apps": ["Discord"] },
        { "id": "own-allow", "mode": "allowlist", "websites": ["work.invalid"], "apps": ["Mail"] }
    ]);

    // Allow-mode room + the student's own blocklist.
    let path = write_temp_json(
        "room-keeps-own-blocklist",
        &json!({
            "blocklists": blocklists,
            "activeBlocks": [room("room-allow"), one_off("own-block")],
            "schedules": [],
            "settings": {}
        }),
    );
    let (domains, blocks) = derive_payload(&path);
    let blocked_apps = derive_blocked_apps(&path);
    let _ = fs::remove_file(&path);
    assert_eq!(domains, vec!["games.invalid".to_string()]);
    assert_eq!(blocks.len(), 2);
    assert_eq!(blocked_apps, vec!["Discord".to_string()]);

    // Block-mode room + the student's own allow-mode space.
    let path = write_temp_json(
        "block-room-keeps-own-allowlist",
        &json!({
            "blocklists": blocklists,
            "activeBlocks": [room("room-block"), one_off("own-allow")],
            "schedules": [],
            "settings": {}
        }),
    );
    let (domains, blocks) = derive_payload(&path);
    let allowed_apps = derive_allowed_apps(&path);
    let blocked_apps = derive_blocked_apps(&path);
    let _ = fs::remove_file(&path);
    assert_eq!(domains, vec!["videos.invalid".to_string()]);
    assert!(
        allow_mode_in_force(&blocks),
        "a block-mode room must leave the student's own allow mode in force"
    );
    assert_eq!(allowed_apps, vec!["Mail".to_string()]);
    assert_eq!(blocked_apps, vec!["Steam".to_string()]);
}

/// Pausing is a one-click way out of an ordinary block. A room's way out is
/// the leave friction the teacher set, so a pause flag on a room block must
/// not suspend it, whatever wrote the flag. Leaving removes the block.
#[test]
fn a_pause_does_not_suspend_a_room_block() {
    let now = now_ms_for_test();
    let path = write_temp_json(
        "room-ignores-pause",
        &json!({
            "blocklists": [{
                "id": "room-bl",
                "mode": "blocklist",
                "websites": ["videos.invalid"],
                "apps": ["Steam"]
            }],
            "activeBlocks": [{
                "blocklistId": "room-bl",
                "roomId": "room-1",
                "startTime": now.saturating_sub(60_000),
                "endTime": now + 60_000,
                "isPaused": true,
                "pauseEndTime": now + 30_000
            }],
            "schedules": [],
            "settings": {}
        }),
    );
    let (domains, blocks) = derive_payload(&path);
    let blocked_apps = derive_blocked_apps(&path);
    let _ = fs::remove_file(&path);

    assert_eq!(domains, vec!["videos.invalid".to_string()]);
    assert_eq!(blocks.len(), 1);
    assert_eq!(blocked_apps, vec!["Steam".to_string()]);
}

#[test]
fn read_payload_refuses_oversized_messages_before_reading() {
    let mut reader = std::io::Cursor::new(vec![7u8; 4]);
    let err = read_payload(&mut reader, MAX_INBOUND_BYTES + 1).unwrap_err();
    assert_eq!(err.kind(), std::io::ErrorKind::Other);
    assert_eq!(read_payload(&mut reader, 4).unwrap(), vec![7u8; 4]);
}

#[test]
fn open_settings_request_only_reaches_the_clicked_browser() {
    assert!(opens_settings_for("chrome", "chrome.exe 154.0.8037.99"));
    assert!(opens_settings_for("edge\n", "msedge.exe 156.0.4314.50"));
    assert!(!opens_settings_for("chrome", "msedge.exe 156.0.4314.50"));
    assert!(!opens_settings_for("edge", "unknown"));
    assert!(!opens_settings_for("", "chrome.exe"));
}

#[test]
fn open_settings_flag_rides_on_a_full_payload() {
    // Older extensions replace their rules with each frame, so the flag must
    // never arrive without the blocklist beside it.
    let domains = vec!["x.com".to_string()];
    let with: Value = serde_json::from_slice(&payload_json(&domains, &[], true).unwrap()).unwrap();
    assert_eq!(with["openExtensionSettings"], true);
    assert_eq!(with["blocklist"], json!(["x.com"]));
    let without: Value =
        serde_json::from_slice(&payload_json(&domains, &[], false).unwrap()).unwrap();
    assert!(without.get("openExtensionSettings").is_none());
}
