use super::BrowserKey;
use std::collections::{HashMap, HashSet};

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(super) struct BrowserProcess {
    pub(super) pid: u32,
    pub(super) started: u64,
}

pub(super) type BrowserProcesses = HashMap<BrowserKey, HashSet<BrowserProcess>>;

pub(super) fn any_live_target(
    key: BrowserKey,
    targets: &HashSet<BrowserProcess>,
    running: &BrowserProcesses,
) -> bool {
    if running
        .get(&key)
        .is_some_and(|live| !live.is_disjoint(targets))
    {
        return true;
    }
    #[cfg(target_os = "windows")]
    {
        // Browser-root identification uses windows. A graceful close can
        // remove those windows while the same browser process is still alive.
        targets.iter().any(|&target| windows::is_running(target))
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

#[cfg(target_os = "macos")]
fn with_bundle_ids<T>(key: BrowserKey, visit: impl FnOnce(&[&str]) -> T) -> T {
    match key.to_web_automation() {
        Some(browser) => visit(&[browser.bundle_id()]),
        None => visit(crate::running_apps::FIREFOX),
    }
}

#[cfg(target_os = "macos")]
pub(super) fn running_browsers() -> BrowserProcesses {
    BrowserKey::enforced()
        .iter()
        .filter_map(|&key| {
            // Use Launch Services rather than scanning system processes.
            let processes: HashSet<_> = with_bundle_ids(key, crate::running_apps::launches)
                .into_iter()
                .map(|(pid, started)| BrowserProcess { pid, started })
                .collect();
            (!processes.is_empty()).then_some((key, processes))
        })
        .collect()
}

#[cfg(target_os = "macos")]
pub(super) fn close_target(key: BrowserKey, target: BrowserProcess, force: bool) -> bool {
    with_bundle_ids(key, |ids| {
        crate::running_apps::close_launch(ids, target.pid, target.started, force)
    })
}

#[cfg(target_os = "windows")]
pub(super) use windows::{close_target, running_browsers};

#[cfg(target_os = "windows")]
mod windows {
    use super::{BrowserKey, BrowserProcess, BrowserProcesses};
    use ::windows::core::{Owned, BOOL, PWSTR};
    use ::windows::Win32::Foundation::{FILETIME, HANDLE, HWND, LPARAM, WAIT_TIMEOUT, WPARAM};
    use ::windows::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, TerminateProcess,
        WaitForSingleObject, PROCESS_ACCESS_RIGHTS, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
    };
    use ::windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetWindowThreadProcessId, PostMessageW, WM_CLOSE,
    };

    pub(in crate::enforcer) fn running_browsers() -> BrowserProcesses {
        let mut running = BrowserProcesses::new();
        // Identify the browser root through a browser window as well as its
        // executable. Chromium and Firefox helpers can share the root's
        // executable name, but do not own browser windows.
        enum_windows(|hwnd| {
            let Some((key, process)) = browser_window(hwnd) else {
                return;
            };
            running.entry(key).or_default().insert(process);
        });
        running
    }

    fn browser_window(hwnd: HWND) -> Option<(BrowserKey, BrowserProcess)> {
        let mut class = [0u16; 32];
        let len = unsafe { GetClassNameW(hwnd, &mut class) };
        let class = String::from_utf16_lossy(&class[..len as usize]);
        if !matches!(class.as_str(), "MozillaWindowClass" | "Chrome_WidgetWin_1") {
            return None;
        }
        let pid = window_pid(hwnd);
        let handle = open(pid, PROCESS_QUERY_LIMITED_INFORMATION)?;
        let started = live_start_time(*handle)?;
        let mut path = [0u16; 1024];
        let mut len = path.len() as u32;
        unsafe {
            QueryFullProcessImageNameW(
                *handle,
                PROCESS_NAME_WIN32,
                PWSTR(path.as_mut_ptr()),
                &mut len,
            )
            .ok()?;
        }
        let path = String::from_utf16_lossy(&path[..len as usize]);
        let key = identify_browser(&class, &path)?;
        (window_pid(hwnd) == pid).then_some((key, BrowserProcess { pid, started }))
    }

    fn identify_browser(class: &str, path: &str) -> Option<BrowserKey> {
        let executable = path.rsplit(['\\', '/']).next()?.to_ascii_lowercase();
        match (class, executable.as_str()) {
            ("MozillaWindowClass", "firefox.exe") => Some(BrowserKey::Firefox),
            ("Chrome_WidgetWin_1", "chrome.exe") => Some(BrowserKey::Chrome),
            ("Chrome_WidgetWin_1", "brave.exe") => Some(BrowserKey::Brave),
            ("Chrome_WidgetWin_1", "msedge.exe") => Some(BrowserKey::Edge),
            _ => None,
        }
    }

    pub(super) fn is_running(target: BrowserProcess) -> bool {
        matching_handle(target, PROCESS_QUERY_LIMITED_INFORMATION).is_some()
    }

    pub(in crate::enforcer) fn close_target(
        key: BrowserKey,
        target: BrowserProcess,
        force: bool,
    ) -> bool {
        let mut access = PROCESS_QUERY_LIMITED_INFORMATION;
        if force {
            access |= PROCESS_TERMINATE;
        }
        let Some(handle) = matching_handle(target, access) else {
            return false;
        };
        if force {
            // Terminate the verified process object through the same handle.
            // No executable matching or child traversal can expand this set.
            return match unsafe { TerminateProcess(*handle, 1) } {
                Ok(()) => true,
                Err(error) => {
                    log::warn!(
                        "enforcer: could not close {} pid={}: {error}",
                        key.label(),
                        target.pid
                    );
                    false
                }
            };
        }

        // The handle remains open while posting WM_CLOSE, preventing PID
        // reuse. Send the cooperative close request to this PID's windows.
        let mut dispatched = false;
        enum_windows(|hwnd| {
            if window_pid(hwnd) == target.pid {
                dispatched |=
                    unsafe { PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0)) }.is_ok();
            }
        });
        dispatched
    }

    fn matching_handle(
        target: BrowserProcess,
        access: PROCESS_ACCESS_RIGHTS,
    ) -> Option<Owned<HANDLE>> {
        let handle = open(target.pid, access)?;
        (live_start_time(*handle) == Some(target.started)).then_some(handle)
    }

    fn open(pid: u32, access: PROCESS_ACCESS_RIGHTS) -> Option<Owned<HANDLE>> {
        if pid == 0 {
            return None;
        }
        // SAFETY: OpenProcess returns a new handle owned by this caller.
        unsafe {
            OpenProcess(access | PROCESS_SYNCHRONIZE, false, pid)
                .ok()
                .map(|handle| Owned::new(handle))
        }
    }

    fn live_start_time(handle: HANDLE) -> Option<u64> {
        let [mut start, mut exit, mut kernel, mut user] = [FILETIME::default(); 4];
        unsafe { GetProcessTimes(handle, &mut start, &mut exit, &mut kernel, &mut user) }.ok()?;
        // The exit FILETIME is undefined for a live process. A process
        // handle becomes signalled when that process exits.
        if unsafe { WaitForSingleObject(handle, 0) } != WAIT_TIMEOUT {
            return None;
        }
        // Keep the native FILETIME precision. sysinfo truncates to seconds.
        let started = (u64::from(start.dwHighDateTime) << 32) | u64::from(start.dwLowDateTime);
        (started != 0).then_some(started)
    }

    fn window_pid(hwnd: HWND) -> u32 {
        let mut pid = 0;
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
        pid
    }

    fn enum_windows<F: FnMut(HWND)>(mut visit: F) {
        unsafe extern "system" fn callback<F: FnMut(HWND)>(hwnd: HWND, state: LPARAM) -> BOOL {
            // SAFETY: EnumWindows calls this synchronously while the visitor
            // is on the stack and borrowed exclusively.
            let visit = unsafe { &mut *(state.0 as *mut F) };
            visit(hwnd);
            BOOL(1)
        }

        let ptr = &mut visit as *mut F as isize;
        let _ = unsafe { EnumWindows(Some(callback::<F>), LPARAM(ptr)) };
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn window_class_and_exact_executable_identify_the_browser_root() {
            let chromium = "Chrome_WidgetWin_1";
            assert_eq!(
                identify_browser(chromium, r"C:\Chrome\CHROME.EXE"),
                Some(BrowserKey::Chrome)
            );
            assert_eq!(
                identify_browser(chromium, r"C:\Brave\brave.exe"),
                Some(BrowserKey::Brave)
            );
            assert_eq!(
                identify_browser(chromium, r"C:\Edge\msedge.exe"),
                Some(BrowserKey::Edge)
            );
            assert_eq!(
                identify_browser("MozillaWindowClass", r"C:\Firefox\firefox.exe"),
                Some(BrowserKey::Firefox)
            );
            assert_eq!(identify_browser(chromium, r"C:\Other\notchrome.exe"), None);
            assert_eq!(
                identify_browser("MozillaWindowClass", r"C:\Chrome\chrome.exe"),
                None
            );
            assert_eq!(
                identify_browser("Chrome_RenderWidgetHostHWND", r"C:\Chrome\chrome.exe"),
                None
            );
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub(super) fn running_browsers() -> BrowserProcesses {
    BrowserProcesses::new()
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub(super) fn close_target(_key: BrowserKey, _target: BrowserProcess, _force: bool) -> bool {
    false
}
