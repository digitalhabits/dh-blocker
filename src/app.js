// Tauri API imports - proper ES modules from @tauri-apps/api
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import logoReddFocusUrl from './images/logo-reddfocus.svg';
import logoReddShieldUrl from './images/logo-redd-shield.svg';
import appleLogoUrl from './images/apple-logo.svg';
// Compatibility layer wrapping Tauri APIs — extracted to tauri-api.js
import { tauriAPI } from './tauri-api.js';
import { state } from './state.js';
import './dev-internals.js';
import { setupFocusSpaceAppearanceFields, setupFocusSpaceOverrideFields } from './focus-space-editor-fields.js';
import { saveFocusSpace } from './focus-space-save.js';
import { installFocusSpaceTagBridges, setupFocusSpaceTagEditors } from './focus-space-tags.js';
import { handlePopoverOutsideClick } from './time-inputs.js';
import { applyFocusSpaceEditorLanguage, confirmDiscardEditorEdits, editorHasUnsavedEdits, setupFocusSpaceEditor } from './focus-space-editor.js';
import { loadData, saveData, updateHostsFile } from './persistence.js';
import { updateBlockedApps, acceptEula, checkHelperStatus, checkScreentimeAuth, detectPlatform, ensureInstalledAppsCache, initializeIOSBlockingState, renderAppBlockingClosedownBanner, renderAppBlockingWarningOverlay, requestScreentimeAuth, runExpiryOnce, setupAppBlockingWarningOverlay, setupHandsetModalScreens, setupMaximizeButtonSync, setupMobileExternalLinkOpens, syncMaximizeButtonFromWindow, updateOnboardingVisibility } from './blocking-platform.js';
import { applyEnforcementDescCopy, applyMacAutomationIntroCopy, ensureExtensionSetupOnboardingShown, hasAcceptedEula, resetDevOnlyEulaAcceptance, returnToWelcomeFromEula, runDesktopOnboarding, runInitialOnboardingSequence, setupMacAutomationIntroModal, syncMigrationPostBackButtonVisibility, syncSetupBannerHeadline, welcomeFirefoxInstalled } from './onboarding.js';
import {
    ALL_BLOCKING_METHOD_KEYS,
    browserBlockingMethod,
    methodOptionsForKey,
    invalidateMigrationMacCopyCache,
    migrationExtLinesHtml,
    applySafariFdaOnboardingLanguage,
    refreshBehaviourBannerIfStale,
    renderBrowserInstallButtons,
    setupAppForegroundRefresh,
    setupEnforcerUiAlerts,
    setupSettingsEnforcementSection,
    setupWebAutomationUiAlerts,
    startWebAutomationWatcher,
    syncBlockingMethodLabelIcons,
    syncMigrationMacHowto,
    syncMigrationPostHeader,
    updateAllEnforcementToggleLocks,
    updateGraceSettingLock,
    wireEnforcementToggle,
} from './enforcement.js';
import {
    addScheduleSegment,
    getDefaultScheduleSegments, handleRepeatDateChange,
    handleUndoToastClick, pendingSegmentDelete,
    rebuildScheduleSegments,
    setupAllowEditsBetweenBlocksToggle,
} from './schedule-editor.js';
import {
    SCHEDULE_OVERLAY_DEFAULT_PRESET_VALUE,
    handleSchedulePanelOverlayOptionClick, isScheduleOverlayCustomiseModalOpen,
    populateScheduleOverlayCustomiseSelector,
    setupScheduleOverlayCustomiseModal,
    syncScheduleOverlayCustomiseDirtyState,
    syncScheduleOverlayCustomiseEditorState, syncScheduleOverlayCustomiseTitle,
    toggleSchedulePanelOverlayDropdown,
} from './schedule-overlay.js';
import { closeBlocklistModal, closeOverrideModal, closeStartConfirmModal, deselectBlocklist, handleBlocklistSelect, openBlocklistModal, refreshSelectedBlocklistUi, updatePauseDialogDuration, initializeOverrideModalChallenge, setStartConfirmPrimaryLabel, stopFocusSpaceTarget, syncOverrideCountUi, updateOverridePreview } from './confirm-modals.js';
import { enhanceNativeSelects } from './custom-select.js';
import { renderBlocklists, closeAllBlocklistMenus, setupBlocklistsImportExportButtons, isBlocklistEditFrictionRequired, pendingDelete, setUndoToastMessage } from './blocklists.js';
import {
    getSelectedBlocklistModalMode,
    syncBlocklistCreateUi,
    syncModalAppPlaceholder,
    syncModalWebsitePlaceholder,
    updateBlocklistModalModeLabels,
} from './list-mode.js';
import { render, startTickInterval, updateWeekCalendar, syncSelectedControlState, renderBlocklistSelector } from './render.js';
import { syncActiveBlocksToHelper, syncSchedulesToHelper } from './schedule-engine.js';
import { dismissTopmostEscapeLayer, refreshOpenHelperUi } from './modal-manager.js';
import {
    refreshUninstallButtonState,
    setupGraceSetting, setupMaxOverrideWordsSetting, syncMaxOverrideWordsSetting, setupHelpMenuLinks, setupHelperSettings, setupInAppUninstall,
    setupOverrideAll, setupSettingsHelpButtons, setupSettingsInfoTooltips, setupWindowsUninstallGuidance,
    syncUninstallConfirmModal,
    updateOverrideAllButtonVisibility,
} from './settings.js';
import { getLastBreakMinutes, rememberBreakMinutes } from './unlock-duration.js';
import { turnFocusSpaceOn } from './focus-space-switch.js';
import { setupTheme, setupUiZoomShortcuts } from './theme.js';
import { checkForAppUpdate, updateBannerWhatsNewButtonHtml } from './update-banner.js';
import { updateDownloadInProgress } from './update-banner.js';
import { setupUsagePingToggle, startUsagePing } from './usage-ping.js';
import { applyStoreReviewPromptCopy, startStoreReviewPrompt } from './store-review-prompt.js';
import { applyStartWarningsLanguage, setupStartWarningsOnboarding, setupStartWarningsToggle, syncIOSStartWarnings } from './ios-start-warnings.js';
import { getChallengeController } from './challenge-controller.js';
import { DEFAULT_OVERRIDE_WORDS, normalizeOverrideType } from './override-challenge.js';
import { escapeHtml } from './utils.js';
import { getSettingsLanguage, tSettings, tSettingsFmt, LANGUAGE_FLAG_SVG, languageNativeLabel, SUPPORTED_LANGUAGE_CODES } from './i18n.js';

// Where the current pointer press began. A drag that starts in a field and
// ends elsewhere fires its click on the common ancestor, so outside-click
// handlers must look at the press origin, not only the click target.
let lastPressTarget = null;
/** Windows Settings → Apps → Installed apps (Apps & features). */
export const WINDOWS_APPS_SETTINGS_URI = 'ms-settings:appsfeatures';

/** Blocklist modal undo: session-scoped stack and "last" values for recording previous state. */

export function pushModalUndo(type, undoFn) {
    if (state.blocklistModalApplyingUndo) return;
    state.blocklistModalUndoStack.push({ type, undo: undoFn });
}

let startupInitializationPromise = null; // Prevent duplicate post-onboarding startup runs
/** Max length for blocklist display name (add/edit modal + persisted saves). */
export const BLOCKLIST_NAME_MAX_LENGTH = 60;
/** Past this length the card title row usually ellipsizes; use "in 11h" instead of "starts in 11h". */
/** Collapse stop-button emoji+name this many px before measured overflow (iOS flex overlap). */
export const IOS_STOP_BTN_META_COLLAPSE_SLACK_PX = 24;

// Schedule mode state
state.scheduleSegments = getDefaultScheduleSegments(); // Array of time segments with per-segment days

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
    detectPlatform(); // Before loadData so first-launch defaults can differ on iOS
    // App-styled dropdowns over every <select>. Before loadData so the first
    // paint never shows an OS menu; the native selects stay the source of truth.
    enhanceNativeSelects();
    await loadData();
    await resetDevOnlyEulaAcceptance();

    setupHandsetModalScreens();
    setupMobileExternalLinkOpens();

    setupEventListeners();
    setupAppBlockingWarningOverlay();
    initWelcomeDemoControls();
    setupTheme();
    setupUiZoomShortcuts();
    setupHelpMenuLinks();
    setupHelperSettings();
    setupUsagePingToggle();
    setupStartWarningsToggle();
    setupStartWarningsOnboarding();
    setupSettingsHelpButtons();
    setupSettingsInfoTooltips();
    setupBlocklistsImportExportButtons();
    setupAppForegroundRefresh();
    setupOverrideAll();
    setupInAppUninstall();
    setupWindowsUninstallGuidance();
    setupMacAutomationIntroModal();
    setupGraceSetting();
    setupMaxOverrideWordsSetting();
    setupSettingsEnforcementSection();
    if (!state.isIOS) {
        void wireEnforcementToggle();
    }
    await runInitialOnboardingSequence();
    if (state.isIOS && hasAcceptedEula()) {
        await checkScreentimeAuth();
    }

    if (hasAcceptedEula()) {
        await runPostAcceptanceStartup();
    }

});

