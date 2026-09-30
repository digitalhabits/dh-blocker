import { beforeEach, describe, expect, test, vi } from 'vitest';

// The update command reports what it did. On macOS an in-place update exits
// and reopens the app, so the banner must not also claim an installer opened
// or re-enable the button for a second download while the process winds down.

const api = vi.hoisted(() => ({ outcome: null }));
const dialog = vi.hoisted(() => ({ message: null }));

vi.mock('../../src/tauri-api.js', () => ({
    tauriAPI: {
        downloadAndRunUpdate: async () => api.outcome,
        onUpdateDownloadProgress: async () => () => {},
    },
    openUrl: () => {},
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({
    message: (...args) => dialog.message(...args),
}));

const { state } = await import('../../src/state.js');
const { startUpdateDownload, resetUpdateDownloadButtonState } = await import('../../src/update-banner.js');

describe('startUpdateDownload', () => {
    let btn;

    beforeEach(() => {
        document.body.innerHTML = '<button id="update-banner-link"></button>';
        btn = document.getElementById('update-banner-link');
        dialog.message = vi.fn(async () => {});
        state.isMacOSDesktop = true;
        // The in-place case deliberately leaves the in-progress flag set.
        resetUpdateDownloadButtonState();
    });

    test('an in-place update leaves the button busy and opens no dialog', async () => {
        api.outcome = 'relaunching';
        await startUpdateDownload('v3.9.1');
        expect(btn.textContent).toBe('Restarting…');
        expect(btn.disabled).toBe(true);
        expect(btn.getAttribute('aria-busy')).toBe('true');
        expect(dialog.message).not.toHaveBeenCalled();
    });

    test('the .pkg fallback still tells the user an installer opened', async () => {
        api.outcome = 'installerOpened';
        await startUpdateDownload('v3.9.1');
        expect(btn.disabled).toBe(false);
        expect(dialog.message).toHaveBeenCalledTimes(1);
        expect(dialog.message.mock.calls[0][1].title).toBe('Installer opened');
    });
});
