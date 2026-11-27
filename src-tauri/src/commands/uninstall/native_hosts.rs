use std::ffi::{CStr, OsStr, OsString};
use std::fs::File;
use std::mem::{size_of, MaybeUninit};
use std::os::fd::AsRawFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct FileIdentity(u64, u64);

impl FileIdentity {
    fn from_path(path: &Path) -> Option<Self> {
        let meta = path.metadata().ok()?;
        Some(Self(meta.dev(), meta.ino()))
    }
}

fn process_image_path(pid: libc::pid_t) -> Option<PathBuf> {
    let mut path = [0; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    // proc_pidpath uses the vnode's current location, unlike the argv path.
    let length = unsafe { libc::proc_pidpath(pid, path.as_mut_ptr().cast(), path.len() as u32) };
    if length <= 0 {
        return None;
    }
    path_from_buffer(&path)
}

fn path_from_buffer(bytes: &[u8]) -> Option<PathBuf> {
    let path = CStr::from_bytes_until_nul(bytes).ok()?.to_bytes();
    (!path.is_empty()).then(|| PathBuf::from(OsStr::from_bytes(path)))
}

fn path_of_open_file(file: &File) -> Option<PathBuf> {
    let mut path = [0u8; libc::MAXPATHLEN as usize];
    // Keep the original file open across the move to resolve its current
    // path even if the Trash directory does not permit path-based stat.
    let result = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETPATH, path.as_mut_ptr()) };
    if result != 0 {
        return None;
    }
    path_from_buffer(&path)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ProcessIdentity {
    real_uid: libc::uid_t,
    effective_uid: libc::uid_t,
    started: (u64, u64),
}

impl ProcessIdentity {
    fn read(pid: libc::pid_t) -> Option<Self> {
        let mut info = MaybeUninit::<libc::proc_bsdinfo>::uninit();
        let size = size_of::<libc::proc_bsdinfo>() as i32;
        let bytes = unsafe {
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDTBSDINFO,
                0,
                info.as_mut_ptr().cast(),
                size,
            )
        };
        if bytes != size {
            return None;
        }
        let info = unsafe { info.assume_init() };
        Some(Self {
            real_uid: info.pbi_ruid,
            effective_uid: info.pbi_uid,
            started: (info.pbi_start_tvsec, info.pbi_start_tvusec),
        })
    }

    fn belongs_to(self, uid: libc::uid_t) -> bool {
        self.real_uid == uid && self.effective_uid == uid
    }
}

pub(super) struct InstalledBinary {
    file: File,
    name: OsString,
    identity: FileIdentity,
}

impl InstalledBinary {
    pub(super) fn capture(path: &Path) -> Option<Self> {
        let file = File::open(path).ok()?;
        let meta = file.metadata().ok()?;
        Some(Self {
            file,
            name: path.file_name()?.to_owned(),
            identity: FileIdentity(meta.dev(), meta.ino()),
        })
    }

    pub(super) fn close_native_hosts(&self) {
        let uid = unsafe { libc::getuid() };
        let own_pid = std::process::id();
        let owned_path = path_of_open_file(&self.file);
        let mut processes = System::new();
        processes.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing(),
        );
        let matching_names: Vec<_> = processes
            .processes()
            .values()
            .filter(|process| process.pid().as_u32() != own_pid && process.name() == self.name)
            .map(sysinfo::Process::pid)
            .collect();
        for candidate in matching_names {
            let pid = candidate.as_u32() as libc::pid_t;
            let Some(original) = ProcessIdentity::read(pid).filter(|p| p.belongs_to(uid)) else {
                continue;
            };
            processes.refresh_processes_specifics(
                ProcessesToUpdate::Some(&[candidate]),
                true,
                ProcessRefreshKind::nothing().with_cmd(UpdateKind::Always),
            );
            let Some(process) = processes.process(candidate) else {
                continue;
            };
            let Some(image_path) = process_image_path(pid) else {
                continue;
            };
            if matches_image(self.identity, &image_path, owned_path.as_deref())
                && is_native_host_invocation(process.cmd())
                && ProcessIdentity::read(pid) == Some(original)
            {
                // macOS signals take a PID. Recheck its start time at
                // microsecond precision immediately before sending TERM.
                if unsafe { libc::kill(pid, libc::SIGTERM) } == 0 {
                    log::info!("uninstall_self_macos: closed native host pid {pid}");
                } else {
                    log::debug!(
                        "uninstall_self_macos: could not close native host pid {pid}: {}",
                        std::io::Error::last_os_error()
                    );
                }
            }
        }
    }
}

