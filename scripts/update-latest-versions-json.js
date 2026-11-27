#!/usr/bin/env node
/**
 * Update docs/latest-versions.json with platform versions and installer checksums.
 *
 * Usage:
 *   node scripts/update-latest-versions-json.js --version 3.4.3
 *   node scripts/update-latest-versions-json.js --version 3.4.3 --macos-pkg ./for-distribution/Digital-Habits-Blocker-3.4.3.pkg
 *   node scripts/update-latest-versions-json.js --version 3.4.3 --windows-x64-setup ./x64.exe --windows-arm64-setup ./arm64.exe
 *   node scripts/update-latest-versions-json.js --macos-pkg-sha256 abc123...
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MANIFEST_PATH = path.join(ROOT, 'docs', 'latest-versions.json');
const ARGUMENTS = new Map([
    ['--version', 'version'],
    ['--macos-pkg', 'macosPkgPath'],
    ['--macos-pkg-sha256', 'macosPkgSha256'],
    ['--windows-x64-setup', 'windowsX64SetupPath'],
    ['--windows-arm64-setup', 'windowsArm64SetupPath'],
]);

function parseArgs(argv) {
    const out = {};
    for (let i = 2; i < argv.length; i += 2) {
        const arg = argv[i];
        const key = ARGUMENTS.get(arg);
        if (!key) throw new Error(`Unknown argument: ${arg}`);
        const value = argv[i + 1];
        if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
        out[key] = value;
    }
    return out;
}

function sha256File(filePath) {
    const hash = crypto.createHash('sha256');
    hash.update(fs.readFileSync(filePath));
    return hash.digest('hex');
}

function setVersion(manifest, platform, version, checksumKeys) {
    const previous = manifest[platform]?.version ?? manifest[platform];
    if (previous !== version) {
        for (const key of checksumKeys) {
            delete manifest.sha256?.[key];
            delete manifest.sizeBytes?.[key];
        }
    }
    manifest[platform] = version;
}

function addInstallerChecksum(manifest, key, installerPath) {
    if (!installerPath) return;
    manifest.sha256 ??= {};
    manifest.sha256[key] = sha256File(installerPath);
}

function main() {
    const args = parseArgs(process.argv);
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));

    if (args.version) {
        setVersion(manifest, 'macos', args.version, ['macosPkg']);
        setVersion(manifest, 'windows', args.version, ['windowsX64Setup', 'windowsArm64Setup']);
        manifest.ios = args.version;
    }

    if (args.macosPkgSha256 && !args.macosPkgPath) {
        const checksum = args.macosPkgSha256.trim().toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(checksum)) throw new Error('Invalid macOS installer SHA-256');
        manifest.sha256 ??= {};
        manifest.sha256.macosPkg = checksum;
    }
    addInstallerChecksum(manifest, 'macosPkg', args.macosPkgPath);
    if (args.macosPkgPath) {
        manifest.sizeBytes ??= {};
        manifest.sizeBytes.macosPkg = fs.statSync(args.macosPkgPath).size;
    }
    addInstallerChecksum(manifest, 'windowsX64Setup', args.windowsX64SetupPath);
    addInstallerChecksum(manifest, 'windowsArm64Setup', args.windowsArm64SetupPath);

    fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 4)}\n`);
    console.log(`Updated ${path.relative(ROOT, MANIFEST_PATH)}`);
    console.log(JSON.stringify(manifest, null, 4));
}

main();
