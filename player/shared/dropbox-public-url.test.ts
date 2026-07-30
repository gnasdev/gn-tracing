/**
 * Proxy-side URL builder tests (SSRF / path allowlist).
 * Source of truth for Cloudflare Pages + Vite middleware.
 */
import { describe, expect, it } from "vitest";
import {
  buildDropboxPublicDownloadUrl,
  isAllowedDropboxSharedLinkPath,
  isDropboxOwnedHost,
} from "./dropbox-public-url.js";

describe("dropbox-public-url (proxy)", () => {
  it("builds download URLs for shared-link ids", () => {
    const url = buildDropboxPublicDownloadUrl("scl/fi/abc/file.zip?rlkey=k");
    expect(url).toContain("www.dropbox.com/scl/fi/abc/file.zip");
    expect(url).toContain("dl=1");
  });

  it("rejects absolute URLs (open proxy / SSRF)", () => {
    expect(() => buildDropboxPublicDownloadUrl("https://evil.example/x")).toThrow(
      /relative shared-link/i,
    );
    expect(() => buildDropboxPublicDownloadUrl("http://127.0.0.1/admin")).toThrow();
  });

  it("rejects non-shared-link paths", () => {
    expect(() => buildDropboxPublicDownloadUrl("login")).toThrow(/shared-link prefix/i);
  });

  it("host boundary checks", () => {
    expect(isDropboxOwnedHost("www.dropbox.com")).toBe(true);
    expect(isDropboxOwnedHost("notdropbox.com")).toBe(false);
    expect(isAllowedDropboxSharedLinkPath("s/x")).toBe(true);
    expect(isAllowedDropboxSharedLinkPath("marketing")).toBe(false);
  });
});
