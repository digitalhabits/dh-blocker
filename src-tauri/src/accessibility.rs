//! macOS Accessibility (AX) access to Firefox's active tab.
//!
//! Firefox is the one supported browser with no usable AppleScript
//! dictionary: it ships only the auto-generated Cocoa Standard Suite, so
//! `URL of every tab of every window` fails to *compile* (-2741) and even
//! `name of every window` goes unanswered until the Apple Event times out.
//! The Accessibility API is the only way to read a Firefox tab's URL without
//! the extension, and the only way to redirect one is to drive the address
//! bar the way a user would.
//!
//! What this buys over reading the address-bar text: `AXWebArea`'s `AXURL` is
//! the document's real URL — scheme intact, untrimmed, in punycode — where
//! the omnibox string is a *display* form. Firefox hides `https://` and may
//! trim `www.`, shows a placeholder when empty, and renders IDN for humans.
//! The Android side carries a whole fixture suite
//! (`BrowserUrlParserTest`) because it has to parse that display form;
//! reading `AXURL` means we never do.
//!
//! Three properties of the API shape this module:
//!
//! - **The grant is global and cannot be self-granted.** TCC's Accessibility
//!   service covers reading *and* synthesising input across every app, so
//!   there is no per-browser prompt to fall back on the way Automation has.
//!   `AXIsProcessTrusted` is therefore checked before every read, and a
//!   revoked grant degrades to "no answer" rather than an error path.
//! - **Accessibility is instantiated lazily by the browser.** Firefox exposes
//!   nothing but titlebar buttons until a client walks the tree; the
//!   documented handshakes (`AXManualAccessibility`,
//!   `AXEnhancedUserInterface`) are rejected outright on current builds
//!   (-25205 / -25208) and the engine comes up as a side effect of querying.
//!   `active_tab_url` therefore falls back to a bounded window walk, which
//!   doubles as the thing that wakes the engine.
//! - **Calls cross a process boundary and can block.** Everything here is
//!   meant for the watcher thread, never the main thread.

use std::ffi::c_void;

use core_foundation::base::{CFGetTypeID, CFRelease, CFTypeRef, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::CFDictionary;
use core_foundation::string::{CFString, CFStringRef};
use core_foundation::url::{CFURLRef, CFURL};
use core_graphics::event::{CGEvent, CGEventFlags};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use core_graphics::geometry::CGSize;

type AXUIElementRef = *mut c_void;
type AXError = i32;

const AX_SUCCESS: AXError = 0;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn AXIsProcessTrustedWithOptions(options: CFTypeRef) -> bool;
    fn AXUIElementCreateApplication(pid: i32) -> AXUIElementRef;
    fn AXUIElementCopyAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: *mut CFTypeRef,
    ) -> AXError;
    /// Decodes an AXValue into a native struct; false when the wrapped type
    /// is not the one asked for. See HIServices/AXValue.h.
    fn AXValueGetValue(value: CFTypeRef, the_type: u32, value_ptr: *mut c_void) -> bool;
    fn AXUIElementSetAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: CFTypeRef,
    ) -> AXError;
    fn AXUIElementPerformAction(element: AXUIElementRef, action: CFStringRef) -> AXError;
    static kAXTrustedCheckOptionPrompt: CFStringRef;
}

/// A borrowed `AXUIElementRef` that releases on drop. AX elements are
/// CFTypes, so the copy rules are CoreFoundation's: anything out of a
/// `Copy`-named call is ours to release.
struct AxElement(AXUIElementRef);

impl Drop for AxElement {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CFRelease(self.0 as CFTypeRef) };
        }
    }
}

impl AxElement {
    fn for_pid(pid: i32) -> Self {
        Self(unsafe { AXUIElementCreateApplication(pid) })
    }

    /// `None` covers every uninteresting outcome alike: the attribute is
    /// unsupported, the app has not instantiated accessibility, the grant is
    /// gone, or the element died between calls.
    fn attr(&self, name: &str) -> Option<CfOwned> {
        let key = CFString::new(name);
        let mut out: CFTypeRef = std::ptr::null();
        let err =
            unsafe { AXUIElementCopyAttributeValue(self.0, key.as_concrete_TypeRef(), &mut out) };
        if err != AX_SUCCESS || out.is_null() {
            return None;
        }
        Some(CfOwned(out))
    }

