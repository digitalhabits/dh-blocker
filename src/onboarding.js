// Onboarding: welcome screen, EULA acceptance/persistence, desktop
// migration overlay wiring. Extracted verbatim from app.js.
import { state, appState } from './state.js';
import { invoke } from '@tauri-apps/api/core';
import { tSettings } from './i18n.js';
import { hasSeenAnyOnboarding, saveData } from './persistence.js';
import { AUTOMATION_BROWSER_KEYS, BROWSER_INFO, browserIconUrl, browserUsesAutomation, lastAutomationPermissionByKey, lastOnboardingState, openNativePermissionSetup, refreshAutomationPermissionStatus, renderNativePermissionRows, startMigrationPolling, startWebAutomationWatcher, stopMigrationPolling, refreshNativePermissions } from './enforcement.js';
import {
    applyEulaOnboardingLanguage, applyMigrationOverlayStaticCopy, applyRebrandOnboardingLanguage,
    applyWelcomeOnboardingLanguage, resetWelcomeDemoPanel,
} from './app.js';
import { showExclusiveOnboardingScreen, updateOnboardingVisibility } from './blocking-platform.js';

export const CURRENT_EULA_REVISION = 1;

export function isLocalDevRun() {
    if (import.meta?.env?.DEV) {
        return true;
    }
    return ['http:', 'https:'].includes(window.location.protocol)
        && ['localhost', '127.0.0.1'].includes(window.location.hostname);
}

export async function resetDevOnlyEulaAcceptance() {
    // Mobile debug builds run through Vite too, but they should behave like
    // installed apps here: once the EULA is accepted, keep respecting it.
    state.forceShowEulaThisSession = !state.isIOS && !state.isAndroid && isLocalDevRun();
}

export function getAcceptedEulaRevision() {
    const rawRevision = state.appData?.settings?.eulaAcceptedRevision;
    if (Number.isInteger(rawRevision) && rawRevision > 0) {
        return rawRevision;
    }
    if (typeof rawRevision === 'string') {
        const parsedRevision = Number.parseInt(rawRevision, 10);
        if (Number.isInteger(parsedRevision) && parsedRevision > 0) {
            return parsedRevision;
        }
    }
    if (state.appData?.settings?.eulaAccepted === true) {
        return CURRENT_EULA_REVISION;
    }
    return null;
}

export function normalizeLoadedEulaState() {
    if (!state.appData.settings) {
        state.appData.settings = {};
    }

    let changed = false;
    const acceptedRevision = getAcceptedEulaRevision();

    if (acceptedRevision == null) {
        if (state.appData.settings.eulaAcceptedRevision != null) {
            delete state.appData.settings.eulaAcceptedRevision;
            changed = true;
        }
    } else if (state.appData.settings.eulaAcceptedRevision !== acceptedRevision) {
        state.appData.settings.eulaAcceptedRevision = acceptedRevision;
        changed = true;
    }

    const rawAcceptedAt = state.appData.settings.eulaAcceptedAt;
    if (rawAcceptedAt != null) {
        const parsedAcceptedAt = Number(rawAcceptedAt);
        if (Number.isFinite(parsedAcceptedAt) && parsedAcceptedAt > 0) {
            if (state.appData.settings.eulaAcceptedAt !== parsedAcceptedAt) {
                state.appData.settings.eulaAcceptedAt = parsedAcceptedAt;
                changed = true;
            }
        } else {
            delete state.appData.settings.eulaAcceptedAt;
            changed = true;
        }
    }

    if ('eulaAccepted' in state.appData.settings) {
        delete state.appData.settings.eulaAccepted;
        changed = true;
    }

    return changed;
}

export function hasAcceptedEula() {
    return !state.forceShowEulaThisSession && getAcceptedEulaRevision() === CURRENT_EULA_REVISION;
}

// ---- Welcome screen --------------------------------------------------------
//
// Friendly one-screen intro shown once per machine, before the EULA.
// Sets context (open-source, who built it) before legal acceptance
// and the macOS Automation / Firefox native permission setup overview.
//
// Persistence: `state.appData.settings.welcomeOnboardingShown` (boolean).
// Wiped by `scripts/dev-reset-fda-onboarding.sh` (incl. --nuke; it also
// clears any pre-3.x /var/lib/redd-block copy, which the backend would
// otherwise import straight back over the per-user file).
export function hasWelcomeOnboardingBeenShown() {
    return state.appData?.settings?.welcomeOnboardingShown === true;
}

