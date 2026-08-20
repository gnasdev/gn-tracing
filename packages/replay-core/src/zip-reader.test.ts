/**
 * Zip reader tests.
 *
 * Property 9 of the repo's safety properties (ZIP/CRC parsing safety) says the
 * structural parse must be *total*: for any byte buffer it returns a typed
 * result and never throws. The property test below is the enforcement, and the
 * round-trip tests prove the reader agrees with the writer the extension ships.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildFixturePackage } from "./testing/fixture";
import {
  calculateCrc32,
  decodeZipEntryPayload,
  decryptZipCryptoPayload,
  locateZipCentralDirectory,
  parseZipCentralDirectory,
  resolveZipPayloadSpan,
  ZipEntryError,
  type ZipEntryRecord,
} from "./zip-reader";

/** Resolves an entry's payload span, failing the test if the header is corrupt. */
function requireSpan(entry: ZipEntryRecord, bytes: Uint8Array): { start: number; end: number } {
  const span = resolveZipPayloadSpan(entry, bytes.subarray(entry.localHeaderOffset));
  if (!span) {
    throw new Error(`fixture entry ${entry.name} should have a readable local header`);
  }
  return span;
}

describe("parseZipCentralDirectory", () => {
  it("never throws for arbitrary byte buffers", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 512 }), (bytes) => {
        const result = parseZipCentralDirectory(bytes);
        expect(typeof result.ok).toBe("boolean");
        if (!result.ok) {
          expect(typeof result.code).toBe("string");
        }
      }),
    );
  });

  it("reports an empty buffer", () => {
    const result = parseZipCentralDirectory(new Uint8Array(0));
    expect(result).toMatchObject({ ok: false, code: "EMPTY_BUFFER" });
  });

  it("reports a buffer with no end-of-central-directory record", () => {
    const result = parseZipCentralDirectory(new Uint8Array(64).fill(9));
    expect(result).toMatchObject({ ok: false, code: "EOCD_NOT_FOUND" });
  });

  it("lists every entry of a package written by the fixture writer", async () => {
    const bytes = await buildFixturePackage([
      { name: "metadata.json", content: { hello: "world" } },
      { name: "video.part-000.webm", content: new Uint8Array(128).fill(3), method: 0 },
    ]);

    const result = parseZipCentralDirectory(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.entries.map((entry) => entry.name)).toEqual([
      "metadata.json",
      "video.part-000.webm",
    ]);
  });
});

describe("locateZipCentralDirectory", () => {
  it("resolves absolute coordinates from a tail-only read", async () => {
    const bytes = await buildFixturePackage([
      { name: "metadata.json", content: { hello: "world" } },
    ]);
    const tailStart = bytes.length - 40;

    const located = locateZipCentralDirectory(bytes.subarray(tailStart), tailStart);
    expect(located.ok).toBe(true);
    if (!located.ok) {
      return;
    }

    const full = locateZipCentralDirectory(bytes, 0);
    expect(full.ok).toBe(true);
    if (full.ok) {
      expect(located.centralOffset).toBe(full.centralOffset);
      expect(located.entryCount).toBe(full.entryCount);
    }
  });
});

