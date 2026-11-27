// App data persistence and platform blocking synchronisation.
import { state } from './state.js';
import { tauriAPI } from './tauri-api.js';
import { normalizeBlocklist, isProtectedDomain, collectActiveIOSManualBlockPayload, healFocusSpaceColors, healWwwWebsiteEntries, migrateLegacyQuickStartBlocklists } from './blocklist-utils.js';
import { isSchedulePausedNow, buildPersistedAppData } from './schedule-engine.js';
import { updateBlockedApps } from './blocking-platform.js';
import { normalizeLoadedEulaState } from './onboarding.js';
import { migrateBlocklistStartOverlaysToGlobal, migrateLegacyScheduleStartOverlays } from './schedule-overlay.js';
import { migrateLegacyRepeatType } from './when-to-block.js';
import { getMaxOverrideWords, migrateOverrideDifficultyToWords } from './override-challenge.js';
import { getLastBreakMinutes } from './unlock-duration.js';
import { isScheduleSegmentActiveNow } from './schedule-editor.js';

export async function loadData() {
    state.appData = await tauriAPI.loadData();
    let shouldSave = false;
    if (!state.appData || !state.appData.blocklists) {
        state.appData = {
            blocklists: [],
            activeBlocks: [],
            schedules: [],
            settings: {}
        };
    }
    // Ensure schedules array exists for older data
    if (!state.appData.schedules) {
        state.appData.schedules = [];
    }
    // A pre-fix bug could insert a duplicate schedule for the same blocklist when
    // saving edits (both the start-flow and edit-flow proceed handlers fired). If
    // that left two entries, keep the one with the most segments and drop the rest.
    if (state.appData.schedules.length > 1) {
        const byBlocklist = new Map();
        for (const s of state.appData.schedules) {
            const existing = byBlocklist.get(s.blocklistId);
            const segCount = Array.isArray(s.segments) ? s.segments.length : 0;
            const existingCount = existing && Array.isArray(existing.segments) ? existing.segments.length : -1;
            if (!existing || segCount > existingCount) {
                byBlocklist.set(s.blocklistId, s);
            }
        }
        if (byBlocklist.size < state.appData.schedules.length) {
            state.appData.schedules = [...byBlocklist.values()];
            shouldSave = true;
        }
    }
    // Ensure settings exists
    if (!state.appData.settings) {
        state.appData.settings = {};
    }
    if (normalizeLoadedEulaState()) {
        shouldSave = true;
    }
    state.appData.blocklists = (state.appData.blocklists || []).map((bl) => normalizeBlocklist(bl));
    if (migrateLegacyQuickStartBlocklists(state.appData)) {
        shouldSave = true;
    }
    // The editor keeps unsaved edits in memory only; drop the per-space drafts
    // and the Timer / Schedule tab preferences older versions persisted.
    for (const key of ['pendingScheduleSegments', 'pendingScheduleRepeatOptions', 'preferredStartMode', 'alwaysOnMode', 'instantBlockDuration']) {
        if (key in state.appData.settings) {
            delete state.appData.settings[key];
            shouldSave = true;
        }
    }
    // "Until" has no one-shot option any more.
    for (const schedule of state.appData.schedules) {
        if (migrateLegacyRepeatType(schedule)) shouldSave = true;
    }
    // overrideDifficulty.count is a word count everywhere now. Desktop stores
    // written before this flag hold character targets; phone stores already
    // held words. Gibberish and Max difficulty are folded in the same pass.
    if (state.appData.settings.overrideCountUnit !== 'words') {
        const countsAreChars = !(state.isIOS);
        for (const bl of state.appData.blocklists) {
            bl.overrideDifficulty = migrateOverrideDifficultyToWords(bl.overrideDifficulty, {
                maxWords: getMaxOverrideWords(),
                countsAreChars,
            });
        }
        state.appData.settings.overrideCountUnit = 'words';
        shouldSave = true;
    }
    // The dialog remembers a global timed choice. Never change existing pauses
    // or infer a preference from legacy per-space unlockMinutes.
    const lastBreakMinutes = getLastBreakMinutes(state.appData.settings);
    if (state.appData.settings.lastBreakMinutes !== lastBreakMinutes) {
        state.appData.settings.lastBreakMinutes = lastBreakMinutes;
        shouldSave = true;
    }
    if ('defaultPauseMinutes' in state.appData.settings) {
        delete state.appData.settings.defaultPauseMinutes;
        shouldSave = true;
    }
    if (healFocusSpaceColors(state.appData.blocklists)) {
        shouldSave = true;
    }
    if (healWwwWebsiteEntries(state.appData.blocklists)) {
        shouldSave = true;
    }
    if (migrateBlocklistStartOverlaysToGlobal()) {
        shouldSave = true;
    }
    if (migrateLegacyScheduleStartOverlays()) {
        shouldSave = true;
    }

    // No default focus space: a fresh install starts empty, so the first
    // space is built by hand and teaches how the app works.

    if (shouldSave) {
        try {
            await saveData();
        } catch (error) {
            if (!state.isIOS) throw error;
            // A migration write failure does not invalidate the state we read.
            console.warn('[startup] Could not save iOS data migrations:', error);
        }
    }
}

