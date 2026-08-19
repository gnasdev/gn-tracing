/**
 * Builds the Manifest V3 extension (popup, SW, content, annotate, offscreen).
 *
 * Replay UI lives only in `player/` (hosted). The extension never
 * ships player assets; upload/history links open the external player host
 * (`PLAYER_HOST_URL` / dev localhost Vite).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import {
  isProductRouteVersion,
  pickWorkerOrigin,
  resolveVersionedWorkerEndpoints,
} from "./packages/replay-core/src/route-version.ts";
import { getChromeExtensionId } from "./scripts/chrome-extension-id.mjs";
import { createDevExtensionReloadGate } from "./scripts/dev-extension-reload-gate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envVars = loadEnvFile(path.resolve(__dirname, ".env"));
const cliEnv = getCliArgValue("--env");
const watch = process.argv.includes("--watch");
const rawAppEnv = cliEnv || (watch ? "development" : "production");
const appEnv = normalizeAppEnv(rawAppEnv);
const isProductionBuild = appEnv === "production";
const browserTarget = normalizeBrowserTarget(getCliArgValue("--browser") || "chrome");
const distRoot = path.resolve(__dirname, "dist", browserTarget);
const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, "package.json"), "utf-8"));
const packageVersion = typeof packageJson.version === "string" ? packageJson.version.trim() : "";
if (!isProductRouteVersion(packageVersion)) {
  throw new Error(
    `package.json version must be core semver MAJOR.MINOR.PATCH (got ${JSON.stringify(packageVersion)})`,
  );
}
const googleClientId = getConfigValue("GOOGLE_CLIENT_ID");
// Web application client for launchWebAuthFlow + PKCE (Edge / Opera / Firefox /
// Chrome fallback). Falls back to GOOGLE_CLIENT_ID when empty (single-client setups).
const googleWebClientId = getConfigValue("GOOGLE_WEB_CLIENT_ID", googleClientId);
const dropboxClientId = getConfigValue("DROPBOX_CLIENT_ID");
// Dev/watch builds default to the multi-issuer Worker started by `task worker:dev`
// / `task dev` on port 63972 so Google and Dropbox hit localhost without editing
// .env. Override with *_TOKEN_PROXY_URL_DEV if needed.
// Production builds always use *_TOKEN_PROXY_URL (deployed Worker origin or URL).
// Endpoints are joined as /{packageVersion}/token via resolveVersionedWorkerEndpoints
// (same pure helper as Worker/player).
const DEFAULT_DEV_WORKER_ORIGIN = "http://localhost:63972";
const googleTokenProxyUrl = resolveGoogleTokenProxyUrl();
const dropboxTokenProxyUrl = resolveDropboxTokenProxyUrl();
// Feedback submit reuses the multi-issuer Worker at POST /{version}/feedback.
// Prefer an explicit FEEDBACK_PROXY_URL; otherwise derive origin from a configured
// OAuth proxy URL so host_permissions stay aligned with the same Worker.
const feedbackProxyUrl = resolveFeedbackProxyUrl();
const chromeExtensionPublicKey = getConfigValue("CHROME_EXTENSION_PUBLIC_KEY");
const chromeExtensionPrivateKey = getConfigValue("CHROME_EXTENSION_PRIVATE_KEY");
const chromeExtensionId = getConfigValue(
  "CHROME_EXTENSION_ID",
  chromeExtensionPublicKey ? getChromeExtensionId(chromeExtensionPublicKey) : "",
);
// Dev-only key pair so unpacked dev builds mint a different extension id than
// production, and stop overriding an installed production extension when
// both are loaded in the same Chrome profile. Falls back to the production
// key above when unset (unchanged behavior for setups that haven't opted in).
const chromeExtensionPublicKeyDev = getConfigValue("CHROME_EXTENSION_PUBLIC_KEY_DEV");
// Edge / Opera may ship a distinct store key; default to Chrome key for local unpack.
const edgeExtensionPublicKey = getConfigValue(
  "EDGE_EXTENSION_PUBLIC_KEY",
  chromeExtensionPublicKey,
);
const operaExtensionPublicKey = getConfigValue(
  "OPERA_EXTENSION_PUBLIC_KEY",
  chromeExtensionPublicKey,
);
const firefoxExtensionId = getConfigValue("FIREFOX_EXTENSION_ID", "gn-tracing@gnas.dev");
const playerLocalPort = getConfigValue("PLAYER_LOCAL_PORT", "5176");
const devExtensionReloadPort = getConfigValue("DEV_EXTENSION_RELOAD_PORT", "63973");
const devExtensionReloadUrl =
  watch && !isProductionBuild ? `http://127.0.0.1:${devExtensionReloadPort}` : "";
// Replay host baked into the extension (Instant Replay / screenshot / Record upload links).
// Dev never falls back to PLAYER_HOST_URL (often production in .env) so local
// builds always open the Vite player unless PLAYER_HOST_URL_DEV is set.
const DEFAULT_PRODUCTION_PLAYER_HOST_URL = "https://tracing.gnas.dev/";
const DEFAULT_DEV_PLAYER_HOST_URL = `http://localhost:${playerLocalPort}/`;
const playerHostUrl = normalizePlayerHostUrl(
  isProductionBuild
    ? getConfigValue("PLAYER_HOST_URL", DEFAULT_PRODUCTION_PLAYER_HOST_URL)
    : getConfigValue("PLAYER_HOST_URL_DEV", DEFAULT_DEV_PLAYER_HOST_URL),
);
const STATIC_ASSET_ENTRIES = [
  { type: "text", src: "popup/popup.html", dest: "popup/popup.html" },
  { type: "file", src: "popup/popup.css", dest: "popup/popup.css" },
  { type: "text", src: "annotate/annotate.html", dest: "annotate/annotate.html" },
  { type: "file", src: "annotate/annotate.css", dest: "annotate/annotate.css" },
  {
    type: "text",
    src: "manage-clouds/manage-clouds.html",
    dest: "manage-clouds/manage-clouds.html",
  },
  { type: "file", src: "manage-clouds/manage-clouds.css", dest: "manage-clouds/manage-clouds.css" },
  {
    type: "text",
    src: "microphone-permission/microphone-permission.html",
    dest: "microphone-permission/microphone-permission.html",
  },
  {
    type: "file",
    src: "microphone-permission/microphone-permission.css",
    dest: "microphone-permission/microphone-permission.css",
  },
  { type: "text", src: "offscreen/offscreen.html", dest: "offscreen/offscreen.html" },
  { type: "dir", src: "icons", dest: "icons" },
  { type: "file", src: "shared/theme.css", dest: "shared/theme.css" },
  { type: "file", src: "shared/theme-init.js", dest: "shared/theme-init.js" },
];
const staticAssetWatchers = [];
const devExtensionReloadGate = createDevExtensionReloadGate(scheduleDevExtensionReload);

// The root build emits the unpacked MV3 extension only. Hosted player packaging
// is owned entirely by `player/` (Vite).
const commonOptions = {
  bundle: true,
  target: browserTarget === "firefox" ? "firefox115" : "chrome120",
  sourcemap: !isProductionBuild,
  minify: false,
  plugins: watch ? [createDevExtensionReloadPlugin()] : [],
  define: {
    __APP_ENV__: JSON.stringify(appEnv),
    __APP_VERSION__: JSON.stringify(packageVersion),
    __BROWSER_TARGET__: JSON.stringify(browserTarget),
    __GOOGLE_CLIENT_ID__: JSON.stringify(googleClientId),
    __GOOGLE_WEB_CLIENT_ID__: JSON.stringify(googleWebClientId || googleClientId),
    __GOOGLE_TOKEN_PROXY_URL__: JSON.stringify(googleTokenProxyUrl),
    __DROPBOX_CLIENT_ID__: JSON.stringify(dropboxClientId),
    __DROPBOX_TOKEN_PROXY_URL__: JSON.stringify(dropboxTokenProxyUrl),
    __FEEDBACK_PROXY_URL__: JSON.stringify(feedbackProxyUrl),
    __PLAYER_LOCAL_PORT__: JSON.stringify(playerLocalPort),
    __PLAYER_HOST_URL__: JSON.stringify(playerHostUrl),
    __DEV_EXTENSION_RELOAD_URL__: JSON.stringify(devExtensionReloadUrl),
  },
};

function normalizeBrowserTarget(value) {
  const normalized = String(value || "chrome")
    .trim()
    .toLowerCase();
  if (
    normalized === "chrome" ||
    normalized === "edge" ||
    normalized === "opera" ||
    normalized === "firefox"
  ) {
    return normalized;
  }
  throw new Error(`Unsupported --browser value: ${value}. Use chrome, edge, opera, or firefox.`);
}

/** Manifest `key` for Chromium-family packages (stable unpacked id). */
function resolveChromiumPublicKey() {
  // One dev key covers chrome/edge/opera (no per-browser *_DEV variants):
  // local dev only needs distinct ids from *production*, not from each other,
  // so all three chromium dev builds intentionally share this id.
  if (!isProductionBuild && chromeExtensionPublicKeyDev) {
    return chromeExtensionPublicKeyDev;
  }
  if (browserTarget === "edge") {
    return edgeExtensionPublicKey || chromeExtensionPublicKey;
  }
  if (browserTarget === "opera") {
    return operaExtensionPublicKey || chromeExtensionPublicKey;
  }
  return chromeExtensionPublicKey;
}

