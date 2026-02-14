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

interface CdpLoadingFinishedParams {
  requestId: string;
  encodedDataLength: number;
}

interface CdpLoadingFailedParams {
  requestId: string;
  errorText: string;
  canceled?: boolean;
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
  #pendingRequests = new Map<string, NetworkEntry>();
  #pendingWebSockets = new Map<string, WebSocketEntry>();
  #storage: StorageManager;
  #attached = false;
  #boundEventHandler: (source: chrome.debugger.Debuggee, method: string, params?: object) => void;
  #boundDetachHandler: (source: chrome.debugger.Debuggee, reason: string) => void;
  #sourceMapResolver = new SourceMapResolver();
  #sourceMapFetches: Promise<void>[] = [];

  constructor(storage: StorageManager) {
    this.#storage = storage;
    this.#boundEventHandler = this.#handleDebuggerEvent.bind(this);
    this.#boundDetachHandler = this.#handleDetach.bind(this);
  }

  get sourceMapResolver(): SourceMapResolver {
    return this.#sourceMapResolver;
  }

  async flushSourceMaps(): Promise<void> {
    await Promise.allSettled(this.#sourceMapFetches);
    this.#sourceMapFetches = [];
  }

  async attach(tabId: number): Promise<void> {
    this.#tabId = tabId;
    this.#pendingRequests.clear();
    this.#pendingWebSockets.clear();
    this.#sourceMapResolver.clear();
    this.#sourceMapFetches = [];

    await chrome.debugger.attach({ tabId }, "1.3");
    this.#attached = true;

    chrome.debugger.onEvent.addListener(this.#boundEventHandler);
    chrome.debugger.onDetach.addListener(this.#boundDetachHandler);

    await Promise.all([
      chrome.debugger.sendCommand({ tabId }, "Network.enable", {
        maxPostDataSize: 65536,
      }),
      chrome.debugger.sendCommand({ tabId }, "Runtime.enable", {
        generatePreviews: true,
      }),
      chrome.debugger.sendCommand({ tabId }, "Log.enable"),
    ]);

    try {
      await chrome.debugger.sendCommand({ tabId }, "Debugger.enable");
      await chrome.debugger.sendCommand({ tabId }, "Debugger.setAsyncCallStackDepth", {
        maxDepth: 32,
      });
    } catch {
      // Debugger domain failed — async stacks won't be available
    }
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

    for (const [, entry] of this.#pendingRequests) {
      this.#storage.addNetworkEntry(entry);
    }
    this.#pendingRequests.clear();

    for (const [, ws] of this.#pendingWebSockets) {
      this.#storage.addWebSocketEntry(ws);
    }
    this.#pendingWebSockets.clear();

    this.#attached = false;
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
      case "Network.requestWillBeSent":
        this.#onRequestWillBeSent(params as CdpRequestWillBeSentParams);
        break;
      case "Network.responseReceived":
        this.#onResponseReceived(params as CdpResponseReceivedParams);
        break;
      case "Network.loadingFinished":
        this.#onLoadingFinished(source, params as CdpLoadingFinishedParams);
        break;
      case "Network.loadingFailed":
        this.#onLoadingFailed(params as CdpLoadingFailedParams);
        break;
      case "Network.webSocketCreated":
        this.#onWebSocketCreated(params as CdpWebSocketCreatedParams);
        break;
      case "Network.webSocketFrameSent":
        this.#onWebSocketFrameSent(params as CdpWebSocketFrameParams);
        break;
      case "Network.webSocketFrameReceived":
        this.#onWebSocketFrameReceived(params as CdpWebSocketFrameParams);
        break;
      case "Network.webSocketClosed":
        this.#onWebSocketClosed(params as CdpWebSocketClosedParams);
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
        this.#onScriptParsed(params as CdpScriptParsedParams);
        break;
      case "Debugger.paused":
        chrome.debugger.sendCommand({ tabId: this.#tabId! }, "Debugger.resume").catch(() => {});
        break;
    }
  }

  // ════════════════════════════════════════════
  // Network handlers
  // ════════════════════════════════════════════

  #onRequestWillBeSent(params: CdpRequestWillBeSentParams): void {
    if (params.redirectResponse) {
      const existing = this.#pendingRequests.get(params.requestId);
      if (existing) {
        if (!existing.redirectChain) existing.redirectChain = [];
        existing.redirectChain.push({
          url: existing.url,
          status: params.redirectResponse.status,
          statusText: params.redirectResponse.statusText,
          headers: params.redirectResponse.headers,
        });
        existing.url = params.request.url;
        existing.method = params.request.method;
        existing.requestHeaders = params.request.headers;
        existing.postData = params.request.postData ?? null;
        existing.timestamp = params.timestamp;
        existing.wallTime = params.wallTime;
        return;
      }
    }

    const entry: NetworkEntry = {
      requestId: params.requestId,
      url: params.request.url,
      method: params.request.method,
      requestHeaders: params.request.headers,
      postData: params.request.postData ?? null,
      timestamp: params.timestamp,
      wallTime: params.wallTime,
      initiator: params.initiator,
      resourceType: params.type,
      status: null,
      statusText: null,
      responseHeaders: null,
      mimeType: null,
      timing: null,
      protocol: null,
      remoteIPAddress: null,
      encodedDataLength: 0,
      error: null,
      responseBody: null,
      redirectChain: null,
    };

    this.#pendingRequests.set(params.requestId, entry);

    if (params.request.hasPostData && !params.request.postData) {
      this.#fetchPostData(params.requestId);
    }
  }

  async #fetchPostData(requestId: string): Promise<void> {
    try {
      const result = await chrome.debugger.sendCommand(
        { tabId: this.#tabId! },
        "Network.getRequestPostData",
        { requestId }
      ) as { postData?: string } | undefined;
      const entry = this.#pendingRequests.get(requestId);
      if (entry && result) {
        entry.postData = result.postData ?? null;
      }
    } catch {
      // Request may have been completed already
    }
  }

  #onResponseReceived(params: CdpResponseReceivedParams): void {
    const entry = this.#pendingRequests.get(params.requestId);
    if (entry) {
      entry.status = params.response.status;
      entry.statusText = params.response.statusText;
      entry.responseHeaders = params.response.headers;
      entry.mimeType = params.response.mimeType;
      entry.timing = params.response.timing ?? null;
      entry.protocol = params.response.protocol ?? null;
      entry.remoteIPAddress = params.response.remoteIPAddress ?? null;
    }
  }

  #onLoadingFinished(source: chrome.debugger.Debuggee, params: CdpLoadingFinishedParams): void {
    const entry = this.#pendingRequests.get(params.requestId);
    if (entry) {
      entry.encodedDataLength = params.encodedDataLength;

      if (this.#shouldFetchBody(entry)) {
        this.#fetchResponseBody(source, params.requestId, entry);
      } else {
        this.#storage.addNetworkEntry(entry);
        this.#pendingRequests.delete(params.requestId);
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

  async #fetchResponseBody(_source: chrome.debugger.Debuggee, requestId: string, entry: NetworkEntry): Promise<void> {
    try {
      const result = await chrome.debugger.sendCommand(
        { tabId: this.#tabId! },
        "Network.getResponseBody",
        { requestId }
      ) as { body?: string; base64Encoded?: boolean } | undefined;
      if (result) {
        entry.responseBody = {
          body: result.body ?? "",
          base64Encoded: result.base64Encoded ?? false,
        };
      }
    } catch {
      // Response body may have been evicted
    }
    this.#storage.addNetworkEntry(entry);
    this.#pendingRequests.delete(requestId);
  }

  #onLoadingFailed(params: CdpLoadingFailedParams): void {
    const entry = this.#pendingRequests.get(params.requestId);
    if (entry) {
      entry.error = params.errorText;
      entry.canceled = params.canceled;
      this.#storage.addNetworkEntry(entry);
      this.#pendingRequests.delete(params.requestId);
    }
  }

  // ════════════════════════════════════════════
  // WebSocket handlers
  // ════════════════════════════════════════════

  #onWebSocketCreated(params: CdpWebSocketCreatedParams): void {
    this.#pendingWebSockets.set(params.requestId, {
      requestId: params.requestId,
      url: params.url,
      initiator: params.initiator,
      frames: [],
      closed: false,
    });
  }

