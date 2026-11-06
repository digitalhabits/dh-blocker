import { describe, expect, test } from 'vitest';
import { buildPersistedAppData, dayIndexMonday0FromDate, getRepeatScheduleLastDayInclusiveMs, isNonRepeatingSchedule, isOneOffBlockEnforced, isOneOffBlockStillActive, isSchedulePausedNow } from '../../src/schedule-engine.js';
import { state } from '../../src/state.js';

describe('schedule repeat classification', () => {
    test('forever and dated repeats are repeating', () => {
        expect(isNonRepeatingSchedule({ repeatType: 'forever' })).toBe(false);
        expect(isNonRepeatingSchedule({ repeatType: 'date', repeatDate: '2026-01-01' })).toBe(false);
    });

    test('everything else is a one-shot', () => {
        expect(isNonRepeatingSchedule({})).toBe(true);
        expect(isNonRepeatingSchedule({ repeatType: 'once' })).toBe(true);
        // A dated repeat with no date cannot recur.
        expect(isNonRepeatingSchedule({ repeatType: 'date' })).toBe(true);
        expect(isNonRepeatingSchedule(null)).toBe(false);
    });

    test('a dated repeat runs to the end of its final day', () => {
        const end = getRepeatScheduleLastDayInclusiveMs({ repeatType: 'date', repeatDate: '2026-03-05' });
        const endDate = new Date(end);
        expect(endDate.getHours()).toBe(23);
        expect(endDate.getMinutes()).toBe(59);
        expect(getRepeatScheduleLastDayInclusiveMs({ repeatType: 'forever' })).toBeNull();
        expect(getRepeatScheduleLastDayInclusiveMs({ repeatType: 'date' })).toBeNull();
    });
});

describe('schedule persistence', () => {
    test('date-limited schedules send a string to Rust without changing the local cutoff day', () => {
        const date = new Date(2026, 10, 6);
        const repeatDate = date.getTime();
        const schedule = { repeatType: 'date', repeatDate, segments: [] };
        const previousAppData = state.appData;
        try {
            state.appData = {
                schedules: [
                    schedule,
                    { ...schedule, repeatDate: date.toISOString() },
                    { ...schedule, repeatType: 'forever', repeatDate: null },
                ],
            };

            const [dated, alreadyEncoded, forever] = buildPersistedAppData().schedules;
            expect(dated.repeatDate).toBe(date.toISOString());
            expect(getRepeatScheduleLastDayInclusiveMs(dated)).toBe(new Date(2026, 10, 6, 23, 59, 59, 999).getTime());
            expect(alreadyEncoded.repeatDate).toBe(dated.repeatDate);
            expect(forever.repeatDate).toBeNull();
            expect(schedule.repeatDate).toBe(repeatDate);
            schedule.repeatDate = Infinity;
            expect(() => buildPersistedAppData()).toThrow(RangeError);
        } finally {
            state.appData = previousAppData;
        }
    });
});

describe('one-off block enforcement window', () => {
    const now = 1_000_000;

    test('a block is enforced only inside its half-open window', () => {
        expect(isOneOffBlockEnforced({ startTime: now, endTime: now + 1 }, now)).toBe(true);
        // Start is inclusive, end is exclusive.
        expect(isOneOffBlockEnforced({ startTime: now + 1, endTime: now + 2 }, now)).toBe(false);
        expect(isOneOffBlockEnforced({ startTime: now - 2, endTime: now }, now)).toBe(false);
    });

    test('a paused block is not enforced but is still alive', () => {
        const block = { startTime: now - 1, endTime: now + 1, isPaused: true };
        expect(isOneOffBlockEnforced(block, now)).toBe(false);
        // Still active, so resuming brings it back rather than dropping it.
        expect(isOneOffBlockStillActive(block, now)).toBe(true);
    });

    test('an elapsed block is neither enforced nor active', () => {
        const block = { startTime: now - 10, endTime: now - 1 };
        expect(isOneOffBlockEnforced(block, now)).toBe(false);
        expect(isOneOffBlockStillActive(block, now)).toBe(false);
    });

    test('a missing block is handled', () => {
        expect(isOneOffBlockEnforced(null, now)).toBe(false);
        expect(isOneOffBlockStillActive(undefined, now)).toBe(false);
    });
});

describe('schedule pause state', () => {
    const now = 1_000_000;

    test('a pause holds until its end time', () => {
        expect(isSchedulePausedNow({ isPaused: true, pauseEndTime: now + 1 }, now)).toBe(true);
        expect(isSchedulePausedNow({ isPaused: true, pauseEndTime: now }, now)).toBe(false);
    });

    test('a pause with no end time is indefinite', () => {
        // Legacy Android-imported schedules land here; they must stay paused
        // rather than silently resuming on the next sync.
        expect(isSchedulePausedNow({ isPaused: true }, now)).toBe(true);
        expect(isSchedulePausedNow({ isPaused: true, pauseEndTime: 0 }, now)).toBe(true);
    });

    test('an unpaused schedule is never paused', () => {
        expect(isSchedulePausedNow({ isPaused: false, pauseEndTime: now + 1000 }, now)).toBe(false);
        expect(isSchedulePausedNow(null, now)).toBe(false);
    });
});

describe('weekday indexing', () => {
    test('JS Sunday-zero dates convert to Monday-zero indices', () => {
        // 2026-03-02 is a Monday; the JS getDay() Sunday-zero convention is
        // off by one from the Monday-zero arrays used everywhere else.
        expect(dayIndexMonday0FromDate(new Date(2026, 2, 2, 12))).toBe(0);
        expect(dayIndexMonday0FromDate(new Date(2026, 2, 7, 12))).toBe(5);
        expect(dayIndexMonday0FromDate(new Date(2026, 2, 8, 12))).toBe(6);
    });
});
