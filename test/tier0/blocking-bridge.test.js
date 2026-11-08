import { expect, test, vi } from 'vitest';
import { tauriAPI } from '../../src/tauri-api.js';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

test('the app watcher receives the complete policy through the desktop command', async () => {
    invoke.mockResolvedValueOnce(null);

    await expect(tauriAPI.setBlockedApps(['Slack'], ['Slack'], {
        allowedApps: ['Notes'],
        allowlistActive: true,
        allowlistNewlyStarted: true,
    })).resolves.toBeNull();
    expect(invoke).toHaveBeenCalledExactlyOnceWith('set_blocked_apps', {
        apps: ['Slack'],
        newlyAdded: ['Slack'],
        allowedApps: ['Notes'],
        allowlistActive: true,
        allowlistNewlyStarted: true,
    });
});

test('app watcher command rejection reaches its caller', async () => {
    const failure = new Error('watcher unavailable');
    invoke.mockRejectedValueOnce(failure);

    await expect(tauriAPI.setBlockedApps([])).rejects.toBe(failure);
});
