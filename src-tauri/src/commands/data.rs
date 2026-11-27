use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
// Only `set_window_size` needs this, and that command is desktop-only.
#[cfg(not(target_os = "ios"))]
use tauri::WebviewWindow;
use tauri::{AppHandle, Manager};

/// App data structure - matches the Electron version exactly
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppData {
    pub blocklists: Vec<Blocklist>,
    pub active_blocks: Vec<ActiveBlock>,
    #[serde(default)]
    pub schedules: Vec<Schedule>,
    pub settings: Settings,
    #[serde(default)]
    pub start_overlays: Vec<NamedScheduleStartOverlay>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub migration_version: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Blocklist {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub websites: Vec<String>,
    #[serde(default)]
    pub apps: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub emoji: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub override_difficulty: Option<OverrideDifficulty>,
    #[serde(default = "default_true")]
    pub show_item_details: bool,
    #[serde(flatten)]
    pub extra: std::collections::HashMap<String, serde_json::Value>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverrideDifficulty {
    #[serde(rename = "type")]
    pub difficulty_type: String,
    #[serde(default)]
    pub count: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom_text: Option<String>,
    #[serde(flatten)]
    pub extra: std::collections::HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveBlock {
    pub id: String,
    pub blocklist_id: String,
    pub start_time: u64,
    pub end_time: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_paused: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pause_end_time: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_always_on: Option<bool>,
    #[serde(flatten)]
    pub extra: std::collections::HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleStartOverlay {
    #[serde(default)]
    pub custom: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lets_go_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_asset: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub voice_asset: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub heading: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NamedScheduleStartOverlay {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lets_go_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_asset: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub voice_asset: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub heading: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    pub id: String,
    pub blocklist_id: String,
    pub segments: Vec<ScheduleSegment>,
    pub repeat_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repeat_date: Option<String>,
    #[serde(default)]
    pub created_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_paused: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pause_end_time: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_overlay_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_overlay: Option<ScheduleStartOverlay>,
    #[serde(flatten)]
    pub extra: std::collections::HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleSegment {
    pub start_hour: u32,
    pub start_minute: u32,
    pub end_hour: u32,
    pub end_minute: u32,
    pub days: Vec<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default)]
    pub onboarding_complete: bool,
    #[serde(default)]
    pub eula_accepted_revision: Option<u32>,
    #[serde(default)]
    pub eula_accepted_at: Option<u64>,
    #[serde(flatten)]
    pub extra: std::collections::HashMap<String, serde_json::Value>,
}

/// Name of the data file in every location it has ever lived.
pub(crate) const DATA_FILE_NAME: &str = "redd-block-data.json";

/// Per-user directory name — the Tauri bundle identifier, so this
/// matches `app_data_dir()` for handle-free callers.
const APP_DIR_NAME: &str = "com.reddblock";

#[cfg(not(target_os = "ios"))]
const PRE_SHARED_IMPORT_BACKUP: &str = "redd-block-data.pre-shared-import.json";

fn get_per_user_data_path(app: &AppHandle) -> PathBuf {
    // `app_data_dir()` fails only when the platform dirs are unresolvable.
    // Falling back keeps a broken environment on the same file the
    // handle-free resolver picks, instead of panicking the command.
    app.path()
        .app_data_dir()
        .map(|dir| dir.join(DATA_FILE_NAME))
        .unwrap_or_else(|_| per_user_data_fallback())
}

/// Return the data file explicitly assigned to a local system-test process.
///
/// This override is intentionally feature-gated: a normal development or
/// production build must never be redirected by an ambient environment
/// variable. The runner supplies a path to an isolated temporary directory;
/// all data readers and writers use the same early-return hook below.
#[cfg(feature = "system-test")]
fn system_test_data_path() -> Option<PathBuf> {
    Some(
        std::env::var_os("REDD_BLOCK_SYSTEM_TEST_DATA_PATH")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            // Fail closed when somebody launches the test bundle outside the
            // runner: never fall through to production shared/per-user storage.
            .unwrap_or_else(|| {
                std::env::temp_dir()
                    .join(format!(
                        "redd-block-system-test-unconfigured-{}",
                        std::process::id()
                    ))
                    .join("redd-block-data.json")
            }),
    )
}

#[cfg(feature = "system-test")]
fn should_import_legacy_data() -> bool {
    system_test_data_path().is_none()
}

/// Apply the system-test override to a normal resolver fallback. Keeping this
/// as one helper is important: handle-based and static callers must not drift
/// into separate environment-variable/path-selection behavior.
///
/// iOS resolves its paths through the App Group store instead and never calls
/// this, so gate it out there rather than carry a dead-code warning.
#[cfg(not(target_os = "ios"))]
fn apply_system_test_override(fallback: impl FnOnce() -> PathBuf) -> PathBuf {
    #[cfg(feature = "system-test")]
    if let Some(path) = system_test_data_path() {
        return path;
    }

    fallback()
}

/// Machine-wide locations written by pre-3.x builds, newest first.
///
/// These are import *sources* only. Nothing writes to them any more: a
/// single file shared by every account on a PC meant one blocklist for
/// the whole family, edits that failed for whoever did not create the
/// file (`C:\ProgramData` lets any account add files to a subfolder but not
/// replace another account's, and a save is a rename over the existing
/// file), and every account able to read every other account's blocklist.
#[cfg(not(target_os = "ios"))]
fn legacy_shared_dirs() -> Vec<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let mut dirs = vec![crate::product_identity::windows_primary_shared_dir()];
        dirs.extend(crate::product_identity::windows_legacy_shared_dirs());
        dirs
    }
    #[cfg(not(target_os = "windows"))]
    {
        // The v1/v2 root helper's directory. Nothing has created it since
        // the helper was removed, so this only fires for v1.x upgraders.
        vec![PathBuf::from("/var/lib/redd-block")]
    }
}

/// Copy machine-wide data into this account's own store, taking the first
/// `shared_dirs` entry that has a data file. Returns whether it copied.
///
/// The destination wins if it is at least as recent. The pre-v3 per-user ->
/// shared migration copied without deleting, so an upgrading account can
/// hold a per-user file frozen at migration time beside the shared file it
/// has been editing ever since. Validate the source before replacing either
/// store and save the previous usable per-user bytes before installing it.
///
/// Never deletes the source: other accounts have not necessarily upgraded
/// yet, and each of them needs to import the same file.
#[cfg(not(target_os = "ios"))]
pub(crate) fn import_shared_data_into_per_user(
    dest: &std::path::Path,
    shared_dirs: &[PathBuf],
) -> Result<bool, String> {
    let modified = |path: &std::path::Path| {
        fs::metadata(path)
            .and_then(|m| m.modified())
            .unwrap_or(std::time::UNIX_EPOCH)
    };

    let Some(src) = shared_dirs
        .iter()
        .map(|dir| dir.join(DATA_FILE_NAME))
        .find(|candidate| candidate.is_file())
    else {
        return Ok(false);
    };

    let source_modified = modified(&src);
    let destination_is_current = || dest.exists() && modified(dest) >= source_modified;
    if destination_is_current() {
        return Ok(false);
    }

    let transaction =
        DataFileWrite::lock(dest).map_err(|e| format!("Could not lock {}: {e}", dest.display()))?;
    if destination_is_current() {
        return Ok(false);
    }
    let previous = match fs::read(dest) {
        Ok(bytes) => Some(bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("Could not read {}: {e}", dest.display())),
    };
    let previous_valid = previous
        .as_deref()
        .filter(|bytes| serde_json::from_slice::<AppData>(bytes).is_ok());
    let source = fs::read(&src)
        .map_err(|e| format!("Could not read {}: {e}", src.display()))
        .and_then(|bytes| {
            serde_json::from_slice::<AppData>(&bytes)
                .map_err(|e| format!("Invalid legacy data in {}: {e}", src.display()))?;
            Ok(bytes)
        });
    let contents = match source {
        Ok(bytes) => bytes,
        Err(e) if previous_valid.is_some() => {
            log::warn!("shared data import: keeping {}: {e}", dest.display());
            return Ok(false);
        }
        Err(e) => return Err(e),
    };

    // Keep the previous backup if we already have these exact bytes.
    if previous.as_deref() == Some(contents.as_slice()) {
        drop(transaction);
        if let Some(dest_dir) = dest.parent() {
            import_overlay_assets(dest_dir, shared_dirs);
        }
        return Ok(false);
    }

    if let Some(bytes) = previous_valid {
        let backup = dest.with_file_name(PRE_SHARED_IMPORT_BACKUP);
        write_data_file_atomic(&backup, bytes).map_err(|e| {
            format!(
                "Could not back up {} to {}: {e}",
                dest.display(),
                backup.display()
            )
        })?;
    }
    transaction.write(&contents).map_err(|e| {
        format!(
            "Could not copy {} to {}: {e}",
            src.display(),
            dest.display()
        )
    })?;

    drop(transaction);
    log::info!(
        "shared data import: copied {} -> {} (this account now has its own blocklist)",
        src.display(),
        dest.display()
    );
    if let Some(dest_dir) = dest.parent() {
        import_overlay_assets(dest_dir, shared_dirs);
    }
    Ok(true)
}

/// Schedule start-overlay media (pictures, voice clips) lives in
/// `overlay-assets/` beside the data file, which stores only relative paths
/// into it (`overlay_assets.rs` resolves the folder from `get_data_path`).
/// A data file imported without it references media that was left behind,
/// so the folder is merged in from every source — the pre-3.x rebrand
/// copy-forward moved only the data file, so a schedule's media can sit one
/// product name back from the file that references it. First source wins
/// per file, and nothing already at the destination is overwritten.
///
/// Failure falls toward a blank overlay, never a missing blocklist: the data
/// file is already in place by the time this runs, and a copy error is logged
/// and otherwise ignored.
#[cfg(not(target_os = "ios"))]
fn import_overlay_assets(dest_dir: &std::path::Path, shared_dirs: &[PathBuf]) {
    use super::overlay_assets::OVERLAY_ASSETS_DIR;
    let dest = dest_dir.join(OVERLAY_ASSETS_DIR);
    for src in shared_dirs.iter().map(|dir| dir.join(OVERLAY_ASSETS_DIR)) {
        if !src.is_dir() {
            continue;
        }
        match copy_dir_merge(&src, &dest) {
            Ok(()) => log::info!(
                "shared data import: merged overlay assets {} -> {}",
                src.display(),
                dest.display()
            ),
            Err(e) => log::warn!(
                "shared data import: overlay assets from {} incomplete: {e}",
                src.display()
            ),
        }
    }
}

/// Recursive copy that never replaces a file already present at `dest`.
#[cfg(not(target_os = "ios"))]
fn copy_dir_merge(src: &std::path::Path, dest: &std::path::Path) -> std::io::Result<()> {
    fs::create_dir_all(dest)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let target = dest.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_merge(&entry.path(), &target)?;
        } else if !target.exists() {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

/// Resolve the import before the first read of the per-user file, including
/// native enforcement reads. Remember failures so polling readers keep using
/// the canonical path without retrying migration on every tick. A new load
/// request can retry after the user fixes the error.
#[cfg(not(target_os = "ios"))]
fn import_shared_data_once(dest: &std::path::Path, retry_failed: bool) -> Result<(), String> {
    use std::sync::Mutex;
    static IMPORT: Mutex<Option<Result<(), String>>> = Mutex::new(None);
    let mut result = IMPORT.lock().unwrap();
    if retry_failed && matches!(*result, Some(Err(_))) {
        *result = None;
    }
    result
        .get_or_insert_with(|| {
            import_shared_data_into_per_user(dest, &import_sources())
                .map(|_| ())
                .inspect_err(|e| log::warn!("shared data import: {e}"))
        })
        .clone()
}

/// Unit tests only: what `import_sources` returns instead of the real
/// machine-wide directories. Without this, the resolver test ran the real
/// import and copied whatever ProgramData file the developer's machine
/// happened to have into their live per-user store.
#[cfg(all(test, not(target_os = "ios")))]
static TEST_IMPORT_SOURCES: std::sync::Mutex<Option<Vec<PathBuf>>> = std::sync::Mutex::new(None);

#[cfg(not(target_os = "ios"))]
fn import_sources() -> Vec<PathBuf> {
    #[cfg(test)]
    if let Some(dirs) = TEST_IMPORT_SOURCES.lock().unwrap().clone() {
        return dirs;
    }
    legacy_shared_dirs()
}

/// Resolve the canonical app-data path.
///
/// Always per-user, on every platform. macOS, Windows and iOS all treat
/// per-user application data as the native default, and nothing in the app
/// reads this file from another user's security context: every reader, the
/// browser-spawned native host included, runs inside the signed-in user's
/// own session.
///
/// Public accessor so other command modules can locate the canonical
/// redd-block-data.json without duplicating path selection logic.
pub fn canonical_data_path(app: &AppHandle) -> Option<PathBuf> {
    Some(get_data_path(app))
}

/// Same path selection as [`canonical_data_path`] but without an
/// [`AppHandle`]. Used by macOS startup gating (`cross_app_consent`)
/// before the frontend has loaded — must NOT scan legacy bundle-id
/// paths, only the canonical per-user location.
#[cfg(not(target_os = "ios"))]
pub fn canonical_data_path_static() -> PathBuf {
    apply_system_test_override(|| {
        let path = per_user_data_path_static();
        let _ = import_shared_data_once(&path, false);
        path
    })
}

/// Where the per-user file lives when `app_data_dir()` cannot be resolved.
/// Desktop falls back to the same handle-free resolver the native host uses,
/// so both still agree on one file. iOS has no handle-free equivalent — the
/// container path is only knowable through the app handle — so it falls back
/// inside the container instead. Unreachable in practice on iOS, where
/// `app_data_dir()` resolves from the sandbox itself.
#[cfg(not(target_os = "ios"))]
fn per_user_data_fallback() -> PathBuf {
    per_user_data_path_static()
}

#[cfg(target_os = "ios")]
fn per_user_data_fallback() -> PathBuf {
    std::env::temp_dir().join(DATA_FILE_NAME)
}

#[cfg(not(target_os = "ios"))]
fn per_user_data_path_static() -> PathBuf {
    per_user_data_path_from(dirs::data_dir(), dirs::home_dir())
}

/// Split out from [`per_user_data_path_static`] so the no-`data_dir`
/// fallback is testable. That branch used to hand back a macOS
/// `~/Library/Application Support` path on Windows and Linux too.
#[cfg(not(target_os = "ios"))]
fn per_user_data_path_from(data_dir: Option<PathBuf>, home: Option<PathBuf>) -> PathBuf {
    if let Some(dir) = data_dir {
        return dir.join(APP_DIR_NAME).join(DATA_FILE_NAME);
    }

    // Only reachable on a broken environment (no $HOME, no %APPDATA%).
    // Mirror each platform's own layout so the app and the native host
    // still agree on one file.
    #[cfg(target_os = "macos")]
    let relative = "Library/Application Support";
    #[cfg(target_os = "windows")]
    let relative = "AppData/Roaming";
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let relative = ".local/share";

    home.unwrap_or_default()
        .join(relative)
        .join(APP_DIR_NAME)
        .join(DATA_FILE_NAME)
}

pub(crate) fn get_data_path(app: &AppHandle) -> PathBuf {
    #[cfg(target_os = "ios")]
    {
        return get_per_user_data_path(app);
    }

    #[cfg(not(target_os = "ios"))]
    {
        apply_system_test_override(|| {
            let path = get_per_user_data_path(app);
            let _ = import_shared_data_once(&path, false);
            path
        })
    }
}

/// Hold this for a complete read-modify-write. The data file itself is
/// replaced on every write, so locking it would leave a stale inode locked.
/// The sidecar stays in place and the OS releases the lock on process exit.
pub(crate) struct DataFileWrite<'a> {
    path: &'a std::path::Path,
    #[cfg(not(target_os = "ios"))]
    _lock: fs::File,
}

impl<'a> DataFileWrite<'a> {
    pub(crate) fn lock(path: &'a std::path::Path) -> std::io::Result<Self> {
        #[cfg(not(target_os = "ios"))]
        {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)?;
            }
            let mut lock_path = path.as_os_str().to_owned();
            lock_path.push(".lock");
            let lock = fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(lock_path)?;
            lock_data_file(&lock)?;
            Ok(Self { path, _lock: lock })
        }
        #[cfg(target_os = "ios")]
        {
            Ok(Self { path })
        }
    }

    pub(crate) fn write(&self, contents: &[u8]) -> std::io::Result<()> {
        write_data_file_atomic(self.path, contents)
    }
}

