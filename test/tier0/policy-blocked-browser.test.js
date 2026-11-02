import { beforeEach, describe, expect, test, vi } from 'vitest';
const native = vi.hoisted(() => ({ listeners: new Map(), invoke: vi.fn(async () => true), finish: vi.fn(), permissions: [] }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async (name, callback) => { native.listeners.set(name, callback); return () => {}; }) }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ onFocusChanged: async () => () => {} }) }));
vi.mock('../../src/app.js', () => ({ setLanguagePickerOpen: vi.fn() }));
vi.mock('../../src/render.js', () => ({ kickClockNow: vi.fn() }));
vi.mock('../../src/blocking-platform.js', () => ({ reconcileBlockingWarningShell: vi.fn() }));
vi.mock('../../src/onboarding.js', () => ({ MIGRATION_POLL_MS: 2500, hasAcceptedEula: () => true, showMigrationOnboarding: vi.fn(), presentWelcomeOnboarding: vi.fn(), finishNativePermissionSetup: native.finish }));
vi.mock('../../src/tauri-api.js', () => ({ tauriAPI: { webAutomationPermissionStatus: async () => native.permissions } }));
import { state } from '../../src/state.js';
import { renderNativePermissionRows, refreshAutomationPermissionStatus, setupNativeEnforcementAlerts, refreshNativePermissions } from '../../src/enforcement.js';
beforeEach(() => {
    document.body.innerHTML = '<div class="app-container"><div id="migration-browser-buttons"></div></div>';
    state.isMacOSDesktop = true; state.isWindowsDesktop = false; state.isIOS = false; state.isAndroid = false; state.migrationOnboardingActive = true;
    native.finish.mockClear(); native.invoke.mockReset().mockResolvedValue(true); native.permissions = [];
});
describe('native permission setup', () => {
    test('granted permissions and absent browsers require no actions', async () => {
        native.permissions = [{ label: 'Chrome', state: 'granted', running: true }];
        await refreshAutomationPermissionStatus({ force: true });
        await renderNativePermissionRows({ browsers: { chrome: { installed: true }, firefox: { installed: true } } });
        expect(document.getElementById('migration-browser-buttons').children).toHaveLength(0);
        expect(native.finish).toHaveBeenCalledOnce();
    });
    test('denied Automation and revoked Accessibility surface recovery actions', async () => {
        native.permissions = [{ label: 'Chrome', state: 'denied', running: true }];
        native.invoke.mockResolvedValue(false);
        await refreshAutomationPermissionStatus({ force: true });
        await renderNativePermissionRows({ browsers: { chrome: { installed: true }, firefox: { installed: true } } });
        expect(document.querySelectorAll('#migration-browser-buttons button')).toHaveLength(2);
        expect(native.finish).not.toHaveBeenCalled();
    });
    test('Windows has no browser setup rows', async () => {
        state.isMacOSDesktop = false; state.isWindowsDesktop = true;
        await renderNativePermissionRows({ browsers: { chrome: { installed: true } } });
        expect(document.getElementById('migration-browser-buttons').children).toHaveLength(0);
        expect(native.invoke).not.toHaveBeenCalled();
    });
});
test('permission warnings persist until polling confirms recovery and never promise closing', async () => {
    setupNativeEnforcementAlerts();
    native.permissions = [{ label: 'Chrome', state: 'denied', running: true }];
    await refreshNativePermissions({ browsers: { chrome: { installed: true } } });
    const banner = document.getElementById('native-enforcement-warning');
    expect(banner.classList.contains('hidden')).toBe(false);
    expect(banner.textContent).toContain('Chrome');
    expect(banner.textContent).not.toContain('seconds');
    expect(banner.querySelector('.update-banner-dismiss')).toBeNull();
    native.permissions = [{ label: 'Chrome', state: 'granted', running: true }];
    await refreshNativePermissions({ browsers: { chrome: { installed: true } } });
    expect(banner.classList.contains('hidden')).toBe(true);
});

test('an empty native inventory skips setup, but a missing inventory never implies granted access', async () => {
    await renderNativePermissionRows({ browsers: {} });
    expect(native.finish).toHaveBeenCalledOnce();
    await expect(renderNativePermissionRows({})).rejects.toThrow('inventory unavailable');
});
