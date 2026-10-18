// Schedule editor: segment editor, repeat dropdown, schedule start flow.
// Extracted verbatim from app.js.
import { state } from './state.js';
import { tSettings, weekdayAbbrevMon0List, weekdayLetterMon0List } from './i18n.js';
import { isNonRepeatingSchedule, isSchedulePausedNow, resolveOneShotOccurrences } from './schedule-engine.js';
import { saveData } from './persistence.js';
import { commitDelete, dismissUndoToast, pendingDelete, showUndoToast, undoDelete } from './blocklists.js';
import { handleTimeChange } from './confirm-modals.js';
import { formatTimeOfDay, pad, parseTimeOfDay, scrollPopoverOptionIntoView } from './time-inputs.js';
import { isAllDaySegment } from './when-to-block.js';
export let pendingSegmentDelete = null;

export function commitSegmentDelete() {
    if (!pendingSegmentDelete) return;
    dismissUndoToast();
    pendingSegmentDelete = null;
}

export function undoSegmentDelete() {
    if (!pendingSegmentDelete) return;
    const { segment, index } = pendingSegmentDelete;
    pendingSegmentDelete = null;
    dismissUndoToast();

    const restored = {
        ...segment,
        days: Array.isArray(segment.days) ? [...segment.days] : segment.days,
    };
    state.scheduleSegments.splice(index, 0, restored);
    rebuildScheduleSegments();

    handleTimeChange();
}

export function handleUndoToastClick() {
    if (pendingSegmentDelete) {
        undoSegmentDelete();
        return;
    }
    undoDelete();
}

function showSegmentDeleteUndoToast(segment, index) {
    showUndoToast(
        tSettings('deleteSegmentUndoToastPrefix'),
        tSettings('deleteSegmentUndoToastEmphasis'),
        '',
        () => commitSegmentDelete(),
    );
    pendingSegmentDelete = { segment, index };
}

/** The schedule record of the focus space the editor is showing (none while creating). */
export function getSelectedSchedule() {
    return state.editingBlocklistId && state.appData.schedules
        ? state.appData.schedules.find(s => s.blocklistId === state.editingBlocklistId) || null
        : null;
}

/**
 * Per-schedule opt-in (default off). The editor holds it as a draft until
 * Save writes it onto the schedule record.
 */
export function isAllowEditsBetweenBlocksOn() {
    return !!state.draftAllowEditsBetweenBlocks;
}

/**
 * Committed is a promise about a *running* space: while it is on, you cannot
 * loosen it, not even between its blocks. A space that is switched off — or
 * inside a temporary unlock, even though it will turn itself back on — is fully
 * editable, this setting included. Turning the opt-in OFF is always allowed.
 */
export function canEnableAllowEditsBetweenBlocks(schedule = getSelectedSchedule()) {
    if (!schedule) return true;
    return isSchedulePausedNow(schedule);
}

/**
 * Active schedule with the opt-in on, and not currently enforcing a time segment
 * (paused schedules count as not enforcing).
 */
export function canEditScheduleBetweenBlocks(schedule = getSelectedSchedule(), nowDate = new Date()) {
    if (!schedule || !schedule.allowEditsBetweenBlocks) return false;
    return !isScheduleSegmentActiveNow(schedule, nowDate);
}

export function isScheduleSegmentMutationBlocked(segmentIndex) {
    if (canEditScheduleBetweenBlocks()) return false;
    return segmentIndex < state.activeScheduleSegmentCount;
}

/**
 * Place an open panel dropdown menu. The menu is taken out of the flow
 * (fixed) so a scrolling dialog or panel cannot clip it, then positioned
 * under its button — or above it when it would fall below the window or
 * under the editor's sticky Save strip — and clamped to the page content
 * horizontally.
 */
