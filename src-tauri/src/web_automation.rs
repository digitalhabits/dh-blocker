// JOMO-style website blocking via macOS automation (Apple Events).
//
// Instead of relying on a browser extension to redirect blocked sites,
// this module drives Safari and Chromium-based browsers (Chrome, Brave,
// Edge) directly with AppleScript: every TICK it reads each *running*
// supported browser's open-tab URLs, and for any tab sitting on a
// blocked domain it sets that tab's URL to the bundled block page —
// the exact same `blocked.html` the extension uses, just reached via a
// `file://` URL with the same query params. When a site is no longer
// blocked (ended / paused / allowlist changed), tabs still parked on
// the block page are restored to their original URL — same rule as the
// extension's `restoreUnblockedTabs`.
//
// This is the macOS replacement for the extension on Safari + Chromium.
// Firefox has no usable scripting dictionary, so it stays on the
// extension + enforcer path (see enforcer.rs). Windows has a narrower
// counterpart for policy-managed PCs in uia_web_automation.rs; the URL
// decisions both share live in block_page.rs.
//
// Trade-off vs. the extension path: this requires **Automation** TCC
// permission ("ReDD Blocker wants to control Google Chrome"). The first
// Apple Event to each browser surfaces the system prompt; if the user
// denies it, osascript returns -1743 and we surface a
// `web-automation://permission-needed` event the UI turns into a
// "grant access" affordance. The hardened-runtime entitlement
// `com.apple.security.automation.apple-events` (entitlements.macos.plist)
// is what makes the signed build allowed to ask at all.
//
// Structurally this mirrors app_watcher.rs: one polling thread, a
// shared enabled flag, and graceful per-tick work. The blocked-domain
// list is read straight from the canonical data file via
// `native_host::derive_payload` — the same single source of truth the
// extension's native host and the enforcer use.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::block_page::{plan_actions, Tab};
pub use crate::block_page::{url_is_blocked, web_enforcement_active};
use crate::native_host::{self, BlockInfo};

/// How often we sweep running browsers. 1s keeps redirects feeling
/// near-instant (type a blocked URL, get bounced within a tick) without
/// the cost of scripting browsers that aren't running — we only ever
/// send Apple Events to browsers `sysinfo` reports as alive.
const TICK: Duration = Duration::from_millis(1000);

/// Cadence for browsers that are running but NOT frontmost while
/// workspace events are active. Only the frontmost browser is scripted
/// every tick — the user can't see a background browser's tabs, and a
/// blocked tab parked there is bounced within one tick of the browser
/// being activated (the activation updates `frontmost_bundle_id`
/// immediately). The slower full pass still catches background
/// navigation (media/JS opening a blocked site in a hidden window).
const BACKGROUND_BROWSER_TICK: Duration = Duration::from_secs(5);

/// Once a browser's Automation permission is denied, stop hammering
/// osascript every second (each call just returns -1743 until the user
/// changes System Settings). Re-probe at this cadence so a later grant
/// is picked up without a restart.
const DENIED_RETRY: Duration = Duration::from_secs(30);
/// While a block is active we retry sooner — the user may have just
/// toggled Automation on in System Settings.
const DENIED_RETRY_WHILE_BLOCKING: Duration = Duration::from_secs(5);

/// Serialize every Apple Event / osascript call. Concurrent access from
/// the automation tick (background thread), the enforcer, and Tauri
/// commands on the main thread can deadlock macOS's AppleEvent manager
/// and freeze the app (beach ball).
static APPLE_EVENTS: Mutex<()> = Mutex::new(());

/// Cap osascript waits so a browser waiting on an Automation consent
/// dialog cannot block the watcher thread indefinitely.
const OSASCRIPT_TIMEOUT: Duration = Duration::from_secs(8);

/// Minimum gap between launch probes for the same browser while it is
/// closed. Avoids relaunching a force-closed browser on every UI poll.
const IDLE_LAUNCH_PROBE_COOLDOWN: Duration = Duration::from_secs(20);

static IDLE_LAUNCH_PROBE_AT: OnceLock<Mutex<HashMap<SupportedBrowser, Instant>>> = OnceLock::new();

fn idle_launch_probe_at() -> &'static Mutex<HashMap<SupportedBrowser, Instant>> {
    IDLE_LAUNCH_PROBE_AT.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
pub enum SupportedBrowser {
    Safari,
    Chrome,
    Brave,
    Edge,
}

impl SupportedBrowser {
    pub fn all() -> [SupportedBrowser; 4] {
        [
            SupportedBrowser::Safari,
            SupportedBrowser::Chrome,
            SupportedBrowser::Brave,
            SupportedBrowser::Edge,
        ]
    }

