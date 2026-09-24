import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { usagePingKeyForMonth } from '../../src/usage-ping.js';

// The ping's privacy promise rests on things nothing else checks: the key
// changes when the month does, the switch in Settings stops it, and it only
// goes out from a release build on a day Blocker is really used.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const win = vi.hoisted(() => ({ visible: false, onFocus: null }));
vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => ({
        isVisible: async () => win.visible,
        onFocusChanged: async (fn) => { win.onFocus = fn; },
    }),
}));

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

describe('usage ping', () => {
    let fetchMock;
    let state;
    let ping;
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    const inForce = (now = Date.now()) => ({ id: 'b', blocklistId: 'x', startTime: now - 1000, endTime: now + 3_600_000 });

    // A fresh module each time: the sent, due and started flags are module state.
    beforeEach(async () => {
        vi.resetModules();
        ({ state } = await import('../../src/state.js'));
        ping = await import('../../src/usage-ping.js');
        state.appData = { settings: {}, activeBlocks: [], schedules: [] };
        localStorage.clear();
        win.visible = false;
        win.onFocus = null;
        fetchMock = vi.fn(async () => ({ ok: true }));
        vi.stubGlobal('fetch', fetchMock);
        vi.stubEnv('MODE', 'production');
    });

    afterEach(() => {
        // Earlier modules keep their document listeners; switch them off.
        state.appData = { settings: { usagePingEnabled: false }, activeBlocks: [], schedules: [] };
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
        vi.useRealTimers();
    });

    test('is on unless the user turned it off', () => {
        expect(ping.usagePingEnabled()).toBe(true);
        state.appData.settings = { usagePingEnabled: false };
        expect(ping.usagePingEnabled()).toBe(false);
    });

    test('sends nothing when turned off', async () => {
        state.appData.settings = { usagePingEnabled: false };
        win.visible = true;
        ping.startUsagePing();
        await settle();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    test('sends only product, platform and key', async () => {
        await ping.maybeSendUsagePing();
        await ping.maybeSendUsagePing();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(Object.keys(body).sort()).toEqual(['key', 'platform', 'product']);
        expect(body.product).toBe('blocker');
        expect(['mac', 'windows', 'ios']).toContain(body.platform);
        expect(body.key).toMatch(UUID);
    });

    test('a retry after a lost reply sends the same key', async () => {
        fetchMock.mockRejectedValueOnce(new Error('reply lost'));
        await ping.maybeSendUsagePing();
        await ping.maybeSendUsagePing();
        expect(fetchMock).toHaveBeenCalledTimes(2);
        const [first, second] = fetchMock.mock.calls.map((call) => JSON.parse(call[1].body).key);
        expect(second).toBe(first);
    });

    test('sends nothing when it cannot keep its key', async () => {
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage full'); });
        await ping.maybeSendUsagePing();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    test('a failing in-force check never throws into the tick', () => {
        ping.startUsagePing();
        state.appData.activeBlocks = null;
        expect(() => ping.usagePingTick()).not.toThrow();
    });

    test('a hidden login start with nothing in force sends nothing', async () => {
        ping.startUsagePing();
        ping.usagePingTick();
        await settle();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    test('pings when the user launches Blocker with its window showing', async () => {
        win.visible = true;
        ping.startUsagePing();
        await settle();
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test.each([
        ['focus', () => win.onFocus({ payload: true })],
        ['visibilitychange', () => document.dispatchEvent(new Event('visibilitychange'))],
    ])('pings when the user brings up a window that started hidden (%s)', async (_, bringUp) => {
        ping.startUsagePing();
        await settle();
        expect(fetchMock).not.toHaveBeenCalled();
        bringUp();
        await settle();
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test('pings for a block already in force at a hidden login start', async () => {
        state.appData.activeBlocks = [inForce()];
        ping.startUsagePing();
        await settle();
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test('pings once the tick sees a block come into force while hidden', async () => {
        ping.startUsagePing();
        state.appData.activeBlocks = [{ ...inForce(), isPaused: true }];
        ping.usagePingTick();
        await settle();
        expect(fetchMock).not.toHaveBeenCalled();
        state.appData.activeBlocks = [inForce()];
        ping.usagePingTick();
        await settle();
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test('iOS pings on opening, as its JS only runs while the app is open', async () => {
        state.isIOS = true;
        ping.startUsagePing();
        await settle();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(JSON.parse(fetchMock.mock.calls[0][1].body).platform).toBe('ios');
    });

    test('sends at most once per UTC day', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-09-24T23:58:00Z'));
        win.visible = true;
        state.appData.activeBlocks = [inForce()];
        ping.startUsagePing();
        win.onFocus({ payload: true });
        document.dispatchEvent(new Event('visibilitychange'));
        ping.usagePingTick();
        await settle();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        vi.setSystemTime(new Date('2026-09-25T00:01:00Z'));
        ping.usagePingTick();
        await settle();
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    test('a restart later the same UTC day does not ping again', async () => {
        const today = new Date().toISOString().slice(0, 10);
        localStorage.setItem('usagePing', JSON.stringify({ month: today.slice(0, 7), key: 'k', lastDay: today }));
        win.visible = true;
        ping.startUsagePing();
        await settle();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    test.each(['development', 'test', 'e2e'])('a %s build never pings', async (mode) => {
        vi.stubEnv('MODE', mode);
        win.visible = true;
        state.appData.activeBlocks = [inForce()];
        ping.startUsagePing();
        ping.usagePingTick();
        await ping.maybeSendUsagePing();
        await settle();
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
