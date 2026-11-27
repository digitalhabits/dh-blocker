import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { initializeIOSBlockingState, reconcileIOSManualBlockingState } from '../../src/blocking-platform.js';
import { commitDelete, deleteBlocklist, pendingDelete, UNDO_TOAST_SECONDS, undoDelete } from '../../src/blocklists.js';
import { startManualBlock, stopFocusSpaceTarget } from '../../src/confirm-modals.js';
import { turnFocusSpaceOn } from '../../src/focus-space-switch.js';
import { runIOSManualOperation, saveData, syncBlockingState } from '../../src/persistence.js';
import * as renderModule from '../../src/render.js';
import { syncIOSSchedules } from '../../src/schedule-engine.js';
import { performOverrideAll } from '../../src/settings.js';
import { state } from '../../src/state.js';
import { tauriAPI } from '../../src/tauri-api.js';

let previous;
beforeEach(() => {
    previous = {
        appData: state.appData,
        isIOS: state.isIOS,
        lastBlockedDomains: state.lastBlockedDomains,
        activatedBlockIds: state.activatedBlockIds,
        screentimeAuthorized: state.screentimeAuthorized,
    };
    state.appData = { blocklists: [], activeBlocks: [], schedules: [], settings: {} };
    state.lastBlockedDomains = new Set();
    state.activatedBlockIds = new Set();
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

test.each(['missing', 'paused', 'expired'])('iOS launch reconciles a manual shield with %s saved intent', async (intent) => {
    state.isIOS = true;
    const now = Date.now();
    state.appData.blocklists = [{ id: 'space', websites: ['manual.invalid'] }];
    if (intent !== 'missing') {
        state.appData.activeBlocks = [{
            id: 'saved-pause',
            blocklistId: 'space',
            startTime: now - 60_000,
            endTime: intent === 'expired' ? now - 1 : now + 60_000,
            isPaused: intent === 'paused',
            pauseEndTime: intent === 'paused' ? now + 30_000 : undefined,
        }];
    }
    const clearManual = vi.spyOn(tauriAPI, 'screentimeClearManualBlock').mockResolvedValue({ success: true });
    const clearAll = vi.spyOn(tauriAPI, 'screentimeClearBlock');
    vi.spyOn(tauriAPI, 'setSchedulesPlugin').mockResolvedValue({ success: true });
    vi.spyOn(tauriAPI, 'screentimeSetStartWarnings').mockResolvedValue({ success: true });

    await initializeIOSBlockingState();
    expect(clearManual).toHaveBeenCalledExactlyOnceWith(intent === 'paused' ? ['saved-pause'] : []);
    expect(clearAll).not.toHaveBeenCalled();
});

test.each([false, true])('iOS launch reapplies saved manual intent (expired pause: %s)', async (expiredPause) => {
    state.isIOS = true;
    const now = Date.now();
    state.appData.blocklists = [{ id: 'space', websites: ['manual.invalid'] }];
    state.appData.activeBlocks = [{
        blocklistId: 'space', startTime: 0, endTime: now + 60_000,
        isPaused: expiredPause, pauseEndTime: expiredPause ? now - 1 : undefined,
    }];
    const start = vi.spyOn(tauriAPI, 'screentimeStartBlock').mockResolvedValue({ success: true });
    vi.spyOn(tauriAPI, 'setSchedulesPlugin').mockResolvedValue({ success: true });

    await initializeIOSBlockingState();
    expect(start).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ domains: ['manual.invalid'] }));
});

test.each(['start', 'clear'])('iOS reports a resolved native %s failure and preserves the previous policy', async (action) => {
    state.isIOS = true;
    state.lastBlockedDomains = new Set(['previous.invalid']);
    const error = 'Screen Time rejected the update';
    if (action === 'start') {
        state.appData.blocklists = [{ id: 'manual', websites: ['manual.invalid'] }];
        state.appData.activeBlocks = [{ blocklistId: 'manual', startTime: 0, endTime: Date.now() + 60_000 }];
        vi.spyOn(tauriAPI, 'screentimeStartBlock').mockResolvedValue({ success: false, error });
    } else {
        vi.spyOn(tauriAPI, 'screentimeClearManualBlock').mockResolvedValue({ success: false, error });
        vi.spyOn(tauriAPI, 'screentimeClearBlock').mockResolvedValue({ success: false, error });
    }

    await expect(syncBlockingState()).resolves.toEqual({ success: false, error });
    expect(state.lastBlockedDomains).toEqual(new Set(['previous.invalid']));
});

