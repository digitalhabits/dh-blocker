//! Download a GitHub release installer and open it in the system installer UI.

#![allow(deprecated)]
// The macOS FFI in this module goes through the `cocoa` crate, whose entire
// surface is deprecated in favour of `objc2`. That migration is real work and
// unrelated to what this module does; scoping the allow here keeps the
// `-D warnings` clippy gate meaningful for every other lint.

use std::future::Future;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::Deserialize;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;

const GITHUB_RELEASES: &str = "https://github.com/digitalhabits/dh-blocker/releases/download";
const GITHUB_RELEASES_API: &str =
    "https://api.github.com/repos/digitalhabits/dh-blocker/releases/tags";
const LATEST_VERSIONS_URL: &str = "https://digitalhabits.github.io/dh-blocker/latest-versions.json";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateDownloadProgress {
    bytes_received: u64,
    total_bytes: Option<u64>,
    percent: Option<u8>,
}

#[derive(Debug, Deserialize)]
struct LatestVersionsManifest {
    macos: Option<serde_json::Value>,
    windows: Option<serde_json::Value>,
    sha256: Option<ManifestChecksums>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestChecksums {
    macos_pkg: Option<String>,
    windows_x64_setup: Option<String>,
    windows_arm64_setup: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    assets: Vec<GitHubReleaseAsset>,
}

#[derive(Debug, Deserialize)]
struct GitHubReleaseAsset {
    name: String,
    digest: Option<String>,
}

#[derive(Clone, Copy)]
enum Installer {
    MacosPkg,
    WindowsX64Setup,
    WindowsArm64Setup,
}

impl Installer {
    fn for_target() -> Result<Self, String> {
        match (std::env::consts::OS, std::env::consts::ARCH) {
            ("macos", _) => Ok(Self::MacosPkg),
            ("windows", "aarch64") => Ok(Self::WindowsArm64Setup),
            ("windows", _) => Ok(Self::WindowsX64Setup),
            _ => Err("in-app update download is not supported on this platform".into()),
        }
    }

    fn filename(self, version: &str) -> String {
        match self {
            Self::MacosPkg => format!("Digital-Habits-Blocker-{version}.pkg"),
            Self::WindowsX64Setup => format!("Digital-Habits-Blocker_{version}_x64-setup.exe"),
            Self::WindowsArm64Setup => format!("Digital-Habits-Blocker_{version}_arm64-setup.exe"),
        }
    }
}

fn validate_version(version: &str) -> Result<&str, String> {
    let version = version.trim();
    let version = version.strip_prefix(['v', 'V']).unwrap_or(version);
    let mut parts = version.splitn(3, '.');
    if parts.clone().count() == 3
        && parts.all(|part| {
            part.bytes().all(|byte| byte.is_ascii_digit())
                && (part == "0" || !part.starts_with('0'))
                && part.parse::<u64>().is_ok()
        })
    {
        Ok(version)
    } else {
        Err("Invalid update version — expected a stable major.minor.patch release".into())
    }
}

fn platform_version_from_manifest(value: &serde_json::Value) -> Option<&str> {
    match value {
        serde_json::Value::String(version) => Some(version.as_str()),
        serde_json::Value::Object(map) => map.get("version").and_then(serde_json::Value::as_str),
        _ => None,
    }
    .and_then(|version| validate_version(version).ok())
}

fn validate_sha256(hash: &str) -> Result<&str, String> {
    let hash = hash.trim();
    if hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(hash)
    } else {
        Err("Update installer checksum was invalid".into())
    }
}

fn manifest_checksum<'a>(
    manifest: &'a LatestVersionsManifest,
    installer: Installer,
    version: &str,
) -> Result<Option<&'a str>, String> {
    let (platform, platform_version) = match installer {
        Installer::MacosPkg => ("macOS", manifest.macos.as_ref()),
        Installer::WindowsX64Setup | Installer::WindowsArm64Setup => {
            ("Windows", manifest.windows.as_ref())
        }
    };

    let manifest_version = platform_version
        .and_then(platform_version_from_manifest)
        .ok_or_else(|| format!("Update manifest has no valid {platform} version"))?;
    if manifest_version != version {
        return Err(format!(
            "Update manifest version mismatch (manifest {manifest_version}, requested {version})"
        ));
    }

    let checksum = manifest
        .sha256
        .as_ref()
        .and_then(|checksums| match installer {
            Installer::MacosPkg => checksums.macos_pkg.as_deref(),
            Installer::WindowsX64Setup => checksums.windows_x64_setup.as_deref(),
            Installer::WindowsArm64Setup => checksums.windows_arm64_setup.as_deref(),
        });
    if checksum.is_none() && matches!(installer, Installer::MacosPkg) {
        return Err(
            "Update manifest is missing the macOS installer checksum — try again later".into(),
        );
    }
    checksum.map(validate_sha256).transpose()
}