export async function persistWelcomeOnboardingShown() {
    if (!state.appData.settings) state.appData.settings = {};
    state.appData.settings.welcomeOnboardingShown = true;
    try {
        await saveData();
    } catch (e) {
        console.warn('[welcome-onboarding] persist failed:', e);
    }
}

export async function runInitialOnboardingSequence() {
    if (__SYSTEM_TEST_BUILD__) {
        updateOnboardingVisibility();
        return;
    }
    if (!state.isIOS && !state.isAndroid) {
        if (shouldShowRebrandNotice()) {
            await presentRebrandNotice();
        } else if (!hasSeenRebrandNotice()) {
            // Fresh install: mark the rename notice as seen without showing
            // it, so completing onboarding later never retriggers it.
            await persistRebrandNoticeShown();
        }
    }
    if (!state.isIOS && !hasWelcomeOnboardingBeenShown()) {
        await presentWelcomeOnboarding();
        await persistWelcomeOnboardingShown();
    }
    updateOnboardingVisibility();
}

// ---- Digital Habits rename notice ------------------------------------------
//
// One-time announcement for users upgrading from ReDD Blocker: the app on
// disk is now "Digital Habits: Blocker" and the organisation behind it is
// now the Centre for Digital Habits. Desktop-only — mobile users see the
// rename in their app store update. Fresh installs never see it (the flag
// is persisted silently on first run, see runInitialOnboardingSequence).
//
// Persistence: `state.appData.settings.digitalHabitsRebrandNoticeShown`.
export function hasSeenRebrandNotice() {
    return state.appData?.settings?.digitalHabitsRebrandNoticeShown === true;
}

export function shouldShowRebrandNotice() {
    if (state.isIOS || state.isAndroid) return false;
    return hasSeenAnyOnboarding() && !hasSeenRebrandNotice();
}

export async function persistRebrandNoticeShown() {
    if (!state.appData.settings) state.appData.settings = {};
    state.appData.settings.digitalHabitsRebrandNoticeShown = true;
    try {
        await saveData();
    } catch (e) {
        console.warn('[rebrand-notice] persist failed:', e);
    }
}

export async function presentRebrandNotice() {
    const overlay = document.getElementById('rebrand-onboarding');
    const btn = document.getElementById('rebrand-onboarding-continue-btn');
    if (!overlay || !btn) return;

    showExclusiveOnboardingScreen('rebrand-onboarding');
    document.getElementById('main-content')?.classList.add('hidden');
    // Mirror the main title bar's window-control visibility (shown on
    // Windows) since this overlay covers the app's own title bar.
    const mainControlsHidden =
        document.getElementById('window-controls')?.classList.contains('hidden') ?? true;
    document.getElementById('rebrand-window-controls')?.classList.toggle('hidden', mainControlsHidden);
    applyRebrandOnboardingLanguage();

    await new Promise((resolve) => {
        const onClick = async () => {
            btn.removeEventListener('click', onClick);
            await persistRebrandNoticeShown();
            overlay.classList.add('hidden');
            updateOnboardingVisibility();
            resolve();
        };
        btn.addEventListener('click', onClick);
    });
}

export function presentWelcomeOnboarding(onContinue) {
    return (async () => {
        const overlay = document.getElementById('welcome-onboarding');
        const btn = document.getElementById('welcome-onboarding-continue-btn');
        if (!overlay || !btn) {
            return;
        }

        showExclusiveOnboardingScreen('welcome-onboarding');
        document.getElementById('main-content')?.classList.add('hidden');
        resetWelcomeDemoPanel();
        welcomeFirefoxInstalled = await detectWelcomeFirefoxInstalled();
        applyWelcomeOnboardingLanguage();

        await new Promise((resolve) => {
            const onClick = () => {
                btn.removeEventListener('click', onClick);
                overlay.classList.add('hidden');
                onContinue?.();
                resolve();
            };
            btn.addEventListener('click', onClick);
        });
    })();
}

