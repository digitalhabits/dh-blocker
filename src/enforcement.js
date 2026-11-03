import { state, appState } from './state.js';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import iconChromeUrl from './images/icon-chrome.svg';
import iconBraveUrl from './images/icon-brave.svg';
import iconEdgeUrl from './images/icon-edge.svg';
import iconFirefoxUrl from './images/icon-firefox.svg';
import iconSafariUrl from './images/icon-safari.svg';
import { tauriAPI } from './tauri-api.js';
import { tSettings, tSettingsFmt } from './i18n.js';
import { kickClockNow } from './render.js';
import { setLanguagePickerOpen } from './app.js';
import { reconcileBlockingWarningShell } from './blocking-platform.js';
import { MIGRATION_POLL_MS, hasAcceptedEula, showMigrationOnboarding, presentWelcomeOnboarding, finishNativePermissionSetup } from './onboarding.js';
export function setSettingsEnforcementSectionExpanded(expanded) {
    const toggle = document.getElementById('settings-enforcement-section-toggle');
    const content = document.getElementById('settings-enforcement-content');
    if (!toggle || !content) return;
    toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    content.classList.toggle('hidden', !expanded);
}

export function resetSettingsEnforcementSection() { setSettingsEnforcementSectionExpanded(true); }

export function setupSettingsEnforcementSection() {
    const toggle = document.getElementById('settings-enforcement-section-toggle');
    if (!toggle || toggle.dataset.bound) return;
    toggle.dataset.bound = '1';
    toggle.addEventListener('click', () => setSettingsEnforcementSectionExpanded(toggle.getAttribute('aria-expanded') !== 'true'));
}

const FIREFOX_AX_POLL_TRIES = 60;

const FIREFOX_AX_POLL_MS = 1000;

export async function pollAccessibilityUntilGranted() {
    for (let i = 0; i < FIREFOX_AX_POLL_TRIES; i++) {
        if (await invoke('accessibility_trusted').catch(() => false)) break;
        await new Promise(resolve => setTimeout(resolve, FIREFOX_AX_POLL_MS));
    }
    await pollMigrationCompliance();
}

export async function requestAccessibilityGrant() {
    if (!(await invoke('accessibility_request').catch(() => false))) await pollAccessibilityUntilGranted();
    await pollMigrationCompliance();
}

export const AUTOMATION_BROWSER_KEYS = ['chrome', 'brave', 'edge', 'safari'];

export const MAC_BLOCKING_METHOD_KEYS = ['safari', 'chrome', 'edge', 'brave', 'firefox'];

export const WINDOWS_BLOCKING_METHOD_KEYS = ['chrome', 'edge', 'brave', 'firefox'];

export const ALL_BLOCKING_METHOD_KEYS = ['safari', ...WINDOWS_BLOCKING_METHOD_KEYS];

export function blockingMethodKeys() {
    return state.isWindowsDesktop ? WINDOWS_BLOCKING_METHOD_KEYS : state.isMacOSDesktop ? MAC_BLOCKING_METHOD_KEYS : [];
}



export function methodDefaultForKey(key) {
    return state.isMacOSDesktop && key === 'firefox' ? 'accessibility' : 'automation';
}

export function methodIsValidForKey(key, method) { return method === methodDefaultForKey(key); }

export function methodOptionsForKey(key) {
    return [methodDefaultForKey(key)];
}

export function browserBlockingMethod(key) { return methodDefaultForKey(key); }

export function browserUsesAutomation(key) {
    if (state.isWindowsDesktop) return browserBlockingMethod(key) === 'automation';
    if (!state.isMacOSDesktop) return false;
    // Firefox can never be on Automation, whatever is stored for it.
    if (key === 'firefox') return false;
    if (MAC_BLOCKING_METHOD_KEYS.includes(key)) {
        return browserBlockingMethod(key) === 'automation';
    }
    return false;
}

export function browserUsesAccessibility(key) {
    if (!state.isMacOSDesktop) return false;
    return browserBlockingMethod(key) === 'accessibility';
}

export let lastAutomationPermissionByKey = {};

let lastAutomationRunningByKey = {};

let lastAutomationPermissionFetchAt = 0;

let automationPermissionStatusReady = false;

export const AUTOMATION_PERMISSION_FETCH_MIN_MS = 2000;

export function normalizeLaunchProbeBrowsers(browserKeyOrLabels) {
    if (browserKeyOrLabels == null) return null;
    const list = Array.isArray(browserKeyOrLabels) ? browserKeyOrLabels : [browserKeyOrLabels];
    const keys = list.map((b) => browserKeyFromLabel(b) || b).filter(Boolean);
    return keys.length > 0 ? keys : null;
}

