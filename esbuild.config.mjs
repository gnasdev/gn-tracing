/**
 * Builds the Manifest V3 extension (popup, SW, content, annotate, offscreen).
 *
 * Replay UI lives only in `player/` (hosted). The extension never
 * ships player assets; upload/history links open the external player host
 * (`PLAYER_HOST_URL` / dev localhost Vite).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envVars = loadEnvFile(path.resolve(__dirname, ".env"));
const cliEnv = getCliArgValue("--env");
const watch = process.argv.includes("--watch");
const rawAppEnv = cliEnv || (watch ? "development" : "production");
const appEnv = normalizeAppEnv(rawAppEnv);
const isProductionBuild = appEnv === "production";
const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, "package.json"), "utf-8"));
const packageVersion = typeof packageJson.version === "string" ? packageJson.version : "";
const googleClientId = getConfigValue("GOOGLE_CLIENT_ID");
const dropboxClientId = getConfigValue("DROPBOX_CLIENT_ID");
// Dev/watch builds default to the multi-issuer Worker started by `task worker:dev`
// / `task dev` on port 8787 so Google and Dropbox hit localhost without editing
// .env. Override with *_TOKEN_PROXY_URL_DEV if needed.
// Production builds always use *_TOKEN_PROXY_URL (deployed Worker paths).
const DEFAULT_DEV_GOOGLE_TOKEN_PROXY_URL = "http://localhost:8787";
const DEFAULT_DEV_DROPBOX_TOKEN_PROXY_URL = "http://localhost:8787/token/dropbox";
const googleTokenProxyUrl = normalizeProxyUrl(
  isProductionBuild
    ? getConfigValue("GOOGLE_TOKEN_PROXY_URL")
    : getConfigValue("GOOGLE_TOKEN_PROXY_URL_DEV", DEFAULT_DEV_GOOGLE_TOKEN_PROXY_URL),
);
const dropboxTokenProxyUrl = normalizeProxyUrl(
  isProductionBuild
    ? getConfigValue("DROPBOX_TOKEN_PROXY_URL")
    : getConfigValue("DROPBOX_TOKEN_PROXY_URL_DEV", DEFAULT_DEV_DROPBOX_TOKEN_PROXY_URL),
);
// Feedback submit reuses the multi-issuer Worker at POST /feedback. Prefer an
// explicit FEEDBACK_PROXY_URL; otherwise derive origin from a configured OAuth
// proxy URL so host_permissions stay aligned with the same Worker.
const DEFAULT_DEV_FEEDBACK_PROXY_URL = "http://localhost:8787/feedback";
const feedbackProxyUrl = resolveFeedbackProxyUrl();
const chromeExtensionPublicKey = getConfigValue("CHROME_EXTENSION_PUBLIC_KEY");
const chromeExtensionPrivateKey = getConfigValue("CHROME_EXTENSION_PRIVATE_KEY");
const chromeExtensionId = getConfigValue(
  "CHROME_EXTENSION_ID",
  chromeExtensionPublicKey ? getChromeExtensionId(chromeExtensionPublicKey) : "",
);
const playerLocalPort = getConfigValue("PLAYER_LOCAL_PORT", "5176");
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
  { type: "text", src: "popup/popup.html", dest: "dist/popup/popup.html" },
  { type: "file", src: "popup/popup.css", dest: "dist/popup/popup.css" },
  { type: "text", src: "annotate/annotate.html", dest: "dist/annotate/annotate.html" },
  { type: "file", src: "annotate/annotate.css", dest: "dist/annotate/annotate.css" },
  { type: "text", src: "offscreen/offscreen.html", dest: "dist/offscreen/offscreen.html" },
  { type: "dir", src: "icons", dest: "dist/icons" },
  { type: "file", src: "shared/theme.css", dest: "dist/shared/theme.css" },
  { type: "file", src: "shared/theme-init.js", dest: "dist/shared/theme-init.js" },
];
const staticAssetWatchers = [];

// The root build emits the unpacked MV3 extension only. Hosted player packaging
// is owned entirely by `player/` (Vite).
const commonOptions = {
  bundle: true,
  target: "chrome120",
  sourcemap: !isProductionBuild,
  minify: false,
  define: {
    __APP_ENV__: JSON.stringify(appEnv),
    __GOOGLE_CLIENT_ID__: JSON.stringify(googleClientId),
    __GOOGLE_TOKEN_PROXY_URL__: JSON.stringify(googleTokenProxyUrl),
    __DROPBOX_CLIENT_ID__: JSON.stringify(dropboxClientId),
    __DROPBOX_TOKEN_PROXY_URL__: JSON.stringify(dropboxTokenProxyUrl),
    __FEEDBACK_PROXY_URL__: JSON.stringify(feedbackProxyUrl),
    __PLAYER_LOCAL_PORT__: JSON.stringify(playerLocalPort),
    __PLAYER_HOST_URL__: JSON.stringify(playerHostUrl),
  },
};

/**
 * Resolve the feedback Worker endpoint for define + host_permissions.
 * Empty string means the extension will refuse submit with a clear error.
 */
