import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { requireHosted } from '../helpers.js';

requireHosted();
const repo = process.cwd();
const root = path.join(repo, 'artifacts', 'upgrade-packages');
mkdirSync(root, { recursive: true });
const baseline = path.join(repo, 'artifacts', 'upgrade-baseline');
const baselineSHA = 'c1567ce38b3f52c61ca0a6c92b9041d409906657';
function run(program, args, cwd, env = {}) {
    const result = spawnSync(program, args, { cwd, env: { ...process.env, ...env }, stdio: 'inherit', windowsHide: true, timeout: 1_800_000 });
    assert(!result.error && result.status === 0, `${program} failed: ${result.error || result.status}`);
}
function hash(file) { return createHash('sha256').update(readFileSync(file)).digest('hex'); }
const manifest = { schema: 1, platform: process.platform, baselineSource: baselineSHA, candidateSource: process.env.GITHUB_SHA,
    lane: 'reconstructed debug installers; embedded WebDriver; no release credentials', packages: {} };
for (const [role, cwd] of [['baseline', baseline], ['candidate', repo]]) {
    assert(!existsSync(path.join(cwd, '.env')), 'Installer probe refuses a checkout containing .env');
    const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', windowsHide: true });
    assert.equal(revision.status, 0);
    assert.equal(revision.stdout.trim(), role === 'baseline' ? baselineSHA : process.env.GITHUB_SHA, 'Wrong build source');
    const version = JSON.parse(readFileSync(path.join(cwd, 'src-tauri', 'tauri.conf.json'))).version;
    const target = path.join(cwd, 'src-tauri', 'target');
    const overlay = path.join(root, role + '.json');
    writeFileSync(overlay, JSON.stringify({ build: { beforeBuildCommand: 'pnpm vite:build:e2e' },
        bundle: process.platform === 'darwin' ? { macOS: { signingIdentity: '-' } } : { windows: { signCommand: null, nsis: { installMode: 'currentUser' } } } }));
    const env = { CARGO_TARGET_DIR: target, BUILD_MAC_TARGET: '' };
    run(process.execPath, ['scripts/ensure-dev-icons.js'], cwd, env);
    run(process.execPath, ['node_modules/@tauri-apps/cli/tauri.js', 'build', '--debug', '--features', 'e2e-webdriver', '--bundles', process.platform === 'darwin' ? 'app' : 'nsis', '--config', overlay], cwd, env);
    let installer, executable;
    if (process.platform === 'darwin') {
        run('/bin/bash', ['scripts/build-mac-pkg.sh'], cwd, env);
        installer = path.join(target, 'debug/bundle/pkg', `Digital-Habits-Blocker-${version}.pkg`);
        executable = path.join(target, 'debug/bundle/macos/Digital Habits Blocker.app/Contents/MacOS/redd-block');
    } else {
        const nsis = path.join(target, 'debug/bundle/nsis');
        const files = readdirSync(nsis).filter((f) => f.endsWith('-setup.exe'));
        assert.equal(files.length, 1, 'Expected exactly one NSIS installer');
        installer = path.join(nsis, files[0]);
        executable = path.join(target, 'debug/redd-block.exe');
    }
    assert(existsSync(installer) && existsSync(executable));
    const copy = path.join(root, role + path.extname(installer));
    cpSync(installer, copy);
    manifest.packages[role] = { version, installer: copy, installerSHA256: hash(copy), executableSHA256: hash(executable) };
}
assert.notEqual(manifest.packages.baseline.version, manifest.packages.candidate.version);
writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2));
