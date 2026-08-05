/**
 * Recording start preflight factory: Firefox prompts for host permission;
 * Chrome is a no-op.
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

  it("firefox preflight requests host permission", async () => {
    await createRecordingStartPreflight("firefox")();
    expect(ensureRecordingHostPermission).toHaveBeenCalledTimes(1);
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
