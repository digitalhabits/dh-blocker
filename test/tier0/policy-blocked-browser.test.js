import { describe, expect, test, vi } from 'vitest';

// An organisation browser policy (NativeMessagingUserLevelHosts=0) stops the
// browser reaching Blocker. Where nothing else blocks it (macOS extension mode),
// the setup screen must say so instead of showing the browser as set up,
// whatever state the extension itself is in.

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => []) }));
vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => ({ onFocusChanged: async () => () => {} }),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: vi.fn() }));

const setUp = async () => {
    const { state } = await import('../../src/state.js');
    state.isMacOSDesktop = false;
    state.isWindowsDesktop = false;
    return import('../../src/enforcement.js');
};
const edge = (extra) => ({
    installed: true,
    profiles: [{ name: 'Default', isDefault: true, installed: true, enabled: true, privateBrowsing: true }],
    ...extra,
});

describe('policy-blocked browsers', () => {
    test('a fully set-up browser blocked by policy is not reported as compliant', async () => {
        const { browserComplianceStatus } = await setUp();
        expect(browserComplianceStatus('edge', edge({}))).toBe('compliant');
        expect(browserComplianceStatus('edge', edge({ nativeHostBlockedByPolicy: true }))).toBe('policy-blocked');
    });

    test('policy wins over a missing extension, since installing it cannot help', async () => {
        const { browserComplianceStatus } = await setUp();
        expect(browserComplianceStatus('edge', edge({ profiles: [], nativeHostBlockedByPolicy: true }))).toBe('policy-blocked');
    });

    test('the setup banner names the blocked browser first', async () => {
        const { buildBannerActionSummary } = await setUp();
        const summary = buildBannerActionSummary(
            { edge: edge({ nativeHostBlockedByPolicy: true }), chrome: edge({ profiles: [] }) },
            ['chrome', 'edge'],
        );
        expect(summary).toBe('Blocked by your organisation in Edge · Install in Chrome');
    });
});

