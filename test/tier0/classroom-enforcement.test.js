// The frontend's half of the room rules. Rust decides what is enforced
// (src-tauri/src/native_host/tests.rs has the matching cases); these functions
// decide what the frontend pushes to the app watcher and offers in the UI.
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { state } from '../../src/state.js';
import { collectAllowedApps, collectManualBlockedApps } from '../../src/blocking-platform.js';
import { hasAnyBlockingStateToClear, isOneOffBlockEnforced } from '../../src/schedule-engine.js';
import { applyStopToTarget } from '../../src/unlock-duration.js';

const NOW = Date.UTC(2026, 10, 27, 9, 0, 0);
const MINUTE = 60_000;

const oneOff = (blocklistId, extra = {}) => ({
    id: `block-${blocklistId}`, blocklistId, startTime: NOW - MINUTE, endTime: NOW + 30 * MINUTE, ...extra,
});

let savedAppData;
beforeEach(() => {
    savedAppData = state.appData;
    state.appData = {
        blocklists: [
            { id: 'room-allow', roomId: 'room-1', mode: 'allowlist', websites: ['school.invalid'], apps: ['Calculator'] },
            { id: 'room-block', roomId: 'room-1', mode: 'blocklist', websites: ['videos.invalid'], apps: ['Steam'] },
            { id: 'own-allow', mode: 'allowlist', websites: ['work.invalid'], apps: ['Spotify'] },
            { id: 'own-block', mode: 'blocklist', websites: ['games.invalid'], apps: ['Discord'] },
        ],
        activeBlocks: [],
        schedules: [],
        settings: {},
    };
});
afterEach(() => {
    state.appData = savedAppData;
});

describe('an allow-mode room', () => {
    test("replaces the student's own allow-mode space instead of being widened by it", () => {
        state.appData.activeBlocks = [oneOff('room-allow', { roomId: 'room-1' }), oneOff('own-allow')];
        expect([...collectAllowedApps(NOW)]).toEqual(['Calculator']);
    });

    test("keeps the student's own blocklist in force", () => {
        state.appData.activeBlocks = [oneOff('room-allow', { roomId: 'room-1' }), oneOff('own-block')];
        expect([...collectManualBlockedApps(NOW)]).toEqual(['Discord']);
    });

    test("gives the student's own allow-mode space back once it is over", () => {
        state.appData.activeBlocks = [
            oneOff('room-allow', { roomId: 'room-1', endTime: NOW - 1 }),
            oneOff('own-allow'),
        ];
        expect([...collectAllowedApps(NOW)]).toEqual(['Spotify']);
    });
});

describe('a block-mode room', () => {
    test("leaves the student's own allow-mode space alone", () => {
        state.appData.activeBlocks = [oneOff('room-block', { roomId: 'room-1' }), oneOff('own-allow')];
        expect([...collectAllowedApps(NOW)]).toEqual(['Spotify']);
        expect([...collectManualBlockedApps(NOW)]).toEqual(['Steam']);
    });
});

describe('pausing and stopping', () => {
    test('a pause flag does not suspend a room block', () => {
        const paused = { isPaused: true, pauseEndTime: NOW + 10 * MINUTE };
        state.appData.activeBlocks = [oneOff('room-block', { roomId: 'room-1', ...paused })];
        expect([...collectManualBlockedApps(NOW)]).toEqual(['Steam']);
        expect(isOneOffBlockEnforced(state.appData.activeBlocks[0], NOW)).toBe(true);

        // An ordinary block still pauses.
        state.appData.activeBlocks = [oneOff('own-block', paused)];
        expect([...collectManualBlockedApps(NOW)]).toEqual([]);
        expect(isOneOffBlockEnforced(state.appData.activeBlocks[0], NOW)).toBe(false);
    });

    test('the ordinary stop and pause path refuses a room block', () => {
        const room = oneOff('room-block', { roomId: 'room-1' });
        state.appData.activeBlocks = [room];
        expect(applyStopToTarget(state.appData, { block: room }, 10, NOW)).toBeNull();
        expect(applyStopToTarget(state.appData, { block: room }, 0, NOW)).toBeNull();
        expect(room.isPaused).toBeUndefined();
        expect(state.appData.activeBlocks).toEqual([room]);
    });

    test('a room alone gives Stop all nothing to clear', () => {
        state.appData.activeBlocks = [oneOff('room-block', { roomId: 'room-1' })];
        expect(hasAnyBlockingStateToClear(NOW)).toBe(false);
        state.appData.activeBlocks.push(oneOff('own-block'));
        expect(hasAnyBlockingStateToClear(NOW)).toBe(true);
    });
});
