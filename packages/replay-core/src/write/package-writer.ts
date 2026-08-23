/**
 * Builds a recording package: artifacts in, ZIP chunks plus the three index
 * documents out.
 *
 * This is the single producer-side entry point. The extension calls it from the
 * offscreen document with video parts attached; the browser SDK calls it with
 * none. Everything that used to make the packager extension-shaped — `Blob`,
 * Drive/Dropbox ids, progress reporting — stays with the caller.
 *
 * Ordering is part of the contract. `recording-index.json`, `manifest.json`,
 * `metadata.json`, and `agent-summary.json` are written before the video parts
 * so a ranged reader finds them in the first few kilobytes of a package that is
 * otherwise hundreds of megabytes of WebM.
 */

import {
  ARTIFACT_FILENAMES,
  ARTIFACT_INDEX_KEYS,
  type AttachableArtifactId,
  type EvidenceCoverage,
  type PackageManifest,
  type PackageMetadata,
  type RecordingCapability,
  type RecordingIndex,
  type RecordingProducer,
} from "../schema/package";
import { buildZipArchive, type ZipInputEntry } from "./zip-writer";

export type { AttachableArtifactId };

export interface VideoPartInput {
  bytes: Uint8Array;
}

export interface VideoInput {
  mimeType: string;
  /** Byte-split parts, in order. Reassembled by concatenation. */
  parts: VideoPartInput[];
  /** Size of the whole video before splitting. */
  totalBytes: number;
}

export interface BuildPackageInput {
  producer: RecordingProducer;
  capabilities: RecordingCapability[];
  /** Selected evidence sources and their per-surface fidelity. */
  evidenceCoverage?: EvidenceCoverage;
  /** ISO timestamp for `metadata.timestamp`. */
  packagedAt: string;
  /** Filename the package will be stored under, recorded in metadata. */
  zipFilename: string;
  /**
   * Producer product version written to `metadata.version` (extension/SDK
   * semver). Defaults to `0.0.0` only for fixtures that omit it.
   */
  version?: string;
  /** Recording duration in seconds, or null when unknown. */
  duration?: number | null;
  /** Page URL the session was recorded on. */
  url?: string;
  /** Epoch ms of the first captured event, or null. */
  startTime?: number | null;
  storage?: { provider?: string; folderId?: string | null };
  /** Omitted by producers that cannot capture video, such as the SDK. */
  video?: VideoInput;
  /** Serialized artifact payloads keyed by logical id. Absent = not captured. */
  artifacts: Partial<Record<AttachableArtifactId, Uint8Array>>;
  /**
   * Extra entries written at a fixed path rather than at an artifact id's
   * conventional filename — screenshot images under `screenshots/`, for
   * instance, where the count is not known in advance. They are written before
   * the video so a ranged reader can pull an image without the media.
   */
  extraEntries?: Array<{ name: string; bytes: Uint8Array }>;
  password?: string;
  modifiedAt?: Date;
  randomBytes?: (length: number) => Uint8Array;
}

export interface BuiltPackage {
  /** ZIP bytes as a chunk list; pass straight to `new Blob(chunks)`. */
  chunks: Uint8Array[];
  totalBytes: number;
  metadata: PackageMetadata;
  manifest: PackageManifest;
  index: RecordingIndex;
  /** Entry names in write order, for diagnostics and conformance tests. */
  entryNames: string[];
}

const JSON_ENCODER = new TextEncoder();

export function encodeJsonArtifact(value: unknown): Uint8Array {
  return JSON_ENCODER.encode(JSON.stringify(value));
}

export function videoPartName(index: number): string {
  return `video.part-${String(index).padStart(3, "0")}.webm`;
}

/**
 * Splits a byte array into parts no larger than `maxPartBytes`. Producers use
 * this to stay under a storage provider's simple-upload ceiling; the reader
 * concatenates the parts back.
 */
export function splitIntoParts(bytes: Uint8Array, maxPartBytes: number): Uint8Array[] {
  if (maxPartBytes <= 0 || bytes.byteLength <= maxPartBytes) {
    return [bytes];
  }
  const parts: Uint8Array[] = [];
  for (let start = 0; start < bytes.byteLength; start += maxPartBytes) {
    parts.push(bytes.subarray(start, Math.min(start + maxPartBytes, bytes.byteLength)));
  }
  return parts;
}

