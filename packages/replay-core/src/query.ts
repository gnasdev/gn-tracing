/**
 * Bounded queries over an opened recording.
 *
 * Every function here answers with a *page*, never a whole artifact. An agent
 * has a context window: a tool that dumps 800 console entries is worse than no
 * tool at all, because it evicts the code the agent was reading. So each result
 * carries `total`, `returned`, and a cursor, and every free-text field is
 * truncated with an explicit marker.
 *
 * Artifacts load lazily and are memoized per session: asking for network data
 * never downloads `console.json`.
 */

import type { RecordingPackage } from "./artifacts";
import { ReplayError } from "./errors";
import { type AgentSummary, buildAgentSummary } from "./summarize";
import {
  buildConsoleViews,
  buildEventViews,
  buildNetworkViews,
  buildWebSocketViews,
  type ConsoleView,
  type EventView,
  isErrorConsoleView,
  isWarningConsoleView,
  type NetworkView,
  resolveRecordingStartTime,
  unwrapArtifactList,
  type WebSocketView,
} from "./views";

export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;
export const MAX_BODY_CHARS = 8000;
const MAX_MESSAGE_CHARS = 2000;
const MAX_FRAMES = 20;

export interface Page<T> {
  items: T[];
  total: number;
  returned: number;
  hasMore: boolean;
  nextCursor?: string;
}

export interface PageRequest {
  cursor?: string;
  limit?: number;
}

/** An opened recording plus its lazily loaded artifacts. */
export interface RecordingSession {
  readonly pkg: RecordingPackage;
  readonly startTime: number;
  summary(): Promise<AgentSummary>;
  consoleViews(): Promise<ConsoleView[]>;
  networkViews(): Promise<NetworkView[]>;
  websocketViews(): Promise<WebSocketView[]>;
  eventViews(): Promise<EventView[]>;
  rawConsole(): Promise<unknown[]>;
  rawNetwork(): Promise<unknown[]>;
  rawWebsocket(): Promise<unknown[]>;
  privacy(): Promise<Record<string, unknown> | null>;
}

export function createRecordingSession(pkg: RecordingPackage): RecordingSession {
  const startTime = resolveRecordingStartTime(pkg.metadata);
  const memo = new Map<string, Promise<unknown>>();

  function once<T>(key: string, load: () => Promise<T>): Promise<T> {
    const existing = memo.get(key) as Promise<T> | undefined;
    if (existing) {
      return existing;
    }
    const created = load();
    memo.set(key, created as Promise<unknown>);
    return created;
  }

  const rawConsole = () =>
    once("raw:console", async () => unwrapArtifactList(await pkg.readArtifact("console")));
  const rawNetwork = () =>
    once("raw:network", async () => unwrapArtifactList(await pkg.readArtifact("network")));
  const rawWebsocket = () =>
    once("raw:websocket", async () => unwrapArtifactList(await pkg.readArtifact("websocket")));

  const session: RecordingSession = {
    pkg,
    startTime,
    rawConsole,
    rawNetwork,
    rawWebsocket,
    consoleViews: () =>
      once("view:console", async () => buildConsoleViews(await rawConsole(), startTime)),
    networkViews: () =>
      once("view:network", async () => buildNetworkViews(await rawNetwork(), startTime)),
    websocketViews: () =>
      once("view:websocket", async () => buildWebSocketViews(await rawWebsocket())),
    eventViews: () =>
      once("view:events", async () => buildEventViews(await pkg.readArtifact("events"), startTime)),
    privacy: () =>
      once(
        "raw:privacy",
        async () => (await pkg.readArtifact<Record<string, unknown>>("privacy")) ?? null,
      ),
    summary: () =>
      once("summary", async () => {
        // A package written by a recent extension already carries the artifact;
        // older packages get an equivalent one computed here from the same code.
        const stored = await pkg.readArtifact<AgentSummary>("agentSummary");
        if (stored?.schemaVersion) {
          return stored;
        }
        const [consoleArtifact, networkArtifact, websocketArtifact, events, privacy, report] =
          await Promise.all([
            pkg.readArtifact("console"),
            pkg.readArtifact("network"),
            pkg.readArtifact("websocket"),
            pkg.readArtifact("events"),
            pkg.readArtifact("privacy"),
            pkg.readArtifact("report"),
          ]);
        return buildAgentSummary({
          metadata: pkg.metadata,
          console: consoleArtifact,
          network: networkArtifact,
          websocket: websocketArtifact,
          events,
          privacy,
          report,
          availableArtifacts: pkg.availableArtifacts,
        });
      }),
  };

  return session;
}