function resolveGoogleTokenProxyUrl() {
  const configured = normalizeProxyUrl(
    isProductionBuild
      ? getConfigValue("GOOGLE_TOKEN_PROXY_URL")
      : getConfigValue("GOOGLE_TOKEN_PROXY_URL_DEV", DEFAULT_DEV_WORKER_ORIGIN),
  );
  if (!configured) {
    return "";
  }
  return resolveVersionedWorkerEndpoints(configured, packageVersion).googleTokenUrl;
}

function resolveDropboxTokenProxyUrl() {
  const configured = normalizeProxyUrl(
    isProductionBuild
      ? getConfigValue("DROPBOX_TOKEN_PROXY_URL")
      : getConfigValue("DROPBOX_TOKEN_PROXY_URL_DEV", DEFAULT_DEV_WORKER_ORIGIN),
  );
  if (!configured) {
    return "";
  }
  return resolveVersionedWorkerEndpoints(configured, packageVersion).dropboxTokenUrl;
}

/**
 * Resolve the feedback Worker endpoint for define + host_permissions.
 * Empty string means the extension will refuse submit with a clear error.
 */
function resolveFeedbackProxyUrl() {
  const explicit = normalizeProxyUrl(
    isProductionBuild
      ? getConfigValue("FEEDBACK_PROXY_URL")
      : getConfigValue("FEEDBACK_PROXY_URL_DEV", DEFAULT_DEV_WORKER_ORIGIN),
  );
  if (explicit) {
    return resolveVersionedWorkerEndpoints(explicit, packageVersion).feedbackUrl;
  }

  const origin = pickWorkerOrigin(googleTokenProxyUrl, dropboxTokenProxyUrl);
  if (origin) {
    return resolveVersionedWorkerEndpoints(origin, packageVersion).feedbackUrl;
  }

  return isProductionBuild
    ? ""
    : resolveVersionedWorkerEndpoints(DEFAULT_DEV_WORKER_ORIGIN, packageVersion).feedbackUrl;
}

