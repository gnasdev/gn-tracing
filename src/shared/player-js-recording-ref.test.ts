/**
 * Drives the SHIPPED `resolveReplayRecordingRef` inside `player/public/player.js`.
 *
 * Production replay loads that IIFE (via player/src/main.ts → /player.js). The
 * extension emits `/{version}/gdrive|dropbox/...` URLs; this function is what
 * must parse them. Golden-checked against `parseStorageRecordingRef`.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseStorageRecordingRef } from "./storage-provider";

const playerJs = readFileSync(
  resolve(import.meta.dirname, "../../player/public/player.js"),
  "utf8",
);

/**
 * Extract and run the production player.js parser against a full href.
 * Does not reimplement strip/parse rules — only loads the function body from disk.
 */
function runShippedResolveReplayRecordingRef(href: string): {
  provider: string;
  fileId: string;
} | null {
  const start = playerJs.indexOf("function resolveReplayRecordingRef()");
  const end = playerJs.indexOf("function resolveReplayRecordingId()");
  if (start < 0 || end <= start) {
    throw new Error("resolveReplayRecordingRef not found in player/public/player.js");
  }
  const fnSource = playerJs.slice(start, end);
  const url = new URL(href, "https://tracing.gnas.dev");
  // eslint-disable-next-line no-new-func -- intentional: execute shipped player.js function body
  const factory = new Function(
    "window",
    `${fnSource}\nreturn resolveReplayRecordingRef();`,
  ) as (window: { location: { pathname: string; search: string } }) => {
    provider: string;
    fileId: string;
  } | null;
  return factory({
    location: {
      pathname: url.pathname,
      search: url.search,
    },
  });
}

const CASES = [
  "https://tracing.gnas.dev/1.7.5/gdrive/1AbCdEfGhIjKlMnOp",
  "https://tracing.gnas.dev/1.6.3/dropbox/scl/fi/abc123/gn-tracing.zip",
  "https://tracing.gnas.dev/gdrive/1AbCdEfGhIjKlMnOp",
  "https://tracing.gnas.dev/dropbox/dbx-file",
  "https://tracing.gnas.dev/1AbCdEfGhIjKlMnOp",
  "https://tracing.gnas.dev/?id=driveFile99",
  "https://tracing.gnas.dev/?id=x&provider=dropbox",
  "https://tracing.gnas.dev/onedrive/whatever",
  "https://tracing.gnas.dev/1.7.5",
  "https://tracing.gnas.dev/privacy",
];

describe("player.js resolveReplayRecordingRef (shipped production path)", () => {
  it("contains product-semver strip before namespaced provider parse", () => {
    expect(playerJs).toMatch(/PRODUCT_SEMVER_RE/);
    expect(playerJs).toMatch(/Optional product-version prefix/);
    // Strip must happen before first.includes(".") rejects "1.7.5"
    const fnStart = playerJs.indexOf("function resolveReplayRecordingRef()");
    const fnBody = playerJs.slice(fnStart, playerJs.indexOf("function resolveReplayRecordingId()"));
    const stripIdx = fnBody.indexOf("PRODUCT_SEMVER_RE.test(segments[0])");
    const rejectDotIdx = fnBody.indexOf('first.includes(".")');
    expect(stripIdx).toBeGreaterThan(0);
    expect(rejectDotIdx).toBeGreaterThan(stripIdx);
  });

  it("parses versioned share links that buildExternalPlayerUrl emits", () => {
    expect(
      runShippedResolveReplayRecordingRef("https://tracing.gnas.dev/1.7.5/gdrive/fileId123"),
    ).toEqual({
      provider: "google-drive",
      fileId: "fileId123",
    });
    expect(
      runShippedResolveReplayRecordingRef(
        "https://tracing.gnas.dev/1.6.3/dropbox/scl%2Ffi%2Fabc%2Ffile.zip",
      ),
    ).toEqual({
      provider: "dropbox",
      fileId: "scl/fi/abc/file.zip",
    });
  });

  it("matches parseStorageRecordingRef for legacy and versioned URL shapes", () => {
    for (const input of CASES) {
      expect({
        input,
        player: runShippedResolveReplayRecordingRef(input),
      }).toEqual({
        input,
        player: parseStorageRecordingRef(input),
      });
    }
  });
});
