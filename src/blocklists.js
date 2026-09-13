// Blocklist CRUD: duplication, import/export, delete-undo, list rendering.
// Extracted verbatim from app.js.
import { state } from './state.js';
import { getMaxOverrideWords, migrateOverrideDifficultyToWords } from './override-challenge.js';
import { normalizeUnlockMinutes } from './unlock-duration.js';
import { confirmDiscardEditorEdits, editorHasUnsavedEdits, formatScheduleWhenSummary } from './focus-space-editor.js';
import { deriveWhenToBlockKind } from './when-to-block.js';
import { BaseDirectory } from '@tauri-apps/api/path';
import { ask, message, open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { escapeHtml, getEnteringChipColor } from './utils.js';
import { tSettings, tSettingsFmt } from './i18n.js';
import { cloneIOSScreenTimeSelection, getBlocklistIOSScreenTimeSelection, getBlocklistRegularApps, isAllowlistBlocklist, isScreenTimeSummaryEntry, normalizeBlocklist } from './blocklist-utils.js';
import { isOneOffBlockEnforced, isSchedulePausedNow } from './schedule-engine.js';
import { saveData, updateHostsFile } from './persistence.js';
import { render, renderNowBlockingRow, renderScheduleVisibilityChips } from './render.js';
import { isFocusSpaceOn, setFocusSpaceEnabled } from './focus-space-switch.js';
import { canEditScheduleBetweenBlocks, commitSegmentDelete, isScheduleSegmentActiveNow } from './schedule-editor.js';
import {
    BLOCKLIST_NAME_MAX_LENGTH,
    generateId,
} from './app.js';
import { buildBlocklistCardMetaHtml, buildBlocklistCardDetailsHtml, blocklistCardHasExpandableSummary } from './list-presentation.js';
import { cloneOverrideDifficulty, deselectBlocklist, handleBlocklistSelect, isBlocklistCardVisuallySelected, isEnterSchedulerModalOpen, openBlocklistModal } from './confirm-modals.js';
import { appBlockingWarningSnoozedUntilMs, formatAppBlockingSnoozeStartsIn, getActiveAppBlockingSnoozeBlocklistId } from './blocking-platform.js';

function getVisibleBlocklists() {
    return state.appData.blocklists || [];
}

/** Focus-space cards whose Sites/Apps summary is expanded (survives re-render). */
const expandedBlocklistCardIds = new Set();

/** One-shot: expand the sole focus space's sites/apps summary on first load. */
let didDefaultExpandSoleCard = false;

function setBlocklistCardExpanded(card, id, expanded) {
    if (expanded) expandedBlocklistCardIds.add(id);
    else expandedBlocklistCardIds.delete(id);

    card.classList.toggle('blocklist-card-expanded', expanded);
    const details = card.querySelector('.blocklist-card-details');
    if (details) {
        details.classList.toggle('hidden', !expanded);
        details.setAttribute('aria-hidden', expanded ? 'false' : 'true');
    }
    const btn = card.querySelector('.blocklist-meta-items-btn');
    if (btn) btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
}

function toggleBlocklistCardExpanded(card, id) {
    setBlocklistCardExpanded(card, id, !expandedBlocklistCardIds.has(id));
}

async function openBlocklistEnterFromCard(blocklistId) {
    if (state.selectedBlocklistId === blocklistId) {
        if (isEnterSchedulerModalOpen()) {
            if (editorHasUnsavedEdits() && !(await confirmDiscardEditorEdits())) return;
            deselectBlocklist();
            return;
        }
        const dropdown = document.getElementById('blocklist-select');
        dropdown.value = blocklistId;
        handleBlocklistSelect({ target: dropdown }, { openEnterUi: true });
        return;
    }

    // Moving to another space drops in-flight edits on this one — ask first.
    if (editorHasUnsavedEdits() && !(await confirmDiscardEditorEdits())) return;
    const dropdown = document.getElementById('blocklist-select');
    dropdown.value = blocklistId;
    handleBlocklistSelect({ target: dropdown }, { openEnterUi: true });
}

/**
 * The card's third line, like the Android app's: "{status} · {timing}".
 * Status is Blocking now / Allowing now (green), Paused until 10:30, Off, or
 * Scheduled; timing is "Manual · starts when enabled" or the schedule's days
 * and times. A Manual space that is not running shows just the timing.
 */
function buildBlocklistCardStatusLine(bl, now = Date.now()) {
    const schedule = (state.appData.schedules || []).find(
        (s) => s.blocklistId === bl.id && s.segments?.length > 0,
    ) || null;
    const block = state.appData.activeBlocks.find(
        (b) => b.blocklistId === bl.id && b.startTime <= now && b.endTime > now,
    ) || null;
    const nowLabel = tSettings(isAllowlistBlocklist(bl) ? 'cardStatusAllowingNow' : 'cardStatusBlockingNow');
    const timing = formatScheduleWhenSummary(deriveWhenToBlockKind(schedule), schedule);
    // 24-hour HH:MM, matching the schedule times on the same line.
    const pausedUntil = (pauseEndTime) => {
        const d = new Date(pauseEndTime);
        const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        return tSettingsFmt('cardStatusPausedUntilFmt', { time: hhmm });
    };

    let status = null;
    let tone = '';
    if (block && !isOneOffPauseActive(block, now)) {
        status = nowLabel; tone = ' is-blocking';
    } else if (block) {
        status = block.pauseEndTime ? pausedUntil(block.pauseEndTime) : tSettings('cardStatusOff');
    } else if (schedule) {
        if (isSchedulePausedNow(schedule, now)) {
            status = schedule.pauseEndTime ? pausedUntil(schedule.pauseEndTime) : tSettings('cardStatusOff');
        } else if (getActiveAppBlockingSnoozeBlocklistId(now) === bl.id) {
            status = formatAppBlockingSnoozeStartsIn(appBlockingWarningSnoozedUntilMs - now);
        } else if (isScheduleSegmentActiveNow(schedule, new Date(now))) {
            status = nowLabel; tone = ' is-blocking';
        } else {
            status = tSettings('cardStatusScheduled');
        }
    }

    const text = status ? tSettingsFmt('cardStatusLineFmt', { status, timing }) : timing;
    return `<div class="blocklist-status-line${tone}" title="${escapeHtml(text)}">${escapeHtml(text)}</div>`;
}

export function truncateBlocklistName(raw) {
    const s = String(raw ?? '');
    return s.length <= BLOCKLIST_NAME_MAX_LENGTH ? s : s.slice(0, BLOCKLIST_NAME_MAX_LENGTH);
}

// Duplicate naming (localized suffix): EN "copy", DA "kopi"; parses both so chains gap-fill correctly.

/** Returns chain root if name ends with localized or legacy "copy" / "kopi" (+ optional number), else null. */
export function parseCopyRoot(name) {
    let m = /^(.+?) copy(?: (\d+))?$/.exec(name);
    if (m) return m[1];
    m = /^(.+?) kopi(?: (\d+))?$/i.exec(name);
    return m ? m[1] : null;
}

export function getBlocklistDuplicateSuffix() {
    return tSettings('blocklistDuplicateSuffix');
}

/** Slot numbers already used for base (counts both "copy" and "kopi" names — one chain per base). */
export function collectUsedDuplicateSuffixSlots(base) {
    const used = new Set();
    const esc = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^${esc} (copy|kopi)(?: (\\d+))?$`, 'i');
    for (const bl of state.appData.blocklists) {
        const m = re.exec(bl.name);
        if (!m) continue;
        used.add(m[2] ? parseInt(m[2], 10) : 1);
    }
    return used;
}

/** Comparable string for content (websites, apps only). Only these + name affect duplicate copy-number chain. */
export function contentKey(blocklistId) {
    const bl = state.appData.blocklists.find(b => b.id === blocklistId);
    if (!bl) return '';
    const w = [...(bl.websites || [])].sort();
    const a = [...getBlocklistRegularApps(bl)].sort();
    const iosSelection = getBlocklistIOSScreenTimeSelection(bl);
    return JSON.stringify({
        w,
        a,
        iosAppTokens: [...(iosSelection?.applicationTokens || [])].sort(),
        iosCategoryTokens: [...(iosSelection?.categoryTokens || [])].sort(),
        iosSummary: iosSelection?.summaryLabel || ''
    });
}

export function sameBlocklistContent(idA, idB) { return contentKey(idA) === contentKey(idB); }

/** True if name is root, "root copy|kopi", or "root copy|kopi N". */
export function nameInChain(name, root) {
    if (name === root) return true;
    const esc = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^${esc} (copy|kopi)(?: (\\d+))?$`, 'i');
    return re.test(name);
}

