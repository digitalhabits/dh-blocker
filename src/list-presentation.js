// Shared list display/meta helpers for blocklist and allowlist focus spaces.
// Extracted from app.js during allowlist-refactoring phase 1.
import { escapeHtml, cleanUrlForDisplay } from './utils.js';
import { getSettingsLanguage, tSettings, tSettingsFmt } from './i18n.js';
import {
    normalizeIOSScreenTimeSelection,
    getBlocklistRegularApps,
    getBlocklistIOSScreenTimeSelection,
    formatIOSScreenTimeSelectionLabel,
} from './blocklist-utils.js';
import { displayNameForBlockedApp } from './blocking-platform.js';
import { isBlocklistAllowlistMode } from './list-mode.js';

/**
 * Mode-aware item count an iOS Screen Time selection contributes to
 * "Blocks {n}" / "Allows {n}". Every app token counts individually;
 * allow-mode selections store category picks already expanded into app tokens.
 */
export function countIOSScreenTimeSelectionItems(selection, allowMode) {
    const normalized = normalizeIOSScreenTimeSelection(selection);
    if (!normalized) return 0;
    const appCount = normalized.applicationCount || 0;
    return allowMode ? appCount : appCount + (normalized.categoryCount || 0);
}

export function getBlocklistDisplayApps(blocklist) {
    const apps = getBlocklistRegularApps(blocklist).map(displayNameForBlockedApp);
    const screenTimeLabel = formatIOSScreenTimeSelectionLabel(getBlocklistIOSScreenTimeSelection(blocklist));
    if (screenTimeLabel) {
        apps.push(screenTimeLabel);
    }
    return apps;
}

export function websiteWord(count) {
    if (getSettingsLanguage() === 'zh-CN') {
        return '网站';
    }
    if (getSettingsLanguage() === 'da') {
        return count === 1 ? 'hjemmeside' : 'hjemmesider';
    }
    return count === 1 ? 'website' : 'websites';
}

/** Editor "What to block" summary, e.g. "1 website · 0 apps" — singular when there is one. */
export function formatEditorItemCounts({ websites = 0, apps = 0 } = {}) {
    const part = (count, oneKey, manyKey) => (count === 1
        ? tSettings(oneKey)
        : tSettingsFmt(manyKey, { count: String(count) }));
    return tSettingsFmt('whatToBlockSummaryFmt', {
        websites: part(websites, 'countWebsiteOne', 'countWebsitesFmt'),
        apps: part(apps, 'countAppOne', 'countAppsFmt'),
    });
}

function siteWord(count) {
    if (getSettingsLanguage() === 'zh-CN') {
        return '网站';
    }
    if (getSettingsLanguage() === 'da') {
        return count === 1 ? 'hjemmeside' : 'hjemmesider';
    }
    return count === 1 ? 'site' : 'sites';
}

function appWord(count) {
    return count === 1 ? 'app' : 'apps';
}

function getBlocklistCardItemCounts(blocklist) {
    const isAllow = isBlocklistAllowlistMode(blocklist);
    const siteCount = blocklist?.websites?.length || 0;
    const regularApps = getBlocklistRegularApps(blocklist);
    const screenTimeCount = countIOSScreenTimeSelectionItems(
        getBlocklistIOSScreenTimeSelection(blocklist),
        isAllow,
    );
    const appCount = regularApps.length + screenTimeCount;
    return { siteCount, appCount };
}

function buildBlocklistCardCountsSummary(siteCount, appCount) {
    const parts = [];
    if (siteCount > 0) {
        parts.push(`${siteCount} ${siteWord(siteCount)}`);
    }
    if (appCount > 0) {
        parts.push(`${appCount} ${appWord(appCount)}`);
    }
    if (parts.length === 0) return '';
    if (parts.length === 1) return parts[0];
    return parts.join(` ${tSettings('blocklistCardCountsJoin')} `);
}

// "Show what it blocks on the card" (Advanced options). Spaces saved before the
// option existed have no field and default to showing names.
function blocklistCardShowsItemNames(blocklist) {
    return blocklist?.showItemDetails !== false;
}

// Up to this many items the card line lists names; beyond it, counts.
const CARD_INLINE_NAMES_MAX = 3;

/**
 * Expandable only when there is more than one item to inspect — and never
 * when names are hidden, or the expansion would reveal exactly what the
 * option is there to keep off the overview.
 */
export function blocklistCardHasExpandableSummary(blocklist) {
    if (!blocklistCardShowsItemNames(blocklist)) return false;
    const { siteCount, appCount } = getBlocklistCardItemCounts(blocklist);
    return siteCount + appCount > 1;
}

/** Short label from a blocked domain, e.g. instagram.com → instagram. */
// Second-level public-suffix labels: for hosts like bbc.co.uk / abc.com.au
// the registrable name sits one label further left than usual. Small curated
// set (no full Public Suffix List) covering the common ccTLD second levels.
const SECOND_LEVEL_PUBLIC_SUFFIXES = new Set([
    'co', 'com', 'org', 'net', 'gov', 'edu', 'ac', 'or', 'ne', 'go', 'gob',
]);

