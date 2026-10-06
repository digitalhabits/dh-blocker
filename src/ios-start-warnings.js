// iOS start warnings: a notification 2 minutes before a focus space starts or
// comes back from a pause. Swift plans and books them from the saved schedules
// (tauri-plugin-screentime StartWarnings.swift); this module sends the setting,
// the wording and the manual resumes, and runs the onboarding screen and the
// Settings switch. A failure here only ever means a missing warning.
import { state } from './state.js';
import { tauriAPI } from './tauri-api.js';
import { saveData } from './persistence.js';
import { getSettingsLanguage, tSettings } from './i18n.js';
import { isAllowlistBlocklist } from './blocklist-utils.js';
import { updateOnboardingVisibility } from './blocking-platform.js';

const DELIVERABLE = ['authorized', 'provisional', 'ephemeral'];

/** The Settings switch (`settings.startWarningsEnabled`, default on). */
export function startWarningsEnabled() {
    return state.appData?.settings?.startWarningsEnabled !== false;
}

export function notificationsAllowed() {
    return DELIVERABLE.includes(state.notificationPermission);
}

/**
 * What Swift needs beyond the saved schedules. Manual spaces stopped for a set
 * time are sent here, because Swift keeps no resume time or name for them.
 */
export function buildStartWarningsPayload(now = Date.now()) {
    const manualResumes = (state.appData?.activeBlocks || [])
        .filter((b) => b.isPaused && b.pauseEndTime > now && b.endTime > b.pauseEndTime)
        .map((b) => {
            const blocklist = state.appData.blocklists?.find((bl) => bl.id === b.blocklistId);
            return {
                id: String(b.id ?? b.blocklistId),
                name: blocklist?.name ?? null,
                emoji: blocklist?.emoji ?? null,
                mode: isAllowlistBlocklist(blocklist) ? 'allowlist' : null,
                resumeAtMs: b.pauseEndTime,
            };
        });
    return {
        enabled: startWarningsEnabled() && state.screentimeAuthorized === true,
        locale: getSettingsLanguage(),
        strings: {
            startTitleFmt: tSettings('startWarningTitleFmt'),
            blockBodyFmt: tSettings('startWarningBlockBodyFmt'),
            allowBodyFmt: tSettings('startWarningAllowBodyFmt'),
            resumeTitleFmt: tSettings('startWarningResumeTitleFmt'),
            multiTitleFmt: tSettings('startWarningMultiTitleFmt'),
            multiBodyFmt: tSettings('startWarningMultiBodyFmt'),
            unnamedSpace: tSettings('startWarningUnnamedSpace'),
        },
        manualResumes,
    };
}

/** Rebuilds the booked warnings. Called after every schedule sync and on its own triggers. */
export async function syncIOSStartWarnings() {
    if (__ANDROID_BUILD__ || !state.isIOS) return;
    try {
        const result = await tauriAPI.screentimeSetStartWarnings(buildStartWarningsPayload());
        if (result?.status) state.notificationPermission = result.status;
        if (result?.success === false) console.warn('[start warnings] rebuild failed:', result.error);
    } catch (e) {
        console.warn('[start warnings] rebuild failed:', e);
    }
    renderStartWarningsRow();
}

export async function refreshNotificationPermission() {
    if (__ANDROID_BUILD__ || !state.isIOS) return;
    try {
        state.notificationPermission = (await tauriAPI.screentimeCheckNotificationPermission())?.status ?? null;
    } catch (e) {
        console.warn('[start warnings] permission check failed:', e);
    }
    renderStartWarningsRow();
}

async function saveStartWarningsSetting(enabled) {
    if (!state.appData.settings) state.appData.settings = {};
    state.appData.settings.startWarningsEnabled = enabled;
    try {
        await saveData();
    } catch (e) {
        console.warn('[start warnings] could not save the setting:', e);
    }
}

