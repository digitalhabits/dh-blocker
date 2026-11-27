use super::*;

#[test]
fn strips_new_marker_block() {
    let input = b"127.0.0.1 localhost\n# === BEGIN REDD BLOCK (reddfocus.org) ===\n0.0.0.0 reddit.com\n# === END REDD BLOCK (reddfocus.org) ===\n::1 localhost\n";
    assert_eq!(
        strip_managed_sections(input).unwrap(),
        b"127.0.0.1 localhost\n::1 localhost\n"
    );
}

#[test]
fn strips_legacy_marker_block() {
    let input = b"127.0.0.1 localhost\n# ReDD Block Start\n0.0.0.0 reddit.com\n# ReDD Block End\n::1 localhost\n";
    assert_eq!(
        strip_managed_sections(input).unwrap(),
        b"127.0.0.1 localhost\n::1 localhost\n"
    );
}

#[test]
fn idempotent_when_nothing_managed() {
    let input = b"127.0.0.1 localhost\r\n::1 localhost";
    assert_eq!(strip_managed_sections(input).unwrap(), input);
}

#[test]
fn detects_markers() {
    assert!(hosts_has_markers(b"foo\n# ReDD Block Start\nbar\n"));
    assert!(hosts_has_markers(
        b"\xef\xbb\xbf# === BEGIN REDD BLOCK (reddfocus.org) ===\n"
    ));
    assert!(!hosts_has_markers(
        b"127.0.0.1 localhost\n# ReDD Block End notes\n"
    ));
}

#[test]
fn keeps_live_hosts_edits_and_exact_unmanaged_bytes() {
    let input = b"\xef\xbb\xbf\t# ReDD Block Start \r\n0.0.0.0 one.test\r\n# ReDD Block End\r\n127.0.0.1 localhost\n# l\xe9gacy comment\r\n# === BEGIN REDD BLOCK (reddfocus.org) ===\r\n0.0.0.0 two.test\n# === END REDD BLOCK (reddfocus.org) ===\n192.0.2.1 added-after-original-backup.test";
    let expected = b"\xef\xbb\xbf127.0.0.1 localhost\n# l\xe9gacy comment\r\n192.0.2.1 added-after-original-backup.test";
    assert_eq!(strip_managed_sections(input).unwrap(), expected);
}

#[test]
fn rejects_unpaired_crossed_and_nested_markers() {
    let ambiguous = [
        &b"# ReDD Block Start\n192.0.2.1 unrelated.test"[..],
        b"# ReDD Block End\n192.0.2.1 unrelated.test",
        b"# ReDD Block Start\n# === END REDD BLOCK (reddfocus.org) ===",
        b"# ReDD Block Start\n# ReDD Block Start\n# ReDD Block End\n# ReDD Block End",
    ];
    for input in ambiguous {
        assert!(hosts_has_markers(input));
        assert!(strip_managed_sections(input).is_err());
    }
}

#[test]
fn keeps_custom_hosts_without_localhost_and_allows_empty_edit() {
    let managed = b"# ReDD Block Start\n0.0.0.0 example.test\n# ReDD Block End\n";
    let custom = b"192.0.2.1 unrelated.test";
    assert!(strip_managed_sections(managed).unwrap().is_empty());
    assert_eq!(
        strip_managed_sections(&[managed.as_slice(), custom].concat()).unwrap(),
        custom
    );
}

#[test]
fn missing_hosts_is_distinct_from_empty_hosts() {
    let dir = migration_fixture_dir();
    let path = dir.join("hosts");
    assert_eq!(read_live_hosts(&path).unwrap(), None);
    std::fs::write(&path, []).unwrap();
    assert_eq!(read_live_hosts(&path).unwrap(), Some(Vec::new()));
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn identifies_task_only_windows_helper_residue() {
    let other_tasks = b"\"\\Microsoft\\Windows\\ReDD Block Helper\",\"N/A\",\"Ready\"\r\n\"\\ReDD Block Watchdog\",\"N/A\",\"Ready\"\r\n";
    let legacy_task = b"\"\\redd block helper\",\"N/A\",\"Disabled\"\r\n";
    assert!(!has_windows_legacy_helper_task(other_tasks));
    assert!(has_windows_legacy_helper_task(legacy_task));
}

#[cfg(not(feature = "system-test"))]
#[test]
fn migration_stamp_keeps_existing_data_and_refuses_malformed_json() {
    let dir = migration_fixture_dir();
    let path = dir.join("redd-block-data.json");

    stamp_version(&path, "3.13.0").unwrap();
    assert!(!path.exists());

    let corrupt = b"{\"blocklists\":[";
    std::fs::write(&path, corrupt).unwrap();
    assert!(stamp_version(&path, "3.13.0").is_err());
    assert_eq!(std::fs::read(&path).unwrap(), corrupt);

    let existing = serde_json::json!({
        "blocklists": [{"id": "test"}],
        "activeBlocks": [],
        "settings": {"theme": "dark"},
        "futureField": 42,
    });
    std::fs::write(&path, serde_json::to_vec(&existing).unwrap()).unwrap();
    stamp_version(&path, "3.13.0").unwrap();
    let stamped: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(stamped["blocklists"], existing["blocklists"]);
    assert_eq!(stamped["activeBlocks"], existing["activeBlocks"]);
    assert_eq!(stamped["futureField"], existing["futureField"]);
    assert_eq!(stamped["settings"]["theme"], "dark");
    assert_eq!(stamped["settings"]["migrationRanAtVersion"], "3.13.0");
    assert!(stamped["settings"]["migrationRanAt"].as_u64().unwrap() > 0);

    std::fs::remove_dir_all(dir).unwrap();
}

fn migration_fixture_dir() -> PathBuf {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "redd-migration-test-{}-{timestamp}",
        std::process::id()
    ));
    std::fs::create_dir(&dir).unwrap();
    dir
}

#[cfg(not(feature = "system-test"))]
#[test]
fn windows_launcher_passes_quoted_script_content_without_executing_a_temp_file() {
    let launcher = windows_elevation_launcher("Write-Output 'O''Brien'");
    assert!(!launcher.contains("Write-Output"));
    assert_eq!(encode_powershell_text("a’b"), "YQAZIGIA");
    assert!(launcher.contains("'-EncodedCommand',$payload"));
    assert!(!launcher.contains("'-File'"));
    assert!(include_str!("cleanup.ps1").trim_end().ends_with("exit 42"));
}

#[cfg(all(not(feature = "system-test"), target_os = "macos"))]
#[test]
fn cleanup_marker_must_be_the_final_shell_output_line() {
    assert!(cleanup_reported_success(b"permission reset\rok\n"));
    assert!(cleanup_reported_success(b"ok\n"));
    assert!(!cleanup_reported_success(b"ok\rfailed\n"));
}
