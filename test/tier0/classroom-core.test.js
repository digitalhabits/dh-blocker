import { webcrypto } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
    ROOM_MAX_MINUTES,
    allowRoomInForce,
    applyJoinToAppData,
    buildCodeLeave,
    buildRoomRequest,
    expandAppAliases,
    findMissingAllowedApps,
    formatRoomCode,
    generateLeaveCode,
    getInstallId,
    getJoinedRoom,
    isOneOffPausedForEnforcement,
    isRoomBlock,
    normalizeRoomCode,
    removeRoomFromAppData,
    stripClassroomForIOS,
    sweepFinishedRooms,
    validateRoomView,
    verifyLeaveCode,
} from '../../src/classroom-core.js';

const NOW = Date.UTC(2026, 10, 27, 9, 0, 0);
const MINUTE = 60_000;

const serverRoom = (overrides = {}) => ({
    roomId: 'room-1',
    name: 'Year 9 maths',
    emoji: '📐',
    color: '#2a9d8f',
    mode: 'allowlist',
    websites: ['geogebra.org'],
    apps: ['Microsoft Word'],
    endsAt: NOW + 45 * MINUTE,
    leave: { type: 'challenge', words: 30 },
    ...overrides,
});

function joinedAppData(roomOverrides = {}) {
    const appData = {
        blocklists: [{ id: 'own', name: 'Mine', mode: 'blocklist', websites: ['videos.invalid'], apps: [] }],
        activeBlocks: [{ id: 'own-block', blocklistId: 'own', startTime: NOW - MINUTE, endTime: NOW + 60 * MINUTE }],
        schedules: [],
        settings: {},
    };
    let n = 0;
    applyJoinToAppData(appData, {
        room: validateRoomView(serverRoom(roomOverrides), NOW),
        token: 'tok',
        installId: 'install-1',
        name: 'Amira',
        code: 'KLM482',
        now: NOW,
        makeId: () => `id-${++n}`,
    });
    return appData;
}

describe('room codes', () => {
    test('are read however they are typed', () => {
        expect(normalizeRoomCode(' klm-482 ')).toBe('KLM482');
        expect(normalizeRoomCode('klm 482 extra')).toBe('KLM482');
        expect(formatRoomCode('klm482')).toBe('KLM 482');
        expect(formatRoomCode('kl')).toBe('KL');
    });
});

describe('what a student accepts from the server', () => {
    test('a well-formed room passes', () => {
        expect(validateRoomView(serverRoom(), NOW)).toMatchObject({ roomId: 'room-1', mode: 'allowlist', endsAt: NOW + 45 * MINUTE });
    });

    test('a room that could never release is refused', () => {
        expect(validateRoomView(serverRoom({ endsAt: undefined }), NOW)).toBeNull();
        expect(validateRoomView(serverRoom({ endsAt: null }), NOW)).toBeNull();
        expect(validateRoomView(serverRoom({ endsAt: 'later' }), NOW)).toBeNull();
        expect(validateRoomView(serverRoom({ endsAt: NOW - 1 }), NOW)).toBeNull();
    });

    test('a room longer than the cap is refused, whatever the server allowed', () => {
        expect(validateRoomView(serverRoom({ endsAt: NOW + ROOM_MAX_MINUTES * MINUTE }), NOW)).not.toBeNull();
        expect(validateRoomView(serverRoom({ endsAt: NOW + (ROOM_MAX_MINUTES + 30) * MINUTE }), NOW)).toBeNull();
        expect(validateRoomView(serverRoom({ endsAt: NOW + 365 * 24 * 60 * MINUTE }), NOW)).toBeNull();
    });

    test('a room without a usable way out, mode or rules is refused', () => {
        expect(validateRoomView(serverRoom({ leave: undefined }), NOW)).toBeNull();
        expect(validateRoomView(serverRoom({ leave: { type: 'challenge', words: 5000 } }), NOW)).toBeNull();
        expect(validateRoomView(serverRoom({ leave: { type: 'code', salt: 'x', codeHash: 'y' } }), NOW)).toBeNull();
        expect(validateRoomView(serverRoom({ mode: 'monitor' }), NOW)).toBeNull();
        expect(validateRoomView(serverRoom({ websites: [], apps: [] }), NOW)).toBeNull();
        expect(validateRoomView(serverRoom({ roomId: '' }), NOW)).toBeNull();
        expect(validateRoomView(null, NOW)).toBeNull();
    });
});