export interface ConsoleFilters extends PageRequest {
  /** `error` also matches uncaught exceptions. */
  level?: string;
  query?: string;
  fromMs?: number;
  toMs?: number;
}

export async function listConsole(
  session: RecordingSession,
  filters: ConsoleFilters = {},
): Promise<Page<ConsoleView>> {
  const views = await session.consoleViews();
  const needle = filters.query?.trim().toLowerCase();
  const filtered = views.filter((view) => {
    if (filters.level && !matchesLevel(view, filters.level)) {
      return false;
    }
    if (!withinRange(view.atMs, filters.fromMs, filters.toMs)) {
      return false;
    }
    if (needle && !view.message.toLowerCase().includes(needle)) {
      return false;
    }
    return true;
  });

  return paginate(filtered, filters, [
    "console",
    filters.level,
    filters.query,
    filters.fromMs,
    filters.toMs,
  ]);
}

function matchesLevel(view: ConsoleView, level: string): boolean {
  const wanted = level.trim().toLowerCase();
  if (wanted === "error") {
    return isErrorConsoleView(view);
  }
  if (wanted === "warning" || wanted === "warn") {
    return isWarningConsoleView(view);
  }
  return view.level.toLowerCase() === wanted;
}

export interface ConsoleFrameDetail {
  function: string;
  file: string;
  line?: number;
  column?: number;
  mapped: boolean;
  unmappedReason?: string;
  snippet?: string[];
}

export interface ConsoleEntryDetail extends ConsoleView {
  frames: ConsoleFrameDetail[];
  framesTruncated: boolean;
  args: string[];
}

export async function getConsoleEntry(
  session: RecordingSession,
  id: string,
): Promise<ConsoleEntryDetail> {
  const views = await session.consoleViews();
  const view = views.find((candidate) => candidate.id === id);
  if (!view) {
    throw new ReplayError("NOT_FOUND", `No console entry with id ${id}.`);
  }
  const raw = (await session.rawConsole())[view.index] as Record<string, unknown> | undefined;
  const frames = Array.isArray(raw?.stackTrace) ? raw.stackTrace : [];

  return {
    ...view,
    message: truncate(view.message, MAX_MESSAGE_CHARS),
    frames: frames.slice(0, MAX_FRAMES).map(toFrameDetail),
    framesTruncated: frames.length > MAX_FRAMES,
    args: Array.isArray(raw?.args)
      ? raw.args.map((arg) => truncate(describeArg(arg), 500)).slice(0, 10)
      : [],
  };
}

function toFrameDetail(frame: unknown): ConsoleFrameDetail {
  const record = (frame ?? {}) as Record<string, unknown>;
  const originalSource = typeof record.originalSource === "string" ? record.originalSource : "";
  const snippet = record.sourceSnippet as Record<string, unknown> | undefined;
  const lines = Array.isArray(snippet?.lines)
    ? snippet.lines.filter((line): line is string => typeof line === "string")
    : undefined;
  const status = record.sourceMapStatus as Record<string, unknown> | undefined;

  return {
    function: typeof record.functionName === "string" ? record.functionName : "(anonymous)",
    file: originalSource || (typeof record.url === "string" ? record.url : ""),
    line: numberOrUndefined(originalSource ? record.originalLine : record.lineNumber),
    column: numberOrUndefined(originalSource ? record.originalColumn : record.columnNumber),
    mapped: Boolean(originalSource),
    ...(typeof status?.reason === "string" ? { unmappedReason: status.reason } : {}),
    ...(lines?.length ? { snippet: lines.slice(0, 20) } : {}),
  };
}

export interface NetworkFilters extends PageRequest {
  /** `2xx`, `4xx`, `5xx`, or an exact status like `500`. */
  statusClass?: string;
  method?: string;
  urlContains?: string;
  failedOnly?: boolean;
  fromMs?: number;
  toMs?: number;
}

export async function listNetwork(
  session: RecordingSession,
  filters: NetworkFilters = {},
): Promise<Page<NetworkView>> {
  const views = await session.networkViews();
  const needle = filters.urlContains?.trim().toLowerCase();
  const method = filters.method?.trim().toUpperCase();

  const filtered = views.filter((view) => {
    if (filters.failedOnly && !view.failed) {
      return false;
    }
    if (method && view.method.toUpperCase() !== method) {
      return false;
    }
    if (needle && !view.url.toLowerCase().includes(needle)) {
      return false;
    }
    if (!withinRange(view.atMs, filters.fromMs, filters.toMs)) {
      return false;
    }
    if (filters.statusClass && !matchesStatusClass(view.status, filters.statusClass)) {
      return false;
    }
    return true;
  });

  return paginate(filtered, filters, [
    "network",
    filters.statusClass,
    filters.method,
    filters.urlContains,
    filters.failedOnly,
    filters.fromMs,
    filters.toMs,
  ]);
}

