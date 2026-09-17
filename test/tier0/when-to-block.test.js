import { describe, expect, test } from 'vitest';
import {
    ALL_DAYS,
    deriveWhenToBlockKind,
    formatWhenToBlockSummary,
    migrateLegacyRepeatType,
    segmentsForKind,
} from '../../src/when-to-block.js';

const seg = (startHour, endHour, days = [...ALL_DAYS]) => ({
    startHour, startMinute: 0, endHour, endMinute: 0, days,
});

describe('formatWhenToBlockSummary', () => {
    const labels = {
        manual: 'Manual',
        dailyFmt: (range) => `Daily ${range}`,
        weeklyFmt: (days, range) => `${days} · ${range}`,
        dayNames: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
        everyDay: 'Every day',
        noDays: 'No days',
    };

    test('compact shows the first range and counts the rest', () => {
        const segments = [seg(0, 23, [0, 1]), seg(9, 12, [0, 1]), seg(14, 16, [0, 1])];
        expect(formatWhenToBlockSummary('weekly', segments, labels)).toBe('Mon, Tue · 00:00 – 23:00 +2');
    });

    // The focus-space card shows this when it fits on the line.
    test('full lists every range, grouped under shared days', () => {
        const segments = [seg(0, 23, [0, 1]), seg(9, 12, [0, 1]), seg(14, 16, [0, 1])];
        expect(formatWhenToBlockSummary('weekly', segments, labels, { full: true }))
            .toBe('Mon, Tue · 00:00 – 23:00, 09:00 – 12:00, 14:00 – 16:00');
    });

    test('full keeps segments on different days as separate groups, in order', () => {
        const segments = [seg(9, 12, [1, 0]), seg(14, 16, [5]), seg(18, 20, [0, 1])];
        expect(formatWhenToBlockSummary('weekly', segments, labels, { full: true }))
            .toBe('Mon, Tue · 09:00 – 12:00, 18:00 – 20:00; Sat · 14:00 – 16:00');
    });

    test('full is the same as compact when there is nothing to expand', () => {
        expect(formatWhenToBlockSummary('weekly', [seg(9, 12, [0])], labels, { full: true })).toBe('Mon · 09:00 – 12:00');
        expect(formatWhenToBlockSummary('daily', [seg(9, 12)], labels, { full: true })).toBe('Daily 09:00 – 12:00');
        expect(formatWhenToBlockSummary('manual', [], labels, { full: true })).toBe('Manual');
    });
});

describe('deriveWhenToBlockKind', () => {
    // The editor has no stored "kind": it is read back from the schedule
    // record so that data written by older versions lands on the right tab.
    test('no schedule is Manual', () => {
        expect(deriveWhenToBlockKind(null)).toBe('manual');
        expect(deriveWhenToBlockKind({ segments: [] })).toBe('manual');
    });

    test('one segment on every day is Daily', () => {
        expect(deriveWhenToBlockKind({ segments: [seg(9, 17)] })).toBe('daily');
        // Day order must not matter.
        expect(deriveWhenToBlockKind({ segments: [seg(9, 17, [6, 5, 4, 3, 2, 1, 0])] })).toBe('daily');
    });

    test('anything else is Weekly', () => {
        expect(deriveWhenToBlockKind({ segments: [seg(9, 17, [0, 1, 2, 3, 4])] })).toBe('weekly');
        expect(deriveWhenToBlockKind({ segments: [seg(9, 12), seg(13, 17)] })).toBe('weekly');
    });
});

describe('segmentsForKind', () => {
    const defaults = () => [seg(14, 16)];

    test('Manual has no segments', () => {
        expect(segmentsForKind('manual', [seg(9, 17)], defaults)).toEqual([]);
    });

    test('Daily keeps only the first segment and forces every day', () => {
        const out = segmentsForKind('daily', [seg(9, 12, [0, 1]), seg(13, 17, [5])], defaults);
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({ startHour: 9, endHour: 12 });
        expect(out[0].days).toEqual([...ALL_DAYS]);
    });

    test('Weekly keeps segments as they are', () => {
        const input = [seg(9, 12, [0, 1]), seg(13, 17, [5])];
        expect(segmentsForKind('weekly', input, defaults)).toEqual(input);
    });

    test('Daily and Weekly fall back to defaults when there are no segments', () => {
        expect(segmentsForKind('daily', [], defaults)).toEqual([seg(14, 16)]);
        expect(segmentsForKind('weekly', null, defaults)).toEqual([seg(14, 16)]);
    });

    test('returns copies, never the caller\'s objects', () => {
        const input = [seg(9, 12, [0])];
        const out = segmentsForKind('weekly', input, defaults);
        expect(out[0]).not.toBe(input[0]);
        expect(out[0].days).not.toBe(input[0].days);
    });
});

describe('migrateLegacyRepeatType', () => {
    // "Until" only offers "I stop it" (forever) and "Date". The old
    // one-shot "No" option is mapped onto a date so an existing one-shot
    // schedule still ends when it was going to.
    test('forever and date are left alone', () => {
        const a = { repeatType: 'forever', segments: [seg(9, 17)] };
        const b = { repeatType: 'date', repeatDate: 5, segments: [seg(9, 17)] };
        expect(migrateLegacyRepeatType(a, Date.now())).toBe(false);
        expect(migrateLegacyRepeatType(b, Date.now())).toBe(false);
        expect(a.repeatType).toBe('forever');
        expect(b).toMatchObject({ repeatType: 'date', repeatDate: 5 });
    });

    test('a one-shot with a future occurrence becomes "date" ending on its last day', () => {
        // Monday 2026-09-14 09:00 local.
        const now = new Date(2026, 8, 14, 9, 0).getTime();
        const schedule = {
            repeatType: 'no',
            createdAt: now - 60_000,
            segments: [seg(10, 12, [2])], // Wednesday
        };
        expect(migrateLegacyRepeatType(schedule, now)).toBe(true);
        expect(schedule.repeatType).toBe('date');
        const end = new Date(schedule.repeatDate);
        expect([end.getFullYear(), end.getMonth(), end.getDate()]).toEqual([2026, 8, 16]);
    });

    test('a one-shot with nothing left ahead becomes forever', () => {
        const schedule = { repeatType: 'no', createdAt: 0, segments: [] };
        expect(migrateLegacyRepeatType(schedule, Date.now())).toBe(true);
        expect(schedule.repeatType).toBe('forever');
        expect(schedule.repeatDate ?? null).toBeNull();
    });

    test('a missing repeatType is treated as legacy one-shot', () => {
        const schedule = { createdAt: 0, segments: [] };
        expect(migrateLegacyRepeatType(schedule, Date.now())).toBe(true);
        expect(schedule.repeatType).toBe('forever');
    });
});