function siteNameForDisplay(url) {
    const host = cleanUrlForDisplay(url).split('/')[0].split(':')[0];
    const parts = host.split('.').filter(Boolean);
    if (parts.length <= 1) return parts[0] || host;
    // e.g. bbc.co.uk -> "bbc" (skip the co.uk two-level suffix), but
    // theguardian.com -> "theguardian".
    const suffixDepth = (parts.length >= 3 && SECOND_LEVEL_PUBLIC_SUFFIXES.has(parts[parts.length - 2]))
        ? 3 : 2;
    return parts[parts.length - suffixDepth];
}

/** Flat comma-separated labels for a focus-space card (websites first, then apps). */
export function collectBlocklistCardSummaryLabels(blocklist) {
    const labels = [];
    for (const url of blocklist?.websites || []) {
        labels.push(siteNameForDisplay(url).toLowerCase());
    }
    for (const app of getBlocklistRegularApps(blocklist)) {
        labels.push(displayNameForBlockedApp(app));
    }
    const screenTimeLabel = formatIOSScreenTimeSelectionLabel(
        getBlocklistIOSScreenTimeSelection(blocklist),
    );
    if (screenTimeLabel) labels.push(screenTimeLabel);
    return labels;
}

/** Room card line, e.g. "Blocks · 4 sites & 2 apps" (or just the name when only one item). */
export function buildBlocklistCardMetaHtml(blocklist) {
    const isAllow = isBlocklistAllowlistMode(blocklist);
    const prefixKey = isAllow ? 'blocklistCardAllowsFmt' : 'blocklistCardBlocksFmt';
    const prefix = escapeHtml(tSettings(prefixKey));

    const { siteCount, appCount } = getBlocklistCardItemCounts(blocklist);
    const total = siteCount + appCount;

    if (total === 0) {
        return `<span class="blocklist-meta-line"><span class="blocklist-meta-prefix">${prefix}</span></span>`;
    }

    const counts = buildBlocklistCardCountsSummary(siteCount, appCount);

    // Names hidden: counts only, and nothing to expand.
    if (!blocklistCardShowsItemNames(blocklist)) {
        return `<span class="blocklist-meta-line"><span class="blocklist-meta-prefix">${prefix}</span><span class="blocklist-meta-sep">·</span><span class="blocklist-meta-items">${escapeHtml(counts)}</span></span>`;
    }

    // Keep the full domain for websites (not the registrable short label).
    const names = [
        ...(blocklist?.websites || []).map(cleanUrlForDisplay),
        ...getBlocklistDisplayApps(blocklist),
    ];

    // Single site/app: show its name directly — no "1 site" expandable.
    if (total === 1) {
        return `<span class="blocklist-meta-line"><span class="blocklist-meta-prefix">${prefix}</span><span class="blocklist-meta-sep">·</span><span class="blocklist-meta-items">${escapeHtml(names[0] || '')}</span></span>`;
    }

    // A short list reads better as names; a long one would only be cut off by
    // the line's ellipsis, so it stays a count. Either way it expands. The
    // iOS Screen Time picker contributes one label for many items, so names
    // only stand in for the count when there is one name per item.
    const summary = total <= CARD_INLINE_NAMES_MAX && names.length === total
        ? names.join(', ')
        : counts;
    return `<span class="blocklist-meta-line"><span class="blocklist-meta-prefix">${prefix}</span><span class="blocklist-meta-sep">·</span><button type="button" class="blocklist-meta-items-btn" aria-expanded="false">${escapeHtml(summary)}</button></span>`;
}

/** Expandable Sites / Apps detail sections with item pills. */
export function buildBlocklistCardDetailsHtml(blocklist, { expanded = false } = {}) {
    const websiteLabels = (blocklist?.websites || []).map(cleanUrlForDisplay);
    const appLabels = getBlocklistDisplayApps(blocklist);
    const sections = [];

    if (websiteLabels.length > 0) {
        sections.push(
            '<div class="blocklist-details-section">'
            + `<div class="blocklist-details-heading">${escapeHtml(tSettings('blocklistCardSitesHeading'))}</div>`
            + `<div class="blocklist-details-pills">${websiteLabels.map((label) => `<span class="blocklist-details-pill">${escapeHtml(label)}</span>`).join('')}</div>`
            + '</div>',
        );
    }

    if (appLabels.length > 0) {
        sections.push(
            '<div class="blocklist-details-section">'
            + `<div class="blocklist-details-heading">${escapeHtml(tSettings('blocklistCardAppsHeading'))}</div>`
            + `<div class="blocklist-details-pills">${appLabels.map((label) => `<span class="blocklist-details-pill">${escapeHtml(label)}</span>`).join('')}</div>`
            + '</div>',
        );
    }

    if (sections.length === 0) return '';

    const hiddenClass = expanded ? '' : ' hidden';
    return `<div class="blocklist-card-details${hiddenClass}" aria-hidden="${expanded ? 'false' : 'true'}">${sections.join('')}</div>`;
}

/** Room card line, e.g. "3 sites · instagram, youtube, reddit". */
export function formatBlocklistCardSitesSummary(websiteCount, websites, showDetails) {
    const countLabel = `${websiteCount} ${siteWord(websiteCount)}`;
    if (!showDetails || websiteCount === 0) return countLabel;
    const names = (websites || []).map(siteNameForDisplay);
    return names.length > 0 ? `${countLabel} · ${names.join(', ')}` : countLabel;
}
