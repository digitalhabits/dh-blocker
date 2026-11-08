import { pushModalUndo } from './app.js';
import { openInstalledAppsPicker } from './apps-picker.js';
import {
    cloneIOSScreenTimeSelection, displayNameForBlockedApp, formatIOSScreenTimeSelectionLabel,
    getBlocklistIOSScreenTimeSelection, isIOSSelectionNarrowing, isProtectedApp,
    isProtectedDomain, mergeIOSScreenTimeSelectionAdditive, normalizeIOSScreenTimeSelection,
} from './blocklist-utils.js';
import { isBlocklistEditFrictionRequired } from './blocklists.js';
import { setupFocusSpaceNameField } from './focus-space-editor-fields.js';
import { notifyEditorChanged } from './focus-space-editor.js';
import { tSettings } from './i18n.js';
import { getSelectedBlocklistModalMode, syncModalAppPlaceholder, syncModalWebsitePlaceholder, updateAllowlistScopeHints } from './list-mode.js';
import { countIOSScreenTimeSelectionItems } from './list-presentation.js';
import { state } from './state.js';
import { tauriAPI } from './tauri-api.js';
import { escapeHtml } from './utils.js';
import { cleanDomainInput, isValidDomain, processWebsiteInput, setupWebsitesImportMenu } from './website-input.js';

export function setupFocusSpaceTagEditors() {
    // Keep both arrays stable for the lifetime of the shared editor.
    const tags = {
        websites: [],
        apps: [],
        iosSelection: null,
        websiteInput: document.getElementById('modal-website-input'),
        appInput: document.getElementById('modal-app-input'),
        websiteContainer: document.getElementById('modal-websites-tags'),
        appContainer: document.getElementById('modal-apps-tags'),
        // Track selection by value so it survives re-rendering.
        selectedWebsites: new Set(),
        selectedApps: new Set(),
    };

    focusInputOnTagAreaClick(tags.websiteContainer, tags.websiteInput);
    focusInputOnTagAreaClick(tags.appContainer, tags.appInput);
    setupFocusSpaceNameField(tags.websiteInput);
    setupWebsiteInput(tags);
    setupAppInput(tags);
    setupAppPicker(tags);
    return tags;
}

// Make the tags+input area feel like a single email-to-field: clicking
// anywhere in the tags container (between chips, after the last chip,
// empty space) focuses the matching input so the user can immediately
// press Backspace to delete the last tag.
function focusInputOnTagAreaClick(tagsContainer, input) {
    if (!tagsContainer || !input) return;
    const wrapper = tagsContainer.closest('.tags-input-container');
    if (!wrapper) return;
    wrapper.addEventListener('click', (e) => {
        if (e.target === input) return;
        // Don't hijack clicks on chips, the X buttons, or the trailing
        // browse/import button — they all have their own click semantics.
        if (e.target.closest('.tag')) return;
        if (e.target.closest('button')) return;
        input.focus();
    });
}

// Running allow mode (lockLastItems): only the last website/app and the iOS "N apps" tag are locked.
function isWebsiteLocked(tags, w) {
    return (Array.isArray(window.lockedWebsites) && window.lockedWebsites.includes(w))
        || (!!window.lockLastItems && tags.websites.length === 1);
}
function isAppLocked(tags, a) {
    return (Array.isArray(window.lockedApps) && window.lockedApps.includes(a))
        || (!!window.lockLastItems && !!a && (a === formatIOSScreenTimeSelectionLabel(tags.iosSelection) || tags.apps.length === 1));
}

function getModalDisplayApps(tags) {
    const displayApps = tags.apps.map(displayNameForBlockedApp);
    const screenTimeLabel = formatIOSScreenTimeSelectionLabel(tags.iosSelection);
    if (screenTimeLabel) {
        displayApps.push(screenTimeLabel);
    }
    return displayApps;
}

function getModalLockedAppDisplayItems(tags) {
    const screenTimeLabel = formatIOSScreenTimeSelectionLabel(tags.iosSelection);
    return [...(window.lockedApps || []), ...tags.apps.filter(app => isAppLocked(tags, app)), ...(isAppLocked(tags, screenTimeLabel) ? [screenTimeLabel] : [])]
        .map((app) => (app === screenTimeLabel ? app : displayNameForBlockedApp(app)));
}

