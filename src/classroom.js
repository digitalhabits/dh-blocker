// Classroom mode: the screens. Rules live in classroom-core.js, the network
// and the check-in loop in src-tauri/src/classroom.rs, the design in
// docs/classroom-design.md.
//
// Desktop only, and off until `settings.classroomEnabled` is switched on.
// Three surfaces: the bar above the focus-space list, one modal whose content
// is one of several views (join, open a room, roster), and the leave modal,
// which reuses the typing challenge.
//
// Per AGENTS.md, module top level holds declarations only. The `let`s below
// are private to this module; nothing else reads them.
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { state } from './state.js';
import { tSettings, tSettingsFmt } from './i18n.js';
import { escapeHtml } from './utils.js';
import { saveData, syncBlockingState } from './persistence.js';
import { render } from './render.js';
import { updateBlockedApps } from './blocking-platform.js';
import { createChallengeController } from './challenge-controller.js';
import { tauriAPI } from './tauri-api.js';
import { formatTime, generateId } from './app.js';
import {
    ROOM_CHALLENGE_WORD_OPTIONS,
    ROOM_CODE_LENGTH,
    ROOM_DEFAULT_CHALLENGE_WORDS,
    ROOM_DEFAULT_MINUTES,
    ROOM_DURATION_OPTIONS,
    ROOM_NAME_MAX_LENGTH,
    applyJoinToAppData,
    buildCodeLeave,
    buildRoomRequest,
    findMissingAllowedApps,
    formatRoomCode,
    generateLeaveCode,
    getInstallId,
    getJoinedRoom,
    isRoomBlocklist,
    normalizeRoomCode,
    removeRoomFromAppData,
    validateRoomView,
    verifyLeaveCode,
} from './classroom-core.js';

const ROSTER_REFRESH_MS = 5000;
// How long a finished room stays on the teacher's screen; the server keeps it
// readable for about this long before deleting it.
const TEACHING_KEEP_AFTER_END_MS = 10 * 60_000;
const ITEMS_SHOWN = 12;

let lastBarHtml = null;
let barNotice = '';
let modalView = null;
let joinDraft = null;
let openDraft = null;
let rosterData = null;
let rosterStale = false;
let rosterTimer = null;
let confirmingEnd = false;
let busy = false;
let leaveController = null;
let leaveSubmitting = false;

export function classroomEnabled() {
    return !state.isIOS && state.appData?.settings?.classroomEnabled === true;
}

// ---- Server calls ----------------------------------------------------------

/** One call to the room server. `status` 0 means it could not be reached. */
async function api(method, path, { body = null, teacherKey = null } = {}) {
    try {
        const response = await invoke('classroom_request', { method, path, body, teacherKey });
        const status = Number(response?.status) || 0;
        return { ok: status >= 200 && status < 300, status, body: response?.body || {} };
    } catch {
        return { ok: false, status: 0, body: {} };
    }
}

function errorKeyFor(response) {
    if (response.status === 0) return 'classroomErrOffline';
    if (response.status === 404) return 'classroomErrNotFound';
    if (response.status === 410) return 'classroomErrEnded';
    if (response.status === 409) return 'classroomErrFull';
    return 'classroomErrGeneric';
}

// ---- Small formatters ------------------------------------------------------

const timeOf = (ms) => formatTime(new Date(ms));

function durationLabel(minutes) {
    if (minutes < 60) return tSettingsFmt('classroomDurationMin', { count: minutes });
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest === 0
        ? tSettingsFmt('classroomDurationHour', { count: hours })
        : tSettingsFmt('classroomDurationHourMin', { hours, minutes: rest });
}

function chipsHtml(items) {
    const shown = items.slice(0, ITEMS_SHOWN);
    const more = items.length - shown.length;
    return `<div class="classroom-chips">${shown.map((item) => `<span class="classroom-chip">${escapeHtml(item)}</span>`).join('')}${
        more > 0 ? `<span class="classroom-chip classroom-chip--more">+${more}</span>` : ''}</div>`;
}

function leaveRuleText(leave) {
    return leave?.type === 'code'
        ? tSettings('classroomLeaveRuleCode')
        : tSettingsFmt('classroomLeaveRuleChallenge', { count: leave?.words ?? 0 });
}

// ---- The bar above the focus-space list ------------------------------------

function teachingRoom(now = Date.now()) {
    const teaching = state.appData?.classroom?.teaching;
    if (!teaching?.roomId) return null;
    return now < teaching.endsAt + TEACHING_KEEP_AFTER_END_MS ? teaching : null;
}

