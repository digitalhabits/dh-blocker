// Modal and escape-layer management.
import { closeAllLanguagePickers, isAnyLanguagePickerOpen } from './app.js';
import { resetWebsitesImportMenuPosition } from './website-input.js';
import { closeAllBlocklistMenus } from './blocklists.js';
import { closeAllPopovers } from './time-inputs.js';
import { closeOpenCustomSelect } from './custom-select.js';

export function isModalVisible(id) {
    const modal = document.getElementById(id);
    return !!(modal && !modal.classList.contains('hidden'));
}

/** ESC: sub-overlays → topmost modal → (elsewhere) deselect blocklist. */
export function dismissTopmostEscapeLayer() {
    if (closeEscapeSubLayer()) return true;
    return closeEscapeDialog();
}

export function closeEscapeSubLayer() {
    if (closeOpenCustomSelect()) return true;
    const focused = document.activeElement;
    if (focused?.matches('#custom-color-input, input[type="color"]')) {
        focused.blur();
        return true;
    }
    const emoji = document.getElementById('emoji-picker-popover');
    if (emoji && !emoji.classList.contains('hidden')) {
        emoji.classList.add('hidden');
        return true;
    }
    if (document.querySelector('.schedule-time-popover')) {
        document.querySelectorAll('.schedule-time-popover').forEach(p => p.remove());
        return true;
    }
    if (document.querySelector('.time-popover:not(.hidden)')) {
        closeAllPopovers();
        return true;
    }
    const repeatMenu = document.getElementById('repeat-dropdown-menu');
    if (repeatMenu && !repeatMenu.classList.contains('hidden')) {
        repeatMenu.classList.add('hidden');
        return true;
    }
    const importMenu = document.querySelector('.websites-import-menu:not(.hidden)');
    if (importMenu) {
        importMenu.classList.add('hidden');
        resetWebsitesImportMenuPosition(importMenu.id);
        importMenu._importBtn?.setAttribute('aria-expanded', 'false');
        return true;
    }
    if (document.querySelector('.blocklist-menu:not(.hidden)')) {
        closeAllBlocklistMenus();
        return true;
    }
    if (isAnyLanguagePickerOpen()) {
        closeAllLanguagePickers();
        return true;
    }
    return false;
}

export function closeEscapeDialog() {
    const modals = [...document.querySelectorAll('.modal-overlay:not(.hidden)')];
    if (!modals.length) return false;
    const modal = modals.reduce((top, el) => {
        const z = parseInt(getComputedStyle(el).zIndex, 10) || 0;
        const topZ = parseInt(getComputedStyle(top).zIndex, 10) || 0;
        return z >= topZ ? el : top;
    });
    const cancel = modal.querySelector('.modal-buttons .cancel-btn, [id^="cancel-"], [id^="close-"]');
    if (cancel) cancel.click();
    else modal.classList.add('hidden');
    return true;
}