function clearWebsiteSelection(tags) {
    if (tags.selectedWebsites.size === 0) return false;
    tags.selectedWebsites.clear();
    window.renderModalTags();
    return true;
}
function clearAppSelection(tags) {
    if (tags.selectedApps.size === 0) return false;
    tags.selectedApps.clear();
    window.renderModalTags();
    return true;
}

function selectAllUnlockedWebsites(tags) {
    tags.selectedWebsites.clear();
    tags.websites.forEach(w => {
        if (!isWebsiteLocked(tags, w)) tags.selectedWebsites.add(w);
    });
    window.renderModalTags();
}
function selectAllUnlockedApps(tags) {
    tags.selectedApps.clear();
    tags.apps.forEach(a => {
        if (!isAppLocked(tags, a)) tags.selectedApps.add(displayNameForBlockedApp(a));
    });
    // Also include the iOS Screen Time aggregate label if present.
    const iosLabel = formatIOSScreenTimeSelectionLabel(tags.iosSelection);
    if (iosLabel && !isAppLocked(tags, iosLabel)) tags.selectedApps.add(iosLabel);
    window.renderModalTags();
}

// Bulk-delete every selected website. Pushes a single undo entry that
// restores all of them at once, matching the user's "select-all then
// backspace" mental model in a text editor.
function deleteSelectedWebsites(tags) {
    if (tags.selectedWebsites.size === 0) return false;
    const toDelete = tags.websites.filter(w => tags.selectedWebsites.has(w) && !isWebsiteLocked(tags, w));
    if (window.lockLastItems && toDelete.length === tags.websites.length) toDelete.pop();
    if (toDelete.length === 0) {
        tags.selectedWebsites.clear();
        window.renderModalTags();
        return false;
    }
    const restoreCopy = [...toDelete];
    pushModalUndo('website-bulk', () => {
        restoreCopy.forEach(w => {
            if (!tags.websites.includes(w)) tags.websites.push(w);
        });
        window.renderModalTags();
    });
    toDelete.forEach(w => {
        const i = tags.websites.indexOf(w);
        if (i !== -1) tags.websites.splice(i, 1);
    });
    tags.selectedWebsites.clear();
    window.renderModalTags();
    return true;
}

// Arrow-key navigation through chips, like an email-to field.
//   direction === -1  → ArrowLeft  (move selection left, or pull last chip
//                       into selection when selection is empty)
//   direction === +1  → ArrowRight (move selection right, deselect & return
//                       focus to the input if past the last chip)
// Returns:
//   'moved'      — selection changed
//   'deselected' — past the last chip; selection was cleared
//   false        — nothing happened
function moveSelectionInList(list, lockedFn, selection, direction) {
    if (selection.size === 0) {
        if (direction === -1) {
            for (let i = list.length - 1; i >= 0; i--) {
                if (!lockedFn(list[i])) {
                    selection.add(list[i]);
                    return 'moved';
                }
            }
        }
        return false;
    }

    const selectedIdx = [];
    list.forEach((item, idx) => {
        if (selection.has(item)) selectedIdx.push(idx);
    });
    if (selectedIdx.length === 0) return false;

    if (direction === -1) {
        let next = selectedIdx[0] - 1;
        while (next >= 0 && lockedFn(list[next])) next--;
        if (next < 0) {
            // At the start: collapse a multi-selection onto the leftmost
            // chip; otherwise nothing to do.
            if (selectedIdx.length > 1) {
                selection.clear();
                selection.add(list[selectedIdx[0]]);
                return 'moved';
            }
            return false;
        }
        selection.clear();
        selection.add(list[next]);
        return 'moved';
    }

    // direction === +1 (ArrowRight)
    let next = selectedIdx[selectedIdx.length - 1] + 1;
    while (next < list.length && lockedFn(list[next])) next++;
    if (next >= list.length) {
        selection.clear();
        return 'deselected';
    }
    selection.clear();
    selection.add(list[next]);
    return 'moved';
}

