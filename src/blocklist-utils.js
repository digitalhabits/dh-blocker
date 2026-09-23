// Blocklist domain helpers: protected apps/domains, iOS Screen Time
// selection normalization, blocklist normalization. Extracted verbatim
// from app.js. Leaf module: imports only shared state.
import { state } from './state.js';

// Far-future timestamp used for "always on" blocks (year 9999)
export const ALWAYS_ON_END_TIME = new Date(9999, 11, 31, 23, 59, 59, 999).getTime();

// Protected app names — Digital Habits Blocker must never block itself
export const PROTECTED_APP_NAMES = [
    'digital habits blocker',
    'digital habits: blocker',
    'redd block',
    'redd blocker',
    'redd-block',
    'redd-block-helper',
    'fristed',
];

// Protected domains — blocking these would break networking or the app itself
export const PROTECTED_DOMAINS = [
    'localhost', 'localhost.localdomain',
    '127.0.0.1', '0.0.0.0', '::1',
    'broadcasthost', 'local',
    'reddfocus.org', 'www.reddfocus.org',
    'digitalhabits.org', 'www.digitalhabits.org',
    'ulyngs.github.io'
];

/**
 * Check if an app name matches a protected app (case-insensitive).
 * Returns true if the app should NOT be added to a blocklist.
 */
export function isProtectedApp(name) {
    if (!name) return false;
    const lower = name.trim().toLowerCase();
    return PROTECTED_APP_NAMES.some(p => lower === p);
}

/**
 * Check if a domain is protected (case-insensitive).
 * Returns true if the domain should NOT be added to a blocklist.
 */
export function isProtectedDomain(domain) {
    if (!domain) return false;
    const lower = domain.trim().toLowerCase();
    return PROTECTED_DOMAINS.some(p => lower === p);
}

// Helper: detect always-on blocks by flag OR far-future end time
export function isBlockAlwaysOn(block) {
    return block.isAlwaysOn === true || block.endTime >= ALWAYS_ON_END_TIME;
}

/** Canonical mode test. Anything that is not explicitly 'allowlist' is a blocklist. */
export function isAllowlistBlocklist(blocklist) {
    return blocklist?.mode === 'allowlist';
}

export function isScreenTimeSummaryEntry(appName) {
    return typeof appName === 'string' && appName.includes('selected (Screen Time)');
}

export function parseLegacyScreenTimeSummary(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return null;
    const summaryLabel = entries.join(', ');
    let applicationCount = 0;
    let categoryCount = 0;
    for (const entry of entries) {
        const appMatch = entry.match(/(\d+)\s+app/);
        const categoryMatch = entry.match(/(\d+)\s+categor(?:y|ies)/);
        if (appMatch) applicationCount += Number.parseInt(appMatch[1], 10);
        if (categoryMatch) categoryCount += Number.parseInt(categoryMatch[1], 10);
    }
    return {
        applicationTokens: [],
        categoryTokens: [],
        applicationCount,
        categoryCount,
        summaryLabel,
        requiresReselection: true
    };
}

