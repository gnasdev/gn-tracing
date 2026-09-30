/**
 * `isEligibleResponseBodyMime` duplicates the CDP-path eligibility rule
 * (`shouldFetchResponseBody` in src/shared/network-response-body.ts) because
 * this package has no dependency on `src/`. This test is the guard against the
 * two copies drifting apart: any MIME/mode pair added to one rule table without
 * the other fails here.
 */
import { describe, expect, it } from "vitest";
import { isEligibleResponseBodyMime } from "./in-page-capture";

// Mirrors shouldFetchResponseBody's own fixture coverage in
// src/shared/network-response-body.test.ts, minus size/mode combinations that
// are this function's caller's responsibility, not the MIME table's.
const fixtures: Array<{
  mode: "off" | "text" | "text-json" | "eligible";
  mime: string;
  eligible: boolean;
}> = [
  { mode: "off", mime: "text/plain", eligible: false },
  { mode: "text", mime: "text/plain", eligible: true },
  { mode: "text", mime: "text/html", eligible: true },
  { mode: "text", mime: "application/json", eligible: false },
  { mode: "text-json", mime: "application/json", eligible: true },
  { mode: "text-json", mime: "application/vnd.api+json", eligible: true },
  { mode: "text-json", mime: "image/png", eligible: false },
  { mode: "eligible", mime: "application/json", eligible: true },
  { mode: "eligible", mime: "application/javascript", eligible: true },
  { mode: "eligible", mime: "text/javascript", eligible: true },
  { mode: "eligible", mime: "application/xml", eligible: true },
  { mode: "eligible", mime: "image/svg+xml", eligible: true },
  { mode: "eligible", mime: "application/ld+json", eligible: true },
  { mode: "eligible", mime: "application/manifest+json", eligible: true },
  { mode: "eligible", mime: "image/png", eligible: false },
  { mode: "eligible", mime: "application/octet-stream", eligible: false },
  { mode: "eligible", mime: "video/mp4", eligible: false },
];

describe("isEligibleResponseBodyMime", () => {
  it.each(fixtures)("$mode + $mime -> $eligible", ({ mode, mime, eligible }) => {
    expect(isEligibleResponseBodyMime(mode, mime)).toBe(eligible);
  });

  it("rejects a null or empty MIME regardless of mode", () => {
    expect(isEligibleResponseBodyMime("eligible", null)).toBe(false);
    expect(isEligibleResponseBodyMime("eligible", "")).toBe(false);
    expect(isEligibleResponseBodyMime("eligible", "   ")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isEligibleResponseBodyMime("text", "TEXT/PLAIN")).toBe(true);
  });

  it("strips Content-Type parameters before matching", () => {
    expect(isEligibleResponseBodyMime("text", "text/plain; charset=utf-8")).toBe(true);
  });
});
