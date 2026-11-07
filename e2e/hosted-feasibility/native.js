import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assertOwned, until, requireHosted, BlockedError } from './helpers.js';

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
export function command(program, args, { log, timeout = 120_000 } = {}) {
    const result = spawnSync(program, args, { encoding: 'utf8', timeout, windowsHide: true });
    const record = { program, args, status: result.status, error: result.error?.message, stdout: result.stdout, stderr: result.stderr };
    if (log) appendFileSync(log, JSON.stringify(record) + '\n');
    if (result.error || result.status !== 0) throw new Error(`${program} failed: ${result.error?.message || result.stderr || result.stdout}`);
    return result.stdout;
}
export function buildFixtures(root, suffix) {
    requireHosted();
    if (process.platform === 'win32') {
        command('powershell.exe', ['-NoProfile', '-File', path.join(fixtures, 'build-native-uia.ps1'), '-OutputDirectory', root], { log: path.join(root, 'native-commands.jsonl') });
    }
    const entries = {};
    for (const role of ['Target', 'Control', 'Secondary']) {
        const name = `DHProbe${role}_${suffix}`;
        const directory = path.join(root, 'fixtures', name);
        mkdirSync(directory, { recursive: true });
        let binary;
        if (process.platform === 'darwin') {
            const contents = path.join(directory, `${name}.app`, 'Contents');
            mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
            binary = path.join(contents, 'MacOS', name);
            command('xcrun', ['swiftc', '-framework', 'AppKit', path.join(fixtures, 'Probe.swift'), '-o', binary], { log: path.join(root, 'native-commands.jsonl') });
            writeFileSync(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>${name}</string><key>CFBundleName</key><string>${name}</string><key>CFBundleIdentifier</key><string>org.digitalhabits.hosted.${name.toLowerCase().replaceAll('_', '-')}</string><key>CFBundlePackageType</key><string>APPL</string><key>NSPrincipalClass</key><string>NSApplication</string></dict></plist>`);
        } else {
            binary = path.join(directory, `${name}.exe`);
            const compiler = path.join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
            command(compiler, ['/nologo', '/target:winexe', `/out:${binary}`, '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', path.join(fixtures, 'Probe.cs')], { log: path.join(root, 'native-commands.jsonl') });
            copyFileSync(path.join(fixtures, 'Probe.exe.config'), binary + '.config');
        }
        entries[role.toLowerCase()] = {
            name, binary, directory, sha256: createHash('sha256').update(readFileSync(binary)).digest('hex'),
            ...(process.platform === 'win32' ? {
                accessibilityProfile: 'net48-modern',
                adapterSha256: createHash('sha256').update(readFileSync(path.join(root, 'native-uia.exe'))).digest('hex'),
                runtimeConfigSha256: createHash('sha256').update(readFileSync(binary + '.config')).digest('hex'),
            } : {}),
        };
    }
    return entries;
}
export function launchFixture(entry, root, generation, stubborn = false) {
    requireHosted();
    const directory = path.join(entry.directory, 'state');
    mkdirSync(directory, { recursive: true });
    // Each launch must prove readiness anew; marker state intentionally survives.
    const readyBefore = existsSync(path.join(directory, 'ready')) ? readFileSync(path.join(directory, 'ready'), 'utf8') : '';
    const title = `${entry.name}-${generation}`;
    const child = spawn(entry.binary, [directory, title, stubborn ? 'stubborn' : 'normal'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const handle = { ...entry, directory, title, child, pid: child.pid, readyBefore };
    child.on('exit', (code, signal) => { handle.exitObservation = { code, signal, wallTime: Date.now() }; });
    assertOwned(handle, root);
    const log = path.join(root, `${entry.name}-${generation}.log`);
    child.stdout.on('data', (chunk) => appendFileSync(log, chunk));
    child.stderr.on('data', (chunk) => appendFileSync(log, chunk));
    child.on('error', (error) => appendFileSync(log, error.stack));
    return handle;
}
export function alive(handle) {
    return handle.child.exitCode === null && handle.child.signalCode === null;
}
function read(directory, file) {
    try { return readFileSync(path.join(directory, file), 'utf8'); } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'EBUSY') return '';
        throw error;
    }
}
export async function ready(handle) {
    await until(() => {
        assert(alive(handle), `Fixture exited before readiness: ${handle.name}`);
        return read(handle.directory, 'ready') === String(handle.pid);
    }, 15_000, `No native window readiness: ${handle.name}`);
}
export async function heartbeat(handle, { writeRequest = writeFileSync } = {}) {
    assert(alive(handle), `Fixture no longer alive: ${handle.name}`);
    const nonce = randomUUID();
    let published = false;
    let writeAttempts = 0;
    await until(() => {
        assert(alive(handle), `Fixture no longer alive: ${handle.name}`);
        if (!published) {
            try {
                writeAttempts++;
                writeRequest(path.join(handle.directory, 'request'), nonce);
                published = true;
            } catch (error) {
                // WinForms briefly holds a read handle without write sharing.
                // Retry only that collision, with the same nonce and within the
                // original 4 s response budget. Never retry GUI activation here.
                if (error.code !== 'EBUSY') throw error;
                appendFileSync(path.join(handle.directory, 'heartbeat-retries.jsonl'), JSON.stringify({ nonce, writeAttempts, code: error.code, wallTime: new Date().toISOString() }) + '\n');
                return false;
            }
        }
        return read(handle.directory, 'response') === nonce;
    }, 4_000, `Event-loop nonce failed: ${handle.name}`);
    return nonce;
}
export async function interact(handle, root, label) {
    const nonce = await heartbeat(handle);
    let method = 'System Events AX button click';
    try {
        if (process.platform === 'darwin') {
            const source = `tell application "System Events"\nset p to first application process whose unix id is ${handle.pid}\ntell p\nset frontmost to true\nclick button "Save marker" of window "${handle.title}"\nend tell\nend tell`;
            command('/usr/bin/osascript', ['-e', source], { log: path.join(root, 'external-gui.jsonl'), timeout: 12_000 });
        } else {
            assertOwned(handle, root);
            command('powershell.exe', ['-NoProfile', '-MTA', '-File', path.join(fixtures, 'inspect-window.ps1'), '-FixturePid', String(handle.pid)], { log: path.join(root, 'external-gui.jsonl'), timeout: 12_000 });
            const output = command(path.join(root, 'native-uia.exe'), [String(handle.pid), handle.title], { log: path.join(root, 'external-gui.jsonl'), timeout: 12_000 });
            method = JSON.parse(output.trim()).method;
        }
    } catch (error) {
        const unavailable = /not (?:allowed|authori[sz]ed)|assistive access|access(?:ibility)? (?:denied|not enabled)|No UIAutomation window|not exposed to UIAutomation|-1743|-1719|-25211|Access is denied|interactive (?:window|desktop)|Native button focus unavailable|Native UIAutomation unavailable/i.test(error.message);
        return { label, verdict: unavailable ? 'BLOCKED' : 'FAIL', pid: handle.pid, message: error.message };
    }
    try {
        await until(() => read(handle.directory, 'gui-response') === nonce && read(handle.directory, 'saved-marker') === nonce, 5_000, `GUI click did not persist marker: ${handle.name}`);
        return { label, verdict: 'PASS', pid: handle.pid, nonce, method };
    } catch (error) {
        return { label, verdict: 'FAIL', pid: handle.pid, message: error.message };
    }
}
export function savedMarker(handle) { return read(handle.directory, 'saved-marker'); }
export async function cleanupFixture(handle, root) {
    assertOwned(handle, root);
    if (!alive(handle)) return;
    handle.child.kill('SIGKILL');
    await until(() => !alive(handle), 5_000, `Exact-child cleanup failed: ${handle.pid}`);
}
export function emptyProfile() {
    requireHosted();
    const directory = process.platform === 'darwin'
        ? path.join(process.env.HOME, 'Library', 'Application Support', 'com.reddblock')
        : path.join(process.env.APPDATA, 'com.reddblock');
    const file = path.join(directory, 'redd-block-data.json');
    if (existsSync(file)) throw new BlockedError(`Refusing pre-existing application data: ${file}`);
    return { directory, file, existed: false };
}