export function normalizeIOSScreenTimeSelection(selection, legacySummaryEntries = []) {
    if (!selection && legacySummaryEntries.length === 0) return null;

    const normalized = {
        applicationTokens: Array.isArray(selection?.applicationTokens) ? [...selection.applicationTokens] : [],
        categoryTokens: Array.isArray(selection?.categoryTokens) ? [...selection.categoryTokens] : [],
        applicationCount: Number.isFinite(selection?.applicationCount) ? selection.applicationCount : null,
        categoryCount: Number.isFinite(selection?.categoryCount) ? selection.categoryCount : null,
        summaryLabel: typeof selection?.summaryLabel === 'string' ? selection.summaryLabel : '',
        requiresReselection: selection?.requiresReselection === true
    };

    if (normalized.applicationCount == null) {
        normalized.applicationCount = normalized.applicationTokens.length;
    }
    if (normalized.categoryCount == null) {
        normalized.categoryCount = normalized.categoryTokens.length;
    }

    if (!selection && legacySummaryEntries.length > 0) {
        return parseLegacyScreenTimeSummary(legacySummaryEntries);
    }

    if (
        !normalized.summaryLabel &&
        (normalized.applicationCount > 0 || normalized.categoryCount > 0) &&
        normalized.applicationTokens.length === 0 &&
        normalized.categoryTokens.length === 0
    ) {
        const legacySelection = parseLegacyScreenTimeSummary(legacySummaryEntries);
        if (legacySelection?.summaryLabel) {
            normalized.summaryLabel = legacySelection.summaryLabel;
        }
        normalized.requiresReselection = true;
    }

    const hasAnySelection =
        normalized.applicationTokens.length > 0 ||
        normalized.categoryTokens.length > 0 ||
        normalized.applicationCount > 0 ||
        normalized.categoryCount > 0 ||
        !!normalized.summaryLabel;

    return hasAnySelection ? normalized : null;
}

export function cloneIOSScreenTimeSelection(selection) {
    const normalized = normalizeIOSScreenTimeSelection(selection);
    return normalized ? { ...normalized } : null;
}

export function hasUsableIOSScreenTimeSelection(selection) {
    const normalized = normalizeIOSScreenTimeSelection(selection);
    return !!normalized && (
        normalized.applicationTokens.length > 0 ||
        normalized.categoryTokens.length > 0
    );
}

export function formatIOSScreenTimeSelectionLabel(selection) {
    const normalized = normalizeIOSScreenTimeSelection(selection);
    if (!normalized) return '';
    if (normalized.summaryLabel) return normalized.summaryLabel;

    const parts = [];
    if (normalized.applicationCount > 0) parts.push(`${normalized.applicationCount} app${normalized.applicationCount > 1 ? 's' : ''}`);
    if (normalized.categoryCount > 0) parts.push(`${normalized.categoryCount} categor${normalized.categoryCount > 1 ? 'ies' : 'y'}`);
    return parts.length > 0 ? `${parts.join(', ')} selected (Screen Time)` : '';
}

export function getBlocklistRegularApps(blocklist) {
    if (!Array.isArray(blocklist?.apps)) return [];
    return blocklist.apps.filter(app => typeof app === 'string' && !isScreenTimeSummaryEntry(app));
}

export function getBlocklistIOSScreenTimeSelection(blocklist) {
    const legacySummaryEntries = Array.isArray(blocklist?.apps)
        ? blocklist.apps.filter(isScreenTimeSummaryEntry)
        : [];
    return normalizeIOSScreenTimeSelection(blocklist?.iosScreenTimeSelection, legacySummaryEntries);
}

export function getBlocklistModalLockedApps(blocklist) {
    const locked = [...getBlocklistRegularApps(blocklist)];
    const screenTimeLabel = formatIOSScreenTimeSelectionLabel(getBlocklistIOSScreenTimeSelection(blocklist));
    if (screenTimeLabel) locked.push(screenTimeLabel);
    return locked;
}

export function getBlocklistIOSPayload(blocklist) {
    const selection = getBlocklistIOSScreenTimeSelection(blocklist);
    return {
        appTokenData: selection?.applicationTokens || [],
        categoryTokenData: selection?.categoryTokens || []
    };
}

export function blocklistNeedsIOSSelectionRefresh(blocklist) {
    const selection = getBlocklistIOSScreenTimeSelection(blocklist);
    return !!selection && selection.requiresReselection === true;
}

/**
 * Apply the result of iOS 26.5's ManagedSettings token refresh without ever
 * turning a refresh problem into an empty selection.
 *
 * Older iOS versions do not expose ManagedSettingsStore.refresh, so an
 * unsupported result is a no-op. A supported refresh that fails, or silently
 * drops any previously stored token, preserves the saved tokens
 * for display/retry but marks them as requiring picker reselection. Callers
 * must not start new enforcement while that marker is set.
 */