export async function runPostAcceptanceStartup() {
    if (state.startupInitializationComplete) return;
    if (startupInitializationPromise) {
        await startupInitializationPromise;
        return;
    }

    startupInitializationPromise = (async () => {
        await runExpiryOnce(); // Align in-memory state with Screen Time / helper (e.g. after app was closed)

        // Paint desktop state before native reconciliation; iOS waits for Screen Time.
        const renderedBeforeNativeStartup = !state.isIOS;
        if (renderedBeforeNativeStartup) {
            render();
            startTickInterval();
            await new Promise((resolve) => {
                requestAnimationFrame(() => setTimeout(resolve, 0));
            });
        }

        if (state.isIOS) {
            await checkScreentimeAuth();
            if (state.screentimeAuthorized) {
                await initializeIOSBlockingState();
            }
        } else {
            // Run first-launch migration off the legacy helper + check
            // Automation TCC (macOS) + extension compliance. Idempotent;
            // a no-op on subsequent launches past the current version.
            setupEnforcerUiAlerts();
            setupWebAutomationUiAlerts();
            await ensureInstalledAppsCache();
            await runDesktopOnboarding();
            await checkHelperStatus();
            console.log('[startup-sync] Desktop startup helperAvailable:', state.helperAvailable);
            // Reconcile manual blocks first so paused one-offs are removed from helper state after reinstall.
            await syncActiveBlocksToHelper();
            // Then sync schedules to helper so both enforcement sources are aligned.
            await syncSchedulesToHelper();
            console.log('[startup-sync] Startup helper reconciliation complete');
            // Push active schedule / block app sets into the in-process watcher
            // immediately — don't wait for the 1s tick interval.
            await updateHostsFile();
            await updateBlockedApps();
            if (!state.migrationOnboardingActive) {
                try {
                    await invoke('enforcer_start');
                } catch (e) {
                    console.warn('[startup] enforcer_start failed:', e);
                }
            }
            // Start the automation watcher even while the migration overlay
            // is open — blocks may already be active and the watcher is
            // idle until then anyway.
            await startWebAutomationWatcher();
        }
        // Desktop has already produced its first meaningful frame. Render
        // again after reconciliation in case native startup changed any UI
        // state; mobile reaches its first render here as before.
        render();
        if (!renderedBeforeNativeStartup) {
            startTickInterval();
        }

        // Check for app updates (non-blocking, desktop only), and re-check
        // every 6 h: the app can stay open for days past a release.
        if (!state.isIOS) {
            checkForAppUpdate();
            setInterval(checkForAppUpdate, 6 * 60 * 60 * 1000);
        }
        // Anonymous daily usage ping (Mac, Windows, iOS; off in Settings).
        startUsagePing();
        state.startupInitializationComplete = true;
        startStoreReviewPrompt();
    })();

    try {
        await startupInitializationPromise;
    } finally {
        if (!state.startupInitializationComplete) {
            startupInitializationPromise = null;
        }
    }
}

// Setup event listeners
function setupEventListeners() {
    // Window controls (using Tauri docs naming)
    document.getElementById('titlebar-minimize')?.addEventListener('click', () => {
        tauriAPI.minimizeWindow();
    });

    document.getElementById('titlebar-maximize')?.addEventListener('click', async () => {
        await tauriAPI.maximizeWindow();
        // State may settle asynchronously on Windows — refresh immediately and once more.
        await syncMaximizeButtonFromWindow({ force: true });
        setTimeout(() => {
            void syncMaximizeButtonFromWindow({ force: true });
        }, 100);
    });

    document.getElementById('titlebar-close')?.addEventListener('click', () => {
        tauriAPI.closeWindow();
    });

    // Rebrand-notice overlay covers the main title bar, so it carries its
    // own window controls (visible on Windows only, mirroring the main set).
    document.getElementById('rebrand-titlebar-minimize')?.addEventListener('click', () => {
        tauriAPI.minimizeWindow();
    });
    document.getElementById('rebrand-titlebar-maximize')?.addEventListener('click', async () => {
        await tauriAPI.maximizeWindow();
        const syncIcons = async () => {
            const maximized = await getCurrentWindow().isMaximized().catch(() => false);
            const maxIcon = document.getElementById('rebrand-maximize-icon');
            const restoreIcon = document.getElementById('rebrand-restore-icon');
            if (maxIcon) maxIcon.style.display = maximized ? 'none' : '';
            if (restoreIcon) restoreIcon.style.display = maximized ? '' : 'none';
        };
        await syncIcons();
        // State may settle asynchronously on Windows — refresh once more.
        setTimeout(() => { void syncIcons(); }, 100);
    });
    document.getElementById('rebrand-titlebar-close')?.addEventListener('click', () => {
        tauriAPI.closeWindow();
    });

    const eulaCheckbox = document.getElementById('eula-agree-checkbox');
    const eulaContinueBtn = document.getElementById('eula-continue-btn');
    if (eulaCheckbox && eulaContinueBtn) {
        eulaContinueBtn.disabled = !eulaCheckbox.checked;
    }
    eulaCheckbox?.addEventListener('change', () => {
        if (eulaContinueBtn) {
            eulaContinueBtn.disabled = !eulaCheckbox.checked;
        }
    });
    eulaContinueBtn?.addEventListener('click', async () => {
        if (!eulaCheckbox?.checked || !eulaContinueBtn) return;
        if (state.firstRunExtensionSetupPending && hasAcceptedEula()) {
            state.extensionSetupPausedForBackNavigation = false;
            document.getElementById('eula-onboarding')?.classList.add('hidden');
            void ensureExtensionSetupOnboardingShown();
            return;
        }
        eulaContinueBtn.disabled = true;
        eulaContinueBtn.textContent = tSettings('eulaContinueBusy');
        try {
            await acceptEula();
        } catch (err) {
            console.error('Failed to accept EULA:', err);
            alert(tSettings('eulaAcceptSaveFailedAlert'));
            eulaContinueBtn.disabled = !eulaCheckbox.checked;
            eulaContinueBtn.textContent = tSettings('eulaContinueBtn');
            return;
        }
        eulaContinueBtn.textContent = tSettings('eulaContinueBtn');
        startStoreReviewPrompt();
    });

    document.getElementById('eula-back-btn')?.addEventListener('click', () => {
        returnToWelcomeFromEula();
    });

    document.getElementById('ios-screentime-grant-btn')?.addEventListener('click', async () => {
        const btn = document.getElementById('ios-screentime-grant-btn');
        const note = document.getElementById('ios-screentime-onboarding-note');
        if (!btn) return;

        btn.disabled = true;
        btn.textContent = tSettings('iosScreentimeRequestingBtn');

        const result = await requestScreentimeAuth();

        if (result.granted) {
            // Every grant asks about start warnings next, so a fresh dev install always shows it.
            state.iosNotificationOnboardingPending = true;
            updateOnboardingVisibility();
            try {
                await initializeIOSBlockingState();
                render();
            } catch (err) {
                console.error('Error initializing iOS blocking state after auth:', err);
            }
        } else if (note) {
            if (result.status === 'denied') {
                note.textContent = tSettings('iosScreentimeDeniedNote');
            } else if (result.error) {
                note.textContent = tSettings('iosScreentimeFailedNoteFmt').replace('{error}', String(result.error));
            }
        }
        updateOnboardingVisibility();

        btn.disabled = false;
        btn.textContent = tSettings('iosScreentimeGrantBtn');
    });

    if (state.isIOS) {
        // Screen Time access is granted and revoked in Settings, and there is no
        // callback for "the user came back". Without this check the app keeps showing
        // focus spaces as on after access is revoked, until the next launch.
        document.addEventListener('visibilitychange', () => {
            // Also rebuilds start warnings: notification permission and the time zone
            // can both change in iOS Settings while the app is away.
            if (document.visibilityState === 'visible') void checkScreentimeAuth().then(syncIOSStartWarnings);
        });
    }

    // Windows custom title bar: sync maximize/restore icon from window events (no polling).
    void setupMaximizeButtonSync();

    // Close the schedule editor's time popovers on outside click.
    document.addEventListener('click', handlePopoverOutsideClick);

    document.addEventListener('pointerdown', (e) => { lastPressTarget = e.target; }, true);

    // Click on background to deselect blocklists
    const KEEP_SELECTION_WITHIN = [
        '.blocklist-card', '.scheduler-section', '.time-picker-container', '.schedule-block-panel',
        '.repeat-dropdown-wrapper', '.repeat-dropdown-menu', '.modal-overlay', '.section-header',
        '.footer', '.title-bar', '.week-calendar-section', '.time-popover', '.segment-time-field',
        '.undo-toast', '.zoom-toast',
    ].join(',');
    document.addEventListener('click', (e) => {
        // Don't deselect if the click — or the press it came from — was on
        // interactive elements
        if (e.target.closest(KEEP_SELECTION_WITHIN)) return;
        if (lastPressTarget instanceof Element && lastPressTarget.closest(KEEP_SELECTION_WITHIN)) return;

        // Deselect blocklist if one is selected (asks first when there are unsaved edits)
        if (state.selectedBlocklistId) {
            if (!editorHasUnsavedEdits()) deselectBlocklist();
            else void confirmDiscardEditorEdits().then((ok) => { if (ok) deselectBlocklist(); });
        }
    });

    // Close blocklist card menus when clicking outside
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.blocklist-menu-wrapper') && !e.target.closest('.blocklist-menu')) {
            closeAllBlocklistMenus();
        }
    });

    // ESC: sub-overlays → dialog → (elsewhere) deselect selected blocklist
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (dismissTopmostEscapeLayer()) {
            e.preventDefault();
            return;
        }
        if (state.selectedBlocklistId) {
            deselectBlocklist();
            e.preventDefault();
        }
    });

    // Ctrl+Z / Cmd+Z: undo in blocklist add/edit modal (session-scoped).
    // Use capture phase so we run before the input's native undo (which would undo character-by-character).
    // Rule: clear pending (unsaved) text in website/app fields before undoing stack actions. Prefer clearing
    // the focused field first, then clear any other field that still has pending text, then pop stack.
    document.addEventListener('keydown', (e) => {
        const editorHost = document.getElementById('focus-space-editor')?.closest('#blocklist-modal, #time-picker-container');
        if (!editorHost || editorHost.classList.contains('hidden')) return;
        const isUndo = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey;
        if (!isUndo) return;

        const websiteInput = document.getElementById('modal-website-input');
        const appInput = document.getElementById('modal-app-input');
        const target = e.target;
        const websiteHasPending = websiteInput && websiteInput.value.trim().length > 0;
        const appHasPending = appInput && appInput.value.trim().length > 0;

        // 1) Clear the focused field if it has pending text (so one Ctrl+Z clears where you're typing)
        if ((target === websiteInput || document.activeElement === websiteInput) && websiteHasPending) {
            websiteInput.value = '';
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        if ((target === appInput || document.activeElement === appInput) && appHasPending) {
            appInput.value = '';
            syncModalAppPlaceholder();
            e.preventDefault();
            e.stopPropagation();
            return;
        }

        // 2) If any field still has pending text, clear it before we touch the stack (so we don't undo
        //    a tag add/remove while leaving unsaved text in the other field)
        if (websiteHasPending) {
            websiteInput.value = '';
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        if (appHasPending) {
            appInput.value = '';
            syncModalAppPlaceholder();
            e.preventDefault();
            e.stopPropagation();
            return;
        }

        // 3) Both fields empty of pending text — pop stack
        if (state.blocklistModalUndoStack.length > 0) {
            state.blocklistModalApplyingUndo = true;
            const entry = state.blocklistModalUndoStack.pop();
            try {
                entry.undo();
            } finally {
                state.blocklistModalApplyingUndo = false;
            }
            e.preventDefault();
        }
    }, true);

    // Blocklist selector
    document.getElementById('blocklist-select').addEventListener('change', handleBlocklistSelect);

    // Add blocklist / allow-only buttons (mode chosen by entry point, not in-dialog)
    // The create modal borrows the editor node, so unsaved edits on the
    // selected space would be lost — ask first.
    document.getElementById('add-blocklist-btn').addEventListener('click', async () => {
        if (!(await confirmDiscardEditorEdits())) return;
        openBlocklistModal();
    });
    document.getElementById('allow-only-blocklist-btn')?.addEventListener('click', async () => {
        if (!(await confirmDiscardEditorEdits())) return;
        openBlocklistModal(null, { mode: 'allowlist' });
    });

    // Onboarding removed. A fresh install starts with no focus spaces.

    // Modal listeners
    setupModalListeners();

    // Override modal
    setupOverrideModalListeners();

    // Undo toast button
    document.getElementById('undo-toast-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        handleUndoToastClick();
    });

    setupScheduleOverlayCustomiseModal();

    // Focus-space editor: create modal + edit panel share one form.
    setupFocusSpaceEditor({ onSave: saveFocusSpaceEditor });
    document.getElementById('add-segment-btn')?.addEventListener('click', addScheduleSegment);
    setupAllowEditsBetweenBlocksToggle();

    document.getElementById('schedule-panel-overlay-dropdown-btn')?.addEventListener('click', toggleSchedulePanelOverlayDropdown);
    document.getElementById('schedule-panel-overlay-dropdown-menu')?.addEventListener('click', handleSchedulePanelOverlayOptionClick);
    document.getElementById('repeat-date-input')?.addEventListener('change', handleRepeatDateChange);

    // Listen for blocks updated from main process
    tauriAPI.onBlocksUpdated(async () => {
        await loadData();
        render();
    });
}

