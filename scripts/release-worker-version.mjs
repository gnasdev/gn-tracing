#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getReleaseByVersion,
  parseReleaseRegistry,
} from "../packages/release-registry/src/index.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const deploy = process.argv.includes("--deploy");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const version = String(packageJson.version || "").trim();
const registry = parseReleaseRegistry(
  fs.readFileSync(path.join(root, "releases/registry.json"), "utf8"),
);
const release = getReleaseByVersion(registry, version);

if (!release) {
  throw new Error(
    `Release ${version} is absent from releases/registry.json. Add its verified immutable entry before deployment.`,
  );
}
const expectedServiceName = `gn-tracing-oauth-proxy-v${version.replaceAll(".", "-")}`;
const expectedBindingName = `WORKER_${version.replaceAll(".", "_")}`;
if (
  release.worker.serviceName !== expectedServiceName ||
  release.worker.bindingName !== expectedBindingName
) {
  throw new Error(
    `Release ${version} Worker service or binding does not match the deterministic naming contract.`,
  );
}
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
if (!sourceCommit.startsWith(release.worker.sourceCommit)) {
  throw new Error(
    `Release ${version} must be deployed from pinned source commit ${release.worker.sourceCommit}, not ${sourceCommit}.`,
  );
}

execFileSync(
  process.execPath,
  ["--experimental-strip-types", "scripts/generate-worker-router-config.mjs"],
  {
    cwd: root,
    stdio: "inherit",
  },
);
console.log(`✓ Immutable Worker release ${version} is ready for ${release.worker.serviceName}.`);

if (!deploy) {
  console.log(
    "No deployment performed. Re-run with --deploy after reviewing the generated router bindings.",
  );
  process.exit(0);
}

execFileSync("bash", ["worker/deploy.sh"], {
  cwd: root,
  env: { ...process.env, WORKER_SERVICE_NAME: release.worker.serviceName },
  stdio: "inherit",
});