export function positionSchedulePanelDropdownMenu(menu) {
    if (!menu || menu.classList.contains('hidden')) return;
    const btn = menu.parentElement?.querySelector('.repeat-dropdown-btn') || menu.previousElementSibling;
    const btnRect = btn?.getBoundingClientRect();
    if (!btnRect) return;

    const pad = 8;
    const gap = 4;

    Object.assign(menu.style, { position: 'fixed', top: '0px', left: '0px', transform: '' });
    const { width: menuW, height: menuH } = menu.getBoundingClientRect();

    // The sticky Save strip covers whatever scrolls under it, so for a menu
    // inside the editor that strip is the real bottom edge.
    let bottomLimit = window.innerHeight - pad;
    const footer = document.getElementById('editor-panel-footer');
    if (footer && footer.offsetParent !== null && menu.closest('#focus-space-editor')) {
        bottomLimit = Math.min(bottomLimit, footer.getBoundingClientRect().top - pad);
    }

    const fitsBelow = btnRect.bottom + gap + menuH <= bottomLimit;
    const fitsAbove = btnRect.top - gap - menuH >= pad;
    const placeAbove = !fitsBelow && fitsAbove;

    // Horizontal bounds are the container's content box — where its own text
    // starts — so a menu wider than its button lines up with the content
    // rather than hanging over the panel's padding.
    const host = btn.closest('.modal-content, .time-picker-container') || document.querySelector('.main-content');
    const hostRect = host?.getBoundingClientRect();
    const hostStyle = host && getComputedStyle(host);
    const minLeft = hostRect ? hostRect.left + parseFloat(hostStyle.paddingLeft) : pad;
    const maxRight = hostRect ? hostRect.right - parseFloat(hostStyle.paddingRight) : window.innerWidth - pad;

    // Right-aligned to the button, slid back inside those bounds when needed.
    const left = Math.max(minLeft, Math.min(btnRect.right - menuW, maxRight - menuW));
    const top = placeAbove ? btnRect.top - gap - menuH : btnRect.bottom + gap;
    Object.assign(menu.style, { left: `${Math.round(left)}px`, top: `${Math.round(top)}px` });
}

export function syncAllowEditsBetweenBlocksToggle() {
    const btn = document.getElementById('schedule-strictness-dropdown-btn');
    if (!btn) return;
    const flexible = isAllowEditsBetweenBlocksOn();
    const btnText = document.getElementById('schedule-strictness-dropdown-text');
    if (btnText) btnText.textContent = tSettings(flexible ? 'allowEditsFlexibleLabel' : 'allowEditsStrictLabel');
    const menu = document.getElementById('schedule-strictness-dropdown-menu');
    menu?.querySelectorAll('.strictness-option').forEach(opt => {
        opt.classList.toggle('active', (opt.dataset.value === 'flexible') === flexible);
    });
    // Committed + schedule running: switching to flexible needs a full stop first,
    // and "committed" is already selected — so the whole dropdown is locked.
    const locked = !flexible && !canEnableAllowEditsBetweenBlocks();
    // Class-only greying (no native `disabled`) so focus is not stolen.
    btn.classList.toggle('repeat-dropdown-disabled', locked);
    if (locked) menu?.classList.add('hidden');
    const wrapper = document.getElementById('schedule-strictness-dropdown-wrapper');
    if (wrapper) wrapper.title = locked ? tSettings('allowEditsBetweenBlocksLockedTooltip') : '';
}

export function setupAllowEditsBetweenBlocksToggle() {
    const btn = document.getElementById('schedule-strictness-dropdown-btn');
    const menu = document.getElementById('schedule-strictness-dropdown-menu');
    if (!btn || !menu || btn.dataset.bound === '1') return;
    btn.dataset.bound = '1';

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (btn.classList.contains('repeat-dropdown-disabled')) return;
        const isHidden = menu.classList.contains('hidden');
        if (isHidden) closeSchedulePanelDropdownMenus('schedule-strictness-dropdown-menu');
        menu.classList.toggle('hidden');
        if (isHidden) {
            requestAnimationFrame(() => positionSchedulePanelDropdownMenu(menu));
            setTimeout(() => {
                document.addEventListener('click', function closeMenu(evt) {
                    if (!menu.contains(evt.target)) {
                        menu.classList.add('hidden');
                        resetSchedulePanelDropdownMenu(menu);
                        document.removeEventListener('click', closeMenu);
                    }
                });
            }, 10);
        }
    });

    window.addEventListener('resize', () => positionSchedulePanelDropdownMenu(menu));

    menu.querySelectorAll('.strictness-option').forEach(opt => {
        opt.addEventListener('click', (e) => {
            e.stopPropagation();
            menu.classList.add('hidden');
            const desired = opt.dataset.value === 'flexible';
            if (desired === isAllowEditsBetweenBlocksOn()) return;
            if (desired && !canEnableAllowEditsBetweenBlocks()) {
                syncAllowEditsBetweenBlocksToggle();
                return;
            }
            state.draftAllowEditsBetweenBlocks = desired;
            syncAllowEditsBetweenBlocksToggle();
            handleTimeChange();
        });
    });
}

