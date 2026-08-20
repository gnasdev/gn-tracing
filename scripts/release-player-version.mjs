#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getReleaseByVersion,
  parseReleaseRegistry,
} from "../packages/release-registry/src/index.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const upload = process.argv.includes("--upload");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const version = String(packageJson.version || "").trim();
const registry = parseReleaseRegistry(
  fs.readFileSync(path.join(root, "releases/registry.json"), "utf8"),
);
const release = getReleaseByVersion(registry, version);
const bucket = process.env.PLAYER_RELEASES_BUCKET || "gn-tracing-player-releases";
const dist = path.join(root, "player/dist");

if (!release) {
  throw new Error(
    `Release ${version} is absent from releases/registry.json. Add its verified immutable entry before preparing artifacts.`,
  );
}
if (release.player.r2Prefix !== `player/${version}/`) {
  throw new Error(`Release ${version} has an invalid Player R2 prefix.`);
}
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
if (!sourceCommit.startsWith(release.sourceCommit)) {
  throw new Error(
    `Release ${version} must be built from pinned source commit ${release.sourceCommit}, not ${sourceCommit}.`,
  );
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

const files = listFiles(dist);
const hashes = Object.fromEntries(
  files.map((file) => [file, sha256(fs.readFileSync(path.join(dist, file)))]),
);
const artifactSha256 = `sha256:${sha256(Buffer.from(JSON.stringify(hashes)))}`;
if (artifactSha256 !== release.player.sha256) {
  throw new Error(
    `Release ${version} artifact checksum mismatch. Registry=${release.player.sha256}, build=${artifactSha256}.`,
  );
}

const manifest = {
  version,
  sourceCommit: release.sourceCommit,
  artifactSha256,
  files: hashes,
  feedbackUrl,
};
fs.writeFileSync(path.join(dist, "release.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`✓ Prepared immutable Player ${version} (${files.length} files, ${artifactSha256}).`);

if (!upload) {
  console.log("No upload performed. Re-run with --upload after reviewing the generated artifact.");
  process.exit(0);
}

const temporaryFile = path.join(os.tmpdir(), `gn-tracing-${version}-release.json`);
let existingRelease = false;
try {
  execFileSync(
    "npx",
    [
      "wrangler",
      "r2",
      "object",
      "get",
      `${bucket}/${release.player.r2Prefix}release.json`,
      "--file",
      temporaryFile,
      "--remote",
    ],
    { cwd: root, stdio: "pipe" },
  );
  existingRelease = true;
} catch (error) {
  const detail = [error?.stdout, error?.stderr].filter(Boolean).join("\n");
  if (!/(404|NoSuchKey|not found|does not exist)/i.test(detail)) {
    throw new Error(
      `Could not verify whether Player release ${version} already exists in R2: ${detail}`,
    );
  }
} finally {
  fs.rmSync(temporaryFile, { force: true });
}
if (existingRelease) {
  throw new Error(`Release ${version} already exists in R2 and cannot be overwritten.`);
}

for (const file of [...files, "release.json"]) {
  execFileSync(
    "npx",
    [
      "wrangler",
      "r2",
      "object",
      "put",
      `${bucket}/${release.player.r2Prefix}${file}`,
      "--file",
      path.join(dist, file),
      "--remote",
    ],
    { cwd: root, stdio: "inherit" },
  );
}
console.log(
  `✓ Uploaded immutable Player release ${version} to ${bucket}/${release.player.r2Prefix}`,
);

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