function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) {
    return {};
  }

  const envVars = {};
  const envContent = fs.readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = normalizeEnvValue(trimmed.slice(separatorIndex + 1).trim());
    if (key) {
      envVars[key] = value;
    }
  }

  return envVars;
}

function normalizeEnvValue(value) {
  const isQuoted =
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"));
  const normalized = isQuoted ? value.slice(1, -1) : value;
  return normalized.replace(/\\n/g, "\n");
}

// Trims a trailing slash so the auth module can append paths predictably and the
// proxy URL stays consistent regardless of how it is configured in .env.
function normalizeProxyUrl(value) {
  const trimmed = String(value || "").trim();
  return trimmed.replace(/\/+$/, "");
}

function getConfigValue(name, fallback = "") {
  return envVars[name] || process.env[name] || fallback;
}

function hasConfigValue(name) {
  return Boolean(envVars[name] || process.env[name]);
}

function validateChromeExtensionIdentity() {
  if (!googleClientId) {
    throw new Error("GOOGLE_CLIENT_ID is required. Set it in .env or the environment.");
  }

  if (browserTarget === "firefox") {
    if (!firefoxExtensionId || !firefoxExtensionId.includes("@")) {
      throw new Error(
        "FIREFOX_EXTENSION_ID is required for Firefox builds (e.g. gn-tracing@gnas.dev).",
      );
    }
    return;
  }

  const publicKey = resolveChromiumPublicKey();

  if (isProductionBuild && browserTarget === "chrome" && !hasConfigValue("CHROME_EXTENSION_ID")) {
    throw new Error("CHROME_EXTENSION_ID is required for production Chrome builds.");
  }

  if (!publicKey) {
    throw new Error(
      "CHROME_EXTENSION_PUBLIC_KEY (or EDGE_EXTENSION_PUBLIC_KEY / OPERA_EXTENSION_PUBLIC_KEY) is required to generate manifest.json.",
    );
  }

  if (chromeExtensionPrivateKey && !chromeExtensionPrivateKey.includes("PRIVATE KEY")) {
    console.warn("CHROME_EXTENSION_PRIVATE_KEY is set but does not look like a PEM private key.");
  }

  // CHROME_EXTENSION_ID pins the production identity (Web Store item). Dev
  // builds intentionally resolve a different key (CHROME_EXTENSION_PUBLIC_KEY_DEV)
  // when configured, so this cross-check only applies to production builds.
  if (browserTarget === "chrome" && isProductionBuild) {
    const derivedExtensionId = getChromeExtensionId(publicKey);
    if (chromeExtensionId && chromeExtensionId !== derivedExtensionId) {
      throw new Error(
        `CHROME_EXTENSION_ID (${chromeExtensionId}) does not match CHROME_EXTENSION_PUBLIC_KEY (${derivedExtensionId}).`,
      );
    }
  }
}

