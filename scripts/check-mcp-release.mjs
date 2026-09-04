/**
 * Guards the publishable agent artifacts against the mistakes that only surface
 * at publish time — or worse, after publish.
 *
 * Seven things have to agree before a release is safe, and nothing in the normal
 * build touches them together:
 *
 * 1. `mcp/package.json#mcpName` must equal `mcp/server.json#name` (the registry
 *    verifies npm ownership through that marker).
 * 2. Versions must match across `package.json`, `server.json`, and the npm
 *    package entry inside `server.json`.
 * 3. `MCP_SERVER_VERSION` in `mcp/src/version.ts` — what both transports
 *    announce in the `initialize` handshake — must equal the published
 *    `mcp/package.json#version`, or a 1.1.0 package keeps introducing itself as
 *    1.0.0 over the wire.
 * 4. `server.json` must point at the npm package that is actually published.
 * 5. Plugin files must not be git-ignored. The repo ignores `.mcp.json`
 *    globally, so a distributed plugin can lose its MCP server declaration and
 *    still look fine locally — the plugin would install with zero tools.
 * 6. Every shipped skill needs valid frontmatter: a `name` equal to its
 *    directory (that is how an agent addresses the skill) and a non-empty
 *    `description` under 1024 characters (that is the only text an agent sees
 *    when deciding whether the skill applies).
 * 7. Local agent mirrors under `.claude/` and `.agents/` must not have diverged
 *    from the plugin skill sources. A missing mirror is fine — the mirrors are
 *    git-ignored and absent on a fresh clone — but a divergent one means someone
 *    edited a copy, so the change ships to nobody.
 *
 * Checks 6 and 7 live here rather than in the Vitest suite because this script
 * runs on every `npm run check`, whereas the pre-commit hook only runs `vitest
 * related` against staged root TypeScript files — a skill edit is Markdown-only and
 * would match no test, making a Vitest-only guard silent in exactly the case it
 * exists to catch.
 *
 * Usage: node scripts/check-mcp-release.mjs
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];

/** Agent tool directories that `scripts/sync-agent-assets.mjs` mirrors skills into. */
const MIRROR_SKILL_DIRS = [".claude/skills", ".agents/skills"];

/** Frontmatter descriptions feed a model's skill-selection prompt, which is budgeted. */
const MAX_DESCRIPTION_LENGTH = 1024;

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

  // Read as text, not import: this script is plain .mjs and cannot load TypeScript.
  checkHandshakeVersion(pkg.version);
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

const skills = discoverSkills();
if (skills.length === 0) {
  problems.push("No skills found under plugins/*/skills/*/SKILL.md; the plugin would ship none.");
}

// Distributed plugin files must actually be committed. Skill paths are discovered
// rather than listed: a hardcoded list silently stops covering the skill added
// after it was written, which is the failure this whole file exists to prevent.
const mustBeTracked = [
  ".claude-plugin/marketplace.json",
  "plugins/gn-tracing/.claude-plugin/plugin.json",
  "plugins/gn-tracing/.mcp.json",
  ...skills.map((skill) => skill.manifestPath),
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

for (const skill of skills) {
  checkSkillFrontmatter(skill);
  checkMirrors(skill);
}

if (problems.length > 0) {
  console.error("MCP release check failed:\n");
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  process.exit(1);
}

console.log(
  `MCP release check passed (${pkg?.name}@${pkg?.version} as ${server?.name}, plugin ${plugin?.name}@${plugin?.version}, ${skills.length} skill(s) with mirrors in sync).`,
);

/** Every `plugins/<plugin>/skills/<skill>` directory found on disk. */
function discoverSkills() {
  const pluginsDir = path.join(rootDir, "plugins");
  if (!fs.existsSync(pluginsDir)) {
    return [];
  }
  const found = [];
  for (const pluginEntry of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!pluginEntry.isDirectory()) {
      continue;
    }
    const skillsDir = path.join(pluginsDir, pluginEntry.name, "skills");
    if (!fs.existsSync(skillsDir)) {
      continue;
    }
    for (const skillEntry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!skillEntry.isDirectory()) {
        continue;
      }
      found.push({
        name: skillEntry.name,
        dir: path.join(skillsDir, skillEntry.name),
        manifestPath: path.posix.join(
          "plugins",
          pluginEntry.name,
          "skills",
          skillEntry.name,
          "SKILL.md",
        ),
      });
    }
  }
  return found;
}