fn github_release_checksum<'a>(
    release: &'a GitHubRelease,
    tag: &str,
    filename: &str,
) -> Result<&'a str, String> {
    if release.tag_name != tag {
        return Err("GitHub returned metadata for a different update release".into());
    }

    let checksum = release
        .assets
        .iter()
        .find(|asset| asset.name == filename)
        .and_then(|asset| asset.digest.as_deref())
        .and_then(|digest| digest.strip_prefix("sha256:"))
        .ok_or_else(|| "GitHub has no SHA-256 for this Windows installer".to_string())?;
    validate_sha256(checksum)
}

async fn fetch_expected_sha256(
    client: &reqwest::Client,
    installer: Installer,
    version: &str,
    tag: &str,
    filename: &str,
) -> Result<String, String> {
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

    if let Some(checksum) = manifest_checksum(&manifest, installer, version)? {
        return Ok(checksum.to_owned());
    }

    // Older manifests contain the Windows version without installer hashes.
    // GitHub's digest for the exact tagged asset keeps those releases verifiable.
    let release: GitHubRelease = client
        .get(format!("{GITHUB_RELEASES_API}/{tag}"))
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("Could not fetch Windows installer metadata: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Windows installer metadata unavailable: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Windows installer metadata was invalid: {e}"))?;
    Ok(github_release_checksum(&release, tag, filename)?.to_owned())
}

async fn download_file(
    client: &reqwest::Client,
    app: &AppHandle,
    url: &str,
    mut file: tokio::fs::File,
) -> Result<(), String> {
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

async fn file_matches_sha256(path: &Path, expected: &str) -> Result<bool, String> {
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
    Ok(actual.eq_ignore_ascii_case(expected))
}

#[cfg(target_os = "windows")]
fn cache_entry_is_link(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    use windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;

    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0
}

#[cfg(not(target_os = "windows"))]
fn cache_entry_is_link(metadata: &std::fs::Metadata) -> bool {
    metadata.is_symlink()
}

fn create_private_cache_directory(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    let created = {
        use std::os::unix::fs::DirBuilderExt;

        std::fs::DirBuilder::new().mode(0o700).create(path)
    };
    // The Windows cache is under the account's LocalAppData and inherits its
    // access control from that directory.
    #[cfg(not(unix))]
    let created = std::fs::create_dir(path);
    if let Err(error) = created {
        if error.kind() != ErrorKind::AlreadyExists {
            return Err(format!("Could not create the installer cache: {error}"));
        }
    }

    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("Could not inspect the installer cache: {error}"))?;
    if !metadata.is_dir() || cache_entry_is_link(&metadata) {
        return Err("Installer cache must be a directory without redirection".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;

        if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 {
            return Err("Installer cache must be private to the current user".into());
        }
    }
    Ok(())
}

enum CachedInstaller {
    Missing,
    Verified,
    Corrupt,
}

async fn inspect_cached_installer(path: &Path, expected: &str) -> Result<CachedInstaller, String> {
    let metadata = match tokio::fs::symlink_metadata(path).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(CachedInstaller::Missing),
        Err(error) => return Err(format!("Could not inspect the cached installer: {error}")),
    };
    if !metadata.is_file() || cache_entry_is_link(&metadata) {
        return Err("Cached installer must be a regular file".into());
    }
    if file_matches_sha256(path, expected).await? {
        Ok(CachedInstaller::Verified)
    } else {
        Ok(CachedInstaller::Corrupt)
    }
}