/** Next duplicate name using current locale suffix; gap-fill; same chain if unedited, else new chain from current name. */
export function getNextCopyName(blocklist) {
    const suffix = getBlocklistDuplicateSuffix();
    const name = blocklist.name;
    const root = parseCopyRoot(name);
    let base = name;
    if (root !== null) {
        const otherInChainSameContent = state.appData.blocklists.some(bl =>
            bl.id !== blocklist.id && nameInChain(bl.name, root) && sameBlocklistContent(bl.id, blocklist.id)
        );
        if (otherInChainSameContent) base = root;
    }
    const used = collectUsedDuplicateSuffixSlots(base);
    let n = 1;
    while (used.has(n)) n++;
    return truncateBlocklistName(n === 1 ? `${base} ${suffix}` : `${base} ${suffix} ${n}`);
}

/** Is this one-off block's pause live right now (open-ended pauses never expire)? */
export function isOneOffPauseActive(block, now = Date.now()) {
    return !!(block?.isPaused && (!block.pauseEndTime || block.pauseEndTime > now));
}

/**
 * Which one-off block or schedule is *running* this focus space right now, if
 * any — running meaning enforcing or due to resume on its own, i.e. not paused.
 *
 * Deliberately NOT the same question as isBlocklistEditFrictionRequired. A
 * flexible schedule sitting between segments is not edit-gated but is still
 * running, and the blocklist/allowlist mode radios stay locked for it: swapping
 * a live focus space between blocking and allowing changes what the next
 * segment enforces. Pausing is the one action that clears both.
 *
 * Doubles as "what would the editor banner's Turn off act on", which is why it
 * returns the row rather than a boolean.
 */
export function getRunningEnforcementTarget(blocklistId, now = Date.now()) {
    if (!blocklistId) return null;
    const block = state.appData.activeBlocks.find(
        b => b.blocklistId === blocklistId
            && b.startTime <= now
            && b.endTime > now
            && !isOneOffPauseActive(b, now)
    );
    if (block) return { type: 'block', block };

    const schedule = state.appData.schedules?.find(
        s => s.blocklistId === blocklistId
            && s.segments?.length > 0
            && !isSchedulePausedNow(s, now)
    );
    return schedule ? { type: 'schedule', schedule } : null;
}