function moveWebsiteSelection(tags, direction) {
    const result = moveSelectionInList(tags.websites, website => isWebsiteLocked(tags, website), tags.selectedWebsites, direction);
    if (result) {
        window.renderModalTags();
        if (result === 'deselected') tags.websiteInput.focus();
    }
    return result;
}
function moveAppSelection(tags, direction) {
    const displayApps = getModalDisplayApps(tags);
    const lockedDisplay = new Set(getModalLockedAppDisplayItems(tags));
    const isDisplayLocked = (displayName) => lockedDisplay.has(displayName);
    const result = moveSelectionInList(displayApps, isDisplayLocked, tags.selectedApps, direction);
    if (result) {
        window.renderModalTags();
        if (result === 'deselected') tags.appInput.focus();
    }
    return result;
}

function deleteSelectedApps(tags) {
    if (tags.selectedApps.size === 0) return false;
    const iosLabel = formatIOSScreenTimeSelectionLabel(tags.iosSelection);
    const toDeleteApps = tags.apps.filter(
        a => tags.selectedApps.has(displayNameForBlockedApp(a)) && !isAppLocked(tags, a),
    );
    if (window.lockLastItems && toDeleteApps.length === tags.apps.length) toDeleteApps.pop();
    const shouldDeleteIos = iosLabel && tags.selectedApps.has(iosLabel) && !isAppLocked(tags, iosLabel);
    if (toDeleteApps.length === 0 && !shouldDeleteIos) {
        tags.selectedApps.clear();
        window.renderModalTags();
        return false;
    }
    const previousIosSelection = shouldDeleteIos ? cloneIOSScreenTimeSelection(tags.iosSelection) : null;
    const restoredApps = [...toDeleteApps];
    pushModalUndo('app-bulk', () => {
        restoredApps.forEach(a => {
            if (!tags.apps.includes(a)) tags.apps.push(a);
        });
        if (previousIosSelection) {
            tags.iosSelection = cloneIOSScreenTimeSelection(previousIosSelection);
        }
        window.renderModalTags();
    });
    toDeleteApps.forEach(a => {
        const i = tags.apps.indexOf(a);
        if (i !== -1) tags.apps.splice(i, 1);
    });
    if (shouldDeleteIos) tags.iosSelection = null;
    tags.selectedApps.clear();
    window.renderModalTags();
    return true;
}

export function confirmModalWebsiteInputValue(tags) {
    const raw = tags.websiteInput.value.trim();
    if (!raw) return null;

    const result = processWebsiteInput(raw);
    const errorMsg = document.getElementById('website-input-error');

    if (result.websiteInvalid) {
        if (errorMsg) {
            errorMsg.classList.remove('hidden');
            setTimeout(() => errorMsg.classList.add('hidden'), 3000);
        }
    } else if (errorMsg) {
        errorMsg.classList.add('hidden');
    }

    if (result.hadProtected) {
        tags.websiteInput.placeholder = tSettings('cannotBlockDomainPlaceholder');
        tags.websiteInput.classList.add('input-error');
        setTimeout(() => {
            tags.websiteInput.placeholder = tSettings('placeholderWebsiteExample');
            tags.websiteInput.classList.remove('input-error');
        }, 2000);
    }

    if (result.toAdd.length > 0) {
        const toAddCopy = [...result.toAdd];
        pushModalUndo('website', () => {
            toAddCopy.forEach(w => {
                const i = tags.websites.indexOf(w);
                if (i !== -1) tags.websites.splice(i, 1);
            });
            window.renderModalTags();
        });
        result.toAdd.forEach(website => {
            if (!tags.websites.includes(website)) tags.websites.push(website);
        });
        window.renderModalTags();
    }
    tags.websiteInput.value = result.inputValueToSet;
    return result;
}

