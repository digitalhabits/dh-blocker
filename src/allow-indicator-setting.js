// Settings toggle for the floating allow-mode indicator
// (`settings.showAllowIndicator`, default on). Desktop only: the window is
// created by src-tauri/src/allow_indicator.rs, which reads the setting from
// the saved data file, so saving is all this has to do.
//
// Turning it off hides a list. It does not change what is blocked.
import { state } from './state.js';
import { saveData } from './persistence.js';

export function allowIndicatorEnabled() {
    return state.appData?.settings?.showAllowIndicator !== false;
}

export function setupAllowIndicatorToggle() {
    const input = document.getElementById('settings-allow-indicator-input');
    const row = document.getElementById('settings-allow-indicator-row');
    if (!input || !row) return;
    // iOS has no floating windows; Screen Time's own shield is the surface there.
    if (state.isIOS) {
        row.classList.add('hidden');
        return;
    }

    const sync = () => { input.checked = allowIndicatorEnabled(); };
    sync();
    ['settings-btn', 'settings-btn-stack']
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .forEach((btn) => btn.addEventListener('click', sync));
    input.addEventListener('change', async () => {
        if (!state.appData.settings) state.appData.settings = {};
        state.appData.settings.showAllowIndicator = input.checked;
        try {
            await saveData();
        } catch (e) {
            console.warn('[allow-indicator] could not save the setting:', e);
        }
    });
}
