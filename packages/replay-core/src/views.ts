/**
 * Flat, timeline-aligned views over the raw artifacts.
 *
 * Raw artifacts keep every field the player needs to render; an agent needs the
 * opposite — one small record per event, already placed on the recording
 * timeline so console, network, and user events can be correlated by `atMs`.
 *
 * The time normalization rules mirror the player (`player/player.js`), which is
 * the source of truth for how a package's timestamps map onto playback time:
 *
 * - `startTime = metadata.startTime || Date.parse(metadata.timestamp)`
 * - console / user events: `timestamp - startTime` (epoch ms)
 * - network: `(wallTime * 1000 || timestamp * 1000) - startTime`
 *
 * WebSocket frames carry CDP monotonic timestamps with no wall-clock anchor, so
 * they are reported as `null` rather than guessed at.
 */

import type { PackageMetadata } from "./schema/package";

export interface SourceLocationView {
  /** Original (source-mapped) file when available, else the generated URL. */
  file: string;
  line?: number;
  column?: number;
  /** True when the location came from a source map rather than the bundle. */
  mapped: boolean;
  /** Why a frame stayed unmapped, when the package explains it. */
  unmappedReason?: string;
}

export interface ConsoleView {
  id: string;
  index: number;
  atMs: number | null;
  level: string;
  source: string;
  message: string;
  location: SourceLocationView | null;
  hasStack: boolean;
  /** Groups repeats of the same message+location. */
  signature: string;
}

export interface NetworkView {
  id: string;
  index: number;
  atMs: number | null;
  method: string;
  url: string;
  status: number | null;
  statusText: string | null;
  resourceType: string;
  mimeType: string | null;
  durationMs: number | null;
  encodedDataLength: number;
  error: string | null;
  fromCache: boolean;
  canceled: boolean;
  failed: boolean;
  /** Still in flight when the recording stopped — unknown outcome, not a failure. */
  incomplete: boolean;
  hasRequestBody: boolean;
  hasResponseBody: boolean;
}

export interface WebSocketView {
  id: string;
  index: number;
  url: string;
  closed: boolean;
  frameCount: number;
  sentCount: number;
  receivedCount: number;
}

export interface EventView {
  index: number;
  atMs: number | null;
  kind: string;
  label: string;
  selector?: string;
  url?: string;
}