// ========================================
// SCHEDULE MODE FUNCTIONS
// ========================================

// Get default schedule segments based on current time
// Start at the current hour (floor), end 2 hours later, selected on every day of the week.
export function getDefaultScheduleSegments() {
    const now = new Date();
    const startHour = now.getHours();
    const endHour = (startHour + 2) % 24;
    return [
        { startHour, startMinute: 0, endHour, endMinute: 0, days: [0, 1, 2, 3, 4, 5, 6] }
    ];
}

/** Drop the fixed placement so a reopened menu measures cleanly. */
export function resetSchedulePanelDropdownMenu(menu) {
    if (!menu) return;
    Object.assign(menu.style, { position: '', top: '', left: '', transform: '' });
}

export function closeSchedulePanelDropdownMenus(exceptMenuId = null) {
    for (const menuId of ['schedule-panel-overlay-dropdown-menu', 'schedule-strictness-dropdown-menu']) {
        if (menuId !== exceptMenuId) {
            const menu = document.getElementById(menuId);
            menu?.classList.add('hidden');
            resetSchedulePanelDropdownMenu(menu);
        }
    }
}

// Handle Repeat date change
export function handleRepeatDateChange(e) {
    const dateStr = e.target.value;
    if (dateStr) {
        state.scheduleRepeatDate = new Date(dateStr + 'T23:59:59');
        // Update the overlay with formatted date
        const dateOverlay = document.getElementById('repeat-date-overlay');
        if (dateOverlay) {
            dateOverlay.textContent = formatDateForDisplay(state.scheduleRepeatDate);
        }
        // Update preview + section summary
        handleTimeChange();
    }
}

// Format date for input element (YYYY-MM-DD)
export function formatDateForInput(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

export function localDateKey(date) {
    return formatDateForInput(date);
}

export function parseLocalDateKey(dateKey) {
    if (!dateKey) return null;
    const [year, month, day] = dateKey.split('-').map(Number);
    if (![year, month, day].every(Number.isFinite)) return null;
    return new Date(year, month - 1, day);
}

// Format date for display (e.g., "3 Feb 2026")
export function formatDateForDisplay(date) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const day = date.getDate();
    const month = months[date.getMonth()];
    const year = date.getFullYear();
    return `${day} ${month} ${year}`;
}

export function isScheduleSegmentActiveNow(schedule, nowDate = new Date()) {
    if (!schedule || !schedule.segments || schedule.segments.length === 0) return false;
    const nowMs = nowDate.getTime();
    if (isSchedulePausedNow(schedule, nowMs)) return false;
    if (isNonRepeatingSchedule(schedule)) {
        return resolveOneShotOccurrences(schedule).some(occurrence => {
            const startMs = occurrence.start.getTime();
            const endMs = occurrence.end.getTime();
            return nowMs >= startMs && nowMs < endMs;
        });
    }
    const currentDay = nowDate.getDay() === 0 ? 6 : nowDate.getDay() - 1;
    const currentMins = nowDate.getHours() * 60 + nowDate.getMinutes();
    return schedule.segments.some(seg => {
        const startMins = seg.startHour * 60 + seg.startMinute;
        const endMins = seg.endHour * 60 + seg.endMinute;
        if (startMins === endMins) return seg.days.includes(currentDay);
        if (endMins > startMins) return seg.days.includes(currentDay) && currentMins >= startMins && currentMins < endMins;
        const yesterdayDay = currentDay === 0 ? 6 : currentDay - 1;
        return (seg.days.includes(currentDay) && currentMins >= startMins) || (seg.days.includes(yesterdayDay) && currentMins < endMins);
    });
}

export function getCommittedScheduleSegmentCount(schedule) {
    return schedule && schedule.segments ? schedule.segments.length : 0;
}

export function areSegmentsEqual(a, b) {
    if (!a || !b) return false;
    const aDays = Array.isArray(a.days) ? [...a.days].sort((x, y) => x - y) : [];
    const bDays = Array.isArray(b.days) ? [...b.days].sort((x, y) => x - y) : [];
    return a.startHour === b.startHour &&
        a.startMinute === b.startMinute &&
        a.endHour === b.endHour &&
        a.endMinute === b.endMinute &&
        JSON.stringify(aDays) === JSON.stringify(bDays);
}

