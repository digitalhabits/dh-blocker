import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { state } from '../../src/state.js';
import {
    maybeSendUsagePing,
    usagePingEnabled,
    usagePingKeyForMonth,
} from '../../src/usage-ping.js';

// The ping's privacy promise rests on two things nothing else checks: the
// key changes when the month does, and the switch in Settings stops it.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('usagePingKeyForMonth', () => {
    test('keeps the key within its month', () => {
        const key = '11111111-1111-4111-8111-111111111111';
        expect(usagePingKeyForMonth({ month: '2026-09', key }, '2026-09')).toBe(key);
    });

    test('makes a new random key in a new month', () => {
        const key = '11111111-1111-4111-8111-111111111111';
        const next = usagePingKeyForMonth({ month: '2026-09', key }, '2026-10');
        expect(next).not.toBe(key);
        expect(next).toMatch(UUID);
    });

    test('makes a key when nothing is stored', () => {
        expect(usagePingKeyForMonth({}, '2026-09')).toMatch(UUID);
        expect(usagePingKeyForMonth(null, '2026-09')).toMatch(UUID);
    });
});

describe('maybeSendUsagePing', () => {
    let fetchMock;
    const saved = state.appData;

    beforeEach(() => {
        localStorage.clear();
        fetchMock = vi.fn(async () => ({ ok: true }));
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        state.appData = saved;
        vi.unstubAllGlobals();
    });

    test('is on unless the user turned it off', () => {
        state.appData = { settings: {} };
        expect(usagePingEnabled()).toBe(true);
        state.appData = { settings: { usagePingEnabled: false } };
        expect(usagePingEnabled()).toBe(false);
    });

    test('sends nothing when turned off', async () => {
        state.appData = { settings: { usagePingEnabled: false } };
        await maybeSendUsagePing();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    test('sends only product, platform and key, once a day', async () => {
        state.appData = { settings: {} };
        await maybeSendUsagePing();
        await maybeSendUsagePing();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(Object.keys(body).sort()).toEqual(['key', 'platform', 'product']);
        expect(body.product).toBe('blocker');
        expect(['mac', 'windows', 'ios']).toContain(body.platform);
        expect(body.key).toMatch(UUID);
    });
});
