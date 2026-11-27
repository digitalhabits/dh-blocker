// Classroom mode: the rules, with no DOM and no network. Design in
// docs/classroom-design.md.
//
// A room is an ordinary one-off block that a student accepted by checking in
// to a teacher's room. On disk it is three things, all tagged with the room's
// id: a focus space in `blocklists` (hidden from the list of the student's own
// spaces), an entry in `activeBlocks` with the room's end time, and
// `classroom.joined`, which the Rust check-in loop reads.
//
// This module imports nothing from the app, so any module may import it.
//
// TWO IMPLEMENTATIONS, KEPT IN STEP. `isOneOffPausedForEnforcement` and
// `allowRoomInForce` mirror `one_off_in_force` and `allow_room_in_force` in
// src-tauri/src/native_host.rs. Rust decides what is enforced; these decide
// what the frontend pushes and shows. Change one and you must change the other.

/** One person's setting must not lock another person's laptop for hours. The
 *  server enforces the same cap; this is the student's own check of it. */
export const ROOM_MAX_MINUTES = 240;
export const ROOM_DURATION_OPTIONS = [15, 30, 45, 60, 90, 120, 180, 240];
export const ROOM_DEFAULT_MINUTES = 45;
export const ROOM_CHALLENGE_WORD_OPTIONS = [15, 30, 50, 100, 150];
export const ROOM_DEFAULT_CHALLENGE_WORDS = 30;
export const ROOM_MAX_CHALLENGE_WORDS = 150;
export const ROOM_NAME_MAX_LENGTH = 60;
export const ROOM_CODE_LENGTH = 6;
// Clocks differ between a teacher's and a student's computer.
const CLOCK_SLACK_MS = 5 * 60_000;

export function isRoomBlock(block) {
    return typeof block?.roomId === 'string' && block.roomId.length > 0;
}

export function isRoomBlocklist(blocklist) {
    return typeof blocklist?.roomId === 'string' && blocklist.roomId.length > 0;
}

/** Whether a one-off block's pause flag suspends it. A room block's never
 *  does: pausing is a one-click way out, and a room's way out is the leave
 *  friction the teacher set. Leaving removes the block instead. */
export function isOneOffPausedForEnforcement(block) {
    return !!block?.isPaused && !isRoomBlock(block);
}

function isAllowMode(blocklist) {
    return blocklist?.mode === 'allowlist';
}

/** True while an allow-mode room is in force. The student's own allow-mode
 *  spaces then drop out, because concurrent allow-mode spaces union and theirs
 *  would widen the room. Blocklists keep applying: they only block more. */
export function allowRoomInForce(appData, now = Date.now()) {
    return (appData?.activeBlocks || []).some((block) => {
        if (!isRoomBlock(block) || !(block.startTime <= now && block.endTime > now)) return false;
        return isAllowMode((appData.blocklists || []).find((bl) => bl.id === block.blocklistId));
    });
}

// ---- Room codes ------------------------------------------------------------

export function normalizeRoomCode(input) {
    return String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, ROOM_CODE_LENGTH);
}

/** "KLM482" → "KLM 482", easier to read off a projector. */
export function formatRoomCode(code) {
    const clean = normalizeRoomCode(code);
    return clean.length > 3 ? `${clean.slice(0, 3)} ${clean.slice(3)}` : clean;
}

