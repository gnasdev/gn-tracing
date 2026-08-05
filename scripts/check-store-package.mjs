/**
 * Validate dist/<browser>/ before store upload.
 *
 * Usage:
 *   node scripts/check-store-package.mjs
 *   node scripts/check-store-package.mjs --browser chrome|edge|firefox
 */

import fs from "node:fs";
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

const browser = String(getCliArgValue("--browser") || "chrome")
  .trim()
  .toLowerCase();
if (!["chrome", "edge", "firefox"].includes(browser)) {
  fail(`unsupported --browser ${browser}`);
}

const distDir = path.join(root, "dist", browser);
const manifestPath = path.join(distDir, "manifest.json");

function fail(message) {
  console.error(`Store package check failed: ${message}`);
  process.exit(1);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`could not read ${path.relative(root, filePath)}: ${error.message}`);
  }
}

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(entryPath) : [entryPath];
  });
}

if (!fs.existsSync(manifestPath)) {
  fail(`dist/${browser}/manifest.json is missing. Run task dist --browser ${browser} first.`);
}

const manifest = readJson(manifestPath);
const manifestText = fs.readFileSync(manifestPath, "utf8");
if (manifestText.includes("{{")) {
  fail("manifest still contains template placeholders.");
}

if (manifest.manifest_version !== 3) {
  fail("manifest_version must be 3.");
}

if (browser === "firefox") {
  if (manifest.minimum_chrome_version) {
    fail("Firefox package must not set minimum_chrome_version.");
  }
  if (!manifest.browser_specific_settings?.gecko?.id) {
    fail("Firefox package requires browser_specific_settings.gecko.id.");
  }
  for (const permission of ["tabCapture", "offscreen", "debugger"]) {
    if (manifest.permissions?.includes(permission)) {
      fail(`Firefox package must not include Chromium-only permission: ${permission}`);
    }
  }
  if (manifest.oauth2) {
    fail("Firefox package must not include oauth2 (use launchWebAuthFlow).");
  }
  if (manifest.key) {
    fail("Firefox package must not include key.");
  }
} else if (!manifest.minimum_chrome_version) {
  fail("minimum_chrome_version is required for Chromium store package clarity.");
}

// Fixed multi-cloud hosts (must match manifest.template.json host_permissions
// minus optional token-proxy origins injected at build time).
const fixedHostPermissions = new Set([
  "https://oauth2.googleapis.com/",
  "https://www.googleapis.com/",
  "https://api.dropboxapi.com/",
  "https://content.dropboxapi.com/",
  "https://www.dropbox.com/",
  "https://dl.dropboxusercontent.com/",
]);
const MAX_TOKEN_PROXY_ORIGINS = 2;

const hostPermissions = Array.isArray(manifest.host_permissions) ? manifest.host_permissions : [];
const extraHostPermissions = hostPermissions.filter(
  (permission) => !fixedHostPermissions.has(permission),
);

if (extraHostPermissions.length > MAX_TOKEN_PROXY_ORIGINS) {
  fail(
    `unexpected host_permissions found: ${extraHostPermissions.join(", ")} ` +
      `(at most ${MAX_TOKEN_PROXY_ORIGINS} OAuth token proxy origins beyond fixed multi-cloud hosts)`,
  );
}

for (const proxyPermission of extraHostPermissions) {
  try {
    const proxyUrl = new URL(proxyPermission);
    if (proxyUrl.protocol !== "https:" || proxyPermission !== `${proxyUrl.origin}/`) {
      fail(
        `OAuth token proxy host_permission must be an https origin with trailing slash, got: ${proxyPermission}`,
      );
    }
  } catch {
    fail(`invalid OAuth token proxy host_permission: ${proxyPermission}`);
  }
}

const missingFixedHosts = [...fixedHostPermissions].filter(
  (permission) => !hostPermissions.includes(permission),
);
if (missingFixedHosts.length > 0) {
  fail(`required host_permissions missing: ${missingFixedHosts.join(", ")}`);
}

const chromiumPermissions = [
  "tabCapture",
  "offscreen",
  "debugger",
  "activeTab",
  "storage",
  "alarms",
  "identity",
];
const firefoxPermissions = ["activeTab", "storage", "alarms", "identity", "scripting", "tabs"];
const requiredPermissions = browser === "firefox" ? firefoxPermissions : chromiumPermissions;

for (const permission of requiredPermissions) {
  if (!manifest.permissions?.includes(permission)) {
    fail(`required permission ${permission} is missing.`);
  }
}

const backgroundRel =
  manifest.background?.service_worker ||
  (Array.isArray(manifest.background?.scripts) ? manifest.background.scripts[0] : "") ||
  "";
const backgroundPath = path.join(distDir, backgroundRel);
if (!backgroundRel || !fs.existsSync(backgroundPath)) {
  fail("background service worker / scripts path does not exist.");
}
if (browser === "firefox") {
  if (manifest.background?.service_worker) {
    fail("Firefox package must use background.scripts (service_worker is disabled on Firefox).");
  }
  if (!Array.isArray(manifest.background?.scripts) || manifest.background.scripts.length === 0) {
    fail("Firefox package requires background.scripts.");
  }
}

const popupPath = path.join(distDir, manifest.action?.default_popup || "");
if (!fs.existsSync(popupPath)) {
  fail("default popup path does not exist.");
}

if (browser === "firefox") {
  for (const rel of [
    "content/in-page-capture-main.js",
    "content/in-page-capture-bridge.js",
    "offscreen/offscreen.js",
  ]) {
    if (!fs.existsSync(path.join(distDir, rel))) {
      fail(`Firefox package missing required asset: ${rel}`);
    }
  }
}

const files = walk(distDir);
for (const file of files) {
  const rel = path.relative(distDir, file);
  const relPosix = rel.split(path.sep).join("/");
  if (relPosix === "player" || relPosix.startsWith("player/")) {
    fail(`extension store package must not include player assets: ${rel}`);
  }
  if (file.endsWith(".map")) {
    fail(`production artifact contains source map: ${rel}`);
  }

  if (!/\.(js|html)$/i.test(file)) {
    continue;
  }

  const content = fs.readFileSync(file, "utf8");
  if (/\beval\s*\(/.test(content)) {
    fail(`eval() found in ${rel}`);
  }
  if (/new\s+Function\s*\(/.test(content)) {
    fail(`new Function() found in ${rel}`);
  }
  if (file.endsWith(".html") && /<script[^>]+src=["']https?:\/\//i.test(content)) {
    fail(`remote script tag found in ${rel}`);
  }
}

console.log(`Store package check passed (${browser}).`);
