/**
 * In-page (MAIN world) capture instrumentation core.
 *
 * This module monkey-patches `console.*`, `window.fetch`, `XMLHttpRequest`,
 * `WebSocket`, and snapshots storage, mapping every captured datum onto the
 * artifact schemas the replay player already reads (`ConsoleEntry`,
 * `NetworkEntry`, `WebSocketEntry`, `StorageSnapshot`). It is deliberately free
 * of any `chrome.*` dependency so it can run in the page's MAIN world (where
 * those APIs are unavailable) and so the patch/cleanup logic stays unit
 * testable with an injected scope.
 *
 * Redaction is intentionally NOT applied here. As prescribed by the design
 * (PHẦN E.2), the service worker redacts entries when it receives the bridged
 * messages, mirroring the existing `RECORDING_USER_EVENT` flow.
 *
 * Correctness Property P6 (Requirement R9.4): `installInPageCapture()` returns
 * a cleanup function that restores every monkey-patched global to the exact
 * original reference captured before patching.
 */

import type {
  ConsoleEntry,
  CookieRecord,
  NetworkEntry,
  SerializedRemoteObject,
  StorageKeyValue,
  StorageSnapshot,
  WebSocketEntry,
} from "../schema/capture";

/** Discriminated kinds emitted by the in-page capture. */
export type InPageCaptureKind = "console" | "network" | "websocket" | "storage";

/** Sink invoked for every captured entry. The transport is supplied by the caller. */
export type InPageCaptureSend = (
  sessionId: string,
  kind: InPageCaptureKind,
  entry: ConsoleEntry | NetworkEntry | WebSocketEntry | StorageSnapshot,
) => void;

/** Session-bound sink used internally by the patch installers. */
type BoundSend = (
  kind: InPageCaptureKind,
  entry: ConsoleEntry | NetworkEntry | WebSocketEntry | StorageSnapshot,
) => void;

/** Mirrors `ResponseBodyCaptureMode` in src/types/messages.ts; kept as a local
 * literal type rather than an import so this package stays free of a
 * dependency on `src/`. */
export type InPageResponseBodyCaptureMode = "off" | "text" | "text-json" | "eligible";

export interface InPageCaptureOptions {
  /** Default "off": reading a response/XHR body is extra work on every request. */
  responseBodyMode?: InPageResponseBodyCaptureMode;
  /** No limit when omitted, matching the CDP path's `maxResponseBodyBytes: null` default. */
  maxResponseBodyBytes?: number | null;
}

function isJsonMime(mime: string): boolean {
  return mime.includes("json") || mime.includes("+json");
}

function isJavascriptMime(mime: string): boolean {
  return (
    mime.includes("javascript") ||
    mime.includes("ecmascript") ||
    mime.startsWith("application/javascript") ||
    mime.startsWith("application/x-javascript") ||
    mime.startsWith("text/javascript")
  );
}

/**
 * Same text-like eligibility CDP uses (see `shouldFetchResponseBody` in
 * `src/shared/network-response-body.ts`), duplicated rather than imported: this
 * package has no dependency on `src/`, and the rule is small enough that
 * copying it is cheaper than introducing a shared package boundary for it.
 * Divergence risk is covered by `response-body-eligibility.test.ts` asserting
 * both copies agree on the same fixture table.
 */
export function isEligibleResponseBodyMime(
  mode: InPageResponseBodyCaptureMode,
  mimeType: string | null,
): boolean {
  if (mode === "off" || !mimeType) {
    return false;
  }
  const mime = mimeType.toLowerCase().trim();
  if (!mime) {
    return false;
  }
  if (mode === "text") {
    return mime.startsWith("text/");
  }
  if (mode === "text-json") {
    return mime.startsWith("text/") || isJsonMime(mime);
  }
  if (mime.startsWith("text/")) return true;
  if (isJsonMime(mime)) return true;
  if (isJavascriptMime(mime)) return true;
  const eligiblePrefixes = [
    "application/xml",
    "application/xhtml+xml",
    "application/manifest+json",
    "application/ld+json",
    "image/svg+xml",
  ];
  return eligiblePrefixes.some((prefix) => mime.startsWith(prefix));
}

/**
 * The subset of global APIs the capture monkey-patches. Tests can pass a mock
 * scope to verify patch/restore behavior without touching the real page.
 */