export async function refreshAutomationPermissionStatus({
    force = false,
    launchProbe = false,
    launchProbeBrowser = null,
    launchProbeBrowsers = null,
} = {}) {
    if (__ANDROID_BUILD__) return lastAutomationPermissionByKey;
    if (!state.isMacOSDesktop) return lastAutomationPermissionByKey;
    const now = Date.now();
    if (!force && now - lastAutomationPermissionFetchAt < AUTOMATION_PERMISSION_FETCH_MIN_MS) {
        return lastAutomationPermissionByKey;
    }
    try {
        const probeList = launchProbeBrowsers ?? normalizeLaunchProbeBrowsers(launchProbeBrowser);
        const list = await tauriAPI.webAutomationPermissionStatus({
            launchProbe,
            launchProbeBrowser: probeList ? null : launchProbeBrowser,
            launchProbeBrowsers: probeList,
        });
        lastAutomationPermissionFetchAt = now;
        const map = {};
        const runningMap = {};
        for (const info of (list || [])) {
            const key = browserKeyFromLabel(info.label || info.browser);
            if (key) {
                map[key] = info.state; // 'granted' | 'denied' | 'unknown'
                runningMap[key] = !!info.running;
            }
        }
        lastAutomationPermissionByKey = map;
        lastAutomationRunningByKey = runningMap;
        if (state.isMacOSDesktop) automationPermissionStatusReady = true;
    } catch (e) {
        console.warn('[automation] permission status fetch failed:', e);
    }
    return lastAutomationPermissionByKey;
}

export function automationBrowserIsRunning(key, browserScan) {
    if (automationPermissionStatusReady && Object.prototype.hasOwnProperty.call(lastAutomationRunningByKey, key)) {
        return !!lastAutomationRunningByKey[key];
    }
    return !!browserScan?.present;
}

export function automationBrowserRowMode(key, browserScan) {
    const perm = lastAutomationPermissionByKey[key] || 'unknown';
    const running = automationBrowserIsRunning(key, browserScan);
    if (perm === 'granted') return 'granted';
    if (!running) return 'awaiting-open';
    if (perm === 'denied') return 'denied';
    return 'needs-grant';
}

export async function renderNativePermissionRows(scan) {
    if (__ANDROID_BUILD__) return;
    appState.lastMigrationBrowserState = scan;
    const container = document.getElementById('migration-browser-buttons');
    if (!container) return;
    container.replaceChildren();
    if (!appState.isMacOSDesktop) return;
    if (!scan?.browsers) throw new Error('Native browser inventory unavailable');
    const browsers = scan.browsers;
    const accessibilityGranted = !browsers.firefox?.installed || await invoke('accessibility_trusted').catch(() => false);
    for (const key of AUTOMATION_BROWSER_KEYS) {
        if (!browsers[key]?.installed || lastAutomationPermissionByKey[key] === 'granted') continue;
        container.appendChild(buildAutomationBrowserRow(key, BROWSER_INFO[key], browsers[key]));
    }
    if (browsers.firefox?.installed && !accessibilityGranted) {
        const row = document.createElement('div');
        row.className = 'migration-browser-row';
        const label = document.createElement('p');
        label.textContent = 'Firefox · ' + tSettings('firefoxAxSettingsNotGranted');
        row.appendChild(label);
        const button = document.createElement('button');
        button.className = 'migration-primary-btn';
        button.textContent = tSettings('firefoxAxSettingsGrantBtn');
        button.addEventListener('click', () => void requestAccessibilityGrant());
        row.appendChild(button);
        container.appendChild(row);

    }
    if (container.childElementCount === 0 && appState.migrationOnboardingActive) { await finishNativePermissionSetup(); return; }
    const done = document.getElementById('migration-done-btn');
    if (done) done.textContent = tSettings('migrationContinue');
    const title = document.getElementById('migration-post-title');
    const subtitle = document.getElementById('migration-post-subtitle');
    if (title) title.textContent = tSettings('nativePermissionTitle');
    if (subtitle) subtitle.textContent = tSettings('nativePermissionSubtitle');
    document.getElementById('migration-post-title-row')?.classList.remove('hidden');
    for (const id of ['migration-howto', 'migration-checklist-ext-lines', 'enforcement-toggle-section']) {
        document.getElementById(id)?.classList.add('hidden');
    }
}