    fn attr_string(&self, name: &str) -> Option<String> {
        let value = self.attr(name)?;
        unsafe {
            if CFGetTypeID(value.0) != CFString::type_id() {
                return None;
            }
            Some(CFString::wrap_under_get_rule(value.0 as CFStringRef).to_string())
        }
    }

    /// `AXURL` is a **CFURL**, not a CFString. Wrapping it as a string is
    /// invalid and yields nothing usable, so the type is checked and the URL
    /// converted properly; some elements hand back a plain string instead,
    /// which is accepted on the same path.
    fn attr_url(&self, name: &str) -> Option<String> {
        let value = self.attr(name)?;
        unsafe {
            let type_id = CFGetTypeID(value.0);
            if type_id == CFURL::type_id() {
                let url = CFURL::wrap_under_get_rule(value.0 as CFURLRef);
                return Some(url.get_string().to_string());
            }
            if type_id == CFString::type_id() {
                return Some(CFString::wrap_under_get_rule(value.0 as CFStringRef).to_string());
            }
            None
        }
    }

    fn attr_element(&self, name: &str) -> Option<AxElement> {
        let value = self.attr(name)?;
        let raw = value.0 as AXUIElementRef;
        // Hand ownership to AxElement rather than letting CfOwned release it.
        std::mem::forget(value);
        Some(AxElement(raw))
    }
}

/// Any CFType we own and must release.
struct CfOwned(CFTypeRef);

impl Drop for CfOwned {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CFRelease(self.0) };
        }
    }
}

/// Whether this process may use the Accessibility API at all. Cheap enough
/// to call on every tick, and the only honest way to know: the grant can be
/// revoked in System Settings at any moment.
pub fn is_trusted() -> bool {
    unsafe { AXIsProcessTrusted() }
}

/// Ask macOS to show the "allow accessibility access" prompt. The prompt only
/// deep-links to System Settings — nothing here can flip the switch — so the
/// caller must still tell the user what to do once they are there.
pub fn prompt_for_trust() -> bool {
    let key = unsafe { CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt) };
    let options = CFDictionary::from_CFType_pairs(&[(key, CFBoolean::true_value())]);
    unsafe { AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef() as CFTypeRef) }
}

/// Deep-link to the Accessibility pane, mirroring
/// `web_automation::open_automation_settings` for the Automation pane.
pub fn open_settings() -> Result<(), String> {
    std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("failed to open Accessibility settings: {e}"))
}

/// Ask the browser to instantiate its accessibility engine.
///
/// Both Firefox and Chromium expose nothing but window furniture until an
/// assistive client turns up — a fresh Firefox window reports three titlebar
/// buttons and no document. The documented handshakes are *rejected* on
/// current builds (`AXEnhancedUserInterface` → -25208 on the application
/// element, `AXManualAccessibility` → -25205), yet the engine comes up anyway
/// shortly after the attempt. So the error is deliberately ignored: the call
/// is a nudge whose return value carries no information.
///
/// The consequence for callers is that reads answer `None` for the first
/// second or two after a browser launches. That is a real gap — Firefox is
/// unenforced until the engine wakes — and the reason the extension stays the
/// default method rather than this one.
pub fn nudge_accessibility(pid: i32) {
    if !is_trusted() {
        return;
    }
    let app = AxElement::for_pid(pid);
    for attribute in ["AXEnhancedUserInterface", "AXManualAccessibility"] {
        let key = CFString::new(attribute);
        let value = CFBoolean::true_value();
        // Return value intentionally unused: see above.
        unsafe {
            AXUIElementSetAttributeValue(app.0, key.as_concrete_TypeRef(), value.as_CFTypeRef())
        };
    }
}

/// Where the user's focus is, which decides whether a redirect is safe.
#[derive(Debug, PartialEq, Eq)]
pub enum Focus {
    /// A document has focus: a redirect will land in the page.
    WebContent,
    /// The address bar has focus — the user is most likely mid-typing, and
    /// Cmd+L plus synthesised text would clobber what they are writing.
    AddressBar,
    /// Anything else, or nothing readable.
    Other,
}

/// Smallest area, in square points, that counts as a laid-out document.
/// Collapsed sidebars report 0x0; anything genuinely visible is orders of
/// magnitude above this.
const MIN_CONTENT_AREA: f64 = 10_000.0;

