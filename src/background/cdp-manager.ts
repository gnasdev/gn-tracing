import { SourceMapResolver } from "./sourcemap-resolver";
import type { StorageManager } from "./storage-manager";
import type {
  ConsoleEntry,
  NetworkEntry,
  WebSocketEntry,
  SerializedRemoteObject,
  ObjectPreview,
  StackFrame,
} from "../types/recording";

// CDP event param interfaces for the events we handle
interface CdpRequestWillBeSentParams {
  requestId: string;
  request: {
    url: string;
    method: string;
    headers: Record<string, string>;
    postData?: string;
    hasPostData?: boolean;
  };
  timestamp: number;
  wallTime: number;
  initiator: { type?: string; url?: string; lineNumber?: number; columnNumber?: number; stack?: CdpRawStackTrace };
  type: string;
  redirectResponse?: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
  };
}

interface CdpRequestWillBeSentExtraInfoParams {
  requestId: string;
  headers?: Record<string, string>;
}

interface CdpResponseReceivedParams {
  requestId: string;
  response: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    mimeType: string;
    timing?: {
      dnsStart: number; dnsEnd: number;
      connectStart: number; connectEnd: number;
      sslStart: number; sslEnd: number;
      sendStart: number; sendEnd: number;
      receiveHeadersEnd: number;
    };
    protocol?: string;
    remoteIPAddress?: string;
  };
}

interface CdpResponseReceivedExtraInfoParams {
  requestId: string;
  headers?: Record<string, string>;
  statusCode?: number;
}

interface CdpResponseReceivedEarlyHintsParams {
  requestId: string;
  headers?: Record<string, string>;
}

interface CdpLoadingFinishedParams {
  requestId: string;
  encodedDataLength: number;
}

interface CdpLoadingFailedParams {
  requestId: string;
  errorText: string;
  canceled?: boolean;
}

interface CdpRequestServedFromCacheParams {
  requestId: string;
}

interface CdpWebSocketCreatedParams {
  requestId: string;
  url: string;
  initiator?: { type?: string; url?: string; lineNumber?: number; columnNumber?: number; stack?: CdpRawStackTrace };
}

interface CdpWebSocketFrameParams {
  requestId: string;
  timestamp: number;
  response: { opcode: number; payloadData: string };
}

interface CdpWebSocketClosedParams {
  requestId: string;
}

interface CdpConsoleAPICalledParams {
  type: string;
  args: CdpRemoteObject[];
  timestamp: number;
  stackTrace?: CdpRawStackTrace;
}

interface CdpExceptionThrownParams {
  timestamp: number;
  exceptionDetails?: {
    text?: string;
    exception?: CdpRemoteObject;
    stackTrace?: CdpRawStackTrace;
    url?: string;
    lineNumber?: number;
    columnNumber?: number;
  };
}

interface CdpLogEntryAddedParams {
  entry?: {
    level?: string;
    text?: string;
    timestamp?: number;
    url?: string;
    lineNumber?: number;
    stackTrace?: CdpRawStackTrace;
  };
}

interface CdpScriptParsedParams {
  url: string;
  sourceMapURL?: string;
}

interface CdpAttachedToTargetParams {
  sessionId: string;
  targetInfo?: {
    type?: string;
    url?: string;
  };
  waitingForDebugger?: boolean;
}

interface CdpDetachedFromTargetParams {
  sessionId: string;
}

interface CdpRemoteObject {
  type: string;
  subtype?: string;
  value?: unknown;
  description?: string;
  className?: string;
  preview?: CdpObjectPreview;
}

interface CdpObjectPreview {
  type: string;
  subtype?: string;
  description?: string;
  overflow?: boolean;
  properties?: CdpPropertyPreview[];
  entries?: CdpEntryPreview[];
}

interface CdpPropertyPreview {
  name: string;
  type: string;
  value?: string;
  subtype?: string;
  valuePreview?: CdpObjectPreview;
}

interface CdpEntryPreview {
  key?: CdpObjectPreview;
  value: CdpObjectPreview;
}

interface CdpRawStackTrace {
  callFrames: { functionName: string; url: string; lineNumber: number; columnNumber: number }[];
  parent?: CdpRawStackTrace;
  description?: string;
}

