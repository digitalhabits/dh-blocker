//! Shared App Group container for Safari extension mode on macOS.
//!
//! When Safari uses the ReDD Focus extension (not Automation), mirror
//! `redd-block-data.json` into `group.com.reddblock.shared` so the App
//! Store Safari handler can read blocklists without cross-app probes.

#[cfg(target_os = "macos")]
use std::fs;
#[cfg(target_os = "macos")]
use std::io;
#[cfg(target_os = "macos")]
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::sync::{Mutex, OnceLock};
#[cfg(target_os = "macos")]
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[cfg(target_os = "macos")]
use objc2_foundation::{NSFileManager, NSString};

#[cfg(target_os = "macos")]
const APP_GROUP_ID: &str = "group.com.reddblock.shared";
#[cfg(target_os = "macos")]
const BLOCKLIST_FILENAME: &str = "redd-block-data.json";

#[cfg(target_os = "macos")]
static GROUP_DIR: OnceLock<Option<PathBuf>> = OnceLock::new();
#[cfg(target_os = "macos")]
static SYNC_LOOP_STARTED: OnceLock<()> = OnceLock::new();
#[cfg(target_os = "macos")]
static BLOCKLIST_MIRROR: BlocklistMirror = BlocklistMirror(Mutex::new(false));

/// Serialise the final removal with writes from the background worker,
/// save-data command and browser-method command.
#[cfg(target_os = "macos")]
struct BlocklistMirror(Mutex<bool>);

#[cfg(target_os = "macos")]
impl BlocklistMirror {
    fn write(&self, bytes: &[u8], target: impl FnOnce() -> Option<PathBuf>) -> io::Result<()> {
        let stopped = self.0.lock().map_err(|e| io::Error::other(e.to_string()))?;
        if *stopped {
            return Ok(());
        }
        let target = target().ok_or_else(|| {
            io::Error::new(io::ErrorKind::NotFound, "App Group container unavailable")
        })?;
        atomic_write(&target, bytes)
    }

    fn stop_and_remove(&self, target: Option<&Path>) -> io::Result<()> {
        let mut stopped = self.0.lock().map_err(|e| io::Error::other(e.to_string()))?;
        *stopped = true;
        remove_mirror_at(target)
    }
}

#[cfg(all(target_os = "macos", feature = "system-test"))]
pub fn path() -> Option<PathBuf> {
    // The system-test app intentionally has no production App Group
    // entitlement, so it must never touch group.com.reddblock.shared.
    None
}

#[cfg(all(target_os = "macos", not(feature = "system-test")))]
pub fn path() -> Option<PathBuf> {
    GROUP_DIR.get_or_init(resolve_group_dir).clone()
}

#[cfg(target_os = "macos")]
pub fn blocklist_path() -> Option<PathBuf> {
    path().map(|dir| dir.join(BLOCKLIST_FILENAME))
}

#[cfg(all(target_os = "macos", feature = "system-test"))]
pub fn safari_extension_mirror_active(source: &Path) -> bool {
    let _ = source;
    false
}

#[cfg(all(target_os = "macos", not(feature = "system-test")))]
pub fn safari_extension_mirror_active(source: &Path) -> bool {
    !crate::blocking_method::uses_automation_at_path(source, "safari")
}

#[cfg(target_os = "macos")]
fn write_blocklist_bytes(bytes: &[u8]) -> io::Result<()> {
    BLOCKLIST_MIRROR.write(bytes, blocklist_path)
}

#[cfg(target_os = "macos")]
pub fn sync_blocklist_from(source: &Path) -> io::Result<()> {
    if !safari_extension_mirror_active(source) {
        remove_blocklist_mirror()?;
        return Ok(());
    }
    let bytes = fs::read(source)?;
    write_blocklist_bytes(&bytes)
}

#[cfg(target_os = "macos")]
pub fn remove_blocklist_mirror() -> io::Result<()> {
    remove_mirror_at(blocklist_path().as_deref())
}

#[cfg(target_os = "macos")]
pub(crate) fn stop_and_remove_blocklist_mirror() -> io::Result<()> {
    BLOCKLIST_MIRROR.stop_and_remove(blocklist_path().as_deref())
}

