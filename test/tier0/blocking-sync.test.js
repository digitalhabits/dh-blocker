import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { syncBlockingState } from '../../src/persistence.js';
import { syncIOSSchedules } from '../../src/schedule-engine.js';
import { state } from '../../src/state.js';
import { tauriAPI } from '../../src/tauri-api.js';

let previous;
beforeEach(() => {
    previous = { appData: state.appData, isIOS: state.isIOS, lastBlockedDomains: state.lastBlockedDomains };
    state.appData = { blocklists: [], activeBlocks: [], schedules: [], settings: {} };
    state.lastBlockedDomains = new Set();
});
afterEach(() => {
    Object.assign(state, previous);
});

test('desktop domain changes update the app watcher and unchanged domains skip the update', async () => {
    state.isIOS = false;
    state.appData.blocklists = [{ id: 'manual', websites: ['manual.invalid'], apps: ['Slack'] }];
    state.appData.activeBlocks = [{ blocklistId: 'manual', startTime: 0, endTime: Date.now() + 60_000 }];
    const watcher = vi.spyOn(tauriAPI, 'setBlockedApps').mockResolvedValue(null);
    const screenTime = vi.spyOn(tauriAPI, 'screentimeStartBlock');
    const schedules = vi.spyOn(tauriAPI, 'setSchedulesPlugin');

    await expect(syncBlockingState()).resolves.toEqual({ success: true });
    expect(watcher).toHaveBeenCalledExactlyOnceWith(['Slack'], [], { allowedApps: [], allowlistActive: false });
    expect(state.lastBlockedDomains).toEqual(new Set(['manual.invalid']));
    await expect(syncBlockingState()).resolves.toEqual({ success: true, unchanged: true });
    await syncIOSSchedules();
    expect(watcher).toHaveBeenCalledOnce();
    expect(screenTime).not.toHaveBeenCalled();
    expect(schedules).not.toHaveBeenCalled();
});

test('iOS clears only the manual channel while a schedule is active', async () => {
    state.isIOS = true;
    state.appData.schedules = [{
        id: 'schedule', repeatType: 'forever',
        segments: [{ startHour: 0, startMinute: 0, endHour: 0, endMinute: 0, days: [0, 1, 2, 3, 4, 5, 6] }],
    }];
    state.lastBlockedDomains = new Set(['previous.invalid']);
    const clearManual = vi.spyOn(tauriAPI, 'screentimeClearManualBlock').mockResolvedValue({ success: true });
    const clearAll = vi.spyOn(tauriAPI, 'screentimeClearBlock').mockResolvedValue({ success: true });
    const watcher = vi.spyOn(tauriAPI, 'setBlockedApps');

    await expect(syncBlockingState()).resolves.toEqual({ success: true });
    expect(clearManual).toHaveBeenCalledOnce();
    expect(clearAll).not.toHaveBeenCalled();
    expect(watcher).not.toHaveBeenCalled();
    expect(state.lastBlockedDomains.size).toBe(0);
});

test('iOS reports a rejected Screen Time call without recording a new policy', async () => {
    state.isIOS = true;
    state.appData.blocklists = [{ id: 'manual', websites: ['manual.invalid'] }];
    state.appData.activeBlocks = [{ blocklistId: 'manual', startTime: 0, endTime: Date.now() + 60_000 }];
    const startBlock = vi.spyOn(tauriAPI, 'screentimeStartBlock').mockRejectedValue(new Error('permission denied'));
    const watcher = vi.spyOn(tauriAPI, 'setBlockedApps');

    await expect(syncBlockingState()).resolves.toEqual({ success: false, error: 'Error: permission denied' });
    expect(startBlock).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ domains: ['manual.invalid'] }));
    expect(watcher).not.toHaveBeenCalled();
    expect(state.lastBlockedDomains.size).toBe(0);
});