/** `MCP_SERVER_VERSION` is the version clients see; it must match the package. */
function checkHandshakeVersion(packageVersion) {
  const versionFile = path.join(rootDir, "mcp/src/version.ts");
  if (!fs.existsSync(versionFile)) {
    problems.push("mcp/src/version.ts is missing; both MCP transports read MCP_SERVER_VERSION.");
    return;
  }
  const match = /MCP_SERVER_VERSION\s*=\s*["']([^"']+)["']/.exec(
    fs.readFileSync(versionFile, "utf8"),
  );
  if (!match) {
    problems.push("mcp/src/version.ts does not export a string MCP_SERVER_VERSION.");
    return;
  }
  if (match[1] !== packageVersion) {
    problems.push(
      `MCP_SERVER_VERSION (${match[1]}) does not match mcp/package.json version (${packageVersion}); clients would see the wrong version in the initialize handshake. Edit mcp/src/version.ts.`,
    );
  }
}

/** A skill is addressed by its frontmatter `name` and selected by its `description`. */
function checkSkillFrontmatter(skill) {
  const manifest = path.join(rootDir, skill.manifestPath);
  if (!fs.existsSync(manifest)) {
    return; // Already reported by the tracked-files loop.
  }
  const source = fs.readFileSync(manifest, "utf8");
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  if (!frontmatter) {
    problems.push(`${skill.manifestPath} has no YAML frontmatter block; agents cannot load it.`);
    return;
  }

  const name = readFrontmatterField(frontmatter[1], "name");
  if (name === null) {
    problems.push(`${skill.manifestPath} frontmatter has no "name" field.`);
  } else if (name !== skill.name) {
    problems.push(
      `${skill.manifestPath} frontmatter name is "${name}" but its directory is "${skill.name}"; agents address the skill by directory and would never find it.`,
    );
  }

  const description = readFrontmatterField(frontmatter[1], "description");
  if (description === null || description.length === 0) {
    problems.push(
      `${skill.manifestPath} frontmatter needs a non-empty "description"; it is the only text an agent sees when deciding whether the skill applies.`,
    );
  } else if (description.length > MAX_DESCRIPTION_LENGTH) {
    problems.push(
      `${skill.manifestPath} frontmatter description is ${description.length} characters; keep it under ${MAX_DESCRIPTION_LENGTH}.`,
    );
  }
}

/** Reads a single-line scalar out of a frontmatter block. */
function readFrontmatterField(frontmatter, field) {
  const match = new RegExp(`^${field}:[ \\t]*(.*)$`, "m").exec(frontmatter);
  if (!match) {
    return null;
  }
  return match[1].trim().replace(/^["'](.*)["']$/, "$1");
}

/** A mirror that exists must be byte-identical; one that does not is simply unsynced. */
function checkMirrors(skill) {
  for (const relativeFile of listFiles(skill.dir)) {
    const source = path.join(skill.dir, relativeFile);
    for (const mirrorRoot of MIRROR_SKILL_DIRS) {
      const mirror = path.join(rootDir, mirrorRoot, skill.name, relativeFile);
      if (!fs.existsSync(mirror)) {
        continue;
      }
      if (!fs.readFileSync(mirror).equals(fs.readFileSync(source))) {
        problems.push(
          `${path.posix.join(mirrorRoot, skill.name, relativeFile)} has diverged from ${path.posix.join(
            skill.dir
              .slice(rootDir.length + 1)
              .split(path.sep)
              .join("/"),
            relativeFile,
          )}; run \`task agent:sync\`. The mirror is git-ignored, so an edit made there ships to nobody.`,
        );
      }
    }
  }
}

/** Relative paths of every file under a directory, recursively. */
function listFiles(dir, prefix = "") {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix ? path.posix.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) {
      files.push(...listFiles(path.join(dir, entry.name), relative));
      continue;
    }
    files.push(relative);
  }
  return files;
}
