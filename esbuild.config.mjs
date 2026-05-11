/**
 * Builds the Manifest V3 extension and copies the static replay player assets.
 *
 * The root package owns extension bundling; the standalone player has its own
 * Vite build under `player-standalone/`.
 */
import * as esbuild from "esbuild";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envVars = loadEnvFile(path.resolve(__dirname, ".env"));
const DEFAULT_GOOGLE_CLIENT_ID = "95916347176-ulk25djm5l4g6ebq7vftjik8iv9a11vf.apps.googleusercontent.com";
const DEFAULT_CHROME_EXTENSION_PUBLIC_KEY = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAjDxBQBIrG2c71RP7pfCDOIDtdcgHOTv4DFIXpFgH96fFdK7AQJ5jIgCfH5GR5+8EVgzFVk6MzJL6qjxIzJrB9APYHDpjeV64izWJIiwL6JOGBh10HqUWSPLu1dj/ccjJLmmxcBJRp4Dq5/MnKnKrLfuFyHtQMlB9jNXcozgAPBLiVD03FM7xgnf5AtMAXjjONhCaJT8eLkBEqlXk0NztNosUOy99i6TOro8ZXAM9Wlr1RlaL9iw/V62CDWC2AVYn3bD8pM42cf9vdaVfAYHfftp8T3V+sN2WZ0N0sZaYl6YoahAoXUQ9audQMQgSIX7cY0GAqsbcY/gQTiyDTtEuawIDAQAB";
const googleClientId = getConfigValue("GOOGLE_CLIENT_ID", DEFAULT_GOOGLE_CLIENT_ID);
const chromeExtensionPublicKey = getConfigValue("CHROME_EXTENSION_PUBLIC_KEY", DEFAULT_CHROME_EXTENSION_PUBLIC_KEY);
const chromeExtensionPrivateKey = getConfigValue("CHROME_EXTENSION_PRIVATE_KEY");
const chromeExtensionId = getConfigValue("CHROME_EXTENSION_ID", getChromeExtensionId(chromeExtensionPublicKey));
const cliEnv = getCliArgValue("--env");
const watch = process.argv.includes("--watch");
const rawAppEnv = cliEnv || (watch ? "development" : "production");
const appEnv = normalizeAppEnv(rawAppEnv);
const playerLocalPort = process.env.PLAYER_LOCAL_PORT || "5173";

// The root build emits the unpacked MV3 extension. Player assets are copied as
// static files because the extension and hosted player intentionally share the
// same browser runtime under `player/`.
const commonOptions = {
  bundle: true,
  target: "chrome120",
  sourcemap: true,
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

function getChromeExtensionId(publicKey) {
  const keyBytes = Buffer.from(publicKey, "base64");
  const hash = crypto.createHash("sha256").update(keyBytes).digest();
  return Array.from(hash.subarray(0, 16), (byte) =>
    byte
      .toString(16)
      .padStart(2, "0")
      .replace(/[0-9a-f]/g, (char) => String.fromCharCode("a".charCodeAt(0) + Number.parseInt(char, 16))),
  ).join("");
}

function validateChromeExtensionIdentity() {
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
  const normalized = String(value || "").trim().toLowerCase();
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

  fs.writeFileSync(manifestPath, template, "utf-8");
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
      { in: "src/offscreen/offscreen.ts", out: "offscreen/offscreen" },
      { in: "src/drive-auth/drive-auth.ts", out: "drive-auth/drive-auth" },
    ],
    outdir: "dist",
    format: "iife",
  });

  if (watch) {
    await Promise.all([swCtx.watch(), uiCtx.watch()]);
    generateManifest("dist/manifest.json");
    copyStaticAssets();
    console.log("Watching extension sources...");
    return;
  }

  await Promise.all([swCtx.rebuild(), uiCtx.rebuild()]);
  await Promise.all([swCtx.dispose(), uiCtx.dispose()]);
  generateManifest("dist/manifest.json");
  copyStaticAssets();

  console.log("Extension built.");
}

function copyStaticAssets() {
  copyTextFile("popup/popup.html", "dist/popup/popup.html");
  copyFile("popup/popup.css", "dist/popup/popup.css");
  copyTextFile("history/history.html", "dist/history/history.html");
  copyFile("history/history.css", "dist/history/history.css");
  copyTextFile("offscreen/offscreen.html", "dist/offscreen/offscreen.html");
  copyTextFile("drive-auth/drive-auth.html", "dist/drive-auth/drive-auth.html");
  copyDir("icons", "dist/icons");
  copyFile("player/player.html", "dist/player/player.html");
  copyFile("player/player.css", "dist/player/player.css");
  copyFile("player/player.js", "dist/player/player.js");
  copyDir("player/icons", "dist/player/icons");
}

build().catch((e) => {
  console.error(e);
  process.exit(1);
});
