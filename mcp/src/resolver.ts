/**
 * Turning what a user pasted into an open recording.
 *
 * A recording is addressed by a *locator* — a replay ref or a local file — and a
 * `recordingId` is just that locator in readable form (`gdrive:<id>`,
 * `dropbox:<id>`, `file:<path>`). Making the id self-describing rather than a
 * server-side handle is what lets the remote transport stay stateless: any
 * worker instance can serve a follow-up call without shared session storage,
 * while the local server still gets a cache for free.
 */

import {
  type ByteRangeSource,
  createRecordingSession,
  isSupportedRecordingRef,
  openRecordingPackage,
  parseStorageRecordingRef,
  type RecordingSession,
  ReplayError,
  type StorageRecordingRef,
} from "../../packages/replay-core/src/index";

export type RecordingLocator =
  | { kind: "remote"; ref: StorageRecordingRef }
  | { kind: "local"; path: string };

export interface OpenedRecording {
  recordingId: string;
  locator: RecordingLocator;
  session: RecordingSession;
  /** Human-openable replay link, when the source is a hosted recording. */
  replayUrl?: string;
}

/** Opens the bytes for a locator; supplied by each transport. */
export type SourceOpener = (
  locator: RecordingLocator,
  options: { password?: string },
) => Promise<ByteRangeSource>;

export interface RecordingStoreOptions {
  openSource: SourceOpener;
  /** Local file paths are only accepted when a transport allows them. */
  allowLocalFiles?: boolean;
  /** Most recordings kept open at once. */
  maxCached?: number;
}

export interface RecordingStore {
  /** Opens a user-supplied source string (replay URL, bare id, or file path). */
  open(source: string, options?: { password?: string }): Promise<OpenedRecording>;
  /** Returns an already-opened recording, reopening it if the cache has rolled. */
  get(recordingId: string, options?: { password?: string }): Promise<OpenedRecording>;
}

export function encodeRecordingId(locator: RecordingLocator): string {
  if (locator.kind === "local") {
    return `file:${locator.path}`;
  }
  const segment = locator.ref.provider === "dropbox" ? "dropbox" : "gdrive";
  return `${segment}:${locator.ref.fileId}`;
}

export function decodeRecordingId(recordingId: string): RecordingLocator | null {
  const separator = recordingId.indexOf(":");
  if (separator <= 0) {
    return null;
  }
  const scheme = recordingId.slice(0, separator);
  const value = recordingId.slice(separator + 1);
  if (!value) {
    return null;
  }
  if (scheme === "file") {
    return { kind: "local", path: value };
  }
  if (scheme === "gdrive") {
    return { kind: "remote", ref: { provider: "google-drive", fileId: value } };
  }
  if (scheme === "dropbox") {
    return { kind: "remote", ref: { provider: "dropbox", fileId: value } };
  }
  return null;
}

/**
 * Classifies a user-supplied source string.
 *
 * Order matters: a replay URL wins over a path, and anything that is neither a
 * parseable ref nor an allowed local file is rejected rather than guessed at.
 */
export function parseRecordingSource(
  source: string,
  options: { allowLocalFiles?: boolean } = {},
): RecordingLocator {
  const trimmed = source.trim();
  if (!trimmed) {
    throw new ReplayError("INVALID_SOURCE", "A recording source is required.");
  }

  const looksLikeFile =
    trimmed.startsWith(".") ||
    trimmed.startsWith("~") ||
    trimmed.startsWith("file://") ||
    /\.zip$/i.test(trimmed) ||
    (trimmed.startsWith("/") && !trimmed.startsWith("//") && trimmed.includes("."));

  if (looksLikeFile) {
    if (!options.allowLocalFiles) {
      throw new ReplayError(
        "INVALID_SOURCE",
        "This server only reads hosted recordings.",
        "Pass a https://tracing.gnas.dev/... replay link, or run the local MCP server to read a .zip file.",
      );
    }
    return { kind: "local", path: trimmed.replace(/^file:\/\//, "") };
  }

  const ref = parseStorageRecordingRef(trimmed);
  if (!ref) {
    throw new ReplayError(
      "INVALID_SOURCE",
      "That is not a recognizable recording source.",
      "Use a replay link such as https://tracing.gnas.dev/gdrive/<file-id>.",
    );
  }
  if (!isSupportedRecordingRef(ref)) {
    throw new ReplayError(
      "UNSUPPORTED_PROVIDER",
      "That replay id is not one the download proxies accept.",
    );
  }
  return { kind: "remote", ref };
}

export function createRecordingStore(options: RecordingStoreOptions): RecordingStore {
  const maxCached = options.maxCached ?? 4;
  const cache = new Map<string, { opened: OpenedRecording; password?: string }>();

  async function openLocator(
    locator: RecordingLocator,
    password: string | undefined,
  ): Promise<OpenedRecording> {
    const recordingId = encodeRecordingId(locator);
    const cached = cache.get(recordingId);
    if (cached && (password === undefined || cached.password === password)) {
      return cached.opened;
    }

    const source = await options.openSource(locator, { password });
    const pkg = await openRecordingPackage(source, { password });
    const opened: OpenedRecording = {
      recordingId,
      locator,
      session: createRecordingSession(pkg),
      ...(locator.kind === "remote" ? { replayUrl: buildReplayLink(locator.ref) } : {}),
    };

    cache.set(recordingId, { opened, password });
    while (cache.size > maxCached) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      cache.delete(oldest);
    }
    return opened;
  }

  return {
    async open(source, callOptions = {}) {
      const locator = parseRecordingSource(source, { allowLocalFiles: options.allowLocalFiles });
      return openLocator(locator, callOptions.password);
    },

    async get(recordingId, callOptions = {}) {
      const locator = decodeRecordingId(recordingId);
      if (!locator) {
        throw new ReplayError(
          "UNKNOWN_RECORDING",
          `Unknown recording id: ${recordingId}.`,
          "Call open_recording first and use the id it returns.",
        );
      }
      if (locator.kind === "local" && !options.allowLocalFiles) {
        throw new ReplayError("INVALID_SOURCE", "This server does not read local files.");
      }
      const cached = cache.get(recordingId);
      return openLocator(locator, callOptions.password ?? cached?.password);
    },
  };
}

function buildReplayLink(ref: StorageRecordingRef): string {
  const segment = ref.provider === "dropbox" ? "dropbox" : "gdrive";
  return `https://tracing.gnas.dev/${segment}/${ref.fileId}`;
}