export async function pollMigrationCompliance({ launchProbe = false } = {}) {
    if (!state.migrationOnboardingActive) return;
    try {
        await refreshAutomationPermissionStatus({ force: true, launchProbe });
        const fresh = await invoke('onboarding_state');
        await renderNativePermissionRows(fresh);
    } catch (e) { /* no-op */ }
}

export function startMigrationPolling() {
    if (__ANDROID_BUILD__) return;
    if (state.migrationPollIntervalId) return;
    state.migrationPollIntervalId = setInterval(pollMigrationCompliance, MIGRATION_POLL_MS);
}

export function stopMigrationPolling() {
    if (__ANDROID_BUILD__) return;
    if (state.migrationPollIntervalId) {
        clearInterval(state.migrationPollIntervalId);
        state.migrationPollIntervalId = null;
    }
}

export function onAppForeground() {
    kickClockNow();
    void reconcileBlockingWarningShell();
    if (state.migrationOnboardingActive) { void pollMigrationCompliance(); return; }
    if (hasAcceptedEula() && state.startupInitializationComplete) {
        void refreshNativePermissionsIfStale({ force: true });
        void hydrateNativeWarnings();
        renderNativeEnforcementWarning();
    }
}

export function setupAppForegroundRefresh() {
    if (__ANDROID_BUILD__ || foregroundRefreshAttached) return;
    foregroundRefreshAttached = true;
    void Promise.resolve().then(() => getCurrentWindow().onFocusChanged(({ payload }) => { if (payload) onAppForeground(); })).catch(() => {});
    document.addEventListener('visibilitychange', () => { if (!document.hidden) onAppForeground(); });
}

export let lastOnboardingState = null;

export async function refreshNativePermissions(scan) {
    if (__ANDROID_BUILD__ || state.isIOS || state.isAndroid) return;
    lastOnboardingState = scan || lastOnboardingState;
    if (state.isMacOSDesktop) {
        await refreshAutomationPermissionStatus({ force: true });
        for (const key of AUTOMATION_BROWSER_KEYS) {
            const label = BROWSER_INFO[key].label;
            if (!scan?.browsers?.[key]?.installed) { permissionWarnings.delete(label); continue; }
            if (lastAutomationPermissionByKey[key] === 'granted') permissionWarnings.delete(label);
            else permissionWarnings.set(label, lastAutomationPermissionByKey[key] === 'denied' ? tSettings('nativePermissionAutomationDenied') : tSettings('nativePermissionUnconfirmed'));
        }
        if (scan?.browsers?.firefox?.installed) {
            const trusted = await invoke('accessibility_trusted').catch(() => false);
            const engine = trusted ? await invoke('firefox_ax_status').catch(() => 'waitingForEngine') : null;
            if (!trusted) permissionWarnings.set('Firefox', tSettings('nativePermissionAccessibilityDenied'));
            else if (engine === 'waitingForEngine') permissionWarnings.set('Firefox', tSettings('nativeFirefoxWaiting'));
            else permissionWarnings.delete('Firefox');
        } else {
            permissionWarnings.delete('Firefox');
        }
        renderNativeEnforcementWarning();
    }
}

export async function openNativePermissionSetup() {
    if (__ANDROID_BUILD__ || !state.isMacOSDesktop) return;
    const fresh = await invoke('onboarding_state');
    await refreshAutomationPermissionStatus({ force: true });
    document.getElementById('settings-modal')?.classList.add('hidden');
    setLanguagePickerOpen(false);
    await showMigrationOnboarding('post', fresh, { mode: 'fresh' });
}

export function finishOnboardingReplayToMainUi() {
    state.forceShowEulaThisSession = false;
    state.migrationOnboardingActive = false;
    state.firstRunNativePermissionSetupPending = false;
    document.getElementById('welcome-onboarding')?.classList.add('hidden');
    document.getElementById('main-content')?.classList.remove('hidden');
}

export async function restartOnboardingFromSettings() {
    if (__ANDROID_BUILD__) return;
    if (state.isIOS || state.isAndroid) return;
    document.getElementById('settings-modal')?.classList.add('hidden');
    setLanguagePickerOpen(false);
    await presentWelcomeOnboarding(finishOnboardingReplayToMainUi);
}

let lastBannerRefreshAt = 0;

export const BANNER_REFRESH_THROTTLE_MS = 5_000;

export async function refreshNativePermissionsIfStale({ force = false } = {}) {
    if (__ANDROID_BUILD__) return;
    if (state.isIOS || state.isAndroid) return;
    if (state.migrationOnboardingActive) return; // overlay is the source of truth
    if (!state.startupInitializationComplete) return;
    const now = Date.now();
    if (!force && now - lastBannerRefreshAt < BANNER_REFRESH_THROTTLE_MS) return;
    lastBannerRefreshAt = now;
    try {
        if (state.isMacOSDesktop) await refreshAutomationPermissionStatus({ force });
        const fresh = await invoke('onboarding_state');
        await refreshNativePermissions(fresh);

    } catch (_) { /* no-op */ }
}

