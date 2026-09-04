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
import { hydrateDomNodeToHtml } from "./dom/hydrate-dom";
import { ReplayError } from "./errors";
import type {
  DomArtifact,
  RecordingReport,
  SourceMapDiagnosticsArtifact,
  StorageArtifact,
} from "./schema/capture";
import type { ArtifactId } from "./schema/package";
import { type AgentSummary, buildAgentSummary } from "./summarize";
import { coerceEpochMs } from "./time";
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
export const MAX_MESSAGE_CHARS = 2000;
export const MAX_FRAMES = 20;
/**
 * Per-bucket ceiling on the storage key names returned per snapshot. The
 * `*Count` fields stay exact, so a caller can always tell the list was cut.
 */
export const MAX_STORAGE_KEYS = 200;
/**
 * Ceiling on rendered DOM HTML. A whole document dwarfs every other artifact —
 * a checkout page is easily 500 KB of markup — so this sits well above the
 * response-body ceiling yet still far below "evicts the agent's context".
 */
export const MAX_DOM_HTML_CHARS = 20_000;
/**
 * Ceiling per WebSocket frame payload. Lower than {@link MAX_BODY_CHARS}
 * because a page returns up to {@link MAX_PAGE_LIMIT} frames at once: a frame
 * is one message, not a document, and 100 × 8000 chars is not a bounded reply.
 */
export const MAX_FRAME_PAYLOAD_CHARS = 2000;
/** Ceiling on distinct source-map failure groups, largest count first. */
export const MAX_DIAGNOSTIC_GROUPS = 20;

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
  /**
   * Memoized raw artifact read for artifacts that have no dedicated view.
   * Returns null when the artifact is absent from the package.
   */
  artifact<T>(id: ArtifactId): Promise<T | null>;
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
    artifact: <T>(id: ArtifactId) => once(`raw:${id}`, async () => await pkg.readArtifact<T>(id)),
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

/** One localStorage/sessionStorage entry, without its value. */
export interface StorageEntrySummary {
  key: string;
  /** Length of the captured value. The value itself is never returned. */
  valueChars: number;
  redacted: boolean;
}

/** One cookie, without its value. */
export interface CookieSummary {
  name: string;
  domain: string;
  path: string;
  valueChars: number;
  redacted: boolean;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  /** Epoch seconds, as the browser reports it. */
  expires?: number;
}

export interface StorageSnapshotSummary {
  /** `start` or `stop` on packages written by a shipped producer. */
  phase: string;
  capturedAt: number;
  atMs: number | null;
  /** Exact counts, unaffected by the {@link MAX_STORAGE_KEYS} list ceiling. */
  localStorageCount: number;
  sessionStorageCount: number;
  cookieCount: number;
  localStorage: StorageEntrySummary[];
  sessionStorage: StorageEntrySummary[];
  cookies: CookieSummary[];
  /** True when any of the three lists was cut at {@link MAX_STORAGE_KEYS}. */
  keysTruncated: boolean;
}

export interface StorageReport {
  snapshots: StorageSnapshotSummary[];
}

/**
 * Storage and cookie key presence at each snapshot phase.
 *
 * Returns null when `storage.json` is absent, and `{ snapshots: [] }` when the
 * artifact was captured but holds nothing — "the producer could not read
 * storage" and "storage was empty" are different facts.
 *
 * Values are deliberately unreachable: an auth token, a session id, and a
 * feature flag all live in localStorage, and the question a bug actually turns
 * on ("was the token there when the request 401'd?") is answered by the key
 * name, its length, and the redaction flag. Returning the value would hand a
 * live credential to whatever reads this. Same for cookie values.
 */
export async function readStorage(session: RecordingSession): Promise<StorageReport | null> {
  const artifact = await session.artifact<StorageArtifact>("storage");
  if (artifact === null) {
    return null;
  }

  const snapshots = unwrapArtifactList(artifact, "snapshots").map((raw): StorageSnapshotSummary => {
    const snapshot = (raw ?? {}) as Record<string, unknown>;
    const local = asList(snapshot.localStorage);
    const sessionStore = asList(snapshot.sessionStorage);
    const cookies = asList(snapshot.cookies);
    const capturedAt = numberOrUndefined(snapshot.capturedAt) ?? 0;

    return {
      phase: typeof snapshot.phase === "string" ? snapshot.phase : "unknown",
      capturedAt,
      atMs: toRelative(capturedAt, session.startTime),
      localStorageCount: local.length,
      sessionStorageCount: sessionStore.length,
      cookieCount: cookies.length,
      localStorage: local.slice(0, MAX_STORAGE_KEYS).map(toStorageEntrySummary),
      sessionStorage: sessionStore.slice(0, MAX_STORAGE_KEYS).map(toStorageEntrySummary),
      cookies: cookies.slice(0, MAX_STORAGE_KEYS).map(toCookieSummary),
      keysTruncated:
        local.length > MAX_STORAGE_KEYS ||
        sessionStore.length > MAX_STORAGE_KEYS ||
        cookies.length > MAX_STORAGE_KEYS,
    };
  });

  return { snapshots };
}