    pub fn label(self) -> &'static str {
        match self {
            SupportedBrowser::Safari => "Safari",
            SupportedBrowser::Chrome => "Chrome",
            SupportedBrowser::Brave => "Brave",
            SupportedBrowser::Edge => "Edge",
        }
    }

    /// Settings key (`chrome`, `edge`, …) for blocking-method lookups.
    pub fn settings_key(self) -> &'static str {
        match self {
            SupportedBrowser::Safari => "safari",
            SupportedBrowser::Chrome => "chrome",
            SupportedBrowser::Brave => "brave",
            SupportedBrowser::Edge => "edge",
        }
    }

    /// Name used in `tell application "<name>"`. Must match the app's
    /// registered name exactly or the Apple Event won't reach it.
    fn applescript_name(self) -> &'static str {
        match self {
            SupportedBrowser::Safari => "Safari",
            SupportedBrowser::Chrome => "Google Chrome",
            SupportedBrowser::Brave => "Brave Browser",
            SupportedBrowser::Edge => "Microsoft Edge",
        }
    }

    /// Main-process name as reported by sysinfo on macOS (bundle binary).
    /// Suffix-matched so renderer/helper processes ("Google Chrome
    /// Helper") don't count as the browser being open.
    fn process_name(self) -> &'static str {
        match self {
            SupportedBrowser::Safari => "Safari",
            SupportedBrowser::Chrome => "Google Chrome",
            SupportedBrowser::Brave => "Brave Browser",
            SupportedBrowser::Edge => "Microsoft Edge",
        }
    }

    /// CFBundleIdentifier — the key TCC stores the Automation decision
    /// under, and what we hand `AEDeterminePermissionToAutomateTarget`
    /// to read that decision back without prompting.
    pub fn bundle_id(self) -> &'static str {
        match self {
            SupportedBrowser::Safari => "com.apple.Safari",
            SupportedBrowser::Chrome => "com.google.Chrome",
            SupportedBrowser::Brave => "com.brave.Browser",
            SupportedBrowser::Edge => "com.microsoft.edgemac",
        }
    }
}

/// Read the current Automation (Apple Events) permission decision for a
/// browser **without surfacing the consent prompt**.
///
/// macOS records the decision per (source app, target app) permanently,
/// but the TCC database is SIP-protected and unreadable. The only public
/// API that reports the decision is `AEDeterminePermissionToAutomateTarget`;
/// called with `askUserIfNeeded: false` it answers silently:
///   - `Granted`  — an Apple Event would succeed,
///   - `Denied`   — the user denied it (or revoked it in System Settings),
///   - `Unknown`  — not decided yet, target not running, or query error.
///
/// Only `Denied` is a positive "automation is off" signal; callers must
/// not treat `Unknown` as off (mirrors the enforcer's rule against acting
/// on unmeasurable state).
#[cfg(target_os = "macos")]
pub fn query_automation_permission(browser: SupportedBrowser) -> PermState {
    // TCC read only — do not take APPLE_EVENTS here. That mutex is for
    // osascript serialization; holding it during AEDeterminePermission…
    // (especially from UI polling every ~2s) starved the blocking tick.
    match tcc::permission_status(browser.bundle_id()) {
        0 => PermState::Granted,    // noErr
        -1743 => PermState::Denied, // errAEEventNotPermitted
        _ => PermState::Unknown,    // -1744 not-decided, -600 not-running, errors
    }
}

#[cfg(not(target_os = "macos"))]
pub fn query_automation_permission(_browser: SupportedBrowser) -> PermState {
    PermState::Unknown
}

/// Minimal FFI to `AEDeterminePermissionToAutomateTarget` (CoreServices /
/// AppleEvents). Builds an address descriptor that targets the browser by
/// bundle id and asks for the *general* automation decision via wildcard
/// event class/id.
#[cfg(target_os = "macos")]
mod tcc {
    use std::os::raw::c_void;

    // OSType four-char codes, big-endian packed.
    const TYPE_APPLICATION_BUNDLE_ID: u32 = u32::from_be_bytes(*b"bund");
    const TYPE_WILDCARD: u32 = u32::from_be_bytes(*b"****");

    #[repr(C)]
    struct AEDesc {
        descriptor_type: u32,
        data_handle: *mut c_void,
    }

    #[link(name = "CoreServices", kind = "framework")]
    extern "C" {
        fn AECreateDesc(
            type_code: u32,
            data_ptr: *const c_void,
            data_size: isize,
            result: *mut AEDesc,
        ) -> i16; // OSErr
        fn AEDisposeDesc(desc: *mut AEDesc) -> i16; // OSErr
        fn AEDeterminePermissionToAutomateTarget(
            target: *const AEDesc,
            the_ae_event_class: u32,
            the_ae_event_id: u32,
            ask_user_if_needed: u8, // Boolean
        ) -> i32; // OSStatus
    }