// Add a new time segment
export function addScheduleSegment() {
    // Get the previous segment's end time, round up to next full hour for new start
    const prevSegment = state.scheduleSegments[state.scheduleSegments.length - 1];
    let newStartHour;
    if (prevSegment) {
        // Start 1 hour after previous end, round up if minutes present
        newStartHour = prevSegment.endMinute > 0
            ? (prevSegment.endHour + 2) % 24
            : (prevSegment.endHour + 1) % 24;
    } else {
        newStartHour = 14;
    }
    const newStartMinute = 0; // Always start on the hour
    // Default to 2 hours after start
    const newEndHour = (newStartHour + 2) % 24;
    const newEndMinute = 0;

    const defaultDays =
        prevSegment && Array.isArray(prevSegment.days) && prevSegment.days.length > 0
            ? [...prevSegment.days]
            : [0, 1, 2, 3, 4, 5, 6];

    state.scheduleSegments.push({
        startHour: newStartHour,
        startMinute: newStartMinute,
        endHour: newEndHour,
        endMinute: newEndMinute,
        days: defaultDays
    });

    // Rebuild all segments to ensure consistent rendering
    rebuildScheduleSegments();

    // Update calendar preview and section summary
    handleTimeChange();
}

// Handle clicking a day toggle within a segment
export function handleSegmentDayToggle(segmentIndex, dayIndex, btn) {
    if (isScheduleSegmentMutationBlocked(segmentIndex)) return;

    const segment = state.scheduleSegments[segmentIndex];
    if (!segment) return;

    // Toggle the day in the segment's days array
    const dayIdx = segment.days.indexOf(dayIndex);
    if (dayIdx === -1) {
        segment.days.push(dayIndex);
        segment.days.sort((a, b) => a - b);
        btn.classList.add('active');
    } else {
        // Allow removing the day (segment with no days just won't apply)
        segment.days.splice(dayIdx, 1);
        btn.classList.remove('active');
    }

    handleTimeChange();
}

// Remove a time segment
export function removeScheduleSegment(index) {
    if (isScheduleSegmentMutationBlocked(index)) return;

    if (state.scheduleSegments.length <= 1) return; // Always keep at least one

    if (pendingSegmentDelete) commitSegmentDelete();
    if (pendingDelete) commitDelete();

    const deletedSegment = {
        ...state.scheduleSegments[index],
        days: [...(state.scheduleSegments[index].days || [])],
    };

    // Remove from state
    state.scheduleSegments.splice(index, 1);

    // Rebuild DOM (simpler than updating indices)
    rebuildScheduleSegments();

    handleTimeChange();

    showSegmentDeleteUndoToast(deletedSegment, index);
}

// Sort schedule segments chronologically by start time.
// When a schedule is running, the committed/pending split is tracked by array index
// (segments before `state.activeScheduleSegmentCount` are committed, the rest are unsaved).
// Sort within each partition independently so that invariant survives the sort —
// otherwise a pending segment with an early time could swap places with a committed
// one and corrupt subsequent saves.
export function sortScheduleSegments() {
    const cmp = (a, b) => (a.startHour * 60 + a.startMinute) - (b.startHour * 60 + b.startMinute);
    if (state.activeScheduleSegmentCount > 0 && state.scheduleSegments.length > state.activeScheduleSegmentCount) {
        const committed = state.scheduleSegments.slice(0, state.activeScheduleSegmentCount).sort(cmp);
        const pending = state.scheduleSegments.slice(state.activeScheduleSegmentCount).sort(cmp);
        state.scheduleSegments = [...committed, ...pending];
    } else {
        state.scheduleSegments.sort(cmp);
    }
}

const REMOVE_SEGMENT_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';

/** The minute column lists every fifth minute; any minute can still be typed. */
const MINUTE_LIST_STEP = 5;

/**
 * The times a range had before "All day" was switched on, so switching it off
 * puts them back. In memory only: a reopened editor falls back to 09:00 – 17:00.
 */
const timesBeforeAllDay = new WeakMap();
const ALL_DAY_FALLBACK_TIMES = Object.freeze({ startHour: 9, startMinute: 0, endHour: 17, endMinute: 0 });

function segmentEdgeTime(seg, edge) {
    return edge === 'start'
        ? { hour: seg.startHour, minute: seg.startMinute }
        : { hour: seg.endHour, minute: seg.endMinute };
}

