/**
 * Sync Script - Copy player assets from ../player/ to public/
 *
 * Pass --watch to keep running and re-sync whenever a source file changes,
 * so `task player:dev` never serves a stale copy of player.js/player.css.
 *
 * Watch mode compares a source mtime/size signature before copying. macOS
 * FSEvents (and Node `fs.watch`) often emit spurious change events while
 * mtime is unchanged; without the signature gate every event rewrote public/
 * and Vite rebuilt in a tight loop.
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

const PLAYER_FILES = ["player.css", "player.js"];
const SHARED_FILES = ["theme.css", "theme-init.js"];
const SHARED_ICON_FILES = ["icon.svg", "icon32.png"];

/** @type {string} */
let lastSourceSignature = "";

/**
 * @param {string} dir
 * @returns {string[]}
 */
function listFilesRecursive(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }
  /** @type {string[]} */
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

/**
 * Stable fingerprint of every source path runSync reads.
 * Spurious fs.watch events must not change this when content is untouched.
 * @returns {string}
 */
function getSourceSignature() {
  const paths = [
    ...PLAYER_FILES.map((file) => path.join(sourceDir, file)),
    ...SHARED_FILES.map((file) => path.join(sharedDir, file)),
    ...SHARED_ICON_FILES.map((file) => path.join(rootIconsDir, file)),
    ...listFilesRecursive(path.join(sourceDir, "icons")),
    ...listFilesRecursive(path.join(sourceDir, "vendor")),
  ];

  return paths
    .map((filePath) => {
      try {
        const stat = fs.statSync(filePath);
        return `${filePath}:${stat.mtimeMs}:${stat.size}`;
      } catch {
        return `${filePath}:missing`;
      }
    })
    .join("|");
}

/**
 * Copy only when bytes differ so identical re-syncs do not bump dest mtime
 * (which would force Vite HMR).
 * @param {string} src
 * @param {string} dest
 * @returns {boolean} true when dest was written
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
 * Recursively mirror a directory tree, skipping unchanged files.
 * @param {string} src absolute source directory
 * @param {string} dest absolute destination directory
 * @returns {{ files: number, written: number }}
 */
function copyDirRecursive(src, dest) {
  let files = 0;
  let written = 0;
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      const nested = copyDirRecursive(srcPath, destPath);
      files += nested.files;
      written += nested.written;
    } else {
      files += 1;
      if (copyFileIfChanged(srcPath, destPath)) {
        written += 1;
      }
    }
  }
  return { files, written };
}

/**
 * @param {{ force?: boolean }} [options]
 * @returns {boolean} true when a sync ran
 */
function runSync(options = {}) {
  const force = Boolean(options.force);
  const signature = getSourceSignature();
  if (!force && signature === lastSourceSignature) {
    return false;
  }

  console.log("🔄 Syncing player assets...");
  console.log("Source:", sourceDir);
  console.log("Target:", targetDir);

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  let copiedCount = 0;
  let writtenCount = 0;

  for (const file of PLAYER_FILES) {
    const src = path.join(sourceDir, file);
    const dest = path.join(targetDir, file);

    if (fs.existsSync(src)) {
      const wrote = copyFileIfChanged(src, dest);
      console.log(`  ${wrote ? "✓" : "·"} ${file}${wrote ? "" : " (unchanged)"}`);
      copiedCount++;
      if (wrote) writtenCount++;
    } else {
      console.error(`  ✗ Missing ${file}`);
    }
  }

  // Copy shared theme assets. The standalone page loads /theme.css from the same
  // design-system source as the extension, so a stale copy breaks state toggles
  // that rely on shared utility classes like `.hidden`.
  for (const file of SHARED_FILES) {
    const src = path.join(sharedDir, file);
    const dest = path.join(targetDir, file);

    if (fs.existsSync(src)) {
      const wrote = copyFileIfChanged(src, dest);
      console.log(`  ${wrote ? "✓" : "·"} ${file}${wrote ? "" : " (unchanged)"}`);
      copiedCount++;
      if (wrote) writtenCount++;
    } else {
      console.error(`  ✗ Missing shared ${file}`);
    }
  }

  // Copy icons directory
  const iconsSrc = path.join(sourceDir, "icons");
  const iconsDest = path.join(targetDir, "icons");

  if (fs.existsSync(iconsSrc)) {
    if (!fs.existsSync(iconsDest)) {
      fs.mkdirSync(iconsDest, { recursive: true });
    }

    let iconWritten = 0;
    const entries = fs.readdirSync(iconsSrc, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        continue;
      }
      const srcPath = path.join(iconsSrc, entry.name);
      const destPath = path.join(iconsDest, entry.name);
      if (copyFileIfChanged(srcPath, destPath)) {
        iconWritten++;
      }
    }
    console.log(`  ${iconWritten ? "✓" : "·"} icons/${iconWritten ? "" : " (unchanged)"}`);
    copiedCount++;
    writtenCount += iconWritten;
  } else {
    console.error("  ✗ Missing icons/");
  }

  for (const file of SHARED_ICON_FILES) {
    const src = path.join(rootIconsDir, file);
    const dest = path.join(iconsDest, file);

    if (fs.existsSync(src)) {
      if (!fs.existsSync(iconsDest)) {
        fs.mkdirSync(iconsDest, { recursive: true });
      }
      const wrote = copyFileIfChanged(src, dest);
      console.log(`  ${wrote ? "✓" : "·"} icons/${file}${wrote ? "" : " (unchanged)"}`);
      if (wrote) writtenCount++;
    } else {
      console.error(`  ✗ Missing shared icon ${file}`);
    }
  }

  // Copy vendored prebuilt bundles (luna-* UMD + CSS, license, version pins) so
  // the standalone player can load them via <link>/<script> before player.js.
  const vendorSrc = path.join(sourceDir, "vendor");
  const vendorDest = path.join(targetDir, "vendor");

  if (fs.existsSync(vendorSrc)) {
    const vendor = copyDirRecursive(vendorSrc, vendorDest);
    console.log(
      `  ${vendor.written ? "✓" : "·"} vendor/ (${vendor.files} files${vendor.written ? `, ${vendor.written} written` : ", unchanged"})`,
    );
    copiedCount++;
    writtenCount += vendor.written;
  } else {
    console.error("  ✗ Missing vendor/");
  }

  lastSourceSignature = signature;
  console.log(`✅ Synced ${copiedCount} items (${writtenCount} file(s) written)`);
  return true;
}

// Always sync once on start so public/ matches sources.
runSync({ force: true });

if (watchMode) {
  // Watch the specific known source paths individually rather than recursively
  // watching `player/` — recursive fs.watch is unsupported on Linux, and these
  // are the only paths runSync() actually reads from.
  // macOS FSEvents can deliver a change as several straggling notifications
  // (metadata + content, sometimes 100ms+ apart), so debounce generously
  // rather than re-syncing once per notification. Signature check still drops
  // no-op events after debounce.
  const debounced = (() => {
    let timer = null;
    return () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        runSync();
      }, 400);
    };
  })();

  const watchTargets = [
    path.join(sourceDir, "player.css"),
    path.join(sourceDir, "player.js"),
    path.join(sourceDir, "icons"),
    path.join(sourceDir, "vendor"),
    path.join(sharedDir, "theme.css"),
    path.join(sharedDir, "theme-init.js"),
    path.join(rootIconsDir, "icon.svg"),
    path.join(rootIconsDir, "icon32.png"),
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
