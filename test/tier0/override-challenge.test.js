import { describe, expect, test } from 'vitest';
import {
    DEFAULT_MAX_OVERRIDE_WORDS_SETTING,
    DEFAULT_OVERRIDE_WORDS,
    MAX_OVERRIDE_WORDS_DESKTOP,
    MAX_OVERRIDE_WORDS_MOBILE,
    getDifficultyTypingCharCount,
    getMaxOverrideWords,
    getOverrideWordsSliderMax,
    getOverrideEstimatedMinutes,
    migrateOverrideDifficultyToWords,
    normalizeMaxOverrideWordsSetting,
    normalizeOverrideCount,
} from '../../src/override-challenge.js';

describe('word-count limits', () => {
    test('desktop allows up to 1000 words, phones 100', () => {
        expect(getMaxOverrideWords(false)).toBe(MAX_OVERRIDE_WORDS_DESKTOP);
        expect(getMaxOverrideWords(true)).toBe(MAX_OVERRIDE_WORDS_MOBILE);
        expect(MAX_OVERRIDE_WORDS_DESKTOP).toBe(1000);
        expect(MAX_OVERRIDE_WORDS_MOBILE).toBe(100);
    });

    test('a count is clamped to [1, max] and nonsense falls back to the default', () => {
        expect(normalizeOverrideCount(0, 'random-words', 300)).toBe(1);
        expect(normalizeOverrideCount(-4, 'random-words', 300)).toBe(1);
        expect(normalizeOverrideCount(999, 'random-words', 300)).toBe(300);
        expect(normalizeOverrideCount('42', 'random-words', 300)).toBe(42);
        expect(normalizeOverrideCount('abc', 'random-words', 300)).toBe(DEFAULT_OVERRIDE_WORDS);
        expect(normalizeOverrideCount(undefined, 'random-words', 100)).toBe(DEFAULT_OVERRIDE_WORDS);
    });

    test('desktop estimates count the spaces and assume a slower rate than prose', () => {
        // Desktop types the whole text: 5 letters per word plus the spaces
        // between them, at 175 keystrokes a minute — copying unrelated words
        // is slower than the 200/min usually quoted for prose.
        expect(getOverrideEstimatedMinutes('random-words', 15, '', false)).toBe(1); // 89 keys
        expect(getOverrideEstimatedMinutes('random-words', 87, '', false)).toBe(3); // 521 keys
        expect(getOverrideEstimatedMinutes('random-words', 300, '', false)).toBe(11); // 1799 keys
        expect(getOverrideEstimatedMinutes('random-words', 1000, '', false)).toBe(35); // 5999 keys
    });

    test('phone estimates are letters only, at a touchscreen rate', () => {
        // The word-by-word gate never asks for a space; 100 letters a minute.
        expect(getOverrideEstimatedMinutes('random-words', 15, '', true)).toBe(1); // 75 letters
        expect(getOverrideEstimatedMinutes('random-words', 100, '', true)).toBe(5); // 500 letters
    });

    test('custom text is prose: 200 a minute on desktop, 150 on a phone', () => {
        expect(getOverrideEstimatedMinutes('custom', 0, 'x'.repeat(400), false)).toBe(2);
        expect(getOverrideEstimatedMinutes('custom', 0, 'x'.repeat(400), true)).toBe(3);
        expect(getOverrideEstimatedMinutes('custom', 0, '', false)).toBe(0);
    });

    test('nothing to type is zero minutes', () => {
        expect(getOverrideEstimatedMinutes('random-words', 0, '', false)).toBe(0);
        expect(getOverrideEstimatedMinutes('random-words', 'abc', '', true)).toBe(0);
    });

    test('difficulty workload is letters, so 10 words tie with 50 characters of custom text', () => {
        expect(getDifficultyTypingCharCount({ type: 'random-words', count: 10 })).toBe(50);
        expect(getDifficultyTypingCharCount({ type: 'custom', customText: 'x'.repeat(50) })).toBe(50);
    });
});

