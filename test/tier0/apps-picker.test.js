import { beforeEach, expect, test, vi } from 'vitest';

const tauriAPI = { openAppPicker: vi.fn() };
const pushModalUndo = vi.fn();

vi.mock('../../src/tauri-api.js', () => ({ tauriAPI }));
vi.mock('../../src/app.js', () => ({ pushModalUndo }));
vi.mock('../../src/blocking-platform.js', () => ({ ensureInstalledAppsCache: vi.fn(async () => {}) }));

const { state } = await import('../../src/state.js');
const { openInstalledAppsPicker } = await import('../../src/apps-picker.js');

const modal = () => document.getElementById('app-picker-modal');
const row = (name) => document.querySelector(`#app-picker-list input[data-process="${name}"]`);

beforeEach(() => {
    document.body.innerHTML = `
        <div id="app-picker-modal" class="hidden">
            <input id="app-picker-search">
            <div id="app-picker-list"></div>
            <button id="app-picker-browse-btn"></button>
            <button id="app-picker-cancel-btn"></button>
            <button id="app-picker-add-btn"></button>
        </div>`;
    state.isAndroid = false;
    state.installedAppsCache = [
        { display_name: 'Google Chrome', process_name: 'Google Chrome' },
        { display_name: 'Slack', process_name: 'Slack' },
    ];
    window.modalApps = [];
    window.renderModalTags = vi.fn();
    pushModalUndo.mockClear();
});

test('browsing manually keeps earlier ticks and adds nothing until Add Selected', async () => {
    await openInstalledAppsPicker();
    row('Slack').click();

    tauriAPI.openAppPicker.mockResolvedValue(['Photoshop', 'Google Chrome']);
    await document.getElementById('app-picker-browse-btn').onclick();

    // Still open, nothing written to the editor behind the user's back.
    expect(modal().classList.contains('hidden')).toBe(false);
    expect(window.modalApps).toEqual([]);
    expect(pushModalUndo).not.toHaveBeenCalled();
    // The earlier tick survives; the browsed apps arrive ticked, the unlisted one as a new row.
    expect(row('Slack').checked).toBe(true);
    expect(row('Photoshop').checked).toBe(true);
    expect(row('Google Chrome').checked).toBe(true);

    document.getElementById('app-picker-add-btn').click();
    expect(window.modalApps.sort()).toEqual(['Google Chrome', 'Photoshop', 'Slack']);
    expect(pushModalUndo).toHaveBeenCalledTimes(1);
    expect(modal().classList.contains('hidden')).toBe(true);
});

test('browsing manually cannot select the blocker itself', async () => {
    await openInstalledAppsPicker();
    tauriAPI.openAppPicker.mockResolvedValue(['Digital Habits Blocker']);
    await document.getElementById('app-picker-browse-btn').onclick();

    expect(row('Digital Habits Blocker')).toBeNull();
    expect(document.getElementById('app-picker-add-btn').disabled).toBe(true);
});