function setSegmentEdgeTime(seg, edge, { hour, minute }) {
    if (edge === 'start') {
        seg.startHour = hour;
        seg.startMinute = minute;
    } else {
        seg.endHour = hour;
        seg.endMinute = minute;
    }
}

function segmentTimeFieldHtml(seg, index, edge, label) {
    const { hour, minute } = segmentEdgeTime(seg, edge);
    return `
        <div class="segment-time-anchor">
            <input type="text" class="segment-time-field"
                data-segment-index="${index}" data-edge="${edge}"
                inputmode="numeric" maxlength="5" autocomplete="off" spellcheck="false"
                value="${formatTimeOfDay(hour, minute)}" aria-label="${label}" />
        </div>`;
}

/**
 * One time range: start – end, with × when there is more than one range, and
 * the day circles underneath in Weekly. No field labels — the HH:MM fields
 * and the dash read as a range on their own (the Mail account-hours layout).
 */
export function buildScheduleSegmentHtml(seg, index, {
    showDays,
    showRemove,
    dayLabels,
    fullDayLabels,
    labelStart,
    labelEnd,
    labelRemove,
    labelAllDay,
}) {
    const segmentDays = seg.days || [];
    const allDay = isAllDaySegment(seg);
    const dayTogglesHtml = dayLabels.map((label, i) =>
        `<button type="button" class="segment-day-toggle${segmentDays.includes(i) ? ' active' : ''}" data-day="${i}" aria-label="${fullDayLabels[i]}" aria-pressed="${segmentDays.includes(i)}">${label}</button>`
    ).join('');

    return `
        <div class="segment-times">
            ${segmentTimeFieldHtml(seg, index, 'start', labelStart)}
            <span class="segment-time-dash" aria-hidden="true">–</span>
            ${segmentTimeFieldHtml(seg, index, 'end', labelEnd)}
            <label class="segment-all-day">
                <span class="segment-all-day-label">${labelAllDay}</span>
                <span class="enforcement-switch">
                    <input type="checkbox" class="segment-all-day-input" role="switch"${allDay ? ' checked' : ''} />
                    <span class="enforcement-slider" aria-hidden="true"></span>
                </span>
            </label>
            ${showRemove ? `<button type="button" class="remove-segment-btn" aria-label="${labelRemove}">${REMOVE_SEGMENT_ICON}</button>` : ''}
        </div>
        ${showDays ? `<div class="segment-days" data-segment-index="${index}">${dayTogglesHtml}</div>` : ''}
    `;
}

export function wireScheduleSegmentElement(segment, index) {
    segment.querySelectorAll('.segment-time-field').forEach(bindScheduleTimeField);

    segment.querySelectorAll('.segment-day-toggle').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const dayIndex = parseInt(btn.dataset.day, 10);
            handleSegmentDayToggle(index, dayIndex, btn);
            btn.setAttribute('aria-pressed', btn.classList.contains('active') ? 'true' : 'false');
        });
    });

    segment.querySelector('.segment-all-day-input')?.addEventListener('change', (e) => {
        setScheduleSegmentAllDay(index, e.currentTarget.checked);
    });

    segment.querySelector('.remove-segment-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        removeScheduleSegment(index);
    });
}

/**
 * Lock the committed prefix of segments while the schedule is enforcing:
 * `state.activeScheduleSegmentCount` is the number of segments that may only
 * be added to, never changed, until the space is stopped or paused.
 */
export function applyScheduleSegmentLocks(container = document.getElementById('schedule-segments')) {
    if (!container) return;
    const unlocked = canEditScheduleBetweenBlocks();
    container.querySelectorAll('.schedule-segment').forEach((segment, index) => {
        const locked = !unlocked && index < state.activeScheduleSegmentCount;
        const allDay = isAllDaySegment(state.scheduleSegments[index]);
        segment.classList.toggle('segment-locked', locked);
        segment.classList.toggle('segment-all-day-on', allDay);
        segment.querySelectorAll('.segment-day-toggle, .remove-segment-btn, .segment-all-day-input')
            .forEach(el => { el.disabled = locked; });
        // An all-day range has no times to edit; the switch is the way back.
        segment.querySelectorAll('.segment-time-field')
            .forEach(el => { el.disabled = locked || allDay; });
    });
}

