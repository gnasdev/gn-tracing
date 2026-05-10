import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const require = createRequire(import.meta.url);
const crx3 = require("crx3");

const EXTENSION_CRX = "gn-tracing-extension.crx";
const UPDATE_MANIFEST = "updates.xml";
const DEFAULT_REPOSITORY = "gnasdev/gn-tracing";

// Release signing must use the private key that corresponds to the committed
// manifest public key. That keeps the extension id stable across GitHub releases
// and allows self-hosted Chrome updates to target already-installed copies.
function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function getExtensionIdFromPublicKey(publicKey) {
  const der = Buffer.from(publicKey, "base64");
  const digest = crypto.createHash("sha256").update(der).digest();
  const alphabet = "abcdefghijklmnop";
  let id = "";

  for (const byte of digest.subarray(0, 16)) {
    id += alphabet[byte >> 4] + alphabet[byte & 15];
  }

  return id;
}

function getPrivateKeyPath() {
  const configuredPath = process.env.CHROME_EXTENSION_PRIVATE_KEY_PATH;
  if (configuredPath) {
    return configuredPath;
  }

  const privateKey = process.env.CHROME_EXTENSION_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error(
      "Missing CHROME_EXTENSION_PRIVATE_KEY or CHROME_EXTENSION_PRIVATE_KEY_PATH. " +
        "Release CRX signing requires the private key that matches manifest.template.json key.",
    );
  }

  const keyPath = path.join(os.tmpdir(), "gn-tracing-release-key.pem");
  fs.writeFileSync(keyPath, privateKey.replace(/\\n/g, "\n"), { mode: 0o600 });
  return keyPath;
}

const cwd = process.cwd();
const distDir = path.join(cwd, "dist");
const manifestPath = path.join(distDir, "manifest.json");

if (!fs.existsSync(manifestPath)) {
  throw new Error("dist/manifest.json is missing. Run npm run release:build before packing CRX.");
}

const manifest = readJson(manifestPath);
const expectedAppId = getExtensionIdFromPublicKey(manifest.key);
const repository = process.env.GITHUB_REPOSITORY || DEFAULT_REPOSITORY;
const crxUrl = `https://github.com/${repository}/releases/latest/download/${EXTENSION_CRX}`;
const keyPath = getPrivateKeyPath();

const result = await crx3([distDir], {
  keyPath,
  crxPath: path.join(cwd, EXTENSION_CRX),
  xmlPath: path.join(cwd, UPDATE_MANIFEST),
  crxURL: crxUrl,
  appVersion: manifest.version,
});

if (result.appId !== expectedAppId) {
  throw new Error(
    `CRX app id ${result.appId} does not match manifest key app id ${expectedAppId}. ` +
      "Use the private key that matches manifest.template.json.",
  );
}

console.log(`Created ${EXTENSION_CRX}`);
console.log(`Created ${UPDATE_MANIFEST}`);
console.log(`Extension ID: ${result.appId}`);
console.log(`Update codebase: ${crxUrl}`);