/// The active tab's URL, or `None` when it cannot be established.
///
/// Returning `None` must mean "no decision", never "nothing is blocked":
/// callers leave the tab alone rather than guessing, because the alternative
/// is redirecting a page we never identified.
pub fn active_tab_url(pid: i32) -> Option<String> {
    if !is_trusted() {
        return None;
    }
    let app = AxElement::for_pid(pid);

    // Fast path: with a page focused, the focused element *is* the web area,
    // so one attribute read answers the question.
    if let Some(focused) = app.attr_element("AXFocusedUIElement") {
        if focused.attr_string("AXRole").as_deref() == Some("AXWebArea") {
            if let Some(url) = focused.attr_url("AXURL") {
                if is_content_url(&url) {
                    return Some(url);
                }
            }
        }
    }

    // Otherwise the focus sits in chrome — the address bar after a Cmd+L, a
    // sidebar, a dialog — and the document has to be found. Background tabs
    // keep their web areas in the tree on Firefox, so "the first web area"
    // is wrong; the laid-out one is the visible one.
    largest_content_web_area(&app)
}

/// Firefox keeps sidebars and extension panels in the same tree. Their URLs
/// are never blockable, and treating them as the active tab would redirect
/// the wrong thing.
fn is_content_url(url: &str) -> bool {
    !url.starts_with("chrome://")
        && !url.starts_with("moz-extension://")
        && !url.starts_with("about:")
        && !url.is_empty()
}

fn largest_content_web_area(app: &AxElement) -> Option<String> {
    let window = app
        .attr_element("AXFocusedWindow")
        .or_else(|| app.attr_element("AXMainWindow"))?;
    let mut best: Option<(f64, String)> = None;
    walk_for_web_area(&window, 0, &mut best);
    best.map(|(_, url)| url)
}

/// Bounded depth and no node budget beyond it: the content web area sits
/// shallow in both Firefox and Chromium, and an unbounded walk on a window
/// with many subtrees is work the 1 s tick cannot afford.
const MAX_WALK_DEPTH: u32 = 20;

fn walk_for_web_area(element: &AxElement, depth: u32, best: &mut Option<(f64, String)>) {
    if depth > MAX_WALK_DEPTH {
        return;
    }
    if element.attr_string("AXRole").as_deref() == Some("AXWebArea") {
        if let Some(url) = element.attr_url("AXURL") {
            if is_content_url(&url) {
                let area = web_area_size(element);
                if area >= MIN_CONTENT_AREA && best.as_ref().map(|(a, _)| area > *a).unwrap_or(true)
                {
                    *best = Some((area, url));
                }
            }
        }
    }
    for child in children(element) {
        walk_for_web_area(&child, depth + 1, best);
    }
}

/// A collapsed sidebar measures 0x0 while the live tab fills the window, so
/// size is what separates the visible document from the parked ones.
fn web_area_size(element: &AxElement) -> f64 {
    let Some(value) = element.attr("AXSize") else {
        return 0.0;
    };
    let mut size = CGSize {
        width: 0.0,
        height: 0.0,
    };
    // kAXValueTypeCGSize, from HIServices/AXValue.h.
    const AX_VALUE_TYPE_CG_SIZE: u32 = 2;
    let decoded = unsafe {
        AXValueGetValue(
            value.0,
            AX_VALUE_TYPE_CG_SIZE,
            &mut size as *mut CGSize as *mut c_void,
        )
    };
    if !decoded {
        return 0.0;
    }
    size.width * size.height
}

fn children(element: &AxElement) -> Vec<AxElement> {
    let Some(value) = element.attr("AXChildren") else {
        return Vec::new();
    };
    let array = unsafe {
        core_foundation::array::CFArray::<*const c_void>::wrap_under_get_rule(
            value.0 as core_foundation::array::CFArrayRef,
        )
    };
    let mut out = Vec::with_capacity(array.len() as usize);
    for item in array.iter() {
        let raw = *item as AXUIElementRef;
        if raw.is_null() {
            continue;
        }
        unsafe { core_foundation::base::CFRetain(raw as CFTypeRef) };
        out.push(AxElement(raw));
    }
    out
}