test('a failed iOS Manual start save releases only the attempted restriction', async () => {
    state.isIOS = true;
    state.screentimeAuthorized = true;
    const original = { id: 'original', blocklistId: 'saved', startTime: 0, endTime: Date.now() + 60_000 };
    state.appData.activeBlocks = [original];
    state.appData.blocklists = [
        { id: 'saved', websites: ['existing.invalid'] },
        { id: 'new', websites: ['new.invalid'] },
    ];
    const start = vi.spyOn(tauriAPI, 'screentimeStartBlock').mockResolvedValue({ success: true });
    const clear = vi.spyOn(tauriAPI, 'screentimeClearManualBlock');
    const save = vi.spyOn(tauriAPI, 'saveData').mockRejectedValue(new Error('Could not save manual block'));
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});

    await expect(startManualBlock('new')).resolves.toBe(false);
    expect(start.mock.calls.map(([payload]) => payload.domains)).toEqual([
        ['existing.invalid', 'new.invalid'], ['existing.invalid'],
    ]);
    expect(save).toHaveBeenCalledOnce();
    expect(clear).not.toHaveBeenCalled();
    expect(state.appData.activeBlocks).toEqual([original]);
    expect(state.activatedBlockIds.size).toBe(0);
    expect(alert).toHaveBeenCalledWith('Could not start block: Could not save manual block');
});

test('iOS stops one Manual source without clearing its overlap', async () => {
    state.isIOS = true;
    const keep = { id: 'keep', blocklistId: 'saved', startTime: 0, endTime: Date.now() + 60_000 };
    const remove = { ...keep, id: 'remove', blocklistId: 'removed' };
    state.appData.activeBlocks = [keep, remove];
    state.appData.blocklists = [
        { id: 'saved', websites: ['shared.invalid'] },
        { id: 'removed', websites: ['shared.invalid', 'removed.invalid'] },
    ];
    vi.spyOn(tauriAPI, 'saveData').mockResolvedValue();
    vi.spyOn(tauriAPI, 'screentimeCancelResume').mockResolvedValue({ success: true });
    const start = vi.spyOn(tauriAPI, 'screentimeStartBlock').mockResolvedValue({ success: true });
    const clear = vi.spyOn(tauriAPI, 'screentimeClearManualBlock');

    await expect(stopFocusSpaceTarget({ block: remove, minutes: 0 })).resolves.toMatchObject({ kind: 'removed' });
    expect(start).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ domains: ['shared.invalid'] }));
    expect(clear).not.toHaveBeenCalled();
    expect(state.appData.activeBlocks).toEqual([keep]);
});

test.each([0, 10])('a failed iOS Manual stop save retains the active block (pause: %s minutes)', async (minutes) => {
    state.isIOS = true;
    const block = { id: 'keep', blocklistId: 'saved', startTime: 0, endTime: Date.now() + 60_000 };
    state.appData.activeBlocks = [block];
    state.appData.blocklists = [{ id: 'saved', websites: ['keep.invalid'] }];
    const clear = vi.spyOn(tauriAPI, 'screentimeClearManualBlock');
    const cancel = vi.spyOn(tauriAPI, 'screentimeCancelResume').mockResolvedValue({ success: true });
    vi.spyOn(tauriAPI, 'screentimeSetResumePayload').mockResolvedValue({ success: true });
    vi.spyOn(tauriAPI, 'screentimeRegisterOneOffActivity').mockResolvedValue({ success: true });
    vi.spyOn(tauriAPI, 'saveData').mockImplementation(async () => {
        expect(state.appData.activeBlocks).toEqual([block]);
        expect(block).not.toHaveProperty('isPaused');
        throw new Error('Could not save manual stop');
    });

    await expect(stopFocusSpaceTarget({ block, minutes })).rejects.toThrow('Could not save manual stop');
    expect(state.appData.activeBlocks).toEqual([block]);
    expect(block).not.toHaveProperty('isPaused');
    expect(clear).not.toHaveBeenCalled();
    if (minutes > 0) expect(cancel).toHaveBeenCalledExactlyOnceWith('keep');
    else expect(cancel).not.toHaveBeenCalled();
});

