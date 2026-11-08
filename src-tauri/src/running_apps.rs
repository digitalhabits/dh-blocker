//! Which browsers are running, asked of Launch Services by bundle id.
//!
//! The watchers and the compliance enforcer used to answer "is this browser
//! open?" with a `sysinfo` refresh of every process on the machine, several
//! times every few seconds during a block. That was most of the app's CPU.
//! Every browser we police is a regular AppKit app, so `NSRunningApplication`
//! answers the same question without touching the process table.
//!
//! The app watcher is deliberately not a caller: a blocked app can be a
//! process AppKit never announces, so it keeps its own process scan.

use std::path::PathBuf;

/// Release, Developer Edition and Nightly. All three run a main process named
/// `firefox`, which is what the process-name match used to find.
pub const FIREFOX: &[&str] = &[
    "org.mozilla.firefox",
    "org.mozilla.firefoxdeveloperedition",
    "org.mozilla.nightly",
];

/// One live (not yet terminated) instance of an app.
pub struct RunningApp {
    pub pid: i32,
    pub executable: Option<PathBuf>,
}

/// Every live instance of the given bundle ids, in the order given.
pub fn instances(bundle_ids: &[&str]) -> Vec<RunningApp> {
    let mut out = Vec::new();
    find_instance(bundle_ids, |pid, app| {
        out.push(RunningApp {
            pid,
            // SAFETY: `app` is a live NSRunningApplication inside the pool.
            executable: unsafe { executable_path(app) },
        });
        None::<()>
    });
    out
}

/// Stops at the first live instance and skips the executable lookup, which
/// only `instances` needs.
pub fn any_running(bundle_ids: &[&str]) -> bool {
    find_instance(bundle_ids, |_, _| Some(())).is_some()
}

pub fn first_pid(bundle_ids: &[&str]) -> Option<i32> {
    find_instance(bundle_ids, |pid, _| Some(pid))
}

/// Visits live instances in the order given until `f` returns `Some`.
#[allow(deprecated)] // Cocoa FFI pending migration to objc2.
fn find_instance<T>(
    bundle_ids: &[&str],
    mut f: impl FnMut(i32, cocoa::base::id) -> Option<T>,
) -> Option<T> {
    use cocoa::base::{id, nil};
    use cocoa::foundation::NSString;
    use objc::{class, msg_send, sel, sel_impl};

    objc::rc::autoreleasepool(|| unsafe {
        for bundle_id in bundle_ids {
            let bid: id = NSString::alloc(nil).init_str(bundle_id);
            let bid: id = msg_send![bid, autorelease];
            let apps: id = msg_send![
                class!(NSRunningApplication),
                runningApplicationsWithBundleIdentifier: bid
            ];
            if apps.is_null() {
                continue;
            }
            let count: usize = msg_send![apps, count];
            for i in 0..count {
                let app: id = msg_send![apps, objectAtIndex: i];
                let terminated: bool = msg_send![app, isTerminated];
                let pid: i32 = msg_send![app, processIdentifier];
                // Headless instances (Playwright, `--headless` screenshots)
                // run as NSApplicationActivationPolicyProhibited: no Dock
                // icon and no windows to browse in, so nothing to enforce.
                let policy: isize = msg_send![app, activationPolicy];
                if terminated || pid <= 0 || policy == 2 {
                    continue;
                }
                if let Some(found) = f(pid, app) {
                    return Some(found);
                }
            }
        }
        None
    })
}

#[allow(deprecated)] // Cocoa FFI pending migration to objc2.
unsafe fn executable_path(app: cocoa::base::id) -> Option<PathBuf> {
    use objc::{msg_send, sel, sel_impl};
    let url: cocoa::base::id = msg_send![app, executableURL];
    if url.is_null() {
        return None;
    }
    let path: cocoa::base::id = msg_send![url, path];
    if path.is_null() {
        return None;
    }
    let c: *const std::os::raw::c_char = msg_send![path, UTF8String];
    if c.is_null() {
        return None;
    }
    let s = std::ffi::CStr::from_ptr(c).to_str().ok()?;
    Some(PathBuf::from(s))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_nothing_for_an_unknown_bundle_id() {
        assert!(!any_running(&["invalid.reddblock.no-such-app"]));
        assert_eq!(first_pid(&["invalid.reddblock.no-such-app"]), None);
    }

    #[test]
    fn finds_the_dock_with_its_executable() {
        // The Dock runs in every GUI session, which unit tests on macOS
        // always have; a headless runner would have no Launch Services
        // session at all, so skip rather than fail there.
        let dock = instances(&["com.apple.dock"]);
        if let Some(app) = dock.first() {
            assert!(app.pid > 0);
            let exe = app.executable.as_ref().expect("Dock has an executable");
            assert!(exe.ends_with("Dock"), "unexpected executable {exe:?}");
            assert!(any_running(&["com.apple.dock"]));
            assert_eq!(first_pid(&["com.apple.dock"]), Some(app.pid));
        }
    }
}
