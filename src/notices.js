// Remote notices: a way to tell users about a problem with the app without
// shipping a release, for when the problem is that a release cannot reach
// them (an updater that fails until the user logs out, say).
//
// The app fetches docs/notices.json from GitHub Pages, the same host as
// latest-versions.json, at startup and hourly, and shows every applicable
// notice as a banner, most severe first. A notice is matched by platform, by app version range and by a
// time window; `expiresAt` is required, so a notice nobody remembers to take
// down still goes away. The schema, and how to publish one, is in
// docs/notices.md.
//
// Failures fall towards showing nothing. A fetch or parse failure, an entry
// that does not validate, or an unparseable date hides that notice; a notice
// already on screen stays until it expires or a later fetch drops it. A notice
// is display-only: nothing in it reaches blocking, schedules or settings, so
// whoever can edit the file can put words in front of users and no more.
//
// The fetch is the webview's own `fetch`, not the Rust updater's HTTP client,
// so a fault in the update download path does not also silence the notice
// about it.
import { tauriAPI, openUrl } from './tauri-api.js';
import { getSettingsLanguage } from './i18n.js';
import { formatChangelogInlineHtml } from './changelog.js';
import { isVersionHigher, getLatestVersionPlatformKey } from './update-banner.js';

export const NOTICES_URL = 'https://digitalhabits.github.io/dh-blocker/notices.json';
const DISMISSED_KEY = 'dismissedNotices';
const CHECK_INTERVAL_MS = 60 * 60_000;
const REFOCUS_MIN_GAP_MS = 15 * 60_000;
const SEVERITY_RANK = { critical: 3, warning: 2, info: 1 };
const PLATFORMS = ['macos', 'windows', 'ios'];

let lastCheckAt = 0;
let started = false;
let currentNotices = [];
let currentContext = null;

function parseTime(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
}

function isVersionString(value) {
    return typeof value === 'string' && /^\d+(\.\d+)*$/.test(value.trim());
}

/** `text` is a string or `{ en, da, 'zh-CN' }`; English is the fallback. */
export function localizedText(text, language) {
    if (typeof text === 'string') return text;
    if (!text || typeof text !== 'object') return '';
    const value = text[language] ?? text.en;
    return typeof value === 'string' ? value : '';
}

/**
 * Check one manifest entry and return it normalised, or null if it must not
 * be shown. Anything malformed is dropped rather than guessed at: a notice is
 * only worth showing if it says what its author meant.
 */
