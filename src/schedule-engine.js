// Schedule engine: occurrence math, native-helper schedule/block sync,
// desktop helper status cache. Extracted verbatim from app.js.
import { state } from './state.js';
import { tauriAPI } from './tauri-api.js';
import { message } from '@tauri-apps/plugin-dialog';
import { tSettings } from './i18n.js';
import { getBlocklistIOSPayload, isAllowlistBlocklist, isProtectedDomain } from './blocklist-utils.js';
import { formatDateForDisplay, isScheduleSegmentActiveNow } from './schedule-editor.js';
import { formatTime } from './app.js';
import { syncIOSStartWarnings } from './ios-start-warnings.js';

let hasShownIOSScheduleSyncError = false;

export const HELPER_STATUS_CACHE_TTL_MS = 3000;
let lastDesktopHelperStatus = null;
let lastDesktopHelperStatusAt = 0;

export function isNonRepeatingSchedule(schedule) {
    return !!schedule && schedule.repeatType !== 'forever' && !(schedule.repeatType === 'date' && schedule.repeatDate);
}

// Resolve concrete one-shot occurrences for non-repeating schedules.
export function resolveOneShotSegmentOccurrences(schedule, segment, segmentIndex = 0) {
    if (!isNonRepeatingSchedule(schedule) || !segment) return [];

    const createdAt = new Date(schedule.createdAt || Date.now());
    if (Number.isNaN(createdAt.getTime())) return [];

    const createdDay = createdAt.getDay() === 0 ? 6 : createdAt.getDay() - 1; // Mon=0
    const segmentDays = Array.isArray(segment.days)
        ? segment.days.filter(day => Number.isInteger(day) && day >= 0 && day <= 6)
        : [];

    if (segmentDays.length === 0) return [];

    const occurrences = segmentDays.map(dayIndex => {
        let daysUntil = dayIndex - createdDay;
        if (daysUntil < 0) daysUntil += 7;

        const start = new Date(createdAt);
        start.setDate(start.getDate() + daysUntil);
        start.setHours(segment.startHour, segment.startMinute, 0, 0);

        const end = new Date(start);
        end.setHours(segment.endHour, segment.endMinute, 0, 0);
        if (end <= start) {
            end.setDate(end.getDate() + 1);
        }

        return {
            segmentIndex,
            dayIndex,
            start,
            end
        };
    });

    occurrences.sort((a, b) => {
        const startDiff = a.start.getTime() - b.start.getTime();
        if (startDiff !== 0) return startDiff;
        const endDiff = a.end.getTime() - b.end.getTime();
        if (endDiff !== 0) return endDiff;
        return a.dayIndex - b.dayIndex;
    });

    return occurrences;
}

export function resolveOneShotOccurrences(schedule) {
    if (!isNonRepeatingSchedule(schedule) || !Array.isArray(schedule.segments)) return [];

    const occurrences = [];
    schedule.segments.forEach((segment, segmentIndex) => {
        occurrences.push(...resolveOneShotSegmentOccurrences(schedule, segment, segmentIndex));
    });

    occurrences.sort((a, b) => {
        const startDiff = a.start.getTime() - b.start.getTime();
        if (startDiff !== 0) return startDiff;
        const segmentDiff = a.segmentIndex - b.segmentIndex;
        if (segmentDiff !== 0) return segmentDiff;
        return a.dayIndex - b.dayIndex;
    });

    return occurrences;
}

function buildResolvedOneShotSegment(occurrence) {
    return {
        startHour: occurrence.start.getHours(),
        startMinute: occurrence.start.getMinutes(),
        endHour: occurrence.end.getHours(),
        endMinute: occurrence.end.getMinutes(),
        days: [],
        activeFromTimestampMs: occurrence.start.getTime(),
        activeUntilTimestampMs: occurrence.end.getTime()
    };
}

function buildResolvedOneShotSegments(schedule) {
    return resolveOneShotOccurrences(schedule).map(buildResolvedOneShotSegment);
}