    /// Returns the raw OSStatus: 0 granted, -1743 denied, -1744
    /// not-determined, -600 target not running, other = error.
    pub fn permission_status(bundle_id: &str) -> i32 {
        unsafe {
            let mut target = AEDesc {
                descriptor_type: 0,
                data_handle: std::ptr::null_mut(),
            };
            let bytes = bundle_id.as_bytes();
            let create = AECreateDesc(
                TYPE_APPLICATION_BUNDLE_ID,
                bytes.as_ptr() as *const c_void,
                bytes.len() as isize,
                &mut target,
            );
            if create != 0 {
                return create as i32;
            }
            let status = AEDeterminePermissionToAutomateTarget(
                &target,
                TYPE_WILDCARD,
                TYPE_WILDCARD,
                0, // askUserIfNeeded = false → never prompts
            );
            AEDisposeDesc(&mut target);
            status
        }
    }
}

/// Per-browser Automation-permission state, surfaced to the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PermState {
    /// Not yet probed this session.
    Unknown,
    /// An Apple Event succeeded — we can read/redirect tabs.
    Granted,
    /// osascript returned -1743 (user denied or hasn't granted yet).
    Denied,
}

#[derive(Debug, Clone, Serialize)]
pub struct PermissionInfo {
    pub browser: SupportedBrowser,
    pub label: &'static str,
    pub state: PermState,
    /// Whether the browser's main process is running right now — the
    /// same signal the permission probe uses (suffix match on bundle
    /// executable). Surfaces to the setup banner so it doesn't rely on
    /// a separate profile-scan `present` flag that can disagree.
    pub running: bool,
}

#[derive(Debug)]
struct BrowserRuntime {
    state: PermState,
    /// Earliest instant we'll re-attempt an Apple Event after a denial.
    next_attempt: Instant,
}

impl Default for BrowserRuntime {
    fn default() -> Self {
        BrowserRuntime {
            state: PermState::Unknown,
            next_attempt: Instant::now(),
        }
    }
}

#[derive(Default)]
struct Shared {
    enabled: bool,
    runtimes: HashMap<SupportedBrowser, BrowserRuntime>,
}

/// Handle returned from `start`. Drop it (or call `set_enabled(false)`)
/// to make the loop go idle.
pub struct WebAutomationHandle {
    shared: Arc<Mutex<Shared>>,
}

impl WebAutomationHandle {
    pub fn set_enabled(&self, enabled: bool) {
        if let Ok(mut s) = self.shared.lock() {
            s.enabled = enabled;
        }
    }

    /// Snapshot of per-browser permission state for the diagnostics /
    /// onboarding UI. Browsers never probed this session report Unknown.
    pub fn permission_status(&self) -> Vec<PermissionInfo> {
        let guard = self.shared.lock().ok();
        let running: std::collections::HashSet<_> =
            running_supported_browsers().into_iter().collect();
        SupportedBrowser::all()
            .into_iter()
            .map(|b| {
                let state = guard
                    .as_ref()
                    .and_then(|s| s.runtimes.get(&b))
                    .map(|r| r.state)
                    .unwrap_or(PermState::Unknown);
                PermissionInfo {
                    browser: b,
                    label: b.label(),
                    state,
                    running: running.contains(&b),
                }
            })
            .collect()
    }

    /// Persist a permission probe result so the watcher tick and UI agree.
    pub fn record_permission(&self, browser: SupportedBrowser, state: PermState) {
        if let Ok(mut s) = self.shared.lock() {
            let rt = s.runtimes.entry(browser).or_default();
            let prev = rt.state;
            rt.state = state;
            // Only arm the denial backoff on a fresh transition — UI
            // polls every ~2.5 s and must not keep pushing retries back.
            if state == PermState::Denied && prev != PermState::Denied {
                rt.next_attempt = Instant::now() + DENIED_RETRY;
            }
        }
    }
}

/// Spawn the automation loop. `block_page_url` is the `file://` base URL
/// of the bundled blocked.html (no query string), resolved once by the
/// caller from the Tauri resource dir.
pub fn start(app: AppHandle, block_page_url: String) -> WebAutomationHandle {
    let shared = Arc::new(Mutex::new(Shared::default()));
    let shared_thread = shared.clone();
    std::thread::spawn(move || {
        // When true, the next idle ticks run a full restore sweep for
        // tabs still parked on blocked.html. Set while website
        // enforcement is active; cleared only after a full pass that
        // planned no restores (so a failed apply retries). Starting
        // true clears leftovers from a previous session.
        let mut needs_restore = true;
        // When the last full pass (all running browsers, not just the
        // frontmost one) was scripted — drives BACKGROUND_BROWSER_TICK.
        let mut last_full_pass: Option<Instant> = None;
        loop {
            std::thread::sleep(TICK);
            let enabled = shared_thread.lock().map(|s| s.enabled).unwrap_or(false);
            if !enabled {
                continue;
            }
            // Displays off → nobody can see a blocked tab. Skip all
            // Apple Events (and the data-file stat) until wake; the
            // first tick after wake redirects/restores as needed.
            if crate::workspace_events::screen_asleep() {
                continue;
            }
            tick(
                &app,
                &shared_thread,
                &block_page_url,
                &mut needs_restore,
                &mut last_full_pass,
            );
        }
    });
    WebAutomationHandle { shared }
}

