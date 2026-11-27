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

/// Serialise uninstall mirror removal with the background worker and
/// the save-data and browser-method commands.
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

    fn remove(&self, target: Option<&Path>) -> io::Result<()> {
        let stopped = self.0.lock().map_err(|e| io::Error::other(e.to_string()))?;
        if *stopped {
            Ok(())
        } else {
            remove_mirror_at(target)
        }
    }

    fn remove_for_uninstall(
        &self,
        target: Option<&Path>,
        move_bundle: impl FnOnce() -> Result<(), String>,
        rollback_policy: impl FnOnce() -> io::Result<Option<Vec<u8>>>,
    ) -> Result<(), String> {
        {
            let mut stopped = self.0.lock().map_err(|e| e.to_string())?;
            remove_mirror_at(target).map_err(|e| format!("could not remove Safari policy: {e}"))?;
            *stopped = true;
        }

        let Err(trash_error) = move_bundle() else {
            return Ok(());
        };

        // Keep save-data and browser-method commands responsive while Finder
        // is open. Re-read the policy under the mirror lock after a failure
        // so any edits made during the prompt are reflected immediately.
        let mut stopped = self.0.lock().map_err(|e| format!("{trash_error}. {e}"))?;
        let restore = target.map_or(Ok(()), |target| {
            if let Some(bytes) = rollback_policy()? {
                atomic_write(target, &bytes)?;
            }
            Ok::<_, io::Error>(())
        });
        *stopped = false;
        match restore {
            Ok(()) => Err(trash_error),
            Err(e) => Err(format!(
                "{trash_error}. Could not restore Safari policy: {e}"
            )),
        }
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
    crate::cross_app_consent::has_accepted_eula_at_path(source)
        && !crate::blocking_method::uses_automation_at_path(source, "safari")
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
    BLOCKLIST_MIRROR.remove(blocklist_path().as_deref())
}

#[cfg(target_os = "macos")]
pub(crate) fn remove_mirror_for_uninstall(
    source: Option<&Path>,
    move_bundle: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    BLOCKLIST_MIRROR.remove_for_uninstall(blocklist_path().as_deref(), move_bundle, || {
        source
            .filter(|source| safari_extension_mirror_active(source))
            .map(fs::read)
            .transpose()
    })
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
            let mut last = None;
            loop {
                if safari_extension_mirror_active(&source) {
                    let current = mtime(&source);
                    let mirror_missing = blocklist_path().is_some_and(|p| !p.is_file());
                    if last.is_none() || current != last || mirror_missing {
                        match sync_blocklist_from(&source) {
                            Ok(()) => last = current,
                            Err(e) => log::warn!("App Group sync failed from {:?}: {e}", source),
                        }
                    }
                } else {
                    last = None;
                    if blocklist_path().is_some_and(|p| p.exists()) {
                        let _ = remove_blocklist_mirror();
                    }
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

    mirror
        .remove_for_uninstall(
            Some(&target),
            || {
                assert!(!target.exists());
                mirror
                    .write(b"during removal", || Some(target.clone()))
                    .unwrap();
                assert!(!target.exists());
                Ok(())
            },
            || panic!("did not need to restore policy"),
        )
        .unwrap();
    mirror
        .write(b"late policy", || Some(target.clone()))
        .unwrap();
    assert!(!target.exists());
    assert_eq!(fs::read(&source).unwrap(), b"saved data");
    fs::remove_dir_all(directory).unwrap();
}

#[cfg(all(target_os = "macos", test))]
#[test]
fn failed_trash_restores_current_safari_policy_and_allows_writes() {
    let directory = std::env::temp_dir().join(format!(
        "redd-block-cancelled-uninstall-mirror-{}",
        std::process::id()
    ));
    let target = directory.join(BLOCKLIST_FILENAME);
    let mirror = BlocklistMirror(Mutex::new(false));
    mirror
        .write(b"old policy", || Some(target.clone()))
        .unwrap();
    let result = mirror.remove_for_uninstall(
        Some(&target),
        || {
            assert!(!target.exists());
            mirror
                .write(b"concurrent save", || Some(target.clone()))
                .unwrap();
            assert!(!target.exists());
            Err("Trash denied".into())
        },
        || Ok(Some(b"current policy".to_vec())),
    );
    assert_eq!(result.unwrap_err(), "Trash denied");
    assert_eq!(fs::read(&target).unwrap(), b"current policy");
    mirror
        .write(b"new policy", || Some(target.clone()))
        .unwrap();
    assert_eq!(fs::read(&target).unwrap(), b"new policy");
    let result =
        mirror.remove_for_uninstall(Some(&target), || Err("Trash denied".into()), || Ok(None));
    assert_eq!(result.unwrap_err(), "Trash denied");
    assert!(!target.exists());
    fs::remove_dir_all(directory).unwrap();
}

#[cfg(all(target_os = "macos", test))]
#[test]
fn mirror_removal_error_leaves_bundle_and_mirror_writes_available() {
    let directory = std::env::temp_dir().join(format!(
        "redd-block-uninstall-mirror-error-{}",
        std::process::id()
    ));
    fs::create_dir_all(&directory).unwrap();
    let mirror = BlocklistMirror(Mutex::new(false));
    let result = mirror.remove_for_uninstall(
        Some(&directory),
        || panic!("bundle move ran despite mirror removal failure"),
        || panic!("mirror was never removed"),
    );
    assert!(result
        .unwrap_err()
        .contains("could not remove Safari policy"));
    let target = directory.join(BLOCKLIST_FILENAME);
    mirror.write(b"policy", || Some(target.clone())).unwrap();
    assert_eq!(fs::read(&target).unwrap(), b"policy");
    fs::remove_dir_all(directory).unwrap();
}
