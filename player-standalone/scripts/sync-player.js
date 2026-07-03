/**
 * Sync Script - Copy player assets from ../player/ to public/
 *
 * Pass --watch to keep running and re-sync whenever a source file changes,
 * so `task player:dev` never serves a stale copy of player.js/player.css.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourceDir = path.resolve(__dirname, "../../player");
const targetDir = path.resolve(__dirname, "../public");
const sharedDir = path.resolve(__dirname, "../../shared");
const rootIconsDir = path.resolve(__dirname, "../../icons");
const watchMode = process.argv.includes("--watch");

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

function runSync() {
  console.log("🔄 Syncing player assets...");
  console.log("Source:", sourceDir);
  console.log("Target:", targetDir);

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  let copiedCount = 0;

  const filesToCopy = ["player.css", "player.js"];
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
    const src = path.join(rootIconsDir, file);
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

  console.log(`✅ Synced ${copiedCount} items`);
}

runSync();

if (watchMode) {
  // Watch the specific known source paths individually rather than recursively
  // watching `player/` — recursive fs.watch is unsupported on Linux, and these
  // are the only paths runSync() actually reads from.
  // macOS FSEvents can deliver a change as several straggling notifications
  // (metadata + content, sometimes 100ms+ apart), so debounce generously
  // rather than re-syncing once per notification.
  const debounced = (() => {
    let timer = null;
    return () => {
      clearTimeout(timer);
      timer = setTimeout(runSync, 300);
    };
  })();

  const watchTargets = [
    path.join(sourceDir, "player.css"),
    path.join(sourceDir, "player.js"),
    path.join(sourceDir, "icons"),
    path.join(sourceDir, "vendor"),
    path.join(sharedDir, "theme.css"),
    path.join(sharedDir, "theme-init.js"),
  ];

  for (const target of watchTargets) {
    if (!fs.existsSync(target)) {
      continue;
    }
    const isDirectory = fs.statSync(target).isDirectory();
    if (isDirectory) {
      try {
        fs.watch(target, { recursive: true }, debounced);
        continue;
      } catch {
        // recursive watch unsupported on this platform (e.g. Linux) — fall
        // back to a non-recursive watch on the directory itself.
      }
    }
    fs.watch(target, debounced);
  }

  console.log("👀 Watching player/ for changes (Ctrl+C to stop)...");
}
