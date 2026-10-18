import { describe, expect, test } from 'vitest';
import { formatTimeOfDay, pad, parseTimeOfDay } from '../../src/time-inputs.js';

describe('time field parsing', () => {
    test('single digits are zero-padded', () => {
        expect(pad(0)).toBe('00');
        expect(pad(7)).toBe('07');
        expect(pad(23)).toBe('23');
    });
});

describe('typed HH:MM time of day', () => {
    test('a bare hour reads as on the hour', () => {
        expect(parseTimeOfDay('8')).toEqual({ hour: 8, minute: 0 });
        expect(parseTimeOfDay('08')).toEqual({ hour: 8, minute: 0 });
        expect(parseTimeOfDay('23')).toEqual({ hour: 23, minute: 0 });
        expect(parseTimeOfDay('8:')).toEqual({ hour: 8, minute: 0 });
    });

    test('digits without a separator split as H(H)MM', () => {
        expect(parseTimeOfDay('830')).toEqual({ hour: 8, minute: 30 });
        expect(parseTimeOfDay('0830')).toEqual({ hour: 8, minute: 30 });
        expect(parseTimeOfDay('1745')).toEqual({ hour: 17, minute: 45 });
    });

    test('colon, dot and space all separate hour from minute', () => {
        expect(parseTimeOfDay('8:30')).toEqual({ hour: 8, minute: 30 });
        expect(parseTimeOfDay('08:30')).toEqual({ hour: 8, minute: 30 });
        expect(parseTimeOfDay('8.30')).toEqual({ hour: 8, minute: 30 });
        expect(parseTimeOfDay(' 8 30 ')).toEqual({ hour: 8, minute: 30 });
        expect(parseTimeOfDay('8:5')).toEqual({ hour: 8, minute: 5 });
    });

    test('out-of-range or unreadable input is rejected, not clamped', () => {
        // A typo must put the field back to what it was, not quietly move a
        // block to 23:59.
        expect(parseTimeOfDay('24')).toBeNull();
        expect(parseTimeOfDay('25:00')).toBeNull();
        expect(parseTimeOfDay('8:60')).toBeNull();
        expect(parseTimeOfDay('12345')).toBeNull();
        expect(parseTimeOfDay('')).toBeNull();
        expect(parseTimeOfDay('abc')).toBeNull();
        expect(parseTimeOfDay('8:30pm')).toBeNull();
        expect(parseTimeOfDay(null)).toBeNull();
    });

    test('formats back to zero-padded HH:MM', () => {
        expect(formatTimeOfDay(8, 0)).toBe('08:00');
        expect(formatTimeOfDay(17, 5)).toBe('17:05');
    });
});