export async function startWebAutomationWatcher() {
    if (__ANDROID_BUILD__) return;
    if (!state.isMacOSDesktop) return;
    try {
        await Promise.all([tauriAPI.webAutomationStart(), invoke('firefox_ax_start')]);
    } catch (e) {
        console.warn('[web-automation] web_automation_start failed:', e);
    }
}

export function browserKeyFromLabel(label) {
    if (!label) return null;
    const normalized = String(label).toLowerCase();
    if (normalized.includes('firefox')) return 'firefox';
    if (normalized.includes('brave')) return 'brave';
    if (normalized.includes('edge')) return 'edge';
    if (normalized.includes('safari')) return 'safari';
    return 'chrome';
}

export function browserIconUrl(key) {
    switch (key) {
        case 'firefox': return iconFirefoxUrl;
        case 'edge': return iconEdgeUrl;
        case 'safari': return iconSafariUrl;
        case 'brave': return iconBraveUrl;
        case 'chrome':
        default: return iconChromeUrl;
    }
}
export const BROWSER_INFO = Object.fromEntries([['safari', 'Safari'], ['chrome', 'Chrome'], ['brave', 'Brave'], ['edge', 'Edge'], ['firefox', 'Firefox']].map(([key, label]) => [key, { label }]));
let foregroundRefreshAttached = false;

export function buildAutomationBrowserRow(key, entry, browserScan) {
    const row = document.createElement('div');
    row.className = 'migration-browser-row';
    const label = document.createElement('p');
    label.textContent = entry.label;
    row.appendChild(label);
    const button = document.createElement('button');
    button.className = 'migration-primary-btn';
    const mode = automationBrowserRowMode(key, browserScan);
    const denied = mode === 'denied';
    button.textContent = mode === 'awaiting-open' ? tSettingsFmt('nativeOpenBrowserFmt', { browser: entry.label }) : denied ? tSettings('migrationOpenAutomationSettings') : tSettingsFmt('migrationGrantAutomation', { browser: entry.label });
    button.addEventListener('click', async () => {
        if (denied) await tauriAPI.openAutomationSettings();
        else await tauriAPI.requestAutomationPermission(entry.label);
        await pollMigrationCompliance({ launchProbe: true });
    });
    row.appendChild(button);
    return row;
}

const nativeWarnings = new Map();
const permissionWarnings = new Map();
let warningCountdownTimer = null;
let nativeAlertsAttached = false;
let nativeWarningGeneration = 0;
export function renderNativeEnforcementWarning() {
    let banner = document.getElementById('native-enforcement-warning');
    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'native-enforcement-warning';
        banner.className = 'update-banner setup-banner hidden';
        banner.setAttribute('role', 'alert');
        const message = document.createElement('div');
        message.className = 'update-banner-content';
        const text = document.createElement('span');
        text.className = 'native-enforcement-warning-text';
        message.appendChild(text);
        const button = document.createElement('button');
        button.className = 'update-banner-btn';
        button.textContent = tSettings('nativeReviewPermissions');
        button.classList.toggle('hidden', !state.isMacOSDesktop);
        button.addEventListener('click', () => void openNativePermissionSetup());
        message.appendChild(button);
        banner.appendChild(message);
        document.querySelector('.app-container')?.prepend(banner);
    }
    banner.classList.toggle('hidden', nativeWarnings.size === 0 && permissionWarnings.size === 0);
    const text = banner.querySelector('.native-enforcement-warning-text');
    const messages = [...permissionWarnings.entries()].map(([browser, reason]) => browser + ': ' + reason);
    for (const warning of nativeWarnings.values()) {
        const browser = warning.browser;
        const key = warning.diagnosticOnly ? 'nativeWarningDiagnosticFmt' : warning.deadline == null ? 'nativeWarningAwaitingVisibleFmt' : 'nativeWarningCountdownFmt';
        messages.push(tSettingsFmt(key, { browser, reason: warning.reason, seconds: Math.max(0, Math.ceil((warning.deadline - Date.now()) / 1000)) }));
    }
    if (text) text.textContent = messages.join(' ');
    requestAnimationFrame(() => void acknowledgeVisibleNativeWarnings());
    const counting = [...nativeWarnings.values()].some(warning => !warning.diagnosticOnly);
    if (counting && !warningCountdownTimer) warningCountdownTimer = setInterval(renderNativeEnforcementWarning, 1000);
    if (!counting && warningCountdownTimer) { clearInterval(warningCountdownTimer); warningCountdownTimer = null; }
}
export function setupNativeEnforcementAlerts() {
    if (__ANDROID_BUILD__ || state.isIOS || state.isAndroid || nativeAlertsAttached) return;
    nativeAlertsAttached = true;
    void (async () => {
        await Promise.all([
            listen('native-permission-changed', () => { void refreshNativePermissionsIfStale({ force: true }); }),
            listen('native-enforcement-warning', ({ payload }) => showNativeEnforcementWarning(payload)),
            listen('native-enforcement-recovered', ({ payload }) => {
                nativeWarningGeneration++;
                const browser = String(payload?.browser || payload);
                for (const [key, warning] of nativeWarnings) if (warning.browser === browser) nativeWarnings.delete(key);
                renderNativeEnforcementWarning();
            }),
        ]);
        await hydrateNativeWarnings();
    })().catch(() => { nativeAlertsAttached = false; });
}


