/**
 * IndexedDB-backed screenshot package staging (memory fallback under Node/vitest).
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  clearScreenshotPackageStaging,
  getScreenshotPackageStaging,
  putScreenshotPackageStaging,
  resetScreenshotPackageStagingMemoryForTests,
} from "./screenshot-package-staging-idb";

afterEach(() => {
  resetScreenshotPackageStagingMemoryForTests();
});

describe("screenshot-package-staging-idb", () => {
  it("round-trips still + IR artifacts by staging id", async () => {
    const instantReplay = JSON.stringify({
      schemaVersion: 1,
      windowMs: 120_000,
      coveredMs: 5_000,
      frames: [{ relativeMs: 0 }],
    });
    await putScreenshotPackageStaging("stage-1", {
      imageDataUrl: "data:image/png;base64,aaa",
      artifacts: {
        instantReplay,
        console: '[{"level":"error"}]',
      },
    });

    const loaded = await getScreenshotPackageStaging("stage-1");
    expect(loaded?.imageDataUrl).toBe("data:image/png;base64,aaa");
    expect(loaded?.artifacts.instantReplay).toBe(instantReplay);
    expect(loaded?.artifacts.console).toBe('[{"level":"error"}]');
  });

  it("allows IR-only staging without a still", async () => {
    await putScreenshotPackageStaging("ir-only", {
      imageDataUrl: "",
      artifacts: { instantReplay: '{"frames":[1]}' },
    });
    const loaded = await getScreenshotPackageStaging("ir-only");
    expect(loaded?.imageDataUrl).toBe("");
    expect(loaded?.artifacts.instantReplay).toContain("frames");
  });

  it("rejects empty payload", async () => {
    await expect(
      putScreenshotPackageStaging("empty", { imageDataUrl: "", artifacts: {} }),
    ).rejects.toThrow(/no image or artifacts/i);
  });

  it("returns null for missing id", async () => {
    expect(await getScreenshotPackageStaging("missing")).toBeNull();
    expect(await getScreenshotPackageStaging("")).toBeNull();
  });

  it("clears by id and clear-all", async () => {
    await putScreenshotPackageStaging("a", {
      imageDataUrl: "data:image/png;base64,a",
      artifacts: {},
    });
    await putScreenshotPackageStaging("b", {
      imageDataUrl: "data:image/png;base64,b",
      artifacts: { console: "[]" },
    });

    await clearScreenshotPackageStaging("a");
    expect(await getScreenshotPackageStaging("a")).toBeNull();
    expect(await getScreenshotPackageStaging("b")).not.toBeNull();

    await clearScreenshotPackageStaging();
    expect(await getScreenshotPackageStaging("b")).toBeNull();
  });

  it("drops empty artifact string values", async () => {
    await putScreenshotPackageStaging("norm", {
      imageDataUrl: "data:image/png;base64,x",
      artifacts: { console: "[]", network: "" },
    });
    const loaded = await getScreenshotPackageStaging("norm");
    expect(loaded?.artifacts).toEqual({ console: "[]" });
  });
});
