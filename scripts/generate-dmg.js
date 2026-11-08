const sharp = require('sharp');
const path = require('path');

const width = 600;
const height = 400;

// ReDD Blocker theme gradient: #667eea to #764ba2
const svgImage = `
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#667eea;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#764ba2;stop-opacity:1" />
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="rgba(0,0,0,0.3)" />
    </filter>
  </defs>
  
  <!-- Background -->
  <rect width="${width}" height="${height}" fill="url(#grad)" />
  
  <!-- Title -->
  <text x="50%" y="60" text-anchor="middle" font-family="sans-serif" font-weight="bold" font-size="32" fill="white" filter="url(#shadow)">
    Install Digital Habits Blocker
  </text>
  
  <!-- Arrow -->
  <path d="M 240 200 L 360 200 M 340 180 L 360 200 L 340 220" stroke="white" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity="0.8" filter="url(#shadow)" />
  
  <!-- Icon Placeholders (Visual guide only, not part of final UI) -->
  <!-- 
  <circle cx="150" cy="200" r="50" fill="rgba(255,255,255,0.2)" />
  <circle cx="450" cy="200" r="50" fill="rgba(255,255,255,0.2)" />
  -->
  
  <!-- Instruction Text -->
  <text x="50%" y="340" text-anchor="middle" font-family="sans-serif" font-size="16" fill="white" opacity="0.9" filter="url(#shadow)">
    Drag Digital Habits Blocker to the Applications folder
  </text>
</svg>
`;

async function generate() {
    const assetsDir = path.join(__dirname, '../assets');
    const outputPath = path.join(assetsDir, 'dmg-background.png');

    try {
        await sharp(Buffer.from(svgImage))
            .png()
            .toFile(outputPath);
        console.log(`Generated DMG background at ${outputPath}`);
    } catch (err) {
        console.error('Error generating image:', err);
    }
}

generate();