test.each(['block', 'schedule'])('a failed iOS %s reschedule restores the original wake-up', async (kind) => {
    state.isIOS = true;
    const previousDeadline = Date.now() + 300_000;
    const target = { id: 'saved-pause', blocklistId: 'space', isPaused: true, pauseEndTime: previousDeadline };
    if (kind === 'block') {
        Object.assign(target, { startTime: 0, endTime: previousDeadline + 300_000 });
        state.appData.activeBlocks = [target];
    } else {
        Object.assign(target, { repeatType: 'forever', segments: [] });
        state.appData.schedules = [target];
    }
    state.appData.blocklists = [{ id: 'space', websites: ['keep.invalid'] }];
    vi.spyOn(tauriAPI, 'screentimeSetResumePayload').mockResolvedValue({ success: true });
    const register = vi.spyOn(tauriAPI, 'screentimeRegisterOneOffActivity').mockResolvedValue({ success: true });
    const cancel = vi.spyOn(tauriAPI, 'screentimeCancelResume');
    vi.spyOn(tauriAPI, 'saveData').mockRejectedValue(new Error('Could not save replacement pause'));

    await expect(stopFocusSpaceTarget({ [kind]: target, minutes: 10 })).rejects.toThrow('Could not save replacement pause');
    const activity = kind === 'block' ? 'redd-block-resume-saved-pause' : 'redd-schedule-resume-saved-pause';
    expect(register).toHaveBeenNthCalledWith(1, activity, expect.any(Number));
    expect(register.mock.calls[0][1]).toBeGreaterThan(previousDeadline);
    expect(register).toHaveBeenNthCalledWith(2, activity, previousDeadline);
    expect(cancel).not.toHaveBeenCalled();
    expect(target).toMatchObject({ isPaused: true, pauseEndTime: previousDeadline });
});

test.each(['native update', 'save'])('failed iOS Resume now retains the saved pause and wake (%s)', async (failure) => {
    state.isIOS = true;
    const pauseEndTime = Date.now() + 300_000;
    const block = { id: 'saved-pause', blocklistId: 'space', startTime: 0, endTime: pauseEndTime + 300_000, isPaused: true, pauseEndTime };
    state.appData.activeBlocks = [block];
    state.appData.blocklists = [{ id: 'space', websites: ['keep.invalid'] }];
    const nativeError = 'Screen Time denied the update';
    vi.spyOn(tauriAPI, 'screentimeStartBlock').mockResolvedValue(failure === 'native update'
        ? { success: false, error: nativeError }
        : { success: true });
    const save = vi.spyOn(tauriAPI, 'saveData').mockRejectedValue(new Error('Could not save Resume now'));
    const cancel = vi.spyOn(tauriAPI, 'screentimeCancelResume');
    const clear = vi.spyOn(tauriAPI, 'screentimeClearManualBlock').mockResolvedValue({ success: true });
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});

    await expect(turnFocusSpaceOn('space')).resolves.toBe(false);
    expect(block).toMatchObject({ isPaused: true, pauseEndTime });
    expect(cancel).not.toHaveBeenCalled();
    expect(clear).toHaveBeenCalledOnce();
    if (failure === 'native update') expect(save).not.toHaveBeenCalled();
    else expect(save).toHaveBeenCalledOnce();
    expect(alert).toHaveBeenCalledWith('Could not resume block: ' + (failure === 'native update' ? nativeError : 'Could not save Resume now'));
});