function barHtml(now = Date.now()) {
    const parts = [];
    if (barNotice) {
        parts.push(`<div class="classroom-notice" role="status"><span>${escapeHtml(barNotice)}</span>
            <button type="button" class="classroom-link-btn" data-classroom-action="dismiss-notice">${escapeHtml(tSettings('classroomClose'))}</button></div>`);
    }
    const joined = getJoinedRoom(state.appData, now);
    if (joined) {
        parts.push(`<div class="classroom-card classroom-card--joined">
            <div class="classroom-card-copy">
                <div class="classroom-card-title">${escapeHtml(tSettingsFmt('classroomInRoom', { name: joined.roomName }))}</div>
                <div class="classroom-card-meta">${escapeHtml(tSettingsFmt('classroomEndsAt', { time: timeOf(joined.endsAt) }))}</div>
            </div>
            <button type="button" class="classroom-btn" data-classroom-action="leave">${escapeHtml(tSettings('classroomLeaveBtn'))}</button>
        </div>`);
    }
    const teaching = teachingRoom(now);
    if (teaching) {
        parts.push(`<div class="classroom-card classroom-card--teaching">
            <div class="classroom-card-copy">
                <div class="classroom-card-title">${escapeHtml(tSettingsFmt('classroomYourRoom', { name: teaching.name }))}</div>
                <div class="classroom-card-meta"><span class="classroom-code-inline">${escapeHtml(formatRoomCode(teaching.code))}</span> · ${
                    escapeHtml(tSettingsFmt('classroomEndsAt', { time: timeOf(teaching.endsAt) }))}</div>
            </div>
            <button type="button" class="classroom-btn" data-classroom-action="roster">${escapeHtml(tSettings('classroomShowRoster'))}</button>
        </div>`);
    }
    const buttons = [];
    if (!joined) buttons.push(`<button type="button" class="classroom-btn" data-classroom-action="join">${escapeHtml(tSettings('classroomJoinBtn'))}</button>`);
    if (!teaching) buttons.push(`<button type="button" class="classroom-btn" data-classroom-action="open">${escapeHtml(tSettings('classroomOpenBtn'))}</button>`);
    if (buttons.length) parts.push(`<div class="classroom-actions">${buttons.join('')}</div>`);
    return parts.join('');
}

export function renderClassroomBar() {
    const bar = document.getElementById('classroom-bar');
    if (!bar) return;
    const enabled = classroomEnabled();
    bar.classList.toggle('hidden', !enabled);
    const html = enabled ? barHtml() : '';
    // Rewriting unchanged markup would drop hover and focus on every render.
    if (html === lastBarHtml) return;
    lastBarHtml = html;
    bar.innerHTML = html;
}

// ---- The modal and its views -----------------------------------------------

function modalEl() {
    return document.getElementById('classroom-modal');
}

function showModal(view) {
    modalView = view;
    renderModal();
    modalEl()?.classList.remove('hidden');
    requestAnimationFrame(() => {
        modalEl()?.querySelector('[data-classroom-autofocus]')?.focus();
    });
}

export function closeClassroomModal() {
    modalEl()?.classList.add('hidden');
    modalView = null;
    joinDraft = null;
    openDraft = null;
    confirmingEnd = false;
    busy = false;
    stopRosterRefresh();
}

function errorHtml(key) {
    return key ? `<p class="form-hint warning classroom-error" role="alert">${escapeHtml(tSettings(key))}</p>` : '';
}

function headerHtml(title) {
    return `<h3 id="classroom-modal-title" class="classroom-modal-title">${escapeHtml(title)}</h3>`;
}

function joinCodeViewHtml() {
    return `${headerHtml(tSettings('classroomJoinTitle'))}
        <label class="classroom-label" for="classroom-code-input">${escapeHtml(tSettings('classroomCodeLabel'))}</label>
        <input id="classroom-code-input" class="classroom-input classroom-code-input" data-classroom-autofocus
            autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false"
            maxlength="${ROOM_CODE_LENGTH + 2}" placeholder="${escapeHtml(tSettings('classroomCodePlaceholder'))}"
            value="${escapeHtml(formatRoomCode(joinDraft?.code || ''))}">
        ${errorHtml(joinDraft?.error)}
        <div class="modal-buttons">
            <button type="button" id="close-classroom-modal-btn" class="modal-btn cancel-btn" data-classroom-action="close">${escapeHtml(tSettings('classroomCancel'))}</button>
            <button type="button" class="modal-btn black-btn" data-classroom-action="find-room" ${busy ? 'disabled' : ''}>${escapeHtml(tSettings('classroomFindRoom'))}</button>
        </div>`;
}

