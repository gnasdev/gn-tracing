#!/usr/bin/env node
/**
 * Ensures player/ and worker/ package.json versions match the root product
 * version (extension SoT). Used by `npm run check` and the release workflow.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readVersion(relPath) {
  const full = path.join(root, relPath);
  const pkg = JSON.parse(fs.readFileSync(full, "utf-8"));
  if (typeof pkg.version !== "string" || !pkg.version.trim()) {
    throw new Error(`${relPath}: missing version`);
  }
  return pkg.version.trim();
}

const rootVersion = readVersion("package.json");
const playerVersion = readVersion("player/package.json");
const workerVersion = readVersion("worker/package.json");

const mismatches = [];
if (playerVersion !== rootVersion) {
  mismatches.push(`player/package.json version ${playerVersion} != root ${rootVersion}`);
}
if (workerVersion !== rootVersion) {
  mismatches.push(`worker/package.json version ${workerVersion} != root ${rootVersion}`);
}

if (mismatches.length > 0) {
  console.error("Product version mismatch:");
  for (const line of mismatches) {
    console.error(`  - ${line}`);
  }
  console.error(
    "Bump player/ and worker/ package.json together with root (chore(release)), or run the release bump script.",
  );
  process.exit(1);
}

console.log(`✓ Product version aligned: ${rootVersion} (root, player, worker)`);
