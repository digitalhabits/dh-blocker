import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execPath } from 'node:process';
import { afterEach, beforeEach, expect, test } from 'vitest';

let root;
let manifestPath;
const sha256 = (content) => createHash('sha256').update(content).digest('hex');
const originalManifest = JSON.stringify({
    macos: '4.2.0',
    windows: '4.2.0',
    ios: '4.2.0',
    sha256: { macosPkg: sha256('old macOS installer') },
    sizeBytes: { macosPkg: 19 },
});

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'redd-block-release-manifest-'));
    mkdirSync(join(root, 'docs'));
    mkdirSync(join(root, 'scripts'));
    copyFileSync('scripts/update-latest-versions-json.js', join(root, 'scripts', 'update-latest-versions-json.js'));
    manifestPath = join(root, 'docs', 'latest-versions.json');
    writeFileSync(manifestPath, originalManifest);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function updateManifest(...args) {
    execFileSync(execPath, ['scripts/update-latest-versions-json.js', ...args], {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(readFileSync(manifestPath, 'utf8'));
}

test('publishes checksums for the exact macOS, Windows x64 and Windows ARM64 installer files', () => {
    writeFileSync(join(root, 'install.pkg'), 'macOS installer');
    writeFileSync(join(root, 'x64.exe'), 'Windows x64 installer');
    writeFileSync(join(root, 'arm64.exe'), 'Windows ARM64 installer');

    const manifest = updateManifest('--version', '4.2.1', '--macos-pkg', 'install.pkg',
        '--windows-x64-setup', 'x64.exe', '--windows-arm64-setup', 'arm64.exe');

    expect(manifest).toMatchObject({
        macos: '4.2.1',
        windows: '4.2.1',
        ios: '4.2.1',
        sha256: {
            macosPkg: sha256('macOS installer'),
            windowsX64Setup: sha256('Windows x64 installer'),
            windowsArm64Setup: sha256('Windows ARM64 installer'),
        },
        sizeBytes: { macosPkg: 15 },
    });
});

test('does not update the manifest when a supplied Windows installer is missing', () => {
    writeFileSync(join(root, 'x64.exe'), 'Windows x64 installer');

    expect(() => updateManifest('--version', '4.2.1', '--windows-x64-setup', 'x64.exe',
        '--windows-arm64-setup', 'missing.exe')).toThrow();
    expect(readFileSync(manifestPath, 'utf8')).toBe(originalManifest);
});

test('does not carry old installer checksums forward in a version-only update', () => {
    const manifest = JSON.parse(originalManifest);
    manifest.sha256.windowsX64Setup = sha256('old Windows x64 installer');
    manifest.sha256.windowsArm64Setup = sha256('old Windows ARM64 installer');
    writeFileSync(manifestPath, JSON.stringify(manifest));

    const updated = updateManifest('--version', '4.2.1');
    expect(updated.sha256).toEqual({});
    expect(updated.sizeBytes).toEqual({});
});