#[cfg(all(unix, not(target_os = "ios")))]
fn lock_data_file(file: &fs::File) -> std::io::Result<()> {
    use std::os::fd::AsRawFd;

    loop {
        // SAFETY: the open File owns this descriptor for the whole call.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } == 0 {
            return Ok(());
        }
        let error = std::io::Error::last_os_error();
        if error.kind() != std::io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

#[cfg(target_os = "windows")]
fn lock_data_file(file: &fs::File) -> std::io::Result<()> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{LockFileEx, LOCKFILE_EXCLUSIVE_LOCK};
    use windows::Win32::System::IO::OVERLAPPED;

    // SAFETY: this is a live synchronous handle. LockFileEx waits for the
    // one-byte lock before returning, so it cannot outlive the offset.
    unsafe {
        LockFileEx(
            HANDLE(file.as_raw_handle()),
            LOCKFILE_EXCLUSIVE_LOCK,
            None,
            1,
            0,
            &mut OVERLAPPED::default(),
        )
    }
    .map_err(std::io::Error::other)
}

#[cfg(target_os = "windows")]
impl Drop for DataFileWrite<'_> {
    fn drop(&mut self) {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::Storage::FileSystem::UnlockFileEx;
        use windows::Win32::System::IO::OVERLAPPED;

        // SAFETY: unlock the same byte on the live handle before it closes.
        let _ = unsafe {
            UnlockFileEx(
                HANDLE(self._lock.as_raw_handle()),
                None,
                1,
                0,
                &mut OVERLAPPED::default(),
            )
        };
    }
}