export interface InPageCaptureScope {
  console: Console;
  fetch?: typeof fetch;
  XMLHttpRequest?: typeof XMLHttpRequest;
  WebSocket?: typeof WebSocket;
  localStorage?: Storage;
  sessionStorage?: Storage;
  performance?: { now(): number };
  document?: { cookie: string };
  location?: { href: string };
  /**
   * Present on a real `window`. When available, uncaught errors and rejected
   * promises are captured as `source: "exception"` console entries — the
   * closest this mode gets to CDP's `Runtime.exceptionThrown`, and the single
   * most useful signal a debugging recording can carry.
   */
  addEventListener?: (type: string, listener: (event: unknown) => void, options?: unknown) => void;
  removeEventListener?: (
    type: string,
    listener: (event: unknown) => void,
    options?: unknown,
  ) => void;
}

const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug", "trace"] as const;
type ConsoleMethod = (typeof CONSOLE_METHODS)[number];

// Console method name → CDP-style level so the player styles entries the same
// way it styles CDP-captured console output.
const CONSOLE_LEVEL_BY_METHOD: Record<ConsoleMethod, string> = {
  log: "log",
  info: "info",
  warn: "warning",
  error: "error",
  debug: "debug",
  trace: "trace",
};

let requestCounter = 0;

function nextRequestId(prefix: string): string {
  requestCounter += 1;
  return `inpage-${prefix}-${Date.now().toString(36)}-${requestCounter.toString(36)}`;
}

function monotonicNow(scope: InPageCaptureScope): number {
  const perf = scope.performance;
  if (perf && typeof perf.now === "function") {
    return perf.now() / 1000;
  }
  return Date.now() / 1000;
}

/**
 * Serializes a single console argument into a `SerializedRemoteObject` so the
 * player's object viewer can render it without source-awareness.
 */
export function serializeConsoleArg(value: unknown): SerializedRemoteObject {
  if (value === null) {
    return { type: "object", subtype: "null", value: null, description: "null" };
  }

  const valueType = typeof value;
  switch (valueType) {
    case "undefined":
      return { type: "undefined", description: "undefined" };
    case "string":
      return { type: "string", value, description: value as string };
    case "number":
      return { type: "number", value, description: String(value) };
    case "boolean":
      return { type: "boolean", value, description: String(value) };
    case "bigint":
      return { type: "bigint", description: `${String(value)}n` };
    case "symbol":
      return { type: "symbol", description: String(value as symbol) };
    case "function": {
      const fn = value as { name?: string };
      const name = typeof fn.name === "string" && fn.name ? fn.name : "anonymous";
      return { type: "function", className: "Function", description: `function ${name}()` };
    }
    default:
      return serializeObjectArg(value);
  }
}

function serializeObjectArg(value: unknown): SerializedRemoteObject {
  if (value instanceof Error) {
    return {
      type: "object",
      subtype: "error",
      className: value.name || "Error",
      description: value.stack || `${value.name}: ${value.message}`,
    };
  }

  const isArray = Array.isArray(value);
  const className = isArray
    ? "Array"
    : ((value as { constructor?: { name?: string } })?.constructor?.name ?? "Object");

  let description = isArray ? `Array(${(value as unknown[]).length})` : className;
  let serializedValue: unknown;
  try {
    // Structured value lets the player render an expandable tree. Guard against
    // cycles/unserializable values without throwing into the patched call.
    serializedValue = JSON.parse(JSON.stringify(value));
    if (description === "Object" || description === "Array") {
      description = isArray ? `Array(${(value as unknown[]).length})` : description;
    }
  } catch {
    serializedValue = undefined;
    try {
      description = String(value);
    } catch {
      description = className;
    }
  }

  return {
    type: "object",
    subtype: isArray ? "array" : undefined,
    className,
    description,
    value: serializedValue,
  };
}

function consoleArgsToMessage(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === "string") {
        return arg;
      }
      const serialized = serializeConsoleArg(arg);
      return serialized.description ?? String(serialized.value ?? "");
    })
    .join(" ");
}

export function toConsoleEntry(method: ConsoleMethod, args: unknown[]): ConsoleEntry {
  return {
    source: "console-api",
    level: CONSOLE_LEVEL_BY_METHOD[method] ?? method,
    timestamp: Date.now(),
    message: consoleArgsToMessage(args),
    args: args.map(serializeConsoleArg),
  };
}

function headersToRecord(
  headers: HeadersInit | Headers | undefined,
): Record<string, string> | null {
  if (!headers) {
    return null;
  }
  const record: Record<string, string> = {};
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    headers.forEach((value, key) => {
      record[key] = value;
    });
    return record;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      record[key] = value;
    }
    return record;
  }
  for (const [key, value] of Object.entries(headers as Record<string, string>)) {
    record[key] = value;
  }
  return record;
}