export class CdpManager {
  #tabId: number | null = null;
  #pendingRequests = new Map<string, PendingNetworkRequest>();
  #pendingWebSockets = new Map<string, PendingWebSocket>();
  #responseBodyFetches = new Map<string, Promise<void>>();
  #pendingRequestExtraInfo = new Map<string, Record<string, string>>();
  #pendingResponseExtraInfo = new Map<string, { headers?: Record<string, string>; statusCode?: number }>();
  #pendingEarlyHints = new Map<string, Record<string, string>>();
  #pendingServedFromCache = new Set<string>();
  #attachedSessions = new Set<string>();
  #storage: StorageManager;
  #attached = false;
  #boundEventHandler: (source: chrome.debugger.Debuggee, method: string, params?: object) => void;
  #boundDetachHandler: (source: chrome.debugger.Debuggee, reason: string) => void;
  #sourceMapResolver = new SourceMapResolver();
  #sourceMapFetches = new Set<Promise<void>>();
  #isPaused = false;

  constructor(storage: StorageManager) {
    this.#storage = storage;
    this.#boundEventHandler = this.#handleDebuggerEvent.bind(this);
    this.#boundDetachHandler = this.#handleDetach.bind(this);
  }

  get sourceMapResolver(): SourceMapResolver {
    return this.#sourceMapResolver;
  }