/**
 * Artifacts written ahead of the video, in this order. `agent-summary.json` is
 * here because an agent reading a package over HTTP range requests should get
 * it in the first read.
 */
const EARLY_ARTIFACTS: AttachableArtifactId[] = ["agentSummary"];

export async function buildRecordingPackage(input: BuildPackageInput): Promise<BuiltPackage> {
  const present = (Object.keys(input.artifacts) as AttachableArtifactId[]).filter(
    (id) => input.artifacts[id] !== undefined,
  );

  const metadata: PackageMetadata = {
    timestamp: input.packagedAt,
    duration: input.duration ?? null,
    url: input.url,
    startTime: input.startTime ?? null,
    extension: "gn-tracing",
    version: String(input.version || "").trim() || "0.0.0",
    producer: input.producer,
    capabilities: input.capabilities,
    evidenceCoverage: input.evidenceCoverage,
    storage: {
      provider: input.storage?.provider,
      folderId: input.storage?.folderId ?? null,
      package: input.zipFilename,
    },
    ...(input.video
      ? {
          video: {
            mimeType: input.video.mimeType,
            totalBytes: input.video.totalBytes,
            partCount: input.video.parts.length,
          },
        }
      : {}),
  };

  const manifestArtifacts: Record<string, string> = { metadata: ARTIFACT_FILENAMES.metadata };
  const indexArtifacts: Record<string, string> = {};
  for (const id of present) {
    manifestArtifacts[id] = ARTIFACT_FILENAMES[id];
    const indexKey = ARTIFACT_INDEX_KEYS[id];
    if (indexKey) {
      indexArtifacts[indexKey] = ARTIFACT_FILENAMES[id];
    }
  }

  const videoPartNames = (input.video?.parts ?? []).map((_, index) => videoPartName(index));

  const manifest: PackageManifest = {
    schemaVersion: 1,
    folderId: input.storage?.folderId ?? null,
    ...(input.video
      ? {
          video: {
            mimeType: input.video.mimeType,
            totalBytes: input.video.totalBytes,
            parts: input.video.parts.map((part, index) => ({
              name: videoPartNames[index],
              size: part.bytes.byteLength,
            })),
          },
        }
      : {}),
    artifacts: manifestArtifacts,
  };

  const index: RecordingIndex & {
    folderId?: string | null;
    package?: { filename: string; format: string };
  } = {
    schemaVersion: 2,
    folderId: input.storage?.folderId ?? null,
    package: { filename: input.zipFilename, format: "zip" },
    manifestPath: ARTIFACT_FILENAMES.manifest,
    metadataPath: ARTIFACT_FILENAMES.metadata,
    artifacts: indexArtifacts,
    ...(input.video
      ? {
          video: {
            mimeType: input.video.mimeType,
            totalBytes: input.video.totalBytes,
            partPaths: videoPartNames,
          },
        }
      : {}),
  };

  const early = EARLY_ARTIFACTS.filter((id) => present.includes(id));
  const late = present.filter((id) => !early.includes(id));

  const entries: ZipInputEntry[] = [
    { name: ARTIFACT_FILENAMES.index, bytes: encodeJsonArtifact(index) },
    { name: ARTIFACT_FILENAMES.manifest, bytes: encodeJsonArtifact(manifest) },
    { name: ARTIFACT_FILENAMES.metadata, bytes: encodeJsonArtifact(metadata) },
    ...early.map((id) => ({
      name: ARTIFACT_FILENAMES[id],
      bytes: input.artifacts[id] as Uint8Array,
    })),
    ...(input.extraEntries ?? []),
    ...(input.video?.parts ?? []).map((part, partIndex) => ({
      name: videoPartNames[partIndex],
      bytes: part.bytes,
    })),
    ...late.map((id) => ({
      name: ARTIFACT_FILENAMES[id],
      bytes: input.artifacts[id] as Uint8Array,
    })),
  ];

  const chunks = await buildZipArchive(entries, {
    modifiedAt: input.modifiedAt,
    password: input.password,
    randomBytes: input.randomBytes,
  });

  return {
    chunks,
    totalBytes: chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0),
    metadata,
    manifest,
    index,
    entryNames: entries.map((entry) => entry.name),
  };
}
