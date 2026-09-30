//! In-app updates.
//!
//! macOS first tries an in-place update through `tauri-plugin-updater`: it
//! downloads the release's minisign-signed `.app.tar.gz`, swaps the bundle and
//! relaunches. When that is unavailable (no updater key configured in this
//! build, no `macos-update.json` on the release, a failed install), it falls
//! back to downloading the release `.pkg` and opening it in Installer.app.
//! Windows always downloads the NSIS installer and runs it.

#![allow(deprecated)]
// The macOS FFI in this module goes through the `cocoa` crate, whose entire
// surface is deprecated in favour of `objc2`. That migration is real work and
// unrelated to what this module does; scoping the allow here keeps the
// `-D warnings` clippy gate meaningful for every other lint.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::Deserialize;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;

const GITHUB_RELEASES: &str = "https://github.com/digitalhabits/dh-blocker/releases/download";
/// Per-release updater manifest the release workflow attaches next to the
/// `.pkg` (see `scripts/stage-macos-updater.js`).
#[allow(dead_code)] // used on macOS; dead on Windows
const MACOS_UPDATE_MANIFEST: &str = "macos-update.json";
#[allow(dead_code)] // used on macOS; dead on Windows
const LATEST_VERSIONS_URL: &str = "https://digitalhabits.github.io/dh-blocker/latest-versions.json";

/// What `download_and_run_update` did, so the frontend knows whether to
/// expect an installer window or for this process to exit and reopen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdateOutcome {
    InstallerOpened,
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    Relaunching,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateDownloadProgress {
    bytes_received: u64,
    total_bytes: Option<u64>,
    percent: Option<u8>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)] // used on macOS; dead on Windows
struct LatestVersionsManifest {
    macos: Option<serde_json::Value>,
    sha256: Option<ManifestChecksums>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)] // used on macOS; dead on Windows
struct ManifestChecksums {
    #[serde(rename = "macosPkg")]
    macos_pkg: Option<String>,
}

fn normalize_version(version: &str) -> String {
    version.trim().trim_start_matches('v').trim().to_string()
}

#[allow(dead_code)] // used on macOS; dead on Windows
fn platform_version_from_manifest(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(version) => Some(normalize_version(version)),
        serde_json::Value::Object(map) => map
            .get("version")
            .and_then(|v| v.as_str())
            .map(normalize_version),
        _ => None,
    }
}