function buildPersistedSchedule(schedule) {
    if (!schedule || !Array.isArray(schedule.segments)) return schedule;

    const { resolvedSegments: _oldResolvedSegments, ...baseSchedule } = schedule;
    if (!isNonRepeatingSchedule(schedule)) {
        return baseSchedule;
    }

    return {
        ...baseSchedule,
        resolvedSegments: buildResolvedOneShotSegments(schedule)
    };
}

export function buildPersistedAppData() {
    return {
        ...state.appData,
        schedules: Array.isArray(state.appData.schedules)
            ? state.appData.schedules.map(buildPersistedSchedule)
            : []
    };
}

export function getIOSScheduleEntryWindow(schedule, seg) {
    const createdAt = new Date(schedule.createdAt || Date.now());

    if (schedule.repeatType === 'forever') {
        return {
            repeats: true,
            activeFromTimestampMs: null,
            activeUntilTimestampMs: null
        };
    }

    if (schedule.repeatType === 'date' && schedule.repeatDate) {
        const endDate = new Date(schedule.repeatDate);
        endDate.setHours(23, 59, 59, 999);
        return {
            repeats: true,
            activeFromTimestampMs: createdAt.getTime(),
            activeUntilTimestampMs: endDate.getTime()
        };
    }

    const occurrences = resolveOneShotSegmentOccurrences(schedule, seg);
    const firstOccurrence = occurrences[0];

    return {
        repeats: false,
        activeFromTimestampMs: firstOccurrence ? firstOccurrence.start.getTime() : null,
        activeUntilTimestampMs: firstOccurrence ? firstOccurrence.end.getTime() : null
    };
}

export function getSingleOccurrenceSegmentDates(schedule, segment) {
    const [firstOccurrence] = resolveOneShotSegmentOccurrences(schedule, segment);
    if (!firstOccurrence) return null;

    return {
        start: new Date(firstOccurrence.start),
        end: new Date(firstOccurrence.end)
    };
}

/**
 * Flatten schedules into the iOS Screen Time plugin payload.
 *
 * Extracted from syncSchedulesToHelper so the per-entry `mode` below can be
 * tested; the sync itself is async and talks to Tauri.
 *
 * Each entry carries `mode` so Swift knows whether its domains/tokens are
 * ALLOWED or BLOCKED items — IOSPolicyResolver unions the allow-mode entries
 * and subtracts the blocked ones. Without it every entry defaulted to blocked
 * semantics, so an allow-mode focus space on a *schedule* blocked exactly the
 * sites and apps it was meant to permit. (The manual/one-off path already sent
 * mode via collectActiveIOSManualBlockPayload, so only schedules were affected.)
 *
 * Category tokens are deliberately still sent on allow-mode entries: Swift
 * ignores them there (it collects categories only from non-allowlist entries),
 * and keeping the data means nothing is lost if the space switches back.
 */
