import { afterEach, beforeEach, expect, test, vi } from 'vitest';

// Remote notices tell users about a broken release without shipping one, so
// the parts that decide who sees what must be right the first time: a notice
// that misses its versions, outlives its window, or is silently dropped for a
// typo fails exactly when it is needed.

const tauriAPI = vi.hoisted(() => ({ getAppVersion: vi.fn(async () => '3.13.0') }));
const openUrl = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../../src/tauri-api.js', () => ({ tauriAPI, openUrl }));
vi.mock('../../src/update-banner.js', () => ({
    getLatestVersionPlatformKey: () => 'macos',
    isVersionHigher: (a, b) => {
        const pa = a.split('.').map(Number);
        const pb = b.split('.').map(Number);
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
            if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
        }
        return false;
    },
}));

import publishedNotices from '../../docs/notices.json?raw';
import {
    checkForNotices,
    dismissNotice,
    normalizeNotice,
    noticeApplies,
    parseNoticesManifest,
    resetNoticesForTests,
    selectNotices,
} from '../../src/notices.js';

const NOW = Date.parse('2026-11-20T12:00:00Z');
const base = {
    id: 'n1',
    title: 'Updates are failing',
    expiresAt: '2026-12-01T00:00:00Z',
};
const ctx = { platform: 'macos', version: '3.13.0', now: NOW };
const applies = (raw, context = ctx) => noticeApplies(normalizeNotice(raw), context);

const shown = () => [...document.querySelectorAll('.notice-banner')];
const shownIds = () => shown().map((b) => b.dataset.noticeId);

beforeEach(() => {
    resetNoticesForTests();
    localStorage.clear();
    document.body.innerHTML = `
        <div id="update-banner"></div>
        <template id="notice-banner-template">
            <div class="notice-banner setup-banner">
                <strong class="notice-banner-title"></strong>
                <span class="notice-banner-body"></span>
                <div class="setup-banner-actions-row"><a class="notice-banner-link"></a></div>
                <button class="notice-banner-dismiss"></button>
            </div>
        </template>
        <div id="behaviour-change-banner"></div>`;
});

afterEach(() => {
    vi.unstubAllGlobals();
});

const serve = (notices) => vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ notices }) })));

test('the published docs/notices.json parses, and every entry in it is valid', () => {
    const manifest = JSON.parse(publishedNotices);
    expect(Array.isArray(manifest.notices)).toBe(true);
    for (const raw of manifest.notices) {
        expect(normalizeNotice(raw), `notice ${JSON.stringify(raw?.id)} is invalid and would never show`).not.toBeNull();
    }
});

test('a notice without an expiry, or with an unreadable date, is dropped', () => {
    expect(normalizeNotice({ ...base, expiresAt: undefined })).toBeNull();
    expect(normalizeNotice({ ...base, expiresAt: 'next week' })).toBeNull();
    expect(normalizeNotice({ ...base, startsAt: 'soon' })).toBeNull();
    expect(normalizeNotice({ ...base, id: '' })).toBeNull();
    expect(normalizeNotice({ ...base, title: '' })).toBeNull();
});

test('a typo in platforms, versions or link drops the notice rather than widening it', () => {
    expect(normalizeNotice({ ...base, platforms: ['mac'] })).toBeNull();
    expect(normalizeNotice({ ...base, platforms: 'macos' })).toBeNull();
    expect(normalizeNotice({ ...base, maxVersion: 'v3.13' })).toBeNull();
    expect(normalizeNotice({ ...base, link: { label: 'Help', url: 'http://example.org' } })).toBeNull();
    expect(normalizeNotice({ ...base, link: { label: 'Help', url: 'javascript:alert(1)' } })).toBeNull();
});

test('the version range is inclusive at both ends', () => {
    const ranged = { ...base, minVersion: '3.12.0', maxVersion: '3.13.0' };
    expect(applies(ranged, { ...ctx, version: '3.12.0' })).toBe(true);
    expect(applies(ranged, { ...ctx, version: '3.13.0' })).toBe(true);
    expect(applies(ranged, { ...ctx, version: '3.11.9' })).toBe(false);
    expect(applies(ranged, { ...ctx, version: '3.13.1' })).toBe(false);
});

test('an unknown app version sees only notices with no version bound', () => {
    expect(applies(base, { ...ctx, version: '' })).toBe(true);
    expect(applies({ ...base, maxVersion: '3.13.0' }, { ...ctx, version: '' })).toBe(false);
});

test('a notice shows only inside its time window and on its platforms', () => {
    expect(applies({ ...base, expiresAt: '2026-11-20T12:00:00Z' })).toBe(false);
    expect(applies({ ...base, startsAt: '2026-11-21T00:00:00Z' })).toBe(false);
    expect(applies({ ...base, platforms: ['windows'] })).toBe(false);
    expect(applies({ ...base, platforms: ['windows', 'macos'] })).toBe(true);
});

