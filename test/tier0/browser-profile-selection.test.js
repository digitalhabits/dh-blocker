import { describe, expect, test } from 'vitest';
import { preferredBrowserProfile } from '../../src/browser-profile-selection.js';

const profile = (name, isDefault, installed = true, enabled = true, privateBrowsing = true) => ({
    name, isDefault, installed, enabled, privateBrowsing,
});

describe('browser installation-default selection', () => {
    test('configured Firefox default wins in either file order', () => {
        const old = profile('old', true, false, false, false);
        const current = profile('current', true);
        for (const profiles of [[old, current], [current, old]]) {
            expect(preferredBrowserProfile({ profiles })).toBe(current);
        }
    });

    test('installed, enabled and private-window setup are ranked in order', () => {
        const missing = profile('missing', true, false, false, false);
        const disabled = profile('disabled', true, true, false, false);
        const noPrivate = profile('no-private', true, true, true, false);
        const ready = profile('ready', true);
        expect(preferredBrowserProfile({ profiles: [missing, disabled] })).toBe(disabled);
        expect(preferredBrowserProfile({ profiles: [disabled, noPrivate] })).toBe(noPrivate);
        expect(preferredBrowserProfile({ profiles: [noPrivate, ready] })).toBe(ready);
    });

    test('a non-default must not hide a broken declared default', () => {
        const broken = profile('default', true, false, false, false);
        const other = profile('secondary', false);
        expect(preferredBrowserProfile({ profiles: [other, broken] })).toBe(broken);
    });

    test('equal ranks keep the first default', () => {
        const first = profile('first', true);
        expect(preferredBrowserProfile({ profiles: [first, profile('second', true)] })).toBe(first);
    });

    test('no declared default preserves the first-profile fallback', () => {
        const first = profile('first', false, false, false, false);
        expect(preferredBrowserProfile({ profiles: [first, profile('second', false)] })).toBe(first);
    });

    test('missing or empty profile catalog returns null', () => {
        for (const browser of [null, {}, { profiles: [] }]) {
            expect(preferredBrowserProfile(browser)).toBe(null);
        }
    });
});