export function syncSetupBannerHeadline() {
    const headlineEl = document.getElementById('setup-banner-headline');
    if (!headlineEl) return;
    const browsers = lastOnboardingState?.browsers;
    if (!browsers) {
        headlineEl.textContent = tSettings(state.isMacOSDesktop ? 'setupBrowsersBannerHeadlineMac' : 'setupBrowsersBannerHeadline');
        return;
    }
    const detectedKeys = Object.keys(BROWSER_INFO).filter(k => browsers[k] && browsers[k].installed);

}

export function showEulaOnboardingScreen() {
    showExclusiveOnboardingScreen('eula-onboarding');
    document.getElementById('main-content')?.classList.add('hidden');
    applyEulaOnboardingLanguage();
    const eulaContinueBtn = document.getElementById('eula-continue-btn');
    const eulaCheckbox = document.getElementById('eula-agree-checkbox');
    if (eulaCheckbox && hasAcceptedEula()) {
        eulaCheckbox.checked = true;
    }
    if (eulaContinueBtn) {
        eulaContinueBtn.disabled = !eulaCheckbox?.checked;
        eulaContinueBtn.textContent = tSettings('eulaContinueBtn');
    }
}

export function isFirstRunOnboardingInProgress() {
    if (!hasAcceptedEula()) return false;
    return state.firstRunNativePermissionSetupPending && !state.migrationOnboardingDismissed;
}

export function continueFirstRunOnboardingFromWelcome() {
    if (!hasAcceptedEula()) {
        updateOnboardingVisibility();
        return;
    }
    if (isFirstRunOnboardingInProgress()) {
        showEulaOnboardingScreen();
        return;
    }
    updateOnboardingVisibility();
}

/** macOS welcome screen: whether Firefox.app is on disk (step 2 gate). */
export let welcomeFirefoxInstalled = false;

export async function detectWelcomeFirefoxInstalled() {
    if (!state.isMacOSDesktop) return false;
    try {
        return !!(await invoke('is_firefox_installed'));
    } catch (e) {
        console.warn('[welcome-onboarding] is_firefox_installed failed:', e);
        return false;
    }
}

/** Cached for enforcement copy when the browser scan is not available yet. */
let enforcementCopyFirefoxInstalled = false;

export function firefoxInstalledFromState(state) {
    const b = state?.browsers?.firefox ?? appState.lastMigrationBrowserState?.browsers?.firefox;
    if (!b) return null;
    return !!b.installed;
}









export function setHtmlById(id, html) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
}

export function returnToWelcomeFromEula() {
    presentWelcomeOnboarding(continueFirstRunOnboardingFromWelcome);
}

// Desktop onboarding preserves legacy cleanup and requests only missing native browser permissions.
export const MIGRATION_POLL_MS = 2500;
export const NATIVE_ONBOARDING_DISMISSED_KEY = 'reddBlockNativePermissionOnboardingDismissed';

/** Bumped each Setup open so a late Done/Skip finish cannot dismiss a newer one. */
let migrationSetupEpoch = 0;

/** Hide Setup, start native watchers and persist completion. */
export async function finishNativePermissionSetup() {
    const epoch = migrationSetupEpoch;
    hideMigrationOnboarding();

    await startWebAutomationWatcher();
    try { localStorage.setItem(NATIVE_ONBOARDING_DISMISSED_KEY, String(Date.now())); }
    catch (_) { /* localStorage may be disabled; harmless */ }
    await persistOnboardingComplete();    if (epoch !== migrationSetupEpoch) return;
    try {
        const fresh = await invoke('onboarding_state');
        await refreshNativePermissions(fresh);
    } catch (e) { /* no-op */ }
}

// Document-level capture so Done/Skip keep working even if content wiring throws.
let migrationFinishDelegationWired = false;
function wireMigrationFinishDelegation() {
    if (migrationFinishDelegationWired) return;
    migrationFinishDelegationWired = true;
    document.addEventListener('click', (event) => {
        const btn = event.target?.closest?.('#migration-done-btn, #migration-skip-btn');
        if (!btn || btn.disabled) return;
        if (!appState.migrationOnboardingActive) return;
        void finishNativePermissionSetup();
    }, true);
}

