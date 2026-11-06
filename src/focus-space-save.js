import { generateId } from './app.js';
import { ensureIOSAllowlistStartable } from './allowlist-ios.js';
import { updateBlockedApps } from './blocking-platform.js';
import { ensureIOSBlocklistSelectionReady, getBlocklistIOSScreenTimeSelection, resolveIOSScreenTimeSelectionForSave } from './blocklist-utils.js';
import { expandBlocklistCard, isBlocklistEditFrictionRequired, renderBlocklists, truncateBlocklistName } from './blocklists.js';
import { closeBlocklistModal, deselectBlocklist, handleBlocklistSelect, isEnterSchedulerModalOpen } from './confirm-modals.js';
import { applyEditorScheduleForBlocklist, getWhenToBlockKind, isEditorInCreateModal, populateFocusSpaceEditor, setOpenEditorSection } from './focus-space-editor.js';
import { confirmModalWebsiteInputValue, confirmPendingAppOnSave } from './focus-space-tags.js';
import { tSettings } from './i18n.js';
import { getSelectedBlocklistModalMode } from './list-mode.js';
import { normalizeCustomOverrideText, normalizeOverrideCount, normalizeOverrideType, resolveActiveOverrideDifficulty } from './override-challenge.js';
import { saveData, updateHostsFile } from './persistence.js';
import { renderBlocklistSelector, renderScheduleAlwaysOnRow, renderWeekBlocks } from './render.js';
import { syncSchedulesToHelper } from './schedule-engine.js';
import { state } from './state.js';

function readFocusSpace(tags) {
    const nameInput = document.getElementById('blocklist-name');
    const name = truncateBlocklistName(nameInput.value.trim());
    const nameEmpty = !name;
    if (nameEmpty) {
        nameInput.classList.add('input-error');
    } else {
        nameInput.classList.remove('input-error');
    }

    // Auto-confirm any pending website input using the same validation flow as Enter/Space.
    let websiteInvalid = false;
    const pendingWebsiteRaw = tags.websiteInput.value.trim();
    if (pendingWebsiteRaw) {
        const result = confirmModalWebsiteInputValue(tags);
        if (result?.hadProtected) return;
        if (result?.websiteInvalid) websiteInvalid = true;
    }

    const overrideType = document.getElementById('override-type').value;
    const customTextArea = document.getElementById('custom-override-text');
    const customText = normalizeCustomOverrideText(customTextArea.value);
    customTextArea.value = customText;
    const customEmpty = overrideType === 'custom' && !customText;
    const customErrorEl = document.getElementById('custom-override-text-error');
    if (customEmpty) {
        customTextArea.classList.add('input-error');
        if (customErrorEl) {
            customErrorEl.textContent = tSettings('customOverrideEmptyError');
            customErrorEl.classList.remove('hidden');
        }
    } else {
        customTextArea.classList.remove('input-error');
        customErrorEl?.classList.add('hidden');
    }

    if (nameEmpty || websiteInvalid || customEmpty) return;

    nameInput.value = name;

    confirmPendingAppOnSave(tags);

    const mode = getSelectedBlocklistModalMode();
    const overrideCountInput = document.getElementById('override-count');
    const overrideCount = normalizeOverrideCount(overrideCountInput.value, 'random-words');
    overrideCountInput.value = overrideCount;
    const selectedSwatch = document.querySelector('.color-swatch.selected');
    const color = selectedSwatch ? selectedSwatch.dataset.color : null;
    const selectedEmoji = document.querySelector('.emoji-swatch.selected');
    const emoji = selectedEmoji ? selectedEmoji.dataset.emoji : '📱';

    const showItemDetails = document.getElementById('show-item-details-checkbox').checked;
    // Preserve the blocklist's existing schedule visibility (toggled via the chips above the
    // schedule); default to true for new blocklists.
    const existingBlocklistForSave = state.editingBlocklistId
        ? state.appData.blocklists.find(bl => bl.id === state.editingBlocklistId)
        : null;
    const alwaysShowInSchedule = existingBlocklistForSave?.alwaysShowInSchedule !== false;

    const overrideDifficultyPayload = {
        type: normalizeOverrideType(overrideType),
        count: overrideCount,
        customText: customText
    };

    // Save is the authoritative enforcement boundary. The picker and undo
    // can leave a candidate that was valid while paused or between schedule
    // segments; recompute friction now so a later resume/start cannot turn
    // that stale candidate into a removal.
    const iosScreenTimeSelectionForSave = resolveIOSScreenTimeSelectionForSave(
        getBlocklistIOSScreenTimeSelection(existingBlocklistForSave),
        tags.iosSelection,
        {
            mode,
            editFrictionRequired: state.isIOS
                && !!state.editingBlocklistId
                && isBlocklistEditFrictionRequired(state.editingBlocklistId),
        },
    );

    // IMPORTANT: Create copies of the arrays, not references!
    return {
        id: state.editingBlocklistId || generateId(),
        name,
        mode,
        color,
        emoji,
        websites: [...tags.websites],
        apps: [...tags.apps],
        iosScreenTimeSelection: iosScreenTimeSelectionForSave,
        showItemDetails,
        alwaysShowInSchedule,
        overrideDifficulty: overrideDifficultyPayload,
        ...(existingBlocklistForSave?.unlockMinutes !== undefined ? { unlockMinutes: existingBlocklistForSave.unlockMinutes } : {}),
    };
}