function setupWebsiteInput(tags) {
    tags.websiteInput.addEventListener('keydown', (e) => {
        const accel = e.metaKey || e.ctrlKey;

        // Cmd/Ctrl-A in an empty input → select all unlocked website tags.
        // Caret in input + text present keeps the native "select text" behaviour.
        if (accel && (e.key === 'a' || e.key === 'A') && !tags.websiteInput.value.length) {
            e.preventDefault();
            selectAllUnlockedWebsites(tags);
            return;
        }

        // Arrow navigation. ArrowLeft from an empty input pulls the last chip
        // into selection; ArrowLeft/Right with an active selection walks the
        // chip list. With caret-in-text, fall through to the default behaviour.
        if (e.key === 'ArrowLeft' && !accel && !tags.websiteInput.value.length && tags.selectedWebsites.size === 0) {
            if (moveWebsiteSelection(tags, -1)) e.preventDefault();
            return;
        }
        if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !accel && tags.selectedWebsites.size > 0) {
            if (moveWebsiteSelection(tags, e.key === 'ArrowLeft' ? -1 : 1)) e.preventDefault();
            return;
        }

        // Backspace/Delete with active selection → bulk delete.
        if ((e.key === 'Backspace' || e.key === 'Delete') && tags.selectedWebsites.size > 0) {
            e.preventDefault();
            deleteSelectedWebsites(tags);
            return;
        }

        // Backspace on empty input removes the last website tag (if not locked)
        if (e.key === 'Backspace' && !tags.websiteInput.value.length && tags.websites.length > 0) {
            const lastIdx = tags.websites.length - 1;
            const last = tags.websites[lastIdx];
            if (!isWebsiteLocked(tags, last)) {
                pushModalUndo('website', () => {
                    tags.websites.splice(lastIdx, 0, last);
                    window.renderModalTags();
                });
                tags.websites.splice(lastIdx, 1);
                window.renderModalTags();
                e.preventDefault();
            }
        }

        // Any printable key with an active selection clears it so the user can
        // keep typing without nuking their tags.
        if (tags.selectedWebsites.size > 0 && !accel && e.key.length === 1) {
            clearWebsiteSelection(tags);
        }
        // Enter or Space confirms the website(s) — supports multiple domains separated by space, newline, or comma
        if ((e.key === 'Enter' || e.key === ' ') && tags.websiteInput.value.trim()) {
            e.preventDefault();
            confirmModalWebsiteInputValue(tags);
        }
    });

    setupWebsitesImportMenu({
        addDomainsToModal: (rawDomains) => {
            // Validate, drop protected, drop dupes — same filtering rules as
            // the manual input keydown path.
            const cleaned = (rawDomains || [])
                .map(d => cleanDomainInput(d))
                .filter(d => isValidDomain(d) && !isProtectedDomain(d));
            const newDomains = cleaned.filter(d => !tags.websites.includes(d));
            if (newDomains.length === 0) return;

            const addedCopy = [...newDomains];
            pushModalUndo('website', () => {
                addedCopy.forEach(w => {
                    const i = tags.websites.indexOf(w);
                    if (i !== -1) tags.websites.splice(i, 1);
                });
                window.renderModalTags();
            });
            newDomains.forEach(w => tags.websites.push(w));
            window.renderModalTags();
        }
    });
}

function setupAppInput(tags) {
    tags.appInput.addEventListener('keydown', (e) => {
        const accel = e.metaKey || e.ctrlKey;

        if (accel && (e.key === 'a' || e.key === 'A') && !tags.appInput.value.length) {
            e.preventDefault();
            selectAllUnlockedApps(tags);
            return;
        }

        if (e.key === 'ArrowLeft' && !accel && !tags.appInput.value.length && tags.selectedApps.size === 0) {
            if (moveAppSelection(tags, -1)) e.preventDefault();
            return;
        }
        if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !accel && tags.selectedApps.size > 0) {
            if (moveAppSelection(tags, e.key === 'ArrowLeft' ? -1 : 1)) e.preventDefault();
            return;
        }

        if ((e.key === 'Backspace' || e.key === 'Delete') && tags.selectedApps.size > 0) {
            e.preventDefault();
            deleteSelectedApps(tags);
            return;
        }

        // Backspace on empty input removes the last app tag (if not locked)
        if (e.key === 'Backspace' && !tags.appInput.value.length && tags.apps.length > 0) {
            const lastIdx = tags.apps.length - 1;
            const last = tags.apps[lastIdx];
            if (!isAppLocked(tags, last)) {
                pushModalUndo('app', () => {
                    tags.apps.splice(lastIdx, 0, last);
                    window.renderModalTags();
                });
                tags.apps.splice(lastIdx, 1);
                window.renderModalTags();
                e.preventDefault();
            }
        }

        if (tags.selectedApps.size > 0 && !accel && e.key.length === 1) {
            clearAppSelection(tags);
        }
        if (e.key === 'Enter' && tags.appInput.value.trim()) {
            e.preventDefault();
            const app = tags.appInput.value.trim();
            if (isProtectedApp(app)) {
                // Show brief warning — ReDD Blocker cannot block itself
                tags.appInput.value = '';
                tags.appInput.placeholder = tSettings('cannotBlockSelfAppPlaceholder');
                tags.appInput.classList.add('input-error');
                setTimeout(() => {
                    syncModalAppPlaceholder();
                    tags.appInput.classList.remove('input-error');
                }, 2000);
                return;
            }
            if (!tags.apps.includes(app)) {
                pushModalUndo('app', () => {
                    const i = tags.apps.indexOf(app);
                    if (i !== -1) tags.apps.splice(i, 1);
                    window.renderModalTags();
                });
                tags.apps.push(app);
                window.renderModalTags();
            }
            tags.appInput.value = '';
        }
    });
}

