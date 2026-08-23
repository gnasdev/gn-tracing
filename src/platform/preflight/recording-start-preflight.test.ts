/**
 * Recording start preflight factory: any non-CDP target (Firefox, Safari,
 * Safari iOS) prompts for host permission since they all rely on in-page
 * content-script injection; Chromium (CDP) is a no-op.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const ensureRecordingHostPermission = vi.fn(async () => true);

vi.mock("../../shared/recording-host-permission", () => ({
  ensureRecordingHostPermission: () => ensureRecordingHostPermission(),
}));

import {
  createRecordingStartPreflight,
  runRecordingStartPreflight,
} from "./recording-start-preflight";

describe("createRecordingStartPreflight", () => {
  afterEach(() => {
    ensureRecordingHostPermission.mockClear();
  });

  it("chromium-family preflight does not request host permission", async () => {
    for (const target of ["chrome", "edge", "opera"] as const) {
      ensureRecordingHostPermission.mockClear();
      await createRecordingStartPreflight(target)();
      expect(ensureRecordingHostPermission).not.toHaveBeenCalled();
    }
  });

  it("firefox and safari targets request host permission", async () => {
    for (const target of ["firefox", "safari", "safari-ios"] as const) {
      ensureRecordingHostPermission.mockClear();
      await createRecordingStartPreflight(target)();
      expect(ensureRecordingHostPermission).toHaveBeenCalledTimes(1);
    }
  });

  it("firefox preflight swallows permission errors", async () => {
    ensureRecordingHostPermission.mockRejectedValueOnce(new Error("user gesture required"));
    await expect(createRecordingStartPreflight("firefox")()).resolves.toBeUndefined();
  });
});

describe("runRecordingStartPreflight", () => {
  afterEach(() => {
    ensureRecordingHostPermission.mockClear();
  });

  it("runs the preflight for an explicit target", async () => {
    await runRecordingStartPreflight("firefox");
    expect(ensureRecordingHostPermission).toHaveBeenCalledTimes(1);
  });
});