/** Bound to the shared editor during listener setup. */
let saveFocusSpaceEditorImpl = null;
export async function saveFocusSpaceEditor() {
    if (saveFocusSpaceEditorImpl) await saveFocusSpaceEditorImpl();
}

function setupModalListeners() {
    // A drag that starts inside a dialog (selecting text in a field) and ends
    // over the backdrop fires a click on the backdrop, which every overlay
    // treats as "close". Only a press that also began on the backdrop counts.
    document.addEventListener('click', (e) => {
        if (!(e.target instanceof Element) || !e.target.classList.contains('modal-overlay')) return;
        if (lastPressTarget && lastPressTarget !== e.target) e.stopPropagation();
    }, true);

    // Close modal when clicking outside content
    document.getElementById('blocklist-modal').addEventListener('click', (e) => {
        if (e.target.classList.contains('modal-overlay')) {
            closeBlocklistModal();
        }
    });

    const tags = setupFocusSpaceTagEditors();
    setupFocusSpaceOverrideFields();
    setupFocusSpaceAppearanceFields();

    // Cancel button
    document.getElementById('cancel-blocklist-btn').addEventListener('click', () => {
        closeBlocklistModal();
    });

    saveFocusSpaceEditorImpl = () => saveFocusSpace(tags);
    document.getElementById('save-blocklist-btn').addEventListener('click', () => {
        void saveFocusSpaceEditorImpl();
    });

    installFocusSpaceTagBridges(tags);
}

// Override modal listeners
function setupOverrideModalListeners() {
    // Typing, progress, paste-blocking and Enter now live in the shared
    // controller (challenge-controller.js); it wires its own listeners on first
    // use. What stays here is the override modal's confirm action, which is what
    // actually distinguishes it from stop-all.
    getChallengeController('override');

    document.getElementById('cancel-override-btn').addEventListener('click', () => {
        closeOverrideModal();
    });

    document.getElementById('cancel-enter-scheduler-btn')?.addEventListener('click', async () => {
        if (await confirmDiscardEditorEdits()) deselectBlocklist();
    });
    // The desktop sheet's back chevron lives in the card's title row.
    document.getElementById('editor-back-btn')?.addEventListener('click', () => {
        document.getElementById('cancel-enter-scheduler-btn')?.click();
    });

    // Start confirmation (switch on): Cancel / overlay close it, Start proceeds.
    document.getElementById('cancel-start-confirm-btn')?.addEventListener('click', closeStartConfirmModal);
    document.getElementById('start-block-confirm-modal')?.addEventListener('click', (e) => {
        if (e.target === e.currentTarget) closeStartConfirmModal();
    });
    document.getElementById('proceed-start-confirm-btn')?.addEventListener('click', async () => {
        const blocklistId = state.pendingStartBlocklistId;
        closeStartConfirmModal();
        if (blocklistId) await turnFocusSpaceOn(blocklistId);
    });

    document.getElementById('unlock-duration-select').addEventListener('change', updatePauseDialogDuration);
    document.getElementById('confirm-override-btn').addEventListener('click', async () => {
        if (state.pauseSubmitting) return;
        const currentSpace = state.appData.blocklists.find(bl => bl.id === state.pendingPauseSpaceId);
        if (!currentSpace) return;
        const difficulty = currentSpace.overrideDifficulty || { type: 'random-words', count: DEFAULT_OVERRIDE_WORDS };
        const skipChallenge = !isBlocklistEditFrictionRequired(currentSpace.id);
        if (JSON.stringify({ difficulty, skipChallenge }) !== state.pauseChallengeSnapshot) {
            initializeOverrideModalChallenge(difficulty, currentSpace.color, { skipChallenge });
            return;
        }
        const result = getChallengeController('override').handleConfirm();
        // A correct but non-final word: the controller already advanced the UI.
        if (result.status !== 'ok') return;

        // Apply only the duration chosen in this confirmation. Never keeps the
        // existing manual-removal / indefinite schedule-off semantics.
        const block = state.overrideBlockId
            ? state.appData.activeBlocks.find(b => b.id === state.overrideBlockId) || null
            : null;
        const scheduleId = window.overrideScheduleId;
        const schedule = !block && scheduleId
            ? state.appData.schedules.find(s => s.id === scheduleId || s.blocklistId === scheduleId) || null
            : null;
        if (!block && !schedule) return;

        // A stale dialog must never extend a pause that was already confirmed.
        if ((block || schedule).isPaused || (block && block.endTime <= Date.now())) return;
        const minutes = Number(document.getElementById('unlock-duration-select').value);
        state.pauseSubmitting = true;
        try {
            const outcome = await stopFocusSpaceTarget({ block, schedule, minutes });
            if (!outcome) {
                initializeOverrideModalChallenge(difficulty, currentSpace.color, { skipChallenge });
                return;
            }
            const previous = getLastBreakMinutes(state.appData.settings);
            rememberBreakMinutes(state.appData.settings, minutes);
            try { await saveData(); } catch (error) {
                state.appData.settings.lastBreakMinutes = previous;
                console.error('Could not remember pause duration:', error);
            }
        } catch (error) {
            console.error('Could not apply pause:', error);
            initializeOverrideModalChallenge(difficulty, currentSpace.color, { skipChallenge });
            alert(tSettings('pauseFailed'));
            return;
        } finally { state.pauseSubmitting = false; }
        state.overrideBlocklistIdForHelper = null;
        delete window.overrideScheduleId;

        const keepSelectedId = state.selectedBlocklistId;
        render();

        // Keep the focus space selected so the scheduler panel stays open; only
        // its lock state is resynced, so in-flight edits survive the stop.
        refreshSelectedBlocklistUi(keepSelectedId);
        await refreshOpenHelperUi();

        closeOverrideModal();
    });

    // Click outside to close
    const overrideModal = document.getElementById('override-modal');
    overrideModal.addEventListener('click', (e) => {
        if (e.target === overrideModal) {
            closeOverrideModal();
        }
    });
}

// Render tags
// Track current selected end time only (start is always 'now')

// Pad number with leading zero

// Show schedule confirmation modal

// Utility functions
export function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

export function formatTime(date) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Last minute of the civil day (23:59). Drag/snap math uses 1440 as exclusive
// end-of-day; converting 1440 through hour/minute fields wrongly yielded 23:00.
export const MINUTES_PER_DAY = 1440;
export const MAX_SAME_DAY_END_MINUTES = MINUTES_PER_DAY - 1;

export function clampSameDayMinutes(totalMinutes) {
    return Math.max(0, Math.min(MAX_SAME_DAY_END_MINUTES, Math.round(totalMinutes)));
}

export function snapMinutesToInterval(minutes, intervalMinutes = 15) {
    return clampSameDayMinutes(Math.round(minutes / intervalMinutes) * intervalMinutes);
}

