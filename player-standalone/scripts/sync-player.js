/**
 * Sync Script - Copy player assets from ../player/ to public/
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourceDir = path.resolve(__dirname, "../../player");
const targetDir = path.resolve(__dirname, "../public");

/**
 * Recursively copy a directory tree. Used to mirror vendored prebuilt assets
 * (e.g. `player/vendor/luna/`) into the standalone player's public dir so the
 * UMD bundles can be served alongside `player.js`.
 * @param {string} src absolute source directory
 * @param {string} dest absolute destination directory
 * @returns {number} number of files copied
 */
function copyDirRecursive(src, dest) {
  let count = 0;
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      count += copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
      count++;
    }
  }
  return count;
}

console.log("🔄 Syncing player assets...");
console.log("Source:", sourceDir);
console.log("Target:", targetDir);

// Ensure target directory exists
if (!fs.existsSync(targetDir)) {
  fs.mkdirSync(targetDir, { recursive: true });
}

// Copy main files
const filesToCopy = ["player.css", "player.js"];
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

// Copy shared theme assets. The standalone page loads /theme.css from the same
// design-system source as the extension, so a stale copy breaks state toggles
// that rely on shared utility classes like `.hidden`.
const sharedDir = path.resolve(__dirname, "../../shared");
const sharedFilesToCopy = ["theme.css", "theme-init.js"];

for (const file of sharedFilesToCopy) {
  const src = path.join(sharedDir, file);
  const dest = path.join(targetDir, file);

  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    console.log(`  ✓ ${file}`);
    copiedCount++;
  } else {
    console.error(`  ✗ Missing shared ${file}`);
  }
}

// Copy icons directory
const iconsSrc = path.join(sourceDir, "icons");
const iconsDest = path.join(targetDir, "icons");
const sharedIconsSrc = path.resolve(__dirname, "../../icons");
const sharedIconFiles = ["icon.svg", "icon32.png"];

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
  console.log("  ✓ icons/");
  copiedCount++;
} else {
  console.error("  ✗ Missing icons/");
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

// Copy vendored prebuilt bundles (luna-* UMD + CSS, license, version pins) so
// the standalone player can load them via <link>/<script> before player.js.
const vendorSrc = path.join(sourceDir, "vendor");
const vendorDest = path.join(targetDir, "vendor");

if (fs.existsSync(vendorSrc)) {
  const vendorCount = copyDirRecursive(vendorSrc, vendorDest);
  console.log(`  ✓ vendor/ (${vendorCount} files)`);
  copiedCount++;
} else {
  console.error("  ✗ Missing vendor/");
}

console.log(`\\n✅ Synced ${copiedCount} items`);