function responseHeadersToRecord(headers: Headers | undefined): Record<string, string> | null {
  if (!headers) {
    return null;
  }
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

function emptyNetworkEntry(url: string, method: string, resourceType: string): NetworkEntry {
  return {
    requestId: nextRequestId(resourceType),
    url,
    method,
    requestHeaders: null,
    postData: null,
    timestamp: 0,
    wallTime: Date.now() / 1000,
    initiator: null,
    resourceType,
    status: null,
    statusText: null,
    responseHeaders: null,
    mimeType: null,
    timing: null,
    protocol: null,
    remoteIPAddress: null,
    encodedDataLength: 0,
    error: null,
    // Response bodies are deliberately not read in-page: doing so would consume
    // the page's response stream and cannot read cross-origin bodies (R9.5).
    responseBody: null,
    redirectChain: null,
  };
}

function resolveRequestUrl(scope: InPageCaptureScope, input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (typeof URL !== "undefined" && input instanceof URL) {
    return input.toString();
  }
  if (input && typeof (input as Request).url === "string") {
    return (input as Request).url;
  }
  return scope.location?.href ?? "";
}

function resolveRequestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) {
    return init.method.toUpperCase();
  }
  if (input && typeof input === "object" && typeof (input as Request).method === "string") {
    return (input as Request).method.toUpperCase();
  }
  return "GET";
}

function readStorage(storage: Storage | undefined): StorageKeyValue[] {
  if (!storage) {
    return [];
  }
  const items: StorageKeyValue[] = [];
  try {
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key === null) {
        continue;
      }
      items.push({ key, value: storage.getItem(key) ?? "" });
    }
  } catch {
    // Access can throw when storage is disabled (e.g. blocked third-party
    // contexts). Treat as empty rather than breaking the page.
  }
  return items;
}

function readCookies(cookieString: string | undefined): CookieRecord[] {
  if (!cookieString) {
    return [];
  }
  const cookies: CookieRecord[] = [];
  for (const pair of cookieString.split(";")) {
    const trimmed = pair.trim();
    if (!trimmed) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    const name = separator >= 0 ? trimmed.slice(0, separator) : trimmed;
    const value = separator >= 0 ? trimmed.slice(separator + 1) : "";
    // document.cookie cannot expose domain/path/httpOnly; record defaults so
    // the shape still satisfies the player's CookieRecord schema.
    cookies.push({ name, value, domain: "", path: "/" });
  }
  return cookies;
}

function safeRead<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    // Property access itself (e.g. `window.localStorage`) can throw in
    // sandboxed/blocked contexts; degrade gracefully without breaking capture.
    return fallback;
  }
}

/** Captures a player-compatible `StorageSnapshot` for the given phase. */
export function captureStorageSnapshot(
  scope: InPageCaptureScope,
  phase: "start" | "stop",
): StorageSnapshot {
  return {
    phase,
    capturedAt: Date.now(),
    localStorage: safeRead(() => readStorage(scope.localStorage), []),
    sessionStorage: safeRead(() => readStorage(scope.sessionStorage), []),
    cookies: safeRead(() => readCookies(scope.document?.cookie), []),
  };
}

/**
 * Installs the in-page capture against the supplied scope and returns a cleanup
 * function. The cleanup restores every monkey-patched global to its original
 * reference and emits a final `"stop"` storage snapshot (Property P6 / R9.4).
 */
export function installInPageCapture(
  scope: InPageCaptureScope,
  sessionId: string,
  send: InPageCaptureSend,
  options: InPageCaptureOptions = {},
): () => void {
  const emit: BoundSend = (kind, entry) => send(sessionId, kind, entry);
  const restorers: Array<() => void> = [];
  /** In-flight fetch/XHR rows; flushed as incomplete when capture stops. */
  const inflightNetwork = new Set<PendingNetworkCapture>();

  installConsoleCapture(scope, emit, restorers);
  installUncaughtErrorCapture(scope, emit, restorers);
  installFetchCapture(scope, emit, restorers, inflightNetwork, options);
  installXhrCapture(scope, emit, restorers, inflightNetwork, options);
  installWebSocketCapture(scope, emit, restorers);

  // Storage is captured via start/stop snapshots (the player's StorageSnapshot
  // schema), matching CDP mode; per design the setItem/removeItem patch is
  // optional, so no Storage global is patched and none needs restoring.
  emit("storage", captureStorageSnapshot(scope, "start"));

  let cleaned = false;
  return () => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    // Flush incomplete network rows before tearing down patches so stop-time
    // packaging still sees in-flight fetch/XHR (status null = incomplete).
    for (const pending of Array.from(inflightNetwork)) {
      settleNetworkCapture(pending, inflightNetwork, emit);
    }
    emit("storage", captureStorageSnapshot(scope, "stop"));
    // Restore in reverse order so each global returns to its exact original.
    for (let i = restorers.length - 1; i >= 0; i -= 1) {
      restorers[i]();
    }
  };
}

