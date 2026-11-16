/**
 * Clicking the page background deselects the selected focus space (and so
 * closes its editor). These are the parts of the page where a click is not
 * "the background", even when nothing in them handles it.
 */
export const KEEP_SELECTION_WITHIN = [
    '.blocklist-card', '.scheduler-section', '.time-picker-container', '.schedule-block-panel',
    '.repeat-dropdown-wrapper', '.repeat-dropdown-menu', '.modal-overlay', '.section-header',
    '.footer', '.title-bar', '.week-calendar-section', '.time-popover', '.segment-time-field',
    '.undo-toast', '.zoom-toast', '.update-banner',
].join(',');

/**
 * Whether a click — or the press it came from — landed on the page
 * background, so the selected focus space should be deselected.
 *
 * An element that is no longer in the page was re-rendered by its own click
 * handler (a website chip re-renders its list when it is selected). Where it
 * sat can no longer be read, and it was a control rather than the
 * background, so the doubt falls on keeping the selection: a missed
 * deselect costs one more click, a wrong one closes the editor.
 */
export function isBackgroundClick(target, pressTarget) {
    if (!(target instanceof Element) || !target.isConnected) return false;
    if (target.closest(KEEP_SELECTION_WITHIN)) return false;
    if (pressTarget instanceof Element
        && (!pressTarget.isConnected || pressTarget.closest(KEEP_SELECTION_WITHIN))) return false;
    return true;
}