export async function runDesktopOnboarding() {
    if (__SYSTEM_TEST_BUILD__) return;
    if (state.isIOS || state.isAndroid) return;
    try {
        const pendingAtLaunch = await invoke('migration_pending');
        const wasUpgrade = await invoke('migration_was_pending_at_launch');

        if (pendingAtLaunch) {
            // Residue still present → show pre-prompt screen.
            await showMigrationOnboarding('pre');
            return;
        }
        if (wasUpgrade && !state.migrationOnboardingDismissed) {
            // Complete legacy cleanup, then request only missing native permissions.
            const onboardingState = await invoke('onboarding_state');
            await showMigrationOnboarding('post', onboardingState, { mode: 'after-cleanup' });
            return;
        }

        const onboardingState = await invoke('onboarding_state');

        // Windows needs no setup; macOS requests only missing native permissions.
        await ensureNativePermissionSetupShown();

        if (state.migrationOnboardingActive) return;

        await refreshNativePermissions(onboardingState);
    } catch (e) {
        console.warn('[onboarding] state check failed:', e);
    }
}





export async function persistOnboardingComplete() {
    if (!state.appData.settings) state.appData.settings = {};
    if (state.appData.settings.onboardingComplete) return;
    state.appData.settings.onboardingComplete = true;
    try {
        await saveData();
    } catch (e) {
        console.warn('[onboarding] persist onboardingComplete failed:', e);
    }
}







export function windowsBrowserSetupIsAutomatic() {
    return state.isWindowsDesktop
        && ['chrome', 'edge', 'brave', 'firefox'].every(browserUsesAutomation);
}

export async function ensureNativePermissionSetupShown() {
    if (state.isIOS || state.isAndroid || state.migrationOnboardingActive) return;

    const dismissed = localStorage.getItem(NATIVE_ONBOARDING_DISMISSED_KEY);
    if (!state.firstRunNativePermissionSetupPending && (dismissed || state.migrationOnboardingDismissed)) return;
    // Windows defaults require no browser permission or installation action.
    // Complete the same startup/persistence work without showing a checklist.
    if (windowsBrowserSetupIsAutomatic()) {
        await finishNativePermissionSetup();
        return;
    }
    try {
        if (state.firstRunNativePermissionSetupPending) {
            state.migrationOnboardingDismissed = false;
        }
        const onboardingState = await invoke('onboarding_state');
        await refreshAutomationPermissionStatus({ force: true });
        if (!onboardingState?.browsers) throw new Error('Native browser inventory unavailable');
        const missingAutomation = AUTOMATION_BROWSER_KEYS.some(key => onboardingState?.browsers?.[key]?.installed && lastAutomationPermissionByKey[key] !== 'granted');
        const missingAccessibility = onboardingState?.browsers?.firefox?.installed && !(await invoke('accessibility_trusted'));
        if (!missingAutomation && !missingAccessibility) { await finishNativePermissionSetup(); return; }
        await showMigrationOnboarding('post', onboardingState, { mode: 'fresh' });
    } catch (e) {
        console.warn('[onboarding] native permission setup failed:', e);
    }
}