/**
 * Must an edit that *loosens* this focus space be confirmed with the exit
 * challenge? Also gates deleting it outright.
 *
 * A live pause unlocks editing for both one-off blocks and schedules. This is
 * the explicit route for users who need to change an active focus space without
 * stopping it and losing its automatic resume. Expired pauses gate again.
 *
 * The one exemption is by design: a schedule with allowEditsBetweenBlocks is
 * editable while it is between segments (canEditScheduleBetweenBlocks).
 *
 * Recompute at the moment of use — a block can end, or a segment begin, while
 * the edit modal sits open.
 */
export function isBlocklistEditFrictionRequired(blocklistId, now = Date.now()) {
    if (!blocklistId) return false;
    const hasActiveBlock = state.appData.activeBlocks.some(
        b => b.blocklistId === blocklistId
            && b.startTime <= now
            && b.endTime > now
            && !isOneOffPauseActive(b, now)
    );
    if (hasActiveBlock) return true;
    const schedule = state.appData.schedules?.find(
        s => s.blocklistId === blocklistId && s.segments && s.segments.length > 0
    );
    if (!schedule) return false;
    if (isSchedulePausedNow(schedule, now)) return false;
    return !canEditScheduleBetweenBlocks(schedule, new Date(now));
}

export function cloneScheduleSegment(seg) {
    return {
        startHour: seg.startHour,
        startMinute: seg.startMinute,
        endHour: seg.endHour,
        endMinute: seg.endMinute,
        days: [...(seg.days || [])]
    };
}

export function duplicateBlocklist(id) {
    const blocklist = state.appData.blocklists.find(bl => bl.id === id);
    if (!blocklist) return;

    const newId = generateId();
    const newName = getNextCopyName(blocklist);

    const duplicate = {
        id: newId,
        name: newName,
        mode: blocklist.mode || 'blocklist',
        color: blocklist.color ?? null,
        emoji: blocklist.emoji ?? '🚫',
        websites: [...(blocklist.websites || [])],
        apps: [...getBlocklistRegularApps(blocklist)],
        iosScreenTimeSelection: cloneIOSScreenTimeSelection(getBlocklistIOSScreenTimeSelection(blocklist)),
        showItemDetails: blocklist.showItemDetails !== false,
        alwaysShowInSchedule: blocklist.alwaysShowInSchedule !== false,
        overrideDifficulty: cloneOverrideDifficulty(blocklist.overrideDifficulty)
    };

    state.appData.blocklists.unshift(duplicate);

    // A duplicated schedule starts switched off (paused until turned on), so a
    // copy never enforces anything the user did not explicitly enable.
    const sourceSchedule = state.appData.schedules?.find((s) => s.blocklistId === id);
    if (sourceSchedule?.segments?.length) {
        state.appData.schedules.push({
            id: crypto.randomUUID(),
            blocklistId: newId,
            segments: sourceSchedule.segments.map(cloneScheduleSegment),
            repeatType: sourceSchedule.repeatType === 'date' ? 'date' : 'forever',
            repeatDate: sourceSchedule.repeatType === 'date' ? (sourceSchedule.repeatDate ?? null) : null,
            createdAt: Date.now(),
            startOverlayId: sourceSchedule.startOverlayId || null,
            allowEditsBetweenBlocks: !!sourceSchedule.allowEditsBetweenBlocks,
            isPaused: true,
        });
    }

    saveData();
    render();

    // Only keep selection on the original blocklist if it was already selected (user had focused it).
    // If they duplicated from the card menu without having clicked the card first, don't switch focus to it.
    if (state.selectedBlocklistId === id) {
        const dropdown = document.getElementById('blocklist-select');
        if (dropdown) {
            dropdown.value = id;
            handleBlocklistSelect({ target: dropdown });
        }
    }
}

export const BLOCKLIST_EXPORT_FORMAT = 'redd-block-rules';
export const BLOCKLIST_EXPORT_FORMAT_VERSION = 2;

function blocklistsExportDefaultPath() {
    return `${BLOCKLIST_EXPORT_FORMAT}.json`;
}

function serializeBlocklistsExportContent(payload) {
    return `${JSON.stringify(payload, null, 2)}\n`;
}

/** iOS save() returns opaque file:// URLs; show the filename in the success dialog. */
function formatExportSuccessDestination(path) {
    if (!state.isIOS || typeof path !== 'string') return path;
    try {
        return decodeURIComponent(new URL(path).pathname.split('/').pop() || path);
    } catch {
        const segment = path.split('/').pop();
        return segment ? decodeURIComponent(segment) : path;
    }
}

function pickBlocklistsExportDestination() {
    return saveDialog({
        title: tSettings('exportBlocklistsSaveTitle'),
        defaultPath: blocklistsExportDefaultPath(),
        filters: [{ name: 'JSON', extensions: ['json'] }]
    });
}

