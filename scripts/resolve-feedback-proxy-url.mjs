#!/usr/bin/env node
/**
 * Resolves the hosted-player feedback Worker URL using the same pure helper as
 * the extension build (`resolveVersionedWorkerEndpoints`).
 *
 * Prints a single line: the full POST /{version}/feedback URL.
 * Exit 1 when no Worker origin can be derived.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  pickWorkerOrigin,
  resolveVersionedWorkerEndpoints,
} from "../packages/replay-core/src/route-version.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
const version = String(packageJson.version || "").trim();

const explicit = String(
  process.env.VITE_FEEDBACK_PROXY_URL || process.env.FEEDBACK_PROXY_URL || "",
).trim();
const google = String(process.env.GOOGLE_TOKEN_PROXY_URL || "").trim();
const dropbox = String(process.env.DROPBOX_TOKEN_PROXY_URL || "").trim();

const configured = pickWorkerOrigin(explicit, google, dropbox) || explicit;
if (!configured) {
  console.error(
    "Could not resolve feedback proxy: set VITE_FEEDBACK_PROXY_URL, FEEDBACK_PROXY_URL, " +
      "or GOOGLE_TOKEN_PROXY_URL / DROPBOX_TOKEN_PROXY_URL.",
  );
  process.exit(1);
}

const { feedbackUrl } = resolveVersionedWorkerEndpoints(configured, version);
if (!feedbackUrl) {
  console.error("Could not join versioned feedback URL.");
  process.exit(1);
}
process.stdout.write(`${feedbackUrl}\n`);