// Rebuild schedule segments DOM from state. In Daily mode there is exactly one
// segment, rendered without the days row or the remove button.
export function rebuildScheduleSegments(container = document.getElementById('schedule-segments')) {
    if (!container) return;
    // Sort chronologically before rebuilding
    sortScheduleSegments();

    const daily = state.editorKind === 'daily';
    container.innerHTML = '';

    const options = {
        showDays: !daily,
        showRemove: !daily && state.scheduleSegments.length > 1,
        // Day toggles are circles with a single letter (M T W T F S S) on every
        // platform, like the Android app; the full name is the aria-label.
        dayLabels: weekdayLetterMon0List(),
        fullDayLabels: weekdayAbbrevMon0List(),
        labelStart: tSettings('startTime'),
        labelEnd: tSettings('endTime'),
        labelRemove: tSettings('segmentDelete'),
        labelAllDay: tSettings('segmentAllDay'),
    };

    state.scheduleSegments.forEach((seg, index) => {
        const segment = document.createElement('div');
        segment.className = 'schedule-segment';
        segment.dataset.segmentIndex = index;
        segment.innerHTML = buildScheduleSegmentHtml(seg, index, options);
        container.appendChild(segment);
        wireScheduleSegmentElement(segment, index);
    });
    applyScheduleSegmentLocks(container);
}

/**
 * "All day" stores start == end at 00:00 (see `isAllDaySegment`); switching
 * it off restores the times the range had before.
 */
export function setScheduleSegmentAllDay(index, on) {
    if (isScheduleSegmentMutationBlocked(index)) return;
    const seg = state.scheduleSegments[index];
    if (!seg || isAllDaySegment(seg) === on) return;
    if (on) {
        timesBeforeAllDay.set(seg, {
            startHour: seg.startHour, startMinute: seg.startMinute,
            endHour: seg.endHour, endMinute: seg.endMinute,
        });
        Object.assign(seg, { startHour: 0, startMinute: 0, endHour: 0, endMinute: 0 });
    } else {
        Object.assign(seg, timesBeforeAllDay.get(seg) || ALL_DAY_FALLBACK_TIMES);
        timesBeforeAllDay.delete(seg);
    }
    document.querySelectorAll('.schedule-time-popover').forEach(p => p.remove());
    rebuildScheduleSegments();
    handleTimeChange();
}

function fieldSegmentIndex(field) {
    return parseInt(field.dataset.segmentIndex, 10);
}

/** The option list open for this time field, if any. */
function getScheduleTimePopoverFor(field) {
    return field.parentElement?.querySelector('.schedule-time-popover') || null;
}

/**
 * Which column the arrow keys walk: the half of HH:MM the caret is in, so
 * the keyboard edits whatever the user is looking at.
 */
function caretTimePart(field) {
    const colon = field.value.indexOf(':');
    const caret = typeof field.selectionStart === 'number' ? field.selectionStart : 0;
    return colon >= 0 && caret > colon ? 'minute' : 'hour';
}

/**
 * Move the arrow-key highlight within one column. The highlight starts from
 * the current value (`.selected`) so the first Down lands on the next option,
 * not the top of the list. Returns false when no list is open.
 */
function moveScheduleTimePopoverHighlight(field, part, delta) {
    const popover = getScheduleTimePopoverFor(field);
    if (!popover) return false;
    const column = popover.querySelector(`.popover-scroll[data-part="${part}"]`);
    const options = [...(column?.querySelectorAll('.popover-option') || [])];
    if (options.length === 0) return false;

    let from = options.findIndex((o) => o.classList.contains('key-active'));
    if (from < 0) from = options.findIndex((o) => o.classList.contains('selected'));
    const next = from < 0
        ? (delta > 0 ? 0 : options.length - 1)
        : Math.min(options.length - 1, Math.max(0, from + delta));

    popover.querySelectorAll('.popover-option.key-active').forEach((o) => o.classList.remove('key-active'));
    options[next].classList.add('key-active');
    scrollPopoverOptionIntoView(column, options[next]);
    return true;
}

/** Write the field back from state (after a rejected edit or a list pick). */
function syncScheduleTimeField(field) {
    const seg = state.scheduleSegments[fieldSegmentIndex(field)];
    if (!seg) return;
    const { hour, minute } = segmentEdgeTime(seg, field.dataset.edge);
    field.value = formatTimeOfDay(hour, minute);
}