export function serializeBlocklistForExport(blocklist) {
    const payload = {
        name: blocklist.name,
        mode: blocklist.mode || 'blocklist',
        color: blocklist.color ?? null,
        emoji: blocklist.emoji ?? '🚫',
        websites: [...(blocklist.websites || [])],
        apps: [...getBlocklistRegularApps(blocklist)],
        iosScreenTimeSelection: cloneIOSScreenTimeSelection(getBlocklistIOSScreenTimeSelection(blocklist)),
        showItemDetails: blocklist.showItemDetails !== false,
        alwaysShowInSchedule: blocklist.alwaysShowInSchedule !== false,
        overrideDifficulty: cloneOverrideDifficulty(blocklist.overrideDifficulty),
        unlockMinutes: normalizeUnlockMinutes(blocklist.unlockMinutes),
    };

    const schedule = state.appData.schedules?.find((s) => s.blocklistId === blocklist.id);
    if (schedule?.segments?.length) {
        payload.schedule = {
            segments: schedule.segments.map(cloneScheduleSegment),
            repeatType: schedule.repeatType === 'date' ? 'date' : 'forever',
            repeatDate: schedule.repeatType === 'date' ? (schedule.repeatDate ?? null) : null
        };
    }

    return payload;
}

export function buildBlocklistsExportPayload() {
    return {
        format: BLOCKLIST_EXPORT_FORMAT,
        formatVersion: BLOCKLIST_EXPORT_FORMAT_VERSION,
        exportedAt: new Date().toISOString(),
        overrideCountUnit: 'words',
        blocklists: (state.appData.blocklists || []).map(serializeBlocklistForExport)
    };
}

export function normalizeImportedScheduleSegment(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const startHour = Number(raw.startHour);
    const startMinute = Number(raw.startMinute);
    const endHour = Number(raw.endHour);
    const endMinute = Number(raw.endMinute);
    const days = Array.isArray(raw.days)
        ? raw.days.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
        : [];
    if (
        !Number.isFinite(startHour)
        || !Number.isFinite(startMinute)
        || !Number.isFinite(endHour)
        || !Number.isFinite(endMinute)
        || days.length === 0
    ) {
        return null;
    }
    return { startHour, startMinute, endHour, endMinute, days: [...days] };
}

export function normalizeImportedSchedule(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const segments = (Array.isArray(raw.segments) ? raw.segments : [])
        .map(normalizeImportedScheduleSegment)
        .filter(Boolean);
    if (segments.length === 0) return null;

    const repeatType = typeof raw.repeatType === 'string' ? raw.repeatType : 'forever';
    let repeatDate = null;
    if (repeatType === 'date' && raw.repeatDate != null) {
        repeatDate = typeof raw.repeatDate === 'number'
            ? raw.repeatDate
            : new Date(raw.repeatDate).getTime();
        if (!Number.isFinite(repeatDate)) repeatDate = null;
    }

    return {
        segments,
        repeat: { repeatType, repeatDate }
    };
}

let importedLegacyCounts = false;

function normalizeImportedDifficulty(raw) {
    const maxWords = getMaxOverrideWords();
    const parsed = Number.parseInt(raw?.count, 10);
    const countsAreChars = importedLegacyCounts && Number.isFinite(parsed) && parsed > maxWords;
    return migrateOverrideDifficultyToWords(raw, { maxWords, countsAreChars });
}

export function normalizeImportedBlocklist(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

    const websites = Array.isArray(raw.websites)
        ? raw.websites.filter((entry) => typeof entry === 'string' && entry.trim())
        : [];
    const apps = Array.isArray(raw.apps)
        ? raw.apps.filter((entry) => typeof entry === 'string' && entry.trim() && !isScreenTimeSummaryEntry(entry))
        : [];
    const schedule = normalizeImportedSchedule(raw.schedule);

    if (
        typeof raw.name !== 'string'
        && websites.length === 0
        && apps.length === 0
        && !raw.iosScreenTimeSelection
        && !schedule
    ) {
        return null;
    }

    const imported = {
        name: typeof raw.name === 'string' ? raw.name : tSettings('importBlocklistDefaultName'),
        mode: typeof raw.mode === 'string' && raw.mode.trim() ? raw.mode : 'blocklist',
        color: typeof raw.color === 'string' && raw.color.trim() ? raw.color : null,
        emoji: typeof raw.emoji === 'string' && raw.emoji.trim() ? raw.emoji : '🚫',
        websites,
        apps,
        iosScreenTimeSelection: cloneIOSScreenTimeSelection(
            getBlocklistIOSScreenTimeSelection({
                apps: raw.apps,
                iosScreenTimeSelection: raw.iosScreenTimeSelection
            })
        ),
        showItemDetails: raw.showItemDetails !== false,
        alwaysShowInSchedule: raw.alwaysShowInSchedule !== false,
        overrideDifficulty: normalizeImportedDifficulty(raw.overrideDifficulty),
        // Files from before the field existed import with the 24-hour default.
        unlockMinutes: normalizeUnlockMinutes(raw.unlockMinutes),
        schedule
    };

    return normalizeBlocklist(imported);
}

export function parseBlocklistsImportPayload(text) {
    const parsed = JSON.parse(text);
    // Files written before overrideCountUnit existed came from a desktop that
    // stored character targets (phones already stored words). Only a count
    // above today's word maximum is unambiguously characters; anything smaller
    // is kept as words, which errs toward a harder challenge.
    importedLegacyCounts = !Array.isArray(parsed) && parsed?.overrideCountUnit !== 'words';
    const rawList = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.blocklists)
            ? parsed.blocklists
            : null;
    if (!rawList) {
        throw new Error('missing blocklists array');
    }
    return rawList.map(normalizeImportedBlocklist).filter(Boolean);
}

export function uniqueImportedBlocklistName(desiredName) {
    let name = truncateBlocklistName(String(desiredName || '').trim() || tSettings('importBlocklistDefaultName'));
    if (!state.appData.blocklists.some((bl) => bl.name === name)) return name;
    return getNextCopyName({
        id: generateId(),
        name,
        websites: [],
        apps: []
    });
}

