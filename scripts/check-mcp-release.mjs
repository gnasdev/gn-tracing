/**
 * Guards the publishable agent artifacts against the mistakes that only surface
 * at publish time — or worse, after publish.
 *
 * Four things have to agree before `mcp-publisher` will accept a release, and
 * nothing in the normal build touches them together:
 *
 * 1. `mcp/package.json#mcpName` must equal `mcp/server.json#name` (the registry
 *    verifies npm ownership through that marker).
 * 2. Versions must match across `package.json`, `server.json`, and the npm
 *    package entry inside `server.json`.
 * 3. `server.json` must point at the npm package that is actually published.
 * 4. Plugin files must not be git-ignored. The repo ignores `.mcp.json`
 *    globally, so a distributed plugin can lose its MCP server declaration and
 *    still look fine locally — the plugin would install with zero tools.
 *
 * Usage: node scripts/check-mcp-release.mjs
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];

function readJson(relativePath) {
  const absolute = path.join(rootDir, relativePath);
  if (!fs.existsSync(absolute)) {
    problems.push(`${relativePath} is missing.`);
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(absolute, "utf8"));
  } catch (error) {
    problems.push(`${relativePath} is not valid JSON: ${error.message}`);
    return null;
  }
}

const pkg = readJson("mcp/package.json");
const server = readJson("mcp/server.json");
const marketplace = readJson(".claude-plugin/marketplace.json");
const plugin = readJson("plugins/gn-tracing/.claude-plugin/plugin.json");

if (pkg && server) {
  if (pkg.mcpName !== server.name) {
    problems.push(
      `mcp/package.json#mcpName (${pkg.mcpName}) must equal mcp/server.json#name (${server.name}); the registry rejects the release otherwise.`,
    );
  }
  if (pkg.version !== server.version) {
    problems.push(
      `Version mismatch: mcp/package.json is ${pkg.version}, mcp/server.json is ${server.version}.`,
    );
  }

  const npmPackage = (server.packages ?? []).find((entry) => entry.registryType === "npm");
  if (!npmPackage) {
    problems.push("mcp/server.json lists no npm package.");
  } else {
    if (npmPackage.identifier !== pkg.name) {
      problems.push(
        `mcp/server.json npm identifier (${npmPackage.identifier}) does not match the published package name (${pkg.name}).`,
      );
    }
    if (npmPackage.version !== pkg.version) {
      problems.push(
        `mcp/server.json npm package version (${npmPackage.version}) does not match mcp/package.json (${pkg.version}).`,
      );
    }
  }

  if (pkg.private) {
    problems.push("mcp/package.json is marked private and cannot be published.");
  }

  // `files` is the publish allowlist; the bin must be inside it or the installed
  // package has no executable.
  const binPath = typeof pkg.bin === "object" ? Object.values(pkg.bin)[0] : pkg.bin;
  if (
    binPath &&
    Array.isArray(pkg.files) &&
    !pkg.files.some((entry) => binPath.startsWith(entry.replace(/\/$/, "")))
  ) {
    problems.push(`mcp/package.json bin (${binPath}) is not covered by the "files" allowlist.`);
  }
}

if (marketplace && plugin) {
  const entry = (marketplace.plugins ?? []).find((candidate) => candidate.name === plugin.name);
  if (!entry) {
    problems.push(
      `.claude-plugin/marketplace.json has no entry named "${plugin.name}"; users could not install it.`,
    );
  } else if (entry.version !== plugin.version) {
    problems.push(
      `Plugin version mismatch: marketplace entry is ${entry.version}, plugin.json is ${plugin.version}.`,
    );
  }
}

// Distributed plugin files must actually be committed.
const mustBeTracked = [
  ".claude-plugin/marketplace.json",
  "plugins/gn-tracing/.claude-plugin/plugin.json",
  "plugins/gn-tracing/.mcp.json",
  "plugins/gn-tracing/skills/gn-tracing-replay/SKILL.md",
];

for (const relativePath of mustBeTracked) {
  if (!fs.existsSync(path.join(rootDir, relativePath))) {
    problems.push(`${relativePath} is missing from the plugin.`);
    continue;
  }
  try {
    // Exit 0 means "ignored" — which for these files is a shipping bug.
    execFileSync("git", ["check-ignore", "-q", relativePath], { cwd: rootDir, stdio: "ignore" });
    problems.push(
      `${relativePath} is git-ignored, so it would never reach users. Add a negation to .gitignore.`,
    );
  } catch {
    // Non-zero exit: not ignored. Good.
  }
}

if (problems.length > 0) {
  console.error("MCP release check failed:\n");
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  process.exit(1);
}

console.log(
  `MCP release check passed (${pkg?.name}@${pkg?.version} as ${server?.name}, plugin ${plugin?.name}@${plugin?.version}).`,
);
