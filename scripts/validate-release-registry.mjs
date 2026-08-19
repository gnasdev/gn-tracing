#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertAppendOnlyReleaseRegistry,
  parseReleaseRegistry,
} from "../packages/release-registry/src/index.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [registryArg = "releases/registry.json", previousArg] = process.argv.slice(2);

function readJson(file) {
  return fs.readFileSync(path.resolve(root, file), "utf8");
}

try {
  const registry = parseReleaseRegistry(readJson(registryArg));
  assertAppendOnlyReleaseRegistry(
    previousArg ? readJson(previousArg) : readCommittedRegistry(),
    registry,
  );
  console.log(`✓ Release registry valid (${registry.releases.length} immutable release entries).`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
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
