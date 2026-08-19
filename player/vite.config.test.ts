import { describe, expect, it } from "vitest";
import { isStorageProxyPath, isUnsupportedLocalPlayerVersionPath } from "./shared/proxy/path";

const CURRENT_VERSION = "1.7.13";

describe("isStorageProxyPath", () => {
  it("accepts root and current-version storage proxy paths", () => {
    expect(isStorageProxyPath("/api/drive", "drive", CURRENT_VERSION)).toBe(true);
    expect(isStorageProxyPath("/1.7.13/api/drive", "drive", CURRENT_VERSION)).toBe(true);
    expect(isStorageProxyPath("/1.7.13/api/dropbox", "dropbox", CURRENT_VERSION)).toBe(true);
  });

  it("rejects historical, unknown, unrelated, and malformed version paths", () => {
    expect(isStorageProxyPath("/1.7.11/api/drive", "drive", CURRENT_VERSION)).toBe(false);
    expect(isStorageProxyPath("/9.9.9/api/drive", "drive", CURRENT_VERSION)).toBe(false);
    expect(isStorageProxyPath("/1.7/api/drive", "drive", CURRENT_VERSION)).toBe(false);
    expect(isStorageProxyPath("/1.7.13/api/dropbox", "drive", CURRENT_VERSION)).toBe(false);
    expect(isStorageProxyPath("/1.7.13/api/drive-extra", "drive", CURRENT_VERSION)).toBe(false);
  });
});

describe("isUnsupportedLocalPlayerVersionPath", () => {
  it("fails closed for historical and unknown versioned routes", () => {
    expect(isUnsupportedLocalPlayerVersionPath("/1.7.11/gdrive/id", CURRENT_VERSION)).toBe(true);
    expect(isUnsupportedLocalPlayerVersionPath("/9.9.9/dropbox/id", CURRENT_VERSION)).toBe(true);
  });

  it("keeps current and legacy routes available to the local source player", () => {
    expect(isUnsupportedLocalPlayerVersionPath("/1.7.13/gdrive/id", CURRENT_VERSION)).toBe(false);
    expect(isUnsupportedLocalPlayerVersionPath("/gdrive/id", CURRENT_VERSION)).toBe(false);
    expect(isUnsupportedLocalPlayerVersionPath("/1.7/gdrive/id", CURRENT_VERSION)).toBe(false);
  });
});
