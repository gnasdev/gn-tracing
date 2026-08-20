#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertAppendOnlyReleaseRegistry,
  getReleaseByVersion,
  parseReleaseRegistry,
} from "../packages/release-registry/src/index.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const write = process.argv.includes("--write");
const registryPath = path.join(root, "releases/registry.json");
const registryRaw = fs.readFileSync(registryPath, "utf8");
const registry = parseReleaseRegistry(registryRaw);
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const version = String(packageJson.version || "").trim();
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();

if (getReleaseByVersion(registry, version)) {
  throw new Error(`Release ${version} is already registered and immutable.`);
}

const feedbackUrl = execFileSync(
  process.execPath,
  ["--experimental-strip-types", "scripts/resolve-feedback-proxy-url.mjs"],
  { cwd: root, env: process.env, encoding: "utf8" },
).trim();
execFileSync("task", ["player:build:release"], {
  cwd: root,
  env: { ...process.env, VITE_BASE_PATH: `/${version}/`, VITE_FEEDBACK_PROXY_URL: feedbackUrl },
  stdio: "inherit",
});

const dist = path.join(root, "player/dist");
const hashes = Object.fromEntries(
  listFiles(dist).map((file) => [file, sha256(fs.readFileSync(path.join(dist, file)))]),
);
const entry = {
  version,
  sourceCommit,
  player: {
    r2Prefix: `player/${version}/`,
    sha256: `sha256:${sha256(Buffer.from(JSON.stringify(hashes)))}`,
    builtAt: new Date().toISOString(),
  },
  worker: {
    serviceName: `gn-tracing-oauth-proxy-v${version.replaceAll(".", "-")}`,
    bindingName: `WORKER_${version.replaceAll(".", "_")}`,
    sourceCommit,
  },
};

if (!write) {
  console.log(JSON.stringify(entry, null, 2));
  console.log(
    "No registry change performed. Review the candidate, then re-run with --write to append it.",
  );
  process.exit(0);
}

const next = { ...registry, releases: [...registry.releases, entry] };
assertAppendOnlyReleaseRegistry(registryRaw, next);
assertAppendOnlyReleaseRegistry(readCommittedRegistry(), next);
fs.writeFileSync(registryPath, `${JSON.stringify(next, null, 2)}\n`);
console.log(`✓ Appended immutable release ${version} to releases/registry.json.`);

function listFiles(directory) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory())
        return listFiles(fullPath).map((file) => path.join(entry.name, file));
      return [path.relative(directory, fullPath)];
    })
    .sort();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readCommittedRegistry() {
  try {
    return execFileSync("git", ["show", "HEAD:releases/registry.json"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return JSON.stringify({ schemaVersion: 1, releases: [] });
  }
}