fn tick(
    app: &AppHandle,
    shared: &Arc<Mutex<Shared>>,
    block_page_url: &str,
    needs_restore: &mut bool,
    last_full_pass: &mut Option<Instant>,
) {
    let mut io = ProductionAutomationIo { app };
    tick_with_io(
        &mut io,
        shared,
        block_page_url,
        needs_restore,
        last_full_pass,
        Instant::now(),
    );
}

/// I/O required by the stateful Automation orchestration. Keeping this seam
/// below `plan_actions` lets unit tests exercise the real latch, cadence, and
/// retry behavior without starting browsers or touching the data file.
trait AutomationIo {
    fn active_blocks(&mut self) -> Option<Vec<BlockInfo>>;
    fn events_active(&self) -> bool;
    fn frontmost_bundle_id(&self) -> Option<String>;
    fn running_browsers(&mut self) -> Vec<SupportedBrowser>;
    fn uses_automation(&mut self, browser: SupportedBrowser) -> bool;
    fn read_tabs(&mut self, browser: SupportedBrowser) -> Result<Vec<Tab>, AutomationError>;
    fn apply_actions(
        &mut self,
        browser: SupportedBrowser,
        actions: &[(u32, u32, String)],
    ) -> Result<(), AutomationError>;
    fn set_permission(
        &mut self,
        shared: &Arc<Mutex<Shared>>,
        browser: SupportedBrowser,
        state: PermState,
        denied_retry: Duration,
        now: Instant,
    );
}

struct ProductionAutomationIo<'a> {
    app: &'a AppHandle,
}

impl AutomationIo for ProductionAutomationIo<'_> {
    fn active_blocks(&mut self) -> Option<Vec<BlockInfo>> {
        let path = crate::commands::canonical_data_path(self.app)?;
        let (_domains, blocks) = native_host::derive_payload(&path);
        Some(blocks)
    }

    fn events_active(&self) -> bool {
        crate::workspace_events::events_active()
    }

    fn frontmost_bundle_id(&self) -> Option<String> {
        crate::workspace_events::frontmost_bundle_id()
    }

    fn running_browsers(&mut self) -> Vec<SupportedBrowser> {
        running_supported_browsers()
    }

    fn uses_automation(&mut self, browser: SupportedBrowser) -> bool {
        let key = browser.settings_key();
        crate::blocking_method::uses_automation(self.app, key)
    }

    fn read_tabs(&mut self, browser: SupportedBrowser) -> Result<Vec<Tab>, AutomationError> {
        read_tabs(browser)
    }

    fn apply_actions(
        &mut self,
        browser: SupportedBrowser,
        actions: &[(u32, u32, String)],
    ) -> Result<(), AutomationError> {
        apply_actions(browser, actions)
    }

    fn set_permission(
        &mut self,
        shared: &Arc<Mutex<Shared>>,
        browser: SupportedBrowser,
        state: PermState,
        denied_retry: Duration,
        now: Instant,
    ) {
        set_perm_inner_at(self.app, shared, browser, state, denied_retry, now);
    }
}