export async function showMigrationOnboarding(phase, onboardingState, opts = {}) {
    if (phase === 'post' && state.isWindowsDesktop) { await finishNativePermissionSetup(); return; }
    const screen = document.getElementById('migration-onboarding');
    const pre = document.getElementById('migration-phase-pre');
    const post = document.getElementById('migration-phase-post');
    const main = document.getElementById('main-content');
    const howto = document.getElementById('migration-howto');
    if (!screen || !pre || !post) return;

    migrationSetupEpoch += 1;
    wireMigrationFinishDelegation();

    applyMigrationOverlayStaticCopy();
    pre.classList.toggle('hidden', phase !== 'pre');
    post.classList.toggle('hidden', phase !== 'post');

    // Configure framing before reveal so we never flash the wrong copy.
    if (phase === 'post') {
        const mode = opts.mode || 'fresh';
        const title = document.getElementById('migration-post-title');
        const subtitle = document.getElementById('migration-post-subtitle');
        const titleRow = document.getElementById('migration-post-title-row');
        const cleanupItems = post.querySelectorAll('.migration-cleanup-only');
        if (mode === 'after-cleanup') {
            if (title) {
                title.textContent = tSettings('migrationPostTitleCleanup');
            }
            if (subtitle) {
                subtitle.textContent = tSettings('migrationPostSubtitleCleanup');
            }
            titleRow?.classList.remove('hidden');
            cleanupItems.forEach(el => el.classList.remove('hidden'));
        } else {
            titleRow?.classList.add('hidden');
            cleanupItems.forEach(el => el.classList.add('hidden'));
        }
        howto?.classList.add('hidden');
    }

    // Reveal before wiring so a wiring error cannot leave a blank main UI.
    showExclusiveOnboardingScreen('migration-onboarding');
    state.migrationOnboardingActive = true;
    state.migrationOnboardingDismissed = false;
    startMigrationPolling();
    if (main) main.classList.add('hidden');

    try {
        if (phase === 'post') {
            state.lastMigrationBrowserRenderSignature = '';
            // Permission rows own the native setup heading.
            wireMigrationPostPhase(onboardingState);
        } else if (phase === 'pre') {
            wireMigrationPrePhase();
        }
    } catch (e) {
        console.error('[migration] overlay wiring failed:', e);
    }
    // Open at the top, not wherever the last visit (or the rows rendering in) left the scroll.
    const toTop = () => [screen, ...screen.querySelectorAll('.migration-card')].forEach(el => { el.scrollTop = 0; });
    toTop();
    requestAnimationFrame(toTop);

    // Bring our window back to the front. The osascript admin
    // prompt steals focus, and on macOS we run as a menu-bar
    // accessory (no dock icon), so `window.setFocus` alone isn't
    // enough — we need NSApp.activate(ignoringOtherApps:). The
    // backend `activate_app` command does that. We retry twice with
    // a small delay because macOS doesn't always restore focus
    // immediately after osascript exits.
    const focusBack = async () => {
        try { await invoke('activate_app'); } catch (e) {
            console.warn('[migration] activate_app failed:', e);
        }
    };
    await focusBack();
    setTimeout(focusBack, 250);
}


export function pauseMigrationOnboardingForBackNavigation() {
    document.getElementById('migration-onboarding')?.classList.add('hidden');
    state.migrationOnboardingActive = false;
    stopMigrationPolling();
}

export function syncMigrationPostBackButtonVisibility() {
    const backBtn = document.getElementById('migration-back-btn');
    if (backBtn) {
        backBtn.classList.toggle('hidden', !state.firstRunNativePermissionSetupPending);
    }
}

export async function returnFromNativePermissionSetup() {
    if (!state.firstRunNativePermissionSetupPending) return;
    state.nativePermissionSetupPausedForBackNavigation = true;
    pauseMigrationOnboardingForBackNavigation();
    showEulaOnboardingScreen();
}

export function hideMigrationOnboarding() {
    const screen = document.getElementById('migration-onboarding');
    const main = document.getElementById('main-content');
    if (screen) screen.classList.add('hidden');
    if (main) main.classList.remove('hidden');
    state.migrationOnboardingActive = false;
    state.migrationOnboardingDismissed = true;
    state.firstRunNativePermissionSetupPending = false;
    state.migrationShowMeHowExpandedKeys.clear();
    state.migrationSafariDuplicateHelpExpanded = false;
    state.lastMigrationBrowserState = null;
    state.lastMigrationBrowserRenderSignature = '';

    stopMigrationPolling();
}