test('iOS reconciliation retries a native failure and surfaces a persistent one', async () => {
    state.isIOS = true;
    const error = 'Could not clear the old shield';
    const clear = vi.spyOn(tauriAPI, 'screentimeClearManualBlock')
        .mockResolvedValue({ success: true })
        .mockResolvedValueOnce({ success: false, error })
        .mockResolvedValueOnce({ success: false, error });
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});

    await expect(reconcileIOSManualBlockingState()).resolves.toEqual({ success: false, error });
    expect(clear).toHaveBeenCalledTimes(2);
    expect(alert).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(error));
    await expect(reconcileIOSManualBlockingState()).resolves.toEqual({ success: true });
    expect(clear).toHaveBeenCalledTimes(3);
    expect(alert).toHaveBeenCalledOnce();
});

test('two concurrent iOS Manual starts retain both committed spaces through foreground reconciliation', async () => {
    state.isIOS = true;
    state.screentimeAuthorized = true;
    state.appData.blocklists = [
        { id: 'first', websites: ['first.invalid'] },
        { id: 'second', websites: ['second.invalid'] },
    ];
    vi.spyOn(renderModule, 'render').mockImplementation(() => {});
    const applied = vi.spyOn(tauriAPI, 'screentimeStartBlock').mockResolvedValue({ success: true });
    const pendingSave = Promise.withResolvers();
    const saveStarted = Promise.withResolvers();
    const save = vi.spyOn(tauriAPI, 'saveData').mockResolvedValue().mockImplementationOnce(() => {
        saveStarted.resolve();
        return pendingSave.promise;
    });

    const first = startManualBlock('first');
    await saveStarted.promise;
    const second = startManualBlock('second');
    const settingsSave = saveData();
    const foreground = reconcileIOSManualBlockingState();
    // Let a second unqueued operation reach its native apply while the first save is held.
    await new Promise(resolve => setTimeout(resolve, 0));
    try {
        expect(applied).toHaveBeenCalledOnce();
        expect(save).toHaveBeenCalledOnce();
    } finally {
        pendingSave.resolve();
        await Promise.allSettled([first, second, settingsSave, foreground]);
    }

    await expect(Promise.all([first, second, foreground])).resolves.toEqual([true, true, { success: true }]);
    expect(save.mock.calls.map(([draft]) => draft.activeBlocks.map(block => block.blocklistId))).toEqual([
        ['first'], ['first', 'second'], ['first', 'second'],
    ]);
    expect(state.appData.activeBlocks.map(block => block.blocklistId)).toEqual(['first', 'second']);
    expect(applied.mock.calls.map(([policy]) => policy.domains)).toEqual([
        ['first.invalid'], ['first.invalid', 'second.invalid'], ['first.invalid', 'second.invalid'],
    ]);
});

test('a rejected iOS Manual operation releases the next queued operation', async () => {
    const failed = runIOSManualOperation(async () => { throw new Error('Manual save failed'); });
    const next = runIOSManualOperation(async () => 'next operation ran');
    await expect(failed).rejects.toThrow('Manual save failed');
    await expect(next).resolves.toBe('next operation ran');
});

test('failed iOS Stop all save retains Manual blocks, schedules and native wakes', async () => {
    state.isIOS = true;
    const pauseEndTime = Date.now() + 300_000;
    const block = { id: 'manual', blocklistId: 'space', startTime: 0, endTime: pauseEndTime + 300_000, isPaused: true, pauseEndTime };
    const schedule = { id: 'schedule', blocklistId: 'other', repeatType: 'forever', segments: [], isPaused: true, pauseEndTime };
    state.appData.activeBlocks = [block];
    state.appData.schedules = [schedule];
    const save = vi.spyOn(tauriAPI, 'saveData').mockImplementation(async draft => {
        expect(draft.activeBlocks).toEqual([]);
        expect(draft.schedules[0]).not.toHaveProperty('pauseEndTime');
        expect(state.appData.activeBlocks).toEqual([block]);
        expect(schedule.pauseEndTime).toBe(pauseEndTime);
        throw new Error('Could not save Stop all');
    });
    const cancel = vi.spyOn(tauriAPI, 'screentimeCancelResume');
    const clear = vi.spyOn(tauriAPI, 'screentimeClearBlock');
    const schedules = vi.spyOn(tauriAPI, 'setSchedulesPlugin');
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});

    await expect(performOverrideAll()).resolves.toBe(false);
    expect(save).toHaveBeenCalledOnce();
    expect(state.appData.activeBlocks).toEqual([block]);
    expect(schedule.pauseEndTime).toBe(pauseEndTime);
    expect(cancel).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    expect(schedules).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('Could not save Stop all'));
});

