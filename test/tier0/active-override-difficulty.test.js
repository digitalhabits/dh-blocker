import { expect, test } from 'vitest';
import { resolveActiveOverrideDifficulty } from '../../src/override-challenge.js';

test('active random words can increase, but a stale editor cannot reduce them', () => {
    const saved = { type: 'random-words', count: 100 };
    expect(resolveActiveOverrideDifficulty(saved, { ...saved, count: 150 }, true).count).toBe(150);
    expect(resolveActiveOverrideDifficulty(saved, { ...saved, count: 50 }, true).count).toBe(100);
    expect(resolveActiveOverrideDifficulty(saved, { type: 'custom', customText: 'x' }, true)).toEqual(saved);
    expect(resolveActiveOverrideDifficulty(saved, { ...saved, count: 50 }, false).count).toBe(50);
});

test('active custom text remains unchanged', () => {
    const saved = { type: 'custom', customText: 'A longer commitment', count: 20 };
    expect(resolveActiveOverrideDifficulty(saved, { ...saved, customText: 'x' }, true)).toEqual(saved);
    expect(resolveActiveOverrideDifficulty(saved, { type: 'random-words', count: 1 }, true)).toEqual(saved);
});