test('every applicable notice shows, most severe first, file order breaking ties', () => {
    const notices = parseNoticesManifest({
        notices: [
            { ...base, id: 'info', severity: 'info' },
            { ...base, id: 'warn-1', severity: 'warning' },
            { ...base, id: 'crit', severity: 'critical' },
            { ...base, id: 'warn-2', severity: 'warning' },
            { ...base, id: 'other-platform', severity: 'critical', platforms: ['windows'] },
        ],
    });
    expect(selectNotices(notices, ctx).map((n) => n.id)).toEqual(['crit', 'warn-1', 'warn-2', 'info']);
    expect(selectNotices(notices, ctx, ['crit', 'info']).map((n) => n.id)).toEqual(['warn-1', 'warn-2']);
});

test('a notice that cannot be closed does not hide the others', async () => {
    serve([
        { ...base, id: 'stuck', severity: 'critical', dismissible: false },
        { ...base, id: 'later', severity: 'info' },
    ]);
    await checkForNotices();
    expect(shownIds()).toEqual(['stuck', 'later']);
    expect(shown()[0].querySelector('.notice-banner-dismiss').classList.contains('hidden')).toBe(true);
    expect(shown()[1].querySelector('.notice-banner-dismiss').classList.contains('hidden')).toBe(false);
});

test('banners sit between the update banner and the setup banner, as siblings', async () => {
    serve([{ ...base, id: 'a' }, { ...base, id: 'b' }]);
    await checkForNotices();
    const order = [...document.body.children].map((e) => e.id || e.dataset.noticeId);
    expect(order).toEqual(['update-banner', 'a', 'b', 'notice-banner-template', 'behaviour-change-banner']);
});

test('a re-check leaves banners on screen in place, so they do not slide in again', async () => {
    serve([{ ...base, id: 'a' }, { ...base, id: 'b', severity: 'warning' }]);
    await checkForNotices();
    const [warning, info] = shown();
    serve([{ ...base, id: 'a', title: 'Edited' }, { ...base, id: 'b', severity: 'warning' }]);
    await checkForNotices();
    const [warningAfter, infoAfter] = shown();
    expect(warningAfter).toBe(warning);
    expect(infoAfter).toBe(info);
    expect(info.querySelector('.notice-banner-title').textContent).toBe('Edited');
});

test('a non-dismissible notice ignores a stored dismissal', async () => {
    localStorage.setItem('dismissedNotices', JSON.stringify(['n1']));
    serve([{ ...base, dismissible: false }]);
    await checkForNotices();
    expect(shownIds()).toEqual(['n1']);
});

test('title and body are escaped; only the body gets inline links', async () => {
    serve([{ ...base, title: '<img src=x onerror=alert(1)>', body: '<b>x</b> [help](https://example.org/h)' }]);
    await checkForNotices();
    const [banner] = shown();
    expect(banner.querySelector('.notice-banner-title').textContent).toBe('<img src=x onerror=alert(1)>');
    expect(banner.querySelector('.notice-banner-body b')).toBeNull();
    expect(banner.querySelector('.notice-banner-body a').getAttribute('href')).toBe('https://example.org/h');
});

test('closing one banner removes only it, and the dismissal persists', async () => {
    serve([{ ...base, id: 'a' }, { ...base, id: 'b', severity: 'warning' }]);
    await checkForNotices();
    expect(shownIds()).toEqual(['b', 'a']);

    shown()[0].querySelector('.notice-banner-dismiss').click();
    expect(shownIds()).toEqual(['a']);
    expect(JSON.parse(localStorage.getItem('dismissedNotices'))).toEqual(['b']);

    dismissNotice('a');
    expect(shownIds()).toEqual([]);
});

test('a failed later fetch keeps the banners already shown', async () => {
    serve([{ ...base, id: 'a' }]);
    await checkForNotices();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await checkForNotices();
    expect(shownIds()).toEqual(['a']);
});

test('a notice dropped from the file disappears on the next check', async () => {
    serve([{ ...base, id: 'a' }, { ...base, id: 'b' }]);
    await checkForNotices();
    serve([{ ...base, id: 'b' }]);
    await checkForNotices();
    expect(shownIds()).toEqual(['b']);
});

test('body links and the button open in the system browser, not the web view', async () => {
    serve([{
        ...base,
        body: 'See [the status page](https://example.org/status).',
        link: { label: 'Get the installer', url: 'https://example.org/dl' },
    }]);
    await checkForNotices();
    const [banner] = shown();
    for (const [anchor, url] of [
        [banner.querySelector('.notice-banner-body a'), 'https://example.org/status'],
        [banner.querySelector('.notice-banner-link'), 'https://example.org/dl'],
    ]) {
        const event = new MouseEvent('click', { bubbles: true, cancelable: true });
        anchor.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
        await Promise.resolve();
        expect(openUrl).toHaveBeenLastCalledWith(url);
    }
});

test('localized title falls back to English', async () => {
    serve([{ ...base, title: { en: 'Broken', 'zh-CN': '坏了' } }]);
    await checkForNotices();
    expect(shown()[0].querySelector('.notice-banner-title').textContent).toBe('Broken');
});
