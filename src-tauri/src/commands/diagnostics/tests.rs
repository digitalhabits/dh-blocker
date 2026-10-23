use super::{allowed_domains_from_blocks, strip_diagnostics_only_execution_fields};
use crate::native_host::BlockInfo;
use serde_json::json;

#[test]
fn allowed_domains_from_blocks_unions_allowlist_only() {
    let blocks = vec![
        BlockInfo {
            blocklist_id: "bl".to_string(),
            name: None,
            emoji: None,
            color: None,
            mode: "blocklist".to_string(),
            domains: vec!["blocked.com".to_string()],
            apps: vec![],
            source: "activeBlock",
            ends_at: Some(100),
            started_at: Some(0),
        },
        BlockInfo {
            blocklist_id: "al".to_string(),
            name: None,
            emoji: None,
            color: None,
            mode: "allowlist".to_string(),
            domains: vec![
                "docs.example.com".to_string(),
                "mail.example.com".to_string(),
            ],
            apps: vec![],
            source: "schedule",
            ends_at: Some(200),
            started_at: Some(0),
        },
        BlockInfo {
            blocklist_id: "al2".to_string(),
            name: None,
            emoji: None,
            color: None,
            mode: "allowlist".to_string(),
            domains: vec!["mail.example.com".to_string()],
            apps: vec![],
            source: "activeBlock",
            ends_at: Some(300),
            started_at: Some(0),
        },
    ];
    assert_eq!(
        allowed_domains_from_blocks(&blocks),
        vec![
            "docs.example.com".to_string(),
            "mail.example.com".to_string(),
        ]
    );
}

#[test]
fn diagnostics_app_data_strips_resolved_segments_recursively() {
    let mut value = json!({
        "schedules": [{
            "id": "sch-1",
            "segments": [{ "days": [1] }],
            "resolvedSegments": [{
                "activeFromTimestampMs": 100,
                "activeUntilTimestampMs": 200
            }]
        }],
        "nested": {
            "resolvedSegments": [{
                "activeFromTimestampMs": 300,
                "activeUntilTimestampMs": 400
            }]
        }
    });

    strip_diagnostics_only_execution_fields(&mut value);

    assert!(value["schedules"][0].get("resolvedSegments").is_none());
    assert!(value["nested"].get("resolvedSegments").is_none());
    assert_eq!(value["schedules"][0]["segments"][0]["days"][0], 1);
}

#[cfg(target_os = "windows")]
#[test]
fn last_connections_keeps_newest_launch_per_browser() {
    let log = "\
[100] spawned pid=1 exe=None argv=[\"x\", \"chrome-extension://gmjfgjdhnhcegfelcddbdljdffiaepam/\"]
[150] sent blocklist (0 domains, 0 blocks)
[200] spawned pid=2 exe=None argv=[\"x\"] browser=msedge.exe 141.0.1.2
[300] spawned pid=3 exe=None argv=[\"x\"] browser=chrome.exe 154.0.1.1
[400] spawned pid=4 exe=None argv=[\"x\"] browser=msedge.exe 141.0.1.2
[500] spawned pid=5 exe=None argv=[\"x\"]
";
    let got: Vec<(String, u64)> = super::last_connections(log)
        .into_iter()
        .map(|c| (c.browser, c.at))
        .collect();
    assert_eq!(
        got,
        vec![
            ("msedge.exe 141.0.1.2".to_string(), 400),
            ("chrome.exe 154.0.1.1".to_string(), 300),
            ("Edge Add-ons extension".to_string(), 100),
        ]
    );
}
