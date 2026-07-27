/**
 * Replay-ref tests, including the golden check against the extension's own
 * implementation.
 *
 * Two copies of a URL rule drift the moment one side is edited alone, and the
 * failure mode is a replay link that resolves differently for an agent than for
 * the player. The golden test below makes that drift a red test instead.
 */

import { describe, expect, it } from "vitest";
import { parseStorageRecordingRef as extensionParse } from "../../../src/shared/storage-provider";
import {
  buildPackageDownloadUrl,
  buildReplayUrl,
  isSupportedRecordingRef,
  parseStorageRecordingRef,
} from "./recording-ref";

const CASES = [
  "https://tracing.gnas.dev/gdrive/1AbCdEfGhIjKlMnOp",
  "https://tracing.gnas.dev/dropbox/scl/fi/abc123/gn-tracing.zip",
  "https://tracing.gnas.dev/1AbCdEfGhIjKlMnOp",
  "https://tracing.gnas.dev/onedrive/whatever",
  "https://tracing.gnas.dev/app",
  "https://tracing.gnas.dev/privacy.html",
  "https://tracing.gnas.dev/?id=1AbCdEfGhIjKlMnOp",
  "https://tracing.gnas.dev/?id=abc&provider=dropbox",
  "https://tracing.gnas.dev/?id=abc&provider=onedrive",
  "/gdrive/1AbCdEfGhIjKlMnOp",
  "1AbCdEfGhIjKlMnOp",
  "gn-tracing.zip",
  "",
  "   ",
  "not a url ://",
];

describe("parseStorageRecordingRef", () => {
  it("matches the extension implementation for every documented URL shape", () => {
    for (const input of CASES) {
      expect({ input, ref: parseStorageRecordingRef(input) }).toEqual({
        input,
        ref: extensionParse(input),
      });
    }
  });

  it("fails closed on the removed OneDrive namespace", () => {
    expect(parseStorageRecordingRef("https://tracing.gnas.dev/onedrive/abc")).toBeNull();
  });

  it("parses the namespaced provider forms", () => {
    expect(parseStorageRecordingRef("https://tracing.gnas.dev/gdrive/file-1")).toEqual({
      provider: "google-drive",
      fileId: "file-1",
    });
    expect(parseStorageRecordingRef("https://tracing.gnas.dev/dropbox/scl/fi/x")).toEqual({
      provider: "dropbox",
      fileId: "scl/fi/x",
    });
  });
});

describe("buildReplayUrl / buildPackageDownloadUrl", () => {
  it("round-trips a Drive ref through the replay URL", () => {
    const ref = { provider: "google-drive", fileId: "1AbCdEfGhIjKlMnOp" } as const;
    expect(parseStorageRecordingRef(buildReplayUrl(ref))).toEqual(ref);
  });

  it("points at the same-origin download proxy for each provider", () => {
    expect(buildPackageDownloadUrl({ provider: "google-drive", fileId: "abc" })).toBe(
      "https://tracing.gnas.dev/api/drive?id=abc",
    );
    expect(buildPackageDownloadUrl({ provider: "dropbox", fileId: "scl/fi/x" })).toBe(
      "https://tracing.gnas.dev/api/dropbox?id=scl%2Ffi%2Fx",
    );
  });

  it("honours a custom player origin", () => {
    expect(
      buildPackageDownloadUrl(
        { provider: "google-drive", fileId: "abc" },
        "http://localhost:5176/",
      ),
    ).toBe("http://localhost:5176/api/drive?id=abc");
  });
});

describe("isSupportedRecordingRef", () => {
  it("accepts ids the download proxies accept", () => {
    expect(isSupportedRecordingRef({ provider: "google-drive", fileId: "1AbCdEfGhIj" })).toBe(true);
    expect(isSupportedRecordingRef({ provider: "dropbox", fileId: "scl/fi/abc" })).toBe(true);
    expect(isSupportedRecordingRef({ provider: "dropbox", fileId: "s/abc" })).toBe(true);
  });

  it("rejects absolute URLs and traversal (the proxy SSRF rules)", () => {
    expect(isSupportedRecordingRef({ provider: "dropbox", fileId: "https://evil.example/x" })).toBe(
      false,
    );
    expect(isSupportedRecordingRef({ provider: "dropbox", fileId: "scl/../../etc" })).toBe(false);
    expect(isSupportedRecordingRef({ provider: "dropbox", fileId: "other/abc" })).toBe(false);
    expect(isSupportedRecordingRef({ provider: "google-drive", fileId: "short" })).toBe(false);
  });
});