// Windows: Chrome, Edge and Brave in that state are blocked through their
// address bar instead (src-tauri/src/uia_web_automation.rs). There is nothing
// for the user to do, so the row must not tell them blocking is broken.
describe('policy-blocked browsers on Windows', () => {
    const setUpWindows = async (optIn = true) => {
        const { state } = await import('../../src/state.js');
        state.isMacOSDesktop = false;
        state.isWindowsDesktop = true;
        state.appData.settings = { ...state.appData.settings, blockingMethods: {} };
        if (optIn) state.appData.settings.blockingMethods = Object.fromEntries(
            ['chrome', 'edge', 'brave', 'firefox'].map(key => [key, 'automation']));
        return import('../../src/enforcement.js');
    };

    test('Windows upgrades and fresh installs retain extension mode unless explicitly opted in', async () => {
        const { browserBlockingMethod, effectiveBrowserComplianceStatus } = await setUpWindows(false);
        const { state } = await import('../../src/state.js');
        const { windowsBrowserSetupIsAutomatic } = await import('../../src/onboarding.js');
        for (const key of ['chrome', 'edge', 'brave', 'firefox']) {
            expect(browserBlockingMethod(key)).toBe('extension');
            expect(effectiveBrowserComplianceStatus(key, { [key]: edge({ profiles: [] }) })).toBe('needs-install');
            expect(effectiveBrowserComplianceStatus(key, { [key]: edge({ nativeHostBlockedByPolicy: true }) })).toBe(key === 'firefox' ? 'policy-blocked' : 'compliant');
            state.appData.settings.blockingMethods[key] = 'invalid';
            expect(browserBlockingMethod(key)).toBe('extension');
        }
        expect(windowsBrowserSetupIsAutomatic()).toBe(false);
    });

    test('policy-blocked Chromium defaults to automation, but explicit extension choice wins', async () => {
        const { windowsBrowserMethod, effectiveBrowserComplianceStatus } = await setUpWindows(false);
        const { windowsBrowserSetupIsAutomatic } = await import('../../src/onboarding.js');
        const { state } = await import('../../src/state.js');
        const browsers = { edge: edge({ nativeHostBlockedByPolicy: true }) };
        expect(windowsBrowserMethod('edge', {}, browsers.edge)).toBe('automation');
        expect(windowsBrowserSetupIsAutomatic(browsers)).toBe(true);
        expect(windowsBrowserSetupIsAutomatic({ ...browsers, chrome: edge({ profiles: [] }) })).toBe(false);
        state.appData.settings.blockingMethods.edge = 'extension';
        expect(effectiveBrowserComplianceStatus('edge', browsers)).toBe('policy-blocked');
        expect(windowsBrowserSetupIsAutomatic(browsers)).toBe(false);
    });

    test.each([undefined, 'invalid', 'extension', 'automation'])('settings and setup agree for saved method %s', async (saved) => {
        const { browserBlockingMethod, syncBlockingMethodRowVisibility, syncBlockingMethodSelects,
            effectiveBrowserComplianceStatus } = await setUpWindows(false);
        const { state } = await import('../../src/state.js');
        const { windowsBrowserSetupIsAutomatic } = await import('../../src/onboarding.js');
        for (const key of ['chrome', 'edge', 'brave', 'firefox']) {
            for (const blocked of [false, true]) {
                const browsers = { [key]: edge({ profiles: [], nativeHostBlockedByPolicy: blocked }) };
                state.appData.settings.blockingMethods = saved === undefined ? {} : { [key]: saved };
                document.body.innerHTML = `<div class="settings-row"><select id="blocking-method-${key}"><option value="extension">Extension</option><option value="automation">Automation</option></select></div>`;
                syncBlockingMethodRowVisibility(browsers);
                syncBlockingMethodSelects();
                const expected = saved === 'automation' || (saved !== 'extension' && blocked && key !== 'firefox')
                    ? 'automation' : 'extension';
                expect(browserBlockingMethod(key, browsers[key])).toBe(expected);
                expect(document.getElementById(`blocking-method-${key}`).value).toBe(expected);
                expect(windowsBrowserSetupIsAutomatic(browsers)).toBe(expected === 'automation');
                expect(effectiveBrowserComplianceStatus(key, browsers)).toBe(
                    expected === 'automation' ? 'compliant' : blocked ? 'policy-blocked' : 'needs-install');
            }
        }
    });

    test('default Windows onboarding still shows the extension checklist', async () => {
        await setUpWindows(false);
        const { state } = await import('../../src/state.js');
        const { ensureExtensionSetupOnboardingShown, EXT_ONBOARDING_DISMISSED_KEY } = await import('../../src/onboarding.js');
        state.isIOS = false;

        state.migrationOnboardingActive = false;
        state.migrationOnboardingDismissed = false;
        state.firstRunExtensionSetupPending = true;
        state.appData.settings.onboardingComplete = false;
        localStorage.removeItem(EXT_ONBOARDING_DISMISSED_KEY);
        document.body.innerHTML = '<div id="migration-onboarding" class="hidden"><div id="migration-phase-pre"></div><div id="migration-phase-post"></div></div><div id="main-content"></div>';
        await ensureExtensionSetupOnboardingShown();
        expect(state.migrationOnboardingActive).toBe(true);
        expect(document.getElementById('migration-onboarding').classList.contains('hidden')).toBe(false);
        expect(state.appData.settings.onboardingComplete).toBe(false);
        state.migrationOnboardingActive = false;
    });

    test('Windows onboarding copy accepts a scan that has not arrived yet', async () => {
        const { migrationExtLinesHtml } = await setUpWindows(false);
        expect(() => migrationExtLinesHtml(null)).not.toThrow();
    });

    test('Windows explicit automation skips extension setup and permission prompts', async () => {
        const { browserBlockingMethod, effectiveBrowserComplianceStatus, buildBannerActionSummary } = await setUpWindows();
        const browsers = Object.fromEntries(['chrome', 'edge', 'brave', 'firefox'].map(key => [key, edge({ profiles: [], present: true })]));
        for (const key of Object.keys(browsers)) {
            expect(browserBlockingMethod(key)).toBe('automation');
            expect(effectiveBrowserComplianceStatus(key, browsers)).toBe('compliant');
        }
        expect(buildBannerActionSummary(browsers, Object.keys(browsers))).toBe('');
    });

    test('Windows setup with explicit automation completes without revealing the browser overlay', async () => {
        await setUpWindows();
        const { state } = await import('../../src/state.js');
        const { ensureExtensionSetupOnboardingShown, EXT_ONBOARDING_DISMISSED_KEY } = await import('../../src/onboarding.js');
        const { invoke } = await import('@tauri-apps/api/core');
        state.isIOS = false;

        state.migrationOnboardingActive = false;
        state.firstRunExtensionSetupPending = true;
        state.appData.settings.onboardingComplete = false;
        document.body.innerHTML = '<div id="migration-onboarding" class="hidden"></div><div id="main-content"></div>';
        invoke.mockClear();
        await ensureExtensionSetupOnboardingShown();
        expect(state.firstRunExtensionSetupPending).toBe(false);
        expect(state.migrationOnboardingActive).toBe(false);
        expect(state.appData.settings.onboardingComplete).toBe(true);
        expect(localStorage.getItem(EXT_ONBOARDING_DISMISSED_KEY)).toBeTruthy();
        expect(invoke).toHaveBeenCalledWith('enforcer_start');
        expect(document.getElementById('migration-onboarding').classList.contains('hidden')).toBe(true);
    });

    test('explicit extension mode restores extension setup, including policy warnings', async () => {
        const { browserBlockingMethod, effectiveBrowserComplianceStatus } = await setUpWindows();
        const { state } = await import('../../src/state.js');
        state.appData.settings.blockingMethods = { chrome: 'extension', firefox: 'extension' };
        expect(browserBlockingMethod('chrome')).toBe('extension');
        expect(effectiveBrowserComplianceStatus('chrome', { chrome: edge({ profiles: [] }) })).toBe('needs-install');
        expect(effectiveBrowserComplianceStatus('chrome', { chrome: edge({ nativeHostBlockedByPolicy: true }) })).toBe('policy-blocked');
        expect(effectiveBrowserComplianceStatus('firefox', { firefox: edge({ profiles: [] }) })).toBe('needs-install');
    });

    test('Chrome, Edge and Brave count as set up', async () => {
        const { browserComplianceStatus } = await setUpWindows();
        for (const key of ['chrome', 'edge', 'brave']) {
            expect(browserComplianceStatus(key, edge({ nativeHostBlockedByPolicy: true }))).toBe('compliant');
            expect(browserComplianceStatus(key, edge({ profiles: [], nativeHostBlockedByPolicy: true }))).toBe('compliant');
        }
    });

    test('the setup banner does not list them', async () => {
        const { buildBannerActionSummary } = await setUpWindows();
        const { state } = await import('../../src/state.js');
        state.appData.settings.blockingMethods.chrome = 'extension';
        const summary = buildBannerActionSummary(
            { edge: edge({ nativeHostBlockedByPolicy: true }), chrome: edge({ profiles: [] }) },
            ['chrome', 'edge'],
        );
        expect(summary).toBe('Install in Chrome');
    });

    test('macOS Firefox and mobile platforms retain extension semantics', async () => {
        const { browserBlockingMethod } = await setUp();
        const { state } = await import('../../src/state.js');
        state.isMacOSDesktop = true;
        state.appData.settings.blockingMethods = {};
        expect(browserBlockingMethod('safari')).toBe('automation');
        expect(browserBlockingMethod('firefox')).toBe('extension');
        state.isMacOSDesktop = false;
        expect(browserBlockingMethod('chrome')).toBe('extension');
    });

    test('the row explains the address-bar blocking instead of the policy warning', async () => {
        const { renderBrowserInstallButtons } = await setUpWindows();
        document.body.innerHTML = '<div id="migration-browser-buttons"></div>';
        renderBrowserInstallButtons({ browsers: { edge: edge({ nativeHostBlockedByPolicy: true }) } }, { force: true });
        const text = document.getElementById('migration-browser-buttons').textContent;
        expect(text).toContain('address bar');
        expect(text).not.toContain("won't work");
        expect(text).not.toContain('organisation');
    });
});
