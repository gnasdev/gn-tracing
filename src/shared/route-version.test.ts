/**
 * Ensures the extension re-export surface stays wired to the pure module
 * (same exports the Worker and esbuild use).
 */
import { describe, expect, it } from "vitest";
import * as core from "../../packages/replay-core/src/route-version";
import {
  joinVersionedPath,
  resolveVersionedWorkerEndpoints,
  stripRouteVersionPrefix,
} from "./route-version";

describe("src/shared/route-version re-export", () => {
  it("matches pure-module behavior for strip, join, and Worker endpoints", () => {
    const path = "/1.6.3/token";
    expect(stripRouteVersionPrefix(path)).toEqual(core.stripRouteVersionPrefix(path));
    expect(joinVersionedPath("1.7.5", "/gdrive/abc")).toBe(
      core.joinVersionedPath("1.7.5", "/gdrive/abc"),
    );
    expect(resolveVersionedWorkerEndpoints("https://proxy.example", "1.7.5")).toEqual(
      core.resolveVersionedWorkerEndpoints("https://proxy.example", "1.7.5"),
    );
  });

  it("drives strip and join on the shipped re-export", () => {
    expect(stripRouteVersionPrefix("/1.6.3/token")).toEqual({
      routeVersion: "1.6.3",
      remainder: "/token",
    });
    expect(joinVersionedPath("1.7.5", "/gdrive/abc")).toBe("/1.7.5/gdrive/abc");
    expect(resolveVersionedWorkerEndpoints("https://proxy.example", "1.7.5").googleTokenUrl).toBe(
      "https://proxy.example/1.7.5/token",
    );
  });
});