export function showNativeEnforcementWarning(payload) {
    if (__ANDROID_BUILD__ || state.isIOS || state.isAndroid || !payload?.browser) return;
    nativeWarningGeneration++;
    const key = String(payload.warningId ?? payload.browser);
    const previous = nativeWarnings.get(key);
    const serverDeadline = payload.warningVisible === true && Number.isFinite(payload.remainingGraceSeconds) ? Date.now() + payload.remainingGraceSeconds * 1000 : null;
    nativeWarnings.set(key, {
        browser: String(payload.browser), warningId: payload.warningId,
        reason: nativeFailureReason(payload.reason),
        diagnosticOnly: payload.diagnosticOnly !== false,
        deadline: serverDeadline != null ? Math.min(previous?.deadline ?? Infinity, serverDeadline) : previous?.deadline ?? (payload.warningId == null ? Date.now() + Math.max(0, Number(payload.graceSeconds) || 60) * 1000 : null),
        acknowledged: payload.warningVisible === true || previous?.acknowledged || false,
    });
    renderNativeEnforcementWarning();
}

export function nativeFailureReason(reason) {
    const key = { PermissionDenied: 'nativeReasonPermissionDenied', AccessPrevented: 'nativeReasonAccessPrevented', BlockedUrlRemains: 'nativeReasonBlockedUrlRemains' }[reason];
    return key ? tSettings(key) : String(reason || tSettings('nativeReasonAccessPrevented'));
}

const nativeWarningAcksInFlight = new Set();
export async function acknowledgeVisibleNativeWarnings() {
    if (__ANDROID_BUILD__ || document.hidden || document.visibilityState !== 'visible') return;
    const banner = document.getElementById('native-enforcement-warning');
    if (!banner || banner.classList.contains('hidden')) return;
    const rect = banner.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.top >= window.innerHeight) return;
    const x = Math.max(0, Math.min(window.innerWidth - 1, rect.left + rect.width / 2));
    const y = Math.max(0, Math.min(window.innerHeight - 1, rect.top + rect.height / 2));
    const top = document.elementFromPoint?.(x, y);
    if (!top || !banner.contains(top)) return;
    for (const warning of nativeWarnings.values()) {
        if (warning.warningId == null || warning.acknowledged || nativeWarningAcksInFlight.has(warning.warningId)) continue;
        nativeWarningAcksInFlight.add(warning.warningId);
        try {
            if (await invoke('native_warning_visible', { warningId: warning.warningId })) {
                warning.acknowledged = true;
                if (warning.deadline == null) warning.deadline = Date.now() + 60000;
            }
        } catch (_) { /* No ACK means no automatic close. */ }
        finally { nativeWarningAcksInFlight.delete(warning.warningId); }
    }
}
export async function hydrateNativeWarnings() {
    if (__ANDROID_BUILD__ || state.isIOS || state.isAndroid) return;
    try {
        const generation = nativeWarningGeneration;
        const status = await invoke('native_website_status');
        const warnings = status?.pendingWarnings;
        if (!Array.isArray(warnings) || generation !== nativeWarningGeneration) return;
        const pending = new Set(warnings.map(warning => String(warning.warningId ?? warning.browser)));
        for (const key of nativeWarnings.keys()) if (!pending.has(key)) nativeWarnings.delete(key);
        for (const warning of warnings) showNativeEnforcementWarning(warning);
        renderNativeEnforcementWarning();
    } catch (_) { /* Foreground events retry the snapshot. */ }
}
