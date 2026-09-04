import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const deployScript = readFileSync(new URL("../worker/deploy.sh", import.meta.url), "utf8");
const syncScript = readFileSync(
  new URL("../scripts/sync-worker-dev-vars.mjs", import.meta.url),
  "utf8",
);
const wranglerConfig = readFileSync(new URL("../worker/wrangler.toml", import.meta.url), "utf8");
const devVarsExample = readFileSync(
  new URL("../worker/.dev.vars.example", import.meta.url),
  "utf8",
);

describe("Worker Safari OAuth origin configuration", () => {
  it("includes Safari's dynamic extension origin in the default production deployment allow-list", () => {
    expect(deployScript).toMatch(
      /ALLOWED_ORIGINS="chrome-extension:\/\/\$\{CHROME_EXTENSION_ID\},moz-extension:\/\/\*,safari-web-extension:\/\/\*"/,
    );
  });

  it("adds Safari's dynamic extension origin to the generated local Worker allow-list", () => {
    expect(syncScript).toMatch(/const required = \[[\s\S]*SAFARI_ORIGIN_WILDCARD,/);
  });
});

describe("Worker local dev var template", () => {
  it("documents every public var wrangler.toml declares", () => {
    // `.dev.vars` overrides wrangler.toml [vars] wholesale in local mode, so a
    // var missing from the template is a var nobody knows they can set — which
    // is how MCP_ENABLED and PLAYER_ORIGIN went undocumented.
    const varsBlock = wranglerConfig.slice(wranglerConfig.indexOf("[vars]"));
    const declared = [...varsBlock.matchAll(/^([A-Z0-9_]+)\s*=/gm)].map((match) => match[1]);
    const documented = [...devVarsExample.matchAll(/^([A-Z0-9_]+)=/gm)].map((match) => match[1]);

    expect(declared.length).toBeGreaterThan(0);
    expect(declared.filter((name) => !documented.includes(name))).toEqual([]);
  });
});
