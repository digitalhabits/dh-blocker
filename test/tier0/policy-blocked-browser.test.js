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
import { renderNativePermissionRows, refreshAutomationPermissionStatus, setupNativeEnforcementAlerts, refreshNativePermissions, showNativeEnforcementWarning, acknowledgeVisibleNativeWarnings, hydrateNativeWarnings } from '../../src/enforcement.js';
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
describe('native enforcement health', () => {
    test('a diagnostic warning stays visible until recovery and never promises automatic closing', () => {
        setupNativeEnforcementAlerts();
        native.listeners.get('native-enforcement-warning')({ payload: { browser: 'Chrome', reason: 'Permission denied', diagnosticOnly: true } });
        const banner = document.getElementById('native-enforcement-warning');
        expect(banner.classList.contains('hidden')).toBe(false);
        expect(banner.textContent).toContain('does not automatically close');
        expect(banner.querySelector('.update-banner-dismiss')).toBeNull();
        native.listeners.get('native-enforcement-recovered')({ payload: 'Chrome' });
        expect(banner.classList.contains('hidden')).toBe(true);
    });
});

test('validated failures show the named browser and remaining grace time', () => {
    vi.useFakeTimers();
    native.listeners.get('native-enforcement-warning')({ payload: { browser: 'Edge', reason: 'Redirect failed', diagnosticOnly: false, graceSeconds: 60 } });
    const banner = document.getElementById('native-enforcement-warning');
    expect(banner.textContent).toContain('Edge');
    expect(banner.textContent).toContain('60 seconds');
    vi.advanceTimersByTime(10000);
    expect(banner.textContent).toContain('50 seconds');
    native.listeners.get('native-enforcement-recovered')({ payload: 'Edge' });
    expect(banner.classList.contains('hidden')).toBe(true);
    vi.useRealTimers();
});

test('successful permission polling cannot hide a native redirect failure', async () => {
    showNativeEnforcementWarning({ browser: 'Chrome', reason: 'BlockedUrlRemains', diagnosticOnly: true });
    native.permissions = [{ label: 'Chrome', state: 'granted', running: true }];
    await refreshNativePermissions({ browsers: { chrome: { installed: true } } });
    expect(document.getElementById('native-enforcement-warning').textContent).toContain('could not be redirected');
    expect(document.getElementById('native-enforcement-warning').classList.contains('hidden')).toBe(false);
    native.listeners.get('native-enforcement-recovered')({ payload: 'Chrome' });
});

test('an empty native inventory skips setup, but a missing inventory never implies granted access', async () => {
    await renderNativePermissionRows({ browsers: {} });
    expect(native.finish).toHaveBeenCalledOnce();
    await expect(renderNativePermissionRows({})).rejects.toThrow('inventory unavailable');
});

test('warning acknowledgment requires a visible unobscured banner and is sent once', async () => {
    showNativeEnforcementWarning({ browser: 'Edge', reason: 'BlockedUrlRemains', diagnosticOnly: false, warningId: 42 });
    const banner = document.getElementById('native-enforcement-warning');
    banner.getBoundingClientRect = () => ({ left: 0, top: 30, right: 600, bottom: 130, width: 600, height: 100 });
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.elementFromPoint = () => banner;
    native.invoke.mockClear();
    await acknowledgeVisibleNativeWarnings();
    expect(native.invoke).not.toHaveBeenCalledWith('native_warning_visible', expect.anything());
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.elementFromPoint = () => document.body;
    await acknowledgeVisibleNativeWarnings();
    expect(native.invoke).not.toHaveBeenCalledWith('native_warning_visible', expect.anything());
    document.elementFromPoint = () => banner;
    await acknowledgeVisibleNativeWarnings();
    await acknowledgeVisibleNativeWarnings();
    expect(native.invoke.mock.calls.filter(([name]) => name === 'native_warning_visible')).toEqual([['native_warning_visible', { warningId: 42 }]]);
    native.listeners.get('native-enforcement-recovered')({ payload: 'Edge' });
});

test('authoritative empty worker snapshot clears missed recovery without clearing permission warnings', async () => {
    native.permissions = [{ label: 'Chrome', state: 'denied', running: true }];
    await refreshNativePermissions({ browsers: { chrome: { installed: true } } });
    showNativeEnforcementWarning({ browser: 'Edge', reason: 'BlockedUrlRemains', diagnosticOnly: true, warningId: 77 });
    native.invoke.mockResolvedValue({ pendingWarnings: [] });
    await hydrateNativeWarnings();
    const banner = document.getElementById('native-enforcement-warning');
    expect(banner.textContent).toContain('Chrome');
    expect(banner.textContent).not.toContain('Edge');
    expect(banner.classList.contains('hidden')).toBe(false);
});
