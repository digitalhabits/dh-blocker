// The allow-mode indicator window: a floating, always-on-top list of what
// the running allow-only focus spaces leave available. Desktop only; the
// window is created by src-tauri/src/allow_indicator.rs, which also derives
// the list from the same blocks enforcement reads. This page only draws it.
//
// Display only. It has no pause, stop or edit control and must not gain
// one: it floats over every app, so anything here is the easiest thing in
// the product to reach in a weak moment. The ✕ hides the window until the
// allow session ends and changes nothing about what is blocked.
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { SETTINGS_TRANSLATIONS } from './i18n.js';

/** Rows shown per section before "Show all". */
export const COLLAPSED_ROWS = 6;
const DRAG_THRESHOLD_PX = 4;

const view = {
    payload: null,
    expanded: false,
    showAll: { websites: false, apps: false },
    lastSize: '',
};

function languageOf(payload) {
    const saved = payload?.language;
    if (SETTINGS_TRANSLATIONS[saved]) return saved;
    const browser = (navigator.language || 'en').toLowerCase();
    if (browser.startsWith('zh')) return 'zh-CN';
    if (browser.startsWith('da')) return 'da';
    return 'en';
}

function translator(lang) {
    return (key, vars = {}) => {
        let text = SETTINGS_TRANSLATIONS[lang]?.[key] || SETTINGS_TRANSLATIONS.en[key] || key;
        for (const [name, value] of Object.entries(vars)) {
            text = text.split(`{${name}}`).join(String(value));
        }
        return text;
    };
}

const capitalise = (text) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * Everything the window says, as plain data. Pure, so the wording rules can
 * be tested without a DOM.
 */
export function describeIndicator(payload, lang = languageOf(payload)) {
    const t = translator(lang);
    const spaces = payload.spaces || [];
    const first = spaces[0] || {};
    const firstName = [first.emoji, first.name].filter(Boolean).join(' ') || t('allowIndicatorUnnamed');
    const title = spaces.length > 1
        ? t('allowIndicatorTitleMore', { name: firstName, n: spaces.length - 1 })
        : firstName;

    const count = (kind, all, items) => {
        if (all) return t(kind === 'websites' ? 'allowIndicatorCountAllWebsites' : 'allowIndicatorCountAllApps');
        const one = kind === 'websites' ? 'allowIndicatorCountWebsiteOne' : 'allowIndicatorCountAppOne';
        const many = kind === 'websites' ? 'allowIndicatorCountWebsites' : 'allowIndicatorCountApps';
        return items.length === 1 ? t(one) : t(many, { n: items.length });
    };
    const summary = capitalise(t('allowIndicatorSummary', {
        websites: count('websites', payload.allWebsites, payload.websites || []),
        apps: count('apps', payload.allApps, payload.apps || []),
    }));

    const section = (kind, all, items) => {
        const isWeb = kind === 'websites';
        let note = null;
        if (all) {
            // "All" is not literally all while a block-mode space also runs.
            note = payload.blocklistAlsoActive
                ? t(isWeb ? 'allowIndicatorAllWebsitesExcept' : 'allowIndicatorAllAppsExcept')
                : t(isWeb ? 'allowIndicatorAllWebsites' : 'allowIndicatorAllApps');
        } else if (items.length === 0) {
            // Listed, but another space blocks every one of them.
            note = t(isWeb ? 'allowIndicatorNoWebsitesLeft' : 'allowIndicatorNoAppsLeft');
        }
        return {
            kind,
            heading: t(isWeb ? 'allowIndicatorWebsitesHeading' : 'allowIndicatorAppsHeading'),
            note,
            items: note ? [] : items,
        };
    };

    let footer = t('allowIndicatorFooter');
    if (payload.endsAt) {
        const time = new Date(payload.endsAt).toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' });
        footer = t('allowIndicatorFooterUntil', { time });
    }

    return {
        title,
        summary,
        color: first.color || null,
        sections: [
            section('websites', payload.allWebsites, payload.websites || []),
            section('apps', payload.allApps, payload.apps || []),
        ],
        footer,
        labels: {
            expand: t('allowIndicatorExpand'),
            collapse: t('allowIndicatorCollapse'),
            dismiss: t('allowIndicatorDismiss'),
            showAll: (n) => t('allowIndicatorShowAll', { n }),
            showFewer: t('allowIndicatorShowFewer'),
        },
    };
}

