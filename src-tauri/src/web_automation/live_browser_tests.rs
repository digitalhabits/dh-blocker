//! Opt-in native transport smoke test. Never attach to an existing browser.
use super::*;
use crate::block_page::{original_url_from_block_page, path_to_file_url};
use std::path::PathBuf;
use std::process::{Child, Command};

struct IsolatedBrowser(Child);
impl Drop for IsolatedBrowser {
    fn drop(&mut self) {
        // This child was launched below with a new worktree-local profile.
        // Never use an application-wide quit or kill an enumerated PID.
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn wait_for_tab(expected: &str) -> Tab {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let tabs = match read_tabs(SupportedBrowser::Brave) {
            Ok(tabs) => tabs,
            // The process can exist before Launch Services can address it.
            // Retry only this startup race, within the same bounded wait;
            // permission denials and other read errors must still fail.
            Err(AutomationError::Other(message))
                if message.contains("(-600)") && Instant::now() < deadline =>
            {
                std::thread::sleep(Duration::from_millis(200));
                continue;
            }
            Err(error) => panic!("native Brave tab read failed: {error:?}"),
        };
        if let Some(tab) = tabs.into_iter().find(|tab| tab.url == expected) {
            return tab;
        }
        assert!(
            Instant::now() < deadline,
            "Brave never displayed the expected test URL"
        );
        std::thread::sleep(Duration::from_millis(200));
    }
}

#[test]
#[ignore = "opens isolated Brave; run explicitly with NATIVE_BROWSER_VALIDATION=1 and Brave closed"]
fn live_brave_redirect_and_restore() {
    assert_eq!(
        std::env::var("NATIVE_BROWSER_VALIDATION").as_deref(),
        Ok("1"),
        "Explicit NATIVE_BROWSER_VALIDATION=1 is required"
    );
    assert!(
        !running_supported_browsers().contains(&SupportedBrowser::Brave),
        "Brave is already running; close it yourself before isolated native-browser validation"
    );
    let binary = PathBuf::from("/Applications/Brave Browser.app/Contents/MacOS/Brave Browser");
    assert!(
        binary.is_file(),
        "Brave Browser is not installed at the supported test path"
    );
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("repository root")
        .canonicalize()
        .expect("canonical repository root");
    let artifacts = root
        .join("artifacts/native-browser-validation")
        .join(format!(
            "{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
    std::fs::create_dir_all(&artifacts).expect("create isolated test directory");
    let original = "https://native-recovery.invalid/exact/path?first=one%20two&second=3#fragment";
    let mut browser = IsolatedBrowser(
        Command::new(&binary)
            .arg(format!(
                "--user-data-dir={}",
                artifacts.join("profile").display()
            ))
            .args([
                "--no-first-run",
                "--no-default-browser-check",
                "--new-window",
                original,
            ])
            .stdout(std::fs::File::create(artifacts.join("browser.stdout.log")).unwrap())
            .stderr(std::fs::File::create(artifacts.join("browser.stderr.log")).unwrap())
            .spawn()
            .expect("launch isolated Brave"),
    );
    std::thread::sleep(Duration::from_secs(2));
    assert!(
        browser.0.try_wait().unwrap().is_none(),
        "isolated Brave exited before validation"
    );
    let tab = wait_for_tab(original);
    let page = path_to_file_url(&root.join("src-tauri/blocked/blocked.html"));
    let blocks = vec![BlockInfo {
        blocklist_id: "native-validation".into(),
        name: None,
        emoji: None,
        color: None,
        mode: "blocklist".into(),
        domains: vec!["native-recovery.invalid".into()],
        apps: vec![],
        source: "activeBlock",
        ends_at: None,
        started_at: None,
    }];
    let redirect = plan_actions(&[tab], &blocks, &page);
    assert_eq!(redirect.len(), 1, "expected exactly one test-tab redirect");
    assert_eq!(
        original_url_from_block_page(&redirect[0].2).as_deref(),
        Some(original)
    );
    apply_actions(SupportedBrowser::Brave, &redirect).expect("native block-page navigation");
    let parked = wait_for_tab(&redirect[0].2);
    assert!(plan_actions(
        &[Tab {
            window_index: parked.window_index,
            tab_index: parked.tab_index,
            url: parked.url.clone()
        }],
        &blocks,
        &page
    )
    .is_empty());
    let restore = plan_actions(&[parked], &[], &page);
    assert_eq!(restore.len(), 1);
    assert_eq!(restore[0].2, original);
    apply_actions(SupportedBrowser::Brave, &restore).expect("native original-URL restoration");
    wait_for_tab(original);
    let version = Command::new(&binary)
        .arg("--version")
        .output()
        .expect("read Brave version");
    let revision = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(&root)
        .output()
        .unwrap();
    let dirty = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(&root)
        .output()
        .unwrap();
    let macos = Command::new("sw_vers")
        .arg("-productVersion")
        .output()
        .unwrap();
    let evidence = serde_json::json!({
        "revision": String::from_utf8_lossy(&revision.stdout).trim(),
        "workingTreeDirty": !dirty.stdout.is_empty(),
        "macosVersion": String::from_utf8_lossy(&macos.stdout).trim(),
        "platform": "macos", "browser": String::from_utf8_lossy(&version.stdout).trim(),
        "redirectObserved": true, "restoreObserved": true, "exactOriginalUrl": original,
        "terminationSignalsValidated": false,
        "scope": "Apple Events transport only; no app lifecycle, grace, notifications or browser termination"
    });
    std::fs::write(
        artifacts.join("result.json"),
        serde_json::to_vec_pretty(&evidence).unwrap(),
    )
    .unwrap();
    eprintln!(
        "Native browser evidence: {}",
        artifacts.join("result.json").display()
    );
}
