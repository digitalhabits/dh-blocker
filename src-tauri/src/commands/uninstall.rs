//! macOS in-app uninstall.
//!
//! Removes the launch-at-login entry, scrubs per-browser
//! native-messaging manifests and the Safari extension mirror, moves
//! the .app bundle to the user's Trash, and exits. User data in
//! `~/Library/Application Support/com.reddblock/` and
//! `~/Library/Preferences/com.reddblock.plist` is preserved so a future
//! reinstall picks the user's blocklists / schedules / settings back
//! up.
//!
//! Why an in-app command (and only on macOS):
//!   - macOS .pkg installers are install-only by design — they don't
//!     ship a sibling uninstaller, and the menu-bar accessory model +
//!     applicationShouldTerminate interceptor mean a user can't quit
//!     the app or drag-trash the bundle while it's running. So uninstall
//!     has to be self-driven from inside the app.
//!   - Windows uninstall lives in `windows/hooks.nsh`'s
//!     NSIS_HOOK_PREUNINSTALL macro, driven by the OS-provided
//!     uninstaller (Settings → Apps → Uninstall). No in-app command is
//!     needed there.
//!
//! Resolve the running bundle before touching setup or user data, then
//! verify legacy hosts and helper cleanup. Suspend and remove the
//! Safari policy mirror until the bundle move is confirmed. Restore
//! eligible policy if the move fails. Other cleanup follows the move.
//!
//! NSFileManager can move the bundle while the app is running. If it
//! fails, Finder may ask for Automation permission. Wait for Finder on
//! a worker thread and verify the original path is gone.
//!
//! Bundle removal and native-host cleanup are logged through Tauri.

#[cfg(target_os = "macos")]
mod native_hosts;

#[cfg(target_os = "macos")]
use std::process::{Command, Stdio};

#[cfg(target_os = "macos")]
use crate::native_host_install;

#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn uninstall_self_macos(
    app: tauri::AppHandle,
    delete_user_data: Option<bool>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        uninstall_macos(&app, delete_user_data.unwrap_or(false))
    })
    .await
    .map_err(|e| format!("uninstall worker failed: {e}"))?
}

#[cfg(target_os = "macos")]
fn uninstall_macos(app: &tauri::AppHandle, delete_user_data: bool) -> Result<(), String> {
    // Concurrent requests must not both pass bundle preflight.
    static UNINSTALL: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = UNINSTALL
        .try_lock()
        .map_err(|_| "uninstall is already running".to_string())?;
    log::info!("uninstall_self_macos: starting (delete_user_data={delete_user_data})");

    let executable = std::env::current_exe().and_then(|p| p.canonicalize()).ok();
    let bundle = executable
        .as_deref()
        .and_then(app_bundle_from_exe)
        .and_then(|path| path.to_str().map(String::from));
    let binary = executable
        .as_deref()
        .and_then(native_hosts::InstalledBinary::capture);

    uninstall_bundle(
        bundle,
        super::migration::cleanup_legacy_for_uninstall,
        |bundle| {
            let source = super::data::canonical_data_path(app);
            crate::app_group::remove_mirror_for_uninstall(source.as_deref(), || {
                move_bundle_to_trash(bundle)
            })
        },
        |_| finish_uninstall(app, delete_user_data, binary),
    )
}

#[cfg(target_os = "macos")]
fn finish_uninstall(
    app: &tauri::AppHandle,
    delete_user_data: bool,
    binary: Option<native_hosts::InstalledBinary>,
) {
    use tauri_plugin_autostart::ManagerExt;

    if delete_user_data {
        super::data::wipe_user_data(app);
    }

    if let Err(e) = native_host_install::uninstall() {
        log::warn!("uninstall_self_macos: native-host uninstall failed: {e}");
    }

    // Remove the External-Extensions hints. The extensions themselves
    // stay installed in the browser profiles.
    if let Err(e) = crate::extension_install::uninstall() {
        log::warn!("uninstall_self_macos: extension-install uninstall failed: {e}");
    }
    if let Some(binary) = binary {
        binary.close_native_hosts();
    }

    // The plugin deletes its plist. A bootout during the extra sweep
    // can terminate this process if launchd started it, so run the
    // sweep after cleanup and after the IPC reply has had time to land.
    if let Err(e) = app.autolaunch().disable() {
        log::warn!("uninstall_self_macos: autostart.disable failed: {e}");
    }
    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_millis(200));
        scrub_all_autostart_plists();
        log::info!("uninstall_self_macos: exiting now");
        std::process::exit(0);
    });
}