export function wireMigrationPrePhase() {
    const btn = document.getElementById('migration-continue-btn');
    const status = document.getElementById('migration-pre-status');
    if (!btn) return;

    // Always reset button + status to a clean pre-cleanup state.
    // This function is also called when the overlay is re-shown
    // (e.g. residue reappears after a successful migration); without
    // this, btn.disabled / btn.textContent / status would carry over
    // from the previous click and the user would be locked out.
    btn.disabled = false;
    btn.textContent = tSettings('migrationContinue');
    if (status) {
        status.textContent = '';
        status.classList.add('hidden');
        status.classList.remove('error');
    }

    if (btn._listenerAdded) return;
    btn._listenerAdded = true;

    btn.addEventListener('click', async () => {
        if (btn.disabled) return;
        btn.disabled = true;
        if (status) {
            status.textContent = tSettings('migrationApproveAdminPrompt');
            status.classList.remove('hidden', 'error');
        }

        const failTryAgain = (msg) => {
            btn.disabled = false;
            btn.textContent = tSettings('migrationTryAgain');
            if (status) {
                status.textContent = msg;
                status.classList.add('error');
            }
        };

        // Race the IPC Promise against a periodic disk-state poll.
        // The Promise is the fast signal (resolves on UAC decline in
        // <1s; on cleanup completion within a few seconds); the poll
        // is the safety net for cases where the Promise never settles
        // (we've seen this happen with the blocking elevated
        // PowerShell on the executor thread). Whichever signals
        // first wins. The poll alone would be correct but too slow on
        // the cancel path (user would wait for the timeout).
        const POLL_MS = 1500;
        const TIMEOUT_MS = 120000;
        const start = Date.now();
        let invokeSettled = false;
        const invokePromise = invoke('run_upgrade_migration')
            .catch((e) => {
                console.warn('[migration] run_upgrade_migration rejected:', e);
            })
            .finally(() => { invokeSettled = true; });

        try {
            while (true) {
                // Sleep, but wake early if the IPC Promise settles.
                await Promise.race([
                    new Promise((r) => setTimeout(r, POLL_MS)),
                    invokePromise,
                ]);
                const stillPending = await invoke('migration_pending');
                if (!stillPending) break;
                // Fast path: IPC said it's done AND residue is still
                // there → user cancelled / cleanup failed. Don't make
                // them wait for the polling timeout.
                if (invokeSettled) {
                    failTryAgain(tSettings('migrationCleanupNeedAdmin'));
                    return;
                }
                if (Date.now() - start > TIMEOUT_MS) {
                    failTryAgain(tSettings('migrationCleanupRetryGeneric'));
                    return;
                }
            }
            const fresh = await invoke('onboarding_state');
            // Explicit after-cleanup framing: we just finished the
            // pre-phase elevated cleanup, so the post screen must
            // surface the "Old version cleaned up / Your blocklists
            // are preserved" rows and the cleanup-flavoured title.
            // Without this, the post phase renders in the default
            // 'fresh' mode for a frame, gets immediately overwritten
            // by the window-focus handler at the bottom of
            // setupEventListeners() (which re-runs runDesktopOnboarding
            // and re-enters with mode: 'after-cleanup' because
            // migration_was_pending_at_launch is still true) — visible
            // on Windows as a flash of the fresh framing right before
            // the cleanup framing settles.
            await showMigrationOnboarding('post', fresh, { mode: 'after-cleanup' });
        } catch (e) {
            console.warn('[migration] poll failed:', e);
            failTryAgain(tSettings('migrationCleanupRetryGeneric'));
        }
    });
}

export function wireMigrationPostPhase(onboardingState) {
    renderNativePermissionRows(onboardingState);
    // macOS: the first paint shows Automation rows as 'unknown' because
    // the native status query is async. Fetch it, then re-render so the
    // rows settle to their real Allowed / needs-permission state.
    if (appState.isMacOSDesktop) {
        refreshAutomationPermissionStatus().then(() => {
            if (appState.migrationOnboardingActive) {
                renderNativePermissionRows(onboardingState, { force: true });
            }
        });
    }

    syncMigrationPostBackButtonVisibility();
    const backBtn = document.getElementById('migration-back-btn');
    if (backBtn && !backBtn._listenerAdded) {
        backBtn._listenerAdded = true;
        backBtn.addEventListener('click', () => {
            void returnFromNativePermissionSetup();
        });
    }
}
if (import.meta.env.DEV) {
    /** Dev only: `previewRebrandNotice()` in the webview console.
     *  Note: clicking Continue persists the shown-flag to real app data. */
    window.previewRebrandNotice = () => { void presentRebrandNotice(); };
}
