/**
 * Bundle `player/core-entry.ts` as a browser IIFE for `player.js`.
 *
 * The player is unbundled JavaScript, so a global (`window.gnCore`) is how typed
 * shared code reaches it. Adding a shared module means exporting it from
 * `player/core-entry.ts` rather than a new build script.
 *
 * Usage: node scripts/build-player-core-vendor.mjs
 * Or: npm run vendor:player-core
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "player/core-entry.ts");
const outDir = path.join(root, "player/public/vendor/gn-core");
const outFile = path.join(outDir, "gn-core.iife.js");

if (!fs.existsSync(entry)) {
  console.error("Missing player/core-entry.ts");
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });

await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: "iife",
  globalName: "gnCore",
  platform: "browser",
  target: "chrome120",
  outfile: outFile,
  logLevel: "info",
});

console.log(`✓ player core bundle → ${path.relative(root, outFile)}`);