#[cfg(target_os = "macos")]
fn uninstall_bundle(
    bundle: Option<String>,
    clean_legacy: impl FnOnce() -> Result<(), String>,
    move_to_trash: impl FnOnce(&str) -> Result<(), String>,
    finish: impl FnOnce(&str),
) -> Result<(), String> {
    let bundle = bundle.ok_or_else(|| "could not resolve app bundle path".to_string())?;
    clean_legacy()?;
    move_to_trash(&bundle)?;
    finish(&bundle);
    Ok(())
}

#[cfg(target_os = "macos")]
fn move_bundle_to_trash(bundle: &str) -> Result<(), String> {
    let trash_result = try_trash_via_nsfilemanager(bundle).or_else(|e| {
        log::warn!(
            "uninstall_self_macos: NSFileManager.trashItemAtURL failed ({e}); trying Finder for {bundle}"
        );
        let output = Command::new("/usr/bin/osascript")
            .args([
                "-e",
                "on run argv",
                "-e",
                r#"tell application "Finder" to delete POSIX file (item 1 of argv)"#,
                "-e",
                "end run",
                bundle,
            ])
            .output()
            .map_err(|e| format!("could not ask Finder to move the app to Trash: {e}"))?;
        if !output.status.success() {
            let error = String::from_utf8_lossy(&output.stderr);
            let error = error.trim();
            log::warn!("uninstall_self_macos: Finder could not move {bundle} to Trash: {error}");
            return Err(format!("Finder could not move the app to Trash: {error}"));
        }
        Ok(())
    });

    match std::fs::symlink_metadata(bundle) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            log::info!("uninstall_self_macos: bundle moved to Trash: {bundle}");
            Ok(())
        }
        Err(e) => Err(format!("could not verify that the app moved to Trash: {e}")),
        Ok(_) => trash_result.and(Err("the app bundle is still at its original path".into())),
    }
}

/// Move the bundle to `~/.Trash/` using `NSFileManager.trashItemAtURL:`,
/// the same API Finder uses internally. No subprocess, no AppleScript,
/// no Automation TCC prompt. Returns the underlying `NSError`'s
/// `localizedDescription` on failure so it can be logged for
/// diagnostics.
#[cfg(target_os = "macos")]
fn try_trash_via_nsfilemanager(bundle: &str) -> Result<(), String> {
    use objc2_foundation::{NSFileManager, NSString, NSURL};

    let manager = NSFileManager::defaultManager();
    let path_ns = NSString::from_str(bundle);
    // `isDirectory: true` because a `.app` bundle is a directory; the
    // flag lets NSURL skip a stat() to figure that out.
    let url = NSURL::fileURLWithPath_isDirectory(&path_ns, true);

    match manager.trashItemAtURL_resultingItemURL_error(&url, None) {
        Ok(()) => Ok(()),
        Err(err) => Err(err.localizedDescription().to_string()),
    }
}

/// Require the main executable's bundle layout.
#[cfg(target_os = "macos")]
fn app_bundle_from_exe(exe: &std::path::Path) -> Option<&std::path::Path> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    (macos.file_name()? == "MacOS"
        && contents.file_name()? == "Contents"
        && bundle.extension()? == "app")
        .then_some(bundle)
}

/// Remove stale user LaunchAgents from Fristed / ReDD Block / older
/// ReDD Blocker builds. Idempotent — silently ignores missing files
/// or dirs. We don't trust any one filename pattern because
/// `tauri-plugin-autostart`'s plist naming has shifted between
/// versions (e.g. `Fristed.plist` vs `redd-block.plist`).
///
/// Legacy plists only — safe to call at startup. The uninstall path
/// uses [`scrub_all_autostart_plists`], which also removes the current
/// bundle's plist.
#[cfg(target_os = "macos")]
// Called from the release-only autostart bootstrap in lib.rs, so it reads as
// dead in a debug build.
#[allow(dead_code)]
pub(crate) fn scrub_stale_autostart_plists() {
    scrub_autostart_plists(false);
}