describe('joining', () => {
    test('writes a tagged focus space, a timed block and the check-in details', () => {
        const appData = joinedAppData();
        const space = appData.blocklists.find((bl) => bl.roomId === 'room-1');
        const block = appData.activeBlocks.find((b) => b.roomId === 'room-1');

        expect(space).toMatchObject({ id: 'room-room-1', mode: 'allowlist', websites: ['geogebra.org'] });
        expect(block).toMatchObject({ blocklistId: 'room-room-1', startTime: NOW, endTime: NOW + 45 * MINUTE });
        expect(block.isAlwaysOn).toBeUndefined();
        expect(appData.classroom.joined).toMatchObject({ roomId: 'room-1', installId: 'install-1', token: 'tok', name: 'Amira' });
        expect(getJoinedRoom(appData, NOW)).toBe(appData.classroom.joined);
        // The student's own space and block are untouched.
        expect(appData.blocklists.map((bl) => bl.id)).toContain('own');
        expect(appData.activeBlocks.map((b) => b.id)).toContain('own-block');
    });

    test('one room at a time: joining another replaces the first', () => {
        const appData = joinedAppData();
        applyJoinToAppData(appData, {
            room: validateRoomView(serverRoom({ roomId: 'room-2' }), NOW),
            token: 't2', installId: 'install-1', name: 'Amira', now: NOW, makeId: () => 'id-x',
        });
        expect(appData.blocklists.filter((bl) => bl.roomId).map((bl) => bl.roomId)).toEqual(['room-2']);
        expect(appData.activeBlocks.filter((b) => b.roomId).map((b) => b.roomId)).toEqual(['room-2']);
        expect(appData.classroom.joined.roomId).toBe('room-2');
    });

    test('leaving removes the room and nothing else', () => {
        const appData = joinedAppData();
        expect(removeRoomFromAppData(appData, 'room-1')).toBe(true);
        expect(appData.blocklists.map((bl) => bl.id)).toEqual(['own']);
        expect(appData.activeBlocks.map((b) => b.id)).toEqual(['own-block']);
        expect(appData.classroom.joined).toBeUndefined();
        expect(removeRoomFromAppData(appData, 'room-1')).toBe(false);
    });

    test('a finished room is swept up; a live one is left alone', () => {
        const appData = joinedAppData();
        expect(sweepFinishedRooms(appData, NOW + 10 * MINUTE)).toBe(false);
        expect(getJoinedRoom(appData, NOW + 10 * MINUTE)).not.toBeNull();

        expect(sweepFinishedRooms(appData, NOW + 45 * MINUTE)).toBe(true);
        expect(appData.blocklists.some((bl) => bl.roomId)).toBe(false);
        expect(appData.activeBlocks.some((b) => b.roomId)).toBe(false);
        expect(appData.classroom.joined).toBeUndefined();
        expect(appData.activeBlocks.map((b) => b.id)).toEqual(['own-block']);
    });

    test('a room focus space whose block has gone is swept up too', () => {
        const appData = joinedAppData();
        appData.activeBlocks = appData.activeBlocks.filter((b) => !b.roomId);
        expect(getJoinedRoom(appData, NOW)).toBeNull();
        expect(sweepFinishedRooms(appData, NOW)).toBe(true);
        expect(appData.blocklists.map((bl) => bl.id)).toEqual(['own']);
    });

    test('iOS drops everything about rooms from an imported file', () => {
        const appData = joinedAppData();
        appData.classroom.teaching = { roomId: 'r', teacherKey: 'k' };
        expect(stripClassroomForIOS(appData)).toBe(true);
        expect(appData.classroom).toBeUndefined();
        expect(appData.blocklists.map((bl) => bl.id)).toEqual(['own']);
        expect(appData.activeBlocks.map((b) => b.id)).toEqual(['own-block']);
        expect(stripClassroomForIOS(appData)).toBe(false);
    });
});