function rulesHtml(room) {
    const allow = room.mode === 'allowlist';
    const rows = [];
    if (room.websites.length) {
        rows.push(`<div class="classroom-rule-row"><span class="classroom-rule-label">${escapeHtml(tSettings('classroomWebsites'))}</span>${chipsHtml(room.websites)}</div>`);
    }
    if (room.apps.length) {
        rows.push(`<div class="classroom-rule-row"><span class="classroom-rule-label">${escapeHtml(tSettings('classroomApps'))}</span>${chipsHtml(room.apps)}</div>`);
    }
    return `<p class="classroom-rules-intro">${escapeHtml(tSettings(allow ? 'classroomAllowIntro' : 'classroomBlockIntro'))}</p>${rows.join('')}`;
}

function joinConfirmViewHtml() {
    const { room, name, missingApps = [], error } = joinDraft;
    const allow = room.mode === 'allowlist';
    const notes = [leaveRuleText(room.leave)];
    if (room.apps.length || allow) notes.push(tSettings(allow ? 'classroomAppsWillClose' : 'classroomBlockedAppsWillClose'));
    return `${headerHtml(room.name)}
        <p class="classroom-until">${escapeHtml(tSettingsFmt('classroomUntil', { time: timeOf(room.endsAt) }))}</p>
        <div class="classroom-rules">${rulesHtml(room)}</div>
        ${missingApps.length ? `<p class="form-hint warning">${escapeHtml(tSettingsFmt('classroomMissingApps', { apps: missingApps.join(', ') }))}</p>` : ''}
        <ul class="classroom-notes">${notes.map((note) => `<li>${escapeHtml(note)}</li>`).join('')}</ul>
        <p class="classroom-privacy">${escapeHtml(tSettings('classroomPrivacy'))}</p>
        <label class="classroom-label" for="classroom-name-input">${escapeHtml(tSettings('classroomYourName'))}</label>
        <input id="classroom-name-input" class="classroom-input" data-classroom-autofocus autocomplete="off"
            maxlength="${ROOM_NAME_MAX_LENGTH}" value="${escapeHtml(name || '')}">
        <p class="form-hint">${escapeHtml(tSettings('classroomNameHint'))}</p>
        ${errorHtml(error)}
        <div class="modal-buttons">
            <button type="button" id="close-classroom-modal-btn" class="modal-btn cancel-btn" data-classroom-action="close">${escapeHtml(tSettings('classroomCancel'))}</button>
            <button type="button" class="modal-btn black-btn" data-classroom-action="confirm-join" ${busy ? 'disabled' : ''}>${escapeHtml(tSettings('classroomJoinConfirm'))}</button>
        </div>`;
}

function ownFocusSpaces() {
    return (state.appData.blocklists || []).filter((bl) => !isRoomBlocklist(bl)
        && ((bl.websites || []).length > 0 || (bl.apps || []).length > 0));
}

function openRoomViewHtml() {
    const spaces = ownFocusSpaces();
    if (spaces.length === 0) {
        return `${headerHtml(tSettings('classroomOpenTitle'))}
            <p class="classroom-empty">${escapeHtml(tSettings('classroomNoSpaces'))}</p>
            <div class="modal-buttons">
                <button type="button" id="close-classroom-modal-btn" class="modal-btn cancel-btn" data-classroom-action="close">${escapeHtml(tSettings('classroomClose'))}</button>
            </div>`;
    }
    const draft = openDraft;
    const option = (value, label, selected) => `<option value="${escapeHtml(String(value))}" ${selected ? 'selected' : ''}>${escapeHtml(label)}</option>`;
    const frictionOptions = [
        ...ROOM_CHALLENGE_WORD_OPTIONS.map((words) => option(`challenge:${words}`,
            tSettingsFmt('classroomFrictionChallenge', { count: words }), draft.friction === `challenge:${words}`)),
        option('code', tSettings('classroomFrictionCode'), draft.friction === 'code'),
    ];
    return `${headerHtml(tSettings('classroomOpenTitle'))}
        <label class="classroom-label" for="classroom-space-select">${escapeHtml(tSettings('classroomFocusSpace'))}</label>
        <select id="classroom-space-select" class="classroom-input" data-classroom-autofocus>
            ${spaces.map((bl) => option(bl.id, `${bl.emoji ? `${bl.emoji} ` : ''}${bl.name}`, bl.id === draft.blocklistId)).join('')}
        </select>
        <label class="classroom-label" for="classroom-duration-select">${escapeHtml(tSettings('classroomDuration'))}</label>
        <select id="classroom-duration-select" class="classroom-input">
            ${ROOM_DURATION_OPTIONS.map((minutes) => option(minutes, durationLabel(minutes), minutes === draft.minutes)).join('')}
        </select>
        <label class="classroom-label" for="classroom-friction-select">${escapeHtml(tSettings('classroomLeaveFriction'))}</label>
        <select id="classroom-friction-select" class="classroom-input">${frictionOptions.join('')}</select>
        <p class="form-hint">${escapeHtml(tSettings('classroomOpenHint'))}</p>
        ${errorHtml(draft.error)}
        <div class="modal-buttons">
            <button type="button" id="close-classroom-modal-btn" class="modal-btn cancel-btn" data-classroom-action="close">${escapeHtml(tSettings('classroomCancel'))}</button>
            <button type="button" class="modal-btn black-btn" data-classroom-action="confirm-open" ${busy ? 'disabled' : ''}>${escapeHtml(tSettings('classroomOpenConfirm'))}</button>
        </div>`;
}