/** Turns the setting on and shows the iOS prompt if iOS has never asked. */
async function turnOnStartWarnings() {
    await saveStartWarningsSetting(true);
    try {
        state.notificationPermission = (await tauriAPI.screentimeRequestNotificationPermission())?.status ?? null;
    } catch (e) {
        console.warn('[start warnings] permission request failed:', e);
    }
}

/** On only when the setting is on and iOS lets us notify, so an install iOS never asked reads off. */
function renderStartWarningsRow() {
    const row = document.getElementById('settings-start-warnings-row');
    if (!row) return;
    row.classList.toggle('hidden', !state.isIOS);
    const denied = state.notificationPermission === 'denied';
    const input = document.getElementById('settings-start-warnings-input');
    if (input) input.checked = startWarningsEnabled() && notificationsAllowed();
    document.getElementById('settings-start-warnings-switch')?.classList.toggle('hidden', denied);
    document.getElementById('settings-start-warnings-open-btn')?.classList.toggle('hidden', !denied);
    document.getElementById('settings-start-warnings-denied')?.classList.toggle('hidden', !denied);
}

export function setupStartWarningsToggle() {
    const input = document.getElementById('settings-start-warnings-input');
    if (!input) return;
    if (__ANDROID_BUILD__ || !state.isIOS) {
        document.getElementById('settings-start-warnings-row')?.classList.add('hidden');
        return;
    }
    ['settings-btn', 'settings-btn-stack']
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .forEach((btn) => btn.addEventListener('click', () => void refreshNotificationPermission()));
    input.addEventListener('change', async () => {
        await (input.checked ? turnOnStartWarnings() : saveStartWarningsSetting(false));
        await syncIOSStartWarnings();
    });
    document.getElementById('settings-start-warnings-open-btn')?.addEventListener('click', () => {
        tauriAPI.screentimeOpenNotificationSettings().catch((e) => console.warn('[start warnings] could not open Settings:', e));
    });
    void refreshNotificationPermission();
}

/** The onboarding screen shown straight after Screen Time is granted. */
export function setupStartWarningsOnboarding() {
    if (__ANDROID_BUILD__) return;
    const finish = () => {
        state.iosNotificationOnboardingPending = false;
        updateOnboardingVisibility();
        void syncIOSStartWarnings();
    };
    const turnOnBtn = document.getElementById('ios-notifications-turn-on-btn');
    turnOnBtn?.addEventListener('click', async () => {
        turnOnBtn.disabled = true;
        turnOnBtn.textContent = tSettings('iosNotificationsRequestingBtn');
        await turnOnStartWarnings();
        turnOnBtn.disabled = false;
        turnOnBtn.textContent = tSettings('iosNotificationsTurnOnBtn');
        finish();
    });
    document.getElementById('ios-notifications-not-now-btn')?.addEventListener('click', finish);
}

export function applyStartWarningsLanguage() {
    const set = (id, key) => {
        const el = document.getElementById(id);
        if (el) el.textContent = tSettings(key);
    };
    document.getElementById('ios-notifications-onboarding-app-icon')?.setAttribute('alt', tSettings('eulaWelcomeIconAlt'));
    set('ios-notifications-onboarding-title', 'iosNotificationsOnboardingTitle');
    set('ios-notifications-onboarding-body', 'iosNotificationsOnboardingBody');
    const turnOnBtn = document.getElementById('ios-notifications-turn-on-btn');
    if (turnOnBtn && !turnOnBtn.disabled) turnOnBtn.textContent = tSettings('iosNotificationsTurnOnBtn');
    set('ios-notifications-not-now-btn', 'iosNotificationsNotNowBtn');
    set('ios-notifications-onboarding-note', 'iosNotificationsOnboardingNote');
    set('settings-start-warnings-label', 'settingsStartWarningsLabel');
    set('settings-start-warnings-hint', 'settingsStartWarningsHint');
    set('settings-start-warnings-denied', 'settingsStartWarningsDenied');
    set('settings-start-warnings-open-btn-label', 'settingsStartWarningsOpenBtn');
}