function normalizeAppEnv(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "dev") return "development";
  if (normalized === "prod") return "production";
  return normalized || "production";
}

const PRODUCTION_PLAYER_ORIGINS = new Set([
  "https://tracing.gnas.dev",
  "http://tracing.gnas.dev",
  "https://gn-tracing-player.pages.dev",
  "http://gn-tracing-player.pages.dev",
]);

/** Ensure player host is an absolute URL ending with `/`. */
function normalizePlayerHostUrl(value) {
  const raw = String(value || "")
    .trim()
    .replace(/\/+$/, "");
  if (!raw) {
    return isProductionBuild ? DEFAULT_PRODUCTION_PLAYER_HOST_URL : DEFAULT_DEV_PLAYER_HOST_URL;
  }
  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    // Development builds must not bake the production player host (common when
    // PLAYER_HOST_URL_DEV is copied from PLAYER_HOST_URL in .env).
    if (!isProductionBuild && PRODUCTION_PLAYER_ORIGINS.has(url.origin)) {
      return DEFAULT_DEV_PLAYER_HOST_URL;
    }
    return `${url.origin}${url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "")}/`;
  } catch {
    return isProductionBuild ? DEFAULT_PRODUCTION_PLAYER_HOST_URL : DEFAULT_DEV_PLAYER_HOST_URL;
  }
}

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

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyTextFile(src, dest, transform) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const content = fs.readFileSync(src, "utf-8");
  fs.writeFileSync(dest, transform ? transform(content) : content, "utf-8");
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function generateManifest(outputPath) {
  const templatePath = path.resolve(__dirname, "manifest.template.json");
  const manifestPath = path.resolve(outputPath);

  if (!fs.existsSync(templatePath)) {
    console.error("manifest.template.json not found");
    return;
  }

  validateChromeExtensionIdentity();

  const publicKey =
    browserTarget === "firefox" ? chromeExtensionPublicKey : resolveChromiumPublicKey();

  const template = fs
    .readFileSync(templatePath, "utf-8")
    .replace(/{{GOOGLE_CLIENT_ID}}/g, googleClientId)
    .replace(/{{CHROME_EXTENSION_PUBLIC_KEY}}/g, publicKey || "");
  const manifest = JSON.parse(template);
  manifest.version = packageVersion || manifest.version;
  if (!isProductionBuild) {
    // Visually distinguish the dev build in chrome://extensions / the toolbar
    // from an installed production extension.
    manifest.name = `${manifest.name} (Dev)`;
  }
  applyBrowserManifestPatches(manifest);
  addTokenProxyHostPermission(manifest);

  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
  console.log(`✓ manifest.json generated (${browserTarget})`);

  if (!isProductionBuild && browserTarget !== "firefox") {
    if (chromeExtensionPublicKeyDev) {
      const devId = getChromeExtensionId(publicKey);
      console.log(
        `✓ Dev extension id: ${devId} — add https://${devId}.chromiumapp.org/ as an OAuth ` +
          "redirect URI on your Google/Dropbox Web application clients to enable Drive/Dropbox connect in dev.",
      );
    } else {
      console.log(
        "ℹ️  CHROME_EXTENSION_PUBLIC_KEY_DEV is not set — this dev build shares the production " +
          "extension id. Set it (see .env.example) so unpacked dev stops overriding an installed " +
          "production extension.",
      );
    }
  }
}

