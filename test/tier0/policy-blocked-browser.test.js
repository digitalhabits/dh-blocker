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
    const setUpWindows = async () => {
        const { state } = await import('../../src/state.js');
        state.isMacOSDesktop = false;
        state.isWindowsDesktop = true;
        state.appData.settings = { ...state.appData.settings, blockingMethods: {} };
        return import('../../src/enforcement.js');
    };

    test('Windows defaults to automation without extension setup or permission prompts', async () => {
        const { browserBlockingMethod, effectiveBrowserComplianceStatus, buildBannerActionSummary } = await setUpWindows();
        const browsers = Object.fromEntries(['chrome', 'edge', 'brave', 'firefox'].map(key => [key, edge({ profiles: [], present: true })]));
        for (const key of Object.keys(browsers)) {
            expect(browserBlockingMethod(key)).toBe('automation');
            expect(effectiveBrowserComplianceStatus(key, browsers)).toBe('compliant');
        }
        expect(buildBannerActionSummary(browsers, Object.keys(browsers))).toBe('');
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
    });
});