#[allow(dead_code)] // used on macOS; dead on Windows
async fn fetch_expected_macos_pkg_sha256(version: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .user_agent(format!("ReDD-Blocker/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("update manifest client: {e}"))?;

    let manifest: LatestVersionsManifest = client
        .get(LATEST_VERSIONS_URL)
        .send()
        .await
        .map_err(|e| format!("Could not fetch update manifest: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Update manifest unavailable: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Update manifest was invalid: {e}"))?;

    let manifest_version = manifest
        .macos
        .as_ref()
        .and_then(platform_version_from_manifest)
        .ok_or_else(|| "Update manifest is missing a macOS version".to_string())?;

    if manifest_version != version {
        return Err(format!(
            "Update manifest version mismatch (manifest {manifest_version}, requested {version})"
        ));
    }

    manifest
        .sha256
        .and_then(|checksums| checksums.macos_pkg)
        .map(|hash| hash.trim().to_lowercase())
        .filter(|hash| !hash.is_empty())
        .ok_or_else(|| {
            "Update manifest is missing the macOS installer checksum — try again later".to_string()
        })
}

/// The updater manifest is pinned to the release the frontend chose from
/// `latest-versions.json`, rather than a floating "latest" URL, so the
/// in-place path and the `.pkg` fallback always install the same version.
#[allow(dead_code)] // used on macOS; dead on Windows
fn macos_update_manifest_url(version: &str) -> String {
    format!(
        "{GITHUB_RELEASES}/v{}/{MACOS_UPDATE_MANIFEST}",
        normalize_version(version)
    )
}

/// `plugins.updater.pubkey` ships empty until the release signing key is set
/// up (see `docs/macos-in-place-updates.md`); an empty key means this build
/// cannot verify an update archive, so it must use the `.pkg`.
#[allow(dead_code)] // used on macOS; dead on Windows
fn updater_pubkey_configured(updater_config: Option<&serde_json::Value>) -> bool {
    updater_config
        .and_then(|c| c.get("pubkey"))
        .and_then(|k| k.as_str())
        .is_some_and(|k| !k.trim().is_empty())
}

/// `/Applications/X.app/Contents/MacOS/redd-block` → `/Applications/X.app`.
///
/// `None` for anything not running from inside an `.app` bundle — notably a
/// `cargo run` / `pnpm dev` binary in `target/debug/`. The updater would treat
/// that binary's parent directory as the thing to replace, so an unbundled
/// build must never take the in-place path.
#[allow(dead_code)] // used on macOS; dead on Windows
fn app_bundle_from_exe(exe: &Path) -> Option<PathBuf> {
    let macos_dir = exe.parent()?;
    let contents = macos_dir.parent()?;
    let bundle = contents.parent()?;
    let is_bundle = macos_dir.file_name()? == "MacOS"
        && contents.file_name()? == "Contents"
        && bundle.extension()? == "app";
    is_bundle.then(|| bundle.to_path_buf())
}

#[allow(clippy::needless_return)] // cfg dispatch: the return is load-bearing on the other platform
fn release_asset(version: &str) -> Result<(String, String), String> {
    let version = normalize_version(version);
    if version.is_empty() {
        return Err("missing version".into());
    }
    let tag = format!("v{version}");

    #[cfg(target_os = "macos")]
    {
        let filename = format!("Digital-Habits-Blocker-{version}.pkg");
        let url = format!("{GITHUB_RELEASES}/{tag}/{filename}");
        Ok((url, filename))
    }

    #[cfg(target_os = "windows")]
    {
        let arch = match std::env::consts::ARCH {
            "aarch64" => "arm64",
            _ => "x64",
        };
        let filename = format!("Digital-Habits-Blocker_{version}_{arch}-setup.exe");
        let url = format!("{GITHUB_RELEASES}/{tag}/{filename}");
        return Ok((url, filename));
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = tag;
        Err("in-app update download is not supported on this platform".into())
    }
}

fn installer_dest_path(filename: &str) -> PathBuf {
    std::env::temp_dir().join(filename)
}

async fn download_file(app: &AppHandle, url: &str, dest: &Path) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .user_agent(format!("ReDD-Blocker/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("download client: {e}"))?;

    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Could not reach GitHub: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Download failed (HTTP {})",
            response.status().as_u16()
        ));
    }

    let total_bytes = response.content_length();
    let mut file = tokio::fs::File::create(dest)
        .await
        .map_err(|e| format!("Could not write installer to disk: {e}"))?;

    let mut stream = response.bytes_stream();
    let mut bytes_received: u64 = 0;
    let mut last_emit = Instant::now();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Download interrupted: {e}"))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("Could not save installer: {e}"))?;
        bytes_received += chunk.len() as u64;

        if last_emit.elapsed() >= Duration::from_millis(200) {
            emit_progress(app, bytes_received, total_bytes);
            last_emit = Instant::now();
        }
    }

    file.flush()
        .await
        .map_err(|e| format!("Could not finish saving installer: {e}"))?;
    emit_progress(app, bytes_received, total_bytes);
    Ok(())
}

