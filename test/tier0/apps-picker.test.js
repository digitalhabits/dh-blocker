import { beforeEach, describe, expect, test, vi } from 'vitest';
import { canOfferTypedAppName, openInstalledAppsPicker } from '../../src/apps-picker.js';
import { state } from '../../src/state.js';
import { tauriAPI } from '../../src/tauri-api.js';

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

const row = (name) => document.querySelector(`#app-picker-list input[data-process="${name}"]`);
const browse = (names) => {
    tauriAPI.openAppPicker.mockResolvedValue(names);
    return document.getElementById('app-picker-browse-btn').onclick();
};

beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(tauriAPI, 'openAppPicker');
    document.body.classList.remove('windows');
    document.body.innerHTML = `
        <div id="app-picker-modal" class="hidden">
            <input id="app-picker-search">
            <div id="app-picker-list"></div>
            <button id="app-picker-browse-btn"></button>
            <button id="app-picker-cancel-btn"></button>
            <button id="app-picker-add-btn"></button>
        </div>`;
    state.isMacOSDesktop = false;
    state.installedAppsCache = [{ display_name: 'Slack', process_name: 'Slack' }];
    state.blocklistModalUndoStack = [];
    window.modalApps = [];
    window.renderModalTags = vi.fn();
});

test('a browsed macOS bundle ticks its installed executable exactly once', async () => {
    state.isMacOSDesktop = true;
    state.installedAppsCache.push({ display_name: 'Visual Studio Code', process_name: 'Code' });
    await openInstalledAppsPicker();
    row('Slack').click();
    await browse(['Visual Studio Code', 'visual studio code']);

    expect(row('Code').checked).toBe(true);
    expect(document.getElementById('app-picker-add-btn').textContent).toBe('Add Selected (2)');
    expect(window.modalApps).toEqual([]);
    document.getElementById('app-picker-add-btn').click();
    expect(window.modalApps).toEqual(['Slack', 'Code']);
    expect(state.blocklistModalUndoStack).toHaveLength(1);
    state.blocklistModalUndoStack.pop().undo();
    expect(window.modalApps).toEqual([]);
});

test('browsing matches Windows executable stems, even when a shortcut has the same label', async () => {
    state.installedAppsCache.push({ display_name: 'Contoso', process_name: 'ContosoLauncher' });
    await openInstalledAppsPicker();
    await browse(['Contoso', 'CONTOSO', 'contosolauncher']);

    expect(row('Contoso')?.checked).toBe(true);
    expect(row('ContosoLauncher').checked).toBe(true);
    expect(document.getElementById('app-picker-add-btn').textContent).toBe('Add Selected (2)');
    document.getElementById('app-picker-cancel-btn').click();
    expect(window.modalApps).toEqual([]);
    expect(state.blocklistModalUndoStack).toHaveLength(0);
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
