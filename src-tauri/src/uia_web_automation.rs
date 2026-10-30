// Website blocking on Windows through UI Automation, for Chromium browsers
// whose organisation policy stops the extension's native-messaging host.
//
// On a managed laptop (a university's, typically) IT can set
// `NativeMessagingUserLevelHosts = 0` or blocklist our host. The extension
// then installs fine but never receives a blocklist, so nothing is blocked
// and nothing says so. macOS sidesteps this with Apple Events
// (web_automation.rs); Windows has no scripting dictionary for browsers, so
// this module does the closest equivalent: every TICK it reads the address
// bar of the foreground browser window through UI Automation and, when it
// shows a blocked site, types the block page's `file://` URL into it and
// presses Enter. Parked windows whose site is no longer blocked are sent
// back the same way. The URL decisions are the shared ones in block_page.rs.
//
// UI Automation needs no elevation, no capability in the MSIX manifest and
// no browser policy, so it works from the Store build on a locked-down PC.
//
// Scope, deliberately narrow for now:
// - Chrome, Edge and Brave only, and only while `browser_policy` says their
//   native-messaging host is blocked. Everywhere else the extension keeps
//   the job: it sees background tabs and redirects before the page loads.
// - The foreground window only. The address bar shows just the active tab,
//   and Enter has to go to the focused window: sending it while another
//   window is foreground would press Enter in that window instead. A blocked
//   tab in a background window is therefore left until the user switches to
//   it, then redirected within a tick.
//
// Which way failures fall: towards allowing, and each case is logged. No
// address bar found, the user typing in it, or text that is not a URL means
// we do nothing that tick. The alternative, guessing which text box is the
// address bar or acting on half-typed text, risks typing a URL into a web
// page's own form and submitting it, which is worse than a missed block on
// a browser the extension cannot reach anyway.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use tauri::AppHandle;
use windows::core::BSTR;
use windows::Win32::Foundation::{CloseHandle, HWND};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationValuePattern,
    TreeScope_Descendants, UIA_ClassNamePropertyId, UIA_ValuePatternId,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP,
    VK_RETURN,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetClassNameW, GetForegroundWindow, GetWindowThreadProcessId,
};

use crate::block_page;
use crate::native_host;
use crate::native_host_install::BrowserTarget;

/// Same cadence as the macOS Automation watcher.
const TICK: Duration = Duration::from_millis(1000);

/// How often to re-read the browsers' native-messaging policy. Policy only
/// changes when IT pushes it, so the registry need not be read every tick.
const POLICY_REFRESH: Duration = Duration::from_secs(60);

/// After navigating a window, leave it alone this long so the next tick
/// does not read the address bar before the navigation has committed and
/// type the block page URL a second time.
const ACTION_COOLDOWN: Duration = Duration::from_secs(2);

/// Top-level window class of every Chromium browser.
const CHROMIUM_WINDOW_CLASS: &str = "Chrome_WidgetWin_1";

/// UI Automation class name of Chromium's address bar (the views class).
/// Matched exactly rather than taking the first edit box, which in a page
/// with a search field could be the page's own input.
const OMNIBOX_CLASS: &str = "OmniboxViewViews";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum UiaBrowser {
    Chrome,
    Edge,
    Brave,
}

impl UiaBrowser {
    fn all() -> [UiaBrowser; 3] {
        [UiaBrowser::Chrome, UiaBrowser::Edge, UiaBrowser::Brave]
    }

    fn label(self) -> &'static str {
        match self {
            UiaBrowser::Chrome => "Chrome",
            UiaBrowser::Edge => "Edge",
            UiaBrowser::Brave => "Brave",
        }
    }

    fn exe_name(self) -> &'static str {
        match self {
            UiaBrowser::Chrome => "chrome.exe",
            UiaBrowser::Edge => "msedge.exe",
            UiaBrowser::Brave => "brave.exe",
        }
    }

    fn policy_target(self) -> BrowserTarget {
        match self {
            UiaBrowser::Chrome => BrowserTarget::Chrome,
            UiaBrowser::Edge => BrowserTarget::Edge,
            UiaBrowser::Brave => BrowserTarget::Brave,
        }
    }

    fn from_exe_path(path: &str) -> Option<UiaBrowser> {
        let file = path.rsplit(['\\', '/']).next()?.to_ascii_lowercase();
        UiaBrowser::all().into_iter().find(|b| b.exe_name() == file)
    }
}

