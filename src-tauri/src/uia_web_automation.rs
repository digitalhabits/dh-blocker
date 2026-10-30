// Website blocking on Windows through UI Automation. Chrome, Edge, Brave and
// Firefox default to this method; explicit extension mode skips the watcher.
// Every tick reads the foreground browser address bar and redirects blocked
// sites to the bundled page. Parked pages restore when the rule no longer
// applies. URL decisions are shared with macOS in block_page.rs.
//
// UI Automation needs no elevation, no capability in the MSIX manifest and
// no browser policy, so it works from the Store build on a locked-down PC.
//
// Scope:
// - Chrome, Edge, Brave and Firefox, while selected for Automation.
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
    TreeScope_Children, TreeScope_Descendants, UIA_AutomationIdPropertyId,
    UIA_ClassNamePropertyId, UIA_ComboBoxControlTypeId, UIA_ControlTypePropertyId,
    UIA_ToolBarControlTypeId, UIA_ValuePatternId,
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
use crate::blocking_method::{self, Method};

/// Same cadence as the macOS Automation watcher.
const TICK: Duration = Duration::from_millis(1000);

/// After navigating a window, leave it alone this long so the next tick
/// does not read the address bar before the navigation has committed and
/// type the block page URL a second time.
const ACTION_COOLDOWN: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum UiaBrowser {
    Chrome,
    Edge,
    Brave,
    Firefox,
}

impl UiaBrowser {
    fn should_watch(self, method: Method) -> bool {
        method == Method::Automation
    }

    fn setting_key(self) -> &'static str {
        match self {
            UiaBrowser::Chrome => "chrome",
            UiaBrowser::Edge => "edge",
            UiaBrowser::Brave => "brave",
            UiaBrowser::Firefox => "firefox",
        }
    }

    fn window_class(self) -> &'static str {
        match self {
            UiaBrowser::Firefox => "MozillaWindowClass",
            _ => "Chrome_WidgetWin_1",
        }
    }

    fn omnibox_class(self) -> &'static str {
        // Brave exposes its subclass name through UI Automation. Match the
        // browser's exact class, never an arbitrary edit box in page content.
        match self {
            UiaBrowser::Brave => "BraveOmniboxViewViews",
            UiaBrowser::Chrome | UiaBrowser::Edge => "OmniboxViewViews",
            // Firefox is selected by toolbar + automation ID, not this class.
            UiaBrowser::Firefox => "urlbar-input textbox-input",
        }
    }

    fn all() -> [UiaBrowser; 4] {
        [
            UiaBrowser::Chrome,
            UiaBrowser::Edge,
            UiaBrowser::Brave,
            UiaBrowser::Firefox,
        ]
    }

    fn label(self) -> &'static str {
        match self {
            UiaBrowser::Chrome => "Chrome",
            UiaBrowser::Edge => "Edge",
            UiaBrowser::Brave => "Brave",
            UiaBrowser::Firefox => "Firefox",
        }
    }

    fn exe_name(self) -> &'static str {
        match self {
            UiaBrowser::Chrome => "chrome.exe",
            UiaBrowser::Edge => "msedge.exe",
            UiaBrowser::Brave => "brave.exe",
            UiaBrowser::Firefox => "firefox.exe",
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
        let Some((hwnd, browser)) = foreground_browser_window() else {
            return;
        };
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
        if !browser.should_watch(blocking_method::method_for_key_at_path(
            &path,
            browser.setting_key(),
        )) {
            return;
        }
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

    fn omnibox_for(&mut self, hwnd: HWND, browser: UiaBrowser) -> Option<IUIAutomationElement> {
        let key = hwnd.0 as isize;
        if let Some((cached_hwnd, element)) = &self.omnibox {
            if *cached_hwnd == key {
                return Some(element.clone());
            }
        }
        match find_omnibox(&self.automation, hwnd, browser) {
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
/// browser. Check both process identity and the browser's window class.
fn foreground_browser_window() -> Option<(HWND, UiaBrowser)> {
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.is_invalid() {
        return None;
    }
    let mut class = [0u16; 64];
    let len = unsafe { GetClassNameW(hwnd, &mut class) };
    if len <= 0 {
        return None;
    }
    let class = String::from_utf16_lossy(&class[..len as usize]);
    if class != "Chrome_WidgetWin_1" && class != "MozillaWindowClass" {
        return None;
    }
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    if pid == 0 {
        return None;
    }
    let path = process_image_path(pid)?;
    let browser = UiaBrowser::from_exe_path(&path)?;
    (class == browser.window_class()).then_some((hwnd, browser))
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
    browser: UiaBrowser,
) -> windows::core::Result<IUIAutomationElement> {
    unsafe {
        let window = automation.ElementFromHandle(hwnd)?;
        if browser == UiaBrowser::Firefox {
            // Observed on Windows Firefox 159: urlbar-input is a ComboBox,
            // not an Edit. Only search inside the browser's direct-child
            // navigation toolbar: page content may reuse these DOM IDs.
            // Missing toolbar/control sends no input (allows this tick).
            let toolbar_id = automation.CreatePropertyCondition(
                UIA_AutomationIdPropertyId,
                &VARIANT::from("nav-bar"),
            )?;
            let toolbar_type = automation.CreatePropertyCondition(
                UIA_ControlTypePropertyId,
                &VARIANT::from(UIA_ToolBarControlTypeId.0),
            )?;
            let toolbar_condition = automation.CreateAndCondition(&toolbar_id, &toolbar_type)?;
            let toolbar = window.FindFirst(TreeScope_Children, &toolbar_condition)?;
            let input_id = automation.CreatePropertyCondition(
                UIA_AutomationIdPropertyId,
                &VARIANT::from("urlbar-input"),
            )?;
            let input_type = automation.CreatePropertyCondition(
                UIA_ControlTypePropertyId,
                &VARIANT::from(UIA_ComboBoxControlTypeId.0),
            )?;
            let input_condition = automation.CreateAndCondition(&input_id, &input_type)?;
            return toolbar.FindFirst(TreeScope_Descendants, &input_condition);
        }
        let condition = automation.CreatePropertyCondition(
            UIA_ClassNamePropertyId,
            &VARIANT::from(browser.omnibox_class()),
        )?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn watcher_respects_selected_method_for_every_browser() {
        for browser in UiaBrowser::all() {
            assert!(browser.should_watch(Method::Automation));
            assert!(!browser.should_watch(Method::Extension));
        }
    }

    #[test]
    fn firefox_requires_its_own_process_and_window_class() {
        assert_eq!(
            UiaBrowser::from_exe_path(r"C:\Program Files\Mozilla Firefox\firefox.exe"),
            Some(UiaBrowser::Firefox)
        );
        assert_eq!(UiaBrowser::Firefox.window_class(), "MozillaWindowClass");
        assert_eq!(UiaBrowser::Chrome.window_class(), "Chrome_WidgetWin_1");
        assert_eq!(UiaBrowser::from_exe_path(r"C:\other\not-firefox.exe"), None);
    }

    #[test]
    fn address_bar_classes_match_browser_providers() {
        // Captured on a real Windows Brave window: AutomationId=view_1012.
        // A generic edit-box fallback must not replace this exact match.
        assert_eq!(UiaBrowser::Brave.omnibox_class(), "BraveOmniboxViewViews");
        assert_eq!(UiaBrowser::Chrome.omnibox_class(), "OmniboxViewViews");
        assert_eq!(UiaBrowser::Edge.omnibox_class(), "OmniboxViewViews");
    }
}