/** Commit what was typed. Unreadable text puts the previous time back. */
export function commitScheduleTimeField(field) {
    const index = fieldSegmentIndex(field);
    if (isScheduleSegmentMutationBlocked(index)) return;
    const seg = state.scheduleSegments[index];
    if (!seg) return;

    const typed = parseTimeOfDay(field.value);
    const current = segmentEdgeTime(seg, field.dataset.edge);
    if (!typed) {
        syncScheduleTimeField(field);
        return;
    }
    field.value = formatTimeOfDay(typed.hour, typed.minute);
    if (typed.hour === current.hour && typed.minute === current.minute) return;
    setSegmentEdgeTime(seg, field.dataset.edge, typed);
    reflectTypedAllDay(seg);
    handleTimeChange();
}

/**
 * Times that meet (09:00 – 09:00) are enforced as a full day, so a committed
 * edit that lands there shows the switch on rather than looking like an
 * empty range.
 */
function reflectTypedAllDay(seg) {
    if (isAllDaySegment(seg)) rebuildScheduleSegments();
}

/** Editable HH:MM: click (or Down / Up) opens the hour and minute lists; typing edits directly. */
export function bindScheduleTimeField(field) {
    if (field.dataset.scheduleUiBound === '1') return;
    field.dataset.scheduleUiBound = '1';

    field.addEventListener('click', (e) => {
        e.stopPropagation();
        if (getScheduleTimePopoverFor(field)) return;
        showScheduleTimePopover(field);
    });
    field.addEventListener('input', () => {
        getScheduleTimePopoverFor(field)?.remove();
        const cleaned = field.value.replace(/[^\d:. ]/g, '');
        if (cleaned !== field.value) field.value = cleaned;
    });
    field.addEventListener('blur', () => commitScheduleTimeField(field));
    field.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (!getScheduleTimePopoverFor(field) && !showScheduleTimePopover(field)) return;
            moveScheduleTimePopoverHighlight(field, caretTimePart(field), e.key === 'ArrowDown' ? 1 : -1);
            return;
        }
        if (e.key === 'Escape') {
            const popover = getScheduleTimePopoverFor(field);
            if (!popover) return;
            e.preventDefault();
            popover.remove();
            return;
        }
        if (e.key !== 'Enter') return;
        e.preventDefault();
        // Enter takes the highlighted option when the list is open, then
        // closes it and commits exactly as it does for a typed time.
        const popover = getScheduleTimePopoverFor(field);
        popover?.querySelector('.popover-option.key-active')?.click();
        popover?.remove();
        commitScheduleTimeField(field);
        field.blur();
    });
}

/**
 * On iPad/iPhone, dragging inside a scrollable list of buttons can be read as
 * taps, and slow drags do not scroll in WKWebView. Drive the scroll ourselves
 * and report whether a tap right now is really the end of a drag.
 */
function bindPopoverTouchScroll(scroll) {
    let suppressOptionClickUntil = 0;
    let touchStartY = null;
    let touchStartScrollTop = 0;
    let isTouchDragging = false;
    let lastTouchY = null;
    let lastTouchTime = 0;
    let touchVelocity = 0;
    let momentumFrame = null;

    function stopMomentum() {
        if (momentumFrame != null) {
            cancelAnimationFrame(momentumFrame);
            momentumFrame = null;
        }
    }

    function startMomentum(initialVelocity) {
        stopMomentum();
        let velocity = initialVelocity;
        let lastFrameTime = performance.now();

        const tick = (now) => {
            const dt = Math.min(32, now - lastFrameTime);
            lastFrameTime = now;

            scroll.scrollTop -= velocity * dt;
            velocity *= 0.95;

            if (Math.abs(velocity) < 0.02) {
                momentumFrame = null;
                return;
            }

            const atTop = scroll.scrollTop <= 0;
            const atBottom = scroll.scrollTop >= scroll.scrollHeight - scroll.clientHeight;
            if ((atTop && velocity > 0) || (atBottom && velocity < 0)) {
                momentumFrame = null;
                return;
            }

            momentumFrame = requestAnimationFrame(tick);
        };

        momentumFrame = requestAnimationFrame(tick);
    }

    scroll.addEventListener('touchstart', (e) => {
        stopMomentum();
        touchStartY = e.touches[0]?.clientY ?? null;
        touchStartScrollTop = scroll.scrollTop;
        isTouchDragging = false;
        lastTouchY = touchStartY;
        lastTouchTime = performance.now();
        touchVelocity = 0;
    }, { passive: true });

    scroll.addEventListener('touchmove', (e) => {
        const currentY = e.touches[0]?.clientY;
        if (touchStartY != null && currentY != null) {
            const deltaY = currentY - touchStartY;
            const now = performance.now();
            const elapsed = Math.max(1, now - lastTouchTime);
            if (lastTouchY != null) {
                touchVelocity = (currentY - lastTouchY) / elapsed;
            }
            lastTouchY = currentY;
            lastTouchTime = now;
            if (Math.abs(deltaY) > 6) {
                isTouchDragging = true;
                suppressOptionClickUntil = Date.now() + 250;
                scroll.scrollTop = touchStartScrollTop - deltaY;
                e.preventDefault();
            }
        }
    }, { passive: false });

    scroll.addEventListener('touchend', () => {
        if (isTouchDragging) {
            suppressOptionClickUntil = Date.now() + 250;
            if (Math.abs(touchVelocity) > 0.08) {
                startMomentum(touchVelocity);
            }
        }
        touchStartY = null;
        isTouchDragging = false;
        lastTouchY = null;
    }, { passive: true });

    scroll.addEventListener('touchcancel', () => {
        touchStartY = null;
        isTouchDragging = false;
        lastTouchY = null;
    }, { passive: true });

    return () => Date.now() < suppressOptionClickUntil;
}