// ---- Apps across macOS and Windows -----------------------------------------
//
// App rules are plain names matched against running processes without regard
// to case. macOS uses the .app bundle name, Windows the process name without
// ".exe". Many apps share a name on both; these do not. Each row is one app
// under every name it goes by, and a room's app list is widened to the whole
// row when it is written on a student's computer. Extra names are harmless: a
// name that matches nothing blocks nothing and allows nothing.
//
// A miss matters most in allow mode, where an app the teacher meant to allow
// would be closed on the other system. Add rows when that is reported.
export const APP_ALIAS_GROUPS = [
    ['Google Chrome', 'chrome'],
    ['Microsoft Edge', 'msedge'],
    ['Brave Browser', 'brave'],
    ['Firefox', 'firefox'],
    ['Opera', 'opera'],
    ['Vivaldi', 'vivaldi'],
    ['Microsoft Word', 'WINWORD', 'Word'],
    ['Microsoft Excel', 'EXCEL', 'Excel'],
    ['Microsoft PowerPoint', 'POWERPNT', 'PowerPoint'],
    ['Microsoft Outlook', 'OUTLOOK', 'Outlook', 'olk'],
    ['Microsoft OneNote', 'ONENOTE', 'OneNote'],
    ['Microsoft Teams', 'ms-teams', 'Teams'],
    ['Visual Studio Code', 'Code'],
    ['zoom.us', 'Zoom'],
    ['Adobe Acrobat Reader', 'Adobe Acrobat', 'Acrobat', 'AcroRd32'],
    ['Calculator', 'CalculatorApp'],
    ['Terminal', 'WindowsTerminal'],
    ['Roblox', 'RobloxPlayerBeta'],
    ['Epic Games Launcher', 'EpicGamesLauncher'],
];

export function expandAppAliases(apps) {
    const seen = new Set();
    const out = [];
    const add = (name) => {
        const key = String(name).toLowerCase();
        if (!name || seen.has(key)) return;
        seen.add(key);
        out.push(name);
    };
    for (const app of apps || []) {
        if (typeof app !== 'string' || !app.trim()) continue;
        add(app);
        const key = app.toLowerCase();
        const group = APP_ALIAS_GROUPS.find((names) => names.some((n) => n.toLowerCase() === key));
        if (group) group.forEach(add);
    }
    return out;
}

/** Allowed apps this computer does not seem to have, for the join screen in
 *  allow mode. `installed` is the names of installed apps, in any case. An app
 *  counts as present if any name in its alias row is. */
export function findMissingAllowedApps(apps, installed) {
    const have = new Set((installed || []).map((n) => String(n).toLowerCase()));
    if (have.size === 0) return [];
    return (apps || []).filter((app) => !expandAppAliases([app]).some((n) => have.has(n.toLowerCase())));
}

// ---- Opening a room (teacher) ----------------------------------------------

function cleanLeave(leave) {
    if (leave?.type === 'challenge') {
        const words = Number(leave.words);
        if (!Number.isInteger(words) || words < 1 || words > ROOM_MAX_CHALLENGE_WORDS) return null;
        return { type: 'challenge', words };
    }
    if (leave?.type === 'code') {
        if (typeof leave.salt !== 'string' || typeof leave.codeHash !== 'string') return null;
        if (!/^[0-9a-f]{16,64}$/.test(leave.salt) || !/^[0-9a-f]{64}$/.test(leave.codeHash)) return null;
        return { type: 'code', salt: leave.salt, codeHash: leave.codeHash };
    }
    return null;
}

/** What the teacher's app sends to open a room from one of their focus spaces.
 *  Only what students need: no schedule, no challenge settings, no iOS tokens. */
export function buildRoomRequest(blocklist, { endsAt, leave }) {
    return {
        name: String(blocklist?.name || '').slice(0, ROOM_NAME_MAX_LENGTH),
        emoji: blocklist?.emoji || '',
        color: blocklist?.color || '',
        mode: isAllowMode(blocklist) ? 'allowlist' : 'blocklist',
        websites: [...(blocklist?.websites || [])],
        apps: [...(blocklist?.apps || [])],
        endsAt,
        leave,
    };
}

// ---- Joining a room (student) ----------------------------------------------

function stringList(value) {
    return Array.isArray(value) ? value.filter((v) => typeof v === 'string' && v.trim()) : [];
}

/**
 * The server's description of a room, checked before it is shown or enforced.
 * Returns null for anything this computer must not act on. The checks that
 * matter most: a room must have an end time, in the future, and no further
 * off than the cap. A room that could never release is refused here, on the
 * student's side, whatever the server says.
 */