// Format a minutes-since-midnight value as zero-padded "HH:MM". Used by drag-resize
// handlers to live-update the time label inside a preview block.
export function formatMinutesAsHHMM(totalMinutes) {
    const clamped = clampSameDayMinutes(totalMinutes);
    const h = Math.floor(clamped / 60);
    const m = clamped % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function formatDuration(minutes) {
    if (minutes < 60) {
        return `${minutes} min${minutes !== 1 ? 's' : ''}`;
    }
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    if (mins === 0) {
        return `${hours} hour${hours !== 1 ? 's' : ''}`;
    }
    return `${hours}h ${mins}m`;
}

/** Remaining pause time chip, e.g. "Paused 15m" or "Paused 1h 30m". */
export function formatPauseRemainingShort(pauseEndTime, now = Date.now()) {
    if (!pauseEndTime) return 'Paused';
    const pauseMins = Math.max(1, Math.ceil((pauseEndTime - now) / 60000));
    const timePart = pauseMins >= 60
        ? `${Math.floor(pauseMins / 60)}h ${pauseMins % 60}m`
        : `${pauseMins}m`;
    return `Paused ${timePart}`;
}

/** Remaining time chip, e.g. EN "1h 39m left", DA "1t 39m endnu" (`totalMins` = full minutes). */
export function formatBlockTimeRemainingShort(totalMins) {
    const n = Math.max(0, Math.floor(totalMins));
    const hrs = Math.floor(n / 60);
    const mins = n % 60;
    if (getSettingsLanguage() === 'zh-CN') {
        if (hrs > 0 && mins > 0) return `剩余 ${hrs}小时${mins}分钟`;
        if (hrs > 0) return `剩余 ${hrs}小时`;
        return `剩余 ${mins}分钟`;
    }
    if (getSettingsLanguage() === 'da') {
        if (hrs > 0 && mins > 0) return `${hrs}t ${mins}m endnu`;
        if (hrs > 0) return `${hrs}t endnu`;
        return `${mins}m endnu`;
    }
    if (hrs > 0 && mins > 0) return `${hrs}h ${mins}m left`;
    if (hrs > 0) return `${hrs}h left`;
    return `${mins}m left`;
}

// Clean up URL for display (remove protocol, www, trailing slash)

const LANGUAGE_PICKER_ROOT_IDS = ['language-picker', 'welcome-language-picker'];

function languagePickerElements(rootId) {
    return {
        picker: document.getElementById(rootId),
        trigger: document.getElementById(`${rootId}-trigger`),
        dropdown: document.getElementById(`${rootId}-dropdown`),
        triggerFlag: document.getElementById(`${rootId}-trigger-flag`),
        triggerCode: document.getElementById(`${rootId}-trigger-code`),
        currentName: document.getElementById(`${rootId}-current-name`),
        currentFlag: document.getElementById(`${rootId}-current-flag`),
        options: document.getElementById(`${rootId}-options`),
        curLabel: document.getElementById(`${rootId}-current-label`),
        swLabel: document.getElementById(`${rootId}-switch-label`),
    };
}

export function isAnyLanguagePickerOpen() {
    return LANGUAGE_PICKER_ROOT_IDS.some((rootId) => {
        const { dropdown } = languagePickerElements(rootId);
        return dropdown && !dropdown.classList.contains('hidden');
    });
}

export function closeAllLanguagePickers() {
    for (const rootId of LANGUAGE_PICKER_ROOT_IDS) {
        const { dropdown, trigger } = languagePickerElements(rootId);
        if (!dropdown || !trigger) continue;
        dropdown.classList.add('hidden');
        trigger.setAttribute('aria-expanded', 'false');
    }
}

export function setLanguagePickerOpen(open, rootId) {
    if (open) {
        for (const id of LANGUAGE_PICKER_ROOT_IDS) {
            const { dropdown, trigger } = languagePickerElements(id);
            if (!dropdown || !trigger) continue;
            const show = id === rootId;
            dropdown.classList.toggle('hidden', !show);
            trigger.setAttribute('aria-expanded', show ? 'true' : 'false');
        }
        return;
    }
    if (rootId) {
        const { dropdown, trigger } = languagePickerElements(rootId);
        if (!dropdown || !trigger) return;
        dropdown.classList.add('hidden');
        trigger.setAttribute('aria-expanded', 'false');
        return;
    }
    closeAllLanguagePickers();
}

function syncLanguagePickerUIForRoot(rootId) {
    const lang = getSettingsLanguage();
    const {
        picker,
        trigger,
        triggerFlag,
        triggerCode,
        currentName,
        currentFlag,
        options,
        curLabel,
        swLabel,
    } = languagePickerElements(rootId);
    if (!picker) return;

    if (triggerCode) {
        triggerCode.textContent = languageNativeLabel(lang);
    }
    if (triggerFlag) triggerFlag.innerHTML = LANGUAGE_FLAG_SVG[lang] || '';
    if (currentFlag) currentFlag.innerHTML = LANGUAGE_FLAG_SVG[lang] || '';

    const curLabelText = languageNativeLabel(lang);
    if (currentName) currentName.textContent = curLabelText;
    if (curLabel) curLabel.textContent = tSettings('languagePickerCurrent');
    if (swLabel) swLabel.textContent = tSettings('languagePickerSwitch');
    if (trigger) trigger.setAttribute('aria-label', tSettings('language'));
    if (options) {
        options.innerHTML = '';
        for (const code of SUPPORTED_LANGUAGE_CODES) {
            if (code === lang) continue;
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'language-picker-option language-picker-option--switch';
            button.setAttribute('role', 'option');
            button.dataset.languageCode = code;
            button.innerHTML = `
                <span class="language-picker-flag-wrap" aria-hidden="true">${LANGUAGE_FLAG_SVG[code] || ''}</span>
                <span class="language-picker-name">${languageNativeLabel(code)}</span>
            `;
            options.appendChild(button);
        }
    }
}

function syncLanguagePickerUI() {
    for (const rootId of LANGUAGE_PICKER_ROOT_IDS) {
        syncLanguagePickerUIForRoot(rootId);
    }
}

function switchLanguageSetting(next) {
    if (!SUPPORTED_LANGUAGE_CODES.includes(next)) return;
    if (!state.appData.settings) state.appData.settings = {};
    state.appData.settings.language = next;
    applySettingsLanguage();
    saveData();
    if (!state.isIOS) void refreshBehaviourBannerIfStale({ force: true });
    if (state.isIOS) void syncIOSStartWarnings(); // the booked wording is in the old language
    closeAllLanguagePickers();
}

let languagePickerDocClickBound = false;

function setupLanguagePickerForRoot(rootId) {
    const { picker, trigger, dropdown, options } = languagePickerElements(rootId);
    if (!picker || !trigger || !dropdown || !options) return;
    if (picker.dataset.bound === '1') return;
    picker.dataset.bound = '1';

    trigger.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const isOpen = trigger.getAttribute('aria-expanded') === 'true';
        setLanguagePickerOpen(!isOpen, rootId);
    });

    dropdown.addEventListener('click', (e) => e.stopPropagation());

    options.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-language-code]');
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        switchLanguageSetting(btn.dataset.languageCode);
    });
}

export function setupLanguagePicker() {
    for (const rootId of LANGUAGE_PICKER_ROOT_IDS) {
        setupLanguagePickerForRoot(rootId);
    }

    if (!languagePickerDocClickBound) {
        languagePickerDocClickBound = true;
        document.addEventListener('click', () => {
            closeAllLanguagePickers();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            if (isAnyLanguagePickerOpen()) closeAllLanguagePickers();
        });
    }
}

/** Confirmation modals — describe typing challenge count + time estimate */
export function formatConfirmModalOverrideTypingLine({ type, count, estimatedMinutes, customText = '' }) {
    const minutes = estimatedMinutes;
    const lang = getSettingsLanguage();
    const wordUnitEn = count === 1 ? 'word' : 'words';
    const wordUnit = lang === 'zh-CN' ? '词' : (lang === 'da' ? 'ord' : wordUnitEn);

    if (normalizeOverrideType(type) === 'custom') {
        return tSettingsFmt('confirmOverrideCustomPhraseFmt', {
            customText: escapeHtml(typeof customText === 'string' ? customText : '')
        });
    }
    return tSettingsFmt('confirmOverrideRandomWordsIosFmt', { count, wordUnit, minutes });
}

/** Static copy on the migration / extension-setup overlay — call when language changes. */
export function applyMigrationOverlayStaticCopy() {
    invalidateMigrationMacCopyCache();
    const setHtml = (id, html) => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = html;
    };
    const setText = (id, text) => {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    };
    setText('migration-pre-title', tSettings('migrationPreWelcomeTitle'));
    setText('migration-pre-subtitle', tSettings('migrationPreSubtitle'));
    setHtml('migration-pre-explainer', tSettings('migrationPreExplainerHtml'));
    setText('migration-pre-bullet-1', tSettings('migrationPreBulletHelper'));
    setHtml('migration-pre-bullet-2', tSettings('migrationPreBulletHostsHtml'));
    setText('migration-pre-bullet-3', tSettings('migrationPreBulletBlocklists'));
    setHtml('migration-pre-warn', tSettings('migrationPreWarnHtml'));
    setText('migration-checklist-cleaned-label', tSettings('migrationChecklistCleanedOld'));
    setText('migration-checklist-blocks-label', tSettings('migrationChecklistBlocklistsPreserved'));
    syncMigrationPostHeader(state.lastMigrationBrowserState);
    setHtml('migration-checklist-ext-lines', migrationExtLinesHtml(state.lastMigrationBrowserState));
    setText('migration-howto-title', tSettings('migrationHowtoHeading'));
    if (state.isMacOSDesktop) {
        syncMigrationMacHowto(state.lastMigrationBrowserState);
    } else {
        setHtml('migration-howto-li1', tSettings('migrationHowtoLi1Html'));
        document.getElementById('migration-howto-li2')?.classList.add('hidden');
        document.getElementById('migration-howto-li3')?.classList.remove('hidden');
        setHtml('migration-howto-li3', tSettings('migrationHowtoLi3Html'));
    }
    setText('migration-done-btn', tSettings('migrationDone'));
    setText('migration-skip-btn', tSettings('migrationSkip'));
    setText('migration-back-btn', tSettings('eulaBackBtn'));
    syncMigrationPostBackButtonVisibility();
    setText('enforcement-toggle-headline-text', tSettings('migrationEnforcementHeadline'));
    void applyEnforcementDescCopy(state.lastMigrationBrowserState);
    setText('enforcement-toggle-disable-note-text', tSettings('migrationEnforcementDisableNote'));
    void updateAllEnforcementToggleLocks();
    setText('settings-enforcement-heading', tSettings('settingsEnforcementHeading'));
    const continueBtn = document.getElementById('migration-continue-btn');
    if (continueBtn && !continueBtn.disabled) {
        continueBtn.textContent = tSettings('migrationContinue');
    }
    setText('migration-post-title', tSettings('migrationPostTitleCleanup'));
    setText('migration-post-subtitle', tSettings('migrationPostSubtitleCleanup'));
}