/**
 * Captures uncaught errors and unhandled promise rejections as
 * `source: "exception"` console entries.
 *
 * These are recorded as *listeners*, never by overwriting `window.onerror` —
 * the page may own that handler, and a recorder that displaces a product's own
 * error reporting has changed the thing it was supposed to observe. Listeners
 * are additive and are removed again on cleanup.
 */
function installUncaughtErrorCapture(
  scope: InPageCaptureScope,
  send: BoundSend,
  restorers: Array<() => void>,
): void {
  const add = scope.addEventListener;
  const remove = scope.removeEventListener;
  if (typeof add !== "function" || typeof remove !== "function") {
    return;
  }

  const onError = (event: unknown): void => {
    const errorEvent = event as {
      message?: string;
      filename?: string;
      lineno?: number;
      colno?: number;
      error?: unknown;
    };
    send("console", {
      source: "exception",
      level: "error",
      timestamp: Date.now(),
      message: errorEvent.message || "Uncaught error",
      args: errorEvent.error === undefined ? [] : [serializeConsoleArg(errorEvent.error)],
      url: errorEvent.filename,
      lineNumber: errorEvent.lineno,
      columnNumber: errorEvent.colno,
    });
  };

  const onRejection = (event: unknown): void => {
    const reason = (event as { reason?: unknown }).reason;
    send("console", {
      source: "exception",
      level: "error",
      timestamp: Date.now(),
      message: `Unhandled promise rejection: ${describeRejection(reason)}`,
      args: reason === undefined ? [] : [serializeConsoleArg(reason)],
    });
  };

  add.call(scope, "error", onError);
  add.call(scope, "unhandledrejection", onRejection);
  restorers.push(() => {
    remove.call(scope, "error", onError);
    remove.call(scope, "unhandledrejection", onRejection);
  });
}

function describeRejection(reason: unknown): string {
  if (reason instanceof Error) {
    return `${reason.name}: ${reason.message}`;
  }
  if (typeof reason === "string") {
    return reason;
  }
  try {
    return JSON.stringify(reason) ?? String(reason);
  } catch {
    return String(reason);
  }
}

function installConsoleCapture(
  scope: InPageCaptureScope,
  send: BoundSend,
  restorers: Array<() => void>,
): void {
  const target = scope.console as unknown as Record<string, unknown>;
  for (const method of CONSOLE_METHODS) {
    const original = target[method];
    if (typeof original !== "function") {
      continue;
    }
    const originalFn = original as (...args: unknown[]) => unknown;
    target[method] = (...args: unknown[]): unknown => {
      try {
        send("console", toConsoleEntry(method, args));
      } catch {
        // Never let capture failures break the page's own logging.
      }
      return originalFn.apply(scope.console, args);
    };
    restorers.push(() => {
      target[method] = originalFn;
    });
  }
}

/** Tracks an in-flight network capture so cleanup can flush incomplete rows once. */
interface PendingNetworkCapture {
  entry: NetworkEntry;
  settled: boolean;
}

function settleNetworkCapture(
  pending: PendingNetworkCapture,
  inflight: Set<PendingNetworkCapture>,
  send: BoundSend,
  mutate?: (entry: NetworkEntry) => void,
): void {
  if (pending.settled) {
    return;
  }
  pending.settled = true;
  inflight.delete(pending);
  try {
    mutate?.(pending.entry);
    send("network", pending.entry);
  } catch {
    // Never let capture failures break the page request path.
  }
}

