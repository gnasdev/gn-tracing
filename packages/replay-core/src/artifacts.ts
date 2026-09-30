/**
 * Recording package reader: zip entries in, typed artifacts out.
 *
 * The artifact taxonomy lives in `./schema/package.ts` and is documented in
 * `docs/shared/data-models.md`. Everything here is tolerant of older packages:
 * artifact paths are resolved from `manifest.json` first, then
 * `recording-index.json`, then the conventional filename, and a missing optional
 * artifact is `null` rather than an error.
 */

import { ReplayError } from "./errors";
import { type ByteRangeSource, createBytesSource } from "./package-source";
import {
  ARTIFACT_FILENAMES,
  ARTIFACT_INDEX_KEYS,
  type ArtifactId,
  type PackageManifest,
  type PackageMetadata,
  type RecordingIndex,
} from "./schema/package";
import {
  decodeZipEntryPayload,
  locateZipCentralDirectory,
  MAX_EOCD_SEARCH_SPAN,
  parseZipDirectoryEntries,
  resolveZipPayloadSpan,
  ZipEntryError,
  type ZipEntryRecord,
} from "./zip-reader";

/** Single-entry read ceiling; a JSON artifact this big is already unusable. */
export const DEFAULT_MAX_ENTRY_BYTES = 32 * 1024 * 1024;

/**
 * Exactly the fixed part of a local file header. The name/extra lengths live at
 * offsets 26 and 28, so 30 bytes is all the payload span needs — and reading
 * more would spill into the *next* entry, which for a small artifact stored just
 * before `video.part-000.webm` means pulling video bytes we promised not to.
 */
const LOCAL_HEADER_PROBE_BYTES = 30;

/** First tail probe: enough for the EOCD record and a short central directory. */
const SMALL_TAIL_BYTES = 1024;

export interface OpenPackageOptions {
  /** Password for a protected package (local transports only). */
  password?: string;
  /** Per-entry read ceiling. */
  maxEntryBytes?: number;
}

export interface RecordingPackage {
  readonly source: ByteRangeSource;
  readonly entries: ZipEntryRecord[];
  readonly metadata: PackageMetadata;
  readonly manifest: PackageManifest | null;
  readonly index: RecordingIndex | null;
  /** Artifact ids present in this package. */
  readonly availableArtifacts: ArtifactId[];
  /**
   * Whether an artifact is present. Accepts any string so callers can assert
   * the absence of ids outside the current {@link ArtifactId} union (e.g.
   * capabilities the producer intentionally did not capture).
   */
  hasArtifact(id: string): boolean;
  readEntryBytes(name: string): Promise<Uint8Array>;
  /** Reads and parses an artifact, or returns null when it is absent. */
  readArtifact<T>(id: ArtifactId): Promise<T | null>;
}

/**
 * Opens a package: locate the zip directory, then read `metadata.json` (plus the
 * manifest/index when present). Video entries are never read.
 */
