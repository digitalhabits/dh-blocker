// Shared time-input helpers: hour/minute popover scrolling and the popover
// close-all used by the schedule segment editor and the pause/override dialogs.
// The timer (fixed-duration) controls that used to live here are gone: a
// Manual focus space runs until it is stopped.

export function pad(num) {
    return num.toString().padStart(2, '0');
}

export function formatTimeOfDay(hour, minute) {
    return `${pad(hour)}:${pad(minute)}`;
}

/**
 * Read a typed time of day: "8", "830", "0830", "8:30", "8.30", "8 30".
 * Returns { hour, minute }, or null for anything unreadable or out of range —
 * the caller puts the field back rather than clamping a typo into a real time.
 */
export function parseTimeOfDay(raw) {
    const text = String(raw ?? '').trim();
    let hourText;
    let minuteText;
    const separated = text.match(/^(\d{1,2})\s*[:.\s]\s*(\d{0,2})$/);
    if (separated) {
        [, hourText, minuteText] = separated;
    } else if (/^\d{1,4}$/.test(text)) {
        hourText = text.length <= 2 ? text : text.slice(0, text.length - 2);
        minuteText = text.length <= 2 ? '' : text.slice(-2);
    } else {
        return null;
    }
    const hour = parseInt(hourText, 10);
    const minute = minuteText === '' ? 0 : parseInt(minuteText, 10);
    if (hour > 23 || minute > 59) return null;
    return { hour, minute };
}

export function scrollPopoverOptionIntoView(scrollContainer, option) {
    if (!scrollContainer || !option) return;
    const optionTop = option.offsetTop;
    const optionHeight = option.offsetHeight;
    const containerHeight = scrollContainer.clientHeight;
    scrollContainer.scrollTop = Math.max(0, optionTop - (containerHeight - optionHeight) / 2);
}

/** Scroll an element into view inside a scroll container only — avoids panning the page. */
export function scrollElementWithinContainer(scrollContainer, element, padding = 12) {
    if (!scrollContainer || !element) return;
    const containerRect = scrollContainer.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();
    if (elementRect.bottom > containerRect.bottom - padding) {
        scrollContainer.scrollTop += elementRect.bottom - containerRect.bottom + padding;
    } else if (elementRect.top < containerRect.top + padding) {
        scrollContainer.scrollTop -= containerRect.top + padding - elementRect.top;
    }
}

export function readRootCssPx(varName) {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
    if (!raw) return 0;
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;height:' + raw;
    document.body.appendChild(probe);
    const px = parseFloat(getComputedStyle(probe).height) || 0;
    probe.remove();
    return px;
}

// Close all popovers
export function closeAllPopovers() {
    document.querySelectorAll('.time-popover:not(.schedule-time-popover)').forEach(p => p.classList.add('hidden'));
    document.querySelectorAll('.schedule-time-popover').forEach(p => p.remove());
    document.querySelectorAll('.time-popover-anchor.active').forEach(el =>
        el.classList.remove('active'));
}

// Handle clicks outside popovers
export function handlePopoverOutsideClick(e) {
    if (
        e.target.closest('.time-popover') ||
        e.target.closest('.time-popover-anchor') ||
        e.target.closest('.segment-time-field') ||
        e.target.closest('.time-popover-anchor')
    ) {
        return;
    }
    closeAllPopovers();
}

