/**
 * Builds the Manifest V3 extension and copies the static replay player assets.
 *
 * The root package owns extension bundling; the standalone player has its own
 * Vite build under `player-standalone/`.
 */

import crypto from "crypto";
import * as esbuild from "esbuild";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envVars = loadEnvFile(path.resolve(__dirname, ".env"));
const cliEnv = getCliArgValue("--env");
const watch = process.argv.includes("--watch");
const rawAppEnv = cliEnv || (watch ? "development" : "production");
const appEnv = normalizeAppEnv(rawAppEnv);
const isProductionBuild = appEnv === "production";
const DEFAULT_GOOGLE_CLIENT_ID =
  "95916347176-ulk25djm5l4g6ebq7vftjik8iv9a11vf.apps.googleusercontent.com";
const DEFAULT_CHROME_EXTENSION_PUBLIC_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAjDxBQBIrG2c71RP7pfCDOIDtdcgHOTv4DFIXpFgH96fFdK7AQJ5jIgCfH5GR5+8EVgzFVk6MzJL6qjxIzJrB9APYHDpjeV64izWJIiwL6JOGBh10HqUWSPLu1dj/ccjJLmmxcBJRp4Dq5/MnKnKrLfuFyHtQMlB9jNXcozgAPBLiVD03FM7xgnf5AtMAXjjONhCaJT8eLkBEqlXk0NztNosUOy99i6TOro8ZXAM9Wlr1RlaL9iw/V62CDWC2AVYn3bD8pM42cf9vdaVfAYHfftp8T3V+sN2WZ0N0sZaYl6YoahAoXUQ9audQMQgSIX7cY0GAqsbcY/gQTiyDTtEuawIDAQAB";
const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, "package.json"), "utf-8"));
const packageVersion = typeof packageJson.version === "string" ? packageJson.version : "";
const googleClientId = getConfigValue(
  "GOOGLE_CLIENT_ID",
  isProductionBuild ? "" : DEFAULT_GOOGLE_CLIENT_ID,
);
const chromeExtensionPublicKey = getConfigValue(
  "CHROME_EXTENSION_PUBLIC_KEY",
  isProductionBuild ? "" : DEFAULT_CHROME_EXTENSION_PUBLIC_KEY,
);
const chromeExtensionPrivateKey = getConfigValue("CHROME_EXTENSION_PRIVATE_KEY");
const chromeExtensionId = getConfigValue(
  "CHROME_EXTENSION_ID",
  chromeExtensionPublicKey ? getChromeExtensionId(chromeExtensionPublicKey) : "",
);
const playerLocalPort = getConfigValue("PLAYER_LOCAL_PORT", "5176");
const STATIC_ASSET_ENTRIES = [
  { type: "text", src: "popup/popup.html", dest: "dist/popup/popup.html" },
  { type: "file", src: "popup/popup.css", dest: "dist/popup/popup.css" },
  { type: "text", src: "history/history.html", dest: "dist/history/history.html" },
  { type: "file", src: "history/history.css", dest: "dist/history/history.css" },
  { type: "text", src: "settings/settings.html", dest: "dist/settings/settings.html" },
  { type: "file", src: "settings/settings.css", dest: "dist/settings/settings.css" },
  { type: "text", src: "offscreen/offscreen.html", dest: "dist/offscreen/offscreen.html" },
  { type: "text", src: "drive-auth/drive-auth.html", dest: "dist/drive-auth/drive-auth.html" },
  { type: "dir", src: "icons", dest: "dist/icons" },
  { type: "file", src: "shared/theme.css", dest: "dist/shared/theme.css" },
  { type: "file", src: "shared/theme-init.js", dest: "dist/shared/theme-init.js" },
  { type: "file", src: "player/player.html", dest: "dist/player/player.html" },
  { type: "file", src: "player/player.css", dest: "dist/player/player.css" },
  { type: "file", src: "player/player.js", dest: "dist/player/player.js" },
  { type: "dir", src: "player/icons", dest: "dist/player/icons" },
];
const staticAssetWatchers = [];

// The root build emits the unpacked MV3 extension. Player assets are copied as
// static files because the extension and hosted player intentionally share the
// same browser runtime under `player/`.
const commonOptions = {
  bundle: true,
  target: "chrome120",
  sourcemap: !isProductionBuild,
  minify: false,
  define: {
    __APP_ENV__: JSON.stringify(appEnv),
    __GOOGLE_CLIENT_ID__: JSON.stringify(googleClientId),
    __PLAYER_LOCAL_PORT__: JSON.stringify(playerLocalPort),
  },
};

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
  if (isProductionBuild && !googleClientId) {
    throw new Error("GOOGLE_CLIENT_ID is required for production builds.");
  }

  if (isProductionBuild && !hasConfigValue("CHROME_EXTENSION_ID")) {
    throw new Error("CHROME_EXTENSION_ID is required for production builds.");
  }

  if (!chromeExtensionPublicKey) {
    throw new Error("CHROME_EXTENSION_PUBLIC_KEY is required to generate manifest.json.");
  }

  if (chromeExtensionPrivateKey && !chromeExtensionPrivateKey.includes("PRIVATE KEY")) {
    console.warn("CHROME_EXTENSION_PRIVATE_KEY is set but does not look like a PEM private key.");
  }

  const derivedExtensionId = getChromeExtensionId(chromeExtensionPublicKey);
  if (chromeExtensionId !== derivedExtensionId) {
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

  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
  console.log("✓ manifest.json generated");
}

async function build() {
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
      { in: "src/history/history.ts", out: "history/history" },
      { in: "src/settings/settings.ts", out: "settings/settings" },
      { in: "src/offscreen/offscreen.ts", out: "offscreen/offscreen" },
      { in: "src/drive-auth/drive-auth.ts", out: "drive-auth/drive-auth" },
    ],
    outdir: "dist",
    format: "iife",
  });

  const contentCtx = await esbuild.context({
    ...commonOptions,
    entryPoints: [{ in: "src/content/recording-events.ts", out: "content/recording-events" }],
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