export async function openRecordingPackage(
  source: ByteRangeSource,
  options: OpenPackageOptions = {},
): Promise<RecordingPackage> {
  const maxEntryBytes = options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES;
  const password = options.password ?? "";

  // Two-phase tail read. The writer emits no zip comment, so the EOCD record is
  // the last 22 bytes and a 1 KB probe finds it — which matters because the wide
  // 64 KB scan would drag in the tail of `video.part-*.webm` on a small package.
  let tail = await source.readTail(SMALL_TAIL_BYTES);
  let located = locateZipCentralDirectory(tail.bytes, tail.start);
  if (!located.ok && tail.start > 0) {
    tail = await source.readTail(MAX_EOCD_SEARCH_SPAN);
    located = locateZipCentralDirectory(tail.bytes, tail.start);
  }
  if (!located.ok) {
    throw new ReplayError(
      "PACKAGE_MALFORMED",
      located.message,
      "The download may be truncated or the link may not point at a recording package.",
    );
  }

  const directoryBytes =
    located.centralOffset >= tail.start
      ? tail.bytes.subarray(
          located.centralOffset - tail.start,
          located.centralOffset - tail.start + located.centralSize,
        )
      : await source.read(located.centralOffset, located.centralOffset + located.centralSize);

  const parsed = parseZipDirectoryEntries(directoryBytes, located.entryCount);
  if (!parsed.ok) {
    throw new ReplayError("PACKAGE_MALFORMED", parsed.message);
  }

  const entries = parsed.entries;
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const cache = new Map<string, Uint8Array>();

  async function readEntryBytes(name: string): Promise<Uint8Array> {
    const cached = cache.get(name);
    if (cached) {
      return cached;
    }

    const entry = byName.get(name);
    if (!entry) {
      throw new ReplayError("ARTIFACT_MISSING", `This recording has no ${name}.`);
    }
    if (entry.uncompressedSize > maxEntryBytes) {
      throw new ReplayError(
        "ENTRY_TOO_LARGE",
        `${name} is larger than the ${Math.round(maxEntryBytes / (1024 * 1024))} MB read limit.`,
        "Use a narrower query, or open the package locally.",
      );
    }

    const headerProbe = await source.read(
      entry.localHeaderOffset,
      entry.localHeaderOffset + LOCAL_HEADER_PROBE_BYTES,
    );
    const span = resolveZipPayloadSpan(entry, headerProbe);
    if (!span) {
      throw new ReplayError("PACKAGE_MALFORMED", `Entry ${name} has a corrupt local header.`);
    }

    const payload = await source.read(span.start, span.end);
    try {
      // `maxEntryBytes` is enforced again here, independent of the
      // `uncompressedSize` check above: that field is declared by whoever wrote
      // the central directory and is never verified against the real inflated
      // output, so a crafted entry can under-declare it and still expand far
      // past the limit during decompression.
      const bytes = await decodeZipEntryPayload(entry, payload, password, maxEntryBytes);
      cache.set(name, bytes);
      return bytes;
    } catch (cause) {
      throw toEntryReadError(cause, name);
    }
  }

  async function readJsonEntry<T>(name: string): Promise<T | null> {
    if (!byName.has(name)) {
      return null;
    }
    const bytes = await readEntryBytes(name);
    const text = new TextDecoder().decode(bytes);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ReplayError("PACKAGE_MALFORMED", `${name} is not valid JSON.`);
    }
  }

  const manifest = await readJsonEntry<PackageManifest>(ARTIFACT_FILENAMES.manifest);
  const index = await readJsonEntry<RecordingIndex>(ARTIFACT_FILENAMES.index);
  const metadataPath = index?.metadataPath || ARTIFACT_FILENAMES.metadata;
  const metadataRaw = await readJsonEntry<PackageMetadata & { metadata?: PackageMetadata }>(
    metadataPath,
  );
  if (!metadataRaw) {
    throw new ReplayError(
      "PACKAGE_MALFORMED",
      "This zip has no metadata.json, so it is not a GN Tracing recording package.",
    );
  }
  // Older packages nested the payload under `metadata` (see player.js).
  const metadata = metadataRaw.metadata ?? metadataRaw;

  function resolveArtifactPath(id: string): string | null {
    // Unknown ids simply miss every lookup, so a single cast keeps the
    // ArtifactId-keyed maps while allowing absence checks for any string.
    const artifactId = id as ArtifactId;
    const manifestPath = manifest?.artifacts?.[artifactId];
    if (manifestPath && byName.has(manifestPath)) {
      return manifestPath;
    }
    const indexKey = ARTIFACT_INDEX_KEYS[artifactId];
    const indexPath = indexKey ? index?.artifacts?.[indexKey] : undefined;
    if (indexPath && byName.has(indexPath)) {
      return indexPath;
    }
    const conventional = ARTIFACT_FILENAMES[artifactId];
    return byName.has(conventional) ? conventional : null;
  }

  const availableArtifacts = (Object.keys(ARTIFACT_FILENAMES) as ArtifactId[]).filter(
    (id) => resolveArtifactPath(id) !== null,
  );

  return {
    source,
    entries,
    metadata,
    manifest,
    index,
    availableArtifacts,
    hasArtifact: (id) => resolveArtifactPath(id) !== null,
    readEntryBytes,
    async readArtifact<T>(id: ArtifactId): Promise<T | null> {
      const path = resolveArtifactPath(id);
      return path ? readJsonEntry<T>(path) : null;
    },
  };
}

/** Convenience for callers that already hold the package bytes. */
export function openRecordingPackageFromBytes(
  bytes: Uint8Array,
  options: OpenPackageOptions = {},
): Promise<RecordingPackage> {
  return openRecordingPackage(createBytesSource(bytes), options);
}

function toEntryReadError(cause: unknown, name: string): ReplayError {
  if (cause instanceof ZipEntryError) {
    if (cause.code === "MISSING_PASSWORD") {
      return new ReplayError(
        "PACKAGE_ENCRYPTED",
        "This recording package is password protected.",
        "Pass the package password when opening the recording.",
      );
    }
    if (cause.code === "WRONG_PASSWORD") {
      return new ReplayError("WRONG_PASSWORD", "The package password is incorrect.");
    }
    if (cause.code === "ENTRY_TOO_LARGE") {
      return new ReplayError(
        "ENTRY_TOO_LARGE",
        cause.message,
        "Use a narrower query, or open the package locally.",
      );
    }
    return new ReplayError("PACKAGE_MALFORMED", cause.message);
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  return new ReplayError("PACKAGE_MALFORMED", `Could not read ${name}: ${message}`);
}
