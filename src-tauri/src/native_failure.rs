use std::time::{Duration, Instant};
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Identity {
    pub browser: String,
    pub pid: u32,
    pub started: u64,
    pub policy: String,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failure {
    PermissionDenied,
    AccessPrevented,
    BlockedUrlRemains,
}
#[derive(Clone, Debug, Default)]
pub struct Grace {
    pending: Option<(Identity, Failure, Instant)>,
    revalidated: bool,
}
#[derive(Debug, PartialEq, Eq)]
pub enum Action {
    None,
    Warn,
    Recover,
    Revalidate,
}
impl Grace {
    pub fn observe(&mut self, evidence: Option<(Identity, Failure)>, now: Instant) -> Action {
        let Some((identity, failure)) = evidence else {
            return if self.pending.take().is_some() {
                Action::Recover
            } else {
                Action::None
            };
        };
        if let Some((previous, reason, since)) = &self.pending {
            if previous == &identity && reason == &failure {
                return if !self.revalidated
                    && now.saturating_duration_since(*since) >= Duration::from_secs(60)
                {
                    self.revalidated = true;
                    Action::Revalidate
                } else {
                    Action::None
                };
            }
        }
        self.pending = Some((identity, failure, now));
        self.revalidated = false;
        Action::Warn
    }
}

fn confirmed_original<F: FnMut() -> Option<String>, W: FnMut()>(
    original: &str,
    mut read: F,
    mut wait: W,
) -> bool {
    for _ in 0..3 {
        wait();
        if read().as_deref() != Some(original) {
            return false;
        }
    }
    true
}

#[derive(Default)]
struct RedirectAttempts {
    previous: Option<(Identity, String, String, String, u8)>,
}
impl RedirectAttempts {
    fn confirm(
        &mut self,
        identity: &Identity,
        original: &str,
        target: &str,
        target_key: &str,
    ) -> bool {
        let entry = self.previous.get_or_insert_with(|| {
            (
                identity.clone(),
                original.into(),
                target.into(),
                target_key.into(),
                0,
            )
        });
        if entry.0 != *identity || entry.1 != original || entry.2 != target || entry.3 != target_key
        {
            *entry = (
                identity.clone(),
                original.into(),
                target.into(),
                target_key.into(),
                0,
            );
        }
        entry.4 = entry.4.saturating_add(1);
        entry.4 >= 2
    }
}
fn continuity_expired(previous: Instant, now: Instant, failure: Failure) -> bool {
    let maximum = if matches!(
        failure,
        Failure::PermissionDenied | Failure::BlockedUrlRemains
    ) {
        Duration::from_secs(35)
    } else {
        Duration::from_secs(3)
    };
    now.saturating_duration_since(previous) > maximum
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn each_qualifying_failure_requires_full_grace_and_a_fresh_observation() {
        for failure in [
            Failure::PermissionDenied,
            Failure::AccessPrevented,
            Failure::BlockedUrlRemains,
        ] {
            let now = Instant::now();
            let mut grace = Grace::default();
            assert_eq!(grace.observe(Some((id(), failure)), now), Action::Warn);
            assert_eq!(
                grace.observe(Some((id(), failure)), now + Duration::from_secs(59)),
                Action::None
            );
            assert_eq!(
                grace.observe(Some((id(), failure)), now + Duration::from_secs(60)),
                Action::Revalidate
            );
        }
    }
    #[test]
    fn pause_inactive_closed_unknown_allowed_and_blockpage_all_cancel() {
        for _reason in [
            "paused",
            "inactive",
            "browser closed",
            "unknown",
            "editing",
            "allowed URL",
            "block page",
            "focus race",
            "engine warmup",
            "missing ack",
        ] {
            let now = Instant::now();
            let mut grace = Grace::default();
            grace.observe(Some((id(), Failure::PermissionDenied)), now);
            assert_eq!(
                grace.observe(None, now + Duration::from_secs(61)),
                Action::Recover
            );
            assert_eq!(
                grace.observe(
                    Some((id(), Failure::PermissionDenied)),
                    now + Duration::from_secs(62)
                ),
                Action::Warn
            );
        }
    }
    #[test]
    fn stale_reports_break_continuity_for_each_failure() {
        let now = Instant::now();
        for failure in [
            Failure::PermissionDenied,
            Failure::AccessPrevented,
            Failure::BlockedUrlRemains,
        ] {
            assert!(continuity_expired(
                now,
                now + Duration::from_secs(60),
                failure
            ));
            assert!(!continuity_expired(
                now,
                now + Duration::from_secs(1),
                failure
            ));
        }
        assert!(!continuity_expired(
            now,
            now + Duration::from_secs(30),
            Failure::PermissionDenied
        ));
        assert!(continuity_expired(
            now,
            now + Duration::from_secs(36),
            Failure::PermissionDenied
        ));
        assert!(!continuity_expired(
            now,
            now + Duration::from_millis(2900),
            Failure::BlockedUrlRemains
        ));
    }
    #[test]
    fn redirect_confirmation_requires_same_instance_policy_urls_and_target() {
        for changed in 0..7 {
            let mut attempts = RedirectAttempts::default();
            let mut identity = id();
            assert!(!attempts.confirm(&identity, "source", "target", "window:1:tab:1"));
            let (mut original, mut target, mut key) = ("source", "target", "window:1:tab:1");
            match changed {
                0 => identity.pid += 1,
                1 => identity.started += 1,
                2 => identity.policy = "new".into(),
                3 => original = "different",
                4 => target = "different",
                5 => key = "window:2:tab:1",
                _ => identity.browser = "Firefox".into(),
            }
            assert!(!attempts.confirm(&identity, original, target, key));
            assert!(attempts.confirm(&identity, original, target, key));
        }
    }
    #[test]
    fn verification_is_bounded_and_requires_three_positive_reads() {
        let mut reads = 0;
        assert!(confirmed_original(
            "denied",
            || {
                reads += 1;
                Some("denied".into())
            },
            || {}
        ));
        assert_eq!(reads, 3);
        for uncertain in [
            None,
            Some("allowed".into()),
            Some("block-page".into()),
            Some("editing".into()),
        ] {
            let mut reads = 0;
            assert!(!confirmed_original(
                "denied",
                || {
                    reads += 1;
                    uncertain.clone()
                },
                || {}
            ));
            assert_eq!(reads, 1);
        }
    }
    #[test]
    fn repeated_deadline_reports_do_not_start_duplicate_close_workers() {
        let mut grace = Grace::default();
        let now = Instant::now();
        grace.observe(Some((id(), Failure::PermissionDenied)), now);
        assert_eq!(
            grace.observe(
                Some((id(), Failure::PermissionDenied)),
                now + Duration::from_secs(60)
            ),
            Action::Revalidate
        );
        assert_eq!(
            grace.observe(
                Some((id(), Failure::PermissionDenied)),
                now + Duration::from_secs(61)
            ),
            Action::None
        );
    }
    fn id() -> Identity {
        Identity {
            browser: "Chrome".into(),
            pid: 1,
            started: 2,
            policy: "p".into(),
        }
    }
    #[test]
    fn grace_requires_same_positive_evidence_at_deadline() {
        let mut g = Grace::default();
        let now = Instant::now();
        assert_eq!(
            g.observe(Some((id(), Failure::PermissionDenied)), now),
            Action::Warn
        );
        assert_eq!(
            g.observe(
                Some((id(), Failure::PermissionDenied)),
                now + Duration::from_secs(59)
            ),
            Action::None
        );
        assert_eq!(
            g.observe(
                Some((id(), Failure::PermissionDenied)),
                now + Duration::from_secs(60)
            ),
            Action::Revalidate
        );
    }
    #[test]
    fn uncertainty_cancels_instead_of_aging_into_failure() {
        let mut g = Grace::default();
        let now = Instant::now();
        g.observe(Some((id(), Failure::BlockedUrlRemains)), now);
        assert_eq!(
            g.observe(None, now + Duration::from_secs(90)),
            Action::Recover
        );
        assert_eq!(
            g.observe(
                Some((id(), Failure::BlockedUrlRemains)),
                now + Duration::from_secs(91)
            ),
            Action::Warn
        );
    }
    #[test]
    fn changed_process_policy_or_failure_starts_new_grace() {
        for field in 0..5 {
            let mut g = Grace::default();
            let now = Instant::now();
            g.observe(Some((id(), Failure::PermissionDenied)), now);
            let mut next = id();
            let mut failure = Failure::PermissionDenied;
            match field {
                0 => next.started += 1,
                1 => next.policy = "new".into(),
                2 => next.pid += 1,
                3 => next.browser = "Firefox".into(),
                _ => failure = Failure::AccessPrevented,
            }
            assert_eq!(
                g.observe(Some((next, failure)), now + Duration::from_secs(60)),
                Action::Warn
            );
        }
    }
}

// Existing transport workers report health here. There is no second browser
// scanner or permission poller. Unknown observations explicitly cancel grace.
mod runtime {
    use super::*;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Mutex, OnceLock};
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};
    use tauri::{AppHandle, Emitter, Manager};
    use tauri_plugin_notification::NotificationExt;
    static APP: OnceLock<AppHandle> = OnceLock::new();
    static NEXT_WARNING: AtomicU64 = AtomicU64::new(1);
    #[cfg(target_os = "macos")]
    static MAIN_PIDS: OnceLock<Mutex<HashMap<String, u32>>> = OnceLock::new();
    static HEALTH: OnceLock<Mutex<HashMap<String, serde_json::Value>>> = OnceLock::new();
    static STATES: OnceLock<Mutex<HashMap<String, Entry>>> = OnceLock::new();
    static ATTEMPTS: OnceLock<Mutex<HashMap<String, RedirectAttempts>>> = OnceLock::new();
    struct Entry {
        identity: Identity,
        grace: Grace,
        failure: Option<Failure>,
        observed_at: Instant,
        warning_id: u64,
        warning_visible: bool,
    }
    fn states() -> &'static Mutex<HashMap<String, Entry>> {
        STATES.get_or_init(Default::default)
    }
    pub fn start(app: AppHandle) {
        let _ = APP.set(app);
    }
    pub fn acknowledge_warning(warning_id: u64) -> bool {
        // An emitted event and notification.show(Ok) do not prove anybody
        // saw a warning. Only the frontend's rendered-warning acknowledgement
        // while the main window is visible arms the dormant close path.
        if APP
            .get()
            .and_then(|app| app.get_webview_window("main"))
            .and_then(|w| w.is_visible().ok())
            != Some(true)
        {
            return false;
        }
        let Ok(mut states) = states().lock() else {
            return false;
        };
        let Some(entry) = states
            .values_mut()
            .find(|entry| entry.warning_id == warning_id && warning_id != 0)
        else {
            return false;
        };
        if !entry.warning_visible {
            entry.warning_visible = true;
            // Give the user the full sixty seconds from visible delivery.
            entry.grace.pending = entry
                .failure
                .map(|failure| (entry.identity.clone(), failure, Instant::now()));
            entry.grace.revalidated = false;
        }
        true
    }
    pub fn record_health(transport: &str, status: &str, reason: Option<&str>) {
        if let Ok(mut health) = HEALTH.get_or_init(Default::default).lock() {
            health.insert(
                transport.into(),
                serde_json::json!({"status":status,"reason":reason}),
            );
        }
    }
    pub fn snapshot() -> serde_json::Value {
        let mut recovered = Vec::new();
        if let Ok(mut states) = states().lock() {
            states.retain(|_, entry| {
                let stale = entry.failure.is_some_and(|failure| {
                    continuity_expired(entry.observed_at, Instant::now(), failure)
                });
                if stale {
                    recovered.push(entry.identity.browser.clone());
                }
                !stale
            });
        }
        if let Some(app) = APP.get() {
            for browser in recovered {
                let _ = app.emit("native-enforcement-recovered", browser);
            }
        }
        let pending = states().lock().map(|states| states.values().filter_map(|entry| {
            let failure = entry.failure?;
            let remaining=if entry.warning_visible { entry.grace.pending.as_ref().map(|(_,_,since)|Duration::from_secs(60).saturating_sub(Instant::now().saturating_duration_since(*since))).unwrap_or_default() } else { Duration::from_secs(60) };
            let remaining_seconds=remaining.as_secs()+u64::from(remaining.subsec_nanos()>0);
            Some(serde_json::json!({"browser":entry.identity.browser,"pid":entry.identity.pid,"reason":format!("{failure:?}"),"diagnosticOnly":!signal_validated(failure),"warningId":entry.warning_id,"graceSeconds":remaining_seconds,"remainingGraceSeconds":remaining_seconds,"warningVisible":entry.warning_visible}))
        }).collect::<Vec<_>>()).unwrap_or_default();
        let health = HEALTH
            .get_or_init(Default::default)
            .lock()
            .map(|h| h.clone())
            .unwrap_or_default();
        serde_json::json!({"pendingWarnings":pending,"automaticBrowserClosingEnabled":false,"workerHealth":health})
    }
    fn instance_key(identity: &Identity) -> String {
        format!("{}:{}:{}", identity.browser, identity.pid, identity.started)
    }
    pub fn clear_browser(browser: &str) {
        if let Ok(mut states) = states().lock() {
            let mut removed = false;
            states.retain(|_, entry| {
                if entry.identity.browser == browser {
                    removed |= entry.grace.pending.is_some();
                    false
                } else {
                    true
                }
            });
            if removed {
                if let Some(app) = APP.get() {
                    let _ = app.emit("native-enforcement-recovered", browser);
                }
            }
        }
        if let Ok(mut attempts) = ATTEMPTS.get_or_init(Default::default).lock() {
            attempts.retain(|_, entry| {
                entry
                    .previous
                    .as_ref()
                    .map_or(true, |e| e.0.browser != browser)
            });
        }
    }
    pub fn recover_permission(browser: &str) {
        let mut recovered = false;
        if let Ok(mut states) = states().lock() {
            recovered = remove_permission_failures(&mut states, browser);
        }
        if recovered {
            if let Some(app) = APP.get() {
                let _ = app.emit("native-enforcement-recovered", browser);
            }
        }
    }
    fn remove_permission_failures(states: &mut HashMap<String, Entry>, browser: &str) -> bool {
        let mut removed = false;
        states.retain(|_, entry| {
            let remove = entry.identity.browser == browser
                && entry.failure == Some(Failure::PermissionDenied);
            removed |= remove;
            !remove
        });
        removed
    }
    pub fn clear_all() {
        let browsers = states()
            .lock()
            .map(|s| {
                s.values()
                    .map(|e| e.identity.browser.clone())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for browser in browsers {
            clear_browser(&browser);
        }
    }
    pub fn retain_browsers(browsers: &[&str]) {
        let removed = states()
            .lock()
            .map(|s| {
                s.values()
                    .filter(|e| !browsers.contains(&e.identity.browser.as_str()))
                    .map(|e| e.identity.browser.clone())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for browser in removed {
            clear_browser(&browser);
        }
    }
    fn policy(app: &AppHandle) -> Option<String> {
        let path = crate::commands::canonical_data_path(app)?;
        let data = crate::data_cache::read(&path)?;
        let settings = data.get("settings")?;
        if !settings
            .get("eulaAcceptedRevision")
            .and_then(|v| v.as_u64())
            .is_some_and(|r| r > 0)
            && settings.get("eulaAccepted").and_then(|v| v.as_bool()) != Some(true)
        {
            return None;
        }
        let (_, blocks) = crate::website_policy::derive_payload(&path);
        crate::block_page::web_enforcement_active(&blocks)
            .then(|| serde_json::to_string(&blocks).ok())
            .flatten()
    }
    fn identity(app: &AppHandle, browser: &str, pid: u32) -> Option<Identity> {
        let mut system = System::new();
        let pids = [sysinfo::Pid::from_u32(pid)];
        system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&pids),
            true,
            ProcessRefreshKind::nothing(),
        );
        let process = system.process(pids[0])?;
        let expected_name = match browser {
            "Chrome" => {
                if cfg!(target_os = "windows") {
                    "chrome.exe"
                } else {
                    "Google Chrome"
                }
            }
            "Edge" => {
                if cfg!(target_os = "windows") {
                    "msedge.exe"
                } else {
                    "Microsoft Edge"
                }
            }
            "Brave" => {
                if cfg!(target_os = "windows") {
                    "brave.exe"
                } else {
                    "Brave Browser"
                }
            }
            "Firefox" => {
                if cfg!(target_os = "windows") {
                    "firefox.exe"
                } else {
                    "firefox"
                }
            }
            "Safari" => "Safari",
            _ => return None,
        };
        if !process
            .name()
            .to_string_lossy()
            .eq_ignore_ascii_case(expected_name)
        {
            return None;
        }
        Some(Identity {
            browser: browser.into(),
            pid,
            started: process.start_time(),
            policy: policy(app)?,
        })
    }
    /// macOS has already resolved these main-process names in the existing
    /// running-browser sweep; renderer/helper names cannot match this lookup.
    #[cfg(target_os = "macos")]
    pub fn main_pid(browser: &str) -> Option<u32> {
        MAIN_PIDS
            .get_or_init(Default::default)
            .lock()
            .ok()?
            .get(browser)
            .copied()
    }
    #[cfg(target_os = "macos")]
    pub fn record_main_pid(browser: &str, pid: u32) {
        if let Ok(mut pids) = MAIN_PIDS.get_or_init(Default::default).lock() {
            pids.insert(browser.into(), pid);
        }
    }
    pub fn requires_revalidation(browser: &str) -> bool {
        states().lock().is_ok_and(|states| {
            states.values().any(|entry| {
                entry.identity.browser == browser
                    && entry.grace.revalidated
                    && entry.failure.is_some_and(signal_validated)
            })
        })
    }
    #[derive(Clone, serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Warning {
        browser: String,
        pid: u32,
        warning_id: u64,
        reason: String,
        grace_seconds: u64,
        diagnostic_only: bool,
    }
    // None of these OS failure signals has passed live validation. A pure
    // state-machine test cannot validate an OS transport or enable force quit.
    fn signal_validated(_failure: Failure) -> bool {
        false
    }
    pub fn report(app: &AppHandle, browser: &str, pid: u32, failure: Option<Failure>) {
        let Some(failure) = failure else {
            clear_browser(browser);
            return;
        };
        let Some(identity) = identity(app, browser, pid) else {
            clear_browser(browser);
            return;
        };
        let action = {
            let Ok(mut states) = states().lock() else {
                return;
            };
            let entry = states
                .entry(instance_key(&identity))
                .or_insert_with(|| Entry {
                    identity: identity.clone(),
                    grace: Grace::default(),
                    failure: None,
                    observed_at: Instant::now(),
                    warning_id: 0,
                    warning_visible: false,
                });
            if continuity_expired(entry.observed_at, Instant::now(), failure) {
                entry.grace = Grace::default();
            }
            entry.observed_at = Instant::now();
            entry.identity = identity.clone();
            entry.failure = Some(failure);
            let action = entry
                .grace
                .observe(Some((identity.clone(), failure)), Instant::now());
            if action == Action::Warn {
                entry.warning_id = NEXT_WARNING.fetch_add(1, Ordering::Relaxed);
                entry.warning_visible = false;
            }
            action
        };
        match action {
            Action::Warn => {
                let diagnostic_only = !signal_validated(failure);
                let _ = app.emit(
                    "native-enforcement-warning",
                    Warning {
                        browser: browser.into(),
                        pid,
                        warning_id: states()
                            .lock()
                            .ok()
                            .and_then(|s| s.get(&instance_key(&identity)).map(|e| e.warning_id))
                            .unwrap_or_default(),
                        reason: format!("{failure:?}"),
                        grace_seconds: 60,
                        diagnostic_only,
                    },
                );
                if app
                    .get_webview_window("main")
                    .and_then(|w| w.is_visible().ok())
                    != Some(true)
                {
                    let body = if diagnostic_only {
                        format!("{browser} needs browser access restored. Open Digital Habits: Blocker to recover. Automatic browser closing is not enabled for this diagnostic signal.")
                    } else {
                        format!("Restore browser access in Digital Habits: Blocker. {browser} will close in 60 seconds if blocking cannot recover.")
                    };
                    let _ = app
                        .notification()
                        .builder()
                        .title("Website blocking needs attention")
                        .body(body)
                        .show();
                }
            }
            Action::Revalidate if signal_validated(failure) => {
                let app = app.clone();
                std::thread::spawn(move || close_after_revalidation(&app, &identity, failure));
            }
            _ => {}
        }
    }
    fn same_instance_policy(app: &AppHandle, expected: &Identity, failure: Failure) -> bool {
        if identity(app, &expected.browser, expected.pid).as_ref() != Some(expected) {
            return false;
        }
        states()
            .lock()
            .ok()
            .and_then(|s| {
                s.get(&instance_key(expected)).map(|e| {
                    e.identity == *expected
                        && e.warning_visible
                        && e.failure == Some(failure)
                        && !continuity_expired(e.observed_at, Instant::now(), failure)
                })
            })
            .unwrap_or(false)
    }
    fn close_after_revalidation(app: &AppHandle, expected: &Identity, failure: Failure) {
        let fresh_since = Instant::now() - Duration::from_secs(3);
        if !signal_validated(failure) || !fresh_evidence_since(app, expected, failure, fresh_since)
        {
            return;
        }
        let polite_started = Instant::now();
        #[cfg(target_os = "windows")]
        let child = {
            use std::os::windows::process::CommandExt;
            std::process::Command::new("taskkill")
                .args(["/PID", &expected.pid.to_string()])
                .creation_flags(0x08000000)
                .spawn()
        };
        #[cfg(target_os = "macos")]
        if !request_macos_quit(expected.pid) {
            return;
        }
        #[cfg(target_os = "windows")]
        if let Ok(mut child) = child {
            let deadline = Instant::now() + Duration::from_secs(10);
            while Instant::now() < deadline {
                if !same_instance_policy(app, expected, failure) {
                    let _ = child.kill();
                    let _ = child.try_wait();
                    return;
                }
                // Wait for the browser, not merely the helper's exit.
                std::thread::sleep(Duration::from_millis(100));
            }
            if child.try_wait().ok().flatten().is_none() {
                let _ = child.kill();
            }
            let _ = child.try_wait();
        } else {
            return;
        }
        #[cfg(target_os = "macos")]
        {
            let deadline = Instant::now() + Duration::from_secs(10);
            while Instant::now() < deadline {
                if !same_instance_policy(app, expected, failure) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
        if fresh_evidence_since(app, expected, failure, polite_started) {
            let mut system = System::new();
            let pids = [sysinfo::Pid::from_u32(expected.pid)];
            system.refresh_processes_specifics(
                ProcessesToUpdate::Some(&pids),
                true,
                ProcessRefreshKind::nothing(),
            );
            if let Some(process) = system.process(pids[0]) {
                if process.start_time() == expected.started {
                    process.kill();
                }
            }
        }
    }
    #[cfg(target_os = "macos")]
    fn request_macos_quit(pid: u32) -> bool {
        // PID-targeted normal AppKit quit, without activating the browser.
        // A failed lookup/request aborts escalation; it is not permission
        // evidence and must not be silently replaced by a termination signal.
        use cocoa::base::{id, BOOL, YES};
        use objc::runtime::Class;
        use objc::{msg_send, sel, sel_impl};
        objc::rc::autoreleasepool(|| unsafe {
            let Some(class) = Class::get("NSRunningApplication") else {
                return false;
            };
            let app: id = msg_send![class,runningApplicationWithProcessIdentifier:pid as i32];
            if app.is_null() {
                return false;
            }
            let requested: BOOL = msg_send![app, terminate];
            requested == YES
        })
    }
    fn fresh_evidence_since(
        app: &AppHandle,
        expected: &Identity,
        failure: Failure,
        since: Instant,
    ) -> bool {
        same_instance_policy(app, expected, failure)
            && states().lock().is_ok_and(|states| {
                states.get(&instance_key(expected)).is_some_and(|entry| {
                    entry.observed_at >= since
                        && entry.observed_at.elapsed() <= Duration::from_secs(3)
                })
            })
    }
    /// Bounded readback without focus changes. An absent answer, a focused
    /// editor, a window switch, or a new policy cancels, never ages into failure.
    /// Settles for 500ms, then performs at most three reads 200ms apart.
    /// UIA/AX add no focus changes; AppleEvents reads each already have an
    /// 8-second process timeout, so their absolute bound is 25.1 seconds.
    /// Repeated positive original-URL reads across two completed redirect
    /// attempts are required; a missing navigation acknowledgment is not proof.
    /// AppleEvents verifies only the first action in a batch. Its window/tab
    /// indices and Firefox's active-tab target are not validated stable OS
    /// identities: those signals MUST remain diagnostic-only until live tests
    /// establish target continuity. This code alone cannot enable force quit.
    pub fn verify_redirect<F: FnMut() -> Option<String>>(
        app: &AppHandle,
        browser: &str,
        pid: u32,
        original: &str,
        target: &str,
        target_key: &str,
        mut read: F,
    ) {
        let Some(before) = identity(app, browser, pid) else {
            clear_browser(browser);
            return;
        };
        std::thread::sleep(Duration::from_millis(500));
        let confirmed = confirmed_original(original, &mut read, || {
            std::thread::sleep(Duration::from_millis(200))
        });
        if !confirmed || identity(app, browser, pid).as_ref() != Some(&before) {
            clear_browser(browser);
            return;
        }
        let confirmed = {
            let Ok(mut attempts) = ATTEMPTS.get_or_init(Default::default).lock() else {
                return;
            };
            attempts
                .entry(instance_key(&before))
                .or_default()
                .confirm(&before, original, target, target_key)
        };
        if confirmed {
            report(app, browser, pid, Some(Failure::BlockedUrlRemains));
        }
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn all_unvalidated_os_signals_cannot_enable_the_executor() {
            for failure in [
                Failure::PermissionDenied,
                Failure::AccessPrevented,
                Failure::BlockedUrlRemains,
            ] {
                assert!(!signal_validated(failure));
            }
        }
        #[test]
        fn permission_recovery_preserves_redirect_failure_and_other_browser_instance() {
            let mut states = HashMap::new();
            for (browser, pid, failure) in [
                ("Chrome", 1, Failure::PermissionDenied),
                ("Chrome", 2, Failure::BlockedUrlRemains),
                ("Firefox", 3, Failure::PermissionDenied),
            ] {
                let identity = Identity {
                    browser: browser.into(),
                    pid,
                    started: 1,
                    policy: "policy".into(),
                };
                let mut grace = Grace::default();
                grace.observe(Some((identity.clone(), failure)), Instant::now());
                states.insert(
                    instance_key(&identity),
                    Entry {
                        identity,
                        grace,
                        failure: Some(failure),
                        observed_at: Instant::now(),
                        warning_id: 0,
                        warning_visible: false,
                    },
                );
            }
            assert_eq!(states.len(), 3);
            assert!(remove_permission_failures(&mut states, "Chrome"));
            assert_eq!(states.len(), 2);
            assert!(states.values().any(|e| e.identity.pid == 2));
            assert!(states.values().any(|e| e.identity.pid == 3));
        }
    }
}
pub use runtime::{
    clear_all, clear_browser, record_health, recover_permission, report, requires_revalidation,
    retain_browsers, snapshot, start, verify_redirect,
};

#[tauri::command]
pub fn native_warning_visible(warning_id: u64) -> bool {
    runtime::acknowledge_warning(warning_id)
}

#[tauri::command]
pub fn native_website_status() -> serde_json::Value {
    runtime::snapshot()
}
#[cfg(target_os = "macos")]
pub use runtime::{main_pid, record_main_pid};