function installFetchCapture(
  scope: InPageCaptureScope,
  send: BoundSend,
  restorers: Array<() => void>,
  inflight: Set<PendingNetworkCapture>,
  options: InPageCaptureOptions,
): void {
  const originalFetch = scope.fetch;
  if (typeof originalFetch !== "function") {
    return;
  }
  const mode = options.responseBodyMode ?? "off";
  const maxBytes = options.maxResponseBodyBytes ?? null;
  const patched: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = resolveRequestUrl(scope, input);
    const method = resolveRequestMethod(input, init);
    const entry = emptyNetworkEntry(url, method, "fetch");
    entry.timestamp = monotonicNow(scope);
    entry.requestHeaders = headersToRecord(init?.headers);
    if (typeof init?.body === "string") {
      entry.postData = init.body;
    }
    const pending: PendingNetworkCapture = { entry, settled: false };
    inflight.add(pending);
    try {
      const response = await originalFetch(input as RequestInfo, init);
      // Clone before any body read: the page's own code still needs the
      // original Response's body stream, and a Response body can only be
      // consumed once.
      const bodyClone = mode === "off" ? null : response.clone();
      const mimeType = response.headers?.get?.("content-type") ?? null;
      const encodedDataLength = Number(response.headers?.get?.("content-length") ?? 0) || 0;
      const eligible =
        bodyClone &&
        isEligibleResponseBodyMime(mode, mimeType) &&
        (maxBytes == null || encodedDataLength <= maxBytes);

      settleNetworkCapture(pending, inflight, send, (e) => {
        e.status = response.status;
        e.statusText = response.statusText;
        e.responseHeaders = responseHeadersToRecord(response.headers);
        e.mimeType = mimeType;
        e.encodedDataLength = encodedDataLength;
      });

      if (eligible && bodyClone) {
        // Read after settleNetworkCapture posts the entry: a slow or hanging
        // body read must not delay delivering the metadata row, and a read
        // failure here is caught on its own so it cannot affect the entry
        // already sent.
        void bodyClone
          .text()
          .then((body) => {
            if (maxBytes == null || body.length <= maxBytes) {
              send("network", { ...entry, responseBody: { body, base64Encoded: false } });
            }
          })
          .catch(() => {
            // Body unreadable (e.g. already-disturbed edge case) — the
            // metadata row already went out; nothing to salvage.
          });
      }
      return response;
    } catch (error) {
      settleNetworkCapture(pending, inflight, send, (e) => {
        e.error = error instanceof Error ? error.message : String(error);
      });
      throw error;
    }
  };
  scope.fetch = patched;
  restorers.push(() => {
    scope.fetch = originalFetch;
  });
}

interface CapturedXhrState {
  pending: PendingNetworkCapture;
}

function installXhrCapture(
  scope: InPageCaptureScope,
  send: BoundSend,
  restorers: Array<() => void>,
  inflight: Set<PendingNetworkCapture>,
  options: InPageCaptureOptions,
): void {
  const OriginalXHR = scope.XMLHttpRequest;
  if (typeof OriginalXHR !== "function") {
    return;
  }
  const mode = options.responseBodyMode ?? "off";
  const maxBytes = options.maxResponseBodyBytes ?? null;

  const stateKey = "__gnTracingXhrState";
  const proto = OriginalXHR.prototype as XMLHttpRequest & Record<string, unknown>;
  const originalOpen = proto.open;
  const originalSend = proto.send;

  proto.open = function patchedOpen(
    this: XMLHttpRequest & Record<string, unknown>,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ): void {
    const urlString = typeof url === "string" ? url : url.toString();
    const entry = emptyNetworkEntry(urlString, (method || "GET").toUpperCase(), "xhr");
    const pending: PendingNetworkCapture = { entry, settled: false };
    const state: CapturedXhrState = { pending };
    this[stateKey] = state;
    (originalOpen as (...a: unknown[]) => void).apply(this, [method, url, ...rest]);
  } as typeof proto.open;

  proto.send = function patchedSend(
    this: XMLHttpRequest & Record<string, unknown>,
    body?: Document | XMLHttpRequestBodyInit | null,
  ): void {
    const state = this[stateKey] as CapturedXhrState | undefined;
    if (state) {
      state.pending.entry.timestamp = monotonicNow(scope);
      if (typeof body === "string") {
        state.pending.entry.postData = body;
      }
      inflight.add(state.pending);
      const onLoadEnd = (): void => {
        const mimeType = this.getResponseHeader?.("content-type") ?? null;
        // responseText throws for any responseType other than "" or "text"
        // (blob/arraybuffer/document reads are not safe to stringify here),
        // so eligibility gates on that before touching the mode/MIME rules.
        const canReadText = this.responseType === "" || this.responseType === "text";
        const encodedDataLength = Number(this.getResponseHeader?.("content-length") ?? 0) || 0;
        const eligible =
          canReadText &&
          isEligibleResponseBodyMime(mode, mimeType) &&
          (maxBytes == null || encodedDataLength <= maxBytes);

        settleNetworkCapture(state.pending, inflight, send, (entry) => {
          entry.status = this.status || null;
          entry.statusText = this.statusText || null;
          const rawHeaders = this.getAllResponseHeaders?.() ?? "";
          entry.responseHeaders = parseRawHeaders(rawHeaders);
          entry.mimeType = mimeType ?? entry.mimeType;
          entry.encodedDataLength = encodedDataLength;
        });

        if (eligible) {
          try {
            const body = this.responseText;
            if (body && (maxBytes == null || body.length <= maxBytes)) {
              send("network", {
                ...state.pending.entry,
                responseBody: { body, base64Encoded: false },
              });
            }
          } catch {
            // responseText access failed — the metadata row already went out.
          }
        }
        this.removeEventListener("loadend", onLoadEnd);
        this.removeEventListener("error", onError);
      };
      const onError = (): void => {
        settleNetworkCapture(state.pending, inflight, send, (entry) => {
          entry.error = "Network request failed";
        });
        this.removeEventListener("loadend", onLoadEnd);
        this.removeEventListener("error", onError);
      };
      this.addEventListener("loadend", onLoadEnd);
      this.addEventListener("error", onError);
    }
    (originalSend as (...a: unknown[]) => void).apply(this, [body]);
  } as typeof proto.send;

  restorers.push(() => {
    proto.open = originalOpen;
    proto.send = originalSend;
  });
}