/**
 * Apply per-browser permission/identity differences on top of the shared template.
 * Official targets: chrome | edge | opera | firefox.
 */
function applyBrowserManifestPatches(manifest) {
  if (browserTarget === "firefox") {
    delete manifest.minimum_chrome_version;
    delete manifest.key;
    delete manifest.oauth2;
    const chromiumOnly = new Set(["tabCapture", "offscreen", "debugger"]);
    manifest.permissions = (manifest.permissions || []).filter((p) => !chromiumOnly.has(p));
    if (!manifest.permissions.includes("tabs")) {
      manifest.permissions.push("tabs");
    }
    // webRequest is Firefox's CDP-Network equivalent: full-tab, all-frames,
    // browser-issued-requests-included network visibility that in-page capture
    // cannot reach (see WebRequestNetworkCollector). Chrome does not get this
    // permission added because its evidence already comes from CDP.
    if (!manifest.permissions.includes("webRequest")) {
      manifest.permissions.push("webRequest");
    }
    // Firefox stable does not support background.service_worker yet; MV3 uses
    // non-persistent event pages via background.scripts (same bundled entry).
    // https://extensionworkshop.com/documentation/develop/manifest-v3-migration-guide/
    const backgroundEntry = manifest.background?.service_worker || "background/service-worker.js";
    manifest.background = {
      scripts: [backgroundEntry],
      type: "module",
    };
    manifest.browser_specific_settings = {
      gecko: {
        id: firefoxExtensionId,
        // 128.0, not 115.0: full-record console/network evidence is injected with
        // `world: "MAIN"`, which Mozilla shipped in Firefox 128 ("In Firefox 128,
        // support is now available for the MAIN execution world for content
        // scripts declared in the manifest.json file and scripting.executeScript").
        // On 115-127 that injection lands in the isolated content-script sandbox
        // instead of the page realm, so the capture patches the sandbox's own
        // console/fetch and records nothing at all, with no error. Refusing to
        // install is honest; recording empty evidence is not.
        strict_min_version: "128.0",
      },
    };
    return;
  }

  if (browserTarget === "edge" || browserTarget === "opera") {
    // Same Chromium capture APIs as Chrome; web OAuth at runtime (no getAuthToken).
    // oauth2 block remains optional for compatibility with Chromium stores.
    if (!manifest.permissions.includes("tabs")) {
      manifest.permissions.push("tabs");
    }
    return;
  }

  // chrome default template is already correct.
}

// Surfaces whether the OAuth token exchange (used by the service worker when
// the popup Manage clouds dialog connects a provider) will go through the
// Cloudflare Worker or directly to Google. Direct-to-Google only works for
// public/installed OAuth clients; a "Web application" client requires the
// Worker or Google returns "client_secret is missing".
function logPlayerHostStatus() {
  console.log(
    `✓ Replay player host (${appEnv}): ${playerHostUrl}` +
      (isProductionBuild ? "" : " — Instant Replay / uploads open the local player"),
  );
}

