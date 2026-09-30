#!/usr/bin/env node
/**
 * Stage the in-place update files for a macOS release.
 *
 * `tauri build` with `createUpdaterArtifacts` leaves `<Product>.app.tar.gz`
 * (and a `.sig`) in the bundle directory. This copies the archive to a
 * versioned, space-free name, re-signs it with the release version bound into
 * the signature, and writes `macos-update.json`, the manifest the app fetches
 * from `releases/download/v<version>/` (see `macos_update_manifest_url` in
 * src-tauri/src/commands/app_update.rs).
 *
 * Re-signing with `--app-version` is what lets the app set
 * `requireSignedVersion`: the plugin then rejects a manifest that pairs this
 * archive with any other version number.
 *
 * Usage (from scripts/build-mac.sh, only when TAURI_SIGNING_PRIVATE_KEY is set):
 *   node scripts/stage-macos-updater.js --bundle-dir <…/bundle/macos> \
 *       --target universal-apple-darwin --out for-distribution
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const GITHUB_RELEASES = 'https://github.com/digitalhabits/dh-blocker/releases/download';
const MANIFEST_NAME = 'macos-update.json';

/**
 * The plugin looks up `darwin-<arch>` for the running binary. A universal
 * archive serves both keys.
 */
function updaterPlatformsForTarget(target) {
    switch (target) {
        case 'universal-apple-darwin':
        case '':
            return { suffix: 'universal', platforms: ['darwin-aarch64', 'darwin-x86_64'] };
        case 'aarch64-apple-darwin':
            return { suffix: 'aarch64', platforms: ['darwin-aarch64'] };
        case 'x86_64-apple-darwin':
            return { suffix: 'x86_64', platforms: ['darwin-x86_64'] };
        default:
            throw new Error(`Unsupported macOS build target: ${target}`);
    }
}

function archiveName(version, suffix) {
    return `Digital-Habits-Blocker-${version}-${suffix}.app.tar.gz`;
}

function buildManifest({ version, archive, signature, platforms, pubDate }) {
    const url = `${GITHUB_RELEASES}/v${version}/${archive}`;
    return {
        version,
        pub_date: pubDate,
        platforms: Object.fromEntries(platforms.map((p) => [p, { url, signature }])),
    };
}

/**
 * The block page is loaded by Safari as the logged-in user over file://, so
 * its resources must be world-readable. The .pkg path fixes modes in
 * scripts/build-mac-pkg.sh and its postinstall; an in-place update runs
 * neither, so the archive has to be right as built. Takes `tar -tvzf` output.
 */
function unreadableBlockedResources(tarListing) {
    return tarListing
        .split('\n')
        .filter((line) => line.includes('/Contents/Resources/blocked/') && line.startsWith('-'))
        .filter((line) => line[7] !== 'r')
        .map((line) => line.trim());
}

function parseArgs(argv) {
    const out = {};
    for (let i = 2; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--bundle-dir') out.bundleDir = argv[++i];
        else if (arg === '--target') out.target = argv[++i];
        else if (arg === '--out') out.outDir = argv[++i];
        else throw new Error(`Unknown argument: ${arg}`);
    }
    if (!out.bundleDir || !out.outDir) {
        throw new Error('Usage: stage-macos-updater.js --bundle-dir <dir> --target <triple> --out <dir>');
    }
    return out;
}

function run(cmd, args) {
    const res = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
    if (res.status !== 0) {
        throw new Error(`${cmd} ${args.join(' ')} failed (exit ${res.status})`);
    }
    return res.stdout;
}

function main() {
    const args = parseArgs(process.argv);
    const version = require(path.join(ROOT, 'src-tauri', 'tauri.conf.json')).version;
    const { suffix, platforms } = updaterPlatformsForTarget(args.target ?? 'universal-apple-darwin');

    const built = fs.readdirSync(args.bundleDir).filter((f) => f.endsWith('.app.tar.gz'));
    if (built.length !== 1) {
        throw new Error(`Expected one .app.tar.gz in ${args.bundleDir}, found: ${built.join(', ') || 'none'}`);
    }

    const bad = unreadableBlockedResources(run('tar', ['-tvzf', path.join(args.bundleDir, built[0])]));
    if (bad.length > 0) {
        throw new Error(`Block page resources are not world-readable in the update archive:\n${bad.join('\n')}`);
    }

    fs.mkdirSync(args.outDir, { recursive: true });
    const archive = archiveName(version, suffix);
    const archivePath = path.join(args.outDir, archive);
    fs.copyFileSync(path.join(args.bundleDir, built[0]), archivePath);

    // Signing key and password come from TAURI_SIGNING_PRIVATE_KEY(_PASSWORD).
    run('pnpm', ['tauri', 'signer', 'sign', '--app-version', version, archivePath]);
    const signature = fs.readFileSync(`${archivePath}.sig`, 'utf8').trim();

    const manifest = buildManifest({
        version,
        archive,
        signature,
        platforms,
        pubDate: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    });
    const manifestPath = path.join(args.outDir, MANIFEST_NAME);
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 4)}\n`);

    console.log(`Staged ${archivePath}`);
    console.log(`Wrote ${manifestPath}`);
}

if (require.main === module) {
    try {
        main();
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }
}

module.exports = { updaterPlatformsForTarget, archiveName, buildManifest, unreadableBlockedResources };