export function buildIOSScheduleEntries() {
    const flatEntries = [];
    for (const schedule of state.appData.schedules || []) {
        if (!schedule.segments || schedule.segments.length === 0) continue;
        const blocklist = state.appData.blocklists.find(bl => bl.id === schedule.blocklistId);
        // Same filter as the manual payload: a protected domain must never ship,
        // and in allow mode it would also eat into the 50-exception budget.
        const domains = (blocklist?.websites || []).filter((d) => !isProtectedDomain(d));
        const iosPayload = getBlocklistIOSPayload(blocklist);
        const blocklistEmoji = blocklist?.emoji ?? null;
        const blocklistName = blocklist?.name ?? null;
        const bc = blocklist?.color;
        const blocklistColorHex = typeof bc === 'string' && bc.length > 0 ? bc : null;
        // Tells Swift whether these domains/tokens are ALLOWED or BLOCKED items.
        // Same convention as the manual payload: 'allowlist' or null.
        const mode = isAllowlistBlocklist(blocklist) ? 'allowlist' : null;
        if (isNonRepeatingSchedule(schedule)) {
            const occurrences = resolveOneShotOccurrences(schedule);
            occurrences.forEach((occurrence, occurrenceIdx) => {
                flatEntries.push({
                    id: `${schedule.id}-${occurrence.segmentIndex}-${occurrenceIdx}`,
                    ...buildResolvedOneShotSegment(occurrence),
                    domains,
                    appTokenData: iosPayload.appTokenData,
                    categoryTokenData: iosPayload.categoryTokenData,
                    repeats: false,
                    isPaused: !!schedule.isPaused,
                    pauseEndTimestampMs: schedule.pauseEndTime || null,
                    blocklistEmoji,
                    blocklistName,
                    blocklistColorHex,
                    mode,
                    blocklistId: schedule.blocklistId
                });
            });
            continue;
        }
        for (let segIdx = 0; segIdx < schedule.segments.length; segIdx++) {
            const seg = schedule.segments[segIdx];
            // No days means never active here; Swift would read [] as every day.
            if (!seg.days?.length) continue;
            const window = getIOSScheduleEntryWindow(schedule, seg);
            flatEntries.push({
                id: `${schedule.id}-${segIdx}`,
                startHour: seg.startHour,
                startMinute: seg.startMinute,
                endHour: seg.endHour,
                endMinute: seg.endMinute,
                days: seg.days ? [...seg.days] : [],
                domains,
                appTokenData: iosPayload.appTokenData,
                categoryTokenData: iosPayload.categoryTokenData,
                repeats: window.repeats,
                activeFromTimestampMs: window.activeFromTimestampMs,
                activeUntilTimestampMs: window.activeUntilTimestampMs,
                isPaused: !!schedule.isPaused,
                pauseEndTimestampMs: schedule.pauseEndTime || null,
                blocklistEmoji,
                blocklistName,
                blocklistColorHex,
                mode,
                blocklistId: schedule.blocklistId
            });
        }
    }

    return flatEntries;
}

/** The iOS schedule-sync warning, shown once per session. */
export async function reportIOSScheduleSyncFailure(failure) {
    if (hasShownIOSScheduleSyncError) return;
    hasShownIOSScheduleSyncError = true;
    try {
        await message(`iOS schedule sync failed: ${failure}`, {
            title: 'Schedule Sync Failed',
            kind: 'error'
        });
    } catch (dialogError) {
        console.warn('[syncSchedulesToHelper] Failed to show iOS sync error:', dialogError);
    }
}

export async function syncSchedulesToHelper({ reportFailure = true } = {}) {
    if (state.isIOS) {
        let failure = null;
        let failedSaveIds;
        try {
            const flatEntries = buildIOSScheduleEntries();
            console.log('[syncSchedulesToHelper] iOS: Sending', flatEntries.length, 'segment entries to plugin');
            const result = await tauriAPI.setSchedulesPlugin(flatEntries);
            if (result?.success !== true) {
                failure = result?.error || 'unknown plugin error';
                failedSaveIds = result?.failedSaveIds;
                console.warn('[syncSchedulesToHelper] iOS plugin failed:', failure);
            }
        } catch (e) {
            failure = e?.message || String(e);
            console.warn('[syncSchedulesToHelper] iOS error:', e);
        }
        if (failure && reportFailure) await reportIOSScheduleSyncFailure(failure);
        // After the save, so Swift plans from the schedules just stored. Not awaited:
        // switching a space on must not wait for notifications (Swift runs rebuilds in order).
        void syncIOSStartWarnings();
        return failure ? { success: false, error: failure, failedSaveIds } : { success: true };
    }

    try {
        const status = await tauriAPI.checkHelperStatus();
        if (!status.running || !status.version_ok) {
            console.log('[syncSchedulesToHelper] Helper not available, skipping');
            return;
        }

        // Build schedule payloads with pre-resolved domains and apps
        const helperSchedules = (state.appData.schedules || []).map(schedule => {
            const blocklist = state.appData.blocklists.find(bl => bl.id === schedule.blocklistId);
            const helperSegments = isNonRepeatingSchedule(schedule)
                ? buildResolvedOneShotSegments(schedule)
                : (schedule.segments || []).map(seg => ({
                    startHour: seg.startHour,
                    startMinute: seg.startMinute,
                    endHour: seg.endHour,
                    endMinute: seg.endMinute,
                    days: [...seg.days]
                }));
            return {
                id: schedule.id,
                domains: blocklist?.websites || [],
                apps: blocklist?.apps || [],
                isPaused: !!schedule.isPaused,
                pauseEndTime: schedule.pauseEndTime || null,
                segments: helperSegments
            };
        });

        console.log('[syncSchedulesToHelper] Sending', helperSchedules.length, 'schedules to helper');
        const result = await tauriAPI.setSchedulesViaHelper(helperSchedules);
        if (!result.success) {
            console.warn('[syncSchedulesToHelper] Failed:', result.error);
        }
    } catch (e) {
        console.warn('[syncSchedulesToHelper] Error:', e);
    }
}