function applyTheme(themeMode) {
    const dark = themeMode === 'dark'
        || (themeMode !== 'light' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark-mode', !!dark);
}

function render() {
    const root = document.getElementById('indicator');
    const payload = view.payload;
    if (!root) return;
    if (!payload || !payload.active) {
        root.hidden = true;
        return;
    }
    const lang = languageOf(payload);
    document.documentElement.lang = lang;
    applyTheme(payload.themeMode);
    const d = describeIndicator(payload, lang);

    root.hidden = false;
    root.classList.toggle('is-expanded', view.expanded);
    root.classList.toggle('is-collapsed', !view.expanded);
    document.getElementById('indicator-title').textContent = d.title;
    document.getElementById('indicator-summary').textContent = d.summary;
    document.getElementById('indicator-dot').style.background = d.color || '';
    document.getElementById('indicator-bar').title = `${d.title} · ${d.summary}`;

    const toggle = document.getElementById('indicator-toggle');
    toggle.setAttribute('aria-expanded', String(view.expanded));
    toggle.setAttribute('aria-label', view.expanded ? d.labels.collapse : d.labels.expand);
    toggle.title = view.expanded ? d.labels.collapse : d.labels.expand;
    const dismiss = document.getElementById('indicator-dismiss');
    dismiss.setAttribute('aria-label', d.labels.dismiss);
    dismiss.title = d.labels.dismiss;

    for (const section of d.sections) {
        const el = root.querySelector(`.indicator-section[data-kind="${section.kind}"]`);
        el.querySelector('.indicator-heading').textContent = section.heading;
        const list = el.querySelector('.indicator-list');
        const more = el.querySelector('.indicator-more');
        list.replaceChildren();
        if (section.note) {
            const li = document.createElement('li');
            li.className = 'is-note';
            li.textContent = section.note;
            list.append(li);
            more.hidden = true;
            continue;
        }
        const all = view.showAll[section.kind];
        // One hidden row is not worth a button: show it instead.
        const fits = section.items.length <= COLLAPSED_ROWS + 1;
        const shown = all || fits ? section.items : section.items.slice(0, COLLAPSED_ROWS);
        for (const item of shown) {
            const li = document.createElement('li');
            li.textContent = item;
            li.title = item;
            list.append(li);
        }
        more.hidden = fits;
        more.textContent = all ? d.labels.showFewer : d.labels.showAll(section.items.length);
    }
    document.getElementById('indicator-footer').textContent = d.footer;
    syncWindowSize();
}

/** Ask the window to fit the card. Rust keeps the bottom-right corner put. */
function syncWindowSize() {
    const root = document.getElementById('indicator');
    if (!root || root.hidden) return;
    const rect = root.getBoundingClientRect();
    const width = Math.ceil(rect.width);
    const height = Math.ceil(rect.height);
    const key = `${width}x${height}`;
    if (!width || !height || key === view.lastSize) return;
    view.lastSize = key;
    invoke('allow_indicator_set_size', { width, height }).catch(() => { view.lastSize = ''; });
}

function setPayload(payload) {
    view.payload = payload;
    render();
}

function setExpanded(expanded) {
    view.expanded = expanded;
    if (!expanded) view.showAll = { websites: false, apps: false };
    render();
}

/**
 * The bar drags the window; a press that does not move toggles the list.
 * The move is done in Rust from the pointer's screen delta (see
 * `allow_indicator_move_by` for why not `startDragging`).
 */
function wireBar() {
    const bar = document.getElementById('indicator-bar');
    let press = null;
    bar.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 || event.target.closest('button')) return;
        press = { startX: event.screenX, startY: event.screenY, x: event.screenX, y: event.screenY, dragged: false };
        // Keep receiving moves when the pointer outruns the window.
        bar.setPointerCapture?.(event.pointerId);
    });
    bar.addEventListener('pointermove', (event) => {
        if (!press) return;
        if (!press.dragged
            && Math.hypot(event.screenX - press.startX, event.screenY - press.startY) < DRAG_THRESHOLD_PX) return;
        press.dragged = true;
        const dx = event.screenX - press.x;
        const dy = event.screenY - press.y;
        if (!dx && !dy) return;
        press.x = event.screenX;
        press.y = event.screenY;
        invoke('allow_indicator_move_by', { dx, dy }).catch(() => {});
    });
    bar.addEventListener('pointerup', (event) => {
        const wasClick = press && !press.dragged;
        press = null;
        bar.releasePointerCapture?.(event.pointerId);
        if (wasClick) setExpanded(!view.expanded);
    });
    bar.addEventListener('pointercancel', () => { press = null; });
}

async function init() {
    document.documentElement.style.setProperty(
        '--indicator-max-height',
        `${Math.max(200, Math.floor((window.screen?.availHeight || 800) * 0.8))}px`,
    );
    wireBar();
    document.getElementById('indicator-toggle').addEventListener('click', () => setExpanded(!view.expanded));
    document.getElementById('indicator-dismiss').addEventListener('click', () => {
        invoke('allow_indicator_dismiss').catch(() => {});
    });
    for (const section of document.querySelectorAll('.indicator-section')) {
        section.querySelector('.indicator-more').addEventListener('click', () => {
            const kind = section.dataset.kind;
            view.showAll[kind] = !view.showAll[kind];
            render();
        });
    }
    document.addEventListener('contextmenu', (event) => event.preventDefault());
    window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', render);
    // Fonts arriving change the measured width.
    document.fonts?.ready?.then(() => { view.lastSize = ''; syncWindowSize(); });

    // For the screenshot script (scripts/ui/shoot-allow-indicator.mjs).
    // Display state only: nothing here reaches enforcement.
    window.__ALLOW_INDICATOR__ = { setPayload, setExpanded, showAll: (kind) => { view.showAll[kind] = true; render(); } };

    try {
        await listen('allow-indicator-state', (event) => setPayload(event.payload));
        // Hidden (dismissed, paused, ended): come back as the small pill.
        await listen('allow-indicator-reset', () => setExpanded(false));
        setPayload(await invoke('allow_indicator_state'));
    } catch (error) {
        console.warn('[allow-indicator] could not read state:', error);
    }
}

function start() {
    // Only on the indicator page itself; Tier 0 imports this module for
    // `describeIndicator` with no such element.
    if (document.getElementById('indicator')) init();
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
}
