#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getReleaseByVersion,
  parseReleaseRegistry,
} from "../packages/release-registry/src/index.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(root, process.argv[2] || "edge/player-router/wrangler.generated.toml");
const registryPath = path.join(root, "releases/registry.json");
const registry = parseReleaseRegistry(fs.readFileSync(registryPath, "utf8"));
const requireLatest = process.argv.includes("--require-latest");
const latestVersion = String(process.env.LATEST_RELEASE_VERSION || "").trim();

if (requireLatest && !latestVersion) {
  throw new Error("LATEST_RELEASE_VERSION is required when deploying the Player router.");
}
if (latestVersion && !getReleaseByVersion(registry, latestVersion)) {
  throw new Error(`LATEST_RELEASE_VERSION ${latestVersion} is absent from releases/registry.json.`);
}

const config = [
  'name = "gn-tracing-player-router"',
  'main = "src/worker.ts"',
  'compatibility_date = "2024-11-01"',
  "",
  "[[r2_buckets]]",
  'binding = "PLAYER_RELEASES"',
  'bucket_name = "gn-tracing-player-releases"',
  "",
  "[vars]",
  `LATEST_RELEASE_VERSION = ${JSON.stringify(latestVersion)}`,
  "",
].join("\n");

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, config);
console.log(
  `✓ Generated ${path.relative(root, output)} (legacy alias: ${latestVersion || "disabled"}).`,
);
