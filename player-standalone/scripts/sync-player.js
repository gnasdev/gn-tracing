/**
 * Sync root shared theme/icons into player-standalone/public.
 *
 * Player runtime (player.js / player.css / vendor) lives in public/ directly —
 * no mirror from a sibling `player/` tree. This script only keeps design-system
 * assets shared with the extension (`shared/theme*`, brand icons) up to date.
 *
 * Pass --watch to re-sync when those shared sources change.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const targetDir = path.resolve(__dirname, "../public");
const sharedDir = path.resolve(__dirname, "../../shared");
const rootIconsDir = path.resolve(__dirname, "../../icons");
const watchMode = process.argv.includes("--watch");

const SHARED_FILES = ["theme.css", "theme-init.js"];
const SHARED_ICON_FILES = ["icon.svg", "icon32.png"];

/** @type {string} */
let lastSourceSignature = "";

/**
 * @param {string} filePath
 * @returns {string}
 */
function fileSignature(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return `${filePath}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return `${filePath}:missing`;
  }
}

/**
 * @returns {string}
 */
function getSourceSignature() {
  return [
    ...SHARED_FILES.map((file) => fileSignature(path.join(sharedDir, file))),
    ...SHARED_ICON_FILES.map((file) => fileSignature(path.join(rootIconsDir, file))),
  ].join("|");
}

/**
 * @param {string} src
 * @param {string} dest
 * @returns {boolean}
 */
function copyFileIfChanged(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) {
    const srcStat = fs.statSync(src);
    const destStat = fs.statSync(dest);
    if (srcStat.size === destStat.size) {
      const srcBuf = fs.readFileSync(src);
      const destBuf = fs.readFileSync(dest);
      if (srcBuf.equals(destBuf)) {
        return false;
      }
    }
  }
  fs.copyFileSync(src, dest);
  return true;
}

/**
 * @param {{ force?: boolean }} [options]
 * @returns {boolean}
 */
function runSync(options = {}) {
  const force = Boolean(options.force);
  const signature = getSourceSignature();
  if (!force && signature === lastSourceSignature) {
    return false;
  }

  console.log("🔄 Syncing shared theme/icons into player public/...");
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  let writtenCount = 0;

  for (const file of SHARED_FILES) {
    const src = path.join(sharedDir, file);
    const dest = path.join(targetDir, file);
    if (!fs.existsSync(src)) {
      console.error(`  ✗ Missing shared ${file}`);
      continue;
    }
    const wrote = copyFileIfChanged(src, dest);
    console.log(`  ${wrote ? "✓" : "·"} ${file}${wrote ? "" : " (unchanged)"}`);
    if (wrote) writtenCount += 1;
  }

  for (const file of SHARED_ICON_FILES) {
    const src = path.join(rootIconsDir, file);
    const dest = path.join(targetDir, "icons", file);
    if (!fs.existsSync(src)) {
      console.error(`  ✗ Missing icon ${file}`);
      continue;
    }
    const wrote = copyFileIfChanged(src, dest);
    console.log(`  ${wrote ? "✓" : "·"} icons/${file}${wrote ? "" : " (unchanged)"}`);
    if (wrote) writtenCount += 1;
  }

  lastSourceSignature = signature;
  console.log(writtenCount > 0 ? `✓ Synced (${writtenCount} written)` : "· Nothing changed");
  return true;
}

runSync({ force: true });

if (watchMode) {
  console.log("Watching shared theme/icons...");
  const watchPaths = [sharedDir, rootIconsDir];
  for (const dir of watchPaths) {
    if (!fs.existsSync(dir)) continue;
    fs.watch(dir, { recursive: true }, () => {
      try {
        runSync();
      } catch (error) {
        console.error(error);
      }
    });
  }
}