/** First-run EULA screen — localized from current UI language / saved preference / browser locale (da). */
export function applyEulaOnboardingLanguage() {
    const title = tSettings('welcomeOnboardingTitle');

    const shieldLogo = document.getElementById('eula-onboarding-shield-logo');
    if (shieldLogo) {
        shieldLogo.src = logoReddShieldUrl;
        shieldLogo.alt = '';
    }

    const heading = document.getElementById('eula-welcome-title');
    if (heading) heading.innerHTML = title;

    const headingIos = document.getElementById('eula-welcome-title-ios');
    if (headingIos) headingIos.innerHTML = title;

    const subtitle = document.getElementById('eula-onboarding-subtitle');
    if (subtitle) subtitle.textContent = tSettings('welcomeOnboardingSubtitle');

    const subtitleIos = document.getElementById('eula-onboarding-subtitle-ios');
    if (subtitleIos) subtitleIos.textContent = tSettings('welcomeOnboardingSubtitle');

    const appIcon = document.getElementById('eula-onboarding-app-icon');
    if (appIcon) appIcon.setAttribute('alt', tSettings('eulaWelcomeIconAlt'));

    const agreeInner = document.getElementById('eula-agree-line-inner');
    if (agreeInner) agreeInner.innerHTML = tSettings('eulaAgreeLineHtml');

    const privacyTitle = document.getElementById('eula-privacy-title');
    if (privacyTitle) privacyTitle.textContent = tSettings('eulaPrivacyTitle');
    const privacyLead = document.getElementById('eula-privacy-lead');
    if (privacyLead) privacyLead.textContent = tSettings('eulaPrivacyLead');
    const howWeCountSummary = document.getElementById('eula-how-we-count-summary');
    if (howWeCountSummary) howWeCountSummary.textContent = tSettings('eulaHowWeCount');
    const howWeCountBody = document.getElementById('eula-how-we-count-body');
    if (howWeCountBody) howWeCountBody.innerHTML = tSettings('eulaHowWeCountHtml');
    document.getElementById('eula-how-we-count')?.classList.remove('hidden');

    const blurb = document.getElementById('eula-project-blurb');
    if (blurb) blurb.innerHTML = tSettings('eulaProjectBlurb');

    const footer1 = document.getElementById('eula-onboarding-footer-1');
    if (footer1) footer1.innerHTML = tSettings('welcomeFooter1Html');

    const cb = document.getElementById('eula-agree-checkbox');
    if (cb) cb.setAttribute('aria-label', tSettings('eulaAgreeAria'));

    const continueBtn = document.getElementById('eula-continue-btn');
    if (continueBtn) continueBtn.textContent = tSettings('eulaContinueBtn');

    const backBtn = document.getElementById('eula-back-btn');
    if (backBtn) {
        backBtn.textContent = tSettings('eulaBackBtn');
        backBtn.classList.toggle('hidden', state.isIOS);
    }
}

/** iOS Screen Time permission onboarding — localized from current UI language. */
export function applyIosScreentimeOnboardingLanguage() {
    const icon = document.getElementById('ios-screentime-onboarding-app-icon');
    if (icon) icon.setAttribute('alt', tSettings('eulaWelcomeIconAlt'));

    const title = document.getElementById('ios-screentime-onboarding-title');
    if (title) title.innerHTML = tSettings('welcomeOnboardingTitle');

    const body = document.getElementById('ios-screentime-onboarding-body');
    if (body) body.textContent = tSettings('iosScreentimeOnboardingBody');

    const grantBtn = document.getElementById('ios-screentime-grant-btn');
    if (grantBtn && !grantBtn.disabled) {
        grantBtn.textContent = tSettings('iosScreentimeGrantBtn');
    }

    const note = document.getElementById('ios-screentime-onboarding-note');
    if (note) note.innerHTML = tSettings('eulaProjectBlurb');
}

/** Welcome onboarding screen — localized in the same way as the EULA screen. */
export function applyRebrandOnboardingLanguage() {
    const icon = document.getElementById('rebrand-onboarding-app-icon');
    if (icon) {
        // Match EULA / welcome: bare shield mark, not the square app-icon tile.
        icon.src = logoReddShieldUrl;
        icon.alt = tSettings('eulaWelcomeIconAlt');
    }

    const title = document.getElementById('rebrand-onboarding-title');
    if (title) title.innerHTML = tSettings('rebrandNoticeTitleHtml');

    const subtitle = document.getElementById('rebrand-onboarding-subtitle');
    if (subtitle) subtitle.textContent = tSettings('rebrandNoticeSubtitle');

    const body1 = document.getElementById('rebrand-onboarding-body-1');
    if (body1) body1.innerHTML = tSettings('rebrandNoticeBody1Html');

    const body2 = document.getElementById('rebrand-onboarding-body-2');
    if (body2) body2.innerHTML = tSettings('rebrandNoticeBody2Html');

    const continueBtn = document.getElementById('rebrand-onboarding-continue-btn');
    if (continueBtn) continueBtn.textContent = tSettings('rebrandNoticeContinueBtn');
}

export function applyWelcomeOnboardingLanguage() {
    const shieldLogo = document.getElementById('welcome-onboarding-shield-logo');
    if (shieldLogo) {
        shieldLogo.src = logoReddShieldUrl;
        shieldLogo.alt = '';
    }

    const heading = document.getElementById('welcome-onboarding-title');
    if (heading) heading.innerHTML = tSettings('welcomeOnboardingTitle');

    const subtitle = document.getElementById('welcome-onboarding-subtitle');
    if (subtitle) subtitle.textContent = tSettings('welcomeOnboardingSubtitle');

    const howHeading = document.getElementById('welcome-how-heading');
    if (howHeading) howHeading.textContent = tSettings('welcomeHowHeading');

    const focusLogoHtml =
        `<img src="${logoReddFocusUrl}" alt="" class="welcome-reddfocus-inline-logo" aria-hidden="true"> `;
    const appleLogoHtml =
        `<img src="${appleLogoUrl}" alt="" class="welcome-apple-inline-logo" aria-hidden="true"> `;

    const stepMac = document.getElementById('welcome-step-mac');
    const stepFirefox = document.getElementById('welcome-step-firefox');

    const step1Title = document.getElementById('welcome-step-1-title');
    const step1Body = document.getElementById('welcome-step-1-body');
    const step2Title = document.getElementById('welcome-step-2-title');
    const step2Body = document.getElementById('welcome-step-2-body');

    if (state.isMacOSDesktop) {
        stepMac?.classList.remove('hidden');
        stepFirefox?.classList.toggle('hidden', !welcomeFirefoxInstalled);

        if (step1Title) {
            step1Title.innerHTML = tSettings('welcomeStep1TitleAutomationHtml').replace('{APPLE}', appleLogoHtml);
        }
        if (step1Body) step1Body.innerHTML = tSettings('welcomeStep1BodyAutomationHtml');

        if (welcomeFirefoxInstalled) {
            if (step2Title) {
                step2Title.innerHTML = tSettings('welcomeStep2TitleFirefoxHtml')
                    .replace('{APPLE}', appleLogoHtml)
                    .replace('{LOGO}', focusLogoHtml);
            }
            if (step2Body) {
                step2Body.innerHTML = tSettings('welcomeStep2BodyFirefoxHtml');
            }
        }
    } else {
        stepMac?.classList.add('hidden');
        stepFirefox?.classList.remove('hidden');

        let step2TitleKey = 'welcomeStep2TitleHtml';
        let step2BodyKey = 'welcomeStep2BodyHtml';
        if (state.isIOS) {
            step2TitleKey = 'welcomeStep2TitleIosHtml';
            step2BodyKey = 'welcomeStep2BodyIosHtml';
        }

        if (step2Title) step2Title.innerHTML = tSettings(step2TitleKey);
        if (step2Body) {
            step2Body.innerHTML = tSettings(step2BodyKey).replace('{LOGO}', focusLogoHtml);
        }
    }

    const step3Title = document.getElementById('welcome-step-3-title');
    if (step3Title) step3Title.textContent = tSettings('welcomeStep3TitleHtml');
    const step3Body = document.getElementById('welcome-step-3-body');
    if (step3Body) step3Body.innerHTML = tSettings('welcomeStep3BodyHtml');

    document.querySelectorAll('#welcome-onboarding .welcome-step:not(.hidden) .welcome-step-num').forEach((num, i) => {
        num.textContent = String(i + 1);
    });

    const demoToggleLabel = document.getElementById('welcome-demo-toggle-label');
    if (demoToggleLabel) demoToggleLabel.textContent = tSettings('welcomeDemoToggleLabel');

    const demoCaption = document.getElementById('welcome-demo-video-caption');
    if (demoCaption) demoCaption.textContent = tSettings('welcomeDemoVideoCaption');

    syncWelcomeDemoPlayLabel();

    const closeLabel = document.getElementById('welcome-demo-close-label');
    if (closeLabel) closeLabel.textContent = tSettings('welcomeDemoCloseLabel');
    const closeBtn = document.getElementById('welcome-demo-close-btn');
    if (closeBtn) closeBtn.setAttribute('aria-label', tSettings('welcomeDemoCloseLabel'));

    syncWelcomeDemoFullscreenLabel();

    const demoVideo = document.getElementById('welcome-demo-video');
    if (demoVideo && !demoVideo.src) {
        import('./reddblock-video.mp4').then(({ default: welcomeDemoVideoUrl }) => {
            if (!demoVideo.src) demoVideo.src = welcomeDemoVideoUrl;
        });
    }

    const continueBtn = document.getElementById('welcome-onboarding-continue-btn');
    if (continueBtn) continueBtn.textContent = tSettings('welcomeOnboardingContinueBtn');

    const footer1 = document.getElementById('welcome-onboarding-footer-1');
    if (footer1) footer1.innerHTML = tSettings('welcomeFooter1Html');

}

