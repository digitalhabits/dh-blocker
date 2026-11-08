import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { heartbeat } from './native.js';

test('heartbeat tolerates a transient Windows request-file sharing collision', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'dh-heartbeat-unit-'));
    let attempts = 0;
    try {
        const nonce = await heartbeat({ directory, name: 'unit-fixture', child: { exitCode: null, signalCode: null } }, {
            writeRequest(file, value) {
                if (++attempts < 3) throw Object.assign(new Error('sharing violation'), { code: 'EBUSY' });
                writeFileSync(file, value);
                writeFileSync(path.join(directory, 'response'), value);
            },
        });
        assert.equal(attempts, 3);
        assert.match(nonce, /^[a-f0-9-]{36}$/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('heartbeat does not swallow permanent errors or pass on an old response', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'dh-heartbeat-unit-'));
    const handle = { directory, name: 'unit-fixture', child: { exitCode: null, signalCode: null } };
    try {
        await assert.rejects(heartbeat(handle, { writeRequest() { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } }), { code: 'EACCES' });
        writeFileSync(path.join(directory, 'response'), 'old-nonce');
        await assert.rejects(heartbeat(handle, { writeRequest() { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); } }), /Event-loop nonce failed/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
});