export function blocklistFromImportedEntry(entry) {
    return {
        id: generateId(),
        name: uniqueImportedBlocklistName(entry.name),
        mode: entry.mode || 'blocklist',
        color: entry.color ?? null,
        emoji: entry.emoji ?? '🚫',
        websites: [...(entry.websites || [])],
        apps: [...getBlocklistRegularApps(entry)],
        iosScreenTimeSelection: cloneIOSScreenTimeSelection(getBlocklistIOSScreenTimeSelection(entry)),
        showItemDetails: entry.showItemDetails !== false,
        alwaysShowInSchedule: entry.alwaysShowInSchedule !== false,
        overrideDifficulty: cloneOverrideDifficulty(entry.overrideDifficulty),
        unlockMinutes: normalizeUnlockMinutes(entry.unlockMinutes),
    };
}

export async function exportBlocklistsToFile() {
    try {
        const payload = buildBlocklistsExportPayload();
        const exportCount = payload.blocklists?.length ?? 0;
        if (exportCount === 0) {
            await message(tSettings('exportBlocklistsEmpty'), { title: tSettings('exportBlocklistsFailedTitle'), kind: 'info' });
            return;
        }

        const content = serializeBlocklistsExportContent(payload);

        // iOS: Tauri's save picker exports a staged Documents file, so write content there first.
        if (state.isIOS) {
            await writeTextFile(blocklistsExportDefaultPath(), content, { baseDir: BaseDirectory.Document });
        }

        const selectedPath = await pickBlocklistsExportDestination();
        if (!selectedPath || typeof selectedPath !== 'string') return;

        if (!state.isIOS) {
            await writeTextFile(selectedPath, content);
        }

        await message(
            tSettingsFmt('exportBlocklistsSuccessFmt', {
                n: exportCount,
                path: formatExportSuccessDestination(selectedPath)
            }),
            { title: tSettings('exportBlocklistsSuccessTitle'), kind: 'info' }
        );
    } catch (err) {
        console.warn('[export] blocklists:', err);
        await message(tSettings('exportBlocklistsFailed'), { title: tSettings('exportBlocklistsFailedTitle'), kind: 'error' });
    }
}

export async function importBlocklistsFromFile() {
    try {
        const selectedPath = await openDialog({
            multiple: false,
            title: tSettings('importBlocklistsOpenTitle'),
            filters: [
                { name: 'JSON', extensions: ['json'] },
                { name: 'All files', extensions: ['*'] }
            ]
        });
        if (!selectedPath || typeof selectedPath !== 'string') return;

        let importedEntries;
        try {
            importedEntries = parseBlocklistsImportPayload(await readTextFile(selectedPath));
        } catch (err) {
            console.warn('[import] parse blocklists:', err);
            await message(tSettings('importBlocklistsParseFailed'), { title: tSettings('importBlocklistsFailedTitle'), kind: 'error' });
            return;
        }

        if (importedEntries.length === 0) {
            await message(tSettings('importBlocklistsInvalidFile'), { title: tSettings('importBlocklistsFailedTitle'), kind: 'warning' });
            return;
        }

        const confirmed = await ask(
            tSettingsFmt('importBlocklistsConfirmFmt', { n: importedEntries.length }),
            { title: tSettings('importBlocklistsDialogTitle'), kind: 'warning' }
        );
        if (!confirmed) return;

        for (const entry of importedEntries) {
            const blocklist = blocklistFromImportedEntry(entry);
            state.appData.blocklists.push(blocklist);
            // Imported schedules arrive switched off (open-ended pause) so an
            // import never starts enforcing anything by itself.
            if (entry.schedule?.segments?.length) {
                state.appData.schedules.push({
                    id: crypto.randomUUID(),
                    blocklistId: blocklist.id,
                    segments: entry.schedule.segments.map(cloneScheduleSegment),
                    repeatType: entry.schedule.repeat?.repeatType === 'date' || entry.schedule.repeatType === 'date' ? 'date' : 'forever',
                    repeatDate: entry.schedule.repeat?.repeatDate ?? entry.schedule.repeatDate ?? null,
                    createdAt: Date.now(),
                    startOverlayId: null,
                    allowEditsBetweenBlocks: false,
                    isPaused: true,
                });
            }
        }

        await saveData();
        render();

        await message(
            tSettingsFmt('importBlocklistsSuccessFmt', { n: importedEntries.length }),
            { title: tSettings('importBlocklistsSuccessTitle'), kind: 'info' }
        );
    } catch (err) {
        console.warn('[import] blocklists:', err);
        await message(tSettings('importBlocklistsFailed'), { title: tSettings('importBlocklistsFailedTitle'), kind: 'error' });
    }
}

export function setupBlocklistsImportExportButtons() {
    const exportBtn = document.getElementById('settings-export-blocklists-btn');
    const importBtn = document.getElementById('settings-import-blocklists-btn');
    if (exportBtn && !exportBtn._listenerAdded) {
        exportBtn._listenerAdded = true;
        exportBtn.addEventListener('click', () => {
            void exportBlocklistsToFile();
        });
    }
    if (importBtn && !importBtn._listenerAdded) {
        importBtn._listenerAdded = true;
        importBtn.addEventListener('click', () => {
            void importBlocklistsFromFile();
        });
    }
}

// Delete blocklist with undo support
export let pendingDelete = null; // { blocklist, activeBlocks }

