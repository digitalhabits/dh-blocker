import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertOwned, BlockedError, requireHosted, until, verdict } from './helpers.js';

test('native guard refuses local/self-hosted/unsupported environments', () => {
    for (const env of [{}, { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted' }]) {
        assert.throws(() => requireHosted(env, 'darwin'), BlockedError);
    }
    assert.throws(() => requireHosted({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted' }, 'linux'), BlockedError);
    requireHosted({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted' }, 'win32');
});
test('cleanup refuses wrong PID, traversal and symlink escape', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'dh-owned-unit-'));
    const outside = mkdtempSync(path.join(os.tmpdir(), 'dh-outside-unit-'));
    try {
        const binary = path.join(root, 'fixture');
        const other = path.join(outside, 'fixture');
        writeFileSync(binary, 'fixture'); writeFileSync(other, 'outside');
        const handle = { child: { pid: 42 }, pid: 42, binary };
        assertOwned(handle, root);
        assert.throws(() => assertOwned({ ...handle, pid: 43 }, root));
        assert.throws(() => assertOwned({ ...handle, binary: other }, root));
        // Windows CI may not grant symlink creation; directory junctions are
        // supported there and exercise the same realpath containment check.
        symlinkSync(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
        assert.throws(() => assertOwned({ ...handle, binary: path.join(root, 'escape', 'fixture') }, root));
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});
test('missing capabilities and unfinished work cannot produce green', () => {
    assert.equal(verdict('PASS', 'PASS', 'PASS'), 'PASS');
    assert.equal(verdict('PASS', 'BLOCKED', 'PASS'), 'BLOCKED');
    assert.equal(verdict('PASS', 'FAIL', 'PASS'), 'FAIL');
    assert.equal(verdict('NOT_RUN', 'PASS', 'PASS'), 'BLOCKED');
    assert.equal(verdict('PASS', 'PASS', 'FAIL'), 'FAIL');
    assert.equal(verdict('FAIL', 'BLOCKED', 'PASS'), 'FAIL');
});
test('polling has one fixed deadline, including last shortened interval', async () => {
    let clock = 0;
    const sleeps = [];
    await assert.rejects(until(() => false, 520, 'deadline', {
        now: () => clock,
        sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    }), /deadline/);
    assert.deepEqual(sleeps, [250, 250, 20]);
    await until(() => true, 0, 'immediate');
});