fn tick_with_io<I: AutomationIo>(
    io: &mut I,
    shared: &Arc<Mutex<Shared>>,
    block_page_url: &str,
    needs_restore: &mut bool,
    last_full_pass: &mut Option<Instant>,
    now: Instant,
) {
    let Some(blocks) = io.active_blocks() else {
        return;
    };
    let blocking_active = web_enforcement_active(&blocks);

    // While enforcement is on, keep the idle-restore latch armed so a
    // later pause/stop/expiry sweeps parked tabs. When enforcement is
    // off and the latch is clear, stay completely idle (no Apple Events).
    if blocking_active {
        *needs_restore = true;
    } else if !*needs_restore {
        return;
    }
    // Idle restore must script every running browser (not just frontmost).
    let restore_pass = !blocking_active && *needs_restore;

    // Frontmost-aware cadence. The browser the user is looking at is
    // scripted every tick; the rest ride BACKGROUND_BROWSER_TICK. When
    // events aren't installed (or the frontmost app is unknown) every
    // tick is a full pass — the pre-events behavior.
    let events = io.events_active();
    let frontmost_bid = if events {
        io.frontmost_bundle_id()
    } else {
        None
    };
    let frontmost_browser = frontmost_bid.as_deref().and_then(|bid| {
        SupportedBrowser::all()
            .into_iter()
            .find(|b| b.bundle_id() == bid)
    });
    let full_pass = restore_pass
        || !events
        || frontmost_bid.is_none()
        || last_full_pass
            .map(|t| now.saturating_duration_since(t) >= BACKGROUND_BROWSER_TICK)
            .unwrap_or(true);

    // Nothing due this tick: the frontmost app isn't an automation
    // browser and the background cadence hasn't elapsed. Skip even the
    // process scan.
    if !full_pass && frontmost_browser.is_none() {
        return;
    }

    // Frontmost-only ticks skip the sysinfo process scan entirely — a
    // frontmost browser is by definition running.
    let candidates = if full_pass {
        io.running_browsers()
    } else {
        frontmost_browser.into_iter().collect()
    };
    if full_pass {
        *last_full_pass = Some(now);
    }

    let running = candidates
        .into_iter()
        .filter(|browser| io.uses_automation(*browser))
        .collect::<Vec<_>>();
    let no_automation_browsers = running.is_empty();
    // Count every action a restore pass *planned*, not just the ones that
    // reported an error. `apply_actions` wraps each `set URL` in its own
    // AppleScript `try`, so a stale window/tab index is swallowed and the
    // batch still returns Ok while the tab stays parked on the block page.
    // Clearing the latch on Ok would strand that tab until the next block
    // re-arms it; keeping it armed costs one extra tick and re-plans from a
    // fresh read.
    let mut restore_actions = 0usize;
    let mut scanned = 0usize;
    for browser in running {
        // Respect the denial backoff so we don't spawn osascript every
        // second only to get -1743 back. While a block is active, retry
        // sooner so a fresh Automation grant is picked up quickly.
        let skip = shared
            .lock()
            .ok()
            .and_then(|s| s.runtimes.get(&browser).map(|r| (r.state, r.next_attempt)))
            .map(|(state, next)| state == PermState::Denied && now < next)
            .unwrap_or(false);
        if skip {
            continue;
        }

        match io.read_tabs(browser) {
            Ok(tabs) => {
                scanned += 1;
                io.set_permission(shared, browser, PermState::Granted, Duration::ZERO, now);
                let actions = plan_actions(&tabs, &blocks, block_page_url);
                if restore_pass {
                    restore_actions += actions.len();
                }
                if actions.is_empty() {
                    log::debug!(
                        "web_automation: {} — {} tab(s), {} blocked domain(s), nothing to do",
                        browser.label(),
                        tabs.len(),
                        blocks.len()
                    );
                } else {
                    match io.apply_actions(browser, &actions) {
                        Ok(()) => log::info!(
                            "web_automation: applied {} tab action(s) to {} (redirect to / restore from block page)",
                            actions.len(),
                            browser.label()
                        ),
                        Err(e) => {
                            log::warn!(
                                "web_automation: applying {} redirect(s) to {} failed: {e:?}",
                                actions.len(),
                                browser.label()
                            );
                            if matches!(e, AutomationError::NotAuthorized) {
                                let retry = if blocking_active {
                                    DENIED_RETRY_WHILE_BLOCKING
                                } else {
                                    DENIED_RETRY
                                };
                                io.set_permission(
                                    shared,
                                    browser,
                                    PermState::Denied,
                                    retry,
                                    now,
                                );
                            }
                        }
                    }
                }
            }
            Err(AutomationError::NotAuthorized) => {
                let retry = if blocking_active {
                    DENIED_RETRY_WHILE_BLOCKING
                } else {
                    DENIED_RETRY
                };
                io.set_permission(shared, browser, PermState::Denied, retry, now);
            }
            Err(AutomationError::Other(msg)) => {
                // Transient (browser quitting mid-tick, AppleScript
                // hiccup) — don't flip the permission state on these.
                log::debug!(
                    "web_automation: read tabs for {} failed: {msg}",
                    browser.label()
                );
            }
        }
    }

    // Idle restore latch: clear only after a full pass that found
    // nothing left to restore (and we actually scanned, or there were
    // no automation browsers to scan). Denial-backoff skips must not
    // clear the latch — retry next tick. Matches the extension's
    // restoreUnblockedTabs retry-until-clean behavior.
    if restore_pass && full_pass && restore_actions == 0 && (scanned > 0 || no_automation_browsers)
    {
        *needs_restore = false;
    }
}

