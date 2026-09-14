import { describe, expect, test } from 'vitest';
import {
    DEFAULT_UNLOCK_MINUTES,
    NEW_SPACE_UNLOCK_MINUTES,
    UNLOCK_MINUTE_OPTIONS,
    applyStopToTarget,
    getBlocklistUnlockMinutes,
    normalizeUnlockMinutes,
} from '../../src/unlock-duration.js';

describe('new focus spaces', () => {
    // Auto-start after stop is opt-in: a new space stays off when stopped
    // until the user picks a duration. Existing spaces with nothing saved keep
    // the 24-hour fallback (below), so none of them silently becomes permanent.
    test('a new space starts on Never, which is a real menu option', () => {
        expect(NEW_SPACE_UNLOCK_MINUTES).toBe(0);
        expect(UNLOCK_MINUTE_OPTIONS).toContain(NEW_SPACE_UNLOCK_MINUTES);
        expect(normalizeUnlockMinutes(NEW_SPACE_UNLOCK_MINUTES)).toBe(0);
    });
});

describe('normalizeUnlockMinutes', () => {
    test('the option set matches the Android app (0 = Never … 24 hours)', () => {
        expect([...UNLOCK_MINUTE_OPTIONS]).toEqual([0, 5, 10, 15, 30, 60, 120, 240, 480, 1440]);
        expect(DEFAULT_UNLOCK_MINUTES).toBe(1440);
    });

    test('every option round-trips, as a number or a select value string', () => {
        for (const minutes of UNLOCK_MINUTE_OPTIONS) {
            expect(normalizeUnlockMinutes(minutes)).toBe(minutes);
            expect(normalizeUnlockMinutes(String(minutes))).toBe(minutes);
        }
    });

    test('missing, malformed or off-menu values fall back to the 24 hour default', () => {
        // Falling back to the *stricter* end matters: a space whose stop
        // used to be permanent now resumes on its own, never the other way.
        for (const raw of [undefined, null, '', 'abc', NaN, Infinity, -5, 7, 45, 1441, {}]) {
            expect(normalizeUnlockMinutes(raw)).toBe(DEFAULT_UNLOCK_MINUTES);
        }
    });

    test('getBlocklistUnlockMinutes reads the record and tolerates a missing one', () => {
        expect(getBlocklistUnlockMinutes({ unlockMinutes: 10 })).toBe(10);
        expect(getBlocklistUnlockMinutes({ unlockMinutes: 0 })).toBe(0);
        expect(getBlocklistUnlockMinutes({})).toBe(DEFAULT_UNLOCK_MINUTES);
        expect(getBlocklistUnlockMinutes(null)).toBe(DEFAULT_UNLOCK_MINUTES);
    });
});

describe('applyStopToTarget', () => {
    const now = 1_000_000_000;
    const makeData = () => ({
        blocklists: [{ id: 'bl' }],
        activeBlocks: [{ id: 'b1', blocklistId: 'bl', startTime: now - 60_000, endTime: 253402300799999, isAlwaysOn: true }],
        schedules: [{ id: 's1', blocklistId: 'bl', segments: [{ startHour: 9, startMinute: 0, endHour: 17, endMinute: 0, days: [0] }] }],
    });

    test('a Manual block with an unlock duration is paused until then, not removed', () => {
        const data = makeData();
        const out = applyStopToTarget(data, { block: data.activeBlocks[0] }, 10, now);
        expect(out).toEqual({ kind: 'unlocked', until: now + 10 * 60_000 });
        expect(data.activeBlocks).toHaveLength(1);
        expect(data.activeBlocks[0]).toMatchObject({ isPaused: true, pauseEndTime: now + 10 * 60_000 });
    });

    test('a Manual block with Never is removed outright', () => {
        const data = makeData();
        const out = applyStopToTarget(data, { block: data.activeBlocks[0] }, 0, now);
        expect(out).toEqual({ kind: 'removed' });
        expect(data.activeBlocks).toEqual([]);
    });

    test('a schedule with an unlock duration is paused until then', () => {
        const data = makeData();
        const out = applyStopToTarget(data, { schedule: data.schedules[0] }, 60, now);
        expect(out).toEqual({ kind: 'unlocked', until: now + 60 * 60_000 });
        expect(data.schedules[0]).toMatchObject({ isPaused: true, pauseEndTime: now + 60 * 60_000 });
    });

    test('a schedule with Never is switched off open-ended (no pauseEndTime)', () => {
        const data = makeData();
        data.schedules[0].pauseEndTime = now + 5; // stale timed pause must not survive
        const out = applyStopToTarget(data, { schedule: data.schedules[0] }, 0, now);
        expect(out).toEqual({ kind: 'off' });
        expect(data.schedules[0].isPaused).toBe(true);
        expect('pauseEndTime' in data.schedules[0]).toBe(false);
        expect(data.schedules).toHaveLength(1);
    });

    test('an unknown duration is treated as the default, never as Never', () => {
        const data = makeData();
        const out = applyStopToTarget(data, { block: data.activeBlocks[0] }, 'nonsense', now);
        expect(out).toEqual({ kind: 'unlocked', until: now + DEFAULT_UNLOCK_MINUTES * 60_000 });
    });

    test('nothing to stop returns null and leaves the data alone', () => {
        const data = makeData();
        const before = JSON.stringify(data);
        expect(applyStopToTarget(data, {}, 10, now)).toBeNull();
        expect(JSON.stringify(data)).toBe(before);
    });
});