// True when this install has been through onboarding before — the signal
// that distinguishes an existing (upgrading) user from a fresh install.
export function hasSeenAnyOnboarding() {
    const settings = state.appData?.settings || {};
    return settings.onboardingComplete === true
        || settings.welcomeOnboardingShown === true
        || settings.eulaAcceptedRevision != null
        || settings.eulaAcceptedAt != null;
}

// Save data to main process
export async function saveData(appData = state.appData) {
    await tauriAPI.saveData(buildPersistedAppData(appData));
}

export async function syncBlockingState() {
    if (state.isIOS) return syncIOSManualBlockingState();

    const allDomains = new Set();
    const now = Date.now();

    // Only block domains for blocks that are currently active and not paused
    state.appData.activeBlocks
        .filter(block => block.startTime <= now && block.endTime > now && !block.isPaused)
        .forEach(block => {
            const blocklist = state.appData.blocklists.find(bl => bl.id === block.blocklistId);
            if (blocklist && blocklist.websites) {
                blocklist.websites.forEach(domain => allDomains.add(domain));
            }
        });

    // Also check scheduled blocks - add domains if a schedule segment is currently active
    const nowDate = new Date();

    if (state.appData.schedules) {
        state.appData.schedules.forEach(schedule => {
            if (!schedule.segments) return;

            // Skip paused schedules
            if (isSchedulePausedNow(schedule)) return;

            if (isScheduleSegmentActiveNow(schedule, nowDate)) {
                const blocklist = state.appData.blocklists.find(bl => bl.id === schedule.blocklistId);
                if (blocklist && blocklist.websites) {
                    blocklist.websites.forEach(domain => allDomains.add(domain));
                }
            }
        });
    }

    // Filter out protected domains (localhost etc. must never be blocked)
    const domainsArray = Array.from(allDomains)
        .filter(d => !isProtectedDomain(d))
        .sort();
    const lastDomainsArray = Array.from(state.lastBlockedDomains).sort();
    const domainsChanged = JSON.stringify(domainsArray) !== JSON.stringify(lastDomainsArray);

    if (!domainsChanged) {
        return { success: true, unchanged: true };
    }

    // Desktop website enforcement reads the saved app data.
    state.lastBlockedDomains = allDomains;
    await updateBlockedApps();
    return { success: true };
}

async function syncIOSManualBlockingState() {
    try {
        const payload = collectActiveIOSManualBlockPayload();
        // Native schedule policy has its own clock and store. Empty manual
        // intent only authorises releasing the manual channel.
        const result = payload.blockStartMs == null
            ? await tauriAPI.screentimeClearManualBlock()
            : await tauriAPI.screentimeStartBlock(payload);
        if (result?.success !== true) {
            const error = result?.error || 'Screen Time could not update manual blocking';
            console.error('[syncBlockingState] iOS Screen Time error:', error);
            return { success: false, error };
        }
        state.lastBlockedDomains = new Set(payload.domains);
        return { success: true };
    } catch (err) {
        console.error('[syncBlockingState] iOS Screen Time error:', err);
        return { success: false, error: String(err) };
    }
}
