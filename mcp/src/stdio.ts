/**
 * Local stdio transport.
 *
 * MCP's stdio transport is newline-delimited JSON-RPC on stdin/stdout, with
 * stderr free for logging. Two invariants matter and are easy to get wrong:
 * stdout carries protocol frames ONLY (a stray `console.log` corrupts the
 * stream), and messages must be split on newlines rather than on chunk
 * boundaries, since one read can carry a partial or several whole messages.
 */

import { open, stat } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import {
  type ByteRangeSource,
  buildPackageDownloadUrl,
  createHttpSource,
  DEFAULT_PLAYER_ORIGIN,
  ReplayError,
} from "../../packages/replay-core/src/index";
import { handleMessage, parseJsonRpcLine, type ServerInfo } from "./protocol";
import { createRecordingStore, type RecordingLocator, type RecordingStore } from "./resolver";
import { createToolRegistry, SERVER_INSTRUCTIONS } from "./tools";

export const SERVER_INFO: ServerInfo = {
  name: "gn-tracing",
  version: "1.0.0",
  instructions: SERVER_INSTRUCTIONS,
};

export interface LocalServerOptions {
  /**
   * Directories local `.zip` packages may be read from. Empty means "no local
   * files": a tool argument must never be able to read an arbitrary path just
   * because it is a path.
   */
  allowedDirectories?: string[];
  /** Origin of the hosted player, for the download proxies. */
  playerOrigin?: string;
}

/** Builds the local recording store: hosted links plus allow-listed local files. */
export function createLocalRecordingStore(options: LocalServerOptions = {}): RecordingStore {
  const allowedDirectories = (options.allowedDirectories ?? []).map((directory) =>
    resolve(directory),
  );
  const playerOrigin = options.playerOrigin ?? DEFAULT_PLAYER_ORIGIN;

  return createRecordingStore({
    allowLocalFiles: allowedDirectories.length > 0,
    openSource: async (locator: RecordingLocator): Promise<ByteRangeSource> => {
      if (locator.kind === "remote") {
        return createHttpSource(buildPackageDownloadUrl(locator.ref, playerOrigin), {
          label: "recording download proxy",
        });
      }
      const path = assertAllowedPath(locator.path, allowedDirectories);
      return createFileSource(path);
    },
  });
}

/**
 * Resolves a path and refuses anything outside the allow-list.
 *
 * Resolution happens before the prefix check so `../` cannot escape, and the
 * separator suffix stops `/data/recordings-secret` from passing as a child of
 * `/data/recordings`.
 */
export function assertAllowedPath(candidate: string, allowedDirectories: string[]): string {
  if (allowedDirectories.length === 0) {
    throw new ReplayError(
      "INVALID_SOURCE",
      "Local file reading is disabled.",
      "Start the server with --allow-dir <directory> to read downloaded packages.",
    );
  }

  const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(process.cwd(), candidate);
  const permitted = allowedDirectories.some(
    (directory) => absolute === directory || absolute.startsWith(`${directory}${sep}`),
  );
  if (!permitted) {
    throw new ReplayError(
      "INVALID_SOURCE",
      "That path is outside the directories this server may read.",
      `Allowed: ${allowedDirectories.join(", ")}`,
    );
  }
  return absolute;
}

/** Ranged reads straight off disk — the local equivalent of a Range request. */
export async function createFileSource(path: string): Promise<ByteRangeSource> {
  const stats = await stat(path).catch(() => null);
  if (!stats?.isFile()) {
    throw new ReplayError("PACKAGE_NOT_FOUND", "No recording package at that path.");
  }
  const size = stats.size;

  async function readRange(start: number, end: number): Promise<Uint8Array> {
    const from = Math.max(0, Math.min(start, size));
    const to = Math.max(from, Math.min(end, size));
    if (to === from) {
      return new Uint8Array(0);
    }
    const handle = await open(path, "r");
    try {
      const buffer = new Uint8Array(to - from);
      await handle.read(buffer, 0, buffer.length, from);
      return buffer;
    } finally {
      await handle.close();
    }
  }

  return {
    label: "local package",
    async readTail(maxBytes: number) {
      const start = Math.max(0, size - Math.max(0, maxBytes));
      return { bytes: await readRange(start, size), start, totalSize: size };
    },
    read: readRange,
    isFullyBuffered: () => false,
  };
}

export interface StdioStreams {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  errorOutput?: NodeJS.WritableStream;
}

/**
 * Runs the stdio server until the input stream ends.
 *
 * Every message is handled in order; the JSON-RPC id lets clients match replies,
 * but processing serially also keeps the recording cache from opening the same
 * package several times when a client fires a burst of calls.
 */
export async function runStdioServer(store: RecordingStore, streams: StdioStreams): Promise<void> {
  const tools = createToolRegistry(store);
  const decoder = new TextDecoder();
  let buffer = "";

  const write = (response: unknown) => {
    streams.output.write(`${JSON.stringify(response)}\n`);
  };

  for await (const chunk of streams.input) {
    buffer +=
      typeof chunk === "string" ? chunk : decoder.decode(chunk as Uint8Array, { stream: true });

    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");

      const parsed = parseJsonRpcLine(line);
      if (!parsed.ok) {
        if (line.trim()) {
          write({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Could not parse JSON-RPC message." },
          });
        }
        continue;
      }

      const response = await handleMessage(parsed.value, tools, SERVER_INFO);
      if (response) {
        write(response);
      }
    }
  }
}

