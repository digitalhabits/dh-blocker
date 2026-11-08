import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('../../src/app.js', () => ({ pushModalUndo: vi.fn() }));
vi.mock('../../src/tauri-api.js', () => ({ tauriAPI: { showActivityPicker: vi.fn() } }));

import { pushModalUndo } from '../../src/app.js';
import { installFocusSpaceTagBridges, setupFocusSpaceTagEditors } from '../../src/focus-space-tags.js';
import { state } from '../../src/state.js';
import { tauriAPI } from '../../src/tauri-api.js';

function wireTags() {
    installFocusSpaceTagBridges(setupFocusSpaceTagEditors());
}

function keydown(input, key, options = {}) {
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options }));
}

beforeEach(() => {
    pushModalUndo.mockClear();
    state.isIOS = false;
    state.editingBlocklistId = null;
    window.lockLastItems = false;
    document.body.innerHTML = `
        <div id="blocklist-modal">
            <input id="blocklist-name">
            <input id="modal-website-input">
            <div id="modal-websites-tags"></div>
            <input id="modal-app-input">
            <div id="modal-apps-tags"></div>
            <button id="modal-browse-apps-btn"></button>
        </div>`;
});

test('keyboard navigation skips locked tags and Escape clears the selection locally', () => {
    wireTags();
    window.setModalData(['example.com', 'locked.example', 'example.org'], [], null, ['locked.example']);
    const input = document.getElementById('modal-website-input');
    const selected = () => document.querySelector('#modal-websites-tags .tag.selected')?.textContent.trim();
    keydown(input, 'ArrowLeft');
    expect(selected()).toContain('example.org');
    keydown(input, 'ArrowLeft');
    expect(selected()).toContain('example.com');

    const outsideModal = vi.fn();
    document.body.addEventListener('keydown', outsideModal, { once: true });
    keydown(input, 'Escape');
    expect(selected()).toBeUndefined();
    expect(outsideModal).not.toHaveBeenCalled();
    keydown(input, 'Escape');
    expect(outsideModal).toHaveBeenCalledOnce();
});

test('bulk deletion retains the last allowed website and app and records one undo for each field', () => {
    wireTags();
    const sharedApps = window.modalApps;
    const sharedWebsites = window.getModalWebsites();
    window.setModalData(['one.example', 'two.example', 'three.example'], ['One', 'Two', 'Three']);
    window.lockLastItems = true;

    for (const inputId of ['modal-website-input', 'modal-app-input']) {
        const input = document.getElementById(inputId);
        keydown(input, 'a', { ctrlKey: true });
        keydown(input, 'Backspace');
        keydown(input, 'Backspace');
    }

    expect(window.getModalApps()).toBe(sharedApps);
    expect(window.getModalWebsites()).toBe(sharedWebsites);
    expect(sharedWebsites).toEqual(['three.example']);
    expect(sharedApps).toEqual(['Three']);
    expect(pushModalUndo.mock.calls.map(([type]) => type)).toEqual(['website-bulk', 'app-bulk']);
    for (const [, undo] of pushModalUndo.mock.calls) undo();
    expect(sharedWebsites).toEqual(['three.example', 'one.example', 'two.example']);
    expect(sharedApps).toEqual(['Three', 'One', 'Two']);

    window.setModalData([], []);
    expect(window.modalApps).toBe(sharedApps);
    expect(sharedApps).toEqual([]);
});

test('Screen Time selection retains the persisted tokens if enforcement begins with the picker open', async () => {
    state.isIOS = true;
    state.editingBlocklistId = 'edited';
    state.appData = {
        blocklists: [{ id: 'edited', iosScreenTimeSelection: { applicationTokens: ['saved'] } }],
        activeBlocks: [],
    };
    wireTags();
    window.setModalData([], [], { applicationTokens: ['saved', 'unsaved'] });

    let finishPicker;
    tauriAPI.showActivityPicker.mockImplementationOnce(() => new Promise(resolve => { finishPicker = resolve; }));
    document.getElementById('modal-browse-apps-btn').click();

    const now = Date.now();
    state.appData.activeBlocks.push({ blocklistId: 'edited', startTime: now - 1000, endTime: now + 60_000 });
    finishPicker({ cancelled: false, applicationCount: 1, applicationTokens: ['picked'] });

    await vi.waitFor(() => {
        expect(window.getModalIOSScreenTimeSelection().applicationTokens).toEqual(['saved', 'picked']);
    });
});