/// Where the user's keyboard focus is, so a redirect can hold off rather than
/// overwrite what they are typing.
pub fn focus_kind(pid: i32) -> Focus {
    if !is_trusted() {
        return Focus::Other;
    }
    let app = AxElement::for_pid(pid);
    let Some(focused) = app.attr_element("AXFocusedUIElement") else {
        return Focus::Other;
    };
    match focused.attr_string("AXRole").as_deref() {
        Some("AXWebArea") => Focus::WebContent,
        Some("AXTextField") | Some("AXComboBox") => Focus::AddressBar,
        _ => Focus::Other,
    }
}

/// Focus the address bar without synthesising a shortcut.
///
/// `Cmd+L` looks like the obvious way in, but CoreGraphics keycodes are
/// *physical positions*, not characters: keycode 37 is `L` on QWERTY and
/// QWERTZ, and `N` on Dvorak — where the synthesised shortcut would open a
/// new window instead. Pressing the menu item means the browser resolves its
/// own shortcut, whatever the layout.
fn press_open_location(app: &AxElement) -> bool {
    let Some(menu_bar) = app.attr_element("AXMenuBar") else {
        return false;
    };
    press_menu_item_titled(&menu_bar, 0)
}

/// Firefox files it under File ▸ "Open Location…"; the ellipsis is a real
/// U+2026 in the menu title, so match on the stem and ignore what follows.
const OPEN_LOCATION_PREFIX: &str = "Open Location";
const MAX_MENU_DEPTH: u32 = 4;

fn press_menu_item_titled(element: &AxElement, depth: u32) -> bool {
    if depth > MAX_MENU_DEPTH {
        return false;
    }
    if element.attr_string("AXRole").as_deref() == Some("AXMenuItem") {
        if let Some(title) = element.attr_string("AXTitle") {
            if title.starts_with(OPEN_LOCATION_PREFIX) {
                let action = CFString::new("AXPress");
                let err =
                    unsafe { AXUIElementPerformAction(element.0, action.as_concrete_TypeRef()) };
                return err == AX_SUCCESS;
            }
        }
    }
    for child in children(element) {
        if press_menu_item_titled(&child, depth + 1) {
            return true;
        }
    }
    false
}

/// Send the current tab to `url`, the way a user would: focus the address
/// bar, replace its contents, press Return.
///
/// Returns `Ok(false)` when the redirect was deliberately *not* attempted
/// because the address bar already had focus. That means the user is most
/// likely part-way through typing, and seizing the field would delete what
/// they had written. Deferring costs one tick; clobbering costs their input.
///
/// Events go to the browser's pid rather than the shared HID tap, so the
/// browser never has to be activated and the user's frontmost app is left
/// alone.
pub fn redirect_active_tab(pid: i32, url: &str) -> Result<bool, String> {
    if !is_trusted() {
        return Err("accessibility permission not granted".into());
    }
    if focus_kind(pid) == Focus::AddressBar {
        return Ok(false);
    }

    let app = AxElement::for_pid(pid);
    let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState)
        .map_err(|_| "could not create a CoreGraphics event source".to_string())?;

    if !press_open_location(&app) {
        // No menu bar (or a renamed item): fall back to the shortcut, which
        // is right on every layout that keeps `L` where QWERTY has it.
        post_key(&source, pid, KEY_L, true)?;
    }
    settle();

    // Unicode is set on the event directly, so the text itself is
    // layout-independent — unlike a keycode.
    let typing = CGEvent::new_keyboard_event(source.clone(), 0, true)
        .map_err(|_| "could not create a keyboard event".to_string())?;
    typing.set_string(url);
    typing.post_to_pid(pid);
    let typing_up = CGEvent::new_keyboard_event(source.clone(), 0, false)
        .map_err(|_| "could not create a keyboard event".to_string())?;
    typing_up.set_string(url);
    typing_up.post_to_pid(pid);
    settle();

    post_key(&source, pid, KEY_RETURN, false)?;
    Ok(true)
}

/// Return sits at the same position on every layout we care about.
const KEY_RETURN: u16 = 36;
/// Only used when the menu item cannot be found; see `press_open_location`.
const KEY_L: u16 = 37;

/// Synthesised events are delivered asynchronously; the browser needs a
/// moment to act on one before the next arrives.
fn settle() {
    std::thread::sleep(std::time::Duration::from_millis(80));
}