fn set_perm_inner_at(
    app: &AppHandle,
    shared: &Arc<Mutex<Shared>>,
    browser: SupportedBrowser,
    new_state: PermState,
    denied_retry: Duration,
    now: Instant,
) {
    let mut transitioned_to = None;
    if let Ok(mut s) = shared.lock() {
        let rt = s.runtimes.entry(browser).or_default();
        if rt.state != new_state {
            rt.state = new_state;
            transitioned_to = Some(new_state);
        }
        if new_state == PermState::Denied {
            rt.next_attempt = now + denied_retry;
        }
    }
    match transitioned_to {
        Some(PermState::Denied) => {
            log::info!(
                "web_automation: {} Automation permission denied",
                browser.label()
            );
            let _ = app.emit(
                "web-automation://permission-needed",
                PermissionInfo {
                    browser,
                    label: browser.label(),
                    state: PermState::Denied,
                    running: true,
                },
            );
        }
        Some(PermState::Granted) => {
            log::info!(
                "web_automation: {} Automation permission granted",
                browser.label()
            );
            let _ = app.emit(
                "web-automation://permission-resolved",
                PermissionInfo {
                    browser,
                    label: browser.label(),
                    state: PermState::Granted,
                    running: true,
                },
            );
        }
        _ => {}
    }
}

pub fn running_supported_browsers() -> Vec<SupportedBrowser> {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};
    let mut sys = System::new();
    // Name matching only — skip the default per-process CPU/memory/disk/
    // exe/cmdline refresh, which is system-wide work this 1 s tick (and
    // the UI's permission polling) would otherwise repeat forever.
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
    let mut out = Vec::new();
    for browser in SupportedBrowser::all() {
        let needle = browser.process_name().to_ascii_lowercase();
        let running = sys.processes().values().any(|p| {
            p.name()
                .to_string_lossy()
                .to_ascii_lowercase()
                .ends_with(&needle)
        });
        if running {
            out.push(browser);
        }
    }
    out
}

// ---- AppleScript ----------------------------------------------------------

#[derive(Debug)]
enum AutomationError {
    /// osascript returned -1743 / "Not authorized to send Apple events".
    NotAuthorized,
    Other(String),
}

/// Field/record separators for the read script's output. Tab and
/// linefeed never appear inside a URL, so parsing back is unambiguous.
const FIELD_SEP: char = '\t';

fn read_tabs(browser: SupportedBrowser) -> Result<Vec<Tab>, AutomationError> {
    let app_name = browser.applescript_name();
    // The `is running` guard keeps the read from *launching* the browser
    // if it quit between the sysinfo check and now (referencing the
    // `running` property does not launch the app).
    // NOTE: `tab` and `linefeed` are resolved at the TOP LEVEL here, before the
    // `tell application` block. Inside a browser `tell` block the bare word
    // `tab` binds to the app's `tab` *element class* (Safari/Chrome both define
    // it), so `... & tab & ...` would concatenate the literal text "tab"
    // instead of an ASCII-9 separator and the Rust parser would drop every row.
    // Hoisting into `_sep`/`_eol` keeps them as real control characters.
    //
    // PERF: `URL of every tab of w` fetches a whole window's tab URLs in
    // ONE Apple Event; the inner repeat then walks a local list with no
    // further IPC. The previous per-tab `URL of t` cost one Apple Event
    // round-trip per tab per tick — with many tabs open, by far the
    // dominant CPU/battery cost of this watcher, on both sides of the
    // event. Tab indices are positional in the returned list, matching
    // the `tab <i> of window <w>` addressing `apply_actions` uses.
    // Safari reports `missing value` for empty tabs; the `as text`
    // coercion is wrapped in `try` so those rows degrade to "".
    let script = format!(
        r#"set _sep to tab
set _eol to linefeed
if application "{app}" is running then
  tell application "{app}"
    set _out to ""
    set _wi to 0
    repeat with w in windows
      set _wi to _wi + 1
      try
        set _urls to URL of every tab of w
      on error
        set _urls to {{}}
      end try
      set _ti to 0
      repeat with _u in _urls
        set _ti to _ti + 1
        set _u_text to ""
        try
          set _u_text to _u as text
        end try
        set _out to _out & _wi & _sep & _ti & _sep & _u_text & _eol
      end repeat
    end repeat
    return _out
  end tell
else
  return ""
end if"#,
        app = app_name
    );
    let out = run_osascript(&script)?;
    let mut tabs = Vec::new();
    for line in out.lines() {
        if line.is_empty() {
            continue;
        }
        let mut parts = line.splitn(3, FIELD_SEP);
        let wi = parts.next().and_then(|s| s.trim().parse::<u32>().ok());
        let ti = parts.next().and_then(|s| s.trim().parse::<u32>().ok());
        let url = parts.next().unwrap_or("").to_string();
        if let (Some(window_index), Some(tab_index)) = (wi, ti) {
            tabs.push(Tab {
                window_index,
                tab_index,
                url,
            });
        }
    }
    Ok(tabs)
}

fn apply_actions(
    browser: SupportedBrowser,
    actions: &[(u32, u32, String)],
) -> Result<(), AutomationError> {
    let app_name = browser.applescript_name();
    let mut body = String::new();
    for (wi, ti, url) in actions {
        // Each set is wrapped in `try` so one stale index (a tab the
        // user closed mid-tick) doesn't abort the whole batch.
        body.push_str(&format!(
            "  try\n    set URL of tab {ti} of window {wi} to {url}\n  end try\n",
            ti = ti,
            wi = wi,
            url = applescript_string_expr(url)
        ));
    }
    let script = format!(
        r#"if application "{app}" is running then
  tell application "{app}"
{body}  end tell
end if"#,
        app = app_name,
        body = body
    );
    run_osascript(&script).map(|_| ())
}