function logTokenProxyStatus() {
  if (googleTokenProxyUrl) {
    console.log(`✓ OAuth token exchange routed through Worker: ${googleTokenProxyUrl}`);
    return;
  }

  const message =
    "GOOGLE_TOKEN_PROXY_URL is not set — the extension will call " +
    "https://oauth2.googleapis.com/token directly. This fails with " +
    '"client_secret is missing" if the OAuth client is a Web application. Set ' +
    "GOOGLE_TOKEN_PROXY_URL to the deployed Worker URL and rebuild to route auth through it.";
  if (isProductionBuild) {
    // Fail hard: a production bundle without the proxy URL bypasses the Worker
    // and is guaranteed to break Google Drive auth for "Web application" clients.
    throw new Error(message);
  }
  console.log(`ℹ️  ${message}`);
}

// When a token proxy Worker is configured, the service worker must be allowed
// to call it. Append the Worker origin to host_permissions so the cross-origin
// POST is not blocked. No-op when the proxy URL is unset (direct-to-Google).
function addTokenProxyHostPermission(manifest) {
  if (!Array.isArray(manifest.host_permissions)) {
    manifest.host_permissions = [];
  }

  for (const [label, proxyUrl] of [
    ["GOOGLE_TOKEN_PROXY_URL", googleTokenProxyUrl],
    ["DROPBOX_TOKEN_PROXY_URL", dropboxTokenProxyUrl],
    ["FEEDBACK_PROXY_URL", feedbackProxyUrl],
    ["DEV_EXTENSION_RELOAD_URL", devExtensionReloadUrl],
  ]) {
    if (!proxyUrl) {
      continue;
    }
    let proxyOrigin;
    try {
      proxyOrigin = `${new URL(proxyUrl).origin}/`;
    } catch {
      throw new Error(`${label} is not a valid URL: ${proxyUrl}`);
    }
    if (!manifest.host_permissions.includes(proxyOrigin)) {
      manifest.host_permissions.push(proxyOrigin);
    }
  }
}

let devExtensionReloadTimer = null;

