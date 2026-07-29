/**
 * Player network detail empty-state: proves the shipped display helper returns
 * a non-empty status for missing bodies and real text when present. The player
 * maps `kind` → i18n (`detail.noResponseBody` / binary / text section).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveNetworkResponseBodyDisplay } from "./network-response-body";

const playerJs = readFileSync(resolve(import.meta.dirname, "../../player/player.js"), "utf8");
const coreEntry = readFileSync(resolve(import.meta.dirname, "../../player/core-entry.ts"), "utf8");

describe("network response body UI (shipped paths)", () => {
  it("exports resolveNetworkResponseBodyDisplay on gnCore.network", () => {
    expect(coreEntry).toMatch(/resolveNetworkResponseBodyDisplay/);
    expect(coreEntry).toMatch(/export const network/);
  });

  it("player buildResponseBodySection uses the shared display helper and empty-state key", () => {
    expect(playerJs).toMatch(/resolveNetworkResponseBodyDisplay/);
    expect(playerJs).toMatch(/detail\.noResponseBody/);
    expect(playerJs).toMatch(/response-body empty/);
    expect(playerJs).toContain('"detail.noResponseBody": "No response body"');
    expect(playerJs).toContain('"detail.noResponseBody": "Không có response body"');
  });

  it("missing body is never an empty string status path (kind missing)", () => {
    const display = resolveNetworkResponseBodyDisplay({ text: "" });
    expect(display.kind).toBe("missing");
    // Player always renders a labeled section for missing — never "".
    const missingBranch = playerJs.includes('display.kind === "missing"');
    expect(missingBranch).toBe(true);
  });

  it("present body text is exposed for rendering", () => {
    const display = resolveNetworkResponseBodyDisplay({ text: '{"ok":true}' });
    expect(display.kind).toBe("text");
    expect(display.text).toBe('{"ok":true}');
  });
});