export function normalizeNotice(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    if (!id) return null;
    if (!localizedText(raw.title, 'en').trim()) return null;

    const expiresAt = parseTime(raw.expiresAt);
    if (expiresAt === null) return null;
    let startsAt = null;
    if (raw.startsAt !== undefined) {
        startsAt = parseTime(raw.startsAt);
        if (startsAt === null) return null;
    }

    let platforms = null;
    if (raw.platforms !== undefined) {
        if (!Array.isArray(raw.platforms)) return null;
        platforms = raw.platforms.filter((p) => PLATFORMS.includes(p));
        if (!platforms.length) return null;
    }
    for (const key of ['minVersion', 'maxVersion']) {
        if (raw[key] !== undefined && !isVersionString(raw[key])) return null;
    }

    let link = null;
    if (raw.link !== undefined) {
        const url = typeof raw.link?.url === 'string' ? raw.link.url.trim() : '';
        if (!/^https:\/\//i.test(url) || !raw.link.label) return null;
        link = { url, label: raw.link.label };
    }

    return {
        id,
        severity: SEVERITY_RANK[raw.severity] ? raw.severity : 'info',
        title: raw.title,
        body: raw.body ?? '',
        platforms,
        minVersion: raw.minVersion?.trim() ?? null,
        maxVersion: raw.maxVersion?.trim() ?? null,
        startsAt,
        expiresAt,
        link,
        dismissible: raw.dismissible !== false,
    };
}

/** Whether a normalised notice applies to this install right now. */
export function noticeApplies(notice, { platform, version, now }) {
    if (notice.platforms && !notice.platforms.includes(platform)) return false;
    if (now >= notice.expiresAt) return false;
    if (notice.startsAt !== null && now < notice.startsAt) return false;
    // Ranges are inclusive. A version we could not read matches only notices
    // with no version bound: we cannot tell whether a bound covers it.
    if (notice.minVersion || notice.maxVersion) {
        if (!version) return false;
        if (notice.minVersion && isVersionHigher(notice.minVersion, version)) return false;
        if (notice.maxVersion && isVersionHigher(version, notice.maxVersion)) return false;
    }
    return true;
}

/**
 * The notices to show, most severe first; notices of equal severity keep
 * their order in the file. Every applicable notice that has not been
 * dismissed is shown, so one that cannot be closed never hides another.
 */
export function selectNotices(notices, context, dismissedIds = []) {
    return notices
        .filter((n) => noticeApplies(n, context) && !(n.dismissible && dismissedIds.includes(n.id)))
        .map((n, i) => [n, i])
        .sort(([a, i], [b, j]) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || i - j)
        .map(([n]) => n);
}

export function parseNoticesManifest(manifest) {
    const list = Array.isArray(manifest?.notices) ? manifest.notices : [];
    return list.map(normalizeNotice).filter(Boolean);
}

function readDismissed() {
    try {
        const ids = JSON.parse(localStorage.getItem(DISMISSED_KEY) || '[]');
        return Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : [];
    } catch {
        return [];
    }
}

function writeDismissed(ids) {
    try {
        localStorage.setItem(DISMISSED_KEY, JSON.stringify(ids));
    } catch {
        /* storage unavailable: the dismissal lasts until the next restart */
    }
}

let sessionDismissed = [];

function dismissedIds() {
    return [...new Set([...readDismissed(), ...sessionDismissed])];
}

function fillBanner(banner, notice, language) {
    banner.dataset.noticeId = notice.id;
    banner.dataset.severity = notice.severity;
    banner.setAttribute('role', notice.severity === 'info' ? 'status' : 'alert');
    banner.querySelector('.notice-banner-title').textContent = localizedText(notice.title, language);

    const bodyEl = banner.querySelector('.notice-banner-body');
    const body = localizedText(notice.body, language);
    // Escapes everything, then allows **bold**, *italics* and http(s)/mailto links.
    bodyEl.innerHTML = body ? formatChangelogInlineHtml(body) : '';
    bodyEl.classList.toggle('hidden', !body);

    const linkEl = banner.querySelector('.notice-banner-link');
    if (notice.link) {
        linkEl.textContent = localizedText(notice.link.label, language);
        linkEl.href = notice.link.url;
        linkEl.dataset.externalUrl = notice.link.url;
    } else {
        linkEl.textContent = '';
        linkEl.removeAttribute('href');
        delete linkEl.dataset.externalUrl;
    }
    linkEl.closest('.setup-banner-actions-row').classList.toggle('hidden', !notice.link);
    banner.querySelector('.notice-banner-dismiss').classList.toggle('hidden', !notice.dismissible);
}

/**
 * Open a notice's links (in the body, and the button) in the system browser
 * on every platform. Desktop has no app-wide handler for target=_blank, and
 * a link in an emergency notice must not depend on the web view's default.
 * iOS's app-wide handler runs first, in the capture phase, and stops the
 * event, so a link is never opened twice.
 */
function openNoticeLink(event) {
    const anchor = event.target.closest?.('a[href]');
    if (!anchor) return;
    const url = anchor.dataset.externalUrl || anchor.getAttribute('href');
    if (!/^(https?:\/\/|mailto:)/i.test(url || '')) return;
    event.preventDefault();
    Promise.resolve()
        .then(() => openUrl(url))
        .catch((err) => {
            console.warn('[Notices] opener failed, falling back to window.open:', err);
            window.open(url, '_blank', 'noopener,noreferrer');
        });
}

/**
 * Show exactly `notices`, in order. Each banner is a clone of
 * #notice-banner-template inserted just before it, so the banners are
 * siblings of the update and setup banners and the stacking rules in
 * styles.css apply to them. A banner already on screen is updated in place
 * rather than rebuilt, so the hourly check does not replay its slide-in.
 */
export function renderNotices(notices) {
    const template = document.getElementById('notice-banner-template');
    if (!template?.parentNode) return;
    const parent = template.parentNode;
    const language = getSettingsLanguage();
    const existing = new Map(
        [...parent.querySelectorAll(':scope > .notice-banner')].map((el) => [el.dataset.noticeId, el]),
    );
    const banners = notices.map((notice) => {
        let banner = existing.get(notice.id);
        existing.delete(notice.id);
        if (!banner) {
            banner = template.content.firstElementChild.cloneNode(true);
            const id = notice.id;
            banner.querySelector('.notice-banner-dismiss').addEventListener('click', () => dismissNotice(id));
            banner.addEventListener('click', openNoticeLink);
        }
        fillBanner(banner, notice, language);
        return banner;
    });
    for (const stale of existing.values()) stale.remove();
    // Place them back to front, each just before its successor. A banner
    // already in place is not moved: re-inserting it would replay its slide-in.
    let next = template;
    for (let i = banners.length - 1; i >= 0; i--) {
        if (banners[i].nextElementSibling !== next) parent.insertBefore(banners[i], next);
        next = banners[i];
    }
}

function refresh(now = Date.now()) {
    if (!currentContext) return;
    renderNotices(selectNotices(currentNotices, { ...currentContext, now }, dismissedIds()));
}

export function dismissNotice(id) {
    if (!id) return;
    sessionDismissed.push(id);
    // Keep only ids still in the manifest, so the stored list does not grow forever.
    const live = new Set(currentNotices.map((n) => n.id));
    writeDismissed(dismissedIds().filter((d) => live.has(d)));
    refresh();
}

export async function checkForNotices() {
    lastCheckAt = Date.now();
    try {
        if (!currentContext) {
            let version = '';
            try {
                version = String((await tauriAPI.getAppVersion()) || '').trim();
            } catch {
                /* version-bound notices are skipped, unbound ones still show */
            }
            currentContext = { platform: getLatestVersionPlatformKey(), version };
        }
        const response = await fetch(`${NOTICES_URL}?t=${Date.now()}`, { credentials: 'omit' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        currentNotices = parseNoticesManifest(await response.json());
    } catch (e) {
        // Keep what we had: a notice already shown stays until it expires.
        console.log('[Notices] Could not check for notices:', e?.message || e);
    }
    refresh();
}

/** Check now, hourly, and when the window comes back after a while away. */
export function startNotices() {
    if (started) return;
    started = true;
    void checkForNotices();
    setInterval(() => void checkForNotices(), CHECK_INTERVAL_MS);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        if (Date.now() - lastCheckAt >= REFOCUS_MIN_GAP_MS) void checkForNotices();
        else refresh();
    });
}

/** Tests only: forget module state between cases. */
export function resetNoticesForTests() {
    lastCheckAt = 0;
    started = false;
    currentNotices = [];
    currentContext = null;
    sessionDismissed = [];
}