export async function syncActiveBlocksToHelper() {
    if (state.isIOS) return;
    try {
        const status = await tauriAPI.checkHelperStatus();
        if (!status.running || !status.version_ok) return;
        const now = Date.now();
        console.log('[syncActiveBlocksToHelper] Total activeBlocks:', state.appData.activeBlocks.length,
            'blocks:', state.appData.activeBlocks.map(b => ({
                id: b.id, blocklistId: b.blocklistId, startTime: b.startTime, endTime: b.endTime,
                isPaused: b.isPaused, isAlwaysOn: b.isAlwaysOn,
                startOk: b.startTime <= now, endOk: b.endTime > now, pauseOk: !b.isPaused
            })));
        const activeBlocks = state.appData.activeBlocks.filter(block => block.startTime <= now && block.endTime > now);
        console.log('[syncActiveBlocksToHelper] Filtered activeBlocks:', activeBlocks.length);

        // Build the blocks array for the atomic set-blocks command.
        // Paused blocks are included so the helper can auto-resume them when the pause expires,
        // even if the frontend isn't running.
        const helperBlocks = activeBlocks.map(block => {
            const blocklist = state.appData.blocklists.find(bl => bl.id === block.blocklistId);
            return {
                domains: blocklist?.websites || [],
                endTime: block.endTime,
                blocklistId: block.blocklistId,
                isPaused: !!block.isPaused,
                pauseEndTime: block.pauseEndTime || null
            };
        });

        console.log('[syncActiveBlocksToHelper] Sending', helperBlocks.length, 'blocks to helper');
        // Atomically replace all blocks in the helper daemon (no clear→re-add race)
        await tauriAPI.setBlocksViaHelper(helperBlocks);
    } catch (e) {
        console.warn('[syncActiveBlocksToHelper] Error:', e);
    }
}

export function isOneOffBlockEnforced(block, now = Date.now()) {
    return !!(block && block.startTime <= now && block.endTime > now && !block.isPaused);
}

export function isOneOffBlockStillActive(block, now = Date.now()) {
    return !!(block && block.endTime > now);
}

// No pauseEndTime = paused indefinitely (legacy-disabled schedules imported
// from older versions); stays paused until the user resumes it.
export function isSchedulePausedNow(schedule, now = Date.now()) {
    return !!(schedule && schedule.isPaused && (!schedule.pauseEndTime || schedule.pauseEndTime > now));
}

export function hasAnyEnforcedBlocks(now = Date.now(), nowDate = new Date(now)) {
    const hasActiveOneOff = state.appData.activeBlocks.some(block => isOneOffBlockEnforced(block, now));
    if (hasActiveOneOff) return true;
    return !!state.appData.schedules?.some(schedule => isScheduleSegmentActiveNow(schedule, nowDate));
}

