/**
 * Shared host-permission helpers used by popup pre-request and arm-panel grant.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hasRecordingHostPermission,
  RECORDING_HOST_ORIGINS,
  requestRecordingHostPermission,
} from "./recording-host-permission";

describe("recording-host-permission", () => {
  beforeEach(() => {
    vi.stubGlobal("chrome", {
      permissions: {
        contains: vi.fn(),
        request: vi.fn(),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("declares the same origins as optional_host_permissions", () => {
    expect([...RECORDING_HOST_ORIGINS]).toEqual(["http://*/*", "https://*/*"]);
  });

  it("reports granted when contains returns true", async () => {
    (chrome.permissions.contains as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    await expect(hasRecordingHostPermission()).resolves.toBe(true);
    expect(chrome.permissions.contains).toHaveBeenCalledWith({
      origins: ["http://*/*", "https://*/*"],
    });
  });

  it("treats missing permissions API as already granted", async () => {
    (chrome.permissions.contains as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("no optional permissions"),
    );
    await expect(hasRecordingHostPermission()).resolves.toBe(true);
  });

  it("requests origins and returns the grant result", async () => {
    (chrome.permissions.request as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    await expect(requestRecordingHostPermission()).resolves.toBe(false);
    expect(chrome.permissions.request).toHaveBeenCalledWith({
      origins: ["http://*/*", "https://*/*"],
    });
  });
});
