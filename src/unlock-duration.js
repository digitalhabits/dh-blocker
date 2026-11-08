// Pause durations and legacy import compatibility. Pure helpers only.
// The dialog uses PAUSE_MINUTE_OPTIONS and settings.lastBreakMinutes; legacy
// per-space unlockMinutes values are retained only for older data/imports.

/** Legacy per-space values accepted on import; 0 = Never. */
export const UNLOCK_MINUTE_OPTIONS = Object.freeze([0, 5, 10, 15, 30, 60, 120, 240, 480, 1440]);

// Keep legacy values above for imported data; new pauses no longer offer 15 minutes.
export const PAUSE_MINUTE_OPTIONS = Object.freeze([5, 10, 30, 60, 120, 240, 480, 1440, 0]);
export function getLastBreakMinutes(settings) {
    const minutes = Number(settings?.lastBreakMinutes);
    return minutes > 0 && PAUSE_MINUTE_OPTIONS.includes(minutes) ? minutes : 10;
}
export function rememberBreakMinutes(settings, minutes) {
    if (minutes > 0 && PAUSE_MINUTE_OPTIONS.includes(minutes)) settings.lastBreakMinutes = minutes;
}

/** 24 hours. Also applied to spaces saved before this field existed. */
export const DEFAULT_UNLOCK_MINUTES = 1440;

/** What a newly created focus space starts on after an early stop. */
export const NEW_SPACE_UNLOCK_MINUTES = 10;

/** An allow-only space starts on Never: once stopped, it stays off until turned on again. */
export const NEW_ALLOW_SPACE_UNLOCK_MINUTES = 0;

/**
 * Anything that is not exactly one of the menu options falls back to the
 * default. Falling back to the strict end matters: a stop that used to be
 * permanent now resumes on its own, never the other way round.
 */
export function normalizeUnlockMinutes(value) {
    const n = typeof value === 'string' ? Number(value === '' ? NaN : value) : value;
    if (typeof n !== 'number' || !Number.isFinite(n)) return DEFAULT_UNLOCK_MINUTES;
    return UNLOCK_MINUTE_OPTIONS.includes(n) ? n : DEFAULT_UNLOCK_MINUTES;
}

export function getBlocklistUnlockMinutes(blocklist) {
    return normalizeUnlockMinutes(blocklist?.unlockMinutes);
}

/**
 * Apply a confirmed stop to a running block or schedule, in memory only.
 * The caller syncs the enforcement layers according to what came back:
 *   { kind: 'unlocked', until }  timed pause; the tick loop resumes it at `until`
 *   { kind: 'removed' }          Manual block deleted (Never)
 *   { kind: 'off' }              schedule switched off open-ended (Never)
 *   null                         nothing to stop
 */
export function applyStopToTarget(appData, { block = null, schedule = null } = {}, unlockMinutes, now = Date.now()) {
    const minutes = normalizeUnlockMinutes(unlockMinutes);
    if (schedule) {
        schedule.isPaused = true;
        if (minutes > 0) {
            schedule.pauseEndTime = now + minutes * 60_000;
            return { kind: 'unlocked', until: schedule.pauseEndTime };
        }
        delete schedule.pauseEndTime;
        return { kind: 'off' };
    }
    if (block) {
        if (minutes > 0) {
            block.isPaused = true;
            block.pauseEndTime = now + minutes * 60_000;
            return { kind: 'unlocked', until: block.pauseEndTime };
        }
        appData.activeBlocks = (appData.activeBlocks || []).filter((b) => b.id !== block.id);
        return { kind: 'removed' };
    }
    return null;
}

/**
 * Whether a failed iOS schedule sync lost a timed stop's own pause. Only the
 * stopped schedule's own entries carry its pause to the monitor, so a manual
 * block never depends on this sync and another space's failure is irrelevant.
 * Without per-entry detail the pause may not have been saved, so that still
 * counts as lost and the stop is undone.
 */
export function timedStopLostOwnPause(scheduleSync, schedule) {
    if (!schedule) return false;
    const failedSaveIds = scheduleSync?.failedSaveIds;
    if (!Array.isArray(failedSaveIds)) return true;
    return failedSaveIds.some(id => id.startsWith(`${schedule.id}-`));
}