/// Atomically replace the data file: write to a temp file in the same
/// directory, then rename over the destination.
///
/// The data file is the single source of truth for active blocking and
/// is re-read continuously by other threads and processes — the
/// Automation watcher (1 s tick), the browser-spawned native host (2 s
/// mtime poll), and the enforcer (5 s tick). A plain truncate-and-write
/// can be observed half-written; the readers then fail the JSON parse
/// and treat the blocklist as empty, momentarily dropping enforcement
/// (and un-parking tabs from the block page). rename() within one
/// directory is atomic on APFS and NTFS, so readers see either the old
/// or the new complete file, never a torn one.
pub(crate) fn write_data_file_atomic(
    path: &std::path::Path,
    contents: &[u8],
) -> std::io::Result<()> {
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};

    // Unique per process AND per call — concurrent Tauri commands may
    // save from different threads of the same process.
    static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("redd-block-data.json");
    let tmp = path.with_file_name(format!(
        ".{file_name}.tmp-{}-{}",
        std::process::id(),
        TMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));

    let result = (|| {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(contents)?;
        // Flush to disk before the rename so a crash can't leave the
        // canonical path pointing at a not-yet-persisted temp file.
        file.sync_all()?;
        drop(file);
        // No permission fixup: the file is per-user now, so the default
        // umask is what we want. The old 0666 made a user's blocklist
        // world-writable, which is exactly the sharing we removed.
        fs::rename(&tmp, path)
    })();

    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    } else {
        // Drop the shared parse cache so the enforcement loops re-read
        // this write even if it landed within the filesystem's
        // timestamp granularity (see data_cache.rs).
        #[cfg(not(target_os = "ios"))]
        crate::data_cache::invalidate(path);
    }
    result
}