function matchesStatusClass(status: number | null, statusClass: string): boolean {
  const wanted = statusClass.trim().toLowerCase();
  const exact = Number(wanted);
  if (Number.isFinite(exact) && wanted.length === 3 && !wanted.includes("x")) {
    return status === exact;
  }
  const digit = Number(wanted[0]);
  if (!Number.isFinite(digit) || status === null) {
    return false;
  }
  return Math.floor(status / 100) === digit;
}

export interface NetworkRequestDetail extends NetworkView {
  requestHeaders: Record<string, string> | null;
  responseHeaders: Record<string, string> | null;
  requestBody: TextPayload | null;
  responseBody: TextPayload | null;
  redirectChain: Array<{ url: string; status: number }>;
  initiator: { type?: string; file?: string; line?: number; mapped?: boolean } | null;
}

export interface TextPayload {
  text: string;
  truncated: boolean;
  totalChars: number;
  base64Encoded?: boolean;
}

export interface NetworkDetailOptions {
  includeHeaders?: boolean;
  includeBody?: boolean;
}

export async function getNetworkRequest(
  session: RecordingSession,
  id: string,
  options: NetworkDetailOptions = {},
): Promise<NetworkRequestDetail> {
  const views = await session.networkViews();
  const view = views.find((candidate) => candidate.id === id);
  if (!view) {
    throw new ReplayError("NOT_FOUND", `No network entry with id ${id}.`);
  }
  const raw = ((await session.rawNetwork())[view.index] ?? {}) as Record<string, unknown>;
  const initiator = raw.initiator as Record<string, unknown> | undefined;
  const responseBody = raw.responseBody as Record<string, unknown> | undefined;

  return {
    ...view,
    requestHeaders: options.includeHeaders ? asHeaders(raw.requestHeaders) : null,
    responseHeaders: options.includeHeaders ? asHeaders(raw.responseHeaders) : null,
    requestBody:
      options.includeBody && typeof raw.postData === "string" ? toTextPayload(raw.postData) : null,
    responseBody:
      options.includeBody && typeof responseBody?.body === "string"
        ? {
            ...toTextPayload(responseBody.body),
            base64Encoded: responseBody.base64Encoded === true,
          }
        : null,
    redirectChain: Array.isArray(raw.redirectChain)
      ? raw.redirectChain.slice(0, 10).map((redirect) => {
          const record = (redirect ?? {}) as Record<string, unknown>;
          return {
            url: typeof record.url === "string" ? record.url : "",
            status: typeof record.status === "number" ? record.status : 0,
          };
        })
      : [],
    initiator: initiator
      ? {
          ...(typeof initiator.type === "string" ? { type: initiator.type } : {}),
          ...(typeof initiator.originalSource === "string"
            ? { file: initiator.originalSource, mapped: true }
            : typeof initiator.url === "string"
              ? { file: initiator.url, mapped: false }
              : {}),
          ...(numberOrUndefined(initiator.originalLine ?? initiator.lineNumber) !== undefined
            ? { line: numberOrUndefined(initiator.originalLine ?? initiator.lineNumber) }
            : {}),
        }
      : null,
  };
}

export interface TimelineFilters extends PageRequest {
  fromMs?: number;
  toMs?: number;
  kind?: string;
}

export async function listUserEvents(
  session: RecordingSession,
  filters: TimelineFilters = {},
): Promise<Page<EventView>> {
  const views = await session.eventViews();
  const kind = filters.kind?.trim().toLowerCase();
  const filtered = views.filter((view) => {
    if (kind && view.kind.toLowerCase() !== kind) {
      return false;
    }
    return withinRange(view.atMs, filters.fromMs, filters.toMs);
  });
  return paginate(filtered, filters, ["events", filters.kind, filters.fromMs, filters.toMs]);
}

export async function listWebSockets(
  session: RecordingSession,
  request: PageRequest = {},
): Promise<Page<WebSocketView>> {
  return paginate(await session.websocketViews(), request, ["websocket"]);
}

export type SearchScope = "console" | "network" | "websocket" | "events";

export interface SearchHit {
  scope: SearchScope;
  id: string;
  atMs: number | null;
  label: string;
  detail: string;
}

export interface SearchFilters extends PageRequest {
  scopes?: SearchScope[];
}

