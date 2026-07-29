/**
 * Gating bar for player e2e acceptance when browsers are unavailable:
 * drive the same fixture cases and body display helper the Playwright specs use.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getNetworkFilterType } from "./network-filter-type";
import { resolveNetworkResponseBodyDisplay } from "./network-response-body";

const fixturePath = resolve(import.meta.dirname, "../../e2e/fixtures/network-filter-cases.json");
const sampleNetworkPath = resolve(
  import.meta.dirname,
  "../../test/fixtures/network/sample-network-entries.json",
);

describe("player e2e acceptance (pure shipped helpers + fixtures)", () => {
  it("filter matrix fixture maps through getNetworkFilterType", () => {
    const cases = JSON.parse(readFileSync(fixturePath, "utf8")) as Array<{
      name: string;
      input: { resourceType?: string; url?: string; mimeType?: string };
      expected: string;
    }>;
    expect(cases.length).toBeGreaterThanOrEqual(5);
    for (const row of cases) {
      expect(getNetworkFilterType(row.input), row.name).toBe(row.expected);
    }
  });

  it("sample network entries: scripts are js, XHR/Fetch stay fetch", () => {
    const entries = JSON.parse(readFileSync(sampleNetworkPath, "utf8")) as Array<{
      requestId: string;
      resourceType: string;
      url: string;
      mimeType: string;
    }>;
    const byId = Object.fromEntries(entries.map((e) => [e.requestId, e]));
    expect(
      getNetworkFilterType({
        resourceType: byId["script-1"].resourceType,
        url: byId["script-1"].url,
        mimeType: byId["script-1"].mimeType,
      }),
    ).toBe("js");
    expect(
      getNetworkFilterType({
        resourceType: byId["xhr-1"].resourceType,
        url: byId["xhr-1"].url,
        mimeType: byId["xhr-1"].mimeType,
      }),
    ).toBe("fetch");
    expect(
      getNetworkFilterType({
        resourceType: byId["api-1"].resourceType,
        url: byId["api-1"].url,
        mimeType: byId["api-1"].mimeType,
      }),
    ).toBe("fetch");
  });

  it("response body present vs missing", () => {
    const entries = JSON.parse(readFileSync(sampleNetworkPath, "utf8")) as Array<{
      requestId: string;
      responseBody: { body: string; base64Encoded: boolean } | null;
    }>;
    const withBody = entries.find((e) => e.requestId === "api-1");
    const empty = entries.find((e) => e.requestId === "empty-1");
    expect(withBody?.responseBody?.body).toBeTruthy();
    expect(resolveNetworkResponseBodyDisplay({ text: withBody?.responseBody?.body ?? "" })).toEqual(
      { kind: "text", text: '{"ok":true}' },
    );
    expect(resolveNetworkResponseBodyDisplay({ text: empty?.responseBody?.body ?? "" })).toEqual({
      kind: "missing",
      text: "",
    });
  });
});
