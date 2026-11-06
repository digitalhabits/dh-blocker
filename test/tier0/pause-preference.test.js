import { describe, expect, test } from 'vitest';
import { PAUSE_MINUTE_OPTIONS, getLastBreakMinutes, rememberBreakMinutes } from '../../src/unlock-duration.js';

describe('pause duration preference', () => {
    test('starts at ten minutes, includes five and ten but not fifteen', () => {
        expect(getLastBreakMinutes({})).toBe(10);
        expect(PAUSE_MINUTE_OPTIONS).toContain(5);
        expect(PAUSE_MINUTE_OPTIONS).toContain(10);
        expect(PAUSE_MINUTE_OPTIONS).not.toContain(15);
    });
    test('remembers a confirmed timed pause, never does not replace it', () => {
        const settings = {};
        rememberBreakMinutes(settings, 1440);
        expect(getLastBreakMinutes(settings)).toBe(1440);
        rememberBreakMinutes(settings, 0);
        expect(getLastBreakMinutes(settings)).toBe(1440);
    });
    test('invalid and retired preferences fall back to ten without mutating legacy pauses', () => {
        for (const lastBreakMinutes of [0, 15, -1, null, 'bad']) {
            const settings = { lastBreakMinutes };
            expect(getLastBreakMinutes(settings)).toBe(10);
            expect(settings.lastBreakMinutes).toBe(lastBreakMinutes);
        }
    });
});