const ROSTER_STATE_KEYS = {
    on: 'classroomCountOn',
    partial: 'classroomCountPartial',
    left: 'classroomCountLeft',
    lost: 'classroomCountLost',
    released: 'classroomCountReleased',
};

function rosterRowHtml(student, ended) {
    const flags = [];
    if (student.duplicateName) flags.push(tSettings('classroomDuplicateName'));
    if (student.nameEdited) flags.push(tSettings('classroomNameEdited'));
    const since = student.state === 'lost' || student.state === 'left' ? ` ${timeOf(student.lastSeen)}` : '';
    const canRelease = !ended && (student.state === 'on' || student.state === 'partial' || student.state === 'lost');
    return `<li class="classroom-roster-row">
        <span class="classroom-roster-name">${escapeHtml(student.name)}${
            flags.length ? ` <span class="classroom-roster-flag">${escapeHtml(flags.join(' · '))}</span>` : ''}</span>
        <span class="classroom-roster-end">
            ${canRelease ? `<button type="button" class="classroom-link-btn" data-classroom-action="release" data-sid="${escapeHtml(student.sid)}">${escapeHtml(tSettings('classroomRelease'))}</button>` : ''}
            <span class="classroom-pill classroom-pill--${escapeHtml(student.state)}">${escapeHtml(tSettings(ROSTER_STATE_KEYS[student.state] || 'classroomCountOn'))}${escapeHtml(since)}</span>
        </span>
    </li>`;
}

function rosterViewHtml() {
    const teaching = state.appData?.classroom?.teaching;
    if (!teaching) return '';
    const roster = rosterData;
    const ended = roster ? roster.ended : Date.now() >= teaching.endsAt;
    const counts = roster?.counts || { on: 0, partial: 0, left: 0, lost: 0, released: 0, total: 0 };
    const metric = (key, value) => `<div class="classroom-metric"><span class="classroom-metric-label">${escapeHtml(tSettings(key))}</span><span class="classroom-metric-value">${value}</span></div>`;
    const students = roster?.students || [];
    const endButtons = confirmingEnd
        ? `<span class="classroom-end-confirm">${escapeHtml(tSettings('classroomEndRoomConfirm'))}</span>
           <button type="button" class="modal-btn cancel-btn" data-classroom-action="cancel-end">${escapeHtml(tSettings('classroomCancel'))}</button>
           <button type="button" class="modal-btn danger-btn" data-classroom-action="confirm-end" ${busy ? 'disabled' : ''}>${escapeHtml(tSettings('classroomEndRoom'))}</button>`
        : `<button type="button" id="close-classroom-modal-btn" class="modal-btn cancel-btn" data-classroom-action="close">${escapeHtml(tSettings('classroomClose'))}</button>
           ${ended ? '' : `<button type="button" class="modal-btn danger-btn" data-classroom-action="end">${escapeHtml(tSettings('classroomEndRoom'))}</button>`}`;
    return `<div class="classroom-roster-head">
            <div>
                ${headerHtml(teaching.name)}
                <p class="classroom-until">${escapeHtml(ended
                    ? tSettings('classroomRoomEnded')
                    : tSettingsFmt('classroomUntil', { time: timeOf(roster?.endsAt ?? teaching.endsAt) }))}</p>
            </div>
            <div class="classroom-code-box">
                <span class="classroom-code-label">${escapeHtml(tSettings('classroomCodeLabel'))}</span>
                <span class="classroom-code">${escapeHtml(formatRoomCode(teaching.code))}</span>
            </div>
        </div>
        ${teaching.leaveCode ? `<p class="classroom-leave-code">${escapeHtml(tSettingsFmt('classroomLeaveCodeIs', { code: teaching.leaveCode }))}</p>` : ''}
        <div class="classroom-metrics">
            ${metric('classroomCountOn', counts.on)}
            ${counts.partial ? metric('classroomCountPartial', counts.partial) : ''}
            ${metric('classroomCountLeft', counts.left + counts.released)}
            ${metric('classroomCountLost', counts.lost)}
        </div>
        ${rosterStale ? `<p class="form-hint warning">${escapeHtml(tSettings('classroomRosterStale'))}</p>` : ''}
        ${students.length
            ? `<ul class="classroom-roster">${students.map((s) => rosterRowHtml(s, ended)).join('')}</ul>`
            : `<p class="classroom-empty">${escapeHtml(tSettings('classroomNoStudents'))}</p>`}
        <div class="modal-buttons">${endButtons}</div>`;
}