fn post_key(source: &CGEventSource, pid: i32, keycode: u16, command: bool) -> Result<(), String> {
    for down in [true, false] {
        let event = CGEvent::new_keyboard_event(source.clone(), keycode, down)
            .map_err(|_| "could not create a keyboard event".to_string())?;
        if command {
            event.set_flags(CGEventFlags::CGEventFlagCommand);
        }
        event.post_to_pid(pid);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chrome_and_extension_urls_are_not_content() {
        assert!(!is_content_url(
            "chrome://browser/content/webext-panels.xhtml"
        ));
        assert!(!is_content_url(
            "moz-extension://74cd033b-a7d4-4fc0-942c-48e552dda363/sidebar/sidebar.html"
        ));
        assert!(!is_content_url("about:blank"));
        assert!(!is_content_url(""));
    }

    #[test]
    fn real_pages_are_content() {
        assert!(is_content_url("https://www.google.com/"));
        assert!(is_content_url("file:///tmp/blocked.html"));
    }

    /// Local-only: needs the Accessibility grant and a running Firefox, so
    /// it is ignored by default and never runs in CI. Re-run it with
    /// `cargo test --lib accessibility -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn reads_firefox_active_tab_locally() {
        assert!(
            is_trusted(),
            "grant Accessibility to the process running this test"
        );
        let pid = firefox_pid().expect("Firefox is not running");
        nudge_accessibility(pid);
        let mut url = None;
        for _ in 0..12 {
            std::thread::sleep(std::time::Duration::from_millis(500));
            url = active_tab_url(pid);
            if url.is_some() {
                break;
            }
        }
        let app = AxElement::for_pid(pid);
        let window = app
            .attr_element("AXFocusedWindow")
            .or_else(|| app.attr_element("AXMainWindow"));
        println!(
            "window: {:?}, top-level children: {}",
            window.as_ref().and_then(|w| w.attr_string("AXRole")),
            window.as_ref().map(|w| children(w).len()).unwrap_or(0)
        );
        println!("firefox pid {pid} active tab: {url:?}");
        println!("focus: {:?}", focus_kind(pid));
        let url = url.expect("no active tab URL");
        assert!(
            url.starts_with("http") || url.starts_with("file:"),
            "unexpected URL shape: {url}"
        );
    }

    /// Local-only, like the read check: drives the real browser, so it is
    /// ignored by default. It redirects the active tab and then puts it back,
    /// which is the same out-and-back the watcher performs when a block
    /// starts and ends.
    #[test]
    #[ignore]
    fn redirects_firefox_active_tab_locally() {
        assert!(is_trusted(), "grant Accessibility to this process");
        let pid = firefox_pid().expect("Firefox is not running");
        nudge_accessibility(pid);

        let original = wait_for_url(pid, |_| true).expect("no active tab URL");
        println!("original: {original}");

        let target = "file:///tmp/redd-block-ax-check.html";
        assert!(
            redirect_active_tab(pid, target).expect("redirect failed"),
            "redirect was deferred; is the address bar focused?"
        );
        let landed = wait_for_url(pid, |u| u.starts_with("file:///tmp/redd-block-ax-check"))
            .expect("tab never reached the target URL");
        println!("landed: {landed}");

        // Restore, which is what a pause/stop/expiry does to a parked tab.
        redirect_active_tab(pid, &original).expect("restore failed");
        let restored = wait_for_url(pid, |u| u == original).expect("tab never returned");
        println!("restored: {restored}");
    }

    #[cfg(test)]
    fn wait_for_url(pid: i32, matches: impl Fn(&str) -> bool) -> Option<String> {
        for _ in 0..30 {
            std::thread::sleep(std::time::Duration::from_millis(400));
            if let Some(url) = active_tab_url(pid) {
                if matches(&url) {
                    return Some(url);
                }
            }
        }
        None
    }

    #[cfg(test)]
    fn firefox_pid() -> Option<i32> {
        use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};
        let mut sys = System::new();
        sys.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing(),
        );
        sys.processes()
            .values()
            .find(|p| p.name().to_string_lossy() == "firefox")
            .map(|p| p.pid().as_u32() as i32)
    }

    #[test]
    fn untrusted_process_reads_nothing() {
        // The grant cannot be present in a unit test, so this pins the
        // fail-closed contract: no trust means no URL, not a wrong URL.
        if !is_trusted() {
            assert_eq!(active_tab_url(std::process::id() as i32), None);
            assert_eq!(focus_kind(std::process::id() as i32), Focus::Other);
        }
    }
}
