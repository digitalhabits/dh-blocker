import { expect, test } from 'vitest';
import { SETTINGS_TRANSLATIONS as T } from '../../src/i18n.js';

// A translation with other {placeholders} than English prints a raw token or drops a detail.
const tokens = (s) => (typeof s === 'string' ? [...new Set(s.match(/\{\w+\}/g))].sort().join() : '');

test.each(Object.keys(T).filter((lang) => lang !== 'en'))('%s uses the same {placeholders} as English', (lang) => {
    const drift = Object.entries(T[lang])
        .filter(([key, value]) => key in T.en && tokens(value) !== tokens(T.en[key]))
        .map(([key, value]) => `${key}: en [${tokens(T.en[key])}] vs [${tokens(value)}]`);
    expect(drift).toEqual([]);
});
