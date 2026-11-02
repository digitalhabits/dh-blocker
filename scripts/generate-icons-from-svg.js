/**
 * Generate all app icons from assets/reddblock-icon.svg
 * Run with: node scripts/generate-icons-from-svg.js
 */
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SVG_PATH = path.join(__dirname, '../assets/reddblock-icon.svg');
const ASSETS_DIR = path.join(__dirname, '../assets');
const ICONS_DIR = path.join(ASSETS_DIR, 'icons');
const SRC_SVG_PATH = path.join(__dirname, '../src/reddblock-icon.svg');
const BLOCKED_SVG_PATH = path.join(__dirname, '../src-tauri/blocked/reddblock-icon.svg');

const TAURI_ICONS_DIR = path.join(__dirname, '../src-tauri/icons');
const IOS_APPICON_DIR = path.join(
    __dirname,
    '../src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset',
);
// Must match the rounded-rect fill in assets/reddblock-icon.svg. iOS App Store
// rejects icons with an alpha channel, so we flatten onto this background.
const IOS_ICON_BG = { r: 247, g: 245, b: 240 };
// Icon sizes needed for various platforms
const ICON_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const ICO_SIZES = ICON_SIZES.filter((size) => size <= 256);

function windowsIconSvg() {
    const svg = fs.readFileSync(SVG_PATH, 'utf8');
    const background = '<rect width="1024" height="1024" rx="150" fill="#F7F5F0"/>';
    if (!svg.includes(background)) throw new Error('Windows icon: canonical background rectangle changed');
    const outline = svg.match(/<path d="([^"]+)" stroke="[^"]+"[^>]*\/>/);
    if (!outline) throw new Error('Windows icon: shield outline missing');
    // The shared SVG also has a rectangular backing behind the shield.
    // Clip the colour fills to the shield itself, then draw its full stroke
    // outside that clip so the outer half of the outline stays intact.
    return Buffer.from(svg.replace(background, '')
        .replace(/<rect width="633" height="791" transform="translate\(195 116\)" fill="#F7F5F0"\/>/, '')
        .replace(outline[0], '')
        .replace('</g>', `</g>${outline[0]}`)
        .replace(/<rect width="633" height="791" fill="white" transform="translate\(195 116\)"\/>/, `<path d="${outline[1]}"/>`));
}

async function renderWindowsIcoPng(svgBuffer, size) {
    return sharp(svgBuffer).resize(size, size).png().toBuffer();
}

function syncReddBlockIconCopies() {
    if (!fs.existsSync(SVG_PATH)) {
        console.error('SVG not found at:', SVG_PATH);
        process.exit(1);
    }

    fs.copyFileSync(SVG_PATH, SRC_SVG_PATH);
    console.log('✓ Synced src/reddblock-icon.svg');

    fs.mkdirSync(path.dirname(BLOCKED_SVG_PATH), { recursive: true });
    fs.copyFileSync(SVG_PATH, BLOCKED_SVG_PATH);
    console.log('✓ Synced src-tauri/blocked/reddblock-icon.svg');
}

function syncTauriBundleIcons() {
    if (!fs.existsSync(TAURI_ICONS_DIR)) {
        fs.mkdirSync(TAURI_ICONS_DIR, { recursive: true });
    }

    for (const size of ICON_SIZES) {
        const name = `${size}x${size}.png`;
        fs.copyFileSync(path.join(ICONS_DIR, name), path.join(TAURI_ICONS_DIR, name));
    }

    for (const name of ['icon.icns', 'icon.ico']) {
        fs.copyFileSync(path.join(ICONS_DIR, name), path.join(TAURI_ICONS_DIR, name));
    }

    fs.copyFileSync(path.join(ASSETS_DIR, 'icon.png'), path.join(TAURI_ICONS_DIR, 'icon.png'));

    // Tauri macOS bundle also references these sizes.
    fs.copyFileSync(path.join(ICONS_DIR, '128x128.png'), path.join(TAURI_ICONS_DIR, '128x128@2x.png'));
    console.log('✓ Synced src-tauri/icons/');
}