#[allow(dead_code)] // used on macOS; dead on Windows
async fn verify_file_sha256(path: &Path, expected: &str) -> Result<(), String> {
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|e| format!("Could not read downloaded installer: {e}"))?;

    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 8192];

    loop {
        let read = file
            .read(&mut buffer)
            .await
            .map_err(|e| format!("Could not verify installer: {e}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }

    let actual = format!("{:x}", hasher.finalize());
    if actual.eq_ignore_ascii_case(expected.trim()) {
        Ok(())
    } else {
        Err(
            "Download failed verification — the installer file may be corrupted or tampered with"
                .into(),
        )
    }
}

fn emit_progress(app: &AppHandle, bytes_received: u64, total_bytes: Option<u64>) {
    let percent = total_bytes.map(|total| {
        bytes_received
            .saturating_mul(100)
            .checked_div(total)
            .unwrap_or(0)
            .min(100) as u8
    });
    let _ = app.emit(
        "update-download-progress",
        UpdateDownloadProgress {
            bytes_received,
            total_bytes,
            percent,
        },
    );
}

/// Keep the Let's go warning UI on screen, but drop Floating / always-on-top
/// so the system installer can appear above it. Yield is recorded even if
/// the shell is not up yet — if Let's go appears mid-install, it stays
/// below Installer. When the installer exits (user cancelled), restore
/// always-on-top if the warning is still active.
///
/// Installer focus-stealing (`activate`) only runs while the Let's go shell
/// is visible. Without that shell, the installer behaves normally and can
/// sit behind other windows.
fn schedule_installer_zorder_handoff(
    app: &AppHandle,
    installer_alive: impl Fn() -> bool + Send + 'static,
    activate: impl Fn() + Send + 'static,
) {
    crate::commands::yield_blocking_warning_zorder_for_installer(app);
    let app = app.clone();
    std::thread::Builder::new()
        .name("installer-zorder-handoff".into())
        .spawn(move || {
            const APPEAR_TIMEOUT: Duration = Duration::from_secs(20);
            const MAX_WAIT: Duration = Duration::from_secs(60 * 30);
            const POLL: Duration = Duration::from_millis(400);
            // Only while Let's go is up — keeps Installer above the shell
            // without dominating focus when the shell is not showing.
            const REACTIVATE_EVERY: Duration = Duration::from_secs(3);

            let started = Instant::now();
            let mut saw_installer = false;
            let mut last_activate = Instant::now()
                .checked_sub(REACTIVATE_EVERY)
                .unwrap_or_else(Instant::now);

            loop {
                let alive = installer_alive();
                if alive {
                    saw_installer = true;
                    // Natural z-order when Let's go is down; only force-front
                    // while the full-screen warning shell would otherwise bury
                    // Installer behind Floating/always-on-top.
                    if crate::app_watcher::blocking_warning_shell_active() {
                        let force = crate::commands::take_installer_activate_request();
                        if force || last_activate.elapsed() >= REACTIVATE_EVERY {
                            activate();
                            last_activate = Instant::now();
                        }
                    }
                } else if saw_installer {
                    break;
                } else if started.elapsed() >= APPEAR_TIMEOUT {
                    log::warn!(
                        "update: installer UI did not appear within {:?}",
                        APPEAR_TIMEOUT
                    );
                    break;
                }

                if started.elapsed() >= MAX_WAIT {
                    log::warn!(
                        "update: giving up waiting for installer exit after {:?}",
                        MAX_WAIT
                    );
                    break;
                }
                std::thread::sleep(POLL);
            }

            crate::commands::restore_blocking_warning_zorder_after_installer(&app);
        })
        .ok();
}

#[cfg(target_os = "macos")]
fn macos_installer_app_running() -> bool {
    use cocoa::base::{id, nil};
    use cocoa::foundation::NSString;
    use objc::{class, msg_send, sel, sel_impl};

    unsafe {
        let bundle_id = NSString::alloc(nil).init_str("com.apple.installer");
        let apps: id = msg_send![
            class!(NSRunningApplication),
            runningApplicationsWithBundleIdentifier: bundle_id
        ];
        if apps == nil {
            return false;
        }
        let count: usize = msg_send![apps, count];
        count > 0
    }
}

#[cfg(target_os = "macos")]
fn activate_macos_installer_app() {
    use cocoa::base::{id, nil};
    use cocoa::foundation::NSString;
    use objc::{class, msg_send, sel, sel_impl};

    unsafe {
        let bundle_id = NSString::alloc(nil).init_str("com.apple.installer");
        let apps: id = msg_send![
            class!(NSRunningApplication),
            runningApplicationsWithBundleIdentifier: bundle_id
        ];
        if apps == nil {
            return;
        }
        let count: usize = msg_send![apps, count];
        if count == 0 {
            return;
        }
        let app: id = msg_send![apps, objectAtIndex: 0usize];
        // NSApplicationActivateAllWindows | NSApplicationActivateIgnoringOtherApps
        let options: u64 = 1 | 2;
        let _: cocoa::base::BOOL = msg_send![app, activateWithOptions: options];
    }
}

#[cfg(target_os = "macos")]
fn launch_installer(app: &AppHandle, path: &Path) -> Result<(), String> {
    if let Some(path_str) = path.to_str() {
        let _ = std::process::Command::new("/usr/bin/xattr")
            .args(["-d", "com.apple.quarantine", path_str])
            .output();
    }

    let status = std::process::Command::new("/usr/bin/open")
        .arg(path)
        .status()
        .map_err(|e| format!("Could not open installer: {e}"))?;

    if !status.success() {
        return Err("Could not open installer".into());
    }

    schedule_installer_zorder_handoff(
        app,
        macos_installer_app_running,
        activate_macos_installer_app,
    );
    Ok(())
}

#[cfg(target_os = "windows")]
fn process_is_alive(pid: u32) -> bool {
    use sysinfo::{Pid, ProcessesToUpdate, System};

    let pid = Pid::from_u32(pid);
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
    sys.process(pid).is_some()
}

/// Bring every visible top-level window for `pid` forward — including owned
/// dialogs such as NSIS's "app is running" MessageBox (which
/// [`crate::commands::activate_external_process_by_pid`] skips because they
/// have an owner).
#[cfg(target_os = "windows")]
fn foreground_all_visible_windows_for_pid(target_pid: u32) {
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::System::Threading::AttachThreadInput;
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetForegroundWindow, GetWindowThreadProcessId, IsIconic, IsWindowVisible,
        SetForegroundWindow, SetWindowPos, ShowWindow, HWND_TOP, SWP_NOACTIVATE, SWP_NOMOVE,
        SWP_NOSIZE, SWP_SHOWWINDOW, SW_RESTORE,
    };

    struct FindCtx {
        target_pid: u32,
        hwnds: Vec<HWND>,
    }

    unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let ctx = &mut *(lparam.0 as *mut FindCtx);
        if !IsWindowVisible(hwnd).as_bool() {
            return BOOL(1);
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == ctx.target_pid {
            ctx.hwnds.push(hwnd);
        }
        BOOL(1)
    }

    unsafe {
        let mut ctx = FindCtx {
            target_pid,
            hwnds: Vec::new(),
        };
        let ptr = (&mut ctx) as *mut FindCtx as isize;
        let _ = EnumWindows(Some(collect), LPARAM(ptr));

        let fg = GetForegroundWindow();
        let mut fg_tid = 0u32;
        if fg != HWND::default() {
            let mut _fg_pid = 0u32;
            fg_tid = GetWindowThreadProcessId(fg, Some(&mut _fg_pid));
        }

        for hwnd in ctx.hwnds {
            if IsIconic(hwnd).as_bool() {
                let _ = ShowWindow(hwnd, SW_RESTORE);
            }
            let flags = SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW | SWP_NOACTIVATE;
            let _ = SetWindowPos(hwnd, Some(HWND_TOP), 0, 0, 0, 0, flags);

            let mut _win_pid = 0u32;
            let tgt_tid = GetWindowThreadProcessId(hwnd, Some(&mut _win_pid));
            if fg_tid != 0 {
                let _ = AttachThreadInput(fg_tid, tgt_tid, true);
            }
            let _ = SetForegroundWindow(hwnd);
            if fg_tid != 0 {
                let _ = AttachThreadInput(fg_tid, tgt_tid, false);
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn launch_installer(app: &AppHandle, path: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;

    const DETACHED_PROCESS: u32 = 0x00000008;
    let child = std::process::Command::new(path)
        .creation_flags(DETACHED_PROCESS)
        .spawn()
        .map_err(|e| format!("Could not open installer: {e}"))?;
    let pid = child.id();
    // Detached process — dropping Child must not wait/kill it.
    drop(child);

    schedule_installer_zorder_handoff(
        app,
        move || process_is_alive(pid),
        move || {
            crate::commands::activate_external_process_by_pid(pid);
            foreground_all_visible_windows_for_pid(pid);
        },
    );
    Ok(())
}

/// Download the release's signed `.app.tar.gz` and swap it in place of the
/// running bundle. Returns the bundle path to relaunch.
///
/// Any error leaves the running bundle as it was (the plugin restores it if
/// the swap fails) and the caller falls back to the `.pkg`. When the bundle is
/// root-owned — every `.pkg` install is — the plugin asks for an administrator
/// password to do the swap.
#[cfg(target_os = "macos")]
async fn install_in_place(app: &AppHandle, version: &str) -> Result<PathBuf, String> {
    use tauri_plugin_updater::UpdaterExt;

    let exe = std::env::current_exe().map_err(|e| format!("current exe: {e}"))?;
    let bundle = app_bundle_from_exe(&exe)
        .ok_or_else(|| format!("not running from an .app bundle ({})", exe.display()))?;

    if !updater_pubkey_configured(app.config().plugins.0.get("updater")) {
        return Err("this build has no updater public key".into());
    }

    let endpoint: tauri::Url = macos_update_manifest_url(version)
        .parse()
        .map_err(|e| format!("update manifest url: {e}"))?;
    let updater = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|e| format!("updater endpoints: {e}"))?
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("updater: {e}"))?;

    let update = updater
        .check()
        .await
        .map_err(|e| format!("update check: {e}"))?
        .ok_or_else(|| format!("{version} is not newer than the running build"))?;
    if normalize_version(&update.version) != version {
        return Err(format!(
            "update manifest version mismatch (manifest {}, requested {version})",
            update.version
        ));
    }

    let mut bytes_received: u64 = 0;
    let mut last_emit = Instant::now();
    update
        .download_and_install(
            |chunk, total| {
                bytes_received += chunk as u64;
                if last_emit.elapsed() >= Duration::from_millis(200) {
                    emit_progress(app, bytes_received, total);
                    last_emit = Instant::now();
                }
            },
            || {},
        )
        .await
        .map_err(|e| format!("in-place install: {e}"))?;

    Ok(bundle)
}

/// Exit and reopen the freshly installed bundle.
///
/// This is the second deliberate exit path besides in-app uninstall (see the
/// note at the top of `lib.rs`): `std::process::exit` bypasses both quit
/// guards, and it is reachable only after a signature-verified update has
/// already replaced the bundle. `AppHandle::restart` cannot be used — it goes
/// through `ExitRequested`, which the guard cancels.
///
/// A detached `sh` waits for this PID to disappear before `open`ing the new
/// bundle; opening it any earlier would hand off to this still-running
/// instance through the single-instance plugin, and the new build would quit.
#[cfg(target_os = "macos")]
fn relaunch_after_update(bundle: &Path) -> Result<(), String> {
    const RELAUNCH: &str =
        r#"while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; exec /usr/bin/open "$2""#;

    std::process::Command::new("/bin/sh")
        .args(["-c", RELAUNCH, "sh"])
        .arg(std::process::id().to_string())
        .arg(bundle)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| {
            format!("The update was installed, but the app could not restart itself ({e}). Reopen Digital Habits: Blocker to finish.")
        })?;

    // Short delay so the IPC reply reaches the frontend first, as in
    // `uninstall_self_macos`.
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_millis(300));
        log::info!("update: exiting to relaunch the updated bundle");
        std::process::exit(0);
    });
    Ok(())
}

