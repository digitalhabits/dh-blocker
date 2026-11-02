// Pure method policy, mirrored by src-tauri/src/blocking_method.rs.
// Missing/invalid Windows choices retain Extension unless policy confirms
// native messaging is blocked; an explicit saved choice always wins.
// Firefox is here for macOS because it has a method *choice* (extension, the
// default, or accessibility) — not because it can be automated. It has no
// AppleScript dictionary for tabs, so it is deliberately absent from
// AUTOMATION_BROWSER_KEYS in enforcement.js.
export const MAC_BLOCKING_METHOD_KEYS = ['safari', 'chrome', 'edge', 'brave', 'firefox'];
export const WINDOWS_BLOCKING_METHOD_KEYS = ['chrome', 'edge', 'brave', 'firefox'];
export const ALL_BLOCKING_METHOD_KEYS = ['safari', ...WINDOWS_BLOCKING_METHOD_KEYS];

export function windowsBrowserMethod(key, methods, browser) {
    if (!WINDOWS_BLOCKING_METHOD_KEYS.includes(key)) return 'extension';
    // Only the two methods Windows can enforce with are honoured. A stored
    // 'accessibility' — which exists for Firefox on macOS alone — therefore
    // falls through to the default below rather than leaving the browser on a
    // method this platform has no implementation for.
    if (methods[key] === 'automation' || methods[key] === 'extension') return methods[key];
    return key !== 'firefox' && browser?.nativeHostBlockedByPolicy ? 'automation' : 'extension';
}