export function applyIOSScreenTimeTokenRefreshResult(selection, result) {
    const saved = normalizeIOSScreenTimeSelection(selection);
    if (!saved || result?.supported !== true) return saved;

    const refreshFailed = result.success !== true;
    const refreshedApps = Array.isArray(result.applicationTokens)
        ? result.applicationTokens
        : [];
    const refreshedCategories = Array.isArray(result.categoryTokens)
        ? result.categoryTokens
        : [];
    const droppedApps = refreshedApps.length < saved.applicationTokens.length;
    const droppedCategories = refreshedCategories.length < saved.categoryTokens.length;

    if (refreshFailed || droppedApps || droppedCategories) {
        return {
            ...saved,
            requiresReselection: true,
        };
    }

    return normalizeIOSScreenTimeSelection({
        applicationTokens: refreshedApps,
        categoryTokens: refreshedCategories,
        requiresReselection: false,
    });
}

/**
 * Merge a freshly-picked Screen Time selection into a saved one, keeping every
 * saved token.
 *
 * The iOS activity picker hands back a *replacement* selection, which makes it
 * the one edit surface that can unblock an app while a focus space is
 * enforcing: the edit modal's locked tags cover only the summary label ("3
 * apps"), never the tokens behind it. Unioning turns the picker additive, which
 * is the rule already in force for every other item on every other platform —
 * while enforcing you may add, never remove.
 *
 * Block mode only, and the caller is responsible for that check. In allow mode
 * the picker expands categories into their member app tokens and returns no
 * category tokens, so a union there would resurrect a saved category token the
 * allow-mode resolver cannot enforce — and adding is the loosening direction in
 * allow mode anyway.
 *
 * Counts are deliberately not carried over from either input: they describe the
 * replacement, not the merge, and the summary label is derived from them. Left
 * null, normalizeIOSScreenTimeSelection recomputes both from the merged arrays.
 *
 * @param {object|null} saved - the persisted selection, the floor to stay above.
 * @param {object|null} picked - what the picker returned (null when it came back empty).
 * @returns {object|null} normalized selection, or null when both sides are empty.
 */
export function mergeIOSScreenTimeSelectionAdditive(saved, picked) {
    const union = (a, b) => {
        const seen = new Set();
        const out = [];
        for (const token of [...(a || []), ...(b || [])]) {
            if (typeof token !== 'string' || !token || seen.has(token)) continue;
            seen.add(token);
            out.push(token);
        }
        return out;
    };

    const applicationTokens = union(saved?.applicationTokens, picked?.applicationTokens);
    const categoryTokens = union(saved?.categoryTokens, picked?.categoryTokens);
    if (applicationTokens.length === 0 && categoryTokens.length === 0) return null;

    // A merge always carries real tokens, so whatever `requiresReselection` the
    // saved side had is repaired by definition.
    return normalizeIOSScreenTimeSelection({
        applicationTokens,
        categoryTokens,
        requiresReselection: false,
    });
}

/**
 * Resolve the Screen Time selection at the final save boundary.
 *
 * The modal candidate can become stale after the picker closes or after undo:
 * a schedule may start, or a pause may expire, before Save is pressed. Reapply
 * the persisted block-mode floor at that moment so every UI path remains
 * additive while edit friction is required. Allow mode deliberately remains
 * replacement-based because adding allowed apps loosens enforcement there.
 */
export function resolveIOSScreenTimeSelectionForSave(
    saved,
    candidate,
    { mode = 'blocklist', editFrictionRequired = false } = {},
) {
    if (mode === 'blocklist' && editFrictionRequired) {
        return mergeIOSScreenTimeSelectionAdditive(saved, candidate);
    }
    return cloneIOSScreenTimeSelection(candidate);
}