  async flushSourceMaps(): Promise<void> {
    await Promise.allSettled(Array.from(this.#sourceMapFetches));
  }

  releaseSourceMaps(): void {
    this.#sourceMapFetches.clear();
    this.#sourceMapResolver.clear();
  }

  async attach(tabId: number): Promise<void> {
    this.#tabId = tabId;
    this.#pendingRequests.clear();
    this.#pendingWebSockets.clear();
    this.#responseBodyFetches.clear();
    this.#pendingRequestExtraInfo.clear();
    this.#pendingResponseExtraInfo.clear();
    this.#pendingEarlyHints.clear();
    this.#pendingServedFromCache.clear();
    this.#attachedSessions.clear();
    this.#sourceMapResolver.clear();
    this.#sourceMapFetches.clear();
    this.#isPaused = false;

    await chrome.debugger.attach({ tabId }, "1.3");
    this.#attached = true;

    chrome.debugger.onEvent.addListener(this.#boundEventHandler);
    chrome.debugger.onDetach.addListener(this.#boundDetachHandler);

    await this.#enableDomains();
    await this.#configureAutoAttach();
  }

  async detach(): Promise<void> {
    chrome.debugger.onEvent.removeListener(this.#boundEventHandler);
    chrome.debugger.onDetach.removeListener(this.#boundDetachHandler);

    if (this.#attached && this.#tabId) {
      try {
        await chrome.debugger.detach({ tabId: this.#tabId });
      } catch {
        // Already detached
      }
    }

    await Promise.allSettled(Array.from(this.#responseBodyFetches.values()));
    for (const key of Array.from(this.#pendingRequests.keys())) {
      this.#finalizePendingRequest(key);
    }
    this.#responseBodyFetches.clear();
    this.#pendingRequestExtraInfo.clear();
    this.#pendingResponseExtraInfo.clear();
    this.#pendingEarlyHints.clear();
    this.#pendingServedFromCache.clear();

    for (const [, ws] of this.#pendingWebSockets) {
      this.#storage.addWebSocketEntry(ws.entry);
    }
    this.#pendingWebSockets.clear();
    this.#attachedSessions.clear();

    this.#attached = false;
    this.#isPaused = false;
  }

  setPaused(isPaused: boolean): void {
    this.#isPaused = isPaused;
  }

  #handleDetach(source: chrome.debugger.Debuggee, _reason: string): void {
    if (source.tabId === this.#tabId) {
      this.#attached = false;
      chrome.debugger.onEvent.removeListener(this.#boundEventHandler);
      chrome.debugger.onDetach.removeListener(this.#boundDetachHandler);
    }
  }

  #handleDebuggerEvent(source: chrome.debugger.Debuggee, method: string, params?: object): void {
    if (source.tabId !== this.#tabId) return;

    switch (method) {
      case "Target.attachedToTarget":
        void this.#onAttachedToTarget(params as CdpAttachedToTargetParams);
        break;
      case "Target.detachedFromTarget":
        this.#onDetachedFromTarget(params as CdpDetachedFromTargetParams);
        break;
      case "Network.requestWillBeSent":
        this.#onRequestWillBeSent(source, params as CdpRequestWillBeSentParams);
        break;
      case "Network.requestWillBeSentExtraInfo":
        this.#onRequestWillBeSentExtraInfo(source, params as CdpRequestWillBeSentExtraInfoParams);
        break;
      case "Network.responseReceived":
        this.#onResponseReceived(source, params as CdpResponseReceivedParams);
        break;
      case "Network.responseReceivedExtraInfo":
        this.#onResponseReceivedExtraInfo(source, params as CdpResponseReceivedExtraInfoParams);
        break;
      case "Network.responseReceivedEarlyHints":
        this.#onResponseReceivedEarlyHints(source, params as CdpResponseReceivedEarlyHintsParams);
        break;
      case "Network.requestServedFromCache":
        this.#onRequestServedFromCache(source, params as CdpRequestServedFromCacheParams);
        break;
      case "Network.loadingFinished":
        this.#onLoadingFinished(source, params as CdpLoadingFinishedParams);
        break;
      case "Network.loadingFailed":
        this.#onLoadingFailed(source, params as CdpLoadingFailedParams);
        break;
      case "Network.webSocketCreated":
        this.#onWebSocketCreated(source, params as CdpWebSocketCreatedParams);
        break;
      case "Network.webSocketFrameSent":
        this.#onWebSocketFrameSent(source, params as CdpWebSocketFrameParams);
        break;
      case "Network.webSocketFrameReceived":
        this.#onWebSocketFrameReceived(source, params as CdpWebSocketFrameParams);
        break;
      case "Network.webSocketClosed":
        this.#onWebSocketClosed(source, params as CdpWebSocketClosedParams);
        break;
      case "Runtime.consoleAPICalled":
        this.#onConsoleAPICalled(params as CdpConsoleAPICalledParams);
        break;
      case "Runtime.exceptionThrown":
        this.#onExceptionThrown(params as CdpExceptionThrownParams);
        break;
      case "Log.entryAdded":
        this.#onLogEntryAdded(params as CdpLogEntryAddedParams);
        break;
      case "Debugger.scriptParsed":
        this.#onScriptParsed(source, params as CdpScriptParsedParams);
        break;
      case "Debugger.paused":
        void this.#sendCommand(source, "Debugger.resume").catch(() => {});
        break;
    }
  }

  // ════════════════════════════════════════════
  // Network handlers
  // ════════════════════════════════════════════

  async #onAttachedToTarget(params: CdpAttachedToTargetParams): Promise<void> {
    if (!params.sessionId || this.#attachedSessions.has(params.sessionId)) {
      return;
    }

    this.#attachedSessions.add(params.sessionId);

    try {
      await this.#enableDomains(params.sessionId);
      await this.#configureAutoAttach(params.sessionId);
      if (params.waitingForDebugger) {
        await this.#sendCommand(this.#getDebuggee(params.sessionId), "Runtime.runIfWaitingForDebugger");
      }
    } catch {
      // Ignore child target setup failures and continue recording on the main target.
    }
  }

  #onDetachedFromTarget(params: CdpDetachedFromTargetParams): void {
    if (!params.sessionId) return;
    this.#attachedSessions.delete(params.sessionId);
    const prefix = `${params.sessionId}:`;
    for (const key of Array.from(this.#pendingRequests.keys())) {
      if (key.startsWith(prefix) && !this.#responseBodyFetches.has(key)) {
        this.#finalizePendingRequest(key);
      }
    }
    for (const key of Array.from(this.#pendingWebSockets.keys())) {
      if (key.startsWith(prefix)) {
        const pending = this.#pendingWebSockets.get(key);
        if (pending) {
          this.#storage.addWebSocketEntry(pending.entry);
        }
        this.#pendingWebSockets.delete(key);
      }
    }
    this.#pruneMetadataForPrefix(prefix);
  }

  #onRequestWillBeSent(source: chrome.debugger.Debuggee, params: CdpRequestWillBeSentParams): void {
    if (this.#isPaused) {
      return;
    }
    const key = this.#requestKey(source, params.requestId);
    if (params.redirectResponse) {
      const existing = this.#pendingRequests.get(key);
      if (existing) {
        if (!existing.entry.redirectChain) existing.entry.redirectChain = [];
        existing.entry.redirectChain.push({
          url: existing.entry.url,
          status: params.redirectResponse.status,
          statusText: params.redirectResponse.statusText,
          headers: params.redirectResponse.headers,
        });
        existing.entry.url = params.request.url;
        existing.entry.method = params.request.method;
        existing.entry.requestHeaders = params.request.headers;
        existing.entry.postData = params.request.postData ?? null;
        existing.entry.timestamp = params.timestamp;
        existing.entry.wallTime = params.wallTime;
        this.#applyPendingRequestMetadata(key, existing.entry);
        return;
      }
    }

    const entry: NetworkEntry = {
      requestId: params.requestId,
      url: params.request.url,
      method: params.request.method,
      requestHeaders: params.request.headers,
      requestHeadersExtra: null,
      postData: params.request.postData ?? null,
      timestamp: params.timestamp,
      wallTime: params.wallTime,
      initiator: params.initiator,
      resourceType: params.type,
      status: null,
      statusText: null,
      responseHeaders: null,
      responseHeadersExtra: null,
      earlyHintsHeaders: null,
      mimeType: null,
      timing: null,
      protocol: null,
      remoteIPAddress: null,
      encodedDataLength: 0,
      error: null,
      responseBody: null,
      redirectChain: null,
      servedFromCache: false,
    };

    this.#applyPendingRequestMetadata(key, entry);
    this.#pendingRequests.set(key, { sessionId: this.#getSessionId(source), entry });

    if (params.request.hasPostData && !params.request.postData) {
      void this.#fetchPostData(source, params.requestId);
    }
  }

  #onRequestWillBeSentExtraInfo(source: chrome.debugger.Debuggee, params: CdpRequestWillBeSentExtraInfoParams): void {
    const key = this.#requestKey(source, params.requestId);
    if (params.headers) {
      const existing = this.#pendingRequests.get(key);
      if (existing) {
        existing.entry.requestHeadersExtra = params.headers;
      } else {
        this.#pendingRequestExtraInfo.set(key, params.headers);
      }
    }
  }

  async #fetchPostData(source: chrome.debugger.Debuggee, requestId: string): Promise<void> {
    try {
      const result = await this.#sendCommand(
        source,
        "Network.getRequestPostData",
        { requestId }
      ) as { postData?: string } | undefined;
      const entry = this.#pendingRequests.get(this.#requestKey(source, requestId));
      if (entry && result) {
        entry.entry.postData = result.postData ?? null;
      }
    } catch {
      // Request may have been completed already
    }
  }

  #onResponseReceived(source: chrome.debugger.Debuggee, params: CdpResponseReceivedParams): void {
    const entry = this.#pendingRequests.get(this.#requestKey(source, params.requestId));
    if (entry) {
      entry.entry.status = params.response.status;
      entry.entry.statusText = params.response.statusText;
      entry.entry.responseHeaders = params.response.headers;
      entry.entry.mimeType = params.response.mimeType;
      entry.entry.timing = params.response.timing ?? null;
      entry.entry.protocol = params.response.protocol ?? null;
      entry.entry.remoteIPAddress = params.response.remoteIPAddress ?? null;
    }
  }

  #onResponseReceivedExtraInfo(source: chrome.debugger.Debuggee, params: CdpResponseReceivedExtraInfoParams): void {
    const key = this.#requestKey(source, params.requestId);
    const existing = this.#pendingRequests.get(key);
    if (existing) {
      existing.entry.responseHeadersExtra = params.headers ?? null;
      if ((existing.entry.status == null || existing.entry.status === 0) && typeof params.statusCode === "number") {
        existing.entry.status = params.statusCode;
      }
    } else {
      this.#pendingResponseExtraInfo.set(key, {
        headers: params.headers,
        statusCode: params.statusCode,
      });
    }
  }

  #onResponseReceivedEarlyHints(source: chrome.debugger.Debuggee, params: CdpResponseReceivedEarlyHintsParams): void {
    const key = this.#requestKey(source, params.requestId);
    const existing = this.#pendingRequests.get(key);
    if (existing) {
      existing.entry.earlyHintsHeaders = params.headers ?? null;
    } else if (params.headers) {
      this.#pendingEarlyHints.set(key, params.headers);
    }
  }

  #onRequestServedFromCache(source: chrome.debugger.Debuggee, params: CdpRequestServedFromCacheParams): void {
    const key = this.#requestKey(source, params.requestId);
    const existing = this.#pendingRequests.get(key);
    if (existing) {
      existing.entry.servedFromCache = true;
    } else {
      this.#pendingServedFromCache.add(key);
    }
  }

  #onLoadingFinished(source: chrome.debugger.Debuggee, params: CdpLoadingFinishedParams): void {
    const key = this.#requestKey(source, params.requestId);
    const entry = this.#pendingRequests.get(key);
    if (entry) {
      entry.entry.encodedDataLength = params.encodedDataLength;

      if (this.#shouldFetchBody(entry.entry)) {
        const fetchPromise = this.#fetchResponseBody(source, params.requestId);
        this.#responseBodyFetches.set(key, fetchPromise);
        void fetchPromise.finally(() => {
          this.#responseBodyFetches.delete(key);
        });
      } else {
        this.#finalizePendingRequest(key);
      }
    }
  }

  #shouldFetchBody(entry: NetworkEntry): boolean {
    if (!entry.mimeType) return false;
    if (entry.encodedDataLength > 1024 * 1024) return false;

    const textTypes = [
      "text/",
      "application/json",
      "application/javascript",
      "application/x-javascript",
      "application/xml",
      "application/xhtml+xml",
      "application/manifest+json",
      "application/ld+json",
      "image/svg+xml",
    ];
    return textTypes.some((t) => entry.mimeType!.startsWith(t));
  }