  #onWebSocketFrameSent(params: CdpWebSocketFrameParams): void {
    const ws = this.#pendingWebSockets.get(params.requestId);
    if (ws) {
      ws.frames.push({
        direction: "sent",
        timestamp: params.timestamp,
        opcode: params.response.opcode,
        payloadData: params.response.payloadData,
      });
    }
  }

  #onWebSocketFrameReceived(params: CdpWebSocketFrameParams): void {
    const ws = this.#pendingWebSockets.get(params.requestId);
    if (ws) {
      ws.frames.push({
        direction: "received",
        timestamp: params.timestamp,
        opcode: params.response.opcode,
        payloadData: params.response.payloadData,
      });
    }
  }

  #onWebSocketClosed(params: CdpWebSocketClosedParams): void {
    const ws = this.#pendingWebSockets.get(params.requestId);
    if (ws) {
      ws.closed = true;
      this.#storage.addWebSocketEntry(ws);
      this.#pendingWebSockets.delete(params.requestId);
    }
  }

  // ════════════════════════════════════════════
  // Console / Runtime handlers
  // ════════════════════════════════════════════

  #onConsoleAPICalled(params: CdpConsoleAPICalledParams): void {
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

  #onScriptParsed(params: CdpScriptParsedParams): void {
    if (params.sourceMapURL && params.url) {
      const promise = this.#fetchAndRegisterSourceMap(params.url, params.sourceMapURL);
      this.#sourceMapFetches.push(promise);
    }
  }

  async #fetchAndRegisterSourceMap(scriptUrl: string, sourceMapURL: string): Promise<void> {
    try {
      const resolvedUrl = this.#resolveSourceMapUrl(sourceMapURL, scriptUrl);
      const content = await this.#fetchSourceMapContent(resolvedUrl);
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

  async #fetchSourceMapContent(url: string): Promise<string | null> {
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
      const result = await chrome.debugger.sendCommand(
        { tabId: this.#tabId },
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
      timeEnd: "log",
    };
    return map[type] || "log";
  }
}
