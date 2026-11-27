import { readFileSync } from 'node:fs';
import { beforeEach, expect, test, vi } from 'vitest';
import '../../src/app.js';

const invoke = vi.hoisted(() => vi.fn());
const ask = vi.hoisted(() => vi.fn().mockResolvedValue(false));
vi.mock('@tauri-apps/plugin-dialog', async (importOriginal) => ({ ...await importOriginal(), ask }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

beforeEach(() => {
    const html = readFileSync('src/index.html', 'utf8');
    document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('en');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    invoke.mockReset();
});

test.each(['load_data', 'save_data'])('startup failure in %s keeps confirmed uninstall reachable', async (failingCommand) => {
    const now = Date.now();
    invoke.mockImplementation(async (command) => {
        if (command === failingCommand) throw new Error('Could not open the data file');
        if (command === 'load_data') {
            return {
                blocklists: [{ id: 'space', name: 'Space', websites: ['example.com'] }],
                activeBlocks: [{ id: 'block', blocklistId: 'space', startTime: now - 1000, endTime: now + 60_000 }],
                settings: {},
            };
        }
        return {};
    });

    document.dispatchEvent(new Event('DOMContentLoaded'));
    const recovery = document.getElementById('startup-recovery');
    await vi.waitFor(() => expect(recovery.classList.contains('hidden')).toBe(false));
    expect(document.getElementById('startup-recovery-error').textContent).toContain('Could not open the data file');
    expect(document.getElementById('main-content').classList.contains('hidden')).toBe(true);
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(
        failingCommand === 'load_data' ? ['load_data'] : ['load_data', 'save_data'],
    );

    document.getElementById('startup-recovery-uninstall').click();
    const confirmation = document.getElementById('uninstall-confirm-modal');
    await vi.waitFor(() => expect(confirmation.classList.contains('hidden')).toBe(false));
    expect(invoke).not.toHaveBeenCalledWith('uninstall_self_macos', expect.anything());
    document.getElementById('confirm-uninstall-confirm-btn').click();

    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('uninstall_self_macos', { deleteUserData: false }));
});

test('damaged desktop data offers recovery and cancelling keeps the original file', async () => {
    invoke.mockImplementation(async (command) => {
        if (command === 'load_data') throw new Error('Invalid saved data in rules.json: missing field');
        return false;
    });
    document.dispatchEvent(new Event('DOMContentLoaded'));
    const restore = document.getElementById('startup-recovery-restore');
    await vi.waitFor(() => expect(restore.classList.contains('hidden')).toBe(false));
    restore.click();
    await vi.waitFor(() => expect(restore.disabled).toBe(false));
    expect(ask).toHaveBeenCalledOnce();
    expect(invoke.mock.calls.some(([name]) => name === 'recover_invalid_data')).toBe(false);
});
