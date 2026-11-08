import { execFile, spawn } from 'node:child_process';
import { closeSync, openSync, writeSync } from 'node:fs';
import { promisify } from 'node:util';
import { root } from './common.mjs';

const execute = promisify(execFile);
const maxLineBytes = 256;
const requestPattern = /^REDD_IOS_NAV ([a-f0-9]{32}) (https:\/\/example\.(?:org|com)\/\?redd-ios-test=[a-f0-9]{32})\r?$/;

export function navigationRequest(line, token) {
    if (Buffer.byteLength(line) > maxLineBytes) return null;
    const match = requestPattern.exec(line);
    return match && match[1] === token ? match[2] : null;
}

export class NavigationError extends Error {}

// Xcode may split a marker across chunks. Ignore overlong diagnostic lines
// until their next newline rather than retaining them in memory.
export function lineReader(onLine) {
    let tail = '';
    let discard = false;
    return chunk => {
        const lines = chunk.split('\n');
        for (const [index, line] of lines.entries()) {
            if (!discard) {
                if (Buffer.byteLength(tail) + Buffer.byteLength(line) > maxLineBytes) discard = true;
                else tail += line;
            }
            if (index === lines.length - 1) break;
            if (!discard) onLine(tail);
            tail = '';
            discard = false;
        }
    };
}

async function openSafari(udid, url, signal) {
    const { stdout } = await execute('xcrun', ['devicectl', 'device', 'process', 'launch', '--device', udid,
        '--payload-url', url, 'com.apple.mobilesafari', '--timeout', '12', '--json-output', '-'],
    { timeout: 15_000, maxBuffer: 128 * 1024, signal });
    const { info } = JSON.parse(stdout);
    if (info?.outcome !== 'success') throw new Error(`CoreDevice launch outcome: ${info?.outcome}`);
}

export async function runWithNavigation(args, { log, udid, token, maxRequests, timeout = 10 * 60_000 }) {
    const fd = openSync(log, 'a', 0o600);
    const controller = new AbortController();
    const urls = new Set();
    let pending = null;
    let failure;
    let forceKill;
    let child;
    const stop = error => {
        if (failure) return;
        failure = error;
        writeSync(fd, `\n[ios-test] ${error.message}\n`);
        controller.abort();
        child.kill('SIGINT');
        forceKill = setTimeout(() => child.kill('SIGKILL'), 10_000);
    };
    const interrupt = () => stop(new Error('XCTest was interrupted.'));
    let timer;
    try {
        writeSync(fd, `\n$ xcodebuild ${args.join(' ')}\n`);
        child = spawn('xcodebuild', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
        process.once('SIGINT', interrupt);
        timer = setTimeout(() => stop(new Error('XCTest exceeded its configured timeout.')), timeout);
        const handleLine = line => {
            const url = navigationRequest(line, token);
            if (!url || failure || urls.has(url)) return;
            if (pending || urls.size >= maxRequests) {
                stop(new NavigationError('XCTest exceeded its Safari navigation allowance.'));
                return;
            }
            urls.add(url);
            writeSync(fd, `\n[ios-test] Opening ${url} in Safari via CoreDevice\n`);
            pending = openSafari(udid, url, controller.signal).catch(error => {
                stop(new NavigationError(`CoreDevice could not open ${url}: ${error.message}`, { cause: error }));
            }).finally(() => { pending = null; });
        };
        for (const stream of [child.stdout, child.stderr]) {
            const consume = lineReader(handleLine);
            stream.setEncoding('utf8');
            stream.on('data', chunk => {
                writeSync(fd, chunk);
                consume(chunk);
            });
        }
        const result = await new Promise((resolve, reject) => {
            child.once('error', reject);
            child.once('close', (code, signal) => resolve({ code, signal }));
        });
        await pending;
        if (failure) throw failure;
        if (result.code !== 0) throw new Error(`xcodebuild test-without-building: ${result.signal || `exit ${result.code}`} (see ${log})`);
    } finally {
        process.off('SIGINT', interrupt);
        clearTimeout(timer);
        clearTimeout(forceKill);
        controller.abort();
        closeSync(fd);
    }
}