export function ensureIOSBlocklistSelectionReady(blocklist, actionLabel) {
    if (!state.isIOS || !blocklistNeedsIOSSelectionRefresh(blocklist)) {
        return true;
    }

    const blocklistName = blocklist?.name || 'This blocklist';
    alert(`${blocklistName} has an old Screen Time app selection that iOS can no longer enforce reliably. Please edit the blocklist and re-select its apps before ${actionLabel}.`);
    return false;
}

/** Soft palette matching the focus-space color swatches (sky → lilac). */
export const FOCUS_SPACE_COLOR_PALETTE = [
    '#B8D1DE',
    '#B3D2C8',
    '#BCD9B6',
    '#EBDCB6',
    '#EECAAD',
    '#E7B3A8',
    '#E1BAC3',
    '#C8B9D6',
];

// Drop a leading `www.` label from a lowercased host. Enforcement matches
// "host == entry or a subdomain of entry", so a stored `www.example.com` would
// never match `example.com` and the site would stay reachable at its bare
// domain. `www.com` is a real domain and is kept. Mirrored on desktop by
// `normalize_website_entry` in src-tauri/src/native_host.rs.
export function stripLeadingWww(host) {
    const bare = host.replace(/^www\./, '');
    return bare.includes('.') ? bare : host;
}

/**
 * Rewrite website entries saved before the input field stripped `www.`.
 * Desktop enforcement normalizes on read, but iOS hands the stored strings to
 * Screen Time as-is and every platform displays them, so the stored data is
 * healed too. Entries that collapse onto an existing one are dropped.
 */
export function healWwwWebsiteEntries(blocklists) {
    let changed = false;
    for (const bl of blocklists || []) {
        if (!Array.isArray(bl.websites)) continue;
        const seen = new Set();
        const healed = [];
        for (const entry of bl.websites) {
            const next = typeof entry === 'string' ? stripLeadingWww(entry.trim().toLowerCase()) : entry;
            if (seen.has(next)) continue;
            seen.add(next);
            healed.push(next);
        }
        if (healed.length !== bl.websites.length || healed.some((w, i) => w !== bl.websites[i])) {
            bl.websites = healed;
            changed = true;
        }
    }
    return changed;
}

/**
 * If saved colors collapsed to one shared value (or are missing), reassign
 * spaces in palette order so the list reads as distinct again.
 */
export function healFocusSpaceColors(blocklists) {
    const lists = blocklists || [];
    if (lists.length === 0) return false;

    const present = lists
        .map((bl) => (typeof bl.color === 'string' && bl.color.trim() ? bl.color.trim() : null))
        .filter(Boolean);
    const collapsed = present.length >= 2 && new Set(present).size === 1;

    if (collapsed) {
        lists.forEach((bl, i) => {
            bl.color = FOCUS_SPACE_COLOR_PALETTE[i % FOCUS_SPACE_COLOR_PALETTE.length];
        });
        return true;
    }

    let changed = false;
    const used = new Set(present);
    for (const bl of lists) {
        if (typeof bl.color === 'string' && bl.color.trim()) continue;
        const next = FOCUS_SPACE_COLOR_PALETTE.find((c) => !used.has(c))
            || FOCUS_SPACE_COLOR_PALETTE[used.size % FOCUS_SPACE_COLOR_PALETTE.length];
        bl.color = next;
        used.add(next);
        changed = true;
    }
    return changed;
}

/**
 * One-time cleanup of "Quick start" spaces left behind by versions before 3.9.
 *
 * Quick start created a hidden `isQuickStart` blocklist (older saves dropped
 * the flag but kept the `qs-` id prefix) for a one-off block. The feature is
 * gone, so the failure has to fall towards blocking: a quick start that is
 * enforcing right now is promoted to an ordinary, visible focus space so its
 * block keeps running; the rest were never meant to be visible and are dropped
 * together with any stale blocks/schedules that point at them. A quick start
 * the user already promoted ("Save as focus space", `isQuickStart: false`)
 * only loses the obsolete flag.
 *
 * Returns true when appData was changed and should be saved.
 */