function isWelcomeDemoVideoExpanded() {
    return document.getElementById('welcome-demo-video-wrap')?.classList.contains('welcome-demo-video-wrap--expanded') ?? false;
}

function setWelcomeDemoVideoExpanded(expanded) {
    const wrap = document.getElementById('welcome-demo-video-wrap');
    const fullscreenBtn = document.getElementById('welcome-demo-fullscreen-btn');
    const closeBtn = document.getElementById('welcome-demo-close-btn');
    if (!wrap) return;
    wrap.classList.toggle('welcome-demo-video-wrap--expanded', expanded);
    fullscreenBtn?.toggleAttribute('hidden', expanded);
    closeBtn?.toggleAttribute('hidden', !expanded);
    syncWelcomeDemoFullscreenLabel();
}

function syncWelcomeDemoFullscreenLabel() {
    const fullscreenBtn = document.getElementById('welcome-demo-fullscreen-btn');
    if (!fullscreenBtn) return;
    fullscreenBtn.setAttribute(
        'aria-label',
        tSettings(isWelcomeDemoVideoExpanded() ? 'welcomeDemoFullscreenExitAriaLabel' : 'welcomeDemoFullscreenEnterAriaLabel'),
    );
}

function syncWelcomeDemoPlayLabel() {
    const playBtn = document.getElementById('welcome-demo-play-btn');
    const video = document.getElementById('welcome-demo-video');
    if (!playBtn || !video) return;
    const labelKey = video.paused
        ? (video.currentTime > 0 ? 'welcomeDemoResumeAriaLabel' : 'welcomeDemoPlayAriaLabel')
        : 'welcomeDemoPauseAriaLabel';
    playBtn.setAttribute('aria-label', tSettings(labelKey));
}

function syncWelcomeDemoVideoCaption() {
    const caption = document.getElementById('welcome-demo-video-caption');
    const video = document.getElementById('welcome-demo-video');
    if (!caption || !video) return;
    caption.classList.toggle('hidden', !video.paused);
}

function toggleWelcomeDemoPlayback(video) {
    if (video.paused) {
        video.play().catch(() => {});
    } else {
        video.pause();
    }
}

export function resetWelcomeDemoPanel() {
    const toggle = document.getElementById('welcome-demo-toggle');
    const panel = document.getElementById('welcome-demo-panel');
    const video = document.getElementById('welcome-demo-video');
    const playBtn = document.getElementById('welcome-demo-play-btn');
    setWelcomeDemoVideoExpanded(false);
    if (toggle) {
        toggle.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
    }
    if (panel) panel.classList.add('hidden');
    if (video) {
        video.pause();
        video.currentTime = 0;
    }
    if (playBtn) playBtn.classList.remove('hidden');
    syncWelcomeDemoVideoCaption();
}

function initWelcomeDemoControls() {
    const toggle = document.getElementById('welcome-demo-toggle');
    const panel = document.getElementById('welcome-demo-panel');
    const videoWrap = document.getElementById('welcome-demo-video-wrap');
    const video = document.getElementById('welcome-demo-video');
    const playBtn = document.getElementById('welcome-demo-play-btn');
    const fullscreenBtn = document.getElementById('welcome-demo-fullscreen-btn');
    const closeBtn = document.getElementById('welcome-demo-close-btn');
    if (!toggle || !panel || !video || !playBtn) return;

    toggle.addEventListener('click', () => {
        const isOpen = toggle.classList.toggle('open');
        toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        panel.classList.toggle('hidden', !isOpen);
        if (!isOpen) {
            setWelcomeDemoVideoExpanded(false);
            video.pause();
            video.currentTime = 0;
            playBtn.classList.remove('hidden');
        }
    });

    playBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        toggleWelcomeDemoPlayback(video);
    });

    fullscreenBtn?.addEventListener('click', (event) => {
        event.stopPropagation();
        setWelcomeDemoVideoExpanded(true);
    });

    closeBtn?.addEventListener('click', (event) => {
        event.stopPropagation();
        setWelcomeDemoVideoExpanded(false);
    });

    let demoClickTimer = null;
    video.addEventListener('click', () => {
        if (demoClickTimer) clearTimeout(demoClickTimer);
        demoClickTimer = setTimeout(() => {
            demoClickTimer = null;
            toggleWelcomeDemoPlayback(video);
        }, 220);
    });

    video.addEventListener('dblclick', (event) => {
        event.preventDefault();
        if (demoClickTimer) {
            clearTimeout(demoClickTimer);
            demoClickTimer = null;
        }
        if (isWelcomeDemoVideoExpanded()) {
            setWelcomeDemoVideoExpanded(false);
        } else {
            setWelcomeDemoVideoExpanded(true);
        }
    });

    window.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && isWelcomeDemoVideoExpanded()) {
            event.preventDefault();
            setWelcomeDemoVideoExpanded(false);
        }
    }, true);

    videoWrap?.addEventListener('click', (event) => {
        if (!isWelcomeDemoVideoExpanded() || event.target !== videoWrap) return;
        setWelcomeDemoVideoExpanded(false);
    });

    video.addEventListener('play', () => {
        playBtn.classList.add('hidden');
        syncWelcomeDemoPlayLabel();
        syncWelcomeDemoVideoCaption();
    });
    video.addEventListener('pause', () => {
        if (video.currentTime < video.duration) playBtn.classList.remove('hidden');
        syncWelcomeDemoPlayLabel();
        syncWelcomeDemoVideoCaption();
    });
    video.addEventListener('ended', () => {
        playBtn.classList.remove('hidden');
        video.currentTime = 0;
        syncWelcomeDemoPlayLabel();
        syncWelcomeDemoVideoCaption();
    });
}

function formatCurrentVersionText(version) {
    return `${tSettings('yourVersionPrefix')} ${version || 'Unknown'}`;
}

function formatLatestVersionText(version) {
    return `${tSettings('latestVersionPrefix')} ${version || 'Unknown'}`;
}

export function applyFormattedCurrentVersion(el, version) {
    if (!el) return;
    el.dataset.appVersion = version || 'Unknown';
    el.textContent = formatCurrentVersionText(el.dataset.appVersion);
}

export function applyFormattedLatestVersion(el, version) {
    if (!el) return;
    el.dataset.appVersion = version;
    el.textContent = formatLatestVersionText(version);
}

function refreshSettingsVersionLabels() {
    const currentVersionEl = document.getElementById('current-app-version');
    if (currentVersionEl?.dataset.appVersion) {
        currentVersionEl.textContent = formatCurrentVersionText(currentVersionEl.dataset.appVersion);
    }
    const latestVersionEl = document.getElementById('latest-app-version');
    if (latestVersionEl?.dataset.appVersion) {
        latestVersionEl.textContent = formatLatestVersionText(latestVersionEl.dataset.appVersion);
    }
}