function parseRawHeaders(raw: string): Record<string, string> | null {
  if (!raw) {
    return null;
  }
  const record: Record<string, string> = {};
  for (const line of raw.trim().split(/[\r\n]+/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      continue;
    }
    record[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return Object.keys(record).length > 0 ? record : null;
}

function installWebSocketCapture(
  scope: InPageCaptureScope,
  send: BoundSend,
  restorers: Array<() => void>,
): void {
  const OriginalWebSocket = scope.WebSocket;
  if (typeof OriginalWebSocket !== "function") {
    return;
  }

  const PatchedWebSocket = function PatchedWebSocket(
    this: unknown,
    url: string | URL,
    protocols?: string | string[],
  ): WebSocket {
    const socket =
      protocols === undefined ? new OriginalWebSocket(url) : new OriginalWebSocket(url, protocols);

    const entry: WebSocketEntry = {
      requestId: nextRequestId("ws"),
      url: typeof url === "string" ? url : url.toString(),
      frames: [],
      closed: false,
    };

    const emit = (): void => {
      // Emit a fresh snapshot per frame/close so downstream routing can replace
      // the entry by requestId (task 20). Clone frames to avoid shared mutation.
      send("websocket", { ...entry, frames: entry.frames.slice() });
    };

    const originalWsSend = socket.send.bind(socket);
    socket.send = (data: string | ArrayBufferLike | Blob | ArrayBufferView): void => {
      entry.frames.push({
        direction: "sent",
        timestamp: Date.now(),
        opcode: typeof data === "string" ? 1 : 2,
        payloadData: typeof data === "string" ? data : "[binary]",
      });
      emit();
      originalWsSend(data);
    };

    socket.addEventListener("message", (event: MessageEvent) => {
      const isString = typeof event.data === "string";
      entry.frames.push({
        direction: "received",
        timestamp: Date.now(),
        opcode: isString ? 1 : 2,
        payloadData: isString ? event.data : "[binary]",
      });
      emit();
    });

    socket.addEventListener("close", () => {
      entry.closed = true;
      emit();
    });

    emit();
    return socket;
  } as unknown as typeof WebSocket;

  // Preserve prototype + static constants so instanceof and WebSocket.OPEN work.
  PatchedWebSocket.prototype = OriginalWebSocket.prototype;
  (PatchedWebSocket as unknown as Record<string, unknown>).CONNECTING =
    OriginalWebSocket.CONNECTING;
  (PatchedWebSocket as unknown as Record<string, unknown>).OPEN = OriginalWebSocket.OPEN;
  (PatchedWebSocket as unknown as Record<string, unknown>).CLOSING = OriginalWebSocket.CLOSING;
  (PatchedWebSocket as unknown as Record<string, unknown>).CLOSED = OriginalWebSocket.CLOSED;

  scope.WebSocket = PatchedWebSocket;
  restorers.push(() => {
    scope.WebSocket = OriginalWebSocket;
  });
}
