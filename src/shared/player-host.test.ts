/**
 * Unit tests for external player URL builder (namespaced multi-cloud paths).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

describe("resolveReplayOpenUrl", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("returns the recording URL unchanged outside rewrite when not production host", async () => {
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

  it("emits /{version}/gdrive/<id> for google-drive by default", async () => {
    const { buildExternalPlayerUrl } = await import("./player-host");
    const { getProductVersion } = await import("./app-version");
    const version = getProductVersion();
    const url = buildExternalPlayerUrl("fileId123");
    expect(url.endsWith(`/${version}/gdrive/fileId123`)).toBe(true);
  });

  it("emits provider-specific namespaces for Drive and Dropbox", async () => {
    const { buildExternalPlayerUrl } = await import("./player-host");
    const { getProductVersion } = await import("./app-version");
    const version = getProductVersion();
    expect(buildExternalPlayerUrl("dbx", "dropbox").endsWith(`/${version}/dropbox/dbx`)).toBe(true);
    expect(buildExternalPlayerUrl("g", "google-drive").endsWith(`/${version}/gdrive/g`)).toBe(true);
  });

  it("returns the host root when the file id is empty", async () => {
    const { buildExternalPlayerUrl } = await import("./player-host");
    const url = buildExternalPlayerUrl("");
    expect(url.endsWith("/")).toBe(true);
    expect(url.includes("/gdrive/")).toBe(false);
  });
});

describe("resolvePlayerHostUrl", () => {
  it("prefers configured host when set", async () => {
    const { resolvePlayerHostUrl } = await import("./player-host");
    expect(resolvePlayerHostUrl("http://127.0.0.1:5176", "production", 5176)).toBe(
      "http://127.0.0.1:5176/",
    );
  });

  it("uses localhost for development when host is empty", async () => {
    const { resolvePlayerHostUrl } = await import("./player-host");
    expect(resolvePlayerHostUrl("", "development", 5176)).toBe("http://localhost:5176/");
    expect(resolvePlayerHostUrl("", "dev", 4000)).toBe("http://localhost:4000/");
  });

  it("uses production host for production when host is empty", async () => {
    const { resolvePlayerHostUrl } = await import("./player-host");
    expect(resolvePlayerHostUrl("", "production", 5176)).toBe("https://tracing.gnas.dev/");
  });

  it("ignores production host configuration in development builds", async () => {
    const { resolvePlayerHostUrl } = await import("./player-host");
    expect(resolvePlayerHostUrl("https://tracing.gnas.dev/", "development", 5176)).toBe(
      "http://localhost:5176/",
    );
    expect(resolvePlayerHostUrl("https://gn-tracing-player.pages.dev", "dev", 4000)).toBe(
      "http://localhost:4000/",
    );
  });

  it("keeps non-production custom hosts in development", async () => {
    const { resolvePlayerHostUrl } = await import("./player-host");
    expect(resolvePlayerHostUrl("https://player-preview.example/", "development", 5176)).toBe(
      "https://player-preview.example/",
    );
  });
});

describe("rewritePlayerHostForDevelopment", () => {
  it("rewrites tracing.gnas.dev to the local player host", async () => {
    const { rewritePlayerHostForDevelopment } = await import("./player-host");
    expect(
      rewritePlayerHostForDevelopment(
        "https://tracing.gnas.dev/gdrive/file123",
        "http://localhost:5176/",
      ),
    ).toBe("http://localhost:5176/gdrive/file123");
  });

  it("rewrites pages.dev production alias too", async () => {
    const { rewritePlayerHostForDevelopment } = await import("./player-host");
    expect(
      rewritePlayerHostForDevelopment(
        "https://gn-tracing-player.pages.dev/dropbox/x",
        "http://localhost:5176/",
      ),
    ).toBe("http://localhost:5176/dropbox/x");
  });

  it("leaves non-production hosts unchanged", async () => {
    const { rewritePlayerHostForDevelopment } = await import("./player-host");
    const url = "http://localhost:5176/gdrive/abc";
    expect(rewritePlayerHostForDevelopment(url, "http://localhost:5176/")).toBe(url);
  });
});