/// Uninstall-only: also removes the CURRENT bundle's LaunchAgent.
/// Never call at startup — see `should_scrub_autostart_plist`.
#[cfg(target_os = "macos")]
pub(crate) fn scrub_all_autostart_plists() {
    scrub_autostart_plists(true);
}

#[cfg(target_os = "macos")]
fn scrub_autostart_plists(include_current: bool) {
    use std::fs;
    use std::io::Read;

    let Some(home) = dirs::home_dir() else {
        return;
    };
    let dir = home.join("Library/LaunchAgents");
    let Ok(rd) = fs::read_dir(&dir) else {
        return;
    };
    let uid = unsafe { libc::getuid() };
    let domain = format!("gui/{uid}");

    for entry in rd.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("plist") {
            continue;
        }
        let Some(filename) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let mut content = String::new();
        if let Ok(mut f) = fs::File::open(&path) {
            let _ = f.read_to_string(&mut content);
        }
        if !should_scrub_autostart_plist(filename, &content, include_current) {
            continue;
        }
        log::info!(
            "scrub_autostart_plists(include_current={include_current}): bootout + remove {}",
            path.display()
        );
        let _ = Command::new("launchctl")
            .args(["bootout", &domain, &path.to_string_lossy()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let _ = fs::remove_file(&path);
    }
}

#[cfg(target_os = "macos")]
fn should_scrub_autostart_plist(filename: &str, content: &str, include_current: bool) -> bool {
    let lower = filename.to_ascii_lowercase();
    if lower.contains("reddblock") || lower.contains("redd-block") {
        return true;
    }
    // Fristed-era autostart used the product name verbatim as the
    // LaunchAgent filename/label — avoid a broad *fristed* substring
    // match that could catch unrelated plists.
    if lower == "fristed.plist" {
        return true;
    }
    if content.contains("/Applications/Fristed.app")
        || content.contains("/Applications/ReDD Block.app")
        || content.contains("/Applications/ReDD Blocker.app")
    {
        return true;
    }
    // The CURRENT bundle's plist may only be scrubbed on uninstall
    // (include_current). The startup self-heal must never match it:
    // when the app was launched at login *by* that plist, `launchctl
    // bootout` on it terminates the running job — i.e. the app kills
    // itself mid-startup and launch-at-login silently stops working.
    include_current
        && content.contains(&format!(
            "/Applications/{}.app",
            crate::product_identity::PRODUCT_DIR_NAME
        ))
}

#[cfg(all(target_os = "macos", test))]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn bundle_path_requires_the_main_executable_layout() {
        assert_eq!(
            app_bundle_from_exe(Path::new(
                "/Applications/Blocker.app/Contents/MacOS/redd-block"
            )),
            Some(Path::new("/Applications/Blocker.app"))
        );
        assert!(app_bundle_from_exe(Path::new("/checkout.app/target/debug/redd-block")).is_none());
    }

    #[test]
    fn no_bundle_means_no_legacy_cleanup() {
        let result = uninstall_bundle(
            None,
            || panic!("legacy cleanup ran"),
            |_| panic!(),
            |_| panic!(),
        );
        assert_eq!(result.unwrap_err(), "could not resolve app bundle path");
    }

    #[test]
    fn app_bundle_is_retained_when_legacy_cleanup_fails() {
        let result = uninstall_bundle(
            Some("/Blocker.app".into()),
            || Err("cancelled".into()),
            |_| panic!("bundle removal ran"),
            |_| panic!("setup cleanup ran"),
        );
        assert_eq!(result.unwrap_err(), "cancelled");
    }

    #[test]
    fn failed_trash_aborts_before_uninstall_can_commit() {
        let result = uninstall_bundle(
            Some("/Blocker.app".into()),
            || Ok(()),
            |bundle| {
                assert_eq!(bundle, "/Blocker.app");
                Err("Trash denied".into())
            },
            |_| panic!("setup cleanup ran"),
        );
        assert_eq!(result.unwrap_err(), "Trash denied");
    }

    #[test]
    fn finishing_uninstall_receives_the_trashed_bundle_path() {
        let trashed = std::cell::Cell::new(false);
        uninstall_bundle(
            Some("/Blocker.app".into()),
            || Ok(()),
            |_| {
                trashed.set(true);
                Ok(())
            },
            |bundle| {
                assert!(trashed.get());
                assert_eq!(bundle, "/Blocker.app");
            },
        )
        .unwrap();
    }
}
