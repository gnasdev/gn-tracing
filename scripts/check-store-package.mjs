/**
 * Validate dist/<browser>/ before store upload.
 *
 * Usage:
 *   node scripts/check-store-package.mjs
 *   node scripts/check-store-package.mjs --browser chrome|edge|opera|firefox|safari|safari-ios
 *
 * For safari/safari-ios this only validates the manifest/JS bundle shape —
 * the actual store artifact is the signed Xcode archive built from this dist
 * output, not this dist output itself.
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

const SUPPORTED_BROWSERS = ["chrome", "edge", "opera", "firefox", "safari", "safari-ios"];
const browser = String(getCliArgValue("--browser") || "chrome")
  .trim()
  .toLowerCase();
if (!SUPPORTED_BROWSERS.includes(browser)) {
  fail(`unsupported --browser ${browser} (use ${SUPPORTED_BROWSERS.join(", ")})`);
}
// Safari shares Firefox's manifest shape (no CDP either): non-persistent
// background scripts, no Chromium-only permissions, webRequest for network.
const isFirefoxShaped = browser === "firefox" || browser === "safari" || browser === "safari-ios";
// Only targets with a real media host need the offscreen page; safari-ios
// has mediaKind "none" and never opens it, even though it's still copied
// into dist as a static asset.
const hasMediaHost = browser !== "safari-ios";

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

if (isFirefoxShaped) {
  if (manifest.minimum_chrome_version) {
    fail(`${browser} package must not set minimum_chrome_version.`);
  }
  for (const permission of ["tabCapture", "offscreen", "debugger"]) {
    if (manifest.permissions?.includes(permission)) {
      fail(`${browser} package must not include Chromium-only permission: ${permission}`);
    }
  }
  if (manifest.oauth2) {
    fail(`${browser} package must not include oauth2 (use launchWebAuthFlow).`);
  }
  if (manifest.key) {
    fail(`${browser} package must not include key.`);
  }
  if (browser === "firefox") {
    if (!manifest.browser_specific_settings?.gecko?.id) {
      fail("Firefox package requires browser_specific_settings.gecko.id.");
    }
  } else if (!manifest.browser_specific_settings?.safari) {
    fail(`${browser} package requires browser_specific_settings.safari.`);
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
const firefoxShapedPermissions = ["activeTab", "storage", "alarms", "scripting", "tabs"];
const requiredPermissions = isFirefoxShaped ? firefoxShapedPermissions : chromiumPermissions;
// "identity" is chrome.identity.getAuthToken (Chromium-only); Firefox keeps it
// declared even though unused, but Safari's converter flags it as an
// unsupported manifest key, so safari/safari-ios must NOT declare it.
if (browser === "safari" || browser === "safari-ios") {
  if (manifest.permissions?.includes("identity")) {
    fail(`${browser} package must not include unsupported permission: identity`);
  }
} else if (isFirefoxShaped && !manifest.permissions?.includes("identity")) {
  fail("required permission identity is missing.");
}

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
if (isFirefoxShaped) {
  if (manifest.background?.service_worker) {
    fail(`${browser} package must use background.scripts (service_worker is disabled here).`);
  }
  if (!Array.isArray(manifest.background?.scripts) || manifest.background.scripts.length === 0) {
    fail(`${browser} package requires background.scripts.`);
  }
}

const popupPath = path.join(distDir, manifest.action?.default_popup || "");
if (!fs.existsSync(popupPath)) {
  fail("default popup path does not exist.");
}

if (isFirefoxShaped) {
  const requiredAssets = ["content/in-page-capture-main.js", "content/in-page-capture-bridge.js"];
  if (hasMediaHost) {
    requiredAssets.push("offscreen/offscreen.js");
  }
  for (const rel of requiredAssets) {
    if (!fs.existsSync(path.join(distDir, rel))) {
      fail(`${browser} package missing required asset: ${rel}`);
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