#[cfg(target_os = "macos")]
fn remove_mirror_at(target: Option<&Path>) -> io::Result<()> {
    match target.map(fs::remove_file) {
        None | Some(Ok(())) => Ok(()),
        Some(Err(e)) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Some(Err(e)) => Err(e),
    }
}

#[cfg(target_os = "macos")]
pub fn maybe_mirror_after_save(source: &Path, bytes: &[u8]) {
    if !safari_extension_mirror_active(source) {
        if let Err(e) = remove_blocklist_mirror() {
            log::debug!("App Group mirror remove skipped: {e}");
        }
        return;
    }
    if let Err(e) = write_blocklist_bytes(bytes) {
        log::warn!("App Group mirror write failed: {e}");
    }
}

#[cfg(all(target_os = "macos", feature = "system-test"))]
pub fn ensure_sync_loop(source: PathBuf) {
    // No App Group is provisioned for the isolated app; in particular do not
    // start a background thread that could mirror into production.
    let _ = source;
}

#[cfg(all(target_os = "macos", not(feature = "system-test")))]
pub fn ensure_sync_loop(source: PathBuf) {
    SYNC_LOOP_STARTED.get_or_init(|| {
        std::thread::spawn(move || {
            let mut last = mtime(&source);
            if safari_extension_mirror_active(&source) {
                if let Err(e) = sync_blocklist_from(&source) {
                    log::warn!("initial App Group sync failed from {:?}: {e}", source);
                }
                last = mtime(&source);
            }
            loop {
                if safari_extension_mirror_active(&source) {
                    let current = mtime(&source);
                    if current != last {
                        last = current;
                        if let Err(e) = sync_blocklist_from(&source) {
                            log::warn!("App Group sync failed from {:?}: {e}", source);
                        }
                    }
                } else if blocklist_path().is_some_and(|p| p.exists()) {
                    let _ = remove_blocklist_mirror();
                }
                std::thread::sleep(Duration::from_secs(2));
            }
        });
    });
}

#[cfg(target_os = "macos")]
fn resolve_group_dir() -> Option<PathBuf> {
    resolve_group_dir_via_ffi()
}

#[cfg(target_os = "macos")]
fn resolve_group_dir_via_ffi() -> Option<PathBuf> {
    let manager = NSFileManager::defaultManager();
    let group_id = NSString::from_str(APP_GROUP_ID);
    let url = manager.containerURLForSecurityApplicationGroupIdentifier(&group_id)?;
    let path = url.path()?;
    Some(PathBuf::from(path.to_string()))
}

#[cfg(target_os = "macos")]
fn atomic_write(target: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = target
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "target has no parent"))?;
    fs::create_dir_all(parent)?;

    let tmp = parent.join(format!(
        ".{}.{}.tmp",
        target
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("app-group"),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    fs::write(&tmp, bytes)?;
    if let Err(e) = fs::rename(&tmp, target) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn mtime(path: &Path) -> Option<SystemTime> {
    fs::metadata(path).and_then(|m| m.modified()).ok()
}

#[cfg(all(target_os = "macos", test))]
#[test]
fn uninstall_removes_mirror_and_prevents_late_writes() {
    let directory = std::env::temp_dir().join(format!(
        "redd-block-uninstall-mirror-{}",
        std::process::id()
    ));
    let target = directory.join(BLOCKLIST_FILENAME);
    let source = directory.join("saved-data.json");
    fs::create_dir_all(&directory).unwrap();
    fs::write(&source, b"saved data").unwrap();
    let mirror = BlocklistMirror(Mutex::new(false));

    mirror.write(b"policy", || Some(target.clone())).unwrap();
    assert_eq!(fs::read(&target).unwrap(), b"policy");

    mirror.stop_and_remove(Some(&target)).unwrap();
    mirror
        .write(b"late policy", || Some(target.clone()))
        .unwrap();
    assert!(!target.exists());
    assert_eq!(fs::read(&source).unwrap(), b"saved data");
    fs::remove_dir_all(directory).unwrap();
}