async fn cache_installer<F>(
    cache_root: &Path,
    filename: &str,
    expected: &str,
    download: impl FnOnce(tokio::fs::File) -> F,
) -> Result<PathBuf, String>
where
    F: Future<Output = Result<(), String>>,
{
    let digest = validate_sha256(expected)?.to_ascii_lowercase();
    create_private_cache_directory(cache_root)?;
    let directory = cache_root.join(&digest);
    create_private_cache_directory(&directory)?;
    let mut destination = directory.join(filename);
    let mut repair_number = 0_u64;
    loop {
        match inspect_cached_installer(&destination, &digest).await? {
            CachedInstaller::Missing => break,
            CachedInstaller::Verified => return Ok(destination),
            CachedInstaller::Corrupt => {
                // An existing installer may still have this path open. Publish
                // the replacement in a stable slot shared by concurrent retries.
                repair_number += 1;
                let repair_directory = directory.join(format!("repair-{repair_number}"));
                create_private_cache_directory(&repair_directory)?;
                destination = repair_directory.join(filename);
            }
        }
    }

    // Each in-flight download owns its staging file. Publish verified bytes
    // once per digest without replacing any file an installer could be using.
    let (file, staging) = tempfile::Builder::new()
        .prefix("download-")
        .tempfile_in(&directory)
        .map_err(|error| format!("Could not stage the installer: {error}"))?
        .into_parts();
    download(tokio::fs::File::from_std(file)).await?;
    if !file_matches_sha256(&staging, &digest).await? {
        return Err(
            "Download failed verification — the installer file may be corrupted or tampered with"
                .into(),
        );
    }
    if let Err(error) = staging.persist_noclobber(&destination) {
        // A concurrent download may have published the same installer first.
        if !matches!(
            inspect_cached_installer(&destination, &digest).await?,
            CachedInstaller::Verified
        ) {
            return Err(format!("Could not publish the installer: {}", error.error));
        }
    }
    Ok(destination)
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

#[tauri::command]
pub async fn download_and_run_update(app: AppHandle, version: String) -> Result<(), String> {
    let version = validate_version(&version)?;
    let installer = Installer::for_target()?;
    let tag = format!("v{version}");
    let filename = installer.filename(version);
    let client = reqwest::Client::builder()
        .user_agent(format!("ReDD-Blocker/{}", env!("CARGO_PKG_VERSION")))
        .https_only(true)
        .build()
        .map_err(|e| format!("update client: {e}"))?;
    let expected_sha256 =
        fetch_expected_sha256(&client, installer, version, &tag, &filename).await?;

    let user_cache = app
        .path()
        .cache_dir()
        .map_err(|error| format!("Could not locate the user's installer cache: {error}"))?;
    tokio::fs::create_dir_all(&user_cache)
        .await
        .map_err(|error| format!("Could not open the user's installer cache: {error}"))?;
    let cache_root = user_cache.join(format!("{}.update-installers", app.config().identifier));
    let url = format!("{GITHUB_RELEASES}/{tag}/{filename}");
    let dest = cache_installer(&cache_root, &filename, &expected_sha256, |file| async {
        log::info!("update: downloading {url}");
        download_file(&client, &app, &url, file).await
    })
    .await?;
    log::info!("update: installer checksum verified");

    launch_installer(&app, &dest)?;

    log::info!("update: opened installer at {}", dest.display());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const X64_SHA256: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const ARM64_SHA256: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const FIXTURE_INSTALLER: &[u8] = b"signed installer";
    const FIXTURE_SHA256: &str = "be2ce2dd28b0293e480f9d7443bc99b442ae06348b010a6f8043c667b15d4a5a";

    #[test]
    fn validates_the_release_version_before_it_becomes_a_path_component() {
        assert_eq!(validate_version(" \tv3.13.0\n"), Ok("3.13.0"));
        assert_eq!(validate_version("0.1.0"), Ok("0.1.0"));
        for version in [
            "",
            "3.13",
            "3.013.0",
            "3.13.0.1",
            "3.13.0-rc.1",
            "3.13.0+build",
            "3.13.0/../file",
            "3.13.0\\file",
            "3.13.0%2f",
            "3.13.0?query",
            "3.13.0#fragment",
        ] {
            assert!(validate_version(version).is_err(), "{version:?}");
        }
    }

    #[test]
    fn selects_the_windows_checksum_for_the_exact_architecture_and_version() {
        let manifest: LatestVersionsManifest = serde_json::from_value(serde_json::json!({
            "windows": { "version": "v3.13.0" },
            "sha256": { "windowsX64Setup": X64_SHA256, "windowsArm64Setup": ARM64_SHA256 }
        }))
        .unwrap();
        let x64 = Installer::WindowsX64Setup;
        let arm64 = Installer::WindowsArm64Setup;
        assert_eq!(
            x64.filename("3.13.0"),
            "Digital-Habits-Blocker_3.13.0_x64-setup.exe"
        );
        assert_eq!(
            arm64.filename("3.13.0"),
            "Digital-Habits-Blocker_3.13.0_arm64-setup.exe"
        );
        assert_eq!(
            manifest_checksum(&manifest, x64, "3.13.0"),
            Ok(Some(X64_SHA256))
        );
        assert_eq!(
            manifest_checksum(&manifest, arm64, "3.13.0"),
            Ok(Some(ARM64_SHA256))
        );
        assert!(manifest_checksum(&manifest, x64, "3.13.1").is_err());
    }

    #[test]
    fn only_a_missing_windows_checksum_uses_release_metadata() {
        let legacy: LatestVersionsManifest = serde_json::from_str(
            r#"{"macos":"3.13.0", "windows":"3.13.0", "sha256":{"macosPkg":null}}"#,
        )
        .unwrap();
        let invalid: LatestVersionsManifest =
            serde_json::from_str(r#"{"windows":"3.13.0", "sha256":{"windowsX64Setup":"invalid"}}"#)
                .unwrap();
        let x64 = Installer::WindowsX64Setup;
        assert_eq!(manifest_checksum(&legacy, x64, "3.13.0"), Ok(None));
        assert!(manifest_checksum(&legacy, x64, "3.13.1").is_err());
        assert!(manifest_checksum(&legacy, Installer::MacosPkg, "3.13.0").is_err());
        assert!(manifest_checksum(&invalid, x64, "3.13.0").is_err());
    }

    #[test]
    fn release_metadata_requires_the_exact_tag_asset_and_sha256() {
        let tag = "v3.13.0";
        let x64 = Installer::WindowsX64Setup.filename("3.13.0");
        let arm64 = Installer::WindowsArm64Setup.filename("3.13.0");
        let mut release: GitHubRelease = serde_json::from_value(serde_json::json!({
            "tag_name": tag,
            "assets": [
                { "name": &arm64, "digest": format!("sha256:{ARM64_SHA256}") },
                { "name": &x64, "digest": format!("sha256:{X64_SHA256}") },
            ]
        }))
        .unwrap();
        assert_eq!(github_release_checksum(&release, tag, &x64), Ok(X64_SHA256));
        assert!(github_release_checksum(&release, "v3.13.1", &x64).is_err());
        assert!(github_release_checksum(&release, tag, "other.exe").is_err());
        for digest in [Some("sha1:abcd".into()), Some("sha256:abcd".into()), None] {
            release.assets[1].digest = digest;
            assert!(github_release_checksum(&release, tag, &x64).is_err());
        }
    }

    #[test]
    fn verifies_installer_bytes_and_rejects_a_changed_file() {
        let staging = tempfile::tempdir().unwrap();
        let file = staging.path().join("installer.exe");
        std::fs::write(&file, FIXTURE_INSTALLER).unwrap();
        assert_eq!(
            tauri::async_runtime::block_on(file_matches_sha256(&file, FIXTURE_SHA256)),
            Ok(true)
        );
        std::fs::write(&file, b"changed installer").unwrap();
        assert_eq!(
            tauri::async_runtime::block_on(file_matches_sha256(&file, FIXTURE_SHA256)),
            Ok(false)
        );
    }

    async fn write_fixture(mut file: tokio::fs::File, bytes: &[u8]) -> Result<(), String> {
        file.write_all(bytes).await.unwrap();
        file.flush().await.unwrap();
        Ok(())
    }

    #[test]
    fn concurrent_downloads_and_retries_reuse_one_verified_installer() {
        let staging = tempfile::tempdir().unwrap();
        let cache = staging.path().join("cache");
        tauri::async_runtime::block_on(async {
            let both_downloading = tokio::sync::Barrier::new(2);
            let download = |file| {
                let barrier = &both_downloading;
                async move {
                    barrier.wait().await;
                    write_fixture(file, FIXTURE_INSTALLER).await
                }
            };
            let installer = "installer.exe";
            let first = cache_installer(&cache, installer, FIXTURE_SHA256, download);
            let second = cache_installer(&cache, installer, FIXTURE_SHA256, download);
            let (first, second) = tokio::time::timeout(
                Duration::from_secs(10),
                futures_util::future::join(first, second),
            )
            .await
            .unwrap();
            let dest = first.unwrap();
            assert_eq!(dest, second.unwrap());

            // The previous installer may still be reading its executable.
            let running = std::fs::File::open(&dest).unwrap();
            let retry = cache_installer(&cache, installer, FIXTURE_SHA256, |_| async {
                panic!("retry should reuse the verified installer")
            })
            .await
            .unwrap();
            assert_eq!(retry, dest);
            assert_eq!(std::fs::read(&dest).unwrap(), FIXTURE_INSTALLER);
            assert_eq!(
                std::fs::read_dir(dest.parent().unwrap()).unwrap().count(),
                1
            );
            drop(running);
        });
    }

    #[test]
    fn failed_download_leaves_no_installer_and_a_retry_repairs_corrupt_cache() {
        let staging = tempfile::tempdir().unwrap();
        let cache = staging.path().join("cache");
        tauri::async_runtime::block_on(async {
            let filename = "installer.exe";
            let result = cache_installer(&cache, filename, FIXTURE_SHA256, |file| {
                write_fixture(file, b"changed installer")
            })
            .await;
            assert!(result.is_err());
            let digest_dir = cache.join(FIXTURE_SHA256);
            assert_eq!(std::fs::read_dir(&digest_dir).unwrap().count(), 0);

            let corrupt = digest_dir.join(filename);
            std::fs::write(&corrupt, b"changed cached installer").unwrap();
            let running = std::fs::File::open(&corrupt).unwrap();
            let repaired = cache_installer(&cache, filename, FIXTURE_SHA256, |file| {
                write_fixture(file, FIXTURE_INSTALLER)
            })
            .await
            .unwrap();
            assert_ne!(repaired, corrupt);
            assert_eq!(std::fs::read(&repaired).unwrap(), FIXTURE_INSTALLER);
            assert_eq!(
                std::fs::read(&corrupt).unwrap(),
                b"changed cached installer"
            );
            drop(running);

            let retry = cache_installer(&cache, filename, FIXTURE_SHA256, |_| async {
                panic!("retry should reuse the repaired installer")
            })
            .await
            .unwrap();
            assert_eq!(retry, repaired);
        });
    }

    #[cfg(unix)]
    #[test]
    fn a_link_to_a_valid_installer_is_rejected_instead_of_repaired() {
        let staging = tempfile::tempdir().unwrap();
        let mirror = staging.path().join("outside-installer.exe");
        std::fs::write(&mirror, FIXTURE_INSTALLER).unwrap();
        let cache = staging.path().join("cache");
        create_private_cache_directory(&cache).unwrap();
        let directory = cache.join(FIXTURE_SHA256);
        create_private_cache_directory(&directory).unwrap();
        let filename = "installer.exe";
        std::os::unix::fs::symlink(&mirror, directory.join(filename)).unwrap();

        let result = tauri::async_runtime::block_on(cache_installer(
            &cache,
            filename,
            FIXTURE_SHA256,
            |_| async { panic!("a redirection must not trigger a repair download") },
        ));
        assert_eq!(
            result,
            Err("Cached installer must be a regular file".into())
        );
    }

    #[cfg(unix)]
    #[test]
    fn cache_directory_requires_private_permissions_and_refuses_links() {
        use std::os::unix::fs::{symlink, PermissionsExt};

        let staging = tempfile::tempdir().unwrap();
        let directory = staging.path().join("cache");
        create_private_cache_directory(&directory).unwrap();
        let mode = std::fs::metadata(&directory).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700);

        let link = staging.path().join("symlink");
        symlink(&directory, &link).unwrap();
        assert!(create_private_cache_directory(&link).is_err());

        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(create_private_cache_directory(&directory).is_err());
    }
}
