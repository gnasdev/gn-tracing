/**
 * Recording-store and locator tests.
 *
 * The recording id is the whole of the remote transport's session state: it is
 * decoded, re-validated, and reopened on every call. So these assert the two
 * things that follow from that — a locator survives the round trip through an
 * id, and an id typed straight into a follow-up call is checked as strictly as
 * one that came from `open`. The cache is asserted through the opener's call
 * count, because eviction means a re-download.
 */

import { describe, expect, it } from "vitest";
import {
  type ByteRangeSource,
  createBytesSource,
  type StorageRecordingRef,
} from "../../packages/replay-core/src/index";
import { buildSamplePackage } from "../../packages/replay-core/src/testing/fixture";
import {
  createRecordingStore,
  decodeRecordingId,
  encodeRecordingId,
  parseRecordingSource,
  type RecordingLocator,
  type SourceOpener,
} from "./resolver";

const DRIVE_ID = "1AbCdEfGhIjKlMnOp";
const DROPBOX_ID = "s/abc123def456";

interface CountingOpener {
  opener: SourceOpener;
  calls: () => number;
  passwords: () => Array<string | undefined>;
}

async function countingOpener(
  options: Parameters<typeof buildSamplePackage>[0] = {},
): Promise<CountingOpener> {
  const bytes = await buildSamplePackage(options);
  const passwords: Array<string | undefined> = [];
  return {
    opener: async (_locator, openOptions): Promise<ByteRangeSource> => {
      passwords.push(openOptions.password);
      return createBytesSource(bytes);
    },
    calls: () => passwords.length,
    passwords: () => passwords,
  };
}

describe("recording id encoding", () => {
  it("round-trips every locator kind through its readable form", () => {
    const locators: RecordingLocator[] = [
      { kind: "remote", ref: { provider: "google-drive", fileId: DRIVE_ID } },
      { kind: "remote", ref: { provider: "dropbox", fileId: DROPBOX_ID } },
      { kind: "local", path: "/tmp/gn-tracing-recording.zip" },
    ];

    for (const locator of locators) {
      expect(decodeRecordingId(encodeRecordingId(locator))).toEqual(locator);
    }
  });

  it("uses the same provider segment a replay link uses", () => {
    expect(
      encodeRecordingId({ kind: "remote", ref: { provider: "google-drive", fileId: DRIVE_ID } }),
    ).toBe(`gdrive:${DRIVE_ID}`);
    expect(
      encodeRecordingId({ kind: "remote", ref: { provider: "dropbox", fileId: DROPBOX_ID } }),
    ).toBe(`dropbox:${DROPBOX_ID}`);
  });

  it("keeps a path that contains a colon intact", () => {
    // Only the first colon separates the scheme, so a Windows-style or
    // colon-bearing path must not be truncated at its own separator.
    const locator: RecordingLocator = { kind: "local", path: "/tmp/odd:name.zip" };
    expect(decodeRecordingId(encodeRecordingId(locator))).toEqual(locator);
  });

  it("rejects an id that is not a locator rather than guessing a provider", () => {
    for (const id of ["", "nonsense", ":no-scheme", "gdrive:", "onedrive:abc", "file:"]) {
      expect(decodeRecordingId(id)).toBeNull();
    }
  });
});

describe("parseRecordingSource", () => {
  it("classifies a replay URL as a remote ref", () => {
    expect(parseRecordingSource(`https://tracing.gnas.dev/gdrive/${DRIVE_ID}`)).toEqual({
      kind: "remote",
      ref: { provider: "google-drive", fileId: DRIVE_ID },
    });
    expect(parseRecordingSource(`https://tracing.gnas.dev/dropbox/${DROPBOX_ID}`)).toEqual({
      kind: "remote",
      ref: { provider: "dropbox", fileId: DROPBOX_ID },
    });
  });

  it("accepts a bare recording id", () => {
    expect(parseRecordingSource(DRIVE_ID)).toEqual({
      kind: "remote",
      ref: { provider: "google-drive", fileId: DRIVE_ID },
    });
  });

  it("classifies the local forms a user actually pastes", () => {
    const cases: Array<[string, string]> = [
      ["./recording.zip", "./recording.zip"],
      ["~/Downloads/gn-tracing.zip", "~/Downloads/gn-tracing.zip"],
      ["/Users/me/Downloads/gn-tracing.zip", "/Users/me/Downloads/gn-tracing.zip"],
      // The scheme is stripped so the path reaches the filesystem as a path.
      ["file:///tmp/gn-tracing.zip", "/tmp/gn-tracing.zip"],
    ];

    for (const [source, path] of cases) {
      expect(parseRecordingSource(source, { allowLocalFiles: true })).toEqual({
        kind: "local",
        path,
      });
    }
  });

  it("points a local path at the local server when the transport forbids files", () => {
    for (const source of ["./recording.zip", "~/r.zip", "file:///tmp/r.zip"]) {
      expect(() => parseRecordingSource(source)).toThrowError(
        expect.objectContaining({ code: "INVALID_SOURCE" }),
      );
    }
    // The hint is the actionable half of the error: the user has somewhere to go.
    try {
      parseRecordingSource("./recording.zip");
      expect.unreachable("expected a local path to be rejected");
    } catch (error) {
      expect((error as { hint?: string }).hint).toContain("local MCP server");
    }
  });

  it("rejects an empty source and an unrecognizable one", () => {
    expect(() => parseRecordingSource("   ")).toThrowError(
      expect.objectContaining({ code: "INVALID_SOURCE" }),
    );
    expect(() => parseRecordingSource("not-a-link.example")).toThrowError(
      expect.objectContaining({ code: "INVALID_SOURCE" }),
    );
  });

  it("rejects a ref the download proxy would refuse", () => {
    // An absolute URL inside the file id is the SSRF shape the allow-list exists
    // for; a traversal id is the other.
    expect(() =>
      parseRecordingSource("https://tracing.gnas.dev/dropbox/https://evil.example/x"),
    ).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_PROVIDER" }));
    expect(() =>
      parseRecordingSource("https://tracing.gnas.dev/dropbox/not-a-shared-link"),
    ).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_PROVIDER" }));
  });
});

