// Pure method policy, mirrored by src-tauri/src/blocking_method.rs.
// Missing/invalid Windows choices retain Extension unless policy confirms
// native messaging is blocked; an explicit saved choice always wins.
export const MAC_BLOCKING_METHOD_KEYS = ['safari', 'chrome', 'edge', 'brave'];
export const WINDOWS_BLOCKING_METHOD_KEYS = ['chrome', 'edge', 'brave', 'firefox'];
export const ALL_BLOCKING_METHOD_KEYS = ['safari', ...WINDOWS_BLOCKING_METHOD_KEYS];

export function windowsBrowserMethod(key, methods, browser) {
    if (!WINDOWS_BLOCKING_METHOD_KEYS.includes(key)) return 'extension';
    if (methods[key] === 'automation' || methods[key] === 'extension') return methods[key];
    return key !== 'firefox' && browser?.nativeHostBlockedByPolicy ? 'automation' : 'extension';
}