/// Spawn the watcher. `block_page_url` is the `file://` base URL of the
/// bundled blocked.html, from `block_page::resolve_block_page_url`.
///
/// There is no pause: the watcher only acts while a block is active, and a
/// browser the extension cannot reach has no other enforcement to defer to.
pub fn start(app: AppHandle, block_page_url: String) {
    std::thread::spawn(move || {
        // UI Automation clients belong in the multithreaded apartment; this
        // thread is ours alone, so nothing else's COM state is affected.
        let automation: IUIAutomation = unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            match CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) {
                Ok(a) => a,
                Err(e) => {
                    log::warn!("uia_web_automation: cannot create IUIAutomation: {e}");
                    return;
                }
            }
        };
        let mut watcher = Watcher {
            automation,
            block_page_url,
            policy_blocked: Vec::new(),
            policy_read_at: None,
            omnibox: None,
            last_action: HashMap::new(),
            missing_omnibox_logged: HashSet::new(),
        };
        loop {
            std::thread::sleep(TICK);
            watcher.tick(&app);
        }
    });
}

struct Watcher {
    automation: IUIAutomation,
    block_page_url: String,
    /// Browsers whose policy blocks our native-messaging host.
    policy_blocked: Vec<UiaBrowser>,
    policy_read_at: Option<Instant>,
    /// Address bar of the window it was last found in. Finding it walks the
    /// browser's UI tree, so it is kept until that window stops answering.
    omnibox: Option<(isize, IUIAutomationElement)>,
    last_action: HashMap<isize, Instant>,
    /// Windows already logged as having no address bar we recognise, so a
    /// browser that renamed its class logs once rather than every second.
    missing_omnibox_logged: HashSet<isize>,
}

impl Watcher {
    fn tick(&mut self, app: &AppHandle) {
        let now = Instant::now();
        if self
            .policy_read_at
            .map_or(true, |t| now.duration_since(t) >= POLICY_REFRESH)
        {
            self.refresh_policy();
            self.policy_read_at = Some(now);
        }
        if self.policy_blocked.is_empty() {
            return;
        }

        let Some((hwnd, browser)) = foreground_browser_window() else {
            return;
        };
        if !self.policy_blocked.contains(&browser) {
            return;
        }
        let key = hwnd.0 as isize;
        if self
            .last_action
            .get(&key)
            .is_some_and(|t| now.duration_since(*t) < ACTION_COOLDOWN)
        {
            return;
        }

        // Read the blocks only once a window needs judging; idle ticks with
        // no browser in front cost two Win32 calls.
        let Some(path) = crate::commands::canonical_data_path(app) else {
            return;
        };
        let (_domains, blocks) = native_host::derive_payload(&path);

        let Some(omnibox) = self.omnibox_for(hwnd, browser) else {
            return;
        };
        let text = match read_address_bar(&omnibox) {
            Ok(AddressBar::Editing) => return,
            Ok(AddressBar::Showing(text)) => text,
            Err(e) => {
                log::debug!(
                    "uia_web_automation: reading {} address bar failed: {e}",
                    browser.label()
                );
                self.omnibox = None;
                return;
            }
        };
        let Some(target) =
            block_page::plan_address_bar_action(&text, &blocks, &self.block_page_url)
        else {
            return;
        };
        self.last_action
            .retain(|_, t| now.duration_since(*t) < ACTION_COOLDOWN);
        self.last_action.insert(key, now);
        match navigate(&omnibox, hwnd, &target) {
            Ok(()) => log::info!(
                "uia_web_automation: sent {} window to {} (redirect to / restore from block page)",
                browser.label(),
                if block_page::is_block_page_url(&target, &self.block_page_url) {
                    "the block page"
                } else {
                    "its original site"
                }
            ),
            Err(e) => log::warn!(
                "uia_web_automation: navigating {} window failed: {e}",
                browser.label()
            ),
        }
    }

    fn refresh_policy(&mut self) {
        let blocked: Vec<UiaBrowser> = UiaBrowser::all()
            .into_iter()
            .filter(|b| crate::browser_policy::read(b.policy_target()).is_some_and(|p| p.blocked))
            .collect();
        if blocked != self.policy_blocked {
            log::info!(
                "uia_web_automation: native messaging blocked by policy for [{}] — {}",
                blocked
                    .iter()
                    .map(|b| b.label())
                    .collect::<Vec<_>>()
                    .join(", "),
                if blocked.is_empty() {
                    "idle"
                } else {
                    "blocking through UI Automation"
                }
            );
        }
        self.policy_blocked = blocked;
    }