/// Ensure the parent directory for the data file exists.
fn ensure_data_dir(path: &std::path::Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create data directory {:?}: {}", parent, e))?;
    }
    Ok(())
}

/// Get the app version
#[tauri::command]
pub fn get_app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

/// True when this process is running from a Microsoft Store (MSIX) package.
/// Store users receive updates via the Store, not digitalhabits.org installers.
#[tauri::command]
pub fn is_microsoft_store_package() -> bool {
    #[cfg(target_os = "windows")]
    {
        std::env::current_exe()
            .map(|p| crate::native_host_install::is_msix_packaged_exe_path(&p))
            .unwrap_or(false)
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

/// Check for data files from previous per-user locations (migration sources).
///
/// Returns the path to the most recently modified data file found in any of:
/// - Current per-user Tauri app data dir (the old default location)
/// - Legacy bundle identifier directories (com.redd.block, redd-block)
fn per_user_data_candidates(app: &AppHandle) -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    // Current Tauri app data dir (the old per-user location before shared migration)
    if let Ok(app_data_dir) = app.path().app_data_dir() {
        candidates.push(app_data_dir.join("redd-block-data.json"));
    }

    // Legacy bundle identifiers
    if let Some(app_support) = dirs::data_dir() {
        for id in &["com.redd.block", "redd-block"] {
            candidates.push(app_support.join(id).join("redd-block-data.json"));
        }
    }

    candidates.retain(|p| p.is_file());
    candidates
        .sort_by_cached_key(|p| std::cmp::Reverse(fs::metadata(p).and_then(|m| m.modified()).ok()));
    candidates
}

fn find_per_user_data(app: &AppHandle) -> Option<PathBuf> {
    per_user_data_candidates(app).into_iter().next()
}

fn normalize_eula_state(data: &mut AppData) -> bool {
    let mut changed = false;
    let settings = &mut data.settings;

    if settings.eula_accepted_revision.is_none() {
        let legacy_accepted = settings
            .extra
            .get("eulaAccepted")
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        if legacy_accepted {
            settings.eula_accepted_revision = Some(1);
            changed = true;
        }
    }

    if settings.eula_accepted_at.is_none() {
        if let Some(raw_accepted_at) = settings
            .extra
            .get("eulaAcceptedAt")
            .and_then(|value| value.as_u64())
        {
            settings.eula_accepted_at = Some(raw_accepted_at);
            changed = true;
        }
    }

    if settings.extra.remove("eulaAccepted").is_some() {
        changed = true;
    }
    if settings.extra.remove("eulaAcceptedAt").is_some() {
        changed = true;
    }
    if settings.extra.remove("eulaAcceptedRevision").is_some() {
        changed = true;
    }

    changed
}

/// Load data from file
#[tauri::command]
pub fn load_data(app: AppHandle) -> Result<AppData, String> {
    #[cfg(target_os = "ios")]
    let data_path = get_data_path(&app);
    #[cfg(not(target_os = "ios"))]
    let data_path = apply_system_test_override(|| get_per_user_data_path(&app));

    #[cfg(not(target_os = "ios"))]
    {
        #[cfg(feature = "system-test")]
        let import_legacy = should_import_legacy_data();
        #[cfg(not(feature = "system-test"))]
        let import_legacy = true;
        if import_legacy {
            import_shared_data_once(&data_path, true)?;
        }
    }

    ensure_data_dir(&data_path)?;

    let source = if data_path
        .try_exists()
        .map_err(|e| format!("Could not access {}: {e}", data_path.display()))?
    {
        Some(data_path.clone())
    } else {
        // An isolated system-test process must never read production data.
        #[cfg(feature = "system-test")]
        if !should_import_legacy_data() {
            return Ok(AppData::default());
        }
        find_per_user_data(&app)
    };
    let Some(source) = source else {
        return Ok(AppData::default());
    };

    let mut data = read_saved_data(&source)?;
    if !normalize_eula_state(&mut data) && source == data_path {
        return Ok(data);
    }

    // A migration must re-read after acquiring the lock. Another process
    // may have installed newer canonical data since we found the source.
    let transaction = DataFileWrite::lock(&data_path)
        .map_err(|e| format!("Could not lock {}: {e}", data_path.display()))?;
    let source = if data_path
        .try_exists()
        .map_err(|e| format!("Could not access {}: {e}", data_path.display()))?
    {
        &data_path
    } else {
        &source
    };
    let mut data = read_saved_data(source)?;
    if normalize_eula_state(&mut data) || source != &data_path {
        let migrated = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
        transaction.write(migrated.as_bytes()).map_err(|e| {
            format!(
                "Could not save migrated data to {}: {e}",
                data_path.display()
            )
        })?;
    }

    // The app-watcher registration loop reads this file on start and then
    // every two seconds, so it needs no synchronous update.
    Ok(data)
}

/// This action is offered only after a decoding failure. Recheck the bytes
/// under the writer lock so retrying cannot reset a repaired or healthy store.
#[cfg(not(target_os = "ios"))]
#[tauri::command]
pub fn recover_invalid_data(app: AppHandle) -> Result<String, String> {
    let path = apply_system_test_override(|| get_per_user_data_path(&app));
    recover_invalid_store(&path, || {
        #[cfg(feature = "system-test")]
        if !should_import_legacy_data() {
            return vec![];
        }
        let mut candidates: Vec<_> = import_sources()
            .into_iter()
            .map(|d| d.join(DATA_FILE_NAME))
            .filter(|p| p.is_file())
            .collect();
        candidates.extend(per_user_data_candidates(&app));
        candidates.retain(|p| p != &path);
        candidates
    })
    .map(|p| p.display().to_string())
    .map_err(|e| e.to_string())
}

#[cfg(not(target_os = "ios"))]
fn recover_invalid_store(
    path: &std::path::Path,
    legacy_sources: impl FnOnce() -> Vec<PathBuf>,
) -> std::io::Result<PathBuf> {
    use sha2::{Digest, Sha256};
    let transaction = DataFileWrite::lock(path)?;
    let sources = legacy_sources();
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => fs::read(sources.first().ok_or(e)?)?,
        Err(e) => return Err(e),
    };
    if serde_json::from_slice::<AppData>(&bytes).is_ok() {
        return Err(std::io::Error::other(
            "The saved data is readable. Try again.",
        ));
    }
    let archived = path.with_file_name(format!(
        "redd-block-data.damaged-{:x}.json",
        Sha256::digest(&bytes)
    ));
    write_data_file_atomic(&archived, &bytes)?;
    // A damaged shared import can mask a valid older per-user store.
    // Exhaust the saved copies before offering an empty configuration.
    let candidates = std::iter::once(path.with_file_name(PRE_SHARED_IMPORT_BACKUP)).chain(sources);
    for candidate in candidates {
        match fs::read(candidate) {
            Ok(bytes) if serde_json::from_slice::<AppData>(&bytes).is_ok() => {
                transaction.write(&bytes)?;
                return Ok(archived);
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
    }
    let replacement = serde_json::to_vec(&AppData::default())?;
    transaction.write(&replacement)?;
    Ok(archived)
}

fn read_saved_data(source: &std::path::Path) -> Result<AppData, String> {
    let content =
        fs::read(source).map_err(|e| format!("Could not read {}: {e}", source.display()))?;
    serde_json::from_slice(&content)
        .map_err(|e| format!("Invalid saved data in {}: {e}", source.display()))
}

/// Save data to file
#[tauri::command]
pub fn save_data(app: AppHandle, mut data: AppData) -> Result<(), String> {
    let data_path = get_data_path(&app);

    // Ensure parent directory exists
    ensure_data_dir(&data_path)?;

    // Backend-managed settings keys: these are owned by dedicated
    // commands (set_enforcement_enabled, set_extension_grace_seconds)
    // that read-modify-write the JSON directly. The frontend never
    // touches them in `appData.settings`, so a blind round-trip here
    // would drop a fresh-install user's toggle a few seconds after
    // they enabled it (the next saveData() trigger — block edit,
    // tick, etc. — serializes the stale `undefined` and clobbers
    // the disk value written by the dedicated command). Preserve
    // whatever is currently on disk for these keys.
    {
        let transaction = DataFileWrite::lock(&data_path)
            .map_err(|e| format!("Could not lock {}: {e}", data_path.display()))?;
        preserve_backend_settings(&data_path, &mut data);
        let content = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
        transaction
            .write(content.as_bytes())
            .map_err(|e| format!("Could not save {}: {e}", data_path.display()))?;

        #[cfg(target_os = "macos")]
        crate::app_group::maybe_mirror_after_save(&data_path, content.as_bytes());
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    super::app_blocking::sync_blocked_apps_from_disk(&app);

    Ok(())
}

const BACKEND_MANAGED_SETTING_KEYS: &[&str] = &[
    "enforcementEnabled",
    "extensionGraceSeconds",
    "blockingMethods",
];

fn preserve_backend_settings(data_path: &std::path::Path, data: &mut AppData) {
    let raw = match fs::read_to_string(data_path) {
        Ok(s) => s,
        Err(_) => return,
    };
    let disk: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return,
    };
    let disk_settings = match disk.get("settings").and_then(|s| s.as_object()) {
        Some(s) => s,
        None => return,
    };
    for key in BACKEND_MANAGED_SETTING_KEYS {
        if let Some(value) = disk_settings.get(*key) {
            data.settings
                .extra
                .insert((*key).to_string(), value.clone());
        } else {
            data.settings.extra.remove(*key);
        }
    }
}

/// Set window size (used after onboarding) - desktop only
#[tauri::command]
#[cfg(not(target_os = "ios"))]
pub fn set_window_size(window: WebviewWindow, width: f64, height: f64) -> Result<(), String> {
    use tauri::LogicalSize;
    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|e| e.to_string())?;
    window.center().map_err(|e| e.to_string())?;
    Ok(())
}

/// Set window size - no-op on mobile (always fullscreen)
#[tauri::command]
#[cfg(target_os = "ios")]
pub fn set_window_size(_width: f64, _height: f64) -> Result<(), String> {
    Ok(())
}

/// Remove blocklists, schedules, settings, and related on-disk state.
/// Best-effort: logs and continues when individual paths are missing or
/// not writable. Logs are intentionally preserved.
#[cfg(not(target_os = "ios"))]
pub fn wipe_user_data(app: &AppHandle) {
    // The normal implementation below deliberately enumerates shared,
    // current per-user, and legacy locations. In system-test mode that list
    // would be an unsafe production cleanup operation, so remove only the
    // exact isolated data file selected by the runner.
    #[cfg(feature = "system-test")]
    if system_test_data_path().is_some() {
        wipe_path(&get_data_path(app));
        return;
    }

    use std::collections::HashSet;

    #[cfg(target_os = "macos")]
    {
        if let Err(e) = crate::app_group::remove_blocklist_mirror() {
            log::warn!("wipe_user_data: App Group mirror cleanup failed: {e}");
        }
    }

    let data_path = get_data_path(app);
    let mut files: Vec<PathBuf> = vec![
        data_path.with_file_name(PRE_SHARED_IMPORT_BACKUP),
        data_path,
    ];

    if let Ok(app_data_dir) = app.path().app_data_dir() {
        files.push(app_data_dir.join("redd-block-data.json"));
    }

    if let Some(data_dir) = dirs::data_dir() {
        files.push(data_dir.join("com.reddblock").join("redd-block-data.json"));
        for id in ["com.redd.block", "redd-block"] {
            files.push(data_dir.join(id).join("redd-block-data.json"));
        }
    }

    // Nothing writes these any more, but an uninstall still has to take
    // away the machine-wide copies a pre-3.x install left behind.
    for shared_dir in legacy_shared_dirs() {
        files.push(shared_dir.join(DATA_FILE_NAME));
        files.push(shared_dir.join("helper-state.json"));
    }

    #[cfg(target_os = "macos")]
    if let Some(home) = dirs::home_dir() {
        files.push(home.join("Library/Preferences/com.reddblock.plist"));
    }

    let mut dirs: HashSet<PathBuf> = HashSet::new();
    if let Ok(app_data_dir) = app.path().app_data_dir() {
        dirs.insert(app_data_dir);
    }
    if let Some(data_dir) = dirs::data_dir() {
        dirs.insert(data_dir.join("com.reddblock"));
        for id in ["com.redd.block", "redd-block"] {
            dirs.insert(data_dir.join(id));
        }
    }

    for path in files {
        wipe_path(&path);
    }
    for dir in dirs {
        wipe_path(&dir);
    }
}

#[cfg(not(target_os = "ios"))]
fn wipe_path(path: &PathBuf) {
    if !path.exists() {
        return;
    }
    let result = if path.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    };
    if let Err(e) = result {
        log::warn!("wipe_user_data: failed to remove {}: {e}", path.display());
    } else {
        log::info!("wipe_user_data: removed {}", path.display());
    }
}

#[cfg(test)]
mod shared_storage_import_tests;

#[cfg(all(test, feature = "system-test"))]
mod system_test_isolation_tests;
