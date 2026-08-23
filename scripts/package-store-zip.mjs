/**
 * Build store zip from dist/<browser>/ for Chrome Web Store, Edge/Opera Add-ons, AMO,
 * or as the source zip for Apple's Safari Web Extension Packager / safari-web-extension-converter.
 *
 * Chrome Web Store rejects packages whose manifest includes a "key" field.
 * Local/unpacked builds keep "key" so the extension ID stays stable; the Store
 * zip strips it before packaging.
 *
 * Usage:
 *   node scripts/package-store-zip.mjs
 *   node scripts/package-store-zip.mjs --browser chrome
 *   node scripts/package-store-zip.mjs --browser edge
 *   node scripts/package-store-zip.mjs --browser opera
 *   node scripts/package-store-zip.mjs --browser firefox
 *   node scripts/package-store-zip.mjs --browser safari
 *   node scripts/package-store-zip.mjs --browser safari-ios
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function getCliArgValue(flagName) {
  for (let i = 0; i < process.argv.length; i += 1) {
    const arg = process.argv[i];
    if (arg === flagName) {
      return process.argv[i + 1];
    }
    if (arg.startsWith(`${flagName}=`)) {
      return arg.slice(flagName.length + 1);
    }
  }
  return undefined;
}

const SUPPORTED_BROWSERS = ["chrome", "edge", "opera", "firefox", "safari", "safari-ios"];
const browser = String(getCliArgValue("--browser") || "chrome")
  .trim()
  .toLowerCase();
if (!SUPPORTED_BROWSERS.includes(browser)) {
  fail(`unsupported --browser ${browser} (use ${SUPPORTED_BROWSERS.join(", ")})`);
}

const distDir = path.join(root, "dist", browser);
const outZip =
  browser === "chrome"
    ? path.join(root, "gn-tracing-store.zip")
    : path.join(root, `gn-tracing-${browser}-store.zip`);
const manifestPath = path.join(distDir, "manifest.json");

function fail(message) {
  console.error(`Store zip failed: ${message}`);
  process.exit(1);
}

if (!fs.existsSync(manifestPath)) {
  fail(
    `dist/${browser}/manifest.json is missing. Run task dist --browser ${browser} or task store:check first.`,
  );
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
    (hadKey ? " (stripped manifest.key for store upload)" : "") +
    ` [${browser}]`,
);
