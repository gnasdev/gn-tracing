/**
 * Unit tests for external player URL builder (namespaced multi-cloud paths).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

describe("resolveReplayOpenUrl", () => {
  it("returns the recording URL unchanged (OneDrive rewrite removed)", async () => {
    const { resolveReplayOpenUrl } = await import("./player-host");
    const url = "http://localhost:5176/gdrive/abc123";
    expect(resolveReplayOpenUrl(url)).toBe(url);
    expect(resolveReplayOpenUrl("  ")).toBe("");
  });
});

describe("buildExternalPlayerUrl", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("emits /gdrive/<id> for google-drive by default", async () => {
    const { buildExternalPlayerUrl } = await import("./player-host");
    const url = buildExternalPlayerUrl("fileId123");
    expect(url.endsWith("/gdrive/fileId123")).toBe(true);
  });

  it("emits provider-specific namespaces for Drive and Dropbox", async () => {
    const { buildExternalPlayerUrl } = await import("./player-host");
    expect(buildExternalPlayerUrl("dbx", "dropbox").endsWith("/dropbox/dbx")).toBe(true);
    expect(buildExternalPlayerUrl("g", "google-drive").endsWith("/gdrive/g")).toBe(true);
  });

  it("returns the host root when the file id is empty", async () => {
    const { buildExternalPlayerUrl } = await import("./player-host");
    const url = buildExternalPlayerUrl("");
    expect(url.endsWith("/")).toBe(true);
    expect(url.includes("/gdrive/")).toBe(false);
  });
});
