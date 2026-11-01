import { describe, expect, test, vi } from 'vitest';

// Windows: an organisation browser policy (NativeMessagingUserLevelHosts=0)
// stops the browser reaching Blocker. The setup screen must say so instead of
// showing the browser as set up, whatever state the extension itself is in.

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => []) }));
vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => ({ onFocusChanged: async () => () => {} }),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: vi.fn() }));

const setUp = async () => {
    const { state } = await import('../../src/state.js');
    state.isMacOSDesktop = false;
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
