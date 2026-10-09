import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
    IOS_ALLOWLIST_EXCEPTION_LIMIT,
    IOS_SIGN_IN_DOMAINS,
    deriveIOSEffectiveWebsitePolicy,
    validateIOSAllowlistLimits,
} from '../../src/allowlist-ios.js';

const allowSource = (websites) => ({ blocklist: { id: 'allow', mode: 'allowlist', websites } });
const blockSource = (websites) => ({ blocklist: { id: 'block', mode: 'blocklist', websites } });
const sites = (n) => Array.from({ length: n }, (_, i) => `site${i}.com`);

// Screen Time's web filter covers every web view on the phone, including the
// sign-in sheet another app opens. An allow-only space that did not list
// accounts.google.com broke "Sign in with Google" everywhere.
describe('iOS sign-in domains', () => {
    test('an allow-only space always lets the sign-in domains through', () => {
        const policy = deriveIOSEffectiveWebsitePolicy([allowSource(['github.com'])]);
        expect(policy.kind).toBe('all-except');
        expect(policy.domains).toEqual(expect.arrayContaining(['github.com', ...IOS_SIGN_IN_DOMAINS]));
    });

    test('an allow-only space that allows nothing still lets them through', () => {
        const policy = deriveIOSEffectiveWebsitePolicy([allowSource(['github.com']), blockSource(['github.com'])]);
        expect(new Set(policy.domains)).toEqual(new Set(IOS_SIGN_IN_DOMAINS));
    });

    test('a blocklist naming one does not take it away', () => {
        const policy = deriveIOSEffectiveWebsitePolicy([
            allowSource(['github.com']),
            blockSource(['accounts.google.com']),
        ]);
        expect(policy.domains).toContain('accounts.google.com');
    });

    test('a blocklist-only policy does not gain them', () => {
        // `.specific` blocks only what it names, so there is nothing to except.
        const policy = deriveIOSEffectiveWebsitePolicy([blockSource(['reddit.com'])]);
        expect(policy).toEqual({ kind: 'specific-block', domains: ['reddit.com'] });
    });

    test('they take room in the 50-domain cap, and the message counts only the user\'s sites', () => {
        const room = IOS_ALLOWLIST_EXCEPTION_LIMIT - IOS_SIGN_IN_DOMAINS.length;
        const fits = validateIOSAllowlistLimits(deriveIOSEffectiveWebsitePolicy([allowSource(sites(room))]));
        expect(fits.ok).toBe(true);

        const over = validateIOSAllowlistLimits(deriveIOSEffectiveWebsitePolicy([allowSource(sites(room + 1))]));
        expect(over).toEqual({ ok: false, reason: 'domains', count: room + 1, max: room });
    });

    // The Swift resolver enforces what the JS one validates; a domain on one
    // list and not the other either breaks sign-in or overflows the cap.
    test.each([
        'tauri-plugin-screentime/ios/Sources/ScheduleData.swift',
        'src-tauri/gen/apple/Shared/ScheduleData.swift',
    ])('%s lists the same domains', (path) => {
        const swift = readFileSync(path, 'utf8');
        const block = swift.match(/enum IOSSignInDomains \{[\s\S]*?\n\}/);
        expect(block, 'IOSSignInDomains not found').not.toBeNull();
        const listed = [...block[0].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
        expect(new Set(listed)).toEqual(new Set(IOS_SIGN_IN_DOMAINS));
    });
});
