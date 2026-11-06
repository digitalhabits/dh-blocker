import { expect, test, vi } from 'vitest';
import { stopFocusSpaceTarget } from '../../src/confirm-modals.js';
import { state } from '../../src/state.js';
import { tauriAPI } from '../../src/tauri-api.js';

test('a failed iOS Never save leaves both the target and existing schedule shields active', async () => {
    const previousData = state.appData;
    const previousIOS = state.isIOS;
    const owned = { id: 'owned-schedule', blocklistId: 'owned', segments: [] };
    const original = { id: 'original-schedule', blocklistId: 'original', segments: [] };
    const save = vi.spyOn(tauriAPI, 'saveData').mockRejectedValue(new Error('Could not save schedule'));
    const clear = vi.spyOn(tauriAPI, 'screentimeClearScheduleBlock').mockResolvedValue();
    try {
        state.isIOS = true;
        state.appData = { blocklists: [], schedules: [owned, original] };

        await expect(stopFocusSpaceTarget({ schedule: owned, minutes: 0 })).rejects.toThrow('Could not save schedule');
        expect(save).toHaveBeenCalledOnce();
        expect(clear).not.toHaveBeenCalled();
        expect(owned).not.toHaveProperty('isPaused');
        expect(owned).not.toHaveProperty('pauseEndTime');
        expect(original).not.toHaveProperty('isPaused');
    } finally {
        save.mockRestore();
        clear.mockRestore();
        state.appData = previousData;
        state.isIOS = previousIOS;
    }
});
