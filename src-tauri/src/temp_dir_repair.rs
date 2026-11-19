//! Repair a stale `TMPDIR` inherited from the `.pkg` installer.
//!
//! The pkg `postinstall` relaunches the app with `open`, and LaunchServices
//! hands the new process the installer's environment — including
//! `TMPDIR=/private/tmp/PKInstallSandbox.XXXX/tmp`. The installer deletes that
//! sandbox as soon as it finishes, and because the app has no quit gesture it
//! keeps the dead path until logout. Every `std::env::temp_dir()` user then
//! fails with ENOENT; most visibly the in-app update download ("Could not
//! write installer to disk: No such file or directory").
//!
//! `postinstall` now strips `TMPDIR` before launching, but already-installed
//! builds will relaunch the next version the old way, so the app repairs it
//! itself at startup.

use std::path::{Path, PathBuf};

/// Decide whether the inherited temp dir must be replaced. Returns the
/// replacement only when the inherited one is unusable (unset or not an
/// existing directory) and the system one is an existing directory.
fn replacement_tmpdir(inherited: Option<&Path>, system: Option<PathBuf>) -> Option<PathBuf> {
    if inherited.is_some_and(Path::is_dir) {
        return None;
    }
    system.filter(|dir| dir.is_dir())
}

/// The per-user temp dir from `confstr(_CS_DARWIN_USER_TEMP_DIR)`, which does
/// not depend on the process environment.
fn darwin_user_temp_dir() -> Option<PathBuf> {
    use std::ffi::{CStr, OsStr};
    use std::os::unix::ffi::OsStrExt;

    let mut buf = vec![0u8; libc::PATH_MAX as usize];
    // SAFETY: `buf` is writable for `buf.len()` bytes and confstr NUL-terminates
    // within that length.
    let needed = unsafe {
        libc::confstr(
            libc::_CS_DARWIN_USER_TEMP_DIR,
            buf.as_mut_ptr().cast(),
            buf.len(),
        )
    };
    if needed == 0 || needed > buf.len() {
        return None;
    }
    let path = CStr::from_bytes_until_nul(&buf).ok()?;
    let path = PathBuf::from(OsStr::from_bytes(path.to_bytes()));
    (!path.as_os_str().is_empty()).then_some(path)
}

/// Point `TMPDIR` at the real per-user temp dir if the inherited one is gone.
/// Call from `main` before any thread is spawned (`set_var` is not thread-safe).
pub fn repair_inherited_tmpdir() {
    let inherited = std::env::var_os("TMPDIR").map(PathBuf::from);
    if let Some(dir) = replacement_tmpdir(inherited.as_deref(), darwin_user_temp_dir()) {
        std::env::set_var("TMPDIR", &dir);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn existing_dir() -> PathBuf {
        let dir = std::env::current_dir().unwrap();
        assert!(dir.is_dir());
        dir
    }

    #[test]
    fn replaces_deleted_installer_sandbox_tmpdir() {
        let system = existing_dir();
        let stale = Path::new("/private/tmp/PKInstallSandbox.does-not-exist/tmp");
        assert_eq!(
            replacement_tmpdir(Some(stale), Some(system.clone())),
            Some(system)
        );
    }

    #[test]
    fn replaces_unset_tmpdir() {
        let system = existing_dir();
        assert_eq!(replacement_tmpdir(None, Some(system.clone())), Some(system));
    }

    #[test]
    fn keeps_existing_tmpdir() {
        let inherited = existing_dir();
        assert_eq!(
            replacement_tmpdir(Some(&inherited), Some(PathBuf::from("/tmp"))),
            None
        );
    }

    #[test]
    fn keeps_inherited_when_system_dir_unusable() {
        let stale = Path::new("/private/tmp/PKInstallSandbox.does-not-exist/tmp");
        assert_eq!(replacement_tmpdir(Some(stale), None), None);
        assert_eq!(
            replacement_tmpdir(Some(stale), Some(PathBuf::from("/does/not/exist"))),
            None
        );
    }

    #[test]
    fn darwin_user_temp_dir_exists() {
        assert!(darwin_user_temp_dir().is_some_and(|dir| dir.is_dir()));
    }
}