export function applySettingsLanguage() {
    const setText = (id, text) => {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    };
    const setHtml = (id, html) => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = html;
    };

    // Main shell / scheduler
    setText('update-banner-prefix', tSettings('updateBannerPrefix'));
    setText('update-banner-suffix', tSettings('updateBannerSuffix'));
    if (!updateDownloadInProgress) {
        setText('update-banner-link', tSettings('updateBannerCta'));
    }
    const updateWhatsNewBtn = document.getElementById('update-banner-whats-new');
    if (updateWhatsNewBtn && !updateWhatsNewBtn.classList.contains('hidden')) {
        updateWhatsNewBtn.innerHTML = updateBannerWhatsNewButtonHtml();
    }
    setText(
        'setup-banner-headline',
        tSettings(state.isMacOSDesktop ? 'setupBrowsersBannerHeadlineMac' : 'setupBrowsersBannerHeadline'),
    );
    syncSetupBannerHeadline();
    setText('behaviour-change-help', tSettings('setupBrowsersBannerCta'));
    const behaviourDismissBtn = document.getElementById('behaviour-change-dismiss');
    if (behaviourDismissBtn) {
        behaviourDismissBtn.title = tSettings('setupBrowsersBannerDismissTitle');
    }
    setText('instant-mode-tab-label', tSettings('modeTimer'));
    setText('schedule-mode-tab-label', tSettings('modeSchedule'));
    const blocklistSelect = document.getElementById('blocklist-select');
    if (blocklistSelect && blocklistSelect.options.length > 0) {
        blocklistSelect.options[0].textContent = tSettings('selectionPromptOption');
    }
    setText('main-blocklists-title', tSettings('yourBlocklists'));
    setText('add-blocklist-btn-label', tSettings('addFocusSpaceBtn'));
    const addBlocklistBtn = document.getElementById('add-blocklist-btn');
    if (addBlocklistBtn) addBlocklistBtn.title = tSettings('addFocusSpaceBtn');
    setText('allow-only-blocklist-btn-label', tSettings('allowOnlyBtn'));
    const allowOnlyBtn = document.getElementById('allow-only-blocklist-btn');
    if (allowOnlyBtn) {
        allowOnlyBtn.title = tSettings('allowOnlyBtn');
        allowOnlyBtn.setAttribute('aria-label', tSettings('allowOnlyBtn'));
    }
    syncBlocklistCreateUi({ isCreate: !state.editingBlocklistId });
    const createActions = document.querySelector('.blocklists-create-actions');
    if (createActions) createActions.setAttribute('aria-label', tSettings('blocklistsCreateActionsAria'));
    setText('main-schedule-title', tSettings('scheduleTitle'));
    setText('no-active-blocks-label', tSettings('noActiveBlocks'));
    setText('always-on-row-label-lead', tSettings('alwaysOnRowLead'));
    setText(
        'always-on-row-label-hint',
        ` (${tSettings('alwaysOnRowTimelineHint')}):`
    );
    setText('schedule-footer-hint', tSettings('scheduleFooterHint'));
    setText('schedule-strictness-label', `${tSettings('scheduleStrictnessLabel')}${tSettings('stopScheduleMetaColon')}`);
    // The option titles and descriptions are mode-aware: updateBlocklistModalModeLabels below.
    setText('schedule-panel-overlay-label', tSettings('scheduleActiveOverlayLabel'));
    setText('footer-made-with', tSettings('madeWith'));
    setText('footer-by', tSettings('by'));
    const footerOrgLink = document.getElementById('footer-org-link');
    if (footerOrgLink) {
        footerOrgLink.textContent = tSettings('footerOrgLabel');
        footerOrgLink.href = tSettings('footerOrgUrl');
    }
    const setPlaceholder = (id, text) => {
        const el = document.getElementById(id);
        if (el) el.placeholder = text;
    };
    setPlaceholder('blocklist-name', tSettings('placeholderNameExample'));
    syncModalAppPlaceholder();
    syncModalWebsitePlaceholder();
    setPlaceholder('challenge-input', tSettings('typeHere'));
    setPlaceholder('override-all-challenge-input', tSettings('typeHere'));
    setText('website-input-error', tSettings('invalidDomainMsg'));
    setPlaceholder('custom-override-text', tSettings('placeholderCustomOverride'));
    setText('custom-override-text-error', tSettings('customOverrideEmptyError'));

    // Focus-space editor
    applyFocusSpaceEditorLanguage();
    updateBlocklistModalModeLabels(getSelectedBlocklistModalMode());
    setText('override-method-label', tSettings('overrideMethod'));
    setText('override-option-random-words', tSettings('overrideRandomWords'));
    setText('override-option-custom', tSettings('overrideCustomText'));
    syncOverrideCountUi();
    updateOverridePreview();
    setText('blocklist-emoji-label', tSettings('emoji'));
    setText('blocklist-color-label', tSettings('color'));
    setText('websites-import-menu-text-file-label', tSettings('importWebsitesFromFile'));
    setText('websites-import-menu-section-label', tSettings('importWebsitesPreMadeList'));
    setText('websites-import-menu-email', tSettings('importPresetEmail'));
    setText('websites-import-menu-gambling', tSettings('importPresetGambling'));
    setText('websites-import-menu-news', tSettings('importPresetNews'));
    setText('websites-import-menu-porn', tSettings('importPresetPorn'));
    setText('websites-import-menu-search-engines', tSettings('importPresetSearchEngines'));
    setText('websites-import-menu-shopping', tSettings('importPresetShopping'));
    setText('websites-import-menu-social-media', tSettings('importPresetSocialMedia'));
    const importWebsitesBtn = document.getElementById('modal-import-websites-btn');
    if (importWebsitesBtn) {
        importWebsitesBtn.title = tSettings('importWebsitesTitle');
        importWebsitesBtn.setAttribute('aria-label', tSettings('importWebsitesTitle'));
    }
    setText('modal-import-websites-caption', tSettings('modalPremadeListsCaption'));
    setText('modal-browse-apps-caption', tSettings('modalBrowseAppsCaption'));
    const modalBrowseAppsBtn = document.getElementById('modal-browse-apps-btn');
    if (modalBrowseAppsBtn) {
        modalBrowseAppsBtn.title = tSettings('modalBrowseAppsCaption');
        modalBrowseAppsBtn.setAttribute('aria-label', tSettings('modalBrowseAppsCaption'));
    }
    setText('cancel-blocklist-btn', tSettings('cancel'));
    setText('save-blocklist-btn', tSettings('save'));

    // Modal copy
    setText('override-confirm-blocking-label', tSettings('startConfirmBlockingLabel'));
    setText('override-confirm-show-all-blocking', tSettings('showAll'));
    setText('override-modal-instruction', tSettings('overrideInstruction'));
    setText('override-modal-word-instruction', tSettings('challengeWordInstruction'));
    setText('cancel-override-btn', tSettings('cancel'));
    updatePauseDialogDuration();
    setText('confirm-override-header', tSettings('startBlockHoldHeader'));
    setText('start-confirm-blocking-label', tSettings('startConfirmBlockingLabel'));
    setText('start-confirm-show-all-blocking', tSettings('showAll'));
    setText('start-confirm-unlock-label', tSettings('startConfirmUnlockLabel'));
    setText('cancel-start-confirm-btn', tSettings('cancel'));
    setStartConfirmPrimaryLabel('proceed-start-confirm-btn', tSettings('startBlock'));
    const panelOverlayCustomiseBtn = document.getElementById('schedule-panel-overlay-customise-btn');
    if (panelOverlayCustomiseBtn) {
        panelOverlayCustomiseBtn.title = tSettings('scheduleOverlayCustomiseBtn');
        panelOverlayCustomiseBtn.setAttribute('aria-label', tSettings('scheduleOverlayCustomiseBtn'));
    }
    syncScheduleOverlayCustomiseTitle();
    setText('schedule-overlay-select-label', tSettings('scheduleOverlaySelectLabel'));
    setText('schedule-overlay-select-unsaved-badge', tSettings('scheduleOverlayUnsavedBadge'));
    setText('schedule-overlay-add-new-btn', tSettings('scheduleOverlayAddNewBtn'));
    setText('schedule-overlay-delete-btn', tSettings('scheduleOverlayDeleteBtn'));
    setText('schedule-overlay-delete-title', tSettings('scheduleOverlayDeleteConfirmTitle'));
    setText('cancel-schedule-overlay-delete-btn', tSettings('cancel'));
    setText('confirm-schedule-overlay-delete-btn', tSettings('scheduleOverlayDeleteBtn'));
    setText('schedule-overlay-discard-title', tSettings('scheduleOverlayDiscardConfirmTitle'));
    setText('cancel-schedule-overlay-discard-btn', tSettings('scheduleOverlayKeepEditingBtn'));
    setText('confirm-schedule-overlay-discard-btn', tSettings('scheduleOverlayDiscardConfirmBtn'));
    if (isScheduleOverlayCustomiseModalOpen() && state.scheduleOverlayCustomiseSelection) {
        populateScheduleOverlayCustomiseSelector(state.scheduleOverlayCustomiseSelection);
        syncScheduleOverlayCustomiseEditorState(state.scheduleOverlayCustomiseSelection);
        syncScheduleOverlayCustomiseTitle(state.scheduleOverlayCustomiseSelection);
        syncScheduleOverlayCustomiseDirtyState();
        const noticeEl = document.getElementById('schedule-overlay-default-notice');
        if (noticeEl && state.scheduleOverlayCustomiseSelection === SCHEDULE_OVERLAY_DEFAULT_PRESET_VALUE) {
            noticeEl.textContent = tSettings('scheduleOverlayDefaultNotice');
        }
    }
    setText('schedule-overlay-name-label', tSettings('scheduleOverlayNameLabel'));
    const overlayNameInput = document.getElementById('schedule-overlay-name-input');
    if (overlayNameInput) overlayNameInput.placeholder = tSettings('scheduleOverlayNamePlaceholder');
    setText('schedule-overlay-heading-label', tSettings('scheduleOverlayHeadingLabel'));
    setText('schedule-overlay-heading-placeholders-note', tSettings('scheduleOverlayHeadingPlaceholdersHint'));
    const overlayHeadingInput = document.getElementById('schedule-overlay-heading-input');
    if (overlayHeadingInput) overlayHeadingInput.placeholder = tSettings('scheduleOverlayHeadingPlaceholder');
    setText('schedule-overlay-message-label', tSettings('scheduleOverlayMessageLabel'));
    setText('schedule-overlay-message-placeholders-note', tSettings('scheduleOverlayMessagePlaceholdersHint'));
    setText('schedule-overlay-lets-go-label', tSettings('scheduleOverlayLetsGoFieldLabel'));
    setText('schedule-overlay-image-label', tSettings('scheduleOverlayImageLabel'));
    setText('schedule-overlay-image-drop-hint', tSettings('scheduleOverlayImageDropHint'));
    setText('schedule-overlay-voice-label', tSettings('scheduleOverlayVoiceLabel'));
    setText('schedule-overlay-voice-help', tSettings('scheduleOverlayVoiceHelp'));
    setText('schedule-overlay-choose-image-btn', tSettings('scheduleOverlayChooseImage'));
    setText('schedule-overlay-record-voice-btn-label', tSettings('scheduleOverlayRecordVoice'));
    setText('schedule-overlay-stop-record-voice-btn-label', tSettings('scheduleOverlayStopRecording'));
    setText('schedule-overlay-choose-voice-btn', tSettings('scheduleOverlayChooseAudio'));
    setText('schedule-overlay-preview-label', tSettings('scheduleOverlayPreviewLabel'));
    setText('schedule-overlay-customise-cancel-btn', tSettings('cancel'));
    setText('schedule-overlay-customise-save-btn', tSettings('scheduleOverlaySaveBtn'));
    setText('schedule-overlay-reset-heading-btn', tSettings('scheduleOverlaySectionReset'));
    setText('schedule-overlay-reset-message-btn', tSettings('scheduleOverlaySectionReset'));
    setText('schedule-overlay-reset-button-btn', tSettings('scheduleOverlaySectionReset'));
    setText('schedule-overlay-reset-image-btn', tSettings('scheduleOverlaySectionReset'));
    setText('schedule-overlay-reset-voice-btn', tSettings('scheduleOverlaySectionReset'));
    setText('undo-toast-btn-label', tSettings('undo'));
    if (pendingDelete?.blocklist) {
        setUndoToastMessage(
            tSettings('deleteUndoToastPrefix'),
            pendingDelete.blocklist.name,
            tSettings('deleteUndoToastSuffix'),
        );
    } else if (pendingSegmentDelete) {
        setUndoToastMessage(
            tSettings('deleteSegmentUndoToastPrefix'),
            tSettings('deleteSegmentUndoToastEmphasis'),
        );
    }
    setText('override-all-title', tSettings('overrideAllTitle'));
    setText('override-all-warning-strong', tSettings('overrideAllWarningStrong'));
    setText('override-all-warning-body', tSettings('overrideAllWarningBody'));
    setText('override-all-instruction', tSettings('overrideAllInstruction'));
    setText('override-all-word-instruction', tSettings('challengeWordInstruction'));
    setText('cancel-override-all-btn', tSettings('cancel'));
    setText('confirm-override-all-btn', tSettings('overrideAll'));

    setText('settings-modal-title', tSettings('settingsTitle'));
    setText('settings-general-heading', tSettings('settingsGeneralHeading'));
    setText('settings-manage-heading', tSettings('settingsManageHeading'));
    setText('settings-theme-label', tSettings('lightDarkMode'));
    setText('settings-zoom-label', tSettings('zoomLevel'));
    setText('settings-language-label', tSettings('language'));
    syncLanguagePickerUI();
    setText('theme-option-system', tSettings('themeAuto'));
    setText('theme-option-light', tSettings('themeLight'));
    setText('theme-option-dark', tSettings('themeDark'));
    setText('settings-override-all-label', tSettings('settingsOverrideAllLabel'));
    setText('settings-override-all-hint', tSettings('settingsOverrideAllHint'));
    setText('settings-override-all-btn-label', tSettings('settingsOverrideAllBtn'));
    setText('settings-uninstall-label', tSettings('uninstallApp'));
    setText('settings-uninstall-hint', tSettings('settingsUninstallHint'));
    setText('settings-uninstall-btn-label', tSettings('uninstallAppBtn'));
    setText('settings-windows-uninstall-label', tSettings('uninstallApp'));
    setText('settings-windows-uninstall-hint', tSettings('windowsUninstallHint'));
    setText('settings-windows-uninstall-btn-label', tSettings('windowsUninstallOpenSettingsBtn'));
    setText('settings-help-label', tSettings('settingsDiagnosticsLabel'));
    setText('settings-enforcement-heading', tSettings('settingsEnforcementHeading'));
    setText('settings-blocking-method-toggle-label', tSettings('settingsBlockingMethodHeading'));
    setText('settings-blocking-method-hint', tSettings(state.isWindowsDesktop ? 'settingsBlockingMethodHintWindows' : 'settingsBlockingMethodHint'));
    setText('settings-blocking-method-chrome-label', tSettings('settingsBlockingMethodChrome'));
    setText('settings-blocking-method-brave-label', tSettings('settingsBlockingMethodBrave'));
    setText('settings-blocking-method-edge-label', tSettings('settingsBlockingMethodEdge'));
    setText('settings-blocking-method-safari-label', tSettings('settingsBlockingMethodSafari'));
    setText('settings-blocking-method-firefox-label', tSettings('settingsBlockingMethodFirefox'));
    syncBlockingMethodLabelIcons();
    for (const key of ALL_BLOCKING_METHOD_KEYS) {
        const select = document.getElementById(`blocking-method-${key}`);
        if (!select) continue;
        const current = select.value || browserBlockingMethod(key);
        select.innerHTML = '';
        // Per browser, not one list for all: Firefox offers extension or
        // accessibility, the others automation or extension.
        const labelKeys = {
            automation: 'settingsBlockingMethodAutomation',
            extension: 'settingsBlockingMethodExtension',
            accessibility: 'settingsBlockingMethodAccessibility',
        };
        for (const value of methodOptionsForKey(key)) {
            const labelKey = labelKeys[value];
            const opt = document.createElement('option');
            opt.value = value;
            opt.textContent = tSettings(labelKey);
            if (value === current) opt.selected = true;
            select.appendChild(opt);
        }
    }
    setText('settings-enforcement-row-label', tSettings('settingsEnforcementRowLabel'));
    void applyEnforcementDescCopy(state.lastMigrationBrowserState);
    setText('settings-setup-btn-label', tSettings('settingsSetupBtn'));
    setText('settings-diagnostics-btn-label', tSettings('settingsDiagnosticsBtn'));
    setText('diagnostics-modal-title', tSettings('diagnosticsModalTitle'));
    setText('diagnostics-refresh-btn-label', tSettings('diagnosticsRefresh'));
    setText('diagnostics-copy-btn-label', tSettings('diagnosticsCopyReport'));
    setText('close-diagnostics-btn', tSettings('close'));
    setText('settings-onboarding-btn-label', tSettings('settingsOnboardingBtn'));
    setText('settings-blocklists-io-label', tSettings('settingsBlocklistsIoLabel'));
    setText('settings-blocklists-io-hint', tSettings('settingsBlocklistsIoHint'));
    setText('settings-usage-ping-label', tSettings('settingsUsagePingLabel'));
    setText('settings-usage-ping-hint', tSettings('settingsUsagePingHint'));
    applyStoreReviewPromptCopy();
    setText('settings-export-blocklists-btn-label', tSettings('settingsExportBlocklistsBtn'));
    setText('settings-import-blocklists-btn-label', tSettings('settingsImportBlocklistsBtn'));
    setText('uninstall-confirm-title', tSettings('uninstallConfirmTitle'));
    setText('uninstall-delete-data-label', tSettings('uninstallDeleteDataLabel'));
    syncUninstallConfirmModal(null);
    setText('cancel-uninstall-confirm-btn', tSettings('cancel'));
    setText('confirm-uninstall-confirm-btn', tSettings('uninstallConfirmOk'));
    applyMacAutomationIntroCopy();
    // The hint paragraph and button tooltip need re-translation too —
    // refreshUninstallButtonState reads from tSettings() and rewrites
    // both. Cheap to call unconditionally.
    refreshUninstallButtonState();
    updateOverrideAllButtonVisibility();
    void updateAllEnforcementToggleLocks();
    setText('settings-helper-service-label', tSettings('helperService'));
    setText('settings-update-helper-label', tSettings('updateHelper'));
    setText('settings-clean-hosts-label', tSettings('cleanHostsFile'));
    setText('settings-helper-hint', tSettings('helperHint'));
    setText('close-settings-btn', tSettings('settingsDone'));
    setText('grace-period-label-text', tSettings('gracePeriodLabel'));
    setText('grace-period-hint-text', tSettings('gracePeriodHint'));
    setText('settings-max-words-label', tSettings('maxOverrideWordsLabel'));
    setText('settings-max-words-hint', tSettings('maxOverrideWordsHint'));
    syncMaxOverrideWordsSetting();
    setText('app-blocking-lets-go-btn-label', tSettings('appBlockingLetsGo'));
    setText('app-blocking-snooze-btn-label', tSettings('appBlockingSnoozeBtn'));
    setHtml('settings-feedback-footer-text', tSettings('settingsFeedbackFooterHtml'));
    updateGraceSettingLock();
    refreshSettingsVersionLabels();

    const helperStatusText = document.getElementById('settings-helper-status-text');
    if (helperStatusText) {
        const raw = (helperStatusText.textContent || '').trim();
        const statusMap = {
            'Checking...': tSettings('helperStatusChecking'),
            'Active': tSettings('helperStatusActive'),
            'Idle': tSettings('helperStatusIdle'),
            'Installed, not reachable': tSettings('helperStatusInstalledNotReachable'),
            'Update available': tSettings('helperStatusUpdateAvailable'),
            'Not installed': tSettings('helperStatusNotInstalled'),
            'Unknown': tSettings('helperStatusUnknown'),
            'Tjekker...': tSettings('helperStatusChecking'),
            'Aktiv': tSettings('helperStatusActive'),
            'Inaktiv': tSettings('helperStatusIdle'),
            'Installeret, men ikke tilgaengelig': tSettings('helperStatusInstalledNotReachable'),
            'Installeret, men ikke tilgængelig': tSettings('helperStatusInstalledNotReachable'),
            'Opdatering tilgaengelig': tSettings('helperStatusUpdateAvailable'),
            'Opdatering tilgængelig': tSettings('helperStatusUpdateAvailable'),
            'Ikke installeret': tSettings('helperStatusNotInstalled'),
            'Ukendt': tSettings('helperStatusUnknown'),
        };
        if (statusMap[raw]) helperStatusText.textContent = statusMap[raw];
    }

    applyMigrationOverlayStaticCopy();
    applyEulaOnboardingLanguage();
    applyWelcomeOnboardingLanguage();
    applyRebrandOnboardingLanguage();
    applySafariFdaOnboardingLanguage();
    applyIosScreentimeOnboardingLanguage();
    applyStartWarningsLanguage();

    if (state.migrationOnboardingActive && state.lastMigrationBrowserState) {
        renderBrowserInstallButtons(state.lastMigrationBrowserState, { force: true });
    }

    // Re-render pieces with dynamic language-dependent text.
    renderAppBlockingWarningOverlay();
    renderAppBlockingClosedownBanner();
    renderBlocklists();
    if (document.getElementById('blocklist-select')) renderBlocklistSelector();
    if (typeof syncSelectedControlState === 'function') syncSelectedControlState();
    if (typeof updateWeekCalendar === 'function') updateWeekCalendar();
    if (typeof rebuildScheduleSegments === 'function') rebuildScheduleSegments();
    if (typeof updateOverridePreview === 'function') updateOverridePreview();
}