export function scheduleHasFutureRecurringOccurrence(schedule, nowDate = new Date()) {
    if (!schedule || !Array.isArray(schedule.segments) || schedule.segments.length === 0) return false;

    const currentDay = nowDate.getDay() === 0 ? 6 : nowDate.getDay() - 1;

    return schedule.segments.some(seg => {
        const segmentDays = (Array.isArray(seg.days) && seg.days.length > 0) ? seg.days : [currentDay];
        return segmentDays.some(segmentDay => {
            let daysUntil = segmentDay - currentDay;
            if (daysUntil < 0) daysUntil += 7;

            const candidateStart = new Date(nowDate);
            candidateStart.setDate(candidateStart.getDate() + daysUntil);
            candidateStart.setHours(seg.startHour, seg.startMinute, 0, 0);

            const candidateEnd = new Date(candidateStart);
            candidateEnd.setHours(seg.endHour, seg.endMinute, 0, 0);
            if (candidateEnd <= candidateStart) {
                candidateEnd.setDate(candidateEnd.getDate() + 1);
            }

            if (candidateEnd <= nowDate) {
                candidateStart.setDate(candidateStart.getDate() + 7);
                candidateEnd.setDate(candidateEnd.getDate() + 7);
            }

            if (schedule.repeatType === 'date' && schedule.repeatDate) {
                const repeatEnd = new Date(schedule.repeatDate);
                repeatEnd.setHours(23, 59, 59, 999);
                return candidateStart <= repeatEnd && candidateEnd > nowDate;
            }

            return candidateEnd > nowDate;
        });
    });
}

export function scheduleHasFutureSingleOccurrence(schedule, nowDate = new Date()) {
    if (!schedule || !Array.isArray(schedule.segments) || schedule.segments.length === 0) return false;
    return resolveOneShotOccurrences(schedule).some(occurrence => occurrence.end > nowDate);
}

export function scheduleCanStillBecomeActive(schedule, nowDate = new Date()) {
    if (!schedule || !Array.isArray(schedule.segments) || schedule.segments.length === 0) return false;
    if (schedule.repeatType === 'forever' || (schedule.repeatType === 'date' && schedule.repeatDate)) {
        return scheduleHasFutureRecurringOccurrence(schedule, nowDate);
    }
    return scheduleHasFutureSingleOccurrence(schedule, nowDate);
}

export function getTitleBarScheduleSearchFloorMs(schedule, nowMs = Date.now()) {
    if (!schedule) return nowMs;
    if (schedule.isPaused && schedule.pauseEndTime > nowMs) {
        return Math.max(nowMs, schedule.pauseEndTime);
    }
    return nowMs;
}

export function dayIndexMonday0FromDate(dt) {
    const d = dt.getDay();
    return d === 0 ? 6 : d - 1;
}

export function getRepeatScheduleLastDayInclusiveMs(schedule) {
    if (schedule.repeatType === 'date' && schedule.repeatDate) {
        const endDate = new Date(schedule.repeatDate);
        endDate.setHours(23, 59, 59, 999);
        return endDate.getTime();
    }
    return null;
}

export function computeNextOneShotOccurrenceMs(schedule, floorMs) {
    let best = null;
    for (const occ of resolveOneShotOccurrences(schedule)) {
        const s = occ.start.getTime();
        const e = occ.end.getTime();
        if (e <= floorMs) continue;
        if (s > floorMs) {
            if (best === null || s < best) best = s;
        }
    }
    return best;
}

export function computeNextRepeatingOccurrenceMs(schedule, floorMs) {
    if (!schedule.segments || schedule.segments.length === 0) return null;
    const lastMs = getRepeatScheduleLastDayInclusiveMs(schedule);
    const floorDate = new Date(floorMs);

    let best = null;
    const y0 = floorDate.getFullYear();
    const m0 = floorDate.getMonth();
    const d0 = floorDate.getDate();

    for (let i = 0; i < 370; i++) {
        const calMidnight = new Date(y0, m0, d0 + i, 0, 0, 0, 0);
        if (lastMs !== null && calMidnight.getTime() > lastMs) break;

        const dayIx = dayIndexMonday0FromDate(calMidnight);

        for (const seg of schedule.segments) {
            const segmentDays = Array.isArray(seg.days) && seg.days.length > 0 ? seg.days : null;
            if (!segmentDays || !segmentDays.includes(dayIx)) continue;

            const startMins = seg.startHour * 60 + seg.startMinute;
            const endMins = seg.endHour * 60 + seg.endMinute;

            if (startMins === endMins) {
                const candMs = calMidnight.getTime();
                if (candMs > floorMs && (lastMs === null || candMs <= lastMs)) {
                    if (best === null || candMs < best) best = candMs;
                }
                continue;
            }

            const cand = new Date(calMidnight);
            cand.setHours(seg.startHour, seg.startMinute, 0, 0);
            const candMs = cand.getTime();
            if (candMs > floorMs && (lastMs === null || candMs <= lastMs)) {
                if (best === null || candMs < best) best = candMs;
            }
        }
    }

    return best;
}

