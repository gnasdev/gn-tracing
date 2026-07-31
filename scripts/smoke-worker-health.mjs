#!/usr/bin/env node
/**
 * Post-deploy Worker health smoke: legacy /health and /{version}/health.
 * Usage: GOOGLE_TOKEN_PROXY_URL=https://…workers.dev node scripts/smoke-worker-health.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveVersionedWorkerEndpoints } from "../packages/replay-core/src/route-version.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8")).version;
const configured = String(process.env.GOOGLE_TOKEN_PROXY_URL || "").trim();
if (!configured) {
  console.error("GOOGLE_TOKEN_PROXY_URL is required");
  process.exit(1);
}

const { origin, healthUrl } = resolveVersionedWorkerEndpoints(configured, version);
if (!origin || !healthUrl) {
  console.error("Could not resolve Worker health URLs from GOOGLE_TOKEN_PROXY_URL");
  process.exit(1);
}

const legacyUrl = `${origin}/health`;

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${url} → HTTP ${res.status}`);
  }
  return res.json();
}

const legacy = await fetchJson(legacyUrl);
const versioned = await fetchJson(healthUrl);

if (!legacy.ok || !versioned.ok) {
  console.error("health ok=false", { legacy, versioned });
  process.exit(1);
}
if (versioned.requestRouteVersion !== version) {
  console.error(
    `expected requestRouteVersion ${version}, got ${JSON.stringify(versioned.requestRouteVersion)}`,
  );
  process.exit(1);
}

console.log(`✓ Worker health ok (legacy + /${version}/health)`);