export function migrateLegacyQuickStartBlocklists(appData, now = Date.now()) {
    if (!appData || !Array.isArray(appData.blocklists)) return false;
    const isLegacyQuickStart = (bl) => bl
        && bl.isQuickStart !== false
        && (bl.isQuickStart === true || String(bl.id || '').startsWith('qs-'));
    const enforcingIds = new Set(
        (appData.activeBlocks || [])
            .filter((b) => b.startTime <= now && b.endTime > now)
            .map((b) => b.blocklistId),
    );
    let changed = false;
    const dropped = new Set();
    appData.blocklists = appData.blocklists.filter((bl) => {
        if (!bl || typeof bl !== 'object') return true;
        if (isLegacyQuickStart(bl)) {
            if (!enforcingIds.has(bl.id)) {
                dropped.add(bl.id);
                changed = true;
                return false;
            }
            delete bl.isQuickStart;
            if (bl.alwaysShowInSchedule === false) bl.alwaysShowInSchedule = true;
            changed = true;
            return true;
        }
        if ('isQuickStart' in bl) {
            delete bl.isQuickStart;
            changed = true;
        }
        return true;
    });
    if (dropped.size > 0) {
        if (Array.isArray(appData.activeBlocks)) {
            appData.activeBlocks = appData.activeBlocks.filter((b) => !dropped.has(b.blocklistId));
        }
        if (Array.isArray(appData.schedules)) {
            appData.schedules = appData.schedules.filter((s) => !dropped.has(s.blocklistId));
        }
    }
    return changed;
}

export function normalizeBlocklist(blocklist) {
    const normalizedBlocklist = { ...blocklist };
    normalizedBlocklist.apps = getBlocklistRegularApps(blocklist);
    normalizedBlocklist.iosScreenTimeSelection = getBlocklistIOSScreenTimeSelection(blocklist);
    return normalizedBlocklist;
}

/**
 * What the iOS save path should tell Screen Time about the manual channel.
 * Schedules are enforced by the DeviceActivity extension from its own store,
 * so a running schedule must never be wiped by a manual change — but the
 * manual store must still be cleared when the last manual block ends,
 * otherwise the extension re-applies the stale record at every boundary.
 */
export function iosManualSyncAction({ hasActiveBlocks, hasActiveScheduleSegments }) {
    if (hasActiveBlocks) return 'start';
    return hasActiveScheduleSegments ? 'clear-manual' : 'clear-all';
}