function renderModal() {
    const content = document.getElementById('classroom-modal-content');
    if (!content) return;
    content.classList.toggle('classroom-modal--wide', modalView === 'roster');
    if (modalView === 'join-code') content.innerHTML = joinCodeViewHtml();
    else if (modalView === 'join-confirm') content.innerHTML = joinConfirmViewHtml();
    else if (modalView === 'open') content.innerHTML = openRoomViewHtml();
    else if (modalView === 'roster') content.innerHTML = rosterViewHtml();
}

/** Re-render a form view without losing what was typed or the caret. */
function rerenderKeepingInputs() {
    const content = document.getElementById('classroom-modal-content');
    const active = document.activeElement?.id;
    renderModal();
    if (active && content?.querySelector(`#${CSS.escape(active)}`)) {
        document.getElementById(active)?.focus();
    }
}

// ---- Joining ---------------------------------------------------------------

function openJoinModal() {
    joinDraft = { code: '', error: null };
    showModal('join-code');
}

async function installedAppNames() {
    try {
        const apps = await tauriAPI.listInstalledApps();
        return (apps || []).flatMap((app) => [app?.display_name, app?.process_name]).filter(Boolean);
    } catch {
        return [];
    }
}

async function findRoom() {
    if (busy || !joinDraft) return;
    const code = normalizeRoomCode(document.getElementById('classroom-code-input')?.value);
    joinDraft.code = code;
    if (code.length !== ROOM_CODE_LENGTH) {
        joinDraft.error = 'classroomErrCode';
        rerenderKeepingInputs();
        return;
    }
    busy = true;
    joinDraft.error = null;
    rerenderKeepingInputs();
    const response = await api('GET', `/rooms/lookup?code=${encodeURIComponent(code)}`);
    busy = false;
    if (modalView !== 'join-code' || !joinDraft) return;
    if (!response.ok) {
        joinDraft.error = errorKeyFor(response);
        rerenderKeepingInputs();
        return;
    }
    const room = validateRoomView(response.body);
    if (!room) {
        joinDraft.error = 'classroomErrInvalid';
        rerenderKeepingInputs();
        return;
    }
    let suggestedName = '';
    try { suggestedName = String(await invoke('classroom_suggested_name') || ''); } catch { /* blank field */ }
    const missingApps = room.mode === 'allowlist' && room.apps.length
        ? findMissingAllowedApps(room.apps, await installedAppNames())
        : [];
    if (modalView !== 'join-code' || !joinDraft) return;
    joinDraft = { code, room, suggestedName, name: suggestedName, missingApps, error: null };
    showModal('join-confirm');
}

async function confirmJoin() {
    if (busy || !joinDraft?.room) return;
    const name = String(document.getElementById('classroom-name-input')?.value || '').replace(/\s+/g, ' ').trim();
    joinDraft.name = name;
    if (!name) {
        joinDraft.error = 'classroomErrName';
        rerenderKeepingInputs();
        return;
    }
    // The room is re-checked against the clock: the confirm screen may have
    // sat open past the end time.
    const room = validateRoomView(joinDraft.room);
    if (!room) {
        joinDraft.error = 'classroomErrEnded';
        rerenderKeepingInputs();
        return;
    }
    busy = true;
    joinDraft.error = null;
    rerenderKeepingInputs();
    const installId = getInstallId();
    const nameEdited = name !== joinDraft.suggestedName;
    const response = await api('POST', `/rooms/${encodeURIComponent(room.roomId)}/join`, {
        body: { installId, name, nameEdited },
    });
    busy = false;
    if (!joinDraft) return;
    if (!response.ok || typeof response.body.token !== 'string') {
        joinDraft.error = errorKeyFor(response);
        rerenderKeepingInputs();
        return;
    }
    applyJoinToAppData(state.appData, {
        room,
        token: response.body.token,
        installId,
        // The server keeps the first name a device joined with.
        name: typeof response.body.name === 'string' ? response.body.name : name,
        nameEdited,
        code: joinDraft.code,
        makeId: generateId,
    });
    barNotice = '';
    closeClassroomModal();
    await persistRoomChange();
}