    fn omnibox_for(&mut self, hwnd: HWND, browser: UiaBrowser) -> Option<IUIAutomationElement> {
        let key = hwnd.0 as isize;
        if let Some((cached_hwnd, element)) = &self.omnibox {
            if *cached_hwnd == key {
                return Some(element.clone());
            }
        }
        match find_omnibox(&self.automation, hwnd) {
            Ok(element) => {
                self.omnibox = Some((key, element.clone()));
                self.missing_omnibox_logged.remove(&key);
                Some(element)
            }
            Err(e) => {
                if self.missing_omnibox_logged.insert(key) {
                    log::warn!(
                        "uia_web_automation: no address bar found in {} window, not blocking it: {e}",
                        browser.label()
                    );
                }
                None
            }
        }
    }
}

/// The foreground window, if it is a top-level window of a supported
/// Chromium browser.
fn foreground_browser_window() -> Option<(HWND, UiaBrowser)> {
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.is_invalid() {
        return None;
    }
    let mut class = [0u16; 64];
    let len = unsafe { GetClassNameW(hwnd, &mut class) };
    if len <= 0 || String::from_utf16_lossy(&class[..len as usize]) != CHROMIUM_WINDOW_CLASS {
        return None;
    }
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    if pid == 0 {
        return None;
    }
    let path = process_image_path(pid)?;
    UiaBrowser::from_exe_path(&path).map(|b| (hwnd, b))
}

fn process_image_path(pid: u32) -> Option<String> {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR(buf.as_mut_ptr()),
            &mut len,
        );
        let _ = CloseHandle(handle);
        ok.ok()?;
        Some(String::from_utf16_lossy(&buf[..len as usize]))
    }
}

fn find_omnibox(
    automation: &IUIAutomation,
    hwnd: HWND,
) -> windows::core::Result<IUIAutomationElement> {
    unsafe {
        let window = automation.ElementFromHandle(hwnd)?;
        let condition = automation
            .CreatePropertyCondition(UIA_ClassNamePropertyId, &VARIANT::from(OMNIBOX_CLASS))?;
        window.FindFirst(TreeScope_Descendants, &condition)
    }
}

enum AddressBar {
    /// The user is typing; the text is their input, not the page's URL.
    Editing,
    Showing(String),
}

fn read_address_bar(omnibox: &IUIAutomationElement) -> windows::core::Result<AddressBar> {
    unsafe {
        if omnibox.CurrentHasKeyboardFocus()?.as_bool() {
            return Ok(AddressBar::Editing);
        }
        let value: IUIAutomationValuePattern = omnibox.GetCurrentPatternAs(UIA_ValuePatternId)?;
        Ok(AddressBar::Showing(value.CurrentValue()?.to_string()))
    }
}

/// Put `url` in the address bar and press Enter.
///
/// Enter is sent with `SendInput`, which goes to whichever window has
/// keyboard focus. So it is sent only after checking that the same browser
/// window is still in front and its address bar holds focus; otherwise the
/// text is left in the bar and nothing is pressed.
fn navigate(omnibox: &IUIAutomationElement, hwnd: HWND, url: &str) -> Result<(), String> {
    unsafe {
        omnibox.SetFocus().map_err(|e| format!("focus: {e}"))?;
        let value: IUIAutomationValuePattern = omnibox
            .GetCurrentPatternAs(UIA_ValuePatternId)
            .map_err(|e| format!("value pattern: {e}"))?;
        value
            .SetValue(&BSTR::from(url))
            .map_err(|e| format!("set value: {e}"))?;
        if GetForegroundWindow() != hwnd {
            return Err("window lost the foreground before Enter".into());
        }
        if !omnibox
            .CurrentHasKeyboardFocus()
            .map(|f| f.as_bool())
            .unwrap_or(false)
        {
            return Err("address bar lost focus before Enter".into());
        }
        let key = |flags| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VK_RETURN,
                    wScan: 0,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        let inputs = [key(KEYBD_EVENT_FLAGS(0)), key(KEYEVENTF_KEYUP)];
        let sent = SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
        if sent as usize != inputs.len() {
            return Err(format!("SendInput sent {sent} of {} events", inputs.len()));
        }
    }
    Ok(())
}