export function collectActiveIOSManualBlockPayload(now = Date.now()) {
    const allDomains = new Set();
    const allowedDomains = new Set();
    const allowedAppTokenData = new Set();
    const appTokenData = new Set();
    const categoryTokenData = new Set();

    let displayWinner = null;
    let allowlistDisplayWinner = null;

    for (const block of state.appData.activeBlocks || []) {
        if (block.startTime > now || block.endTime <= now || block.isPaused) continue;
        const blocklist = state.appData.blocklists.find(bl => bl.id === block.blocklistId);
        if (!blocklist) continue;

        const bid = String(block.blocklistId ?? '');
        if (
            displayWinner == null
            || block.startTime < displayWinner.block.startTime
            || (block.startTime === displayWinner.block.startTime
                && bid < String(displayWinner.block.blocklistId ?? ''))
        ) {
            displayWinner = { block, blocklist };
        }

        if (
            isAllowlistBlocklist(blocklist)
            && (
                allowlistDisplayWinner == null
                || block.startTime < allowlistDisplayWinner.block.startTime
                || (block.startTime === allowlistDisplayWinner.block.startTime
                    && bid < String(allowlistDisplayWinner.block.blocklistId ?? ''))
            )
        ) {
            allowlistDisplayWinner = { block, blocklist };
        }

        if (isAllowlistBlocklist(blocklist)) {
            // Allow-mode focus space: websites and app tokens are ALLOWED items.
            // Category tokens cannot be allowlist exceptions on iOS and are ignored.
            for (const domain of blocklist.websites || []) {
                if (!isProtectedDomain(domain)) allowedDomains.add(domain);
            }
            for (const token of getBlocklistIOSPayload(blocklist).appTokenData) {
                allowedAppTokenData.add(token);
            }
            continue;
        }

        for (const domain of blocklist.websites || []) {
            if (!isProtectedDomain(domain)) allDomains.add(domain);
        }

        const iosPayload = getBlocklistIOSPayload(blocklist);
        for (const token of iosPayload.appTokenData) appTokenData.add(token);
        for (const token of iosPayload.categoryTokenData) categoryTokenData.add(token);
    }

    // Blocklist wins on overlap: an explicitly blocked item is never an exception.
    for (const domain of allDomains) allowedDomains.delete(domain);
    for (const token of appTokenData) allowedAppTokenData.delete(token);

    const out = {
        domains: Array.from(allDomains).sort(),
        allowedDomains: Array.from(allowedDomains).sort(),
        allowedAppTokenData: Array.from(allowedAppTokenData),
        appTokenData: Array.from(appTokenData),
        categoryTokenData: Array.from(categoryTokenData)
    };
    if (displayWinner) {
        const { block, blocklist } = displayWinner;
        out.blocklistEmoji = blocklist.emoji ?? null;
        out.blocklistName = blocklist.name ?? null;
        const c = blocklist.color;
        out.blocklistColorHex = typeof c === 'string' && c.length > 0 ? c : null;
        out.blockStartMs = block.startTime;
        out.blockEndMs = block.endTime;
        out.mode = isAllowlistBlocklist(blocklist) ? 'allowlist' : null;
    }
    if (allowlistDisplayWinner) {
        // Shield attribution for "blocked because not allowed" targets: the
        // earliest-started active allow-mode block, independent of the overall
        // display winner above (which may be a blocklist block).
        const { block, blocklist } = allowlistDisplayWinner;
        out.allowlistBlocklistEmoji = blocklist.emoji ?? null;
        out.allowlistBlocklistName = blocklist.name ?? null;
        const c = blocklist.color;
        out.allowlistBlocklistColorHex = typeof c === 'string' && c.length > 0 ? c : null;
        out.allowlistBlockStartMs = block.startTime;
        out.allowlistBlockEndMs = block.endTime;
    }
    return out;
}

/// Invisible direction/format marks a platform may carry in a process name —
/// macOS reports WhatsApp as "‎WhatsApp". Left in, they defeat the
/// installed-apps lookup and survive into the name we show.
const INVISIBLE_MARKS = /[\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

const cleanProcessName = (name) => String(name || '')
    .replace(INVISIBLE_MARKS, '')
    .trim()
    .replace(/\.exe$/i, '');

export function normalizeBlockedAppKey(name) {
    return cleanProcessName(name).toLowerCase();
}

export function displayNameForBlockedApp(processName) {
    const key = normalizeBlockedAppKey(processName);
    if (!key) return processName;
    const match = (state.installedAppsCache || []).find(
        (a) => normalizeBlockedAppKey(a.process_name) === key,
    );
    if (match?.display_name) return match.display_name;

    // Unknown app (not installed / not in the cache). Package-style ids
    // (Android, e.g. app.vanadium.browser) read worse when title-cased.
    if (key.includes('.')) return key;
    // A name carrying its own capitals or spaces is already user-facing
    // ("WhatsApp", "Windows PowerShell") — lowercasing it was the bug. Only
    // bare tokens need prettifying, and splitting those on camelCase would
    // mangle the very names this protects, so it splits on _ and - only.
    const raw = cleanProcessName(processName);
    if (/[A-Z]/.test(raw) || /\s/.test(raw)) return raw;
    const spaced = raw.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** One entry per blocked app — Edge's many PIDs collapse to a single name. */
export function uniqueBlockedAppDisplayNames(names) {
    const seen = new Set();
    const out = [];
    for (const name of names) {
        const key = normalizeBlockedAppKey(name);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(displayNameForBlockedApp(name));
    }
    return out;
}