fn matches_image(
    expected: FileIdentity,
    process_path: &Path,
    owned_kernel_path: Option<&Path>,
) -> bool {
    FileIdentity::from_path(process_path)
        .map_or(owned_kernel_path == Some(process_path), |id| id == expected)
}

fn is_native_host_invocation(command: &[OsString]) -> bool {
    let extension_ids = crate::native_host_install::chromium_extension_ids();
    command.iter().skip(1).any(|argument| {
        argument == "--native-host"
            || argument == crate::native_host_install::FIREFOX_EXT_ID
            || argument
                .to_str()
                .and_then(|argument| argument.strip_prefix("chrome-extension://"))
                .and_then(|origin| origin.strip_suffix('/'))
                .is_some_and(|id| extension_ids.iter().any(|extension| extension == id))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_match_uses_executable_identity_after_the_bundle_moves() {
        let root = std::env::temp_dir().join(format!(
            "redd-block-uninstall-file-id-{}",
            std::process::id()
        ));
        let installed = root.join("Applications/Blocker.app/Contents/MacOS/redd-block");
        let trashed = root.join("Trash/Blocker.app/Contents/MacOS/redd-block");
        std::fs::create_dir_all(installed.parent().unwrap()).unwrap();
        std::fs::create_dir_all(trashed.parent().unwrap()).unwrap();
        std::fs::write(&installed, b"fixture").unwrap();
        let original = InstalledBinary::capture(&installed).unwrap();
        std::fs::rename(&installed, &trashed).unwrap();
        // A replacement at the exact original path is a different file.
        std::fs::write(&installed, b"fixture").unwrap();
        let owned_path = path_of_open_file(&original.file).unwrap();
        assert_eq!(
            owned_path.canonicalize().unwrap(),
            trashed.canonicalize().unwrap()
        );
        assert!(matches_image(
            original.identity,
            &trashed,
            Some(&owned_path)
        ));
        assert!(!matches_image(
            original.identity,
            &installed,
            Some(&owned_path)
        ));
        let unavailable = root.join("unavailable");
        assert!(matches_image(
            original.identity,
            &unavailable,
            Some(&unavailable)
        ));
        assert!(!matches_image(
            original.identity,
            &unavailable,
            Some(&owned_path)
        ));
        assert!(!matches_image(original.identity, &unavailable, None));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn host_invocation_requires_known_arguments() {
        let app = OsString::from("/Applications/Blocker.app/Contents/MacOS/redd-block");
        let chrome_id = crate::native_host_install::chromium_extension_ids().remove(0);
        assert!(is_native_host_invocation(&[
            app.clone(),
            "--native-host".into()
        ]));
        assert!(is_native_host_invocation(&[
            app.clone(),
            crate::native_host_install::FIREFOX_EXT_ID.into()
        ]));
        assert!(is_native_host_invocation(&[
            app.clone(),
            format!("chrome-extension://{chrome_id}/").into()
        ]));
        assert!(!is_native_host_invocation(&[
            app.clone(),
            "chrome-extension://other-extension/".into()
        ]));
        assert!(!is_native_host_invocation(&[app]));
    }

    #[test]
    fn same_pid_requires_matching_user_and_original_start_time() {
        let original = ProcessIdentity {
            real_uid: 501,
            effective_uid: 501,
            started: (100, 10),
        };
        assert!(original.belongs_to(501));
        assert!(!original.belongs_to(502));
        assert!(!ProcessIdentity {
            effective_uid: 0,
            ..original
        }
        .belongs_to(501));
        assert_ne!(
            ProcessIdentity {
                started: (100, 11),
                ..original
            },
            original
        );
    }
}
