import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { command } from '../native.js';
import { requireHosted } from '../helpers.js';

export function hash(file) { return createHash('sha256').update(readFileSync(file)).digest('hex'); }
export function contained(root, file) {
    const relative = path.relative(realpathSync(root), realpathSync(file));
    assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Package escaped its worktree directory');
}
export function verifyPackage(root, entry) {
    assert(entry && /^\d+\.\d+\.\d+$/.test(entry.version), 'Invalid package version');
    assert(/^[a-f0-9]{64}$/.test(entry.installerSHA256) && /^[a-f0-9]{64}$/.test(entry.executableSHA256), 'Missing package hashes');
    contained(root, entry.installer);
    assert.equal(hash(entry.installer), entry.installerSHA256, 'Installer bytes changed');
}
export function verifyUpgradeVersions(before, after) {
    assert(/^\d+\.\d+\.\d+$/.test(before) && /^\d+\.\d+\.\d+$/.test(after), 'Invalid upgrade versions');
    const a = before.split('.').map(Number), b = after.split('.').map(Number);
    const changed = b.findIndex((n, i) => n !== a[i]);
    assert(changed >= 0 && b[changed] > a[changed], 'Candidate must be newer than baseline');
}
export function prepareUpgrade(repo) {
    requireHosted();
    const root = path.join(repo, 'artifacts', 'upgrade-packages');
    const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json')));
    assert.equal(manifest.platform, process.platform);
    assert.equal(manifest.candidateSource, process.env.GITHUB_SHA);
    assert.equal(manifest.baselineSource, 'c1567ce38b3f52c61ca0a6c92b9041d409906657');
    verifyUpgradeVersions(manifest.packages.baseline.version, manifest.packages.candidate.version);
    const home = process.env.HOME || process.env.USERPROFILE;
    const dataRoots = process.platform === 'darwin'
        ? [path.join(home, 'Library/Application Support'), '/Library/Application Support']
        : [process.env.APPDATA, process.env.PROGRAMDATA];
    for (const parent of dataRoots) {
        if (!parent) continue;
        for (const name of ['com.reddblock', 'com.redd.block', 'redd-block']) assert(!existsSync(path.join(parent, name)), 'Refusing pre-existing Blocker data directory');
    }
    if (process.platform === 'darwin') {
        for (const file of ['/Library/LaunchDaemons/com.redd.block.helper.plist', '/Library/LaunchDaemons/org.reddfocus.redd-block-helper.plist', '/Library/PrivilegedHelperTools/com.redd.block.helper']) assert(!existsSync(file), 'Refusing legacy helper residue');
    }
    const installedDirectory = process.platform === 'darwin' ? '/Applications/Digital Habits Blocker.app'
        : path.join(repo, 'artifacts', 'installed-upgrade-app');
    assert(!existsSync(installedDirectory), 'Refusing existing installation');
    if (process.platform === 'darwin') {
        for (const name of ['ReDD Blocker', 'ReDD Block', 'Fristed']) assert(!existsSync(`/Applications/${name}.app`), 'Refusing legacy installation');
        const processes = command('/bin/ps', ['-axo', 'comm=']).split('\n').map((p) => path.basename(p.trim()));
        for (const name of ['redd-block', 'Digital Habits Blocker', 'ReDD Blocker', 'ReDD Block', 'Fristed']) assert(!processes.includes(name), 'Refusing pre-existing Blocker process');
    } else {
        const existing = JSON.parse(command('powershell.exe', ['-NoProfile', '-Command', 'ConvertTo-Json -InputObject @(Get-ItemProperty "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*", "HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*" -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match "^(Digital Habits|ReDD Block|Fristed)" } | Select-Object -ExpandProperty DisplayName) -Compress']));
        assert.equal(existing.length, 0, 'Refusing existing Windows installation registration');
    }
    const binary = process.platform === 'darwin' ? path.join(installedDirectory, 'Contents/MacOS/redd-block')
        : path.join(installedDirectory, 'redd-block.exe');
    const installs = [];
    return { manifest, binary, installs, async install(role, profile, evidence) {
        requireHosted();
        const entry = manifest.packages[role];
        assert(entry && ['baseline', 'candidate'].includes(role));
        verifyPackage(root, entry);
        const before = existsSync(profile.file) ? readFileSync(profile.file) : null;
        if (role === 'candidate') assert(before, 'Missing baseline policy before upgrade');
        const log = path.join(evidence, `install-${role}.jsonl`);
        if (process.platform === 'darwin') {
            command('/usr/bin/sudo', ['/usr/bin/env', `USER=${os.userInfo().username}`, '/usr/sbin/installer', '-pkg', entry.installer, '-target', '/'], { log, timeout: 180_000 });
        } else {
            command(entry.installer, ['/S', `/D=${installedDirectory}`], { log, timeout: 180_000 });
        }
        assert.equal(hash(binary), entry.executableSHA256, 'Installed executable differs from packaged build');
        // Both production postinstall hooks launch the GUI. Stop only the
        // run-owned, hash-verified installed path before WDIO takes ownership.
        // No process names, parent trees or unrelated apps are used for cleanup.
        if (process.platform === 'win32') {
            process.env.HOSTED_INSTALLED_BINARY = binary;
            assert.equal(hash(binary), entry.executableSHA256);
            command('powershell.exe', ['-NoProfile', '-Command', '$ErrorActionPreference = "Stop"; Get-Process | Where-Object { $_.Path -eq $env:HOSTED_INSTALLED_BINARY } | ForEach-Object { $_.Kill(); if (-not $_.WaitForExit(10000)) { throw "Owned installed app did not exit" } }'], { log });
        } else {
            const rows = command('/bin/ps', ['-axo', 'pid=,comm=']).split('\n').map((r) => r.trim().match(/^(\d+)\s+(.+)$/));
            for (const row of rows.filter((r) => r && r[2] === binary)) {
                assert.equal(hash(binary), entry.executableSHA256);
                process.kill(Number(row[1]), 'SIGTERM');
                await delay(1000);
                const still = command('/bin/ps', ['-axo', 'pid=,comm=']).split('\n').some((r) => {
                    const m = r.trim().match(/^(\d+)\s+(.+)$/);
                    return m && m[1] === row[1] && m[2] === binary;
                });
                if (still) process.kill(Number(row[1]), 'SIGKILL');
            }
        }
        if (before) {
            const after = readFileSync(profile.file);
            writeFileSync(path.join(evidence, `policy-before-${role}.json`), before);
            writeFileSync(path.join(evidence, `policy-after-${role}.json`), after);
            for (const key of ['blocklists', 'activeBlocks', 'schedules']) {
                assert.deepEqual(JSON.parse(after)[key], JSON.parse(before)[key], `Installer changed existing ${key}`);
            }
        }
        installs.push({ role, version: entry.version, binary, executableSHA256: hash(binary), installerSHA256: entry.installerSHA256, completedAt: new Date().toISOString() });
    } };
}