/** Recording-wide time anchor derived from `metadata.json`. */
export function resolveRecordingStartTime(metadata: PackageMetadata): number {
  const explicit = Number(metadata.startTime);
  if (Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }
  const parsed = Date.parse(String(metadata.timestamp ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Prefers a caller-supplied `relativeMs`.
 *
 * The player normalizes every entry onto the timeline as it loads (including
 * HAR-shaped imports, where the raw timestamp units differ). When it hands those
 * entries back for a summary, its own value is authoritative — recomputing would
 * be a second, worse guess.
 */
function providedRelativeMs(entry: UnknownRecord): number | null {
  const value = entry.relativeMs;
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
}

function toRelativeMs(epochMs: number, startTime: number): number | null {
  if (!Number.isFinite(epochMs) || epochMs <= 0 || !startTime) {
    return null;
  }
  return Math.round(epochMs - startTime);
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" ? (value as UnknownRecord) : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Unwraps the artifact shapes the player accepts (bare array or wrapper). */
export function unwrapArtifactList(artifact: unknown, ...keys: string[]): unknown[] {
  if (Array.isArray(artifact)) {
    return artifact;
  }
  const record = asRecord(artifact);
  if (!record) {
    return [];
  }
  for (const key of ["entries", "logs", "data", "events", ...keys]) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value;
    }
  }
  return [];
}

function describeRemoteObject(arg: unknown): string {
  const record = asRecord(arg);
  if (!record) {
    return String(arg);
  }
  if (typeof record.value === "string") {
    return record.value;
  }
  if (record.value !== undefined && record.value !== null) {
    return String(record.value);
  }
  const description = asString(record.description);
  if (description) {
    return description;
  }
  const className = asString(record.className);
  return className || asString(record.type) || "";
}

function formatConsoleMessage(entry: UnknownRecord): string {
  const message = asString(entry.message);
  if (message) {
    return message;
  }
  const args = Array.isArray(entry.args) ? entry.args : [];
  return args.map(describeRemoteObject).filter(Boolean).join(" ");
}

function resolveConsoleLocation(entry: UnknownRecord): SourceLocationView | null {
  const originalSource = asString(entry.originalSource);
  if (originalSource) {
    return {
      file: originalSource,
      line: asNumber(entry.originalLine) ?? undefined,
      column: asNumber(entry.originalColumn) ?? undefined,
      mapped: true,
    };
  }

  const frames = Array.isArray(entry.stackTrace) ? entry.stackTrace : [];
  const topFrame = asRecord(frames[0]);
  if (topFrame) {
    const frameOriginal = asString(topFrame.originalSource);
    if (frameOriginal) {
      return {
        file: frameOriginal,
        line: asNumber(topFrame.originalLine) ?? undefined,
        column: asNumber(topFrame.originalColumn) ?? undefined,
        mapped: true,
      };
    }
    const frameUrl = asString(topFrame.url);
    if (frameUrl) {
      return {
        file: frameUrl,
        line: asNumber(topFrame.lineNumber) ?? undefined,
        column: asNumber(topFrame.columnNumber) ?? undefined,
        mapped: false,
        unmappedReason: asString(asRecord(topFrame.sourceMapStatus)?.reason) || undefined,
      };
    }
  }

  const url = asString(entry.url);
  if (!url) {
    return null;
  }
  return {
    file: url,
    line: asNumber(entry.lineNumber) ?? undefined,
    column: asNumber(entry.columnNumber) ?? undefined,
    mapped: false,
    unmappedReason: asString(asRecord(entry.sourceMapStatus)?.reason) || undefined,
  };
}

export function buildConsoleViews(artifact: unknown, startTime: number): ConsoleView[] {
  return unwrapArtifactList(artifact)
    .map((raw, index): ConsoleView | null => {
      const entry = asRecord(raw);
      if (!entry) {
        return null;
      }
      const message = formatConsoleMessage(entry);
      const location = resolveConsoleLocation(entry);
      const level = asString(entry.level) || "log";
      return {
        id: `c-${index}`,
        index,
        atMs: providedRelativeMs(entry) ?? toRelativeMs(asNumber(entry.timestamp) ?? 0, startTime),
        level,
        source: asString(entry.source) || "console-api",
        message,
        location,
        hasStack: Array.isArray(entry.stackTrace) && entry.stackTrace.length > 0,
        signature: `${level}|${message.slice(0, 200)}|${location?.file ?? ""}:${location?.line ?? ""}`,
      };
    })
    .filter((view): view is ConsoleView => view !== null)
    .sort(byAtMs);
}

/** Levels the summary treats as errors (exceptions included). */
export function isErrorConsoleView(view: ConsoleView): boolean {
  return view.level === "error" || view.source === "exception";
}

export function isWarningConsoleView(view: ConsoleView): boolean {
  return view.level === "warning" || view.level === "warn";
}

function resolveNetworkAtMs(entry: UnknownRecord, startTime: number): number | null {
  const provided = providedRelativeMs(entry);
  if (provided !== null) {
    return provided;
  }
  const wallTime = asNumber(entry.wallTime);
  if (wallTime && wallTime > 0) {
    return toRelativeMs(wallTime * 1000, startTime);
  }
  const timestamp = asNumber(entry.timestamp);
  if (timestamp === null) {
    return null;
  }
  // CDP monotonic seconds in the native shape; the player multiplies by 1000.
  return toRelativeMs(timestamp * 1000, startTime);
}

function resolveNetworkDuration(entry: UnknownRecord): number | null {
  const timing = asRecord(entry.timing);
  if (!timing) {
    return null;
  }
  const received = asNumber(timing.receiveHeadersEnd);
  if (received !== null && received > 0) {
    return Math.round(received);
  }
  return null;
}

export function buildNetworkViews(artifact: unknown, startTime: number): NetworkView[] {
  return unwrapArtifactList(artifact)
    .map((raw, index): NetworkView | null => {
      const entry = asRecord(raw);
      if (!entry) {
        return null;
      }
      const status = asNumber(entry.status);
      const error = asString(entry.error) || null;
      const canceled = entry.canceled === true;
      return {
        id: `n-${index}`,
        index,
        atMs: resolveNetworkAtMs(entry, startTime),
        method: asString(entry.method) || "GET",
        url: asString(entry.url),
        status,
        statusText: asString(entry.statusText) || null,
        resourceType: asString(entry.resourceType),
        mimeType: asString(entry.mimeType) || null,
        durationMs: resolveNetworkDuration(entry),
        encodedDataLength: asNumber(entry.encodedDataLength) ?? 0,
        error,
        fromCache: entry.servedFromCache === true,
        canceled,
        // A request with no status was still in flight when recording stopped;
        // that is "incomplete", not "failed", and must not pollute the summary.
        failed: Boolean(error) || (status !== null && status >= 400),
        incomplete: status === null && !error && !canceled,
        hasRequestBody: Boolean(asString(entry.postData)),
        hasResponseBody: Boolean(asRecord(entry.responseBody)),
      };
    })
    .filter((view): view is NetworkView => view !== null)
    .sort(byAtMs);
}

export function buildWebSocketViews(artifact: unknown): WebSocketView[] {
  return unwrapArtifactList(artifact)
    .map((raw, index): WebSocketView | null => {
      const entry = asRecord(raw);
      if (!entry) {
        return null;
      }
      const frames = Array.isArray(entry.frames) ? entry.frames : [];
      let sentCount = 0;
      let receivedCount = 0;
      for (const frame of frames) {
        const direction = asString(asRecord(frame)?.direction);
        if (direction === "sent") {
          sentCount += 1;
        } else if (direction === "received") {
          receivedCount += 1;
        }
      }
      return {
        id: `w-${index}`,
        index,
        url: asString(entry.url),
        closed: entry.closed === true,
        frameCount: frames.length,
        sentCount,
        receivedCount,
      };
    })
    .filter((view): view is WebSocketView => view !== null);
}

function describeEvent(event: UnknownRecord): string {
  const kind = asString(event.type);
  const text = asString(event.text).trim();
  const selector = asString(event.selector);
  switch (kind) {
    case "navigation":
      return asString(event.url);
    case "click":
    case "contextmenu":
      return text || selector || kind;
    case "scroll":
      return `${asString(event.direction) || "scroll"}${event.deltaY ? ` ${Math.round(Number(event.deltaY))}px` : ""}`;
    case "key":
      return asString(event.key);
    case "focus":
      return selector || asString(event.inputType) || "focus";
    case "submit":
      return selector || "submit";
    default:
      return text || selector || kind;
  }
}

export function buildEventViews(artifact: unknown, startTime: number): EventView[] {
  return unwrapArtifactList(artifact)
    .map((raw, index): EventView | null => {
      const event = asRecord(raw);
      if (!event) {
        return null;
      }
      const kind = asString(event.type) || "event";
      const selector = asString(event.selector);
      const url = asString(event.url);
      return {
        index,
        atMs: providedRelativeMs(event) ?? toRelativeMs(asNumber(event.timestamp) ?? 0, startTime),
        kind,
        label: describeEvent(event),
        ...(selector ? { selector } : {}),
        ...(url ? { url } : {}),
      };
    })
    .filter((view): view is EventView => view !== null)
    .sort(byAtMs);
}

function byAtMs(a: { atMs: number | null }, b: { atMs: number | null }): number {
  const left = a.atMs ?? Number.POSITIVE_INFINITY;
  const right = b.atMs ?? Number.POSITIVE_INFINITY;
  return left - right;
}
