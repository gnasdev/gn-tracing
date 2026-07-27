/**
 * Mirrors the published plugin's skills into the local agent tool directories.
 *
 * The source of truth is `plugins/<plugin>/skills/`, because that is what ships
 * to users through the Claude Code marketplace. `.claude/` and `.agents/` are
 * git-ignored (local agent state plus skills vendored from elsewhere, tracked by
 * `skills-lock.json`), so this copies the published skill into them — the same
 * source-plus-mirror shape as `task player:sync`. Editing the mirror instead of
 * the source loses the change on the next sync AND ships nothing to users.
 *
 * Usage: node scripts/sync-agent-assets.mjs
 * Re-run after editing anything under a plugin's `skills/` directory.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const pluginsDir = path.join(rootDir, "plugins");

/** Agent tools that read skills from a well-known directory. */
const TARGET_SKILL_DIRS = [
  path.join(rootDir, ".claude", "skills"),
  path.join(rootDir, ".agents", "skills"),
];

if (!fs.existsSync(pluginsDir)) {
  console.log("No plugins directory; nothing to sync.");
  process.exit(0);
}

/** Every `plugins/<plugin>/skills/<skill>` directory, in publish order. */
const skills = [];
for (const plugin of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
  if (!plugin.isDirectory()) {
    continue;
  }
  const skillsDir = path.join(pluginsDir, plugin.name, "skills");
  if (!fs.existsSync(skillsDir)) {
    continue;
  }
  for (const skill of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (skill.isDirectory()) {
      skills.push({ name: skill.name, from: path.join(skillsDir, skill.name) });
    }
  }
}

if (skills.length === 0) {
  console.log("No skills found under plugins/*/skills.");
  process.exit(0);
}

let copiedFiles = 0;

for (const targetDir of TARGET_SKILL_DIRS) {
  for (const skill of skills) {
    const to = path.join(targetDir, skill.name);
    fs.mkdirSync(to, { recursive: true });
    copiedFiles += copyDirectory(skill.from, to);
  }
}

console.log(
  `Synced ${skills.length} skill(s) (${copiedFiles} file copies) into ${TARGET_SKILL_DIRS.length} agent directories.`,
);
console.log(`Skills: ${skills.map((skill) => skill.name).join(", ")}`);

/** Recursively copies a directory, returning the number of files written. */
function copyDirectory(from, to) {
  let count = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const sourcePath = path.join(from, entry.name);
    const targetPath = path.join(to, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(targetPath, { recursive: true });
      count += copyDirectory(sourcePath, targetPath);
      continue;
    }
    fs.copyFileSync(sourcePath, targetPath);
    count += 1;
  }
  return count;
}