#[tauri::command]
pub async fn download_and_run_update(
    app: AppHandle,
    version: String,
) -> Result<UpdateOutcome, String> {
    let version = normalize_version(&version);

    #[cfg(target_os = "macos")]
    match install_in_place(&app, &version).await {
        Ok(bundle) => {
            log::info!(
                "update: installed {version} in place at {}",
                bundle.display()
            );
            relaunch_after_update(&bundle)?;
            return Ok(UpdateOutcome::Relaunching);
        }
        Err(e) => {
            log::warn!("update: in-place update unavailable, falling back to the .pkg: {e}");
        }
    }

    let (url, filename) = release_asset(&version)?;
    let dest = installer_dest_path(&filename);

    log::info!("update: downloading {url} -> {}", dest.display());

    if dest.exists() {
        if let Err(e) = tokio::fs::remove_file(&dest).await {
            log::warn!(
                "update: could not remove stale installer {}: {e}",
                dest.display()
            );
        }
    }

    download_file(&app, &url, &dest).await?;

    #[cfg(target_os = "macos")]
    {
        let expected_sha256 = fetch_expected_macos_pkg_sha256(&version).await?;
        verify_file_sha256(&dest, &expected_sha256).await?;
        log::info!("update: installer checksum verified");
    }

    launch_installer(&app, &dest)?;

    log::info!("update: opened installer at {}", dest.display());
    Ok(UpdateOutcome::InstallerOpened)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_url_is_pinned_to_the_requested_release() {
        assert_eq!(
            macos_update_manifest_url("v3.9.1 "),
            "https://github.com/digitalhabits/dh-blocker/releases/download/v3.9.1/macos-update.json"
        );
    }

    #[test]
    fn empty_or_missing_pubkey_is_not_configured() {
        assert!(!updater_pubkey_configured(None));
        assert!(!updater_pubkey_configured(Some(&serde_json::json!({}))));
        assert!(!updater_pubkey_configured(Some(
            &serde_json::json!({ "pubkey": "  " })
        )));
        assert!(updater_pubkey_configured(Some(
            &serde_json::json!({ "pubkey": "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWdu" })
        )));
    }

    #[test]
    fn bundle_is_found_only_inside_an_app() {
        assert_eq!(
            app_bundle_from_exe(Path::new(
                "/Applications/Digital Habits Blocker.app/Contents/MacOS/redd-block"
            )),
            Some(PathBuf::from("/Applications/Digital Habits Blocker.app"))
        );
        // `cargo run`: replacing the parent directory would delete target/debug.
        assert_eq!(
            app_bundle_from_exe(Path::new(
                "/src/dh-blocker/src-tauri/target/debug/redd-block"
            )),
            None
        );
        assert_eq!(
            app_bundle_from_exe(Path::new("/Applications/Foo/Contents/MacOS/redd-block")),
            None
        );
    }

    #[test]
    fn outcome_serialises_as_the_strings_the_frontend_checks() {
        assert_eq!(
            serde_json::to_string(&UpdateOutcome::Relaunching).unwrap(),
            r#""relaunching""#
        );
        assert_eq!(
            serde_json::to_string(&UpdateOutcome::InstallerOpened).unwrap(),
            r#""installerOpened""#
        );
    }
}