export function validateRoomView(room, now = Date.now()) {
    if (!room || typeof room.roomId !== 'string' || !room.roomId) return null;
    const endsAt = Number(room.endsAt);
    if (!Number.isFinite(endsAt) || endsAt <= now) return null;
    if (endsAt - now > ROOM_MAX_MINUTES * 60_000 + CLOCK_SLACK_MS) return null;
    if (room.mode !== 'allowlist' && room.mode !== 'blocklist') return null;
    const leave = cleanLeave(room.leave);
    if (!leave) return null;
    const websites = stringList(room.websites);
    const apps = stringList(room.apps);
    if (websites.length === 0 && apps.length === 0) return null;
    return {
        roomId: room.roomId,
        name: String(room.name || '').slice(0, ROOM_NAME_MAX_LENGTH) || 'Room',
        emoji: typeof room.emoji === 'string' ? room.emoji : '',
        color: typeof room.color === 'string' ? room.color : '',
        mode: room.mode,
        websites,
        apps,
        endsAt,
        leave,
    };
}

export function roomBlocklistId(roomId) {
    return `room-${roomId}`;
}

/** Remove every trace of a room (or of all rooms) from `appData`: its focus
 *  space, its block and `classroom.joined`. Returns whether anything changed. */
export function removeRoomFromAppData(appData, roomId = null) {
    if (!appData) return false;
    const matches = (id) => typeof id === 'string' && id.length > 0 && (roomId === null || id === roomId);
    let changed = false;

    const blocks = (appData.activeBlocks || []).filter((b) => !matches(b.roomId));
    if (blocks.length !== (appData.activeBlocks || []).length) {
        appData.activeBlocks = blocks;
        changed = true;
    }
    const blocklists = (appData.blocklists || []).filter((bl) => !matches(bl.roomId));
    if (blocklists.length !== (appData.blocklists || []).length) {
        appData.blocklists = blocklists;
        changed = true;
    }
    if (appData.classroom?.joined && matches(appData.classroom.joined.roomId)) {
        delete appData.classroom.joined;
        changed = true;
    }
    return changed;
}

/**
 * Write a room the student just confirmed into `appData`. `room` must have
 * come through `validateRoomView`. One room at a time: any earlier room is
 * removed first.
 */
export function applyJoinToAppData(appData, { room, token, installId, name, nameEdited = false, code = '', now = Date.now(), makeId }) {
    removeRoomFromAppData(appData);
    const blocklistId = roomBlocklistId(room.roomId);
    const blockId = makeId();

    appData.blocklists = appData.blocklists || [];
    appData.activeBlocks = appData.activeBlocks || [];
    appData.blocklists.push({
        id: blocklistId,
        roomId: room.roomId,
        name: room.name,
        mode: room.mode,
        color: room.color,
        emoji: room.emoji,
        websites: [...room.websites],
        apps: expandAppAliases(room.apps),
        showItemDetails: true,
    });
    appData.activeBlocks.push({
        id: blockId,
        blocklistId,
        roomId: room.roomId,
        startTime: now,
        endTime: room.endsAt,
    });
    appData.classroom = appData.classroom || {};
    appData.classroom.joined = {
        roomId: room.roomId,
        code,
        installId,
        token,
        name,
        nameEdited: !!nameEdited,
        roomName: room.name,
        mode: room.mode,
        endsAt: room.endsAt,
        leave: room.leave,
        blocklistId,
        blockId,
        joinedAt: now,
    };
    return appData.classroom.joined;
}

/** The room this computer is checked in to and still held by, or null. */
export function getJoinedRoom(appData, now = Date.now()) {
    const joined = appData?.classroom?.joined;
    if (!joined?.roomId) return null;
    const held = (appData.activeBlocks || []).some((b) => b.roomId === joined.roomId && b.endTime > now);
    return held ? joined : null;
}

/** Tidy up after a room that is over: its end time passed, or its block is
 *  gone. Also drops a finished room the teacher was running. Returns whether
 *  anything changed, so the caller knows to save. */
