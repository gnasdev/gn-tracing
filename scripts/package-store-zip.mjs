/**
 * Build gn-tracing-store.zip from dist/ for Chrome Web Store upload.
 *
 * Chrome Web Store rejects packages whose manifest includes a "key" field.
 * Local/unpacked builds keep "key" so the extension ID stays stable; the Store
 * zip strips it before packaging.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const distDir = path.join(root, "dist");
const outZip = path.join(root, "gn-tracing-store.zip");
const manifestPath = path.join(distDir, "manifest.json");

function fail(message) {
  console.error(`Store zip failed: ${message}`);
  process.exit(1);
}

if (!fs.existsSync(manifestPath)) {
  fail("dist/manifest.json is missing. Run task dist or task store:check first.");
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const hadKey = Object.hasOwn(manifest, "key");
delete manifest.key;

const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "gn-tracing-store-"));
try {
  fs.cpSync(distDir, stagingDir, { recursive: true });
  fs.writeFileSync(
    path.join(stagingDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  if (fs.existsSync(outZip)) {
    fs.unlinkSync(outZip);
  }

  execFileSync("zip", ["-r", outZip, "."], {
    cwd: stagingDir,
    stdio: "inherit",
  });
} finally {
  fs.rmSync(stagingDir, { recursive: true, force: true });
}

// Verify the packaged manifest has no key and parses cleanly.
const listed = execFileSync("unzip", ["-p", outZip, "manifest.json"], {
  encoding: "utf8",
});
const packaged = JSON.parse(listed);
if (Object.hasOwn(packaged, "key")) {
  fail("packaged manifest still contains key; refusing to keep the zip.");
}

console.log(
  `Store zip ready: ${path.relative(root, outZip)}` +
    (hadKey ? " (stripped manifest.key for Chrome Web Store)" : ""),
);