describe('room rules the frontend mirrors from Rust', () => {
    test('a pause flag suspends an ordinary block but never a room block', () => {
        expect(isOneOffPausedForEnforcement({ isPaused: true })).toBe(true);
        expect(isOneOffPausedForEnforcement({ isPaused: true, roomId: 'room-1' })).toBe(false);
        expect(isOneOffPausedForEnforcement({})).toBe(false);
        expect(isRoomBlock({ roomId: '' })).toBe(false);
    });

    test('only an allow-mode room that is running puts the override in force', () => {
        const allow = joinedAppData();
        expect(allowRoomInForce(allow, NOW + MINUTE)).toBe(true);
        expect(allowRoomInForce(allow, NOW + 46 * MINUTE)).toBe(false);
        expect(allowRoomInForce(joinedAppData({ mode: 'blocklist' }), NOW + MINUTE)).toBe(false);
        expect(allowRoomInForce({ blocklists: [], activeBlocks: [] }, NOW)).toBe(false);
    });
});

describe('apps across macOS and Windows', () => {
    test('an app is written under every name it goes by', () => {
        expect(expandAppAliases(['Microsoft Word'])).toEqual(['Microsoft Word', 'WINWORD', 'Word']);
        expect(expandAppAliases(['chrome'])).toEqual(['chrome', 'Google Chrome']);
        expect(expandAppAliases(['Spotify', 'spotify', ''])).toEqual(['Spotify']);
        expect(joinedAppData().blocklists.find((bl) => bl.roomId).apps).toEqual(['Microsoft Word', 'WINWORD', 'Word']);
    });

    test('the join screen can tell which allowed apps this computer lacks', () => {
        const installed = ['winword', 'Spotify'];
        expect(findMissingAllowedApps(['Microsoft Word', 'Spotify', 'GeoGebra'], installed)).toEqual(['GeoGebra']);
        // No list of installed apps means no claim that anything is missing.
        expect(findMissingAllowedApps(['GeoGebra'], [])).toEqual([]);
    });

    test('a room request carries the rules and nothing else from the focus space', () => {
        const request = buildRoomRequest({
            id: 'bl-1', name: 'Maths', mode: 'allowlist', emoji: '📐', color: '#111',
            websites: ['geogebra.org'], apps: ['Calculator'],
            overrideDifficulty: { type: 'custom', count: 10, customText: 'private' },
            iosScreenTimeSelection: 'token', unlockMinutes: 5,
        }, { endsAt: NOW + 30 * MINUTE, leave: { type: 'challenge', words: 30 } });
        expect(Object.keys(request).sort()).toEqual(['apps', 'color', 'emoji', 'endsAt', 'leave', 'mode', 'name', 'websites']);
        expect(JSON.stringify(request)).not.toContain('private');
    });
});

describe("the teacher's leave code", () => {
    test('only the right code checks out, however it is typed', async () => {
        const leave = await buildCodeLeave('4821', webcrypto);
        expect(leave).toMatchObject({ type: 'code' });
        expect(JSON.stringify(leave)).not.toContain('4821');
        expect(await verifyLeaveCode('4821', leave, webcrypto)).toBe(true);
        expect(await verifyLeaveCode(' 48 21 ', leave, webcrypto)).toBe(true);
        expect(await verifyLeaveCode('4822', leave, webcrypto)).toBe(false);
        expect(await verifyLeaveCode('', leave, webcrypto)).toBe(false);
        expect(await verifyLeaveCode('4821', { type: 'challenge', words: 30 }, webcrypto)).toBe(false);
    });

    test('a generated code is four digits', () => {
        for (let i = 0; i < 20; i += 1) expect(generateLeaveCode(webcrypto)).toMatch(/^\d{4}$/);
    });
});

describe('install id', () => {
    test('is made once and kept, and survives storage that throws', () => {
        const store = new Map();
        const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
        const first = getInstallId(storage, webcrypto);
        expect(first).toMatch(/^[0-9a-f-]{36}$/);
        expect(getInstallId(storage, webcrypto)).toBe(first);

        const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
        expect(getInstallId(broken, webcrypto)).toMatch(/^[0-9a-f-]{36}$/);
    });
});