/**
 * Among schedules that can still run, earliest segment start strictly after pause/search floor.
 */
export function pickEarliestUpcomingScheduledBlock(nowMs = Date.now()) {
    let best = null;
    for (const schedule of state.appData.schedules || []) {
        if (!schedule.segments || schedule.segments.length === 0) continue;
        if (!scheduleCanStillBecomeActive(schedule, new Date(nowMs))) continue;
        // Indefinitely paused (no pauseEndTime): no upcoming start to show.
        if (schedule.isPaused && !schedule.pauseEndTime) continue;

        const floorMs = getTitleBarScheduleSearchFloorMs(schedule, nowMs);
        let nextMs;

        if (isNonRepeatingSchedule(schedule)) {
            nextMs = computeNextOneShotOccurrenceMs(schedule, floorMs);
        } else {
            nextMs = computeNextRepeatingOccurrenceMs(schedule, floorMs);
        }

        if (nextMs == null) continue;

        const blocklist = state.appData.blocklists.find(bl => bl.id === schedule.blocklistId);
        if (!blocklist) continue;

        if (best === null || nextMs < best.startMs) {
            best = { startMs: nextMs, blocklist, schedule };
        }
    }
    return best;
}

export function formatTitleBarScheduleStartWhen(date, nowMs = Date.now()) {
    const n = new Date(nowMs);
    const dMid = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
    const targetMid = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    const dd = Math.round((targetMid - dMid) / 86400000);
    const timeStr = formatTime(date);
    if (dd === 0) return `${tSettings('scheduleStartsToday')} ${timeStr}`;
    if (dd === 1) return `${tSettings('scheduleStartsTomorrow')} ${timeStr}`;
    return `${formatDateForDisplay(date)} · ${timeStr}`;
}

export function hasAnyBlockingStateToClear(now = Date.now(), nowDate = new Date(now)) {
    const hasOneOffState = state.appData.activeBlocks.some(block => isOneOffBlockStillActive(block, now));
    if (hasOneOffState) return true;
    // A schedule switched off with no end time stays off until turned on, so there is nothing to stop.
    return !!state.appData.schedules?.some(schedule =>
        !(schedule.isPaused && !schedule.pauseEndTime) && scheduleCanStillBecomeActive(schedule, nowDate));
}

export async function refreshDesktopHelperStatus() {
    if (state.isIOS) {
        return { installed: false, running: false, version: null, version_ok: false, helperReady: false };
    }
    try {
        const status = await tauriAPI.checkHelperStatus();
        const helperReady = !!(status.running && status.version_ok);
        const nextStatus = { ...status, helperReady };
        state.helperAvailable = helperReady;
        lastDesktopHelperStatus = nextStatus;
        lastDesktopHelperStatusAt = Date.now();
        return nextStatus;
    } catch (err) {
        console.error('Error checking helper status:', err);
        state.helperAvailable = false;
        lastDesktopHelperStatus = {
            installed: false,
            running: false,
            version: null,
            version_ok: false,
            helperReady: false,
            error: err
        };
        lastDesktopHelperStatusAt = Date.now();
        return lastDesktopHelperStatus;
    }
}

export function getCachedDesktopHelperStatus(maxAgeMs = HELPER_STATUS_CACHE_TTL_MS) {
    if (!lastDesktopHelperStatus) return null;
    if ((Date.now() - lastDesktopHelperStatusAt) > maxAgeMs) return null;
    return lastDesktopHelperStatus;
}