export function sweepFinishedRooms(appData, now = Date.now()) {
    if (!appData) return false;
    let changed = false;
    const liveRoomIds = new Set(
        (appData.activeBlocks || []).filter((b) => isRoomBlock(b) && b.endTime > now).map((b) => b.roomId),
    );
    for (const bl of [...(appData.blocklists || [])]) {
        if (isRoomBlocklist(bl) && !liveRoomIds.has(bl.roomId)) {
            changed = removeRoomFromAppData(appData, bl.roomId) || changed;
        }
    }
    for (const block of [...(appData.activeBlocks || [])]) {
        if (isRoomBlock(block) && !liveRoomIds.has(block.roomId)) {
            changed = removeRoomFromAppData(appData, block.roomId) || changed;
        }
    }
    const joined = appData.classroom?.joined;
    if (joined && !liveRoomIds.has(joined.roomId)) {
        delete appData.classroom.joined;
        changed = true;
    }
    return changed;
}

/** iOS has no Classroom mode. A data file brought over from a desktop must
 *  not leave a room's focus space or block behind there, where the resolvers
 *  would treat them as the user's own. */
export function stripClassroomForIOS(appData) {
    if (!appData) return false;
    let changed = removeRoomFromAppData(appData);
    if (appData.classroom) {
        delete appData.classroom;
        changed = true;
    }
    return changed;
}

// ---- The teacher's leave code ----------------------------------------------
//
// The code never goes to the server. The teacher's app keeps it and sends a
// salted hash, which students' apps check a typed code against, so it works
// with no connection. Four digits behind a hash would not stop someone with a
// script; it does not need to. The bar is a student in a weak moment at the
// app's own screen (see "The product principle" in AGENTS.md).

function toHex(bytes) {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function randomBytes(count, cryptoImpl = globalThis.crypto) {
    const bytes = new Uint8Array(count);
    cryptoImpl.getRandomValues(bytes);
    return bytes;
}

export function generateLeaveCode(cryptoImpl = globalThis.crypto) {
    const bytes = randomBytes(4, cryptoImpl);
    return Array.from(bytes, (b) => String(b % 10)).join('');
}

export function generateSalt(cryptoImpl = globalThis.crypto) {
    return toHex(randomBytes(16, cryptoImpl));
}

export function normalizeLeaveCode(input) {
    return String(input || '').replace(/\D/g, '');
}

export async function hashLeaveCode(code, salt, cryptoImpl = globalThis.crypto) {
    const data = new TextEncoder().encode(`${salt}:${normalizeLeaveCode(code)}`);
    return toHex(new Uint8Array(await cryptoImpl.subtle.digest('SHA-256', data)));
}

export async function buildCodeLeave(code, cryptoImpl = globalThis.crypto) {
    const salt = generateSalt(cryptoImpl);
    return { type: 'code', salt, codeHash: await hashLeaveCode(code, salt, cryptoImpl) };
}

export async function verifyLeaveCode(input, leave, cryptoImpl = globalThis.crypto) {
    if (leave?.type !== 'code' || !normalizeLeaveCode(input)) return false;
    return (await hashLeaveCode(input, leave.salt, cryptoImpl)) === leave.codeHash;
}

// ---- Install id ------------------------------------------------------------

function randomUuid(cryptoImpl = globalThis.crypto) {
    if (typeof cryptoImpl?.randomUUID === 'function') return cryptoImpl.randomUUID();
    const b = randomBytes(16, cryptoImpl);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = toHex(b);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const INSTALL_ID_KEY = 'classroomInstallId';

/**
 * A random id for this install, which the server uses to keep one name per
 * device per room. It lives in localStorage, not the data file: the data file
 * is exported and imported between machines, and two machines must not share
 * one. Where storage is unavailable the id lasts for this run only.
 */
export function getInstallId(storage = globalThis.localStorage, cryptoImpl = globalThis.crypto) {
    try {
        const stored = storage?.getItem(INSTALL_ID_KEY);
        if (stored && /^[0-9a-f-]{36}$/.test(stored)) return stored;
    } catch { /* fall through to a fresh id */ }
    const id = randomUuid(cryptoImpl);
    try { storage?.setItem(INSTALL_ID_KEY, id); } catch { /* this run only */ }
    return id;
}