/// Run an AppleScript via osascript, classifying the not-authorized
/// (Automation TCC) error so the caller can drive the permission UI.
fn run_osascript(script: &str) -> Result<String, AutomationError> {
    let _guard = APPLE_EVENTS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);

    let mut child = std::process::Command::new("/usr/bin/osascript")
        .arg("-e")
        .arg(script)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| AutomationError::Other(format!("spawn osascript: {e}")))?;

    let started = Instant::now();
    loop {
        match child
            .try_wait()
            .map_err(|e| AutomationError::Other(format!("wait osascript: {e}")))?
        {
            Some(status) => {
                use std::io::Read;
                let mut stdout = String::new();
                let mut stderr = String::new();
                if let Some(mut out) = child.stdout.take() {
                    out.read_to_string(&mut stdout).ok();
                }
                if let Some(mut err) = child.stderr.take() {
                    err.read_to_string(&mut stderr).ok();
                }
                if status.success() {
                    return Ok(stdout);
                }
                if stderr.contains("-1743")
                    || stderr.contains("Not authorized to send Apple events")
                {
                    return Err(AutomationError::NotAuthorized);
                }
                return Err(AutomationError::Other(stderr.trim().to_string()));
            }
            None if started.elapsed() >= OSASCRIPT_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(AutomationError::Other(format!(
                    "osascript timed out after {}s",
                    OSASCRIPT_TIMEOUT.as_secs()
                )));
            }
            None => std::thread::sleep(Duration::from_millis(50)),
        }
    }
}

/// Probe whether we can actually control a browser right now by sending
/// a harmless Apple Event. Unlike `AEDeterminePermissionToAutomateTarget`
/// this reflects real-world access — important in dev where `tauri dev`
/// runs under Cursor/Terminal and TCC often reports Unknown even though
/// osascript works. Only returns Granted when the browser is running and
/// the event succeeds; returns Unknown when the browser is not open.
pub fn probe_automation_access(browser: SupportedBrowser) -> PermState {
    let app_name = browser.applescript_name();
    let script = format!(
        r#"if application "{app}" is running then
  tell application "{app}" to count windows
  return "ok"
else
  return "idle"
end if"#,
        app = app_name
    );
    match run_osascript(&script) {
        Ok(out) if out.contains("ok") => PermState::Granted,
        Ok(_) => PermState::Unknown,
        Err(AutomationError::NotAuthorized) => PermState::Denied,
        Err(_) => PermState::Unknown,
    }
}

/// Apple Event probe that launches the browser if needed. The only
/// reliable way to detect a Settings toggle while the enforcer has the
/// browser closed — `AEDeterminePermissionToAutomateTarget` returns -600
/// ("target not running") for both grant and deny until an event reaches
/// the app.
pub fn probe_automation_access_launching(browser: SupportedBrowser) -> PermState {
    let app_name = browser.applescript_name();
    let script = format!(
        r#"tell application "{app}" to count windows"#,
        app = app_name
    );
    match run_osascript(&script) {
        Ok(_) => PermState::Granted,
        Err(AutomationError::NotAuthorized) => PermState::Denied,
        Err(_) => PermState::Unknown,
    }
}

fn probe_automation_access_launching_rate_limited(browser: SupportedBrowser) -> Option<PermState> {
    let now = Instant::now();
    let mut allow = false;
    if let Ok(mut map) = idle_launch_probe_at().lock() {
        let stale = map
            .get(&browser)
            .map(|t| now.duration_since(*t) >= IDLE_LAUNCH_PROBE_COOLDOWN)
            .unwrap_or(true);
        if stale {
            map.insert(browser, now);
            allow = true;
        }
    }
    if !allow {
        return None;
    }
    Some(probe_automation_access_launching(browser))
}

/// Merge osascript probe, silent TCC read, and session cache.
/// Denied from any live source wins over a stale Granted cache.
fn combine_permission_signals(
    probe: PermState,
    tcc: PermState,
    cached: Option<PermState>,
) -> PermState {
    if probe == PermState::Denied || tcc == PermState::Denied {
        return PermState::Denied;
    }
    if probe == PermState::Granted || tcc == PermState::Granted {
        return PermState::Granted;
    }
    match cached {
        Some(PermState::Denied) => PermState::Denied,
        Some(PermState::Granted) => PermState::Granted,
        _ => PermState::Unknown,
    }
}