/**
 * Hour and minute lists side by side under the field. Picking an hour keeps
 * the list open for the minute; picking a minute closes it.
 * Returns false when the segment cannot be edited.
 */
export function showScheduleTimePopover(field) {
    const index = fieldSegmentIndex(field);
    if (isScheduleSegmentMutationBlocked(index)) return false;
    const segment = state.scheduleSegments[index];
    if (!segment) return false;
    const edge = field.dataset.edge;

    document.querySelectorAll('.schedule-time-popover').forEach(p => p.remove());

    const popover = document.createElement('div');
    popover.className = 'time-popover schedule-time-popover';
    const columns = document.createElement('div');
    columns.className = 'popover-columns';
    popover.appendChild(columns);

    const buildColumn = (part) => {
        const scroll = document.createElement('div');
        scroll.className = 'popover-scroll';
        scroll.dataset.part = part;
        const isSuppressed = bindPopoverTouchScroll(scroll);

        const current = segmentEdgeTime(segment, edge)[part];
        // A freely typed minute marks the nearest listed one.
        const marked = part === 'minute'
            ? Math.min(60 - MINUTE_LIST_STEP, Math.round(current / MINUTE_LIST_STEP) * MINUTE_LIST_STEP)
            : current;
        const max = part === 'hour' ? 24 : 60;
        const step = part === 'hour' ? 1 : MINUTE_LIST_STEP;

        for (let i = 0; i < max; i += step) {
            const option = document.createElement('button');
            option.type = 'button';
            option.className = 'popover-option' + (i === marked ? ' selected' : '');
            option.textContent = pad(i);
            option.addEventListener('click', (e) => {
                e.stopPropagation(); // Prevent blocklist deselection
                if (isSuppressed()) return;
                const next = { ...segmentEdgeTime(segment, edge), [part]: i };
                setSegmentEdgeTime(segment, edge, next);
                syncScheduleTimeField(field);
                scroll.querySelectorAll('.popover-option').forEach((o) =>
                    o.classList.toggle('selected', o === option));
                if (part === 'minute') {
                    popover.remove();
                    reflectTypedAllDay(segment);
                }
                handleTimeChange();
            });
            scroll.appendChild(option);
        }
        columns.appendChild(scroll);
        return scroll;
    };

    const hourColumn = buildColumn('hour');
    const minuteColumn = buildColumn('minute');
    field.parentElement.appendChild(popover);

    // Scroll each column to its current value, inside the popover only.
    scrollPopoverOptionIntoView(hourColumn, hourColumn.querySelector('.selected'));
    scrollPopoverOptionIntoView(minuteColumn, minuteColumn.querySelector('.selected'));

    // Close on outside click
    setTimeout(() => {
        document.addEventListener('click', function closePopover(e) {
            if (!popover.isConnected) {
                document.removeEventListener('click', closePopover);
                return;
            }
            if (!popover.contains(e.target) && e.target !== field) {
                popover.remove();
                document.removeEventListener('click', closePopover);
            }
        });
    }, 10);
    return true;
}
