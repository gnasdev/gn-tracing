/**
 * Derives the Chrome extension id Chrome computes from a manifest `key`
 * (base64 SubjectPublicKeyInfo). Shared by esbuild.config.mjs (build-time
 * manifest generation) and sync-worker-dev-vars.mjs (local Worker allow-list)
 * so both stay in lockstep with Chrome's own derivation.
 */

import crypto from "node:crypto";

export function getChromeExtensionId(publicKeyBase64) {
  const keyBytes = Buffer.from(publicKeyBase64, "base64");
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
