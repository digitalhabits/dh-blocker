import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
    archiveName,
    buildManifest,
    unreadableBlockedResources,
    updaterPlatformsForTarget,
} from '../../scripts/stage-macos-updater.js';

// scripts/stage-macos-updater.js writes the manifest; app_update.rs fetches it
// by a URL it builds itself. Nothing else ties the two together.

describe('macos-update.json', () => {
    test('a universal archive serves both architectures from one URL', () => {
        const { suffix, platforms } = updaterPlatformsForTarget('universal-apple-darwin');
        const archive = archiveName('3.9.1', suffix);
        const manifest = buildManifest({
            version: '3.9.1', archive, signature: 'sig', platforms, pubDate: '2026-09-30T00:00:00Z',
        });
        expect(Object.keys(manifest.platforms).sort()).toEqual(['darwin-aarch64', 'darwin-x86_64']);
        expect(manifest.platforms['darwin-aarch64']).toEqual({
            url: 'https://github.com/digitalhabits/dh-blocker/releases/download/v3.9.1/Digital-Habits-Blocker-3.9.1-universal.app.tar.gz',
            signature: 'sig',
        });
    });

    test('a single-arch build only claims its own architecture', () => {
        expect(updaterPlatformsForTarget('aarch64-apple-darwin').platforms).toEqual(['darwin-aarch64']);
        expect(() => updaterPlatformsForTarget('x86_64-pc-windows-msvc')).toThrow();
    });

    test('the app fetches the manifest name and release path the script writes', () => {
        const rust = readFileSync('src-tauri/src/commands/app_update.rs', 'utf8');
        const script = readFileSync('scripts/stage-macos-updater.js', 'utf8');
        const releases = 'https://github.com/digitalhabits/dh-blocker/releases/download';
        expect(rust).toContain(`const MACOS_UPDATE_MANIFEST: &str = "macos-update.json";`);
        expect(script).toContain(`const MANIFEST_NAME = 'macos-update.json';`);
        expect(rust).toContain(`const GITHUB_RELEASES: &str = "${releases}";`);
        expect(script).toContain(`const GITHUB_RELEASES = '${releases}';`);
    });
});

describe('block page permissions in the archive', () => {
    const listing = [
        'drwxr-xr-x  0 ci staff     0 Sep 30 12:00 Digital Habits Blocker.app/Contents/Resources/blocked/',
        '-rw-r--r--  0 ci staff  1024 Sep 30 12:00 Digital Habits Blocker.app/Contents/Resources/blocked/blocked.html',
        '-rw-------  0 ci staff  2048 Sep 30 12:00 Digital Habits Blocker.app/Contents/Resources/blocked/reddblock-icon.svg',
        '-rw-------  0 ci staff  2048 Sep 30 12:00 Digital Habits Blocker.app/Contents/Resources/icon.icns',
    ].join('\n');

    test('flags only block-page files the user cannot read', () => {
        const bad = unreadableBlockedResources(listing);
        expect(bad).toHaveLength(1);
        expect(bad[0]).toContain('reddblock-icon.svg');
    });
});