// The create modal's Save button and the panel's Save changes both land here.
export async function saveFocusSpace(tags) {
    const blocklist = readFocusSpace(tags);
    if (!blocklist) return;

    // Daily / Weekly spaces activate on save, so the same platform checks
    // that used to guard "Start schedule" apply here.
    if (getWhenToBlockKind() !== 'manual') {
        if (!ensureIOSBlocklistSelectionReady(blocklist, 'saving this schedule')) return;
        if (!await ensureIOSAllowlistStartable(blocklist)) return;
    }

    // Recheck after asynchronous platform validation, immediately before committing.
    const currentSavedSpace = state.appData.blocklists.find(bl => bl.id === state.editingBlocklistId);
    blocklist.overrideDifficulty = resolveActiveOverrideDifficulty(
        currentSavedSpace?.overrideDifficulty, blocklist.overrideDifficulty,
        !!currentSavedSpace && isBlocklistEditFrictionRequired(currentSavedSpace.id),
    );
    if (state.editingBlocklistId) {
        const idx = state.appData.blocklists.findIndex(bl => bl.id === state.editingBlocklistId);
        if (idx !== -1) {
            state.appData.blocklists[idx] = blocklist;
        }
    } else {
        // New spaces go to the top of the focus list.
        state.appData.blocklists.unshift(blocklist);
    }

    applyEditorScheduleForBlocklist(blocklist.id);

    await saveData();

    // If this blocklist is active (block or schedule), update blocking rules immediately
    const now = Date.now();
    const hasActiveBlock = state.appData.activeBlocks.some(
        b => b.blocklistId === blocklist.id && b.startTime <= now && b.endTime > now
    );
    const hasActiveSchedule = state.appData.schedules?.some(
        s => s.blocklistId === blocklist.id && s.segments && s.segments.length > 0
    );

    if (hasActiveBlock || hasActiveSchedule) {
        // Wait for edited rules to reach enforcement before completing the save.
        await updateHostsFile();
        await syncSchedulesToHelper();
        await updateBlockedApps();
    } else if (state.isIOS) {
        // Switched to Manual: its old schedule's monitors and start warnings go now.
        await syncSchedulesToHelper();
    }

    refreshAfterFocusSpaceSave(blocklist);
}

function refreshAfterFocusSpaceSave(blocklist) {
    // Keep live preview while editing, but don't revert after a confirmed save.
    state.blocklistModalPreviewSnapshot = null;
    const wasNewBlocklist = !state.editingBlocklistId;
    if (isEditorInCreateModal()) {
        closeBlocklistModal();
    } else {
        // Saving is not a reset: keep the section the user is working in.
        // Populating closes every section, which on a narrow window also
        // changes the sheet's height and can bounce it shut.
        const openSection = state.openEditorSection;
        populateFocusSpaceEditor(blocklist);
        setOpenEditorSection(openSection);
    }

    // Only update blocklist display without resetting schedule segments
    renderBlocklists();
    renderBlocklistSelector();
    renderWeekBlocks(); // Refresh calendar so colour / emoji / name changes propagate
    renderScheduleAlwaysOnRow();

    if (wasNewBlocklist) {
        // Land back on the list, not in the editor we just left: the new
        // card carries its own switch, and a scheduled space needs no start.
        deselectBlocklist();
        requestAnimationFrame(() => {
            const card = document.querySelector(`.blocklist-card[data-id="${blocklist.id}"]`);
            if (!card) return;
            card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            card.classList.add('blocklist-card-just-created');
            card.addEventListener('animationend', () => card.classList.remove('blocklist-card-just-created'), { once: true });
        });
    } else if (isEnterSchedulerModalOpen()) {
        deselectBlocklist();
        expandBlocklistCard(blocklist.id);
    } else if (state.selectedBlocklistId) {
        // Edit existing: refresh controls only, never auto-open enter.
        const dropdown = document.getElementById('blocklist-select');
        if (dropdown) {
            dropdown.value = state.selectedBlocklistId;
            // handleBlocklistSelect defaults openEnterUi to false, and the
            // sheet sync reads "not opening" as "close it" — which on a
            // narrow window shut the editor and landed the user back on the
            // list every time they saved. Keep whatever state it is in.
            handleBlocklistSelect({ target: dropdown }, { openEnterUi: isEnterSchedulerModalOpen() });
        }
    }
}