async function persistRoomChange() {
    await saveData();
    await syncBlockingState();
    await updateBlockedApps();
    render();
}

// ---- Leaving ---------------------------------------------------------------

function getLeaveController() {
    if (!leaveController) {
        const el = (id) => document.getElementById(id);
        leaveController = createChallengeController({
            textEl: el('classroom-leave-challenge-text'),
            inputEl: el('classroom-leave-challenge-input'),
            wordInputEl: el('classroom-leave-word-input'),
            wordProgressEl: el('classroom-leave-word-progress'),
            wordsRemainingEl: el('classroom-leave-words-remaining'),
            currentWordEl: el('classroom-leave-current-word'),
            progressBarEl: el('classroom-leave-progress-bar'),
            confirmBtnEl: el('confirm-classroom-leave-btn'),
            modalContentEl: document.querySelector('#classroom-leave-modal .modal-content'),
        });
    }
    return leaveController;
}

/**
 * The only way out of a room before its end time. Every control that would
 * pause or stop an ordinary block is routed here for a room block (see
 * `openOverrideModal`), so the friction the teacher set cannot be sidestepped
 * from the app's own UI.
 */
export function openClassroomLeaveModal() {
    const joined = getJoinedRoom(state.appData);
    const modal = document.getElementById('classroom-leave-modal');
    if (!joined || !modal) return;
    const byCode = joined.leave?.type === 'code';
    const setText = (id, text) => {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    };
    setText('classroom-leave-title', tSettingsFmt('classroomLeaveTitle', { name: joined.roomName }));
    setText('classroom-leave-body', tSettings('classroomLeaveBody'));
    setText('classroom-leave-instruction', tSettings(byCode ? 'classroomLeaveCodeInstruction' : 'classroomLeaveTypeInstruction'));
    setText('cancel-classroom-leave-btn', tSettings('classroomStay'));
    const confirmLabel = document.querySelector('#confirm-classroom-leave-btn .start-confirm-primary-label');
    if (confirmLabel) confirmLabel.textContent = tSettings('classroomLeaveConfirm');

    const codeInput = document.getElementById('classroom-leave-code-input');
    if (codeInput) {
        codeInput.value = '';
        codeInput.classList.toggle('hidden', !byCode);
    }
    document.getElementById('classroom-leave-progress')?.classList.toggle('hidden', byCode);
    document.getElementById('classroom-leave-error')?.classList.add('hidden');

    const controller = getLeaveController();
    controller.open(byCode
        ? { skipChallenge: true }
        : { difficulty: { type: 'random-words', count: joined.leave?.words || ROOM_DEFAULT_CHALLENGE_WORDS }, progressColor: null });
    modal.classList.remove('hidden');
    requestAnimationFrame(() => (byCode ? codeInput?.focus() : controller.focus()));
}

export function closeClassroomLeaveModal() {
    if (leaveSubmitting) return;
    document.getElementById('classroom-leave-modal')?.classList.add('hidden');
    leaveController?.reset?.();
}

async function confirmLeave() {
    if (leaveSubmitting) return;
    const joined = getJoinedRoom(state.appData);
    if (!joined) {
        closeClassroomLeaveModal();
        return;
    }
    if (joined.leave?.type === 'code') {
        const input = document.getElementById('classroom-leave-code-input');
        if (!(await verifyLeaveCode(input?.value, joined.leave))) {
            const error = document.getElementById('classroom-leave-error');
            if (error) {
                error.textContent = tSettings('classroomLeaveCodeWrong');
                error.classList.remove('hidden');
            }
            input?.select();
            return;
        }
    } else if (getLeaveController().handleConfirm().status !== 'ok') {
        return;
    }
    leaveSubmitting = true;
    try {
        await leaveRoom(joined, { tellServer: true });
    } finally {
        leaveSubmitting = false;
    }
    closeClassroomLeaveModal();
}