export interface DomSnapshotSummary {
  index: number;
  /** `start` or `stop` on packages written by a shipped producer. */
  label: string;
  capturedAt: number;
  atMs: number | null;
  documentUrl: string;
  nodeCount: number;
  /** Depth of the deepest node, counting the root as 1. */
  maxDepth: number;
  /** Nodes the producer's privacy policy masked before serialization. */
  maskedNodeCount: number;
  /** Present only with `includeHtml`; capped at {@link MAX_DOM_HTML_CHARS}. */
  html?: TextPayload;
}

export interface DomSnapshotIndex {
  snapshots: DomSnapshotSummary[];
}

export interface DomSnapshotOptions {
  /**
   * Render each snapshot's tree to an HTML document, truncated at
   * {@link MAX_DOM_HTML_CHARS}. Off by default: a real page's markup is larger
   * than every other artifact in the package combined.
   */
  includeHtml?: boolean;
  /** Restrict to one snapshot label, e.g. `stop`. */
  label?: string;
}

/**
 * Index over `dom.json`: shape and size of each snapshot, not the tree.
 *
 * Returns null when `dom.json` is absent, `{ snapshots: [] }` when it was
 * captured but holds no snapshot.
 */
export async function readDomSnapshots(
  session: RecordingSession,
  options: DomSnapshotOptions = {},
): Promise<DomSnapshotIndex | null> {
  const artifact = await session.artifact<DomArtifact>("dom");
  if (artifact === null) {
    return null;
  }

  const label = options.label?.trim().toLowerCase();
  const snapshots: DomSnapshotSummary[] = [];

  unwrapArtifactList(artifact, "snapshots").forEach((raw, index) => {
    const snapshot = (raw ?? {}) as Record<string, unknown>;
    const snapshotLabel = typeof snapshot.label === "string" ? snapshot.label : "unknown";
    if (label && snapshotLabel.toLowerCase() !== label) {
      return;
    }
    const capturedAt = numberOrUndefined(snapshot.capturedAt) ?? 0;
    const documentUrl = typeof snapshot.documentUrl === "string" ? snapshot.documentUrl : "";
    const shape = measureDomTree(snapshot.root);

    snapshots.push({
      index,
      label: snapshotLabel,
      capturedAt,
      atMs: toRelative(capturedAt, session.startTime),
      documentUrl,
      ...shape,
      ...(options.includeHtml
        ? {
            html: toTextPayload(
              hydrateDomNodeToHtml(snapshot.root, {
                ...(documentUrl ? { baseHref: documentUrl } : {}),
                title: snapshotLabel,
              }),
              MAX_DOM_HTML_CHARS,
            ),
          }
        : {}),
    });
  });

  return { snapshots };
}

export interface SourceMapFailureGroup {
  status: string;
  reason: string | null;
  httpStatusCode: number | null;
  count: number;
  /** One generated script that hit this failure, to reproduce the fetch. */
  exampleGeneratedUrl: string;
}

export interface SourceMapDiagnosticsSummary {
  total: number;
  countByStatus: Record<string, number>;
  /**
   * Non-`success` entries grouped by status + reason + HTTP status, largest
   * group first, capped at {@link MAX_DIAGNOSTIC_GROUPS}.
   */
  failures: SourceMapFailureGroup[];
  failureGroupsTruncated: boolean;
}

/**
 * Why source-map resolution produced the frames it did.
 *
 * Without this, an unmapped stack trace is a dead end: the reader cannot tell a
 * 404 on the `.map` URL from a source map the producer chose to skip. Returns
 * null when `diagnostics.json` is absent; a zero `total` means the artifact was
 * written with no attempts recorded.
 */
