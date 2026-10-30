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
