/**
 * Sync Script - Copy player assets from ../player/ to public/
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourceDir = path.resolve(__dirname, '../../player');
const targetDir = path.resolve(__dirname, '../public');

console.log('🔄 Syncing player assets...');
console.log('Source:', sourceDir);
console.log('Target:', targetDir);

// Ensure target directory exists
if (!fs.existsSync(targetDir)) {
  fs.mkdirSync(targetDir, { recursive: true });
}

// Copy main files
const filesToCopy = ['player.css', 'player.js'];
let copiedCount = 0;

for (const file of filesToCopy) {
  const src = path.join(sourceDir, file);
  const dest = path.join(targetDir, file);

  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    console.log(`  ✓ ${file}`);
    copiedCount++;
  } else {
    console.error(`  ✗ Missing ${file}`);
  }
}

// Copy icons directory
const iconsSrc = path.join(sourceDir, 'icons');
const iconsDest = path.join(targetDir, 'icons');
const sharedIconsSrc = path.resolve(__dirname, '../../icons');
const sharedIconFiles = ['icon.svg', 'icon32.png'];

if (fs.existsSync(iconsSrc)) {
  if (!fs.existsSync(iconsDest)) {
    fs.mkdirSync(iconsDest, { recursive: true });
  }

  const entries = fs.readdirSync(iconsSrc, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(iconsSrc, entry.name);
    const destPath = path.join(iconsDest, entry.name);
    fs.copyFileSync(srcPath, destPath);
  }
  console.log('  ✓ icons/');
  copiedCount++;
} else {
  console.error('  ✗ Missing icons/');
}

for (const file of sharedIconFiles) {
  const src = path.join(sharedIconsSrc, file);
  const dest = path.join(iconsDest, file);

  if (fs.existsSync(src)) {
    if (!fs.existsSync(iconsDest)) {
      fs.mkdirSync(iconsDest, { recursive: true });
    }
    fs.copyFileSync(src, dest);
    console.log(`  ✓ icons/${file}`);
  } else {
    console.error(`  ✗ Missing shared icon ${file}`);
  }
}

console.log(`\\n✅ Synced ${copiedCount} items`);
