import { describe, expect, it, vi } from "vitest";
import {
  buildDropboxPublicDownloadUrl,
  buildDropboxSharedLinkUrl,
  encodeDropboxApiArg,
  encodeDropboxReplayIdFromSharedUrl,
  isAllowedDropboxSharedLinkPath,
  isDropboxFolderAlreadyExistsError,
  isDropboxOwnedHost,
  makeDropboxPublicReadable,
} from "./dropbox-api";
import { parseStorageRecordingRef } from "./storage-provider";

describe("Dropbox host / path allowlists", () => {
  it("accepts proper Dropbox hosts with subdomain boundary", () => {
    expect(isDropboxOwnedHost("dropbox.com")).toBe(true);
    expect(isDropboxOwnedHost("www.dropbox.com")).toBe(true);
    expect(isDropboxOwnedHost("dl.dropboxusercontent.com")).toBe(true);
    expect(isDropboxOwnedHost("dropboxusercontent.com")).toBe(true);
    expect(isDropboxOwnedHost("db.tt")).toBe(true);
  });

  it("rejects host suffix spoofing", () => {
    expect(isDropboxOwnedHost("notdropbox.com")).toBe(false);
    expect(isDropboxOwnedHost("evilnotdropbox.com")).toBe(false);
    expect(isDropboxOwnedHost("dropbox.com.evil.example")).toBe(false);
    expect(isDropboxOwnedHost("example.com")).toBe(false);
  });

  it("allows only shared-link path prefixes", () => {
    expect(isAllowedDropboxSharedLinkPath("s/abc/file.zip")).toBe(true);
    expect(isAllowedDropboxSharedLinkPath("scl/fi/x/y.zip")).toBe(true);
    expect(isAllowedDropboxSharedLinkPath("sh/abc/x")).toBe(true);
    expect(isAllowedDropboxSharedLinkPath("sm/abc")).toBe(true);
    expect(isAllowedDropboxSharedLinkPath("login")).toBe(false);
    expect(isAllowedDropboxSharedLinkPath("../s/x")).toBe(false);
    expect(isAllowedDropboxSharedLinkPath("")).toBe(false);
  });
});

describe("Dropbox canonical replay id", () => {
  it("encodes scl shared links with rlkey", () => {
    const shared = "https://www.dropbox.com/scl/fi/abc123/gn-tracing.zip?rlkey=secret&dl=0&st=xyz";
    const id = encodeDropboxReplayIdFromSharedUrl(shared);
    expect(id).toBe("scl/fi/abc123/gn-tracing.zip?rlkey=secret");
  });

  it("encodes legacy /s/ shared links", () => {
    const shared = "https://www.dropbox.com/s/abc123/file.zip?dl=0";
    const id = encodeDropboxReplayIdFromSharedUrl(shared);
    expect(id).toBe("s/abc123/file.zip");
  });

  it("rejects non-Dropbox hosts when encoding", () => {
    expect(() => encodeDropboxReplayIdFromSharedUrl("https://evil.example/scl/fi/x/y.zip")).toThrow(
      /host/i,
    );
    expect(() =>
      encodeDropboxReplayIdFromSharedUrl("https://notdropbox.com/s/abc/file.zip"),
    ).toThrow(/host/i);
  });

  it("builds public download URLs with dl=1", () => {
    const url = buildDropboxPublicDownloadUrl("scl/fi/abc/file.zip?rlkey=k");
    expect(url).toContain("https://www.dropbox.com/scl/fi/abc/file.zip");
    expect(url).toContain("rlkey=k");
    expect(url).toContain("dl=1");
  });

  it("rejects absolute URLs (open-proxy / SSRF prevention)", () => {
    expect(() => buildDropboxPublicDownloadUrl("https://internal.example/secret")).toThrow(
      /relative shared-link/i,
    );
    expect(() => buildDropboxPublicDownloadUrl("http://evil.test/x")).toThrow();
  });

  it("rejects non-shared-link relative paths", () => {
    expect(() => buildDropboxPublicDownloadUrl("login")).toThrow(/shared-link prefix/i);
    expect(() => buildDropboxPublicDownloadUrl("home")).toThrow(/shared-link prefix/i);
    expect(() => buildDropboxPublicDownloadUrl("../s/x")).toThrow();
  });

  it("builds shared link URLs with dl=0 for API", () => {
    const url = buildDropboxSharedLinkUrl("s/abc/file.zip");
    expect(url).toContain("dl=0");
  });

  it("round-trips through encodeURIComponent path segment and parseStorageRecordingRef", () => {
    const id = encodeDropboxReplayIdFromSharedUrl(
      "https://www.dropbox.com/scl/fi/x/y.zip?rlkey=abc",
    );
    const path = `/dropbox/${encodeURIComponent(id)}`;
    const ref = parseStorageRecordingRef(`https://tracing.gnas.dev${path}`);
    expect(ref).toEqual({ provider: "dropbox", fileId: id });
    expect(id).toContain("?rlkey=");
  });
});

describe("isDropboxFolderAlreadyExistsError", () => {
  it("accepts path/conflict/folder only", () => {
    expect(isDropboxFolderAlreadyExistsError("path/conflict/folder/...")).toBe(true);
    expect(
      isDropboxFolderAlreadyExistsError("conflict", {
        error: { ".tag": "path", path: { ".tag": "conflict", conflict: { ".tag": "folder" } } },
      }),
    ).toBe(true);
  });

  it("rejects path/conflict/file and other folder errors", () => {
    expect(isDropboxFolderAlreadyExistsError("path/conflict/file/...")).toBe(false);
    expect(isDropboxFolderAlreadyExistsError("insufficient_space for folder")).toBe(false);
    expect(isDropboxFolderAlreadyExistsError("malformed_path")).toBe(false);
  });
});

describe("encodeDropboxApiArg", () => {
  it("escapes non-ASCII for HTTP headers", () => {
    const encoded = encodeDropboxApiArg({ path: "/thư-mục/file.zip" });
    // ASCII-only: max char code <= 0x7f (avoids control-char regex lint).
    expect([...encoded].every((ch) => ch.charCodeAt(0) <= 0x7f)).toBe(true);
    expect(encoded).toContain("\\u");
  });
});

describe("makeDropboxPublicReadable hard-fail", () => {
  it("propagates create_shared_link failures", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error_summary: "sharing/restricted" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(makeDropboxPublicReadable("token", "/file.zip")).rejects.toThrow(
      /share failed|sharing/i,
    );

    vi.unstubAllGlobals();
  });
});