export const UNDO_TOAST_SECONDS = 5;
let undoToastCountdownHandle = null;

function stopUndoToastCountdown() {
    if (undoToastCountdownHandle) {
        clearInterval(undoToastCountdownHandle);
        undoToastCountdownHandle = null;
    }
}

export function dismissUndoToast() {
    stopUndoToastCountdown();
    document.getElementById('undo-toast')?.classList.add('hidden');
}

function startUndoToastCountdown(onExpire) {
    stopUndoToastCountdown();
    const countEl = document.getElementById('undo-toast-countdown');
    let remaining = UNDO_TOAST_SECONDS;
    if (countEl) countEl.textContent = String(remaining);

    undoToastCountdownHandle = setInterval(() => {
        remaining -= 1;
        if (countEl) countEl.textContent = String(remaining);
        if (remaining <= 0) {
            stopUndoToastCountdown();
            onExpire();
        }
    }, 1000);
}

export function setUndoToastMessage(prefix, emphasis, suffix = '') {
    const toast = document.getElementById('undo-toast');
    const message = document.getElementById('undo-toast-message');
    if (!toast || !message) return;
    message.replaceChildren();
    if (prefix) message.append(document.createTextNode(prefix));
    if (emphasis) {
        const strong = document.createElement('strong');
        strong.textContent = emphasis;
        message.append(strong);
    }
    if (suffix) message.append(document.createTextNode(suffix));
    toast.classList.remove('hidden');
}

export function showUndoToast(prefix, emphasis, suffix, onExpire) {
    setUndoToastMessage(prefix, emphasis, suffix);
    startUndoToastCountdown(onExpire);
}

export async function deleteBlocklist(id) {
    const blocklist = state.appData.blocklists.find(bl => bl.id === id);
    if (!blocklist) return;

    // Check if this blocklist has an active block or schedule running
    const now = Date.now();
    const hasActiveBlock = state.appData.activeBlocks.some(
        block => block.blocklistId === id && block.startTime <= now && block.endTime > now
    );
    // Deliberately NOT isBlocklistEditFrictionRequired: deleting is refused for
    // any schedule that is switched on, with no allowEditsBetweenBlocks
    // exemption. Routing it through the edit gate would make a between-segments
    // flexible schedule deletable, which is a loosening no one asked for. A
    // schedule the switch turned off (paused) is just data and can go.
    const hasActiveSchedule = state.appData.schedules?.some(
        s => s.blocklistId === id && s.segments && s.segments.length > 0 && !isSchedulePausedNow(s, now)
    );

    if (hasActiveBlock) {
        alert(tSettingsFmt('deleteBlocklistDeniedActiveBlockFmt', { name: blocklist.name }));
        return;
    }

    if (hasActiveSchedule) {
        alert(tSettingsFmt('deleteBlocklistDeniedActiveScheduleFmt', { name: blocklist.name }));
        return;
    }

    // If there's already a pending delete, commit it first
    if (pendingDelete) {
        commitDelete();
    }
    commitSegmentDelete();

    // Store the blocklist, its blocks and its (switched-off) schedules for undo
    const activeBlocksToRemove = state.appData.activeBlocks.filter(b => b.blocklistId === id);
    const schedulesToRemove = (state.appData.schedules || []).filter(s => s.blocklistId === id);

    // Remove from data (soft delete)
    state.appData.blocklists = state.appData.blocklists.filter(bl => bl.id !== id);
    state.appData.activeBlocks = state.appData.activeBlocks.filter(b => b.blocklistId !== id);
    state.appData.schedules = (state.appData.schedules || []).filter(s => s.blocklistId !== id);
    expandedBlocklistCardIds.delete(id);
    void saveData();

    // If the deleted blocklist was the selected one, reset the scheduler UI
    if (state.selectedBlocklistId === id) {
        state.selectedBlocklistId = null;
        const blocklistSelect = document.getElementById('blocklist-select');
        blocklistSelect.value = '';
        handleBlocklistSelect({ target: blocklistSelect });
    }

    // Re-render immediately
    render();

    showUndoToast(
        tSettings('deleteUndoToastPrefix'),
        blocklist.name,
        tSettings('deleteUndoToastSuffix'),
        () => commitDelete(),
    );

    pendingDelete = {
        blocklist,
        activeBlocks: activeBlocksToRemove,
        schedules: schedulesToRemove,
    };
}

export function commitDelete() {
    if (!pendingDelete) return;

    if (pendingDelete.activeBlocks.length > 0) {
        updateHostsFile();
    }

    dismissUndoToast();
    pendingDelete = null;
}

export function undoDelete() {
    if (!pendingDelete) return;

    // Restore the blocklist and active blocks
    state.appData.blocklists.push(pendingDelete.blocklist);
    pendingDelete.activeBlocks.forEach(block => {
        state.appData.activeBlocks.push(block);
    });
    (pendingDelete.schedules || []).forEach(schedule => {
        state.appData.schedules.push(schedule);
    });
    void saveData();

    dismissUndoToast();
    pendingDelete = null;

    // Re-render
    render();
}

// Main render function