function scheduleDevExtensionReload() {
  if (!devExtensionReloadUrl) {
    return;
  }
  clearTimeout(devExtensionReloadTimer);
  devExtensionReloadTimer = setTimeout(async () => {
    try {
      const response = await fetch(`${devExtensionReloadUrl}/notify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: browserTarget }),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
    } catch (error) {
      console.warn(
        `[dev:reload] Could not notify ${browserTarget}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }, 100);
}

function createDevExtensionReloadPlugin() {
  return {
    name: "dev-extension-reload",
    setup(buildContext) {
      const buildKey = JSON.stringify(buildContext.initialOptions.entryPoints);
      devExtensionReloadGate.register(buildKey);
      buildContext.onStart(() => {
        devExtensionReloadGate.begin(buildKey);
      });
      buildContext.onEnd((result) => {
        devExtensionReloadGate.report(buildKey, result.errors.length > 0);
      });
    },
  };
}

async function build() {
  logTokenProxyStatus();
  logPlayerHostStatus();
  console.log(`✓ Browser target: ${browserTarget} → ${path.relative(__dirname, distRoot)}/`);

  if (!watch) {
    fs.rmSync(distRoot, { recursive: true, force: true });
  }

  const swCtx = await esbuild.context({
    ...commonOptions,
    entryPoints: ["src/background/service-worker.ts"],
    outfile: path.join(distRoot, "background/service-worker.js"),
    format: "esm",
  });

  const uiCtx = await esbuild.context({
    ...commonOptions,
    entryPoints: [
      { in: "src/popup/popup.ts", out: "popup/popup" },
      { in: "src/offscreen/offscreen.ts", out: "offscreen/offscreen" },
      { in: "src/annotate/annotate.ts", out: "annotate/annotate" },
      { in: "src/manage-clouds/manage-clouds.ts", out: "manage-clouds/manage-clouds" },
      {
        in: "src/microphone-permission/microphone-permission.ts",
        out: "microphone-permission/microphone-permission",
      },
    ],
    outdir: distRoot,
    format: "iife",
  });

  const contentEntries = [
    { in: "src/content/recording-events.ts", out: "content/recording-events" },
    { in: "src/content/drawing-overlay.ts", out: "content/drawing-overlay" },
    { in: "src/content/instant-replay.ts", out: "content/instant-replay" },
    { in: "src/content/instant-replay-evidence.ts", out: "content/instant-replay-evidence" },
    { in: "src/content/page-dom-snapshot.ts", out: "content/page-dom-snapshot" },
    { in: "src/content/in-page-capture-main.ts", out: "content/in-page-capture-main" },
    { in: "src/content/in-page-capture-bridge.ts", out: "content/in-page-capture-bridge" },
  ];

  const contentCtx = await esbuild.context({
    ...commonOptions,
    entryPoints: contentEntries,
    outdir: distRoot,
    format: "iife",
    sourcemap: false,
  });

  if (watch) {
    await Promise.all([swCtx.watch(), uiCtx.watch(), contentCtx.watch()]);
    syncExtensionAssets();
    watchExtensionAssets();
    console.log(`Watching extension sources (${browserTarget})...`);
    return;
  }

  await Promise.all([swCtx.rebuild(), uiCtx.rebuild(), contentCtx.rebuild()]);
  await Promise.all([swCtx.dispose(), uiCtx.dispose(), contentCtx.dispose()]);
  syncExtensionAssets();

  console.log(`Extension built for ${browserTarget}.`);
}

function copyStaticAssets() {
  for (const entry of STATIC_ASSET_ENTRIES) {
    const dest = path.join(distRoot, entry.dest);
    if (entry.type === "text") {
      copyTextFile(entry.src, dest);
    } else if (entry.type === "dir") {
      copyDir(entry.src, dest);
    } else {
      copyFile(entry.src, dest);
    }
  }
}

function syncExtensionAssets() {
  generateManifest(path.join(distRoot, "manifest.json"));
  copyStaticAssets();
  devExtensionReloadGate.notifyStaticAssets();
}

function watchExtensionAssets() {
  let debounceTimer;
  let lastAssetSignature = getStaticAssetSignature();
  const watchedPaths = new Set([
    path.resolve(__dirname, "manifest.template.json"),
    ...STATIC_ASSET_ENTRIES.flatMap((entry) =>
      getWatchedAssetPaths(path.resolve(__dirname, entry.src)),
    ),
  ]);

  const syncAfterChange = () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      try {
        const nextAssetSignature = getStaticAssetSignature();
        if (nextAssetSignature === lastAssetSignature) {
          return;
        }

        lastAssetSignature = nextAssetSignature;
        syncExtensionAssets();
        console.log("✓ static extension assets copied");
      } catch (error) {
        console.error(error);
      }
    }, 300);
  };

  for (const watchedPath of watchedPaths) {
    try {
      staticAssetWatchers.push(fs.watch(watchedPath, syncAfterChange));
    } catch (error) {
      console.warn(`Could not watch ${path.relative(__dirname, watchedPath)}: ${error.message}`);
    }
  }
}

function getWatchedAssetPaths(assetPath) {
  if (!fs.existsSync(assetPath)) {
    return [];
  }

  const stat = fs.statSync(assetPath);
  if (!stat.isDirectory()) {
    return [path.dirname(assetPath), assetPath];
  }

  const paths = [assetPath];
  for (const entry of fs.readdirSync(assetPath, { withFileTypes: true })) {
    const entryPath = path.join(assetPath, entry.name);
    if (entry.isDirectory()) {
      paths.push(...getWatchedAssetPaths(entryPath));
    } else {
      paths.push(entryPath);
    }
  }

  return paths;
}

function getStaticAssetSignature() {
  const assetPaths = [
    path.resolve(__dirname, "manifest.template.json"),
    ...STATIC_ASSET_ENTRIES.flatMap((entry) =>
      getWatchedAssetPaths(path.resolve(__dirname, entry.src)),
    ),
  ];

  return assetPaths
    .map((assetPath) => {
      try {
        const stat = fs.statSync(assetPath);
        return `${assetPath}:${stat.mtimeMs}:${stat.size}`;
      } catch {
        return `${assetPath}:missing`;
      }
    })
    .join("|");
}

build().catch((e) => {
  console.error(e);
  process.exit(1);
});