describe('migrateOverrideDifficultyToWords', () => {
    // Desktop used to store a character target; iOS/Android already stored
    // words. Gibberish and Max difficulty are gone. The failure must fall
    // toward blocking: a max-difficulty space becomes the platform maximum,
    // and a count above the maximum is clamped, never dropped.
    test('desktop character counts become words (six characters per word)', () => {
        expect(migrateOverrideDifficultyToWords({ type: 'random-words', count: 50 }, { maxWords: 300, countsAreChars: true }))
            .toEqual({ type: 'random-words', count: 8, customText: '' });
        expect(migrateOverrideDifficultyToWords({ type: 'random-words', count: 7500 }, { maxWords: 300, countsAreChars: true }))
            .toEqual({ type: 'random-words', count: 300, customText: '' });
        expect(migrateOverrideDifficultyToWords({ type: 'random-words', count: 3 }, { maxWords: 300, countsAreChars: true }).count).toBe(1);
    });

    test('phone word counts are kept, only clamped to the new maximum', () => {
        expect(migrateOverrideDifficultyToWords({ type: 'random-words', count: 25 }, { maxWords: 100, countsAreChars: false }).count).toBe(25);
        expect(migrateOverrideDifficultyToWords({ type: 'random-words', count: 500 }, { maxWords: 100, countsAreChars: false }).count).toBe(100);
    });

    test('gibberish becomes random words and max difficulty becomes the maximum', () => {
        expect(migrateOverrideDifficultyToWords({ type: 'gibberish', count: 120 }, { maxWords: 300, countsAreChars: true }))
            .toEqual({ type: 'random-words', count: 20, customText: '' });
        expect(migrateOverrideDifficultyToWords(
            { type: 'random-words', count: 7500, maxDifficulty: true, countBeforeMax: 40, typeBeforeMax: 'random-words' },
            { maxWords: 300, countsAreChars: true },
        )).toEqual({ type: 'random-words', count: 300, customText: '' });
        expect(migrateOverrideDifficultyToWords({ type: 'gibberish', maxDifficulty: true }, { maxWords: 100, countsAreChars: false }).count).toBe(100);
    });

    test('custom text survives untouched and gets a sane word count', () => {
        const out = migrateOverrideDifficultyToWords({ type: 'custom', customText: ' I choose focus ', count: 999 }, { maxWords: 300, countsAreChars: true });
        expect(out.type).toBe('custom');
        expect(out.customText).toBe('I choose focus');
        expect(out.count).toBe(DEFAULT_OVERRIDE_WORDS);
    });

    test('missing or malformed input yields the default', () => {
        expect(migrateOverrideDifficultyToWords(null, { maxWords: 300, countsAreChars: true }))
            .toEqual({ type: 'random-words', count: DEFAULT_OVERRIDE_WORDS, customText: '' });
        expect(migrateOverrideDifficultyToWords({ type: 'bogus' }, { maxWords: 300, countsAreChars: false }).type).toBe('random-words');
    });
});

describe('the "maximum words" setting', () => {
    test('defaults to 300 and is held to 50–1000', () => {
        expect(DEFAULT_MAX_OVERRIDE_WORDS_SETTING).toBe(300);
        expect(normalizeMaxOverrideWordsSetting(undefined)).toBe(300);
        expect(normalizeMaxOverrideWordsSetting('abc')).toBe(300);
        expect(normalizeMaxOverrideWordsSetting(10)).toBe(50);
        expect(normalizeMaxOverrideWordsSetting(5000)).toBe(1000);
        expect(normalizeMaxOverrideWordsSetting('650')).toBe(650);
    });

    test('it sets the top of the desktop slider', () => {
        expect(getOverrideWordsSliderMax({ maxSetting: undefined, currentCount: 15, mobile: false })).toBe(300);
        expect(getOverrideWordsSliderMax({ maxSetting: 1000, currentCount: 15, mobile: false })).toBe(1000);
        expect(getOverrideWordsSliderMax({ maxSetting: 50, currentCount: 15, mobile: false })).toBe(50);
    });

    test('lowering it never pulls an existing space down', () => {
        // The slider is the only thing the setting touches. A space already
        // above it keeps its count and gets a slider long enough to show it —
        // otherwise opening the editor and saving would quietly cut the
        // challenge, and the setting would be a way around it.
        expect(getOverrideWordsSliderMax({ maxSetting: 50, currentCount: 800, mobile: false })).toBe(800);
        expect(normalizeOverrideCount(800, 'random-words', getMaxOverrideWords(false))).toBe(800);
    });

    test('phones ignore it: the native gate cannot serve more than 100 words', () => {
        expect(getOverrideWordsSliderMax({ maxSetting: 1000, currentCount: 15, mobile: true })).toBe(100);
    });

    test('raising the ceiling does not inflate legacy migrations', () => {
        // 7500 characters used to mean "the 300-word maximum", not 1000 words.
        expect(migrateOverrideDifficultyToWords({ type: 'random-words', count: 7500 }, { maxWords: 1000, countsAreChars: true }).count).toBe(300);
        expect(migrateOverrideDifficultyToWords({ type: 'random-words', maxDifficulty: true }, { maxWords: 1000, countsAreChars: false }).count).toBe(300);
        // A current word count is untouched up to the ceiling.
        expect(migrateOverrideDifficultyToWords({ type: 'random-words', count: 800 }, { maxWords: 1000, countsAreChars: false }).count).toBe(800);
    });
});