// Render blocklists
export function renderBlocklists() {
    closeAllBlocklistMenus();
    const container = document.getElementById('blocklists-container');
    const visibleBlocklists = getVisibleBlocklists();

    if (!didDefaultExpandSoleCard) {
        if (visibleBlocklists.length === 1 && blocklistCardHasExpandableSummary(visibleBlocklists[0])) {
            expandedBlocklistCardIds.add(visibleBlocklists[0].id);
            didDefaultExpandSoleCard = true;
        } else if (visibleBlocklists.length >= 1) {
            didDefaultExpandSoleCard = true;
        }
    }

    if (visibleBlocklists.length === 0) {
        container.innerHTML = `
      <div class="no-active-blocks clickable" id="empty-blocklists-cta" style="cursor: pointer;">
        <p>${tSettings('noBlocklistsYet')}</p>
        <p class="subtle">${tSettings('clickHereCreateBlocklist')}</p>
      </div>
    `;
        document.getElementById('empty-blocklists-cta').addEventListener('click', () => {
            openBlocklistModal();
        });
        return;
    }

    container.innerHTML = visibleBlocklists.map(bl => {
        const metaHtml = buildBlocklistCardMetaHtml(bl);
        const isExpanded = expandedBlocklistCardIds.has(bl.id);
        const showDetails = blocklistCardHasExpandableSummary(bl);
        const detailsHtml = showDetails ? buildBlocklistCardDetailsHtml(bl, { expanded: isExpanded }) : '';

        // Get color for left border
        const borderColor = bl.color || 'linear-gradient(135deg, #4a00e0 0%, #8e2de2 100%)';

        // Check if this blocklist has an active block
        const now = Date.now();
        const activeBlock = state.appData.activeBlocks.find(b => b.blocklistId === bl.id && b.startTime <= now && b.endTime > now);
        const isActive = !!activeBlock;

        // Check if this blocklist has a schedule
        const hasSchedule = state.appData.schedules && state.appData.schedules.some(s => s.blocklistId === bl.id);

        const activeClass = isActive ? ' blocklist-card-active' : (hasSchedule ? ' blocklist-card-scheduled' : '');

        const statusLineHtml = buildBlocklistCardStatusLine(bl, now);

        const isSelected = isBlocklistCardVisuallySelected(bl.id);
        const selectedClass = isSelected ? ' selected' : '';
        const expandedClass = isExpanded ? ' blocklist-card-expanded' : '';
        const accent = bl.color || '#667eea';
        const selectedStyle = isSelected
            ? `style="border-top-color: ${accent}; border-right-color: ${accent}; border-bottom-color: ${accent}; border-left-width: 0; box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1);"`
            : '';
        const enteringChipColor = getEnteringChipColor(accent);
        const enteringChip = isSelected
            ? `<span class="blocklist-entering-chip" style="background-color: ${enteringChipColor}">${tSettings('blocklistEnteringChip')}</span>`
            : '';

        const switchOn = isFocusSpaceOn(bl.id, now);
        const switchLabel = tSettingsFmt(switchOn ? 'switchTurnOffFmt' : 'switchTurnOnFmt', { name: bl.name });
        const switchHtml = `<button type="button" class="blocklist-switch${switchOn ? ' on' : ''}" role="switch" aria-checked="${switchOn ? 'true' : 'false'}" title="${escapeHtml(switchLabel)}" aria-label="${escapeHtml(switchLabel)}" data-id="${bl.id}"><span class="blocklist-switch-knob" aria-hidden="true"></span></button>`;

        return `
      <div class="blocklist-card${activeClass}${selectedClass}${expandedClass}" data-id="${bl.id}" data-active="${isActive}" ${selectedStyle}>
        ${enteringChip}
        <div class="blocklist-stripe" style="background: ${borderColor}"></div>
        <div class="blocklist-card-body">
          <div class="blocklist-card-header">
            <div class="blocklist-card-title-row">
              <div class="blocklist-name">
                <span class="blocklist-emoji">${bl.emoji || '🚫'}</span>
                <span class="blocklist-title-text">${escapeHtml(bl.name)}</span>
              </div>
              <div class="blocklist-actions">
                ${switchHtml}
              </div>
            </div>
            <div class="blocklist-meta">${metaHtml}</div>
            ${statusLineHtml}
          </div>
          ${detailsHtml}
        </div>
      </div>
    `;
    }).join('');

    // Add event listeners
    container.querySelectorAll('.blocklist-card').forEach(card => {
        const id = card.dataset.id;
        const isActive = card.dataset.active === 'true';

        // Everywhere on the card except the switch selects the space, which
        // shows its editor: inline on desktop, as a full-screen sheet on phones and
        // single-column desktop windows.
        card.addEventListener('click', (e) => {
            if (e.target.closest('.blocklist-meta-items-btn')) return;
            if (e.target.closest('.blocklist-actions')) return;
            closeAllBlocklistMenus();
            void openBlocklistEnterFromCard(id);
        });

        // The switch: on is immediate, off goes through the override challenge.
        card.querySelector('.blocklist-switch')?.addEventListener('click', (e) => {
            e.stopPropagation();
            closeAllBlocklistMenus();
            void setFocusSpaceEnabled(id, !isFocusSpaceOn(id));
        });

        // Desktop: Duplicate / Delete live on right-click.
        card.addEventListener('contextmenu', (e) => {
            if (document.body.classList.contains('handset-device')) return;
            e.preventDefault();
            e.stopPropagation();
            openBlocklistContextMenu(id, e.clientX, e.clientY);
        });

        const summaryBtn = card.querySelector('.blocklist-meta-items-btn');
        if (summaryBtn) {
            if (expandedBlocklistCardIds.has(id)) summaryBtn.setAttribute('aria-expanded', 'true');
            summaryBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                toggleBlocklistCardExpanded(card, id);
            });
        }

        // Drag and drop using mouse events on document
        card.addEventListener('mousedown', (e) => {
            // Don't start drag if clicking on buttons
            if (e.target.closest('.blocklist-switch') || e.target.closest('.blocklist-menu')) return;
            if (e.target.closest('.blocklist-meta-items-btn')) return;
            if (e.target.closest('.blocklist-actions')) return;
            if (e.button !== 0) return; // Only left click

            e.preventDefault(); // Prevent text selection

            const startY = e.clientY;
            let isDragging = false;
            const container = document.getElementById('blocklists-container');


            const onMouseMove = (moveEvent) => {
                // Only start dragging after moving 5px
                if (!isDragging && Math.abs(moveEvent.clientY - startY) > 5) {
                    isDragging = true;
                    card.classList.add('dragging');
                }

                if (!isDragging) return;

                const siblings = [...container.querySelectorAll('.blocklist-card:not(.dragging)')];
                const nextSibling = siblings.find(sibling => {
                    const rect = sibling.getBoundingClientRect();
                    return moveEvent.clientY < rect.top + rect.height / 2;
                });


                if (nextSibling) {
                    container.insertBefore(card, nextSibling);
                } else {
                    container.appendChild(card);
                }
            };

            const onMouseUp = () => {
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
                card.classList.remove('dragging');

                if (isDragging) {
                    saveBlocklistOrderFromDOM();
                }
            };

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });
    });
}

