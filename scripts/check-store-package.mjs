import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const distDir = path.join(root, "dist");
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
  fail("dist/manifest.json is missing. Run task dist first.");
}

const manifest = readJson(manifestPath);
const manifestText = fs.readFileSync(manifestPath, "utf8");
if (manifestText.includes("{{")) {
  fail("manifest still contains template placeholders.");
}

if (manifest.manifest_version !== 3) {
  fail("manifest_version must be 3.");
}

if (!manifest.minimum_chrome_version) {
  fail("minimum_chrome_version is required for Store package clarity.");
}

// Fixed multi-cloud hosts (must match manifest.template.json host_permissions
// minus optional token-proxy origins injected at build time).
// Google Drive + Dropbox fixed host permissions.
const fixedHostPermissions = new Set([
  "https://oauth2.googleapis.com/",
  "https://www.googleapis.com/",
  "https://api.dropboxapi.com/",
  "https://content.dropboxapi.com/",
  "https://www.dropbox.com/",
  "https://dl.dropboxusercontent.com/",
]);
// Optional token-proxy Worker origins (Google / Dropbox), max 2.
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

for (const permission of [
  "tabCapture",
  "offscreen",
  "debugger",
  "activeTab",
  "storage",
  "alarms",
  "identity",
]) {
  if (!manifest.permissions?.includes(permission)) {
    fail(`required permission ${permission} is missing.`);
  }
}

const backgroundPath = path.join(distDir, manifest.background?.service_worker || "");
if (!fs.existsSync(backgroundPath)) {
  fail("background service worker path does not exist.");
}

const popupPath = path.join(distDir, manifest.action?.default_popup || "");
if (!fs.existsSync(popupPath)) {
  fail("default popup path does not exist.");
}

const files = walk(distDir);
for (const file of files) {
  const rel = path.relative(distDir, file);
  if (file.endsWith(".map")) {
    fail(`production artifact contains source map: ${rel}`);
  }

  if (!/\.(js|html)$/i.test(file)) {
    continue;
  }

  const content = fs.readFileSync(file, "utf8");
  // Vendored third-party player UI (luna) is packaged locally; it may use
  // `new Function` for named constructors and is not remote code.
  const isVendoredPlayer = rel.split(path.sep).join("/").startsWith("player/vendor/");
  if (!isVendoredPlayer) {
    if (/\beval\s*\(/.test(content)) {
      fail(`eval() found in ${rel}`);
    }
    if (/new\s+Function\s*\(/.test(content)) {
      fail(`new Function() found in ${rel}`);
    }
  }
  if (file.endsWith(".html") && /<script[^>]+src=["']https?:\/\//i.test(content)) {
    fail(`remote script tag found in ${rel}`);
  }
}

console.log("Store package check passed.");
