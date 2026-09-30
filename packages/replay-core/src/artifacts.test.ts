/**
 * Package-reading tests.
 *
 * The load-bearing claim of this layer is that reading a recording over HTTP
 * does **not** download the video, which is ~99% of a real package. That is
 * asserted directly here by recording every byte range the reader requests and
 * checking it never overlaps the video entry.
 */

import { describe, expect, it, vi } from "vitest";
import { openRecordingPackage, openRecordingPackageFromBytes } from "./artifacts";
import { createBytesSource, createHttpSource, parseContentRange } from "./package-source";
import { buildFixturePackage, buildSamplePackage } from "./testing/fixture";
import { parseZipCentralDirectory } from "./zip-reader";

interface RangeRequest {
  start: number;
  end: number;
}

/**
 * A fetch stub that behaves like the hosted download proxies: it honours
 * `Range` and answers `206` with a `Content-Range` header.
 */
function createRangeFetch(bytes: Uint8Array, ranges: RangeRequest[], supportRanges = true) {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const rangeHeader = (init?.headers as Record<string, string> | undefined)?.range;
    if (!rangeHeader || !supportRanges) {
      return new Response(new Uint8Array(bytes), {
        status: 200,
        headers: { "content-length": String(bytes.length) },
      });
    }

    const suffix = /^bytes=-(\d+)$/.exec(rangeHeader);
    const explicit = /^bytes=(\d+)-(\d+)$/.exec(rangeHeader);
    let start: number;
    let end: number;
    if (suffix) {
      start = Math.max(0, bytes.length - Number(suffix[1]));
      end = bytes.length;
    } else if (explicit) {
      start = Number(explicit[1]);
      end = Math.min(bytes.length, Number(explicit[2]) + 1);
    } else {
      return new Response(new Uint8Array(bytes), { status: 200 });
    }

    ranges.push({ start, end });
    return new Response(new Uint8Array(bytes.subarray(start, end)), {
      status: 206,
      headers: {
        "content-range": `bytes ${start}-${end - 1}/${bytes.length}`,
        "content-length": String(end - start),
      },
    });
  });
}

describe("openRecordingPackage", () => {
  it("reads metadata, manifest, and the artifact inventory", async () => {
    const bytes = await buildSamplePackage();
    const pkg = await openRecordingPackageFromBytes(bytes);

    expect(pkg.metadata.url).toBe("https://shop.example.com/checkout");
    expect(pkg.manifest?.artifacts?.console).toBe("console.json");
    expect(pkg.availableArtifacts).toContain("console");
    expect(pkg.availableArtifacts).toContain("network");
    expect(pkg.hasArtifact("agentSummary")).toBe(false);
  });

  it("returns null for an artifact the package does not contain", async () => {
    const bytes = await buildSamplePackage({ withConsole: false });
    const pkg = await openRecordingPackageFromBytes(bytes);

    expect(pkg.hasArtifact("console")).toBe(false);
    expect(await pkg.readArtifact("console")).toBeNull();
  });

  it("reads artifacts over HTTP without ever touching the video entry", async () => {
    const bytes = await buildSamplePackage();
    const parsed = parseZipCentralDirectory(bytes);
    if (!parsed.ok) {
      throw new Error("fixture should parse");
    }
    const videoEntry = parsed.entries.find((entry) => entry.name.startsWith("video.part-"));
    if (!videoEntry) {
      throw new Error("fixture should contain a video part");
    }
    const videoStart = videoEntry.localHeaderOffset;
    const videoEnd = videoStart + 30 + videoEntry.name.length + videoEntry.compressedSize;

    const ranges: RangeRequest[] = [];
    const fetchImpl = createRangeFetch(bytes, ranges);
    const pkg = await openRecordingPackage(
      createHttpSource("https://tracing.gnas.dev/api/drive?id=x", { fetchImpl }),
    );
    const consoleArtifact = await pkg.readArtifact<unknown[]>("console");

    expect(Array.isArray(consoleArtifact)).toBe(true);
    expect(ranges.length).toBeGreaterThan(0);
    // The video payload span must never appear in a requested range.
    const overlapsVideo = ranges.some(
      (range) => range.start < videoEnd && range.end > videoStart + 30 + videoEntry.name.length,
    );
    expect(overlapsVideo).toBe(false);
  });

  it("falls back to a single full download when the server ignores Range", async () => {
    const bytes = await buildSamplePackage();
    const ranges: RangeRequest[] = [];
    const fetchImpl = createRangeFetch(bytes, ranges, false);

    const pkg = await openRecordingPackage(
      createHttpSource("https://tracing.gnas.dev/api/drive?id=x", { fetchImpl }),
    );
    expect(await pkg.readArtifact("console")).not.toBeNull();
    // One buffered download, then every later read is served from memory.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(pkg.source.isFullyBuffered()).toBe(true);
  });

  it("refuses a package larger than the configured ceiling", async () => {
    const bytes = await buildSamplePackage();
    const fetchImpl = createRangeFetch(bytes, [], false);

    await expect(
      openRecordingPackage(
        createHttpSource("https://tracing.gnas.dev/api/drive?id=x", { fetchImpl, maxBytes: 128 }),
      ),
    ).rejects.toMatchObject({ code: "PACKAGE_TOO_LARGE" });
  });

  it("maps a missing package to PACKAGE_NOT_FOUND", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 404 }));
    await expect(
      openRecordingPackage(
        createHttpSource("https://tracing.gnas.dev/api/drive?id=x", { fetchImpl }),
      ),
    ).rejects.toMatchObject({ code: "PACKAGE_NOT_FOUND" });
  });

  it("rejects a zip that is not a recording package", async () => {
    const bytes = await buildFixturePackage([{ name: "notes.txt", content: "hello" }]);
    await expect(openRecordingPackageFromBytes(bytes)).rejects.toMatchObject({
      code: "PACKAGE_MALFORMED",
    });
  });

  it("reports a password-protected package before asking for artifacts", async () => {
    const bytes = await buildSamplePackage({ password: "hunter2" });
    await expect(openRecordingPackageFromBytes(bytes)).rejects.toMatchObject({
      code: "PACKAGE_ENCRYPTED",
    });

    const pkg = await openRecordingPackageFromBytes(bytes, { password: "hunter2" });
    expect(pkg.metadata.url).toBe("https://shop.example.com/checkout");
  });

  it("surfaces a wrong password distinctly", async () => {
    const bytes = await buildSamplePackage({ password: "hunter2" });
    await expect(openRecordingPackageFromBytes(bytes, { password: "nope" })).rejects.toMatchObject({
      code: "WRONG_PASSWORD",
    });
  });
});

describe("createBytesSource", () => {
  it("clamps out-of-range reads instead of throwing", async () => {
    const source = createBytesSource(new Uint8Array([1, 2, 3]));
    expect(await source.read(-10, 99)).toEqual(new Uint8Array([1, 2, 3]));
    expect((await source.readTail(2)).start).toBe(1);
  });
});

describe("parseContentRange", () => {
  it("parses a standard header", () => {
    expect(parseContentRange("bytes 10-19/100")).toEqual({ start: 10, end: 19, total: 100 });
  });

  it("tolerates an unknown total", () => {
    expect(parseContentRange("bytes 0-9/*")).toEqual({ start: 0, end: 9, total: null });
  });

  it("returns null for anything else", () => {
    expect(parseContentRange("pages 1-2")).toBeNull();
  });
});