/// Pre-select the sole blocklist as the default state. Skipped if the
/// user has explicitly deselected this session (so click-outside / ESC
/// stay sticky). Pass `force: true` to clear that flag — used when the
/// user just *created* a new blocklist, which is a strong "I want to
/// use this" signal.
export function autoSelectSoleBlocklist({ force = false } = {}) {
    const visible = getVisibleBlocklists();
    if (visible.length !== 1) return;
    if (state.selectedBlocklistId) return;
    if (force) state.userExplicitlyDeselected = false;
    if (state.userExplicitlyDeselected) return;
    const dropdown = document.getElementById('blocklist-select');
    if (!dropdown) return;
    dropdown.value = visible[0].id;
    handleBlocklistSelect({ target: dropdown });
}


/** One shared right-click menu (Duplicate / Delete) for desktop cards. */
function getBlocklistContextMenu() {
    let menu = document.getElementById('blocklist-context-menu');
    if (menu) return menu;
    menu = document.createElement('div');
    menu.id = 'blocklist-context-menu';
    menu.className = 'blocklist-menu blocklist-context-menu hidden';
    menu.setAttribute('role', 'menu');
    menu.innerHTML = `
        <button type="button" class="blocklist-menu-item duplicate-blocklist-item" role="menuitem">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>
            <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>
          </svg>
          <span class="context-duplicate-label"></span>
        </button>
        <button type="button" class="blocklist-menu-item delete-blocklist-item" role="menuitem">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M3 6h18"></path>
            <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path>
            <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path>
          </svg>
          <span class="context-delete-label"></span>
        </button>`;
    menu.querySelector('.duplicate-blocklist-item').addEventListener('click', (e) => {
        e.stopPropagation();
        const id = menu.dataset.blocklistId;
        closeAllBlocklistMenus();
        if (id) duplicateBlocklist(id);
    });
    menu.querySelector('.delete-blocklist-item').addEventListener('click', (e) => {
        e.stopPropagation();
        const id = menu.dataset.blocklistId;
        closeAllBlocklistMenus();
        if (id) void deleteBlocklist(id);
    });
    document.body.appendChild(menu);
    return menu;
}

export function openBlocklistContextMenu(blocklistId, clientX, clientY) {
    const menu = getBlocklistContextMenu();
    menu.dataset.blocklistId = blocklistId;
    menu.querySelector('.context-duplicate-label').textContent = tSettings('blocklistCardDuplicate');
    menu.querySelector('.context-delete-label').textContent = tSettings('blocklistCardDelete');
    menu.classList.remove('hidden');

    const padding = 8;
    const rect = menu.getBoundingClientRect();
    const left = Math.max(padding, Math.min(clientX, window.innerWidth - rect.width - padding));
    const top = Math.max(padding, Math.min(clientY, window.innerHeight - rect.height - padding));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
}

export function closeAllBlocklistMenus() {
    document.getElementById('blocklist-context-menu')?.classList.add('hidden');
}

// Save blocklist order based on DOM position
export function saveBlocklistOrderFromDOM() {
    const container = document.getElementById('blocklists-container');
    if (!container) return;

    const cardElements = Array.from(container.querySelectorAll('.blocklist-card'));
    const newOrder = cardElements.map(card => card.dataset.id);

    // Reorder state.appData.blocklists to match
    const reorderedBlocklists = [];
    newOrder.forEach(id => {
        const blocklist = state.appData.blocklists.find(bl => bl.id === id);
        if (blocklist) {
            reorderedBlocklists.push(blocklist);
        }
    });

    // Add any blocklists that weren't in the DOM
    state.appData.blocklists.forEach(bl => {
        if (!reorderedBlocklists.find(r => r.id === bl.id)) {
            reorderedBlocklists.push(bl);
        }
    });

    state.appData.blocklists = reorderedBlocklists;
    saveData();

    // Re-render the bits of UI that mirror blocklist order. Don't call full render() —
    // the cards are already in the right order in the DOM (the user just dropped them
    // there), and a full re-render would briefly flicker.
    renderNowBlockingRow();
    renderScheduleVisibilityChips();
}
