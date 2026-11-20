import { afterEach, beforeEach, expect, test, vi } from 'vitest';

// Remote notices tell users about a broken release without shipping one, so
// the parts that decide who sees what must be right the first time: a notice
// that misses its versions, outlives its window, or is silently dropped for a
// typo fails exactly when it is needed.

const tauriAPI = vi.hoisted(() => ({ getAppVersion: vi.fn(async () => '3.13.0') }));
vi.mock('../../src/tauri-api.js', () => ({ tauriAPI }));
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
    dismissCurrentNotice,
    normalizeNotice,
    noticeApplies,
    parseNoticesManifest,
    resetNoticesForTests,
    selectNotice,
} from '../../src/notices.js';

const NOW = Date.parse('2026-11-20T12:00:00Z');
const base = {
    id: 'n1',
    title: 'Updates are failing',
    expiresAt: '2026-12-01T00:00:00Z',
};
const ctx = { platform: 'macos', version: '3.13.0', now: NOW };
const applies = (raw, context = ctx) => noticeApplies(normalizeNotice(raw), context);

const el = (id) => document.getElementById(id);

beforeEach(() => {
    resetNoticesForTests();
    localStorage.clear();
    document.body.innerHTML = `
        <div id="notice-banner" class="hidden">
            <strong id="notice-banner-title"></strong>
            <span id="notice-banner-body"></span>
            <div class="setup-banner-actions-row"><a id="notice-banner-link" class="hidden"></a></div>
            <button id="notice-banner-dismiss"></button>
        </div>`;
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

test('the most severe applicable notice wins; a dismissed one gives way to the next', () => {
    const notices = parseNoticesManifest({
        notices: [
            { ...base, id: 'info', severity: 'info' },
            { ...base, id: 'crit', severity: 'critical' },
            { ...base, id: 'warn', severity: 'warning' },
        ],
    });
    expect(selectNotice(notices, ctx).id).toBe('crit');
    expect(selectNotice(notices, ctx, ['crit']).id).toBe('warn');
});

test('a non-dismissible notice ignores a stored dismissal and hides its close button', async () => {
    localStorage.setItem('dismissedNotices', JSON.stringify(['n1']));
    serve([{ ...base, dismissible: false }]);
    await checkForNotices();
    expect(el('notice-banner').classList.contains('hidden')).toBe(false);
    expect(el('notice-banner-dismiss').classList.contains('hidden')).toBe(true);
});

test('title and body are escaped; only the body gets inline links', async () => {
    serve([{ ...base, title: '<img src=x onerror=alert(1)>', body: '<b>x</b> [help](https://example.org/h)' }]);
    await checkForNotices();
    expect(el('notice-banner-title').textContent).toBe('<img src=x onerror=alert(1)>');
    expect(el('notice-banner-body').querySelector('b')).toBeNull();
    expect(el('notice-banner-body').querySelector('a').getAttribute('href')).toBe('https://example.org/h');
});

test('dismissal persists, and a failed later fetch keeps the shown notice', async () => {
    serve([{ ...base, id: 'a' }, { ...base, id: 'b', severity: 'warning' }]);
    await checkForNotices();
    expect(el('notice-banner').dataset.noticeId).toBe('b');

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await checkForNotices();
    expect(el('notice-banner').dataset.noticeId).toBe('b');

    dismissCurrentNotice();
    expect(el('notice-banner').dataset.noticeId).toBe('a');
    expect(JSON.parse(localStorage.getItem('dismissedNotices'))).toEqual(['b']);
});

test('localized title falls back to English', async () => {
    serve([{ ...base, title: { en: 'Broken', 'zh-CN': '坏了' } }]);
    await checkForNotices();
    expect(el('notice-banner-title').textContent).toBe('Broken');
});
