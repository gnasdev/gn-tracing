/**
 * Byte sources a recording package can be read from.
 *
 * A package is mostly video, so the reader is built around *ranged* reads: pull
 * the tail to find the zip directory, then pull only the JSON entries an agent
 * actually asked for. Both hosted download proxies
 * (the Player router's shared proxy handlers) forward the `Range` header upstream,
 * so this works against a real replay link.
 *
 * When a server ignores `Range` and answers `200`, the full body is cached once
 * and every later read is served from memory — correctness never depends on
 * range support, only bandwidth does.
 */

import { ReplayError } from "./errors";

/** Result of reading the last bytes of a package. */
export interface TailRead {
  bytes: Uint8Array;
  /** Absolute offset of `bytes[0]` within the package. */
  start: number;
  /** Total package size when the source can report it. */
  totalSize: number | null;
}

export interface ByteRangeSource {
  /** Human-safe label for diagnostics — never a file id or full URL. */
  readonly label: string;
  /** Reads up to `maxBytes` from the end of the package. */
  readTail(maxBytes: number): Promise<TailRead>;
  /** Reads the absolute `[start, end)` span. */
  read(start: number, end: number): Promise<Uint8Array>;
  /** True once the whole package is buffered in memory. */
  isFullyBuffered(): boolean;
}

/** Reads a package already held in memory (local file, test fixture). */
export function createBytesSource(bytes: Uint8Array, label = "bytes"): ByteRangeSource {
  return {
    label,
    async readTail(maxBytes: number): Promise<TailRead> {
      const start = Math.max(0, bytes.length - Math.max(0, maxBytes));
      return { bytes: bytes.subarray(start), start, totalSize: bytes.length };
    },
    async read(start: number, end: number): Promise<Uint8Array> {
      const from = Math.max(0, Math.min(start, bytes.length));
      const to = Math.max(from, Math.min(end, bytes.length));
      return bytes.subarray(from, to);
    },
    isFullyBuffered: () => true,
  };
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpSourceOptions {
  /** Injected for tests and for runtimes with a scoped fetch. */
  fetchImpl?: FetchLike;
  /** Hard ceiling for a non-ranged (`200`) download. */
  maxBytes?: number;
  /** Extra request headers (for example an authorization header). */
  headers?: Record<string, string>;
  /** Label used in diagnostics instead of the URL. */
  label?: string;
}

/** 64 MB: large enough for real packages read whole, small enough to stay safe. */
export const DEFAULT_MAX_PACKAGE_BYTES = 64 * 1024 * 1024;

/**
 * Reads a package over HTTP, preferring `Range` requests.
 *
 * Servers that ignore `Range` are handled by buffering the single `200`
 * response; `maxBytes` bounds that fallback so a huge package fails with a
 * typed error instead of exhausting memory.
 */
export function createHttpSource(url: string, options: HttpSourceOptions = {}): ByteRangeSource {
  const candidateFetch = options.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
  if (typeof candidateFetch !== "function") {
    throw new ReplayError("UPSTREAM_UNAVAILABLE", "This runtime has no fetch implementation.");
  }
  const fetchImpl: FetchLike = candidateFetch;

  const maxBytes = options.maxBytes ?? DEFAULT_MAX_PACKAGE_BYTES;
  const label = options.label ?? "remote package";
  let buffered: Uint8Array | null = null;

  async function request(range: string | null): Promise<Response> {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (range) {
      headers.range = range;
    }
    let response: Response;
    try {
      response = await fetchImpl(url, { headers, redirect: "follow" });
    } catch (cause) {
      throw new ReplayError(
        "UPSTREAM_UNAVAILABLE",
        `Could not reach the ${label}.`,
        cause instanceof Error ? cause.message : undefined,
      );
    }

    if (response.status === 404 || response.status === 410) {
      throw new ReplayError(
        "PACKAGE_NOT_FOUND",
        "The recording package was not found.",
        "Check that the replay link is still shared publicly.",
      );
    }
    if (response.status === 429) {
      throw new ReplayError("RATE_LIMITED", "The storage provider is rate limiting downloads.");
    }
    if (!response.ok && response.status !== 206) {
      throw new ReplayError(
        "UPSTREAM_UNAVAILABLE",
        `The ${label} responded with status ${response.status}.`,
      );
    }
    return response;
  }

  async function bufferFull(response: Response): Promise<Uint8Array> {
    const declared = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new ReplayError(
        "PACKAGE_TOO_LARGE",
        `The recording package is larger than the ${formatBytes(maxBytes)} limit.`,
        "Download the package and open it with the local MCP server instead.",
      );
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > maxBytes) {
      throw new ReplayError(
        "PACKAGE_TOO_LARGE",
        `The recording package is larger than the ${formatBytes(maxBytes)} limit.`,
        "Download the package and open it with the local MCP server instead.",
      );
    }
    buffered = bytes;
    return bytes;
  }

  return {
    label,

    async readTail(maxTailBytes: number): Promise<TailRead> {
      if (buffered) {
        const start = Math.max(0, buffered.length - maxTailBytes);
        return { bytes: buffered.subarray(start), start, totalSize: buffered.length };
      }

      const response = await request(`bytes=-${Math.max(1, Math.floor(maxTailBytes))}`);
      if (response.status === 206) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        const contentRange = response.headers.get("content-range") ?? "";
        const parsed = parseContentRange(contentRange);
        return {
          bytes,
          start: parsed?.start ?? Math.max(0, (parsed?.total ?? bytes.length) - bytes.length),
          totalSize: parsed?.total ?? null,
        };
      }

      const bytes = await bufferFull(response);
      const start = Math.max(0, bytes.length - maxTailBytes);
      return { bytes: bytes.subarray(start), start, totalSize: bytes.length };
    },

    async read(start: number, end: number): Promise<Uint8Array> {
      if (buffered) {
        return buffered.subarray(Math.max(0, start), Math.max(0, end));
      }
      if (end <= start) {
        return new Uint8Array(0);
      }
      if (end - start > maxBytes) {
        throw new ReplayError(
          "ENTRY_TOO_LARGE",
          `That entry is larger than the ${formatBytes(maxBytes)} limit.`,
        );
      }

      const response = await request(`bytes=${start}-${end - 1}`);
      if (response.status === 206) {
        return new Uint8Array(await response.arrayBuffer());
      }

      const bytes = await bufferFull(response);
      return bytes.subarray(Math.max(0, start), Math.max(0, end));
    },

    isFullyBuffered: () => buffered !== null,
  };
}

interface ParsedContentRange {
  start: number;
  end: number;
  total: number | null;
}

export function parseContentRange(value: string): ParsedContentRange | null {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(value.trim());
  if (!match) {
    return null;
  }
  const total = match[3] === "*" ? null : Number(match[3]);
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    total: total !== null && Number.isFinite(total) ? total : null,
  };
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${Math.round(bytes / (1024 * 1024))} MB`;
  }
  return `${Math.round(bytes / 1024)} KB`;
}
