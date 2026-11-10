import { beforeEach, describe, expect, test, vi } from 'vitest';

// Firefox on macOS can block through its extension (the default) or through
// the Accessibility API. This resolver is the UI's copy of
// `blocking_method::method_for_key_at_path`; if the two drift, the settings
// screen promises something enforcement will not do.

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => []) }));
vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => ({ onFocusChanged: async () => () => {} }),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: vi.fn() }));

const load = async ({ mac = true, methods = {} } = {}) => {
    const { state } = await import('../../src/state.js');
    state.isMacOSDesktop = mac;
    state.appData = { settings: { blockingMethods: methods } };
    return import('../../src/enforcement.js');
};

describe('Firefox blocking method', () => {
    beforeEach(() => vi.resetModules());

    test('Windows Firefox falls back to the extension and rejects macOS Accessibility', async () => {
        // Windows defaults to the extension (Automation only as the
        // policy-blocked fallback, and never for Firefox), so a stored
        // 'accessibility' — which exists for Firefox on macOS alone — must
        // land on the extension rather than on a method Windows cannot
        // enforce with.
        const e = await load({ mac: false, methods: { firefox: 'accessibility' } });
        const { state } = await import('../../src/state.js');
        state.isWindowsDesktop = true;
        expect(e.browserBlockingMethod('firefox')).toBe('extension');
        expect(e.browserUsesAutomation('firefox')).toBe(false);
        expect(e.browserUsesAccessibility('firefox')).toBe(false);
        expect(e.methodOptionsForKey('firefox')).toEqual(['automation', 'extension']);
        expect(e.methodIsValidForKey('firefox', 'accessibility')).toBe(false);
    });

    test('defaults to the extension, so existing installs are untouched', async () => {
        const e = await load();
        expect(e.browserBlockingMethod('firefox')).toBe('extension');
        expect(e.browserUsesAccessibility('firefox')).toBe(false);
    });

    test('can be switched to accessibility', async () => {
        const e = await load({ methods: { firefox: 'accessibility' } });
        expect(e.browserBlockingMethod('firefox')).toBe('accessibility');
        expect(e.browserUsesAccessibility('firefox')).toBe(true);
        // Still never automation: Firefox has no tab scripting at all.
        expect(e.browserUsesAutomation('firefox')).toBe(false);
    });

    test('never resolves to automation, even if the data file says so', async () => {
        const e = await load({ methods: { firefox: 'automation' } });
        expect(e.browserBlockingMethod('firefox')).toBe('extension');
        expect(e.browserUsesAutomation('firefox')).toBe(false);
    });

    test('other browsers cannot be put on accessibility', async () => {
        const e = await load({ methods: { chrome: 'accessibility', safari: 'accessibility' } });
        expect(e.browserBlockingMethod('chrome')).toBe('automation');
        expect(e.browserBlockingMethod('safari')).toBe('automation');
        expect(e.browserUsesAccessibility('chrome')).toBe(false);
        expect(e.methodIsValidForKey('edge', 'accessibility')).toBe(false);
        expect(e.methodIsValidForKey('firefox', 'accessibility')).toBe(true);
        expect(e.methodIsValidForKey('firefox', 'automation')).toBe(false);
    });

    test('chromium and Safari defaults are unchanged', async () => {
        const e = await load();
        for (const key of ['chrome', 'brave', 'edge', 'safari']) {
            expect(e.browserBlockingMethod(key)).toBe('automation');
        }
    });

    test('offers each browser only the methods it can enforce with', async () => {
        const e = await load();
        expect(e.methodOptionsForKey('firefox')).toEqual(['extension', 'accessibility']);
        expect(e.methodOptionsForKey('chrome')).toEqual(['automation', 'extension']);
    });

    test('off macOS everything stays on the extension', async () => {
        const e = await load({ mac: false, methods: { firefox: 'accessibility' } });
        expect(e.browserBlockingMethod('firefox')).toBe('extension');
        expect(e.browserUsesAccessibility('firefox')).toBe(false);
    });
});

// The setup screen judged every non-Automation browser by its extension, so
// Firefox on Accessibility showed "Disabled" with an "Open Extension
// Settings" prompt even after the grant. The enforcer (enforcer.rs) already
// judges it by the grant alone; the UI has to agree.
describe('Firefox setup status on the Accessibility method', () => {
    beforeEach(() => vi.resetModules());

    // Installed, but the extension is switched off: compliant only if the
    // status ignores the extension.
    const browsers = {
        firefox: {
            installed: true,
            nativeHostReady: false,
            profiles: [{ isDefault: true, installed: true, enabled: false, privateBrowsing: false }],
        },
    };

    const loadWithGrant = async (trusted, methods = { firefox: 'accessibility' }) => {
        const { invoke } = await import('@tauri-apps/api/core');
        invoke.mockImplementation(async (cmd) => (cmd === 'accessibility_trusted' ? trusted : []));
        const e = await load({ methods });
        await e.refreshAccessibilityTrustedStatus();
        return e;
    };

    test('is compliant once Accessibility is granted, whatever the extension says', async () => {
        const e = await loadWithGrant(true);
        expect(e.effectiveBrowserComplianceStatus('firefox', browsers)).toBe('compliant');
    });

    test('asks for Accessibility, not the extension, while the grant is missing', async () => {
        const e = await loadWithGrant(false);
        expect(e.effectiveBrowserComplianceStatus('firefox', browsers)).toBe('needs-accessibility');
        expect(e.bannerHeadlineKey(browsers, ['firefox'])).toBe('setupBrowsersBannerHeadlineMac');
        expect(e.buildBannerActionSummary(browsers, ['firefox'])).toContain('Firefox');
    });

    test('the extension method still reports extension problems', async () => {
        const e = await loadWithGrant(true, {});
        expect(e.effectiveBrowserComplianceStatus('firefox', browsers)).toBe('needs-enable');
    });

    test('the setup subtitle does not send Accessibility users to the extension', async () => {
        const ax = await loadWithGrant(true);
        const axCopy = ax.migrationExtHeaderCopy({ browsers });
        expect(axCopy.subtitleHtml).not.toContain('Focus extension');
        expect(axCopy.subtitleHtml).toContain('Accessibility');

        vi.resetModules();
        const ext = await loadWithGrant(true, {});
        expect(ext.migrationExtHeaderCopy({ browsers }).subtitleHtml).toContain('Focus extension');
    });
});

describe('Firefox Accessibility warning', () => {
    beforeEach(() => vi.resetModules());

    // A missing Accessibility grant is a permission problem, not an extension one:
    // the warning must say so, and its button must open Accessibility, not add-ons.
    test('names Accessibility and opens its settings, not Firefox add-ons', async () => {
        const e = await load({ methods: { firefox: 'accessibility' } });
        const payload = { label: 'Firefox', issue: 'accessibility', remaining_secs: 30, total_secs: 60 };
        for (const copy of [e.enforcerCopy(payload), e.enforcerClosedCopy(payload)]) {
            expect(`${copy.headline} ${copy.instruction}`).toContain('Accessibility');
            expect(`${copy.headline} ${copy.instruction}`).not.toMatch(/extension/i);
        }
        const { invoke } = await import('@tauri-apps/api/core');
        invoke.mockClear();
        await e.openEnforcerFix(payload);
        const calls = invoke.mock.calls.map(([cmd]) => cmd);
        expect(calls).toContain('accessibility_request');
        expect(calls).not.toContain('open_browser_extension_settings');
    });
});
