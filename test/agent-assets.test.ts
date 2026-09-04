/**
 * Guards agent-facing docs against naming things that do not exist.
 *
 * Every bug this file was written for had the same shape: a skill or developer
 * doc confidently named a tool (`source: "dom-snapshot"`), a field, or a Task
 * command (`task player:deploy`) that had been renamed or never existed. An
 * agent following those instructions calls the wrong thing and reports a
 * capability gap that is really a documentation bug — and nothing in the build
 * noticed, because prose does not compile.
 *
 * So the shipped skills' own references are resolved against the real
 * definitions on disk: MCP tool names against `TOOL_DEFINITIONS` in
 * `mcp/src/tools.ts`, and `task <name>` invocations against `Taskfile.yml`.
 *
 * Skill frontmatter validity and `.claude`/`.agents` mirror drift are checked by
 * `scripts/check-mcp-release.mjs` instead: that runs on every `npm run check`,
 * whereas the pre-commit hook only runs `vitest related` on staged root `*.ts`
 * files, which a Markdown-only skill edit never matches.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const PLUGIN_SKILLS_DIR = join(ROOT, "plugins", "gn-tracing", "skills");

/** Docs that instruct an agent to run Task commands. */
const TASK_REFERENCING_DOCS = [
  "DEVELOPER.md",
  ".agents/skills/verify-gn-tracing/SKILL.md",
] as const;

function read(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

/** Every shipped skill's `SKILL.md`, keyed by skill name. */
function readPluginSkills(): { name: string; source: string }[] {
  return readdirSync(PLUGIN_SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      source: readFileSync(join(PLUGIN_SKILLS_DIR, entry.name, "SKILL.md"), "utf8"),
    }));
}

/** Tool names as the MCP server actually registers them. */
function readToolNames(): string[] {
  const source = read("mcp/src/tools.ts");
  const definitions = source.slice(source.indexOf("TOOL_DEFINITIONS"));
  return [...definitions.matchAll(/^\s{4}name: "([a-z_]+)",$/gm)].map((match) => match[1]);
}

const taskNames = [...read("Taskfile.yml").matchAll(/^ {2}([a-z][\w:-]*):$/gm)].map(
  (match) => match[1],
);

/** Every backticked lowercase identifier in a skill, tool name or not. */
function backtickedIdentifiers(source: string): string[] {
  return [...source.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)*)`/g)].map((match) => match[1]);
}

/**
 * References that are shaped like a tool name. Single-word tools (`search`) are
 * indistinguishable from prose identifiers such as `notes` or `url`, so only
 * snake_case is treated as a claim that a tool exists — the coverage test below
 * catches a missing single-word tool from the other direction.
 */
function referencedToolNames(source: string): string[] {
  return backtickedIdentifiers(source).filter((name) => name.includes("_"));
}

/** `task <name>` invocations, with or without surrounding backticks. */
function referencedTaskNames(source: string): string[] {
  return [...source.matchAll(/`?task ([a-z][\w:-]*)/g)].map((match) => match[1]);
}

const skills = readPluginSkills();
const toolNames = readToolNames();

describe("agent assets: shipped skills reference real MCP tools", () => {
  it("finds the tool registry", () => {
    // A refactor that renames TOOL_DEFINITIONS or reformats the entries would
    // otherwise make every assertion below vacuously pass.
    expect(toolNames).toContain("open_recording");
    expect(toolNames.length).toBeGreaterThanOrEqual(18);
  });

  it.each(skills.map((skill) => skill.name))("%s names only registered tools", (skillName) => {
    const skill = skills.find((candidate) => candidate.name === skillName);
    const unknown = referencedToolNames(skill!.source).filter((name) => !toolNames.includes(name));
    expect(unknown).toEqual([]);
  });

  it("names every tool an investigating agent needs", () => {
    // A tool no skill mentions is a tool no agent reaches for. These are the
    // ones that answer a question the skills already tell the agent to ask.
    const namedAnywhere = skills.flatMap((skill) => backtickedIdentifiers(skill.source));
    for (const required of ["open_recording", "get_overview", "list_screenshots", "search"]) {
      expect(namedAnywhere).toContain(required);
    }
  });
});

describe("agent assets: docs reference real Task commands", () => {
  it("finds the Taskfile targets", () => {
    expect(taskNames).toContain("test:all");
    expect(taskNames).toContain("agent:sync");
  });

  it.each([
    ...TASK_REFERENCING_DOCS,
    ...skills.map((skill) => `plugin skill ${skill.name}`),
  ])("%s invokes only declared tasks", (label) => {
    const source = label.startsWith("plugin skill ")
      ? skills.find((skill) => `plugin skill ${skill.name}` === label)!.source
      : read(label);
    const unknown = referencedTaskNames(source)
      // Documented as a placeholder for the per-browser variants.
      .filter((name) => name !== "dev:")
      .filter((name) => !taskNames.includes(name));
    expect(unknown).toEqual([]);
  });
});
