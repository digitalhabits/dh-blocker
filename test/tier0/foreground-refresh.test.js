import { describe, expect, test, vi } from 'vitest';
const invoke = vi.hoisted(() => vi.fn(async () => []));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ onFocusChanged: async () => () => {} }) }));
vi.mock('../../src/app.js', () => ({ setLanguagePickerOpen: vi.fn() }));
vi.mock('../../src/render.js', () => ({ kickClockNow: vi.fn() }));
vi.mock('../../src/blocking-platform.js', () => ({ reconcileBlockingWarningShell: vi.fn() }));
import { state } from '../../src/state.js';
import { setupAppForegroundRefresh } from '../../src/enforcement.js';
describe('native foreground refresh', () => {
    test('does not poll hidden windows, and refreshes on becoming visible', async () => {
        state.isMacOSDesktop = true; state.isIOS = false; state.isAndroid = false;
        state.startupInitializationComplete = true; state.migrationOnboardingActive = false;
        state.appData.settings = { eulaAcceptedRevision: 1 };
        let hidden = true;
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
        setupAppForegroundRefresh();
        vi.useFakeTimers(); invoke.mockClear();
        await vi.advanceTimersByTimeAsync(60000);
        expect(invoke).not.toHaveBeenCalled();
        hidden = false; document.dispatchEvent(new Event('visibilitychange'));
        await vi.advanceTimersByTimeAsync(0);
        expect(invoke).toHaveBeenCalledWith('onboarding_state');
        vi.useRealTimers();
    });
});
