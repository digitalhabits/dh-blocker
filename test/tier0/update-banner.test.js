import { afterEach, beforeEach, expect, test, vi } from 'vitest';

// The app can stay open for days, so the banner's version goes stale. Pressing
// the button must install the newest release, and the timed re-check must not
// reopen a dismissed banner while still showing a newer release.

const tauriAPI = vi.hoisted(() => ({
    getAppVersion: vi.fn(async () => '3.7.0'),
    downloadAndRunUpdate: vi.fn(async () => {}),
    onUpdateDownloadProgress: vi.fn(async () => () => {}),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ message: vi.fn() }));
vi.mock('../../src/tauri-api.js', () => ({ tauriAPI, openUrl: vi.fn() }));
vi.mock('../../src/changelog.js', () => ({
    resolveReleaseNotesForVersion: async () => null,
    renderReleaseNotesHtml: () => '',
    releaseNotesHasContent: () => false,
    filterReleaseNotesForPlatform: (notes) => notes,
}));

import { showUpdateBanner, startUpdateDownload } from '../../src/update-banner.js';

const el = (id) => document.getElementById(id);

beforeEach(() => {
    document.body.innerHTML = `
        <div id="update-banner" class="hidden">
            <span id="update-banner-version"></span>
            <button id="update-banner-link"></button>
            <button id="update-banner-dismiss"></button>
        </div>`;
});

afterEach(() => {
    vi.unstubAllGlobals();
});

test('pressing the button installs the newest release, not the one the banner shows', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ windows: '3.11.0' }) })));
    await showUpdateBanner('3.10.1', '3.7.0');
    await startUpdateDownload('3.10.1');
    expect(el('update-banner-version').textContent).toBe('3.11.0');
    expect(tauriAPI.downloadAndRunUpdate).toHaveBeenCalledWith('3.11.0');
});

test('a dismissed banner stays hidden for that version but shows a newer one', async () => {
    await showUpdateBanner('3.10.1', '3.7.0');
    el('update-banner-dismiss').click();
    await showUpdateBanner('3.10.1', '3.7.0');
    expect(el('update-banner').classList.contains('hidden')).toBe(true);

    await showUpdateBanner('3.11.0', '3.7.0');
    expect(el('update-banner').classList.contains('hidden')).toBe(false);
    expect(el('update-banner-version').textContent).toBe('3.11.0');
});