export async function searchRecording(
  session: RecordingSession,
  query: string,
  filters: SearchFilters = {},
): Promise<Page<SearchHit>> {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    throw new ReplayError("INVALID_SOURCE", "Search needs a non-empty query.");
  }
  const scopes = filters.scopes?.length
    ? filters.scopes
    : (["console", "network", "websocket", "events"] as SearchScope[]);
  const hits: SearchHit[] = [];

  if (scopes.includes("console")) {
    for (const view of await session.consoleViews()) {
      if (view.message.toLowerCase().includes(needle)) {
        hits.push({
          scope: "console",
          id: view.id,
          atMs: view.atMs,
          label: view.level,
          detail: truncate(view.message, 300),
        });
      }
    }
  }
  if (scopes.includes("network")) {
    for (const view of await session.networkViews()) {
      if (view.url.toLowerCase().includes(needle)) {
        hits.push({
          scope: "network",
          id: view.id,
          atMs: view.atMs,
          label: `${view.method} ${view.status ?? "—"}`,
          detail: truncate(view.url, 300),
        });
      }
    }
  }
  if (scopes.includes("websocket")) {
    for (const view of await session.websocketViews()) {
      if (view.url.toLowerCase().includes(needle)) {
        hits.push({
          scope: "websocket",
          id: view.id,
          atMs: null,
          label: `${view.frameCount} frames`,
          detail: truncate(view.url, 300),
        });
      }
    }
  }
  if (scopes.includes("events")) {
    for (const view of await session.eventViews()) {
      const haystack = `${view.label} ${view.selector ?? ""} ${view.url ?? ""}`.toLowerCase();
      if (haystack.includes(needle)) {
        hits.push({
          scope: "events",
          id: `e-${view.index}`,
          atMs: view.atMs,
          label: view.kind,
          detail: truncate(view.label, 300),
        });
      }
    }
  }

  hits.sort((a, b) => (a.atMs ?? Number.POSITIVE_INFINITY) - (b.atMs ?? Number.POSITIVE_INFINITY));
  return paginate(hits, filters, ["search", needle, scopes.join(",")]);
}

/**
 * Slices a filtered list into a page.
 *
 * The cursor carries a hash of the filter set: resuming a cursor under different
 * filters would silently skip or repeat records, so it fails loudly instead.
 */
export function paginate<T>(items: T[], request: PageRequest, filterKey: unknown[]): Page<T> {
  const limit = clampLimit(request.limit);
  const hash = hashFilters(filterKey);
  const offset = decodeCursor(request.cursor, hash);
  const slice = items.slice(offset, offset + limit);
  const nextOffset = offset + slice.length;
  const hasMore = nextOffset < items.length;

  return {
    items: slice,
    total: items.length,
    returned: slice.length,
    hasMore,
    ...(hasMore ? { nextCursor: `${nextOffset}.${hash}` } : {}),
  };
}

function clampLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit ?? Number.NaN)) {
    return DEFAULT_PAGE_LIMIT;
  }
  return Math.max(1, Math.min(MAX_PAGE_LIMIT, Math.floor(limit as number)));
}

function decodeCursor(cursor: string | undefined, hash: string): number {
  if (!cursor) {
    return 0;
  }
  const [rawOffset, rawHash] = cursor.split(".");
  const offset = Number(rawOffset);
  if (!Number.isFinite(offset) || offset < 0 || rawHash !== hash) {
    throw new ReplayError(
      "INVALID_CURSOR",
      "That cursor belongs to a different query.",
      "Drop the cursor and start the query again with the new filters.",
    );
  }
  return offset;
}

function hashFilters(filterKey: unknown[]): string {
  const text = JSON.stringify(filterKey);
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

function withinRange(atMs: number | null, fromMs?: number, toMs?: number): boolean {
  if (fromMs === undefined && toMs === undefined) {
    return true;
  }
  if (atMs === null) {
    return false;
  }
  if (fromMs !== undefined && atMs < fromMs) {
    return false;
  }
  if (toMs !== undefined && atMs > toMs) {
    return false;
  }
  return true;
}

function toTextPayload(text: string): TextPayload {
  return {
    text: truncate(text, MAX_BODY_CHARS),
    truncated: text.length > MAX_BODY_CHARS,
    totalChars: text.length,
  };
}

function asHeaders(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const headers: Record<string, string> = {};
  for (const [key, headerValue] of Object.entries(value as Record<string, unknown>)) {
    headers[key] =
      typeof headerValue === "string" ? truncate(headerValue, 500) : String(headerValue);
  }
  return headers;
}

function describeArg(arg: unknown): string {
  if (arg === null || arg === undefined) {
    return String(arg);
  }
  if (typeof arg !== "object") {
    return String(arg);
  }
  const record = arg as Record<string, unknown>;
  if (typeof record.value === "string") {
    return record.value;
  }
  if (record.value !== undefined) {
    return String(record.value);
  }
  if (typeof record.description === "string") {
    return record.description;
  }
  return JSON.stringify(arg);
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