describe("recording store", () => {
  it("serves a follow-up call from the cache without reopening the package", async () => {
    const { opener, calls } = await countingOpener();
    const store = createRecordingStore({ openSource: opener });

    const opened = await store.open(`https://tracing.gnas.dev/gdrive/${DRIVE_ID}`);
    expect(opened.recordingId).toBe(`gdrive:${DRIVE_ID}`);
    expect(opened.replayUrl).toBe(`https://tracing.gnas.dev/gdrive/${DRIVE_ID}`);

    await store.get(opened.recordingId);
    await store.get(opened.recordingId);
    expect(calls()).toBe(1);
  });

  it("reopens a recording the LRU has evicted", async () => {
    const { opener, calls } = await countingOpener();
    const store = createRecordingStore({ openSource: opener, maxCached: 1 });

    const first = await store.open(`https://tracing.gnas.dev/gdrive/${DRIVE_ID}`);
    await store.open("https://tracing.gnas.dev/dropbox/s/second000");
    expect(calls()).toBe(2);

    // The first recording is gone, so this call costs another download — the
    // observable consequence of a bounded cache, and the reason `password` has
    // to be resendable on any tool call.
    await store.get(first.recordingId);
    expect(calls()).toBe(3);
  });

  it("reopens with the new password when it differs from the cached one", async () => {
    const { opener, calls, passwords } = await countingOpener({ password: "correct horse" });
    const store = createRecordingStore({ openSource: opener });

    await store.open(`https://tracing.gnas.dev/gdrive/${DRIVE_ID}`, {
      password: "correct horse",
    });
    expect(calls()).toBe(1);

    await store.get(`gdrive:${DRIVE_ID}`, { password: "correct horse" });
    expect(calls()).toBe(1);

    await expect(store.get(`gdrive:${DRIVE_ID}`, { password: "wrong" })).rejects.toMatchObject({
      code: "WRONG_PASSWORD",
    });
    expect(passwords()).toEqual(["correct horse", "wrong"]);
  });

  it("reuses the cached password when a later call omits it", async () => {
    const { opener, calls } = await countingOpener({ password: "correct horse" });
    const store = createRecordingStore({ openSource: opener });

    const opened = await store.open(`https://tracing.gnas.dev/gdrive/${DRIVE_ID}`, {
      password: "correct horse",
    });
    const again = await store.get(opened.recordingId);

    expect(again.recordingId).toBe(opened.recordingId);
    expect(calls()).toBe(1);
  });

  it("names the id it could not decode", async () => {
    const { opener } = await countingOpener();
    const store = createRecordingStore({ openSource: opener });

    await expect(store.get("nonsense")).rejects.toMatchObject({
      code: "UNKNOWN_RECORDING",
      message: expect.stringContaining("nonsense"),
    });
  });

  it("rejects an unsupported ref from open and from a typed-in id alike", async () => {
    const { opener, calls } = await countingOpener();
    const store = createRecordingStore({ openSource: opener });
    const unsupported: StorageRecordingRef = {
      provider: "dropbox",
      fileId: "not-a-shared-link",
    };

    await expect(
      store.open("https://tracing.gnas.dev/dropbox/not-a-shared-link"),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_PROVIDER" });

    // Same rejection when the id skips `open` entirely, which is the path a
    // model takes when it invents a follow-up id.
    await expect(
      store.get(encodeRecordingId({ kind: "remote", ref: unsupported })),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_PROVIDER" });

    // Neither reached the download proxy.
    expect(calls()).toBe(0);
  });

  it("refuses a local recording id when the transport reads hosted packages only", async () => {
    const { opener, calls } = await countingOpener();
    const store = createRecordingStore({ openSource: opener });

    await expect(store.get("file:/tmp/gn-tracing.zip")).rejects.toMatchObject({
      code: "INVALID_SOURCE",
    });
    expect(calls()).toBe(0);
  });

  it("serves a local recording id when the transport allows files", async () => {
    const { opener } = await countingOpener();
    const store = createRecordingStore({ openSource: opener, allowLocalFiles: true });

    const opened = await store.get("file:/tmp/gn-tracing.zip");
    expect(opened.locator).toEqual({ kind: "local", path: "/tmp/gn-tracing.zip" });
    // A local package has no hosted link, so there is nothing for a human to open.
    expect(opened.replayUrl).toBeUndefined();
  });

  it("forwards the per-entry read ceiling to the package reader", async () => {
    const { opener } = await countingOpener();
    const store = createRecordingStore({ openSource: opener, maxEntryBytes: 8 });

    // A Worker-sized budget must be enforced by the reader, not merely recorded:
    // the sample package's artifacts are all larger than eight bytes.
    await expect(store.open(`https://tracing.gnas.dev/gdrive/${DRIVE_ID}`)).rejects.toMatchObject({
      code: "ENTRY_TOO_LARGE",
    });
  });
});
