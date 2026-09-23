// iOS allowlist validation and effective-policy derivation.
// Extracted from app.js during allowlist-refactoring phase 3.
import { ask, message } from '@tauri-apps/plugin-dialog';
import { state } from './state.js';
import { tSettings } from './i18n.js';
import {
    isProtectedDomain,
    getBlocklistRegularApps,
    getBlocklistIOSScreenTimeSelection,
    getBlocklistIOSPayload,
} from './blocklist-utils.js';
import { isBlocklistAllowlistMode } from './list-mode.js';
import { isScheduleSegmentActiveNow } from './schedule-editor.js';
import { isSchedulePausedNow } from './schedule-engine.js';

/** Apple caps `.all(except:)` exceptions at 50 domains / 50 tokens per store. */
export const IOS_ALLOWLIST_EXCEPTION_LIMIT = 50;

export async function ensureIOSAllowlistStartable(blocklist) {
    if (!state.isIOS || !isBlocklistAllowlistMode(blocklist)) return true;
    const selection = getBlocklistIOSScreenTimeSelection(blocklist);
    const appTokens = selection?.applicationTokens || [];
    const categoryTokens = selection?.categoryTokens || [];
    const enforceableWebsites = (blocklist?.websites || []).filter((domain) => !isProtectedDomain(domain));

    if (appTokens.length === 0 && enforceableWebsites.length === 0) {
        await message(tSettings('allowlistIosNeedsWebsites'), {
            title: tSettings('allowlistIosNeedsWebsitesTitle'),
            kind: 'warning',
        });
        return false;
    }
    const breach = iosAllowlistUnionBreach(blocklist);
    if (breach) {
        await message(tSettings(breach.key).replace('{n}', String(breach.count)), {
            title: tSettings(`${breach.key}Title`),
            kind: 'warning',
        });
        return false;
    }
    if (appTokens.length > 0 && categoryTokens.length > 0) {
        const proceed = await ask(tSettings('allowlistIosCategoriesIgnored'), {
            title: tSettings('allowlistIosCategoriesIgnoredTitle'),
            kind: 'warning',
            okLabel: 'OK',
            cancelLabel: tSettings('cancel'),
        });
        if (!proceed) return false;
    }
    const hasUnenforceableApps = getBlocklistRegularApps(blocklist).length > 0 || categoryTokens.length > 0;
    if (appTokens.length === 0 && hasUnenforceableApps) {
        const proceed = await ask(tSettings('allowlistIosWebOnlyConfirm'), {
            title: tSettings('allowlistIosWebOnlyConfirmTitle'),
            kind: 'warning',
        });
        if (!proceed) return false;
    }
    return true;
}

/** The limit this space would breach once it joins the spaces already running,
 *  or null. Apple's cap is per store, not per focus space: two allow spaces of
 *  30 sites each pass on their own and silently lose 10 between them, because
 *  Swift keeps only a sorted 50-item prefix. Kept apart from the dialog above
 *  so the decision is testable. */
export function iosAllowlistUnionBreach(blocklist, now = Date.now()) {
    const union = [
        ...collectActiveIOSEnforcementSources(now).filter((s) => s.blocklist?.id !== blocklist?.id),
        { kind: 'manual', blocklist },
    ];
    const sites = validateIOSAllowlistLimits(deriveIOSEffectiveWebsitePolicy(union));
    if (!sites.ok) return { key: 'allowlistIosDomainLimit', count: sites.count };
    const apps = validateIOSAllowlistLimits(deriveIOSEffectiveAppPolicy(union));
    if (!apps.ok) return { key: 'allowlistIosTokenLimit', count: apps.count };
    return null;
}

export function collectActiveIOSEnforcementSources(now = Date.now()) {
    const sources = [];
    for (const block of state.appData.activeBlocks || []) {
        if (block.startTime > now || block.endTime <= now || block.isPaused) continue;
        const blocklist = state.appData.blocklists.find((bl) => bl.id === block.blocklistId);
        if (!blocklist) continue;
        sources.push({ kind: 'manual', blocklist, block });
    }
    const nowDate = new Date(now);
    for (const schedule of state.appData.schedules || []) {
        if (!schedule.segments || schedule.segments.length === 0) continue;
        if (isSchedulePausedNow(schedule, now)) continue;
        if (!isScheduleSegmentActiveNow(schedule, nowDate)) continue;
        const blocklist = state.appData.blocklists.find((bl) => bl.id === schedule.blocklistId);
        if (!blocklist) continue;
        sources.push({ kind: 'schedule', blocklist, schedule });
    }
    return sources;
}

export function deriveIOSEffectiveWebsitePolicy(sources) {
    const blocked = new Set();
    const allowed = new Set();
    for (const { blocklist } of sources || []) {
        const target = isBlocklistAllowlistMode(blocklist) ? allowed : blocked;
        for (const domain of blocklist?.websites || []) {
            if (!isProtectedDomain(domain)) target.add(domain);
        }
    }
    if (allowed.size === 0) {
        return { kind: 'specific-block', domains: Array.from(blocked).sort() };
    }
    for (const domain of blocked) allowed.delete(domain);
    return { kind: 'all-except', domains: Array.from(allowed).sort() };
}

export function deriveIOSEffectiveAppPolicy(sources) {
    const blockedApps = new Set();
    const blockedCategories = new Set();
    const allowedApps = new Set();
    for (const { blocklist } of sources || []) {
        const payload = getBlocklistIOSPayload(blocklist);
        if (isBlocklistAllowlistMode(blocklist)) {
            for (const token of payload.appTokenData) allowedApps.add(token);
        } else {
            for (const token of payload.appTokenData) blockedApps.add(token);
            for (const token of payload.categoryTokenData) blockedCategories.add(token);
        }
    }
    if (allowedApps.size === 0) {
        return {
            kind: 'specific-block',
            appTokenData: Array.from(blockedApps),
            categoryTokenData: Array.from(blockedCategories),
        };
    }
    for (const token of blockedApps) allowedApps.delete(token);
    return { kind: 'all-except', appTokenData: Array.from(allowedApps), categoryTokenData: [] };
}

export function validateIOSAllowlistLimits(policy) {
    if (!policy || policy.kind !== 'all-except') return { ok: true };
    const domainCount = policy.domains?.length ?? 0;
    if (domainCount > IOS_ALLOWLIST_EXCEPTION_LIMIT) {
        return { ok: false, reason: 'domains', count: domainCount };
    }
    const tokenCount = policy.appTokenData?.length ?? 0;
    if (tokenCount > IOS_ALLOWLIST_EXCEPTION_LIMIT) {
        return { ok: false, reason: 'tokens', count: tokenCount };
    }
    return { ok: true };
}