/// Live permission while the browser process is running.
pub fn resolve_permission_state(browser: SupportedBrowser, cached: Option<PermState>) -> PermState {
    let probe = probe_automation_access(browser);
    let tcc = query_automation_permission(browser);
    combine_permission_signals(probe, tcc, cached)
}

/// True when `target` names this browser (label or settings key from the UI).
pub fn browser_matches_launch_probe_target(browser: SupportedBrowser, target: &str) -> bool {
    let t = target.trim().to_ascii_lowercase();
    if t.is_empty() {
        return false;
    }
    if browser.label().eq_ignore_ascii_case(target) {
        return true;
    }
    browser.settings_key() == t
}

/// Permission snapshot for UI polling. Running browsers get a live probe;
/// idle browsers normally can't be read via TCC (-600). When
/// `launch_probe` is set — only after the user explicitly opens
/// Settings or taps Grant access — send one rate-limited Apple Event
/// that launches the browser if needed so a fresh grant is detected.
pub fn resolve_permission_state_for_status(
    browser: SupportedBrowser,
    cached: Option<PermState>,
    is_running: bool,
    launch_probe: bool,
) -> PermState {
    if is_running {
        return resolve_permission_state(browser, cached);
    }
    if launch_probe && cached == Some(PermState::Denied) {
        if let Some(probe) = probe_automation_access_launching_rate_limited(browser) {
            if matches!(probe, PermState::Granted | PermState::Denied) {
                return probe;
            }
        }
    }
    let tcc = query_automation_permission(browser);
    match tcc {
        PermState::Denied => PermState::Denied,
        PermState::Granted => PermState::Granted,
        PermState::Unknown => {
            // TCC returns -600 when the target app is not running. Only
            // trust a previous grant while closed; any other cached state
            // (denied / unknown) means we cannot show "Allowed".
            if cached == Some(PermState::Granted) {
                PermState::Granted
            } else {
                PermState::Unknown
            }
        }
    }
}

/// Whether the enforcer should treat Automation as missing for this browser.
///
/// The silent TCC read (`query_automation_permission`) often returns
/// `Unknown` in dev builds even after osascript fails with -1743, so we
/// also trust the watcher's cached denial and a live probe — the same
/// signals that make website blocking fail.
pub fn automation_denied_for_enforcement(
    browser: SupportedBrowser,
    cached: Option<PermState>,
    is_running: bool,
) -> bool {
    if is_running {
        match probe_automation_access(browser) {
            PermState::Denied => return true,
            PermState::Granted => return false,
            PermState::Unknown => {}
        }
    }
    match query_automation_permission(browser) {
        PermState::Denied => return true,
        PermState::Granted => return false,
        PermState::Unknown => {}
    }
    // Stale watcher denial while the browser is closed isn't actionable.
    if is_running {
        cached == Some(PermState::Denied)
    } else {
        false
    }
}

/// Open System Settings → Privacy & Security → Automation and bring it
/// to the foreground.
pub fn open_automation_settings() -> Result<(), String> {
    std::process::Command::new("/usr/bin/open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Automation")
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("open Automation settings: {e}"))
}

/// Send a minimal Apple Event to surface the system Automation prompt
/// (or confirm an existing grant) on demand — used by the "Enable" /
/// onboarding affordance so the prompt appears when the user expects it.
pub fn trigger_permission_prompt(browser: SupportedBrowser) -> Result<(), String> {
    let app_name = browser.applescript_name();
    // No "is running" guard: this is the explicit onboarding "Grant
    // access" path, so we *want* to launch the browser if it's closed —
    // the Automation consent prompt only appears when an Apple Event
    // actually reaches the target app. `count windows` is harmless and
    // returns 0 on a freshly launched browser.
    let script = format!(
        r#"tell application "{app}" to count windows"#,
        app = app_name
    );
    let result = match run_osascript(&script) {
        Ok(_) => Ok(()),
        Err(AutomationError::NotAuthorized) => Err(format!(
            "Automation permission for {} not granted",
            browser.label()
        )),
        Err(AutomationError::Other(msg)) => Err(msg),
    };
    // The Apple Event launches/activates the browser; bring System
    // Settings → Automation back to the front so the user can toggle
    // the grant without hunting for the Settings window.
    let _ = open_automation_settings();
    result
}

fn applescript_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Build an AppleScript string expression for `s`. Query strings contain
/// `&` between params; inside AppleScript double-quoted strings `&` is the
/// concatenation operator, so `"file://x?u=1&id=2"` parses as two expressions
/// and the `set URL` silently fails inside `try`.
fn applescript_string_expr(s: &str) -> String {
    if !s.contains('&') {
        return format!("\"{}\"", applescript_escape(s));
    }
    s.split('&')
        .map(|part| format!("\"{}\"", applescript_escape(part)))
        .collect::<Vec<_>>()
        .join(" & \"&\" & ")
}

#[cfg(test)]
mod tests;