async function leaveRoom(joined, { tellServer }) {
    if (tellServer) {
        // Best effort, and not awaited: a student who is offline still leaves.
        // The roster then shows "lost contact" instead of "left".
        void api('POST', `/rooms/${encodeURIComponent(joined.roomId)}/checkin`, {
            body: { installId: joined.installId, token: joined.token, state: 'left' },
        });
    }
    removeRoomFromAppData(state.appData, joined.roomId);
    await persistRoomChange();
}

/** The check-in loop learned the room is over for this student. */
async function handleRoomStatus(payload) {
    const joined = state.appData?.classroom?.joined;
    if (!joined || payload?.roomId !== joined.roomId) return;
    if (payload.status !== 'ended' && payload.status !== 'released') return;
    barNotice = tSettingsFmt(payload.status === 'released' ? 'classroomReleasedNotice' : 'classroomEndedNotice', { name: joined.roomName });
    document.getElementById('classroom-leave-modal')?.classList.add('hidden');
    await leaveRoom(joined, { tellServer: false });
}

// ---- Opening a room and the roster (teacher) -------------------------------

function openOpenRoomModal() {
    const spaces = ownFocusSpaces();
    const selected = spaces.find((bl) => bl.id === state.selectedBlocklistId) || spaces[0];
    openDraft = {
        blocklistId: selected?.id || '',
        minutes: ROOM_DEFAULT_MINUTES,
        friction: `challenge:${ROOM_DEFAULT_CHALLENGE_WORDS}`,
        error: null,
    };
    showModal('open');
}

function readOpenForm() {
    if (!openDraft) return;
    const value = (id) => document.getElementById(id)?.value;
    openDraft.blocklistId = value('classroom-space-select') || openDraft.blocklistId;
    openDraft.minutes = Number(value('classroom-duration-select')) || openDraft.minutes;
    openDraft.friction = value('classroom-friction-select') || openDraft.friction;
}

async function confirmOpenRoom() {
    if (busy || !openDraft) return;
    readOpenForm();
    const blocklist = ownFocusSpaces().find((bl) => bl.id === openDraft.blocklistId);
    if (!blocklist || !ROOM_DURATION_OPTIONS.includes(openDraft.minutes)) return;
    busy = true;
    openDraft.error = null;
    rerenderKeepingInputs();

    let leave;
    let leaveCode = null;
    if (openDraft.friction === 'code') {
        leaveCode = generateLeaveCode();
        leave = await buildCodeLeave(leaveCode);
    } else {
        leave = { type: 'challenge', words: Number(openDraft.friction.split(':')[1]) || ROOM_DEFAULT_CHALLENGE_WORDS };
    }
    const endsAt = Date.now() + openDraft.minutes * 60_000;
    const response = await api('POST', '/rooms', { body: buildRoomRequest(blocklist, { endsAt, leave }) });
    busy = false;
    if (!openDraft) return;
    if (!response.ok || typeof response.body.teacherKey !== 'string') {
        openDraft.error = response.status === 0 ? 'classroomErrOffline' : 'classroomErrGeneric';
        rerenderKeepingInputs();
        return;
    }
    state.appData.classroom = state.appData.classroom || {};
    state.appData.classroom.teaching = {
        roomId: response.body.roomId,
        code: response.body.code,
        teacherKey: response.body.teacherKey,
        endsAt: Number(response.body.endsAt) || endsAt,
        name: blocklist.name,
        // Kept on the teacher's computer only; the server has a hash.
        ...(leaveCode ? { leaveCode } : {}),
    };
    await saveData();
    render();
    openRosterModal();
}

function stopRosterRefresh() {
    if (rosterTimer) clearInterval(rosterTimer);
    rosterTimer = null;
}

async function clearTeaching() {
    if (!state.appData?.classroom?.teaching) return;
    delete state.appData.classroom.teaching;
    rosterData = null;
    await saveData();
    render();
}

async function refreshRoster() {
    const teaching = state.appData?.classroom?.teaching;
    if (!teaching || modalView !== 'roster') return;
    const response = await api('GET', `/rooms/${encodeURIComponent(teaching.roomId)}/roster`, { teacherKey: teaching.teacherKey });
    if (modalView !== 'roster') return;
    if (response.ok) {
        rosterData = response.body;
        rosterStale = false;
        if (Number.isFinite(response.body.endsAt) && response.body.endsAt !== teaching.endsAt) {
            teaching.endsAt = response.body.endsAt;
            await saveData();
        }
    } else if (response.status === 404 || response.status === 403) {
        // The server has deleted the room: nothing left to show.
        closeClassroomModal();
        await clearTeaching();
        return;
    } else {
        rosterStale = true;
    }
    // Leave the end-room confirmation alone while it is showing.
    if (!busy) renderModal();
}