test('iOS Stop all reports persistent native clear failure and can be retried', async () => {
    state.isIOS = true;
    state.appData.activeBlocks = [{ id: 'manual', blocklistId: 'space', startTime: 0, endTime: Date.now() + 60_000 }];
    const error = 'Could not clear both native stores';
    const clear = vi.spyOn(tauriAPI, 'screentimeClearBlock').mockResolvedValue({ success: true })
        .mockResolvedValueOnce({ success: false, error })
        .mockResolvedValueOnce({ success: false, error });
    const cancel = vi.spyOn(tauriAPI, 'screentimeCancelResume').mockResolvedValue({ success: true });
    const schedules = vi.spyOn(tauriAPI, 'setSchedulesPlugin').mockResolvedValue({ success: true });
    const save = vi.spyOn(tauriAPI, 'saveData').mockResolvedValue();
    vi.spyOn(tauriAPI, 'screentimeSetStartWarnings').mockResolvedValue({ success: true });
    vi.spyOn(renderModule, 'render').mockImplementation(() => {});
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});

    await expect(performOverrideAll()).resolves.toBe(false);
    expect(clear).toHaveBeenCalledTimes(2);
    expect(schedules).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledExactlyOnceWith('manual');
    expect(state.appData.activeBlocks).toEqual([]);
    expect(alert).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(error));

    await expect(performOverrideAll()).resolves.toBe(true);
    expect(clear).toHaveBeenCalledTimes(3);
    expect(save).toHaveBeenCalledTimes(2);
    expect(alert).toHaveBeenCalledOnce();
});

test('iOS Undo claims the delete before waiting for the queue or a slow save', async () => {
    state.isIOS = true;
    const pauseEndTime = Date.now() + 300_000;
    const block = { id: 'paused', blocklistId: 'space', startTime: 0, endTime: pauseEndTime + 300_000, isPaused: true, pauseEndTime };
    state.appData.activeBlocks = [block];
    state.appData.blocklists = [{ id: 'space', name: 'Paused space', websites: ['keep.invalid'] }];
    vi.spyOn(renderModule, 'render').mockImplementation(() => {});
    vi.spyOn(tauriAPI, 'setSchedulesPlugin').mockResolvedValue({ success: true });
    vi.spyOn(tauriAPI, 'screentimeSetStartWarnings').mockResolvedValue({ success: true });
    const save = vi.spyOn(tauriAPI, 'saveData').mockResolvedValue();
    const cancel = vi.spyOn(tauriAPI, 'screentimeCancelResume').mockResolvedValue({ success: true });
    vi.useFakeTimers();
    const queueGate = Promise.withResolvers();
    const saveGate = Promise.withResolvers();
    let queued;
    let undo;
    try {
        await deleteBlocklist('space');
        expect(pendingDelete?.activeBlocks).toEqual([block]);
        const saveStarted = Promise.withResolvers();
        save.mockImplementationOnce(() => {
            saveStarted.resolve();
            return saveGate.promise;
        });
        queued = runIOSManualOperation(() => queueGate.promise);
        undo = undoDelete();
        expect(pendingDelete).toBeNull();

        await vi.advanceTimersByTimeAsync(UNDO_TOAST_SECONDS * 1000);
        expect(cancel).not.toHaveBeenCalled();
        expect(save).toHaveBeenCalledOnce();

        queueGate.resolve();
        await saveStarted.promise;
        await vi.advanceTimersByTimeAsync(UNDO_TOAST_SECONDS * 1000);
        expect(cancel).not.toHaveBeenCalled();
    } finally {
        queueGate.resolve();
        saveGate.resolve();
        await Promise.allSettled([queued, undo]);
        vi.useRealTimers();
    }
    expect(state.appData.activeBlocks).toEqual([block]);
    expect(save).toHaveBeenCalledTimes(2);
    expect(cancel).not.toHaveBeenCalled();
});

