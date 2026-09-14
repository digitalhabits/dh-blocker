import { describe, expect, test } from 'vitest';
import { pad, parseEndTimeBoundedInt } from '../../src/time-inputs.js';

describe('time field parsing', () => {
    test('single digits are zero-padded', () => {
        expect(pad(0)).toBe('00');
        expect(pad(7)).toBe('07');
        expect(pad(23)).toBe('23');
    });

    test('typed end-time digits are clamped to their field range', () => {
        expect(parseEndTimeBoundedInt('9', 0, 23)).toBe(9);
        expect(parseEndTimeBoundedInt('99', 0, 23)).toBe(23);
        expect(parseEndTimeBoundedInt('75', 0, 59)).toBe(59);
        expect(parseEndTimeBoundedInt('0', 0, 59)).toBe(0);
    });

    test('non-digits are stripped before parsing', () => {
        expect(parseEndTimeBoundedInt('1a2', 0, 59)).toBe(12);
        expect(parseEndTimeBoundedInt('-5', 0, 23)).toBe(5);
    });

    test('empty input parses to null rather than zero', () => {
        // Returning 0 here would silently rewrite a half-typed field to
        // midnight while the user is still typing.
        expect(parseEndTimeBoundedInt('', 0, 23)).toBeNull();
        expect(parseEndTimeBoundedInt('   ', 0, 23)).toBeNull();
        expect(parseEndTimeBoundedInt('abc', 0, 23)).toBeNull();
        expect(parseEndTimeBoundedInt(null, 0, 23)).toBeNull();
        expect(parseEndTimeBoundedInt(undefined, 0, 23)).toBeNull();
    });
});