async function generatePngIcons() {
    console.log('=== Generating PNG icons from SVG ===');

    if (!fs.existsSync(SVG_PATH)) {
        console.error('SVG not found at:', SVG_PATH);
        process.exit(1);
    }

    // Ensure icons directory exists
    if (!fs.existsSync(ICONS_DIR)) {
        fs.mkdirSync(ICONS_DIR, { recursive: true });
    }

    const svgBuffer = fs.readFileSync(SVG_PATH);

    // Generate each size
    for (const size of ICON_SIZES) {
        const outputPath = path.join(ICONS_DIR, `${size}x${size}.png`);
        try {
            await sharp(svgBuffer)
                .resize(size, size, { fit: 'contain' })
                .png()
                .toFile(outputPath);
            console.log(`✓ Generated ${size}x${size}.png`);
        } catch (err) {
            console.error(`✗ Error generating ${size}x${size}.png:`, err);
        }
    }

    // Also generate the main icon.png (1024x1024) in assets root
    const mainIconPath = path.join(ASSETS_DIR, 'icon.png');
    try {
        await sharp(svgBuffer)
            .resize(1024, 1024, { fit: 'contain' })
            .png()
            .toFile(mainIconPath);
        console.log('✓ Generated assets/icon.png (1024x1024)');
    } catch (err) {
        console.error('✗ Error generating icon.png:', err);
    }

    // Generate src/images/icon.png as well
    const srcImagesDir = path.join(__dirname, '../src/images');
    if (!fs.existsSync(srcImagesDir)) {
        fs.mkdirSync(srcImagesDir, { recursive: true });
    }
    const srcIconPath = path.join(srcImagesDir, 'icon.png');
    try {
        await sharp(svgBuffer)
            .resize(256, 256, { fit: 'contain' })
            .png()
            .toFile(srcIconPath);
        console.log('✓ Generated src/images/icon.png (256x256)');
    } catch (err) {
        console.error('✗ Error generating src/images/icon.png:', err);
    }
}

async function generateIco() {
    console.log('\n=== Generating ICO file ===');

    if (!fs.existsSync(SVG_PATH)) {
        console.error('SVG not found, cannot generate ICO');
        return;
    }

    try {
        // Use dynamic import for ES module
        const pngToIcoModule = await import('png-to-ico');
        const pngToIco = pngToIcoModule.default;
        const svgBuffer = windowsIconSvg();
        await sharp(svgBuffer).png().toFile(path.join(ICONS_DIR, 'windows-1024.png'));

        // Render each frame directly from the transparent Windows artwork.
        const icoPngBuffers = await Promise.all(
            ICO_SIZES.map((size) => renderWindowsIcoPng(svgBuffer, size)),
        );

        const icoBuffer = await pngToIco(icoPngBuffers);

        // Write to both locations
        fs.writeFileSync(path.join(ICONS_DIR, 'icon.ico'), icoBuffer);
        fs.writeFileSync(path.join(ASSETS_DIR, 'icon.ico'), icoBuffer);
        fs.writeFileSync(path.join(TAURI_ICONS_DIR, 'icon.ico'), icoBuffer);

        console.log('✓ Generated icon.ico');
    } catch (err) {
        console.error('✗ Error generating ICO:', err);
        throw err;
    }
}

async function renderIosAppIconPng(svgBuffer, pixelSize) {
    return sharp(svgBuffer)
        .resize(pixelSize, pixelSize, { fit: 'contain', background: IOS_ICON_BG })
        .flatten({ background: IOS_ICON_BG })
        .png()
        .toBuffer();
}