export function confirmPendingAppOnSave(tags) {
    const pendingApp = tags.appInput.value.trim();
    if (pendingApp && !isProtectedApp(pendingApp) && !tags.apps.includes(pendingApp)) {
        pushModalUndo('app', () => {
            const i = tags.apps.indexOf(pendingApp);
            if (i !== -1) tags.apps.splice(i, 1);
            window.renderModalTags();
        });
        tags.apps.push(pendingApp);
        tags.appInput.value = '';
        window.renderModalTags();
    } else {
        tags.appInput.value = '';
    }
}

/**
 * The saved Screen Time selection the picker may not go below, or null when
 * it is free to replace outright.
 *
 * Recomputed on every Browse tap rather than cached at modal-open time: a
 * block can end, or a schedule segment begin, while the modal sits open.
 *
 * Deliberately the *persisted* selection, not the modal's working copy — a
 * token added earlier in this same editing session was never enforced, so
 * dropping it again is not a loosening (and matches how a freshly added tag
 * on desktop keeps its remove button).
 */
function getEnforcedIOSSelectionFloor() {
    if (!state.isIOS) return null;
    if (!state.editingBlocklistId) return null;
    // Allow mode is deliberately excluded — see
    // mergeIOSScreenTimeSelectionAdditive.
    if (getSelectedBlocklistModalMode() !== 'blocklist') return null;
    if (!isBlocklistEditFrictionRequired(state.editingBlocklistId)) return null;
    const saved = state.appData?.blocklists?.find(bl => bl.id === state.editingBlocklistId);
    return saved ? getBlocklistIOSScreenTimeSelection(saved) : null;
}

