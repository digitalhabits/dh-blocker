import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// The app never quits: closing the window hides it to the tray, so a timer
// the UI starts keeps firing for as long as the machine is on. On macOS the
// banner refresh behind this timer spawns osascript for every running
// browser and rescans browser profiles, which is where idle CPU went.

const invoke = vi.hoisted(() => vi.fn(async () => []));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => ({ onFocusChanged: async () => () => {} }),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: vi.fn() }));

let visibility = 'visible';

beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => visibility,
    });
    localStorage.clear();
});

afterEach(() => {
    vi.useRealTimers();
});

async function setUpMacDesktop() {
    const { state } = await import('../../src/state.js');
    const { CURRENT_EULA_REVISION } = await import('../../src/onboarding.js');
    const enforcement = await import('../../src/enforcement.js');
    state.isIOS = false;
    state.isAndroid = false;
    state.isMacOSDesktop = true;
    state.startupInitializationComplete = true;
    state.migrationOnboardingActive = false;
    state.appData = { ...(state.appData || {}), settings: { eulaAcceptedRevision: CURRENT_EULA_REVISION } };
    return enforcement;
}

describe('setupAppForegroundRefresh', () => {
    test('does not poll the backend while the window is hidden in the tray', async () => {
        const enforcement = await setUpMacDesktop();
        enforcement.setupAppForegroundRefresh();

        visibility = 'hidden';
        invoke.mockClear();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(invoke).not.toHaveBeenCalled();

        // Control: the same poll does reach the backend once the window is
        // back, so the assertion above is not passing for an unrelated reason.
        visibility = 'visible';
        await vi.advanceTimersByTimeAsync(10_000);
        expect(invoke).toHaveBeenCalledWith('onboarding_state');
    });
});

describe('ensureEnforcerClosedBannerPoll', () => {
    test('does not poll the backend while the window is hidden in the tray', async () => {
        const enforcement = await setUpMacDesktop();
        enforcement.enforcerClosedBannerStates.set('chrome', {});
        enforcement.ensureEnforcerClosedBannerPoll();

        visibility = 'hidden';
        await vi.advanceTimersByTimeAsync(0);
        invoke.mockClear();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(invoke).not.toHaveBeenCalled();

        visibility = 'visible';
        await vi.advanceTimersByTimeAsync(10_000);
        expect(invoke).toHaveBeenCalledWith('onboarding_state');

        enforcement.enforcerClosedBannerStates.clear();
        enforcement.stopEnforcerClosedBannerPoll();
    });
});
