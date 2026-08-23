import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const deployScript = readFileSync(new URL("../worker/deploy.sh", import.meta.url), "utf8");
const syncScript = readFileSync(
  new URL("../scripts/sync-worker-dev-vars.mjs", import.meta.url),
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