function resolveFeedbackProxyUrl() {
  const explicit = normalizeProxyUrl(
    isProductionBuild
      ? getConfigValue("FEEDBACK_PROXY_URL")
      : getConfigValue("FEEDBACK_PROXY_URL_DEV", DEFAULT_DEV_FEEDBACK_PROXY_URL),
  );
  if (explicit) {
    // Allow either full /feedback URL or bare Worker origin.
    if (/\/feedback\/?$/i.test(explicit)) {
      return explicit.replace(/\/+$/, "");
    }
    try {
      return `${new URL(explicit).origin}/feedback`;
    } catch {
      return explicit;
    }
  }

  for (const proxyUrl of [googleTokenProxyUrl, dropboxTokenProxyUrl]) {
    if (!proxyUrl) {
      continue;
    }
    try {
      return `${new URL(proxyUrl).origin}/feedback`;
    } catch {
      // try next
    }
  }

  return isProductionBuild ? "" : DEFAULT_DEV_FEEDBACK_PROXY_URL;
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

function getChromeExtensionId(publicKey) {
  const keyBytes = Buffer.from(publicKey, "base64");
  const hash = crypto.createHash("sha256").update(keyBytes).digest();
  return Array.from(hash.subarray(0, 16), (byte) =>
    byte
      .toString(16)
      .padStart(2, "0")
      .replace(/[0-9a-f]/g, (char) =>
        String.fromCharCode("a".charCodeAt(0) + Number.parseInt(char, 16)),
      ),
  ).join("");
}

function validateChromeExtensionIdentity() {
  if (!googleClientId) {
    throw new Error("GOOGLE_CLIENT_ID is required. Set it in .env or the environment.");
  }

  if (isProductionBuild && !hasConfigValue("CHROME_EXTENSION_ID")) {
    throw new Error("CHROME_EXTENSION_ID is required for production builds.");
  }

  if (!chromeExtensionPublicKey) {
    throw new Error(
      "CHROME_EXTENSION_PUBLIC_KEY is required to generate manifest.json. Set it in .env or the environment.",
    );
  }

  if (chromeExtensionPrivateKey && !chromeExtensionPrivateKey.includes("PRIVATE KEY")) {
    console.warn("CHROME_EXTENSION_PRIVATE_KEY is set but does not look like a PEM private key.");
  }

  const derivedExtensionId = getChromeExtensionId(chromeExtensionPublicKey);
  if (chromeExtensionId && chromeExtensionId !== derivedExtensionId) {
    throw new Error(
      `CHROME_EXTENSION_ID (${chromeExtensionId}) does not match CHROME_EXTENSION_PUBLIC_KEY (${derivedExtensionId}).`,
    );
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
  const manifestPath = path.resolve(__dirname, outputPath);

  if (!fs.existsSync(templatePath)) {
    console.error("manifest.template.json not found");
    return;
  }

  validateChromeExtensionIdentity();

  const template = fs
    .readFileSync(templatePath, "utf-8")
    .replace(/{{GOOGLE_CLIENT_ID}}/g, googleClientId)
    .replace(/{{CHROME_EXTENSION_PUBLIC_KEY}}/g, chromeExtensionPublicKey);
  const manifest = JSON.parse(template);
  manifest.version = packageVersion || manifest.version;
  addTokenProxyHostPermission(manifest);

  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
  console.log("✓ manifest.json generated");
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

async function build() {
  logTokenProxyStatus();
  logPlayerHostStatus();

  if (!watch) {
    fs.rmSync(path.resolve(__dirname, "dist"), { recursive: true, force: true });
  }

  const swCtx = await esbuild.context({
    ...commonOptions,
    entryPoints: ["src/background/service-worker.ts"],
    outfile: "dist/background/service-worker.js",
    format: "esm",
  });

  const uiCtx = await esbuild.context({
    ...commonOptions,
    entryPoints: [
      { in: "src/popup/popup.ts", out: "popup/popup" },
      { in: "src/offscreen/offscreen.ts", out: "offscreen/offscreen" },
      { in: "src/annotate/annotate.ts", out: "annotate/annotate" },
    ],
    outdir: "dist",
    format: "iife",
  });

  const contentCtx = await esbuild.context({
    ...commonOptions,
    entryPoints: [
      { in: "src/content/recording-events.ts", out: "content/recording-events" },
      { in: "src/content/drawing-overlay.ts", out: "content/drawing-overlay" },
      { in: "src/content/instant-replay.ts", out: "content/instant-replay" },
      { in: "src/content/instant-replay-evidence.ts", out: "content/instant-replay-evidence" },
    ],
    outdir: "dist",
    format: "iife",
    sourcemap: false,
  });

  if (watch) {
    await Promise.all([swCtx.watch(), uiCtx.watch(), contentCtx.watch()]);
    syncExtensionAssets();
    watchExtensionAssets();
    console.log("Watching extension sources...");
    return;
  }

  await Promise.all([swCtx.rebuild(), uiCtx.rebuild(), contentCtx.rebuild()]);
  await Promise.all([swCtx.dispose(), uiCtx.dispose(), contentCtx.dispose()]);
  syncExtensionAssets();

  console.log("Extension built.");
}

function copyStaticAssets() {
  for (const entry of STATIC_ASSET_ENTRIES) {
    if (entry.type === "text") {
      copyTextFile(entry.src, entry.dest);
    } else if (entry.type === "dir") {
      copyDir(entry.src, entry.dest);
    } else {
      copyFile(entry.src, entry.dest);
    }
  }
}

function syncExtensionAssets() {
  generateManifest("dist/manifest.json");
  copyStaticAssets();
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