function useIOSDeleteFixture() {
    state.isIOS = true;
    const pauseEndTime = Date.now() + 300_000;
    const block = { id: 'paused', blocklistId: 'space', startTime: 0, endTime: pauseEndTime + 300_000, isPaused: true, pauseEndTime };
    const schedule = { id: 'schedule', blocklistId: 'space', repeatType: 'forever', segments: [], isPaused: true };
    state.appData.blocklists = [{ id: 'space', name: 'Paused space', websites: ['keep.invalid'] }];
    state.appData.activeBlocks = [block];
    state.appData.schedules = [schedule];
    vi.spyOn(renderModule, 'render').mockImplementation(() => {});
    vi.spyOn(tauriAPI, 'screentimeClearManualBlock').mockResolvedValue({ success: true });
    vi.spyOn(tauriAPI, 'screentimeSetStartWarnings').mockResolvedValue({ success: true });
    return {
        block,
        schedule,
        cancel: vi.spyOn(tauriAPI, 'screentimeCancelResume').mockResolvedValue({ success: true }),
        schedules: vi.spyOn(tauriAPI, 'setSchedulesPlugin').mockResolvedValue({ success: true }),
        save: vi.spyOn(tauriAPI, 'saveData').mockResolvedValue(),
        alert: vi.spyOn(window, 'alert').mockImplementation(() => {}),
    };
}

test('failed iOS deletion leaves all three live arrays intact for later saves and can be retried', async () => {
    const { block, schedule, cancel, schedules, save, alert } = useIOSDeleteFixture();
    save.mockImplementationOnce(async draft => {
        expect(draft).toMatchObject({ blocklists: [], activeBlocks: [], schedules: [] });
        expect(state.appData).toMatchObject({ activeBlocks: [block], schedules: [schedule] });
        throw new Error('Delete save failed');
    });

    try {
        await expect(deleteBlocklist('space')).resolves.toBe(false);
        expect(pendingDelete).toBeNull();
        expect(schedules).not.toHaveBeenCalled();
        expect(cancel).not.toHaveBeenCalled();
        expect(alert).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('Delete save failed'));

        await saveData();
        expect(save).toHaveBeenNthCalledWith(2, expect.objectContaining({
            blocklists: [expect.objectContaining({ id: 'space' })], activeBlocks: [block], schedules: [schedule],
        }));
        await expect(deleteBlocklist('space')).resolves.toBe(true);
        expect(state.appData).toMatchObject({ blocklists: [], activeBlocks: [], schedules: [] });
    } finally {
        commitDelete();
        await runIOSManualOperation(() => {});
    }
});

test('failed iOS Undo keeps the deletion saved and offers a retry without cancelling the wake', async () => {
    const { block, schedule, cancel, save, alert } = useIOSDeleteFixture();
    try {
        await deleteBlocklist('space');
        expect(state.appData).toMatchObject({ blocklists: [], activeBlocks: [], schedules: [] });
        save.mockImplementationOnce(async draft => {
            expect(draft).toMatchObject({ activeBlocks: [block], schedules: [schedule] });
            expect(state.appData).toMatchObject({ blocklists: [], activeBlocks: [], schedules: [] });
            throw new Error('Undo save failed');
        });

        await expect(undoDelete()).resolves.toBe(false);
        expect(pendingDelete?.activeBlocks).toEqual([block]);
        expect(cancel).not.toHaveBeenCalled();
        expect(alert).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('Undo save failed'));

        await saveData();
        expect(save).toHaveBeenNthCalledWith(3, expect.objectContaining({ blocklists: [], activeBlocks: [], schedules: [] }));
        await expect(undoDelete()).resolves.toBe(true);
        expect(pendingDelete).toBeNull();
        expect(state.appData).toMatchObject({
            blocklists: [expect.objectContaining({ id: 'space' })], activeBlocks: [block], schedules: [schedule],
        });
        expect(cancel).not.toHaveBeenCalled();
    } finally {
        commitDelete();
        await runIOSManualOperation(() => {});
    }
});