function setupAppPicker(tags) {
    // Browse button for modal
    const modalBrowseBtn = document.getElementById('modal-browse-apps-btn');
    if (state.isIOS && modalBrowseBtn) {
        modalBrowseBtn.addEventListener('click', async () => {
            try {
                // Allow mode: the native picker expands category picks into
                // their member app tokens (the only thing `.all(except:)` can
                // enforce) and returns no category tokens.
                const result = await tauriAPI.showActivityPicker({
                    initialApplicationTokenData: tags.iosSelection?.applicationTokens || [],
                    initialCategoryTokenData: tags.iosSelection?.categoryTokens || [],
                    mode: getSelectedBlocklistModalMode()
                });
                // Running allow mode: only a narrowing (no new apps, never none).
                if (window.lockLastItems && !result.cancelled) {
                    const picked = normalizeIOSScreenTimeSelection({
                        applicationTokens: result.applicationTokens || [],
                        categoryTokens: result.categoryTokens || [],
                    });
                    if (!isIOSSelectionNarrowing(tags.iosSelection, picked)) {
                        alert(tSettings(picked?.applicationTokens.length || picked?.categoryTokens.length ? 'allowlistPickerNoAdditions' : 'allowlistPickerKeepOne'));
                        return;
                    }
                    pushModalUndo('ios-screentime-selection', ((previous) => () => {
                        tags.iosSelection = previous;
                        window.renderModalTags();
                    })(cloneIOSScreenTimeSelection(tags.iosSelection)));
                    tags.iosSelection = picked;
                    window.renderModalTags();
                    return;
                }
                // Non-null while enforcing: the picker becomes add-only, so a
                // deselection inside it is ignored rather than saved.
                const floor = getEnforcedIOSSelectionFloor();
                if (!result.cancelled && (result.applicationCount > 0 || result.categoryCount > 0)) {
                    const previousSelection = cloneIOSScreenTimeSelection(tags.iosSelection);
                    pushModalUndo('ios-screentime-selection', () => {
                        tags.iosSelection = cloneIOSScreenTimeSelection(previousSelection);
                        window.renderModalTags();
                    });
                    const picked = normalizeIOSScreenTimeSelection({
                        applicationTokens: result.applicationTokens || [],
                        categoryTokens: result.categoryTokens || [],
                        applicationCount: result.applicationCount || 0,
                        categoryCount: result.categoryCount || 0,
                        requiresReselection: false
                    });
                    tags.iosSelection = floor
                        ? mergeIOSScreenTimeSelectionAdditive(floor, picked)
                        : picked;
                    window.renderModalTags();
                } else if (!result.cancelled && tags.iosSelection) {
                    // Deselecting everything and confirming — the fastest form
                    // of the bypass. While enforcing it lands back on the floor
                    // instead of clearing.
                    const previousSelection = cloneIOSScreenTimeSelection(tags.iosSelection);
                    pushModalUndo('ios-screentime-selection-clear', () => {
                        tags.iosSelection = cloneIOSScreenTimeSelection(previousSelection);
                        window.renderModalTags();
                    });
                    tags.iosSelection = floor
                        ? mergeIOSScreenTimeSelectionAdditive(floor, null)
                        : null;
                    window.renderModalTags();
                }
            } catch (err) {
                console.error('Activity picker error:', err);
                alert('Failed to open app picker: ' + err);
            }
        });
    } else if (modalBrowseBtn) {
        modalBrowseBtn.addEventListener('click', async () => {
            // Open the in-app installed apps picker instead of the OS file picker
            openInstalledAppsPicker();
        });
    }
}

export function installFocusSpaceTagBridges(tags) {
    // Store references for modal functions. Keep both the refactor-era getter
    // and the original direct array bridge so extracted modules like the app
    // picker still share the same mutable selection state.
    window.getModalApps = () => tags.apps;
    window.getModalWebsites = () => tags.websites;
    window.getModalIOSScreenTimeSelection = () => tags.iosSelection;
    window.lockedWebsites = [];
    window.lockedApps = [];
    window.clearModalTagSelections = () => {
        tags.selectedWebsites.clear();
        tags.selectedApps.clear();
    };

    window.getModalAllowlistScopeCounts = () => ({
        websites: tags.websites.length,
        apps: tags.apps.length + countIOSScreenTimeSelectionItems(
            tags.iosSelection,
            true,
        ),
    });
    const render = () => renderModalTags(tags);
    window.restoreBlocklistModalTagBridges = () => {
        window.modalApps = tags.apps;
        window.renderModalTags = render;
    };
    window.restoreBlocklistModalTagBridges();

    // Esc inside the modal clears any active tag selection (it does NOT close
    // the modal in that case — only when no selection is active).
    document.getElementById('blocklist-modal').addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        const clearedWebsites = clearWebsiteSelection(tags);
        const clearedApps = clearAppSelection(tags);
        if (clearedWebsites || clearedApps) e.stopPropagation();
    });

    window.setModalData = (websites, apps, iosScreenTimeSelection = null, lockedWebsitesList = [], lockedAppsList = []) => {
        tags.websites.length = 0;
        tags.apps.length = 0;
        tags.selectedWebsites.clear();
        tags.selectedApps.clear();
        tags.iosSelection = cloneIOSScreenTimeSelection(iosScreenTimeSelection);
        window.lockedWebsites = lockedWebsitesList;
        window.lockedApps = lockedAppsList;

        websites.forEach(w => tags.websites.push(w));
        apps.forEach(a => tags.apps.push(a));
        window.renderModalTags();
    };
}

function renderModalTags(tags) {
    // Changes from the app picker and website importer don't bubble through
    // the editor's input/change listeners, so explicitly mark its state here.
    notifyEditorChanged();
    renderModalWebsiteTags(tags);
    renderModalAppTags(tags);
    syncModalWebsitePlaceholder();
    syncModalAppPlaceholder();
    const appCount = tags.apps.length + countIOSScreenTimeSelectionItems(
        tags.iosSelection,
        true,
    );
    updateAllowlistScopeHints(tags.websites.length, appCount);
}

