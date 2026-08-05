/**
 * The writer/reader round-trip property.
 *
 * Every package `buildRecordingPackage` produces must be readable by
 * `openRecordingPackage`, and every artifact must come back byte-identical.
 * This is the contract that lets a second producer (the SDK) exist at all: it
 * is checked against the real reader rather than against a copy of the writer's
 * own assumptions, so a producer that drifts fails here instead of in a user's
 * player.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { openRecordingPackageFromBytes } from "../artifacts";
import { ATTACHABLE_ARTIFACT_IDS, EXTENSION_CAPABILITIES, SDK_CAPABILITIES } from "../schema";
import {
  type AttachableArtifactId,
  buildRecordingPackage,
  encodeJsonArtifact,
  splitIntoParts,
} from "./package-writer";
import { concatChunks } from "./zip-writer";

/** Deterministic salt so an encrypted package is reproducible across runs. */
const fixedSalt = (length: number): Uint8Array =>
  Uint8Array.from({ length }, (_, index) => (index * 37 + 11) & 0xff);

const JSON_ARTIFACT_IDS = ATTACHABLE_ARTIFACT_IDS.filter((id) => id !== "screenshot");

function buildBytes(chunks: Uint8Array[]): Uint8Array {
  return concatChunks(chunks);
}

describe("recording package round-trip", () => {
  // Property suite does many zip write/read cycles; under loaded pre-commit
  // runners 5s is occasionally tight on macOS shared hosts.
  it("reads back every artifact the writer attached", { timeout: 20_000 }, async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.constantFrom(...JSON_ARTIFACT_IDS), { minLength: 0, maxLength: 6 }),
        fc.array(fc.integer({ min: 0, max: 255 }), { minLength: 0, maxLength: 200 }),
        fc.boolean(),
        async (ids, videoByteValues, withVideo) => {
          const artifacts: Partial<Record<AttachableArtifactId, Uint8Array>> = {};
          for (const id of ids) {
            artifacts[id] = encodeJsonArtifact({ id, entries: [{ marker: `payload-${id}` }] });
          }

          const videoBytes = Uint8Array.from(videoByteValues);
          const parts = withVideo ? splitIntoParts(videoBytes, 64) : [];

          const built = await buildRecordingPackage({
            producer: withVideo ? "extension" : "sdk",
            capabilities: withVideo ? EXTENSION_CAPABILITIES : SDK_CAPABILITIES,
            packagedAt: "2026-01-01T00:00:00.000Z",
            zipFilename: "gn-tracing-test.zip",
            duration: 12,
            url: "https://example.test/checkout",
            startTime: 1_700_000_000_000,
            ...(withVideo
              ? {
                  video: {
                    mimeType: "video/webm;codecs=vp9,opus",
                    totalBytes: videoBytes.byteLength,
                    parts: parts.map((bytes) => ({ bytes })),
                  },
                }
              : {}),
            artifacts,
            modifiedAt: new Date(0),
          });

          const pkg = await openRecordingPackageFromBytes(buildBytes(built.chunks));

          expect(pkg.metadata.producer).toBe(withVideo ? "extension" : "sdk");
          expect(pkg.metadata.capabilities).toEqual(
            withVideo ? EXTENSION_CAPABILITIES : SDK_CAPABILITIES,
          );

          for (const id of ids) {
            expect(pkg.hasArtifact(id), `artifact ${id} should be present`).toBe(true);
            const parsed = await pkg.readArtifact<{ id: string }>(id);
            expect(parsed?.id).toBe(id);
          }
          for (const id of JSON_ARTIFACT_IDS) {
            if (!ids.includes(id)) {
              expect(pkg.hasArtifact(id), `artifact ${id} should be absent`).toBe(false);
            }
          }
        },
      ),
      { numRuns: 40 },
    );
  });

  it("round-trips a password-protected package and rejects the wrong password", async () => {
    const built = await buildRecordingPackage({
      producer: "extension",
      capabilities: EXTENSION_CAPABILITIES,
      packagedAt: "2026-01-01T00:00:00.000Z",
      zipFilename: "gn-tracing-protected.zip",
      artifacts: { console: encodeJsonArtifact([{ level: "error", message: "boom" }]) },
      password: "correct horse",
      randomBytes: fixedSalt,
      modifiedAt: new Date(0),
    });
    const bytes = buildBytes(built.chunks);

    const opened = await openRecordingPackageFromBytes(bytes, { password: "correct horse" });
    const entries = await opened.readArtifact<Array<{ message: string }>>("console");
    expect(entries?.[0]?.message).toBe("boom");

    // Opening already reads metadata.json, so a wrong password fails there
    // rather than on the first artifact read.
    await expect(openRecordingPackageFromBytes(bytes, { password: "wrong" })).rejects.toThrow(
      /password is incorrect/i,
    );
    await expect(openRecordingPackageFromBytes(bytes)).rejects.toThrow(/password protected/i);
  });

  it("reassembles byte-split video parts in order", async () => {
    const videoBytes = Uint8Array.from({ length: 500 }, (_, index) => index & 0xff);
    const parts = splitIntoParts(videoBytes, 128);
    expect(parts).toHaveLength(4);

    const built = await buildRecordingPackage({
      producer: "extension",
      capabilities: EXTENSION_CAPABILITIES,
      packagedAt: "2026-01-01T00:00:00.000Z",
      zipFilename: "gn-tracing-video.zip",
      video: {
        mimeType: "video/webm;codecs=vp9,opus",
        totalBytes: videoBytes.byteLength,
        parts: parts.map((bytes) => ({ bytes })),
      },
      artifacts: {},
      modifiedAt: new Date(0),
    });

    const pkg = await openRecordingPackageFromBytes(buildBytes(built.chunks));
    const partPaths = pkg.index?.video?.partPaths ?? [];
    expect(partPaths).toEqual([
      "video.part-000.webm",
      "video.part-001.webm",
      "video.part-002.webm",
      "video.part-003.webm",
    ]);

    const rejoined = concatChunks(
      await Promise.all(partPaths.map((name) => pkg.readEntryBytes(name))),
    );
    expect(rejoined).toEqual(videoBytes);
  });

  it("writes the index documents and agent summary ahead of the video", async () => {
    const built = await buildRecordingPackage({
      producer: "extension",
      capabilities: EXTENSION_CAPABILITIES,
      packagedAt: "2026-01-01T00:00:00.000Z",
      zipFilename: "gn-tracing-order.zip",
      video: {
        mimeType: "video/webm",
        totalBytes: 8,
        parts: [{ bytes: new Uint8Array(8) }],
      },
      artifacts: {
        agentSummary: encodeJsonArtifact({ schemaVersion: 1 }),
        console: encodeJsonArtifact([]),
      },
      modifiedAt: new Date(0),
    });

    expect(built.entryNames).toEqual([
      "recording-index.json",
      "manifest.json",
      "metadata.json",
      "agent-summary.json",
      "video.part-000.webm",
      "console.json",
    ]);
  });

  it("omits video fields entirely for a producer that captures none", async () => {
    const built = await buildRecordingPackage({
      producer: "sdk",
      capabilities: SDK_CAPABILITIES,
      packagedAt: "2026-01-01T00:00:00.000Z",
      zipFilename: "gn-tracing-sdk.zip",
      artifacts: { console: encodeJsonArtifact([]) },
      modifiedAt: new Date(0),
    });

    expect(built.metadata.video).toBeUndefined();
    expect(built.manifest.video).toBeUndefined();
    expect(built.index.video).toBeUndefined();

    const pkg = await openRecordingPackageFromBytes(buildBytes(built.chunks));
    expect(pkg.metadata.capabilities).not.toContain("video");
  });
});
