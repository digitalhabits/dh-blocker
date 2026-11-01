// @vitest-environment node
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import sharp from 'sharp';

const icon = readFileSync(new URL('../../assets/icons/icon.ico', import.meta.url));
test('every Windows ICO frame has a transparent surround and an opaque shield', () => {
    expect(icon.readUInt16LE(4)).toBe(7);
    for (let i = 0; i < icon.readUInt16LE(4); i++) {
        const entry = 6 + i * 16;
        const width = icon[entry] || 256;
        const offset = icon.readUInt32LE(entry + 12);
        expect(icon.readUInt32LE(offset)).toBe(40); // 32-bit DIB frame
        expect(icon.readUInt16LE(offset + 14)).toBe(32);
        const alpha = (x, y) => icon[offset + 40 + ((width - 1 - y) * width + x) * 4 + 3];
        expect(alpha(Math.floor(width / 10), Math.floor(width / 2))).toBe(0);
        if (width >= 32) expect(alpha(Math.floor(width / 4), Math.floor(width / 8))).toBe(0);
        expect(alpha(Math.floor(width / 2), Math.floor(width / 2))).toBe(255);
    }
});
test('all shipped ICO copies match', () => {
    for (const path of ['../../assets/icon.ico', '../../src-tauri/icons/icon.ico']) {
        expect(readFileSync(new URL(path, import.meta.url)).equals(icon)).toBe(true);
    }
});
test('MSIX source is transparent while the shared platform artwork stays opaque', async () => {
    for (const [file, expected] of [['windows-1024.png', 0], ['1024x1024.png', 255]]) {
        const {data, info} = await sharp(readFileSync(new URL('../../assets/icons/' + file, import.meta.url))).ensureAlpha().raw().toBuffer({resolveWithObject:true});
        expect(data[(512 * info.width + 100) * 4 + 3]).toBe(expected);
        expect(data[(160 * info.width + 250) * 4 + 3]).toBe(expected);
    }
});
