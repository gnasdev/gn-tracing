import { describe, expect, it } from "vitest";
import {
  pickProductVersion,
  requireProductVersion,
} from "../../packages/replay-core/src/product-version";
import {
  collectExtensionVersionCandidates,
  getProductVersion,
  getProductVersionOrDefault,
} from "./app-version";

describe("extension getProductVersion", () => {
  it("resolves a core semver from build define (vitest)", () => {
    expect(getProductVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("lists define then manifest as candidates", () => {
    const candidates = collectExtensionVersionCandidates();
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    // First candidate is the vitest/esbuild define when present.
    expect(pickProductVersion(...candidates)).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("falls back through pickProductVersion when define is empty", () => {
    const picked = pickProductVersion(undefined, "9.8.7");
    expect(requireProductVersion(picked, "extension")).toBe("9.8.7");
  });

  it("getProductVersionOrDefault never throws", () => {
    expect(getProductVersionOrDefault("0.0.0")).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
