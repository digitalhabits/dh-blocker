// Anonymous usage ping, so we know roughly how many people use Blocker.
//
// At most once per UTC day the app sends { product, platform, key } to the
// planner. The key is a random id that is replaced at the start of each
// calendar month, so no two months of one install can be linked. Nothing
// about blocklists, schedules, sites or apps is sent. The user can turn it
// off in Settings (`settings.usagePingEnabled`, default on).
//
// The key lives in localStorage, not in the data file: the data file is
// exported and imported between machines, and two machines must not share
// a key. Android sends no ping from this code.
import { state } from './state.js';
import { saveData } from './persistence.js';

const PING_URL = 'https://plan.digitalhabits.org/api/ping';
const PING_STATE_KEY = 'usagePing';
const PING_CHECK_MS = 60 * 60_000;

let pingSentDay = null;
let pingInFlight = false;
let pingStarted = false;

export function usagePingEnabled() {
    return state.appData?.settings?.usagePingEnabled !== false;
}

export function usagePingPlatform() {
    if (state.isIOS) return 'ios';
    return navigator.platform.toUpperCase().indexOf('MAC') >= 0 ? 'mac' : 'windows';
}

function readPingState() {
    try {
        return JSON.parse(localStorage.getItem(PING_STATE_KEY) || '{}') || {};
    } catch {
        return {};
    }
}

function writePingState(value) {
    try {
        localStorage.setItem(PING_STATE_KEY, JSON.stringify(value));
    } catch { /* localStorage may be disabled; we then ping again tomorrow */ }
}

/**
 * The key to send for `month` ("YYYY-MM"): the stored one if it belongs to
 * that month, else a fresh random id.
 */
export function usagePingKeyForMonth(stored, month) {
    if (stored && stored.month === month && typeof stored.key === 'string' && stored.key) {
        return stored.key;
    }
    return randomUuid();
}

// crypto.randomUUID needs a secure context, which a custom-scheme webview
// may not count as. getRandomValues has no such rule.
function randomUuid() {
    if (typeof crypto.randomUUID === 'function') {
        try { return crypto.randomUUID(); } catch { /* fall through */ }
    }
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export async function maybeSendUsagePing() {
    if (__ANDROID_BUILD__ || state.isAndroid) return;
    const today = new Date().toISOString().slice(0, 10);
    if (pingSentDay === today || pingInFlight) return;
    if (!usagePingEnabled()) return;

    const stored = readPingState();
    if (stored.lastDay === today) {
        pingSentDay = today;
        return;
    }
    const month = today.slice(0, 7);
    const key = usagePingKeyForMonth(stored, month);
    pingInFlight = true;
    try {
        const response = await fetch(PING_URL, {
            method: 'POST',
            headers: { 'content-type': 'text/plain' },
            body: JSON.stringify({ product: 'blocker', platform: usagePingPlatform(), key }),
            credentials: 'omit',
        });
        if (!response.ok) return;
        writePingState({ month, key, lastDay: today });
        pingSentDay = today;
    } catch {
        // Offline: the hourly check tries again.
    } finally {
        pingInFlight = false;
    }
}

/** Ping now, then check hourly and whenever the window comes back. */
export function startUsagePing() {
    if (__ANDROID_BUILD__ || pingStarted) return;
    pingStarted = true;
    void maybeSendUsagePing();
    setInterval(() => void maybeSendUsagePing(), PING_CHECK_MS);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void maybeSendUsagePing();
    });
}

/**
 * The "Send anonymous usage count" switch in Settings. It reads the
 * setting each time Settings opens, because the data file loads after the
 * listeners are set up. Android hides the row.
 */
export function setupUsagePingToggle() {
    const input = document.getElementById('settings-usage-ping-input');
    if (!input) return;
    if (__ANDROID_BUILD__ || state.isAndroid) {
        document.getElementById('settings-usage-ping-row')?.classList.add('hidden');
        return;
    }
    const sync = () => { input.checked = usagePingEnabled(); };
    sync();
    ['settings-btn', 'settings-btn-stack']
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .forEach((btn) => btn.addEventListener('click', sync));
    input.addEventListener('change', async () => {
        if (!state.appData.settings) state.appData.settings = {};
        state.appData.settings.usagePingEnabled = input.checked;
        try {
            await saveData();
        } catch (e) {
            console.warn('[usage-ping] could not save the setting:', e);
        }
        if (input.checked) void maybeSendUsagePing();
    });
}
