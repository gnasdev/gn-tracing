/**
 * Local checklist for Google OAuth domain policy + Console wiring.
 *
 * Does not call Google Cloud Console (no public API for OAuth client redirects).
 * Reads .env, probes live product URLs, prints exact values to paste into Console.
 *
 * Usage: node scripts/check-oauth-domain-console.mjs
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const out = {};
  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const i = trimmed.indexOf("=");
    const key = trimmed.slice(0, i).trim();
    let value = trimmed.slice(i + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

async function headOk(url) {
  try {
    const res = await fetch(url, { method: "GET", redirect: "follow" });
    return { url, status: res.status, ok: res.ok };
  } catch (error) {
    return { url, status: 0, ok: false, error: error.message };
  }
}

const env = loadEnv(path.join(root, ".env"));
const clientId = env.GOOGLE_CLIENT_ID || "";
const extId = env.CHROME_EXTENSION_ID || "";
const playerHost = (env.PLAYER_HOST_URL || "https://tracing.gnas.dev/").replace(/\/+$/, "");
const proxy = env.GOOGLE_TOKEN_PROXY_URL || "";
const hasSecret = Boolean(env.GOOGLE_CLIENT_SECRET);
const firefoxId = env.FIREFOX_EXTENSION_ID || "gn-tracing@gnas.dev";

const chromeRedirect = extId ? `https://${extId}.chromiumapp.org/` : "(set CHROME_EXTENSION_ID)";
const homepage = `${playerHost}/app/`;
const privacy = `${playerHost}/privacy/`;
const terms = `${playerHost}/terms/`;

console.log("=== GN Tracing — Google OAuth domain / Console checklist ===\n");

console.log("Local .env");
console.log(`  GOOGLE_CLIENT_ID:        ${clientId ? "set" : "MISSING"}`);
console.log(`  GOOGLE_CLIENT_SECRET:    ${hasSecret ? "set" : "empty (OK if public client only)"}`);
console.log(`  GOOGLE_TOKEN_PROXY_URL:  ${proxy ? "set" : "empty"}`);
console.log(`  CHROME_EXTENSION_ID:     ${extId || "MISSING"}`);
console.log(`  PLAYER_HOST_URL:         ${playerHost}`);
console.log("");

console.log("Live product pages (must be 200 for consent screen)");
const pages = await Promise.all([headOk(homepage), headOk(privacy), headOk(terms)]);
for (const p of pages) {
  console.log(`  ${p.ok ? "OK" : "FAIL"} ${p.status} ${p.url}`);
}
console.log("");

console.log("Paste into Google Cloud Console → project gn-tracing");
console.log("  Consent screen");
console.log(`    App name:           GN Tracing`);
console.log(`    Homepage:           ${homepage}`);
console.log(`    Privacy policy:     ${privacy}`);
console.log(`    Terms of service:   ${terms}`);
console.log(`    Authorized domain:  gnas.dev`);
console.log(`    Scope:              https://www.googleapis.com/auth/drive.file`);
console.log("");
console.log("  Credentials → OAuth client (Chrome Extension)");
console.log(`    Extension ID:       ${extId || "(missing)"}`);
console.log("");
console.log("  Credentials → OAuth client (Web application) for Edge/Firefox PKCE");
console.log("  This client must match GOOGLE_WEB_CLIENT_ID (not the Chrome Extension client).");
console.log("  Authorized redirect URIs (ONLY these — never tracing.gnas.dev callbacks):");
console.log(`    ${chromeRedirect}`);
// Firefox identity.getRedirectURL uses SHA-1(addon id), not the raw email id.
const firefoxSha1 = crypto.createHash("sha1").update(firefoxId, "utf8").digest("hex");
const firefoxMozo = `http://127.0.0.1/mozoauth2/${firefoxSha1}`;
console.log(`    Firefox (SHA-1 of addon id — required for Google):`);
console.log(`      ${firefoxMozo}`);
console.log(`    Firefox id:         ${firefoxId}`);
console.log(`    Firefox sha1(id):   ${firefoxSha1}`);
console.log("");
console.log("  redirect_uri_mismatch fix:");
console.log(`    1. Open Web application client → Authorized redirect URIs`);
console.log(`    2. Add Chromium: ${chromeRedirect}`);
console.log(`    3. Add Firefox:  ${firefoxMozo}`);
console.log(`    4. Save → task build:firefox → reload temporary add-on → Connect Drive again`);
console.log("");
console.log("  Do NOT add as redirect URI:");
console.log(`    ${playerHost}/oauth/callback`);
console.log("    https://*.workers.dev/...");
console.log("    https://…@….extensions.allizom.org/");
console.log(`    http://127.0.0.1/mozoauth2/${firefoxId}  (raw email — WRONG; use SHA-1 above)`);
console.log("");

// Dropbox refuses http:// redirect URIs on any host other than the literal
// "localhost", so the mozoauth2 IP-literal form Google needs cannot be
// registered there. Firefox also intercepts the https allizom identity host.
const firefoxAllizom = `https://${firefoxSha1}.extensions.allizom.org/`;
console.log("Paste into Dropbox App Console → your app → Settings → OAuth 2 → Redirect URIs");
console.log(`  DROPBOX_CLIENT_ID:       ${env.DROPBOX_CLIENT_ID ? "set" : "MISSING"}`);
console.log(`  Chromium: ${chromeRedirect}`);
console.log(`  Firefox:  ${firefoxAllizom}`);
console.log("  Dropbox allows http:// only for the literal host 'localhost', so the Firefox");
console.log("  mozoauth2 loopback above is rejected with 'Invalid redirect_uri' — use the");
console.log("  https allizom URI for Dropbox and mozoauth2 for Google.");
console.log("");
console.log("Deep links");
console.log("  https://console.cloud.google.com/auth/overview?project=gn-tracing");
console.log("  https://console.cloud.google.com/apis/credentials?project=gn-tracing");
console.log(
  "  https://console.cloud.google.com/apis/library/drive.googleapis.com?project=gn-tracing",
);
console.log("");

const failed = pages.filter((p) => !p.ok);
if (!clientId || !extId || failed.length) {
  console.log("Status: incomplete local/live config — fix MISSING/FAIL rows above.");
  process.exitCode = 1;
} else {
  console.log(
    "Status: local config + live pages look ready. Remaining step is Console UI: " +
      "confirm consent URLs, clients, and redirect URI list match the values above.",
  );
}
