import { expect, test, vi } from 'vitest';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ onFocusChanged: async () => () => {} }) }));
vi.mock('../../src/app.js', () => ({ setLanguagePickerOpen: vi.fn(), WINDOWS_APPS_SETTINGS_URI: '' }));
import { renderSystemDiagnostics } from '../../src/settings.js';
import { tSettings } from '../../src/i18n.js';
test('native diagnostics preserve live permission states and expose worker health without profiles', () => {
    const html = renderSystemDiagnostics({
        app: { os: 'macos', arch: 'aarch64' }, migration: { residue_items: [] },
        automation: { applicable: true, browsers: [{ label: 'Chrome', state: 'granted' }, { label: 'Safari', state: 'denied' }] },
        native_website_failures: { pendingWarnings: [], automaticBrowserClosingEnabled: false, workerHealth: { firefox: { status: 'WaitingForEngine' } } },
    });
    expect(html).toContain(tSettings('diagnosticsAutomationGranted'));
    expect(html).toContain(tSettings('diagnosticsAutomationDenied'));
    expect(html).toContain('WaitingForEngine');
    expect(html).not.toContain('Extension installed');
});