describe("entry payloads", () => {
  it("round-trips a stored entry", async () => {
    const payload = { message: "stored" };
    const bytes = await buildFixturePackage([
      { name: "metadata.json", content: payload, method: 0 },
    ]);
    const parsed = parseZipCentralDirectory(bytes);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }

    const entry = parsed.entries[0];
    const span = requireSpan(entry, bytes);
    const decoded = await decodeZipEntryPayload(entry, bytes.subarray(span.start, span.end));
    expect(JSON.parse(new TextDecoder().decode(decoded))).toEqual(payload);
  });

  it("round-trips a deflated entry", async () => {
    const payload = { message: "x".repeat(4096) };
    const bytes = await buildFixturePackage([
      { name: "console.json", content: payload, method: 8 },
    ]);
    const parsed = parseZipCentralDirectory(bytes);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }

    const entry = parsed.entries[0];
    expect(entry.compressionMethod).toBe(8);
    const span = requireSpan(entry, bytes);
    const decoded = await decodeZipEntryPayload(entry, bytes.subarray(span.start, span.end));
    expect(JSON.parse(new TextDecoder().decode(decoded))).toEqual(payload);
  });

  it("decrypts a ZipCrypto entry with the right password and rejects the wrong one", async () => {
    const payload = { message: "secret" };
    const bytes = await buildFixturePackage([{ name: "metadata.json", content: payload }], {
      password: "hunter2",
    });
    const parsed = parseZipCentralDirectory(bytes);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }

    const entry = parsed.entries[0];
    expect(entry.isEncrypted).toBe(true);
    const span = requireSpan(entry, bytes);
    const encrypted = bytes.subarray(span.start, span.end);

    const decoded = await decodeZipEntryPayload(entry, encrypted, "hunter2");
    expect(JSON.parse(new TextDecoder().decode(decoded))).toEqual(payload);

    await expect(decodeZipEntryPayload(entry, encrypted, "wrong")).rejects.toBeInstanceOf(
      ZipEntryError,
    );
    await expect(decodeZipEntryPayload(entry, encrypted, "")).rejects.toMatchObject({
      code: "MISSING_PASSWORD",
    });
  });

  it("flags a payload whose CRC does not match", async () => {
    const bytes = await buildFixturePackage([
      { name: "metadata.json", content: { a: 1 }, method: 0 },
    ]);
    const parsed = parseZipCentralDirectory(bytes);
    if (!parsed.ok) {
      throw new Error("fixture should parse");
    }
    const entry = parsed.entries[0];
    const span = requireSpan(entry, bytes);
    const corrupted = new Uint8Array(bytes.subarray(span.start, span.end));
    corrupted[0] ^= 0xff;

    await expect(decodeZipEntryPayload(entry, corrupted)).rejects.toMatchObject({
      code: "CRC_MISMATCH",
    });
  });

  it("caps inflated output independent of the entry's declared uncompressedSize", async () => {
    // Highly repetitive content compresses to a tiny payload but expands back to
    // its full size, which is exactly what makes an under-declared
    // uncompressedSize dangerous: the central directory's own size field is not
    // a bound on what decompression can produce.
    const realSize = 2 * 1024 * 1024;
    const bytes = await buildFixturePackage([
      { name: "console.json", content: "a".repeat(realSize), method: 8 },
    ]);
    const parsed = parseZipCentralDirectory(bytes);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const entry = parsed.entries[0];
    expect(entry.uncompressedSize).toBe(realSize);
    const span = requireSpan(entry, bytes);
    const payload = bytes.subarray(span.start, span.end);

    // A lying central directory: same compressed bytes, a small declared size.
    const lyingEntry: ZipEntryRecord = { ...entry, uncompressedSize: 1024 };

    const decoded = await decodeZipEntryPayload(lyingEntry, payload);
    expect(decoded.byteLength).toBe(realSize);

    await expect(decodeZipEntryPayload(lyingEntry, payload, "", 1024 * 1024)).rejects.toMatchObject(
      { code: "ENTRY_TOO_LARGE" },
    );
  });
});

describe("decryptZipCryptoPayload", () => {
  it("requires a password", () => {
    const result = decryptZipCryptoPayload(new Uint8Array(20), "", 0);
    expect(result).toMatchObject({ ok: false, code: "MISSING_PASSWORD" });
  });

  it("reports truncated payloads", () => {
    const result = decryptZipCryptoPayload(new Uint8Array(4), "pw", 0);
    expect(result).toMatchObject({ ok: false, code: "TRUNCATED" });
  });
});

describe("calculateCrc32", () => {
  it("matches the known CRC of a well-known input", () => {
    expect(calculateCrc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
});