export async function readSourceMapDiagnostics(
  session: RecordingSession,
): Promise<SourceMapDiagnosticsSummary | null> {
  const artifact = await session.artifact<SourceMapDiagnosticsArtifact>("diagnostics");
  if (artifact === null) {
    return null;
  }

  const entries = unwrapArtifactList(artifact, "sourceMaps");
  const countByStatus: Record<string, number> = {};
  const groups = new Map<string, SourceMapFailureGroup>();

  for (const raw of entries) {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const status = typeof entry.status === "string" ? entry.status : "unknown";
    countByStatus[status] = (countByStatus[status] ?? 0) + 1;
    if (status === "success") {
      continue;
    }

    const reason = typeof entry.reason === "string" ? entry.reason : null;
    const httpStatusCode = numberOrUndefined(entry.httpStatusCode) ?? null;
    const key = `${status}\u0000${reason}\u0000${httpStatusCode}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    groups.set(key, {
      status,
      reason,
      httpStatusCode,
      count: 1,
      exampleGeneratedUrl:
        typeof entry.generatedUrl === "string" ? truncate(entry.generatedUrl, 300) : "",
    });
  }

  const failures = [...groups.values()].sort((a, b) => b.count - a.count);
  return {
    total: entries.length,
    countByStatus,
    failures: failures.slice(0, MAX_DIAGNOSTIC_GROUPS),
    failureGroupsTruncated: failures.length > MAX_DIAGNOSTIC_GROUPS,
  };
}

export interface ReporterReport {
  title: string;
  description: string | null;
  expected: string | null;
  actual: string | null;
  severity: "low" | "medium" | "high" | "critical" | null;
  /** Issue key, ticket URL, or whatever the reporter pasted. */
  reference: string | null;
  createdAt: string;
  pageUrl: string;
  pageTitle: string | null;
}

/**
 * The reporter's own bug statement from `report.json`.
 *
 * The agent summary carries only the page title and environment, so the human's
 * expected-versus-actual — the one field written by someone who saw the bug —
 * never reaches a reader through the summary. Returns null when `report.json`
 * is absent.
 */
export async function readReporterReport(
  session: RecordingSession,
): Promise<ReporterReport | null> {
  const report = await session.artifact<RecordingReport>("report");
  if (!report) {
    return null;
  }

  const page = (report.page ?? {}) as { url?: string; title?: string };
  return {
    title: truncate(report.title ?? "", MAX_MESSAGE_CHARS),
    description: optionalText(report.description),
    expected: optionalText(report.expected),
    actual: optionalText(report.actual),
    severity: report.severity ?? null,
    reference: optionalText(report.reference),
    createdAt: typeof report.createdAt === "string" ? report.createdAt : "",
    pageUrl: typeof page.url === "string" ? page.url : "",
    pageTitle: optionalText(page.title),
  };
}

export interface WebSocketFrameView {
  /** Position within the connection's frame list. */
  index: number;
  direction: "sent" | "received" | "unknown";
  /** RFC 6455 opcode: 1 text, 2 binary, 8 close, 9 ping, 10 pong. */
  opcode: number;
  /**
   * Recording-relative milliseconds, or null when the captured timestamp is a
   * monotonic value with no wall-clock anchor (legacy CDP packages).
   */
  atMs: number | null;
  payload: TextPayload;
}

/**
 * Frames of one WebSocket connection.
 *
 * `connectionId` accepts the view id from {@link listWebSockets} (`w-0`) or the
 * producer's own `requestId`. Payloads are capped at
 * {@link MAX_FRAME_PAYLOAD_CHARS}; a producer whose privacy profile drops
 * WebSocket payloads leaves them empty, which `payload.totalChars: 0`
 * reports rather than hiding.
 */
export async function listWebSocketFrames(
  session: RecordingSession,
  connectionId: string,
  request: PageRequest = {},
): Promise<Page<WebSocketFrameView>> {
  const views = await session.websocketViews();
  const raw = await session.rawWebsocket();
  let index = views.findIndex((view) => view.id === connectionId);
  if (index < 0) {
    index = raw.findIndex(
      (entry) => ((entry ?? {}) as Record<string, unknown>).requestId === connectionId,
    );
  }
  if (index < 0) {
    throw new ReplayError(
      "NOT_FOUND",
      `No WebSocket connection with id ${connectionId}.`,
      "List connections first; ids look like `w-0`.",
    );
  }

  const frames = asList((raw[index] as Record<string, unknown> | undefined)?.frames).map(
    (item, frameIndex): WebSocketFrameView => {
      const frame = (item ?? {}) as Record<string, unknown>;
      const payload = typeof frame.payloadData === "string" ? frame.payloadData : "";
      const direction = frame.direction;

      return {
        index: frameIndex,
        direction: direction === "sent" || direction === "received" ? direction : "unknown",
        opcode: numberOrUndefined(frame.opcode) ?? 0,
        atMs: toRelative(
          coerceEpochMs(numberOrUndefined(frame.timestamp) ?? null) ?? 0,
          session.startTime,
        ),
        payload: toTextPayload(payload, MAX_FRAME_PAYLOAD_CHARS),
      };
    },
  );

  return paginate(frames, request, ["websocket-frames", connectionId]);
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
  fromMs?: number;
  toMs?: number;
}

export interface SearchPage extends Page<SearchHit> {
  /**
   * Hits dropped because a time window was given and the hit carries no
   * wall-clock anchor. Always 0 without a window.
   */
  excludedWithoutTimestamp: number;
}

/**
 * Free-text search across the recording, newest-anchored hits first.
 *
 * `fromMs`/`toMs` are recording-relative milliseconds. WebSocket hits have no
 * wall-clock anchor (`atMs: null`), so a time window drops them rather than
 * keeping matches that cannot be placed on the timeline. Silently keeping them
 * would make "no network activity in this window" a lie; silently dropping them
 * would hide a match, so the count lands in `excludedWithoutTimestamp`.
 */
export async function searchRecording(
  session: RecordingSession,
  query: string,
  filters: SearchFilters = {},
): Promise<SearchPage> {
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

  const windowed =
    filters.fromMs === undefined && filters.toMs === undefined
      ? hits
      : hits.filter((hit) => withinRange(hit.atMs, filters.fromMs, filters.toMs));

  windowed.sort(
    (a, b) => (a.atMs ?? Number.POSITIVE_INFINITY) - (b.atMs ?? Number.POSITIVE_INFINITY),
  );
  return {
    ...paginate(windowed, filters, [
      "search",
      needle,
      scopes.join(","),
      filters.fromMs,
      filters.toMs,
    ]),
    excludedWithoutTimestamp: hits.length - windowed.length,
  };
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

function toTextPayload(text: string, max = MAX_BODY_CHARS): TextPayload {
  return {
    text: truncate(text, max),
    truncated: text.length > max,
    totalChars: text.length,
  };
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function optionalText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? truncate(trimmed, MAX_MESSAGE_CHARS) : null;
}

/**
 * Epoch milliseconds to recording-relative milliseconds. Null when the value is
 * not a usable wall-clock instant, so a caller never sees a bogus `0ms`.
 */
function toRelative(epochMs: number, startTime: number): number | null {
  if (!Number.isFinite(epochMs) || epochMs <= 0 || !startTime) {
    return null;
  }
  return Math.round(epochMs - startTime);
}

function toStorageEntrySummary(raw: unknown): StorageEntrySummary {
  const entry = (raw ?? {}) as Record<string, unknown>;
  return {
    key: typeof entry.key === "string" ? truncate(entry.key, 300) : "",
    valueChars: typeof entry.value === "string" ? entry.value.length : 0,
    redacted: entry.redacted === true,
  };
}

function toCookieSummary(raw: unknown): CookieSummary {
  const cookie = (raw ?? {}) as Record<string, unknown>;
  const sameSite = cookie.sameSite;
  const expires = numberOrUndefined(cookie.expires);
  return {
    name: typeof cookie.name === "string" ? truncate(cookie.name, 300) : "",
    domain: typeof cookie.domain === "string" ? cookie.domain : "",
    path: typeof cookie.path === "string" ? cookie.path : "",
    valueChars: typeof cookie.value === "string" ? cookie.value.length : 0,
    redacted: cookie.redacted === true,
    httpOnly: cookie.httpOnly === true,
    secure: cookie.secure === true,
    ...(sameSite === "Strict" || sameSite === "Lax" || sameSite === "None" ? { sameSite } : {}),
    ...(expires === undefined ? {} : { expires }),
  };
}

/**
 * Node count, deepest nesting, and masked-node count of a serialized DOM tree.
 *
 * Iterative on purpose: a captured document nests deeper than a recursive walk
 * can survive on some runtimes, and a stack overflow while summarizing a
 * snapshot would take down the whole read.
 */
function measureDomTree(root: unknown): {
  nodeCount: number;
  maxDepth: number;
  maskedNodeCount: number;
} {
  if (!root || typeof root !== "object") {
    return { nodeCount: 0, maxDepth: 0, maskedNodeCount: 0 };
  }

  let nodeCount = 0;
  let maxDepth = 0;
  let maskedNodeCount = 0;
  const stack: Array<{ node: Record<string, unknown>; depth: number }> = [
    { node: root as Record<string, unknown>, depth: 1 },
  ];

  while (stack.length > 0) {
    const { node, depth } = stack.pop() as { node: Record<string, unknown>; depth: number };
    nodeCount += 1;
    if (depth > maxDepth) {
      maxDepth = depth;
    }
    if (node.masked === true) {
      maskedNodeCount += 1;
    }
    for (const child of asList(node.children)) {
      if (child && typeof child === "object") {
        stack.push({ node: child as Record<string, unknown>, depth: depth + 1 });
      }
    }
  }

  return { nodeCount, maxDepth, maskedNodeCount };
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
