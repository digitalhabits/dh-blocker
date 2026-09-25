// Auto-start after stop — what "stop" means for a focus space.
//
// Every focus space carries `unlockMinutes`. Stopping a running space (the
// card switch, the Android friction gate) pauses it for that long and it turns
// itself back on afterwards. 0 is
// "Never": a Manual block is removed and a Daily / Weekly schedule is switched
// off open-ended (`isPaused` with no `pauseEndTime`, honoured by every
// enforcement layer). Mirrors `autoReenableMinutes` in the Android app.
//
// Pure helpers only (Tier 0). No DOM, no `state`.

/** Minutes offered in the editor; 0 = Never. Same menu as Android. */
export const UNLOCK_MINUTE_OPTIONS = Object.freeze([0, 5, 10, 15, 30, 60, 120, 240, 480, 1440]);

/** 24 hours, the Android default. Also applied to spaces saved before this field existed. */
export const DEFAULT_UNLOCK_MINUTES = 1440;

/** What a newly created focus space starts on after an early stop. */
export const NEW_SPACE_UNLOCK_MINUTES = DEFAULT_UNLOCK_MINUTES;

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
