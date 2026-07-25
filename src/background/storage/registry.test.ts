/**
 * Unit tests for the storage provider registry (Drive + Dropbox).
 */
import { describe, expect, it } from "vitest";
import {
  getDropboxProvider,
  getGoogleDriveProvider,
  getStorageProvider,
  isStorageProviderRegistered,
  listRegisteredStorageProviders,
  registerStorageProvider,
  requireRegisteredStorageProvider,
  resolveRegisteredUploadProviderId,
} from "./registry";
import type { StorageProvider } from "./types";

describe("storage provider registry", () => {
  it("registers only google-drive and dropbox by default", () => {
    expect(listRegisteredStorageProviders()).toContain("google-drive");
    expect(listRegisteredStorageProviders()).toContain("dropbox");
    expect(listRegisteredStorageProviders()).not.toContain("onedrive");
    expect(isStorageProviderRegistered("google-drive")).toBe(true);
    expect(isStorageProviderRegistered("dropbox")).toBe(true);
    expect(isStorageProviderRegistered("onedrive")).toBe(false);
    expect(getStorageProvider("google-drive").id).toBe("google-drive");
    expect(getStorageProvider("dropbox").id).toBe("dropbox");
    expect(getGoogleDriveProvider().id).toBe("google-drive");
    expect(getDropboxProvider().id).toBe("dropbox");
  });

  it("falls back to google-drive for unknown providers via getStorageProvider", () => {
    expect(getStorageProvider("unknown").id).toBe("google-drive");
  });

  it("requireRegisteredStorageProvider accepts Drive/Dropbox and rejects onedrive", () => {
    expect(requireRegisteredStorageProvider("dropbox").ok).toBe(true);
    expect(requireRegisteredStorageProvider("google-drive").ok).toBe(true);
    const removed = requireRegisteredStorageProvider("onedrive");
    expect(removed.ok).toBe(false);
    if (!removed.ok) {
      expect(removed.error).toMatch(/onedrive/i);
    }
    // Unknown ids normalize to google-drive (registered), so they succeed as Drive.
    const unknown = requireRegisteredStorageProvider("s3");
    expect(unknown.ok).toBe(true);
    if (unknown.ok) {
      expect(unknown.provider.id).toBe("google-drive");
    }
  });

  it("resolveRegisteredUploadProviderId keeps registered providers", () => {
    expect(resolveRegisteredUploadProviderId("dropbox")).toBe("dropbox");
    expect(resolveRegisteredUploadProviderId("onedrive")).toBe("google-drive");
    expect(resolveRegisteredUploadProviderId("google-drive")).toBe("google-drive");
    expect(resolveRegisteredUploadProviderId("s3")).toBe("google-drive");
  });

  it("builds namespaced google-drive and dropbox replay URLs", () => {
    const driveUrl = getGoogleDriveProvider().buildReplayUrl("abc123");
    expect(driveUrl).toContain("/gdrive/abc123");
    const dropboxUrl = getDropboxProvider().buildReplayUrl("scl/fi/x/file.zip?rlkey=y");
    expect(dropboxUrl).toContain("/dropbox/");
    expect(dropboxUrl).toContain(encodeURIComponent("scl/fi/x/file.zip?rlkey=y"));
  });

  it("registerStorageProvider replaces the map entry used by getStorageProvider", () => {
    const original = getStorageProvider("google-drive");
    const stub: StorageProvider = {
      ...original,
      id: "google-drive",
      buildReplayUrl: (id) => `stub://${id}`,
    };
    registerStorageProvider(stub);
    expect(getStorageProvider("google-drive").buildReplayUrl("x")).toBe("stub://x");
    // getGoogleDriveProvider stays the module singleton (auth wiring), not the map.
    expect(getGoogleDriveProvider().buildReplayUrl("x")).toContain("/gdrive/x");
    // Restore so later suites stay hermetic.
    registerStorageProvider(original);
    expect(getStorageProvider("google-drive").buildReplayUrl("x")).toContain("/gdrive/x");
  });
});