function openRosterModal() {
    if (!state.appData?.classroom?.teaching) return;
    rosterData = null;
    rosterStale = false;
    confirmingEnd = false;
    showModal('roster');
    stopRosterRefresh();
    rosterTimer = setInterval(() => void refreshRoster(), ROSTER_REFRESH_MS);
    void refreshRoster();
}

async function releaseStudent(sid) {
    const teaching = state.appData?.classroom?.teaching;
    if (!teaching || !sid) return;
    await api('POST', `/rooms/${encodeURIComponent(teaching.roomId)}/release`, { teacherKey: teaching.teacherKey, body: { sid } });
    await refreshRoster();
}

async function endRoom() {
    const teaching = state.appData?.classroom?.teaching;
    if (!teaching || busy) return;
    busy = true;
    renderModal();
    const response = await api('POST', `/rooms/${encodeURIComponent(teaching.roomId)}/end`, { teacherKey: teaching.teacherKey });
    busy = false;
    confirmingEnd = false;
    if (response.ok && Number.isFinite(response.body.endsAt)) {
        teaching.endsAt = response.body.endsAt;
        await saveData();
        render();
    } else {
        rosterStale = true;
    }
    await refreshRoster();
    renderModal();
}

// ---- Wiring ----------------------------------------------------------------

function handleAction(action, target) {
    switch (action) {
        case 'join': openJoinModal(); break;
        case 'open': openOpenRoomModal(); break;
        case 'leave': openClassroomLeaveModal(); break;
        case 'roster': openRosterModal(); break;
        case 'dismiss-notice': barNotice = ''; renderClassroomBar(); break;
        case 'close': closeClassroomModal(); break;
        case 'find-room': void findRoom(); break;
        case 'confirm-join': void confirmJoin(); break;
        case 'confirm-open': void confirmOpenRoom(); break;
        case 'release': void releaseStudent(target.dataset.sid); break;
        case 'end': confirmingEnd = true; renderModal(); break;
        case 'cancel-end': confirmingEnd = false; renderModal(); break;
        case 'confirm-end': void endRoom(); break;
        default: break;
    }
}

function onActionClick(event) {
    const target = event.target.closest('[data-classroom-action]');
    if (target) handleAction(target.dataset.classroomAction, target);
}

function setupSettingsToggle() {
    const input = document.getElementById('settings-classroom-input');
    if (!input) return;
    const sync = () => {
        input.checked = state.appData?.settings?.classroomEnabled === true;
    };
    sync();
    document.getElementById('settings-btn')?.addEventListener('click', sync);
    document.getElementById('settings-btn-stack')?.addEventListener('click', sync);
    input.addEventListener('change', async () => {
        state.appData.settings.classroomEnabled = input.checked;
        await saveData();
        render();
    });
}

/** Settings text, called whenever the language is applied. */
export function applyClassroomLanguage() {
    const label = document.getElementById('settings-classroom-label');
    if (label) label.textContent = tSettings('classroomSettingLabel');
    const hint = document.getElementById('settings-classroom-hint');
    if (hint) hint.textContent = tSettings('classroomSettingHint');
    lastBarHtml = null;
    renderClassroomBar();
}

export function setupClassroom() {
    if (state.isIOS) return;
    document.getElementById('classroom-bar')?.addEventListener('click', onActionClick);
    const modal = modalEl();
    modal?.addEventListener('click', (event) => {
        if (event.target === event.currentTarget) closeClassroomModal();
        else onActionClick(event);
    });
    modal?.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' || event.target.tagName !== 'INPUT') return;
        event.preventDefault();
        if (modalView === 'join-code') void findRoom();
        else if (modalView === 'join-confirm') void confirmJoin();
    });
    modal?.addEventListener('change', () => {
        if (modalView === 'open') readOpenForm();
    });

    const leaveModal = document.getElementById('classroom-leave-modal');
    leaveModal?.addEventListener('click', (event) => {
        if (event.target === event.currentTarget) closeClassroomLeaveModal();
    });
    document.getElementById('cancel-classroom-leave-btn')?.addEventListener('click', closeClassroomLeaveModal);
    document.getElementById('confirm-classroom-leave-btn')?.addEventListener('click', () => void confirmLeave());
    document.getElementById('classroom-leave-code-input')?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            void confirmLeave();
        }
    });

    setupSettingsToggle();
    void listen('classroom://room-status', (event) => void handleRoomStatus(event.payload));
    renderClassroomBar();
}
