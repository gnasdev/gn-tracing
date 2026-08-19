#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getReleaseByVersion,
  parseReleaseRegistry,
} from "../packages/release-registry/src/index.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputArgument = process.argv.slice(2).find((argument) => !argument.startsWith("--"));
const output = path.resolve(root, outputArgument || "edge/worker-router/wrangler.generated.toml");
const registryPath = path.join(root, "releases/registry.json");
const registry = parseReleaseRegistry(fs.readFileSync(registryPath, "utf8"));
const requireLatest = process.argv.includes("--require-latest");
const latestVersion = String(process.env.LATEST_RELEASE_VERSION || "").trim();

if (requireLatest && !latestVersion) {
  throw new Error("LATEST_RELEASE_VERSION is required when deploying the Worker router.");
}
if (latestVersion && !getReleaseByVersion(registry, latestVersion)) {
  throw new Error(`LATEST_RELEASE_VERSION ${latestVersion} is absent from releases/registry.json.`);
}

const lines = [
  'name = "gn-tracing-oauth-proxy"',
  'main = "src/worker.ts"',
  'compatibility_date = "2024-11-01"',
  "workers_dev = true",
  "",
  "[vars]",
  `LATEST_RELEASE_VERSION = ${JSON.stringify(latestVersion)}`,
  "",
];

for (const release of registry.releases) {
  lines.push("[[services]]");
  lines.push(`binding = "${release.worker.bindingName}"`);
  lines.push(`service = "${release.worker.serviceName}"`);
  lines.push("");
}

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${lines.join("\n")}\n`);
console.log(
  `✓ Generated ${path.relative(root, output)} (${registry.releases.length} immutable bindings).`,
);
