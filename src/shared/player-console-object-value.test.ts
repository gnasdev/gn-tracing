import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const playerSource = fs.readFileSync(path.join(root, "player/public/player.js"), "utf8");

describe("player console object values", () => {
  it("renders serialized object values when CDP preview data is unavailable", () => {
    const renderObjectPreview = playerSource.match(
      /function renderObjectPreview\(obj, options = \{\}\) \{[\s\S]*?\n {2}\}/,
    )?.[0];
    const remoteObjectToPlain = playerSource.match(
      /function remoteObjectToPlain\(obj, depth\) \{[\s\S]*?\n {2}\}/,
    )?.[0];

    expect(renderObjectPreview).toContain("renderStructuredObjectValue(obj.value)");
    expect(remoteObjectToPlain).toContain("return obj.value");
  });
});