  async #fetchResponseBody(source: chrome.debugger.Debuggee, requestId: string): Promise<void> {
    const key = this.#requestKey(source, requestId);
    const pending = this.#pendingRequests.get(key);
    if (!pending) return;

    try {
      const result = await this.#sendCommand(
        source,
        "Network.getResponseBody",
        { requestId }
      ) as { body?: string; base64Encoded?: boolean } | undefined;
      const latestPending = this.#pendingRequests.get(key);
      if (latestPending && result) {
        latestPending.entry.responseBody = {
          body: result.body ?? "",
          base64Encoded: result.base64Encoded ?? false,
        };
      }
    } catch {
      // Response body may have been evicted
    }
    this.#finalizePendingRequest(key);
  }

  #onLoadingFailed(source: chrome.debugger.Debuggee, params: CdpLoadingFailedParams): void {
    const key = this.#requestKey(source, params.requestId);
    const entry = this.#pendingRequests.get(key);
    if (entry) {
      entry.entry.error = params.errorText;
      entry.entry.canceled = params.canceled;
      this.#finalizePendingRequest(key);
    }
  }

  // ════════════════════════════════════════════
  // WebSocket handlers
  // ════════════════════════════════════════════

  #onWebSocketCreated(source: chrome.debugger.Debuggee, params: CdpWebSocketCreatedParams): void {
    if (this.#isPaused) {
      return;
    }
    this.#pendingWebSockets.set(this.#requestKey(source, params.requestId), {
      sessionId: this.#getSessionId(source),
      entry: {
        requestId: params.requestId,
        url: params.url,
        initiator: params.initiator,
        frames: [],
        closed: false,
      },
    });
  }

  #onWebSocketFrameSent(source: chrome.debugger.Debuggee, params: CdpWebSocketFrameParams): void {
    if (this.#isPaused) {
      return;
    }
    const ws = this.#pendingWebSockets.get(this.#requestKey(source, params.requestId));
    if (ws) {
      ws.entry.frames.push({
        direction: "sent",
        timestamp: params.timestamp,
        opcode: params.response.opcode,
        payloadData: params.response.payloadData,
      });
    }
  }

  #onWebSocketFrameReceived(source: chrome.debugger.Debuggee, params: CdpWebSocketFrameParams): void {
    if (this.#isPaused) {
      return;
    }
    const ws = this.#pendingWebSockets.get(this.#requestKey(source, params.requestId));
    if (ws) {
      ws.entry.frames.push({
        direction: "received",
        timestamp: params.timestamp,
        opcode: params.response.opcode,
        payloadData: params.response.payloadData,
      });
    }
  }

  #onWebSocketClosed(source: chrome.debugger.Debuggee, params: CdpWebSocketClosedParams): void {
    const ws = this.#pendingWebSockets.get(this.#requestKey(source, params.requestId));
    if (ws) {
      ws.entry.closed = true;
      if (!this.#isPaused) {
        this.#storage.addWebSocketEntry(ws.entry);
      }
      this.#pendingWebSockets.delete(this.#requestKey(source, params.requestId));
    }
  }

  // ════════════════════════════════════════════
  // Console / Runtime handlers
  // ════════════════════════════════════════════

  #onConsoleAPICalled(params: CdpConsoleAPICalledParams): void {
    if (this.#isPaused) {
      return;
    }
    const entry: ConsoleEntry = {
      source: "console-api",
      level: this.#mapConsoleType(params.type),
      timestamp: this.#toEpochMs(params.timestamp),
      args: (params.args || []).map((arg) => this.#serializeRemoteObject(arg)),
      stackTrace: this.#serializeStackTrace(params.stackTrace),
    };

    this.#storage.addConsoleEntry(entry);
  }

  #onExceptionThrown(params: CdpExceptionThrownParams): void {
    if (this.#isPaused) {
      return;
    }
    const details = params.exceptionDetails || {};
    const entry: ConsoleEntry = {
      source: "exception",
      level: "error",
      timestamp: this.#toEpochMs(params.timestamp),
      message: details.text || "Uncaught exception",
      args: details.exception
        ? [this.#serializeRemoteObject(details.exception)]
        : [],
      stackTrace: this.#serializeStackTrace(details.stackTrace),
      url: details.url,
      lineNumber: details.lineNumber,
      columnNumber: details.columnNumber,
    };

    this.#storage.addConsoleEntry(entry);
  }

  #onLogEntryAdded(params: CdpLogEntryAddedParams): void {
    if (this.#isPaused) {
      return;
    }
    const logEntry = params.entry || {};
    const entry: ConsoleEntry = {
      source: "browser",
      level: logEntry.level || "info",
      timestamp: this.#toEpochMs(logEntry.timestamp),
      message: logEntry.text || "",
      url: logEntry.url,
      lineNumber: logEntry.lineNumber,
      stackTrace: this.#serializeStackTrace(logEntry.stackTrace),
    };

    this.#storage.addConsoleEntry(entry);
  }

  // ════════════════════════════════════════════
  // Serialization helpers
  // ════════════════════════════════════════════

  #serializeRemoteObject(obj: CdpRemoteObject): SerializedRemoteObject {
    if (!obj) return { type: "undefined", value: undefined };

    const result: SerializedRemoteObject = {
      type: obj.type,
      subtype: obj.subtype || undefined,
      value: obj.value,
      description: obj.description || undefined,
      className: obj.className || undefined,
    };

    if (obj.preview) {
      result.preview = this.#serializePreview(obj.preview);
    }

    return result;
  }

  #serializePreview(preview: CdpObjectPreview): ObjectPreview | undefined {
    if (!preview) return undefined;
    return {
      type: preview.type,
      subtype: preview.subtype,
      description: preview.description,
      overflow: preview.overflow,
      properties: (preview.properties || []).map((p) => ({
        name: p.name,
        type: p.type,
        value: p.value,
        subtype: p.subtype || undefined,
        valuePreview: p.valuePreview
          ? this.#serializePreview(p.valuePreview)
          : undefined,
      })),
      entries: preview.entries
        ? preview.entries.map((e) => ({
            key: e.key ? this.#serializePreview(e.key) : undefined,
            value: this.#serializePreview(e.value)!,
          }))
        : undefined,
    };
  }

  #serializeStackTrace(stackTrace: CdpRawStackTrace | undefined): StackFrame[] | undefined {
    if (!stackTrace) return undefined;

    const frames: StackFrame[] = (stackTrace.callFrames || []).map((f) => ({
      functionName: f.functionName || "(anonymous)",
      url: f.url,
      lineNumber: f.lineNumber,
      columnNumber: f.columnNumber,
    }));

    if (stackTrace.parent) {
      const parentDesc = stackTrace.parent.description;
      const parentFrames = this.#serializeStackTrace(stackTrace.parent);
      if (parentFrames && parentFrames.length > 0) {
        frames.push({ asyncBoundary: parentDesc || "async", functionName: "", url: "", lineNumber: 0, columnNumber: 0 });
        frames.push(...parentFrames);
      }
    }

    return frames;
  }

  // ════════════════════════════════════════════
  // Sourcemap collection
  // ════════════════════════════════════════════

  #onScriptParsed(source: chrome.debugger.Debuggee, params: CdpScriptParsedParams): void {
    if (params.sourceMapURL && params.url) {
      const promise = this.#trackSourceMapFetch(
        this.#fetchAndRegisterSourceMap(source, params.url, params.sourceMapURL),
      );
      this.#sourceMapFetches.add(promise);
    }
  }

  #trackSourceMapFetch(promise: Promise<void>): Promise<void> {
    promise.finally(() => {
      this.#sourceMapFetches.delete(promise);
    });
    return promise;
  }

  async #fetchAndRegisterSourceMap(
    source: chrome.debugger.Debuggee,
    scriptUrl: string,
    sourceMapURL: string,
  ): Promise<void> {
    try {
      const resolvedUrl = this.#resolveSourceMapUrl(sourceMapURL, scriptUrl);
      const content = await this.#fetchSourceMapContent(source, resolvedUrl);
      if (content) {
        const raw = JSON.parse(content);
        this.#sourceMapResolver.addMap(scriptUrl, raw);
      }
    } catch {
      // Ignore sourcemap failures
    }
  }

  #resolveSourceMapUrl(sourceMapURL: string, scriptUrl: string): string {
    if (sourceMapURL.startsWith("data:")) return sourceMapURL;
    try {
      return new URL(sourceMapURL, scriptUrl).href;
    } catch {
      return sourceMapURL;
    }
  }

  async #fetchSourceMapContent(source: chrome.debugger.Debuggee, url: string): Promise<string | null> {
    if (url.startsWith("data:")) {
      const commaIdx = url.indexOf(",");
      if (commaIdx < 0) return null;
      const meta = url.slice(5, commaIdx);
      const data = url.slice(commaIdx + 1);
      return meta.includes("base64") ? atob(data) : decodeURIComponent(data);
    }

    if (!this.#attached || !this.#tabId) return null;
    try {
      const maxSize = 5 * 1024 * 1024;
      const result = await this.#sendCommand(
        source,
        "Runtime.evaluate",
        {
          expression: `fetch(${JSON.stringify(url)}).then(r=>r.ok?r.text():null).then(t=>t&&t.length<=${maxSize}?t:null).catch(()=>null)`,
          awaitPromise: true,
          returnByValue: true,
        }
      ) as { result?: { value?: string } } | undefined;
      return result?.result?.value || null;
    } catch {
      return null;
    }
  }

  #toEpochMs(ts: number | undefined): number {
    if (!ts) return Date.now();
    return ts < 1e11 ? ts * 1000 : ts;
  }

  #mapConsoleType(type: string): string {
    const map: Record<string, string> = {
      log: "log",
      verbose: "debug",
      debug: "debug",
      info: "info",
      warning: "warn",
      error: "error",
      dir: "log",
      dirxml: "log",
      table: "log",
      trace: "log",
      clear: "log",
      startGroup: "log",
      startGroupCollapsed: "log",
      endGroup: "log",
      assert: "error",
      count: "log",
      countReset: "log",
      timeLog: "log",
      timeEnd: "log",
      profile: "info",
      profileEnd: "info",
    };
    return map[type] || "log";
  }

  #requestKey(source: chrome.debugger.Debuggee, requestId: string): string {
    return `${this.#getSessionId(source) || "root"}:${requestId}`;
  }

  #getSessionId(source: chrome.debugger.Debuggee): string | undefined {
    return (source as chrome.debugger.Debuggee & { sessionId?: string }).sessionId;
  }

  async #enableDomains(sessionId?: string): Promise<void> {
    const target = this.#getDebuggee(sessionId);
    await Promise.all([
      this.#sendCommand(target, "Network.enable", {
        maxPostDataSize: 65536,
      }),
      this.#sendCommand(target, "Runtime.enable", {
        generatePreviews: true,
      }),
      this.#sendCommand(target, "Log.enable"),
    ]);

    try {
      await this.#sendCommand(target, "Debugger.enable");
      await this.#sendCommand(target, "Debugger.setAsyncCallStackDepth", {
        maxDepth: 32,
      });
    } catch {
      // Debugger domain failed — async stacks won't be available
    }
  }

  async #configureAutoAttach(sessionId?: string): Promise<void> {
    await this.#sendCommand(this.#getDebuggee(sessionId), "Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    }).catch(() => {});
  }

  #applyPendingRequestMetadata(key: string, entry: NetworkEntry): void {
    const requestHeadersExtra = this.#pendingRequestExtraInfo.get(key);
    if (requestHeadersExtra) {
      entry.requestHeadersExtra = requestHeadersExtra;
      this.#pendingRequestExtraInfo.delete(key);
    }

    const responseExtra = this.#pendingResponseExtraInfo.get(key);
    if (responseExtra) {
      entry.responseHeadersExtra = responseExtra.headers ?? null;
      if ((entry.status == null || entry.status === 0) && typeof responseExtra.statusCode === "number") {
        entry.status = responseExtra.statusCode;
      }
      this.#pendingResponseExtraInfo.delete(key);
    }

    const earlyHints = this.#pendingEarlyHints.get(key);
    if (earlyHints) {
      entry.earlyHintsHeaders = earlyHints;
      this.#pendingEarlyHints.delete(key);
    }

    if (this.#pendingServedFromCache.has(key)) {
      entry.servedFromCache = true;
      this.#pendingServedFromCache.delete(key);
    }
  }

  #finalizePendingRequest(key: string): void {
    const pending = this.#pendingRequests.get(key);
    if (!pending) return;
    this.#applyPendingRequestMetadata(key, pending.entry);
    this.#storage.addNetworkEntry(pending.entry);
    this.#pendingRequests.delete(key);
  }

  #pruneMetadataForPrefix(prefix: string): void {
    for (const key of Array.from(this.#pendingRequestExtraInfo.keys())) {
      if (key.startsWith(prefix) && !this.#pendingRequests.has(key)) {
        this.#pendingRequestExtraInfo.delete(key);
      }
    }
    for (const key of Array.from(this.#pendingResponseExtraInfo.keys())) {
      if (key.startsWith(prefix) && !this.#pendingRequests.has(key)) {
        this.#pendingResponseExtraInfo.delete(key);
      }
    }
    for (const key of Array.from(this.#pendingEarlyHints.keys())) {
      if (key.startsWith(prefix) && !this.#pendingRequests.has(key)) {
        this.#pendingEarlyHints.delete(key);
      }
    }
    for (const key of Array.from(this.#pendingServedFromCache)) {
      if (key.startsWith(prefix) && !this.#pendingRequests.has(key)) {
        this.#pendingServedFromCache.delete(key);
      }
    }
  }

  #getDebuggee(sessionId?: string): chrome.debugger.Debuggee {
    if (!this.#tabId) {
      throw new Error("Debugger is not attached");
    }
    return sessionId
      ? ({ tabId: this.#tabId, sessionId } as chrome.debugger.Debuggee)
      : { tabId: this.#tabId };
  }

  async #sendCommand(
    target: chrome.debugger.Debuggee,
    method: string,
    commandParams?: object,
  ): Promise<object | undefined> {
    return chrome.debugger.sendCommand(target, method, commandParams);
  }
}

interface PendingNetworkRequest {
  sessionId?: string;
  entry: NetworkEntry;
}

interface PendingWebSocket {
  sessionId?: string;
  entry: WebSocketEntry;
}
