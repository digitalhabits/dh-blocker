import { beforeEach, describe, expect, test, vi } from 'vitest';

const tauriAPI = { openAppPicker: vi.fn() };
const pushModalUndo = vi.fn();

vi.mock('../../src/tauri-api.js', () => ({ tauriAPI }));
vi.mock('../../src/app.js', () => ({ pushModalUndo }));
vi.mock('../../src/blocking-platform.js', () => ({ ensureInstalledAppsCache: vi.fn(async () => {}) }));

const { state } = await import('../../src/state.js');
const { canOfferTypedAppName, openInstalledAppsPicker } = await import('../../src/apps-picker.js');

const modal = () => document.getElementById('app-picker-modal');
const row = (name) => document.querySelector(`#app-picker-list input[data-process="${name}"]`);

beforeEach(() => {
    document.body.classList.remove("windows");
    state.isIOS = false;
    document.body.innerHTML = `
        <div id="app-picker-modal" class="hidden">
            <input id="app-picker-search">
            <div id="app-picker-list"></div>
            <button id="app-picker-browse-btn"></button>
            <button id="app-picker-cancel-btn"></button>
            <button id="app-picker-add-btn"></button>
        </div>`;
    state.isAndroid = false;
    state.isMacOSDesktop = false;
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

test('a browsed macOS bundle ticks its installed executable exactly once', async () => {
    state.isMacOSDesktop = true;
    state.installedAppsCache.push({ display_name: 'Visual Studio Code', process_name: 'Code' });
    await openInstalledAppsPicker();
    row('Slack').click();

    tauriAPI.openAppPicker.mockResolvedValue(['Visual Studio Code', 'visual studio code']);
    await document.getElementById('app-picker-browse-btn').onclick();

    expect(row('Code').checked).toBe(true);
    expect(document.getElementById('app-picker-add-btn').textContent).toBe('Add Selected (2)');
    expect(window.modalApps).toEqual([]);
    document.getElementById('app-picker-add-btn').click();
    expect(window.modalApps).toEqual(['Slack', 'Code']);
    expect(pushModalUndo).toHaveBeenCalledTimes(1);
    pushModalUndo.mock.calls[0][1]();
    expect(window.modalApps).toEqual([]);
});

test('browsing matches Windows executable stems, even when a shortcut has the same label', async () => {
    state.installedAppsCache.push({ display_name: 'Contoso', process_name: 'ContosoLauncher' });
    await openInstalledAppsPicker();

    tauriAPI.openAppPicker.mockResolvedValue(['Contoso', 'CONTOSO', 'contosolauncher']);
    await document.getElementById('app-picker-browse-btn').onclick();

    expect(row('Contoso')?.checked).toBe(true);
    expect(row('ContosoLauncher').checked).toBe(true);
    expect(document.getElementById('app-picker-add-btn').textContent).toBe('Add Selected (2)');
    document.getElementById('app-picker-cancel-btn').click();
    expect(window.modalApps).toEqual([]);
    expect(pushModalUndo).not.toHaveBeenCalled();
});

const installed = [
    { display_name: 'Google Chrome', process_name: 'Google Chrome' },
    { display_name: 'Xcode', process_name: 'Xcode' },
];

describe('offering to add an app the scan missed', () => {
    test('offered only when the search found nothing', () => {
        expect(canOfferTypedAppName('Photoshop', installed)).toBe(true);
        expect(canOfferTypedAppName('  Xcode  ', installed)).toBe(false);
        expect(canOfferTypedAppName('google chrome', installed)).toBe(false);
        expect(canOfferTypedAppName('   ', installed)).toBe(false);
    });

    test('the blocker itself is refused however it is spelled', () => {
        // Blocking it would take enforcement down with it, so this path must not
        // hand the user a way in that the installed list already refuses.
        for (const name of ['Digital Habits Blocker', 'digital habits: blocker', 'ReDD Blocker', 'redd-block']) {
            expect(canOfferTypedAppName(name, installed)).toBe(false);
        }
    });
});


test('Windows typed names recognise an optional .exe suffix', async () => {
    document.body.classList.add('windows');
    state.installedAppsCache.push({ display_name: 'Visual Studio Code', process_name: 'Code' });
    await openInstalledAppsPicker();
    const search = document.getElementById('app-picker-search');
    const fill = (value) => {
        search.value = value;
        search.dispatchEvent(new Event('input'));
    };
    fill('Code.EXE');
    expect(row('Code')).not.toBeNull();
    expect(document.querySelector('.app-picker-add-typed')).toBeNull();
    fill('redd-block.exe');
    expect(document.querySelector('.app-picker-add-typed')).toBeNull();
    fill('unlisted.exe');
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(row('unlisted')?.checked).toBe(true);
    document.getElementById('app-picker-add-btn').click();
    expect(window.modalApps).toEqual(['unlisted']);
});

test('typed entries retain ticks, escape markup, and commit in one undo step', async () => {
    state.isMacOSDesktop = true;
    await openInstalledAppsPicker();
    row('Slack').click();
    const search = document.getElementById('app-picker-search');
    search.value = '<missing app>';
    search.dispatchEvent(new Event('input'));
    expect(document.querySelector('#app-picker-list missing')).toBeNull();
    document.querySelector('.app-picker-add-typed').click();
    expect(row('<missing app>').checked).toBe(true);
    expect(row('Slack').checked).toBe(true);
    expect(window.modalApps).toEqual([]);
    document.getElementById('app-picker-add-btn').click();
    expect(window.modalApps).toEqual(['Slack', '<missing app>']);
    expect(pushModalUndo).toHaveBeenCalledTimes(1);
    pushModalUndo.mock.calls[0][1]();
    expect(window.modalApps).toEqual([]);
});

test('cancelling discards a typed entry', async () => {
    await openInstalledAppsPicker();
    const search = document.getElementById('app-picker-search');
    search.value = 'MissingApp';
    search.dispatchEvent(new Event('input'));
    document.querySelector('.app-picker-add-typed').click();
    document.getElementById('app-picker-cancel-btn').click();
    expect(window.modalApps).toEqual([]);
    expect(pushModalUndo).not.toHaveBeenCalled();
});

test.each(['isAndroid', 'isIOS'])('typed entries are unavailable on %s', async (platform) => {
    state[platform] = true;
    await openInstalledAppsPicker();
    const search = document.getElementById('app-picker-search');
    search.value = 'MissingApp';
    search.dispatchEvent(new Event('input'));
    expect(document.querySelector('.app-picker-add-typed')).toBeNull();
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(document.getElementById('app-picker-add-btn').disabled).toBe(true);
});
