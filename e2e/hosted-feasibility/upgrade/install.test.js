import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertPolicyPreserved, hash, verifyPackage, verifyUpgradeVersions } from './install.js';

test('durable policy comparison rejects changed targets, pause state and schedule boundaries', () => {
    const saved = {
        blocklists: [{ id: 'rule', apps: ['Target'], mode: 'blocklist' }],
        activeBlocks: [{ blocklistId: 'rule', isPaused: true, pauseEndTime: 900, endTime: 1000 }],
        schedules: [{ id: 'schedule', repeatType: 'date', repeatDate: '2026-11-07', segments: [{ endHour: 21, endMinute: 5 }] }],
    };
    assertPolicyPreserved(saved, structuredClone(saved));
    for (const mutate of [
        (p) => { p.blocklists[0].apps = ['Control']; },
        (p) => { p.blocklists[0].mode = 'allowlist'; },
        (p) => { p.activeBlocks[0].isPaused = false; },
        (p) => { delete p.activeBlocks[0].pauseEndTime; },
        (p) => { p.activeBlocks[0].endTime = 2000; },
        (p) => { p.schedules[0].segments[0].endMinute = 10; },
        (p) => { delete p.schedules[0].repeatDate; },
    ]) {
        const changed = structuredClone(saved);
        mutate(changed);
        assert.throws(() => assertPolicyPreserved(saved, changed), /changed saved/);
    }
});

test('upgrade versions require an actual forward version transition', () => {
    verifyUpgradeVersions('3.10.1', '3.11.0');
    verifyUpgradeVersions('3.9.0', '3.10.0');
    assert.throws(() => verifyUpgradeVersions('3.11.0', '3.10.1'), /newer/);
    assert.throws(() => verifyUpgradeVersions('3.11.0', '3.11.0'), /newer/);
    assert.throws(() => verifyUpgradeVersions('3.11.0', 'unknown'), /Invalid/);
});

test('package verification rejects tampering and incomplete executable identity', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'dh-upgrade-unit-'));
    try {
        const installer = path.join(root, 'test-installer');
        writeFileSync(installer, 'known package');
        const entry = { version: '3.10.1', installer, installerSHA256: hash(installer), executableSHA256: 'a'.repeat(64) };
        verifyPackage(root, entry);
        assert.throws(() => verifyPackage(root, { ...entry, executableSHA256: null }), /hashes/);
        writeFileSync(installer, 'changed package');
        assert.throws(() => verifyPackage(root, entry), /bytes changed/);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('package verification rejects an installer outside the owned package directory', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'dh-upgrade-unit-'));
    const outside = mkdtempSync(path.join(os.tmpdir(), 'dh-upgrade-outside-'));
    try {
        const installer = path.join(outside, 'test-installer');
        writeFileSync(installer, 'known package');
        assert.throws(() => verifyPackage(root, { version: '3.10.1', installer, installerSHA256: hash(installer), executableSHA256: 'a'.repeat(64) }), /escaped/);
    } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
    }
});