function renderModalWebsiteTags(tags) {
    renderTags(tags.websiteContainer, tags.websites, (idx) => {
        const value = tags.websites[idx];
        if (isWebsiteLocked(tags, value)) {
            return; // Do not remove locked items; do not push undo.
        }
        pushModalUndo('website', () => {
            tags.websites.splice(idx, 0, value);
            window.renderModalTags();
        });
        tags.websites.splice(idx, 1);
        window.renderModalTags();
    }, tags.websites.filter(website => isWebsiteLocked(tags, website)), {
        selectedItems: tags.selectedWebsites,
        onTagClick: (idx) => {
            const value = tags.websites[idx];
            if (!value || isWebsiteLocked(tags, value)) return;
            if (tags.selectedWebsites.has(value)) {
                tags.selectedWebsites.delete(value);
            } else {
                tags.selectedWebsites.add(value);
            }
            window.renderModalTags();
            // Keep keyboard focus on the input so Backspace works immediately.
            tags.websiteInput.focus();
        }
    });
}

function renderModalAppTags(tags) {
    const displayApps = getModalDisplayApps(tags);
    const screenTimeLabel = formatIOSScreenTimeSelectionLabel(tags.iosSelection);
    renderTags(tags.appContainer, displayApps, (idx) => {
        if (displayApps[idx] === screenTimeLabel) {
            if (isAppLocked(tags, screenTimeLabel)) return;
            const previousSelection = cloneIOSScreenTimeSelection(tags.iosSelection);
            pushModalUndo('ios-screentime-selection-remove', () => {
                tags.iosSelection = cloneIOSScreenTimeSelection(previousSelection);
                window.renderModalTags();
            });
            tags.iosSelection = null;
        } else {
            const processName = tags.apps[idx];
            if (!processName || isAppLocked(tags, processName)) return;
            const appIdx = tags.apps.indexOf(processName);
            if (appIdx === -1) return;
            pushModalUndo('app', () => {
                tags.apps.splice(appIdx, 0, processName);
                window.renderModalTags();
            });
            tags.apps.splice(appIdx, 1);
        }
        window.renderModalTags();
    }, getModalLockedAppDisplayItems(tags), {
        selectedItems: tags.selectedApps,
        onTagClick: (idx) => {
            const value = displayApps[idx];
            if (!value) return;
            if (value === screenTimeLabel) {
                if (isAppLocked(tags, screenTimeLabel)) return;
            } else if (isAppLocked(tags, tags.apps[idx])) {
                return;
            }
            if (tags.selectedApps.has(value)) {
                tags.selectedApps.delete(value);
            } else {
                tags.selectedApps.add(value);
            }
            window.renderModalTags();
            tags.appInput.focus();
        }
    });
}

function renderTags(container, items, onRemove, lockedItems = [], options = {}) {
    const selectedItems = options.selectedItems instanceof Set ? options.selectedItems : null;
    const onTagClick = typeof options.onTagClick === 'function' ? options.onTagClick : null;

    container.innerHTML = items.map((item, idx) => {
        const isLocked = lockedItems.includes(item);
        const isSelected = !isLocked && selectedItems?.has(item);
        const classes = ['tag'];
        if (isLocked) classes.push('locked');
        if (isSelected) classes.push('selected');
        const removeBtn = !isLocked ? `<button class="tag-remove" data-idx="${idx}">×</button>` : '';

        return `
    <span class="${classes.join(' ')}" data-idx="${idx}">
      ${escapeHtml(item)}
      ${removeBtn}
    </span>
  `;
    }).join('');

    container.querySelectorAll('.tag-remove').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = parseInt(btn.dataset.idx);
            if (onRemove) onRemove(idx);
        });
    });

    if (onTagClick) {
        container.querySelectorAll('.tag').forEach(tagEl => {
            tagEl.addEventListener('click', (e) => {
                // Don't toggle when the user clicks the inline ✕ — that path
                // is handled by .tag-remove above and removes the chip outright.
                if (e.target.closest('.tag-remove')) return;
                const idx = parseInt(tagEl.dataset.idx);
                if (Number.isFinite(idx)) onTagClick(idx);
            });
        });
    }
}