async function generateIosAppIcons() {
    console.log('\n=== Generating iOS AppIcon.appiconset ===');

    const contentsPath = path.join(IOS_APPICON_DIR, 'Contents.json');
    if (!fs.existsSync(contentsPath)) {
        console.warn('iOS AppIcon catalog not found, skipping:', contentsPath);
        return;
    }

    const contents = JSON.parse(fs.readFileSync(contentsPath, 'utf8'));
    const svgBuffer = fs.readFileSync(SVG_PATH);

    for (const image of contents.images) {
        if (!image.filename) {
            continue;
        }

        const baseSize = parseFloat(image.size);
        const scale = parseInt(image.scale, 10) || 1;
        const pixelSize = Math.round(baseSize * scale);
        const outputPath = path.join(IOS_APPICON_DIR, image.filename);

        try {
            const pngBuffer = await renderIosAppIconPng(svgBuffer, pixelSize);
            fs.writeFileSync(outputPath, pngBuffer);
            console.log(`✓ Generated iOS ${image.filename} (${pixelSize}x${pixelSize})`);
        } catch (err) {
            console.error(`✗ Error generating iOS ${image.filename}:`, err);
        }
    }

    console.log('✓ Synced src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset/');
}

async function generateIcns() {
    console.log('\n=== Generating ICNS file (macOS) ===');

    // electron-icon-builder can generate ICNS from PNG
    const source1024 = path.join(ICONS_DIR, '1024x1024.png');

    if (!fs.existsSync(source1024)) {
        console.error('1024x1024.png not found, cannot generate ICNS');
        return;
    }

    try {
        // Use iconutil on macOS to create .icns
        const iconsetDir = path.join(ICONS_DIR, 'icon.iconset');

        // Create iconset directory
        if (!fs.existsSync(iconsetDir)) {
            fs.mkdirSync(iconsetDir);
        }

        // Generate all required sizes for iconset
        const icnsRequiredSizes = [
            { size: 16, scale: 1, name: 'icon_16x16.png' },
            { size: 16, scale: 2, name: 'icon_16x16@2x.png' },
            { size: 32, scale: 1, name: 'icon_32x32.png' },
            { size: 32, scale: 2, name: 'icon_32x32@2x.png' },
            { size: 128, scale: 1, name: 'icon_128x128.png' },
            { size: 128, scale: 2, name: 'icon_128x128@2x.png' },
            { size: 256, scale: 1, name: 'icon_256x256.png' },
            { size: 256, scale: 2, name: 'icon_256x256@2x.png' },
            { size: 512, scale: 1, name: 'icon_512x512.png' },
            { size: 512, scale: 2, name: 'icon_512x512@2x.png' },
        ];

        const svgBuffer = fs.readFileSync(SVG_PATH);

        for (const entry of icnsRequiredSizes) {
            const actualSize = entry.size * entry.scale;
            await sharp(svgBuffer)
                .resize(actualSize, actualSize, { fit: 'contain' })
                .png()
                .toFile(path.join(iconsetDir, entry.name));
        }

        // Run iconutil to create .icns
        execSync(`iconutil -c icns "${iconsetDir}" -o "${path.join(ICONS_DIR, 'icon.icns')}"`);

        // Clean up iconset directory
        fs.rmSync(iconsetDir, { recursive: true });

        console.log('✓ Generated icon.icns');
    } catch (err) {
        console.error('✗ Error generating ICNS:', err);
        console.error('  (This is only possible on macOS)');
    }
}

async function main() {
    console.log('Starting icon generation from:', SVG_PATH);
    console.log('');

    if (process.argv.includes('--windows-only')) {
        await generateIco();
        return;
    }

    syncReddBlockIconCopies();
    console.log('');

    await generatePngIcons();
    await generateIco();
    await generateIcns();
    await generateIosAppIcons();
    syncTauriBundleIcons();

    console.log('\n=== Icon generation complete ===');
    console.log('');
    console.log('Now run the store assets generator:');
    console.log('  node scripts/generate-store-assets.js');
}

main().catch(console.error);
