/**
 * Captures Chrome Debugger Protocol events for recording replay artifacts.
 */

import { coerceEpochMs } from "../../packages/replay-core/src/time";
import {
  drainBodyFetchesThenDetach,
  shouldFetchResponseBodyForEntry,
} from "../shared/network-response-body";
import {
  getPrivacyProfileSettings,
  REDACTED_VALUE,
  redactBodyText,
  redactHeaderMap,
  redactUrl,
} from "../shared/privacy-redaction";
import type {
  HeaderCaptureMode,
  PrivacyRedactionSettings,
  UploadSettings,
} from "../types/messages";
import type {
  ConsoleEntry,
  NetworkEntry,
  NetworkInitiator,
  ObjectPreview,
  RedactionHit,
  SerializedRemoteObject,
  SourceMapDiagnostic,
  StackFrame,
  WebSocketEntry,
} from "../types/recording";
import { CdpStorageSnapshotCollector } from "./cdp-storage-snapshot";
import { monotonicSecondsToEpochMs, wallClockOffsetFromNetworkPair } from "./network-clock";
import { SourceMapResolver } from "./sourcemap-resolver";
import type { StorageManager } from "./storage-manager";

/**
 * Chrome Debugger Protocol collector.
 *
 * CdpManager attaches to the active tab, mirrors relevant CDP domains across
 * child targets, buffers in-flight network/WebSocket state until complete, and
 * sends finalized entries to StorageManager. Event ordering is intentionally
 * defensive because CDP extra-info, body fetches, redirects, and target detach
 * notifications can arrive out of the simple request lifecycle order.
 */

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
  initiator: {
    type?: string;
    url?: string;
    lineNumber?: number;
    columnNumber?: number;
    stack?: CdpRawStackTrace;
  };
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
  type?: string;
  response: {
    url?: string;
    status: number;
    statusText: string;
    headers: Record<string, string>;
    mimeType: string;
    timing?: {
      dnsStart: number;
      dnsEnd: number;
      connectStart: number;
      connectEnd: number;
      sslStart: number;
      sslEnd: number;
      sendStart: number;
      sendEnd: number;
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
  initiator?: {
    type?: string;
    url?: string;
    lineNumber?: number;
    columnNumber?: number;
    stack?: CdpRawStackTrace;
  };
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

interface CdpExecutionContextCreatedParams {
  context?: {
    id?: number;
    auxData?: {
      frameId?: string;
    };
  };
}

interface CdpScriptParsedParams {
  executionContextId?: number;
  url: string;
  sourceMapURL?: string;
  executionContextAuxData?: {
    frameId?: string;
  };
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

interface CdpLoadNetworkResourceResult {
  resource?: {
    success?: boolean;
    stream?: string;
    httpStatusCode?: number;
    netError?: number;
    netErrorName?: string;
  };
}

interface CdpIoReadResult {
  data?: string;
  base64Encoded?: boolean;
  eof?: boolean;
}

interface CdpRemoteObject {
  type: string;
  subtype?: string;
  value?: unknown;
  description?: string;
  className?: string;
  objectId?: string;
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

interface CdpPropertyDescriptor {
  name: string;
  value?: CdpRemoteObject;
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

interface SourceMapLoadAttempt {
  source: chrome.debugger.Debuggee;
  scriptUrl: string;
  sourceMapURL: string;
  resolvedUrl: string;
  sessionId?: string;
  executionContextId?: number;
  frameId?: string;
  diagnostic: SourceMapDiagnostic;
}

type RuntimeCaptureSettings = Pick<
  UploadSettings,
  | "captureConsole"
  | "captureNetwork"
  | "captureRequestHeaders"
  | "captureResponseHeaders"
  | "captureRequestBodies"
  | "captureResponseBodyMode"
  | "maxResponseBodyBytes"
  | "captureRedirectHeaders"
  | "captureInitiator"
  | "suppressRecorderInternalRequests"
  | "captureWebSockets"
  | "captureWebSocketFrames"
  | "maxWebSocketFrameBytes"
  | "captureWebSocketInitiator"
  | "redactStorageValues"
  | "redactDomTextContent"
>;

const SOURCE_MAP_MAX_BYTES = 50 * 1024 * 1024;
const SOURCE_MAP_READ_CHUNK_BYTES = 1024 * 1024;
const SOURCE_MAP_DIAGNOSTIC_LIMIT = 500;
const SOURCE_MAP_RESOLVE_URL_PROPERTY = "__gnSourceMapResolveUrl";
const MAX_PARSED_ERROR_STACK_FRAMES = 80;
const MAX_CONSOLE_OBJECT_PROPERTIES = 12;
const MINIMAL_REQUEST_HEADERS = new Set([
  "accept",
  "content-type",
  "origin",
  "referer",
  "user-agent",
]);
const MINIMAL_RESPONSE_HEADERS = new Set([
  "cache-control",
  "content-type",
  "etag",
  "last-modified",
  "location",
]);

export class CdpManager {
  #tabId: number | null = null;
  #pendingRequests = new Map<string, PendingNetworkRequest>();
  #pendingWebSockets = new Map<string, PendingWebSocket>();
  #responseBodyFetches = new Map<string, Promise<void>>();
  #pendingRequestExtraInfo = new Map<string, Record<string, string>>();
  #pendingResponseExtraInfo = new Map<
    string,
    { headers?: Record<string, string>; statusCode?: number }
  >();
  #pendingEarlyHints = new Map<string, Record<string, string>>();
  #pendingServedFromCache = new Set<string>();
  #suppressedRequestKeys = new Set<string>();
  #attachedSessions = new Set<string>();
  #executionContextFrameIds = new Map<string, string>();
  #sessionTargetTypes = new Map<string, string>();
  #sourceMapResourceUrls = new Set<string>();
  #sourceMapDiagnostics: SourceMapDiagnostic[] = [];
  #pendingSourceMapAttempts = new Map<string, SourceMapLoadAttempt>();
  #storage: StorageManager;
  #attached = false;
  #boundEventHandler: (source: chrome.debugger.Debuggee, method: string, params?: object) => void;
  #boundDetachHandler: (source: chrome.debugger.Debuggee, reason: string) => void;
  #sourceMapResolver = new SourceMapResolver();
  #sourceMapFetches = new Set<Promise<void>>();
  #consoleCaptureQueue: Promise<void> = Promise.resolve();
  #consoleCaptureFetches = new Set<Promise<void>>();
  #privacySettings: PrivacyRedactionSettings = getPrivacyProfileSettings("standard");
  #recordRedactionHits: (hits: RedactionHit[]) => void = () => {};
  #storageSnapshot: CdpStorageSnapshotCollector;
  /**
   * wallTime_ms - monotonic_ms from Network.requestWillBeSent pairs. Used to
   * place WebSocket frame MonotonicTime timestamps on the wall-clock epoch so
   * Instant Replay rolling trim can keep in-window frames.
   */
  #networkWallClockOffsetMs: number | null = null;
  #captureSettings: RuntimeCaptureSettings = {
    captureConsole: true,
    captureNetwork: true,
    captureRequestHeaders: "full",
    captureResponseHeaders: "full",
    captureRequestBodies: true,
    captureResponseBodyMode: "eligible",
    maxResponseBodyBytes: null,
    captureRedirectHeaders: "location",
    captureInitiator: "summary",
    suppressRecorderInternalRequests: true,
    captureWebSockets: true,
    captureWebSocketFrames: true,
    maxWebSocketFrameBytes: null,
    captureWebSocketInitiator: false,
    redactStorageValues: true,
    redactDomTextContent: true,
  };

  constructor(storage: StorageManager) {
    this.#storage = storage;
    this.#storageSnapshot = new CdpStorageSnapshotCollector(storage);
    this.#boundEventHandler = this.#handleDebuggerEvent.bind(this);
    this.#boundDetachHandler = this.#handleDetach.bind(this);
  }

  get sourceMapResolver(): SourceMapResolver {
    return this.#sourceMapResolver;
  }

  getSourceMapDiagnostics(): SourceMapDiagnostic[] {
    return this.#sourceMapDiagnostics.map((diagnostic) => ({ ...diagnostic }));
  }

  /**
   * Returns the privacy limitations recorded while capturing storage snapshots
   * (e.g. a CDP query that failed and forced a partial snapshot). The
   * service-worker aggregates these into RecordingPrivacySummary.limitations.
   */
  getStorageLimitations(): string[] {
    return this.#storageSnapshot.getStorageLimitations();
  }

  async flushSourceMaps(): Promise<void> {
    this.#retryPendingSourceMapAttempts();
    await Promise.allSettled(Array.from(this.#sourceMapFetches));
    this.#retryPendingSourceMapAttempts();
    await Promise.allSettled(Array.from(this.#sourceMapFetches));
    this.#failPendingSourceMapAttempts();
  }

  releaseSourceMaps(): void {
    this.#sourceMapFetches.clear();
    this.#sourceMapResourceUrls.clear();
    this.#sourceMapResolver.clear();
    this.#sourceMapDiagnostics = [];
    this.#pendingSourceMapAttempts.clear();
    this.#sessionTargetTypes.clear();
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
    this.#suppressedRequestKeys.clear();
    this.#attachedSessions.clear();
    this.#executionContextFrameIds.clear();
    this.#sessionTargetTypes.clear();
    this.#networkWallClockOffsetMs = null;
    this.#sourceMapResourceUrls.clear();
    this.#sourceMapResolver.clear();
    this.#sourceMapFetches.clear();
    this.#consoleCaptureQueue = Promise.resolve();
    this.#consoleCaptureFetches.clear();
    this.#sourceMapDiagnostics = [];
    this.#pendingSourceMapAttempts.clear();
    this.#storageSnapshot.reset();

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

    // Console object properties also require the debugger. Preserve event order
    // by draining the serial capture queue before detaching the target.
    await Promise.allSettled(Array.from(this.#consoleCaptureFetches));

    // Body fetches need the debugger attached. Wait for them, finalize pending
    // entries into storage, then detach — never detach-first (that drops bodies).
    const tabId = this.#tabId;
    const shouldDetachDebugger = this.#attached && tabId != null;
    await drainBodyFetchesThenDetach({
      bodyFetches: this.#responseBodyFetches.values(),
      finalizePending: () => {
        for (const key of Array.from(this.#pendingRequests.keys())) {
          this.#finalizePendingRequest(key);
        }
      },
      detachDebugger: async () => {
        if (!shouldDetachDebugger || tabId == null) return;
        try {
          await chrome.debugger.detach({ tabId });
        } catch {
          // Already detached
        }
      },
    });

    this.#responseBodyFetches.clear();
    this.#pendingRequestExtraInfo.clear();
    this.#pendingResponseExtraInfo.clear();
    this.#pendingEarlyHints.clear();
    this.#pendingServedFromCache.clear();
    this.#suppressedRequestKeys.clear();
    this.#executionContextFrameIds.clear();
    this.#sourceMapResourceUrls.clear();
    this.#pendingSourceMapAttempts.clear();

    for (const [, ws] of this.#pendingWebSockets) {
      this.#storage.addWebSocketEntry(ws.entry);
    }
    this.#pendingWebSockets.clear();
    this.#attachedSessions.clear();
    this.#sessionTargetTypes.clear();

    this.#attached = false;
  }

  setCaptureSettings(settings: Partial<RuntimeCaptureSettings>): void {
    this.#captureSettings = {
      ...this.#captureSettings,
      ...settings,
      captureRequestBodies: Boolean(settings.captureRequestBodies),
      captureWebSocketFrames: Boolean(settings.captureWebSocketFrames),
      redactStorageValues:
        settings.redactStorageValues ?? this.#captureSettings.redactStorageValues,
      redactDomTextContent:
        settings.redactDomTextContent ?? this.#captureSettings.redactDomTextContent,
    };
    this.#storageSnapshot.setCaptureSettings({
      redactStorageValues: this.#captureSettings.redactStorageValues,
      redactDomTextContent: this.#captureSettings.redactDomTextContent,
    });
  }

  setPrivacySettings(
    settings: PrivacyRedactionSettings,
    recordRedactionHits?: (hits: RedactionHit[]) => void,
  ): void {
    this.#privacySettings = settings;
    this.#recordRedactionHits = recordRedactionHits || (() => {});
    this.#storageSnapshot.setPrivacySettings(settings, recordRedactionHits);
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
        this.#onConsoleAPICalled(source, params as CdpConsoleAPICalledParams);
        break;
      case "Runtime.executionContextCreated":
        this.#onExecutionContextCreated(source, params as CdpExecutionContextCreatedParams);
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
    this.#sessionTargetTypes.set(params.sessionId, params.targetInfo?.type || "unknown");

    try {
      await this.#enableDomains(params.sessionId);
      await this.#configureAutoAttach(params.sessionId);
    } catch {
      // Ignore child target setup failures and continue recording on the main target.
    } finally {
      // Always resume if we paused the child for domain enable (waitForDebuggerOnStart).
      if (params.waitingForDebugger) {
        await this.#sendCommand(
          this.#getDebuggee(params.sessionId),
          "Runtime.runIfWaitingForDebugger",
        ).catch(() => {});
      }
    }
  }

  #onDetachedFromTarget(params: CdpDetachedFromTargetParams): void {
    if (!params.sessionId) return;
    this.#attachedSessions.delete(params.sessionId);
    this.#sessionTargetTypes.delete(params.sessionId);
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
    for (const key of Array.from(this.#executionContextFrameIds.keys())) {
      if (key.startsWith(prefix)) {
        this.#executionContextFrameIds.delete(key);
      }
    }
    for (const key of Array.from(this.#pendingSourceMapAttempts.keys())) {
      if (key.startsWith(prefix)) {
        this.#pendingSourceMapAttempts.delete(key);
      }
    }
    this.#pruneMetadataForPrefix(prefix);
  }

  #onRequestWillBeSent(source: chrome.debugger.Debuggee, params: CdpRequestWillBeSentParams): void {
    const key = this.#requestKey(source, params.requestId);
    if (this.#shouldSuppressRecorderResource(params.request.url)) {
      this.#suppressedRequestKeys.add(key);
      return;
    }
    if (!this.#captureSettings.captureNetwork) {
      return;
    }
    if (params.redirectResponse) {
      const existing = this.#pendingRequests.get(key);
      if (existing) {
        if (!existing.entry.redirectChain) existing.entry.redirectChain = [];
        existing.entry.redirectChain.push({
          url: existing.entry.url,
          status: params.redirectResponse.status,
          statusText: params.redirectResponse.statusText,
          headers: this.#filterRedirectHeaders(params.redirectResponse.headers) || {},
        });
        existing.entry.url =
          this.#redactUrlValue(params.request.url, "url", "network.request.url") ||
          params.request.url;
        existing.entry.method = params.request.method;
        existing.entry.requestHeaders = this.#filterHeaders(
          params.request.headers,
          this.#captureSettings.captureRequestHeaders,
          "request",
        );
        existing.entry.postData = this.#captureSettings.captureRequestBodies
          ? this.#redactBodyValue(params.request.postData, "network.request.postData")
          : null;
        existing.entry.timestamp = params.timestamp;
        existing.entry.wallTime = params.wallTime;
        this.#noteNetworkWallClock(params.timestamp, params.wallTime);
        this.#applyPendingRequestMetadata(key, existing.entry);
        return;
      }
    }

    const entry: NetworkEntry = {
      requestId: params.requestId,
      url:
        this.#redactUrlValue(params.request.url, "url", "network.request.url") ||
        params.request.url,
      method: params.request.method,
      requestHeaders: this.#filterHeaders(
        params.request.headers,
        this.#captureSettings.captureRequestHeaders,
        "request",
      ),
      requestHeadersExtra: null,
      postData: this.#captureSettings.captureRequestBodies
        ? this.#redactBodyValue(params.request.postData, "network.request.postData")
        : null,
      timestamp: params.timestamp,
      wallTime: params.wallTime,
      initiator: this.#filterInitiator(params.initiator),
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

    this.#noteNetworkWallClock(params.timestamp, params.wallTime);
    this.#applyPendingRequestMetadata(key, entry);
    this.#pendingRequests.set(key, { sessionId: this.#getSessionId(source), entry });

    if (
      this.#captureSettings.captureRequestBodies &&
      params.request.hasPostData &&
      !params.request.postData
    ) {
      void this.#fetchPostData(source, params.requestId);
    }
  }

  #onRequestWillBeSentExtraInfo(
    source: chrome.debugger.Debuggee,
    params: CdpRequestWillBeSentExtraInfoParams,
  ): void {
    if (!this.#captureSettings.captureNetwork) return;
    const key = this.#requestKey(source, params.requestId);
    if (this.#suppressedRequestKeys.has(key)) return;
    if (params.headers) {
      const existing = this.#pendingRequests.get(key);
      const redactedHeaders =
        this.#filterHeaders(
          params.headers,
          this.#captureSettings.captureRequestHeaders,
          "request",
        ) || {};
      if (existing) {
        existing.entry.requestHeadersExtra = redactedHeaders;
      } else {
        this.#pendingRequestExtraInfo.set(key, redactedHeaders);
      }
    }
  }

  async #fetchPostData(source: chrome.debugger.Debuggee, requestId: string): Promise<void> {
    try {
      const result = (await this.#sendCommand(source, "Network.getRequestPostData", {
        requestId,
      })) as { postData?: string } | undefined;
      const entry = this.#pendingRequests.get(this.#requestKey(source, requestId));
      if (entry && result) {
        entry.entry.postData = this.#redactBodyValue(result.postData, "network.request.postData");
      }
    } catch {
      // Request may have been completed already
    }
  }

  #onResponseReceived(source: chrome.debugger.Debuggee, params: CdpResponseReceivedParams): void {
    if (!this.#captureSettings.captureNetwork) return;
    const entry = this.#pendingRequests.get(this.#requestKey(source, params.requestId));
    if (entry) {
      entry.entry.status = params.response.status;
      entry.entry.statusText = params.response.statusText;
      entry.entry.responseHeaders = this.#filterHeaders(
        params.response.headers,
        this.#captureSettings.captureResponseHeaders,
        "response",
      );
      entry.entry.mimeType = params.response.mimeType;
      entry.entry.timing = params.response.timing ?? null;
      entry.entry.protocol = params.response.protocol ?? null;
      entry.entry.remoteIPAddress = params.response.remoteIPAddress ?? null;
    }
  }

  #onResponseReceivedExtraInfo(
    source: chrome.debugger.Debuggee,
    params: CdpResponseReceivedExtraInfoParams,
  ): void {
    if (!this.#captureSettings.captureNetwork) return;
    const key = this.#requestKey(source, params.requestId);
    if (this.#suppressedRequestKeys.has(key)) return;
    const redactedHeaders = params.headers
      ? this.#filterHeaders(
          params.headers,
          this.#captureSettings.captureResponseHeaders,
          "response",
        ) || undefined
      : undefined;
    const existing = this.#pendingRequests.get(key);
    if (existing) {
      existing.entry.responseHeadersExtra = redactedHeaders ?? null;
      if (
        (existing.entry.status == null || existing.entry.status === 0) &&
        typeof params.statusCode === "number"
      ) {
        existing.entry.status = params.statusCode;
      }
    } else {
      this.#pendingResponseExtraInfo.set(key, {
        headers: redactedHeaders,
        statusCode: params.statusCode,
      });
    }
  }

  #onResponseReceivedEarlyHints(
    source: chrome.debugger.Debuggee,
    params: CdpResponseReceivedEarlyHintsParams,
  ): void {
    if (!this.#captureSettings.captureNetwork) return;
    const key = this.#requestKey(source, params.requestId);
    if (this.#suppressedRequestKeys.has(key)) return;
    const redactedHeaders = params.headers
      ? this.#filterHeaders(
          params.headers,
          this.#captureSettings.captureResponseHeaders,
          "response",
        ) || undefined
      : undefined;
    const existing = this.#pendingRequests.get(key);
    if (existing) {
      existing.entry.earlyHintsHeaders = redactedHeaders ?? null;
    } else if (redactedHeaders) {
      this.#pendingEarlyHints.set(key, redactedHeaders);
    }
  }

  #onRequestServedFromCache(
    source: chrome.debugger.Debuggee,
    params: CdpRequestServedFromCacheParams,
  ): void {
    if (!this.#captureSettings.captureNetwork) return;
    const key = this.#requestKey(source, params.requestId);
    if (this.#suppressedRequestKeys.has(key)) return;
    const existing = this.#pendingRequests.get(key);
    if (existing) {
      existing.entry.servedFromCache = true;
    } else {
      this.#pendingServedFromCache.add(key);
    }
  }

  #onLoadingFinished(source: chrome.debugger.Debuggee, params: CdpLoadingFinishedParams): void {
    if (!this.#captureSettings.captureNetwork) return;
    const key = this.#requestKey(source, params.requestId);
    if (this.#suppressedRequestKeys.has(key)) {
      this.#suppressedRequestKeys.delete(key);
      return;
    }
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
    return shouldFetchResponseBodyForEntry(
      this.#captureSettings.captureResponseBodyMode,
      entry,
      this.#captureSettings.maxResponseBodyBytes,
    );
  }

  async #fetchResponseBody(source: chrome.debugger.Debuggee, requestId: string): Promise<void> {
    const key = this.#requestKey(source, requestId);
    const pending = this.#pendingRequests.get(key);
    if (!pending) return;

    try {
      const result = (await this.#sendCommand(source, "Network.getResponseBody", { requestId })) as
        | { body?: string; base64Encoded?: boolean }
        | undefined;
      const latestPending = this.#pendingRequests.get(key);
      if (latestPending && result) {
        latestPending.entry.responseBody = {
          body: result.base64Encoded
            ? (result.body ?? "")
            : this.#redactBodyValue(result.body ?? "", "network.response.body", true) || "",
          base64Encoded: result.base64Encoded ?? false,
        };
      }
    } catch {
      // Response body may have been evicted
    }
    this.#finalizePendingRequest(key);
  }

  #onLoadingFailed(source: chrome.debugger.Debuggee, params: CdpLoadingFailedParams): void {
    if (!this.#captureSettings.captureNetwork) return;
    const key = this.#requestKey(source, params.requestId);
    if (this.#suppressedRequestKeys.has(key)) {
      this.#suppressedRequestKeys.delete(key);
      return;
    }
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
    if (!this.#captureSettings.captureWebSockets) return;
    this.#pendingWebSockets.set(this.#requestKey(source, params.requestId), {
      sessionId: this.#getSessionId(source),
      entry: {
        requestId: params.requestId,
        url: this.#redactUrlValue(params.url, "url", "websocket.url") || params.url,
        initiator: this.#captureSettings.captureWebSocketInitiator
          ? (this.#filterInitiator(params.initiator) ?? undefined)
          : undefined,
        frames: [],
        closed: false,
      },
      frameMonotonicSeconds: [],
    });
  }

  #onWebSocketFrameSent(source: chrome.debugger.Debuggee, params: CdpWebSocketFrameParams): void {
    if (!this.#captureSettings.captureWebSockets) return;
    const ws = this.#pendingWebSockets.get(this.#requestKey(source, params.requestId));
    if (ws) {
      const monotonicSeconds = params.timestamp;
      ws.entry.frames.push({
        direction: "sent",
        timestamp: this.#webSocketFrameEpochMs(monotonicSeconds),
        opcode: params.response.opcode,
        payloadData: this.#getWebSocketPayload(params.response.payloadData),
      });
      ws.frameMonotonicSeconds.push(monotonicSeconds ?? Number.NaN);
    }
  }

  #onWebSocketFrameReceived(
    source: chrome.debugger.Debuggee,
    params: CdpWebSocketFrameParams,
  ): void {
    if (!this.#captureSettings.captureWebSockets) return;
    const ws = this.#pendingWebSockets.get(this.#requestKey(source, params.requestId));
    if (ws) {
      const monotonicSeconds = params.timestamp;
      ws.entry.frames.push({
        direction: "received",
        timestamp: this.#webSocketFrameEpochMs(monotonicSeconds),
        opcode: params.response.opcode,
        payloadData: this.#getWebSocketPayload(params.response.payloadData),
      });
      ws.frameMonotonicSeconds.push(monotonicSeconds ?? Number.NaN);
    }
  }

  #onWebSocketClosed(source: chrome.debugger.Debuggee, params: CdpWebSocketClosedParams): void {
    if (!this.#captureSettings.captureWebSockets) return;
    const ws = this.#pendingWebSockets.get(this.#requestKey(source, params.requestId));
    if (ws) {
      ws.entry.closed = true;
      this.#storage.addWebSocketEntry(ws.entry);
      this.#pendingWebSockets.delete(this.#requestKey(source, params.requestId));
    }
  }

  #filterHeaders(
    headers: Record<string, string> | null | undefined,
    mode: HeaderCaptureMode,
    direction: "request" | "response",
  ): Record<string, string> | null {
    if (!headers || mode === "off") {
      return null;
    }
    const redaction = redactHeaderMap(headers, this.#privacySettings, "headers");
    this.#recordRedactionHits(redaction.applied);
    const redacted = redaction.value || {};
    if (mode === "full") {
      return redacted;
    }
    const allowed = direction === "request" ? MINIMAL_REQUEST_HEADERS : MINIMAL_RESPONSE_HEADERS;
    const filtered = Object.fromEntries(
      Object.entries(redacted).filter(([name]) => allowed.has(name.trim().toLowerCase())),
    );
    return Object.keys(filtered).length > 0 ? filtered : null;
  }

  #filterRedirectHeaders(
    headers: Record<string, string> | null | undefined,
  ): Record<string, string> | null {
    if (!headers || this.#captureSettings.captureRedirectHeaders === "off") {
      return null;
    }
    if (this.#captureSettings.captureRedirectHeaders === "full") {
      const redaction = redactHeaderMap(headers, this.#privacySettings, "headers");
      this.#recordRedactionHits(redaction.applied);
      return redaction.value;
    }
    const redaction = redactHeaderMap(headers, this.#privacySettings, "headers");
    this.#recordRedactionHits(redaction.applied);
    const location = Object.entries(redaction.value || {}).find(
      ([name]) => name.trim().toLowerCase() === "location",
    );
    return location ? { [location[0]]: location[1] } : null;
  }

  #filterInitiator(
    initiator:
      | {
          type?: string;
          url?: string;
          lineNumber?: number;
          columnNumber?: number;
          stack?: CdpRawStackTrace;
        }
      | null
      | undefined,
  ): NetworkInitiator | null {
    if (!initiator || this.#captureSettings.captureInitiator === "off") {
      return null;
    }
    if (this.#captureSettings.captureInitiator === "full-stack") {
      return this.#redactInitiator(initiator);
    }
    const filtered = {
      type: initiator.type,
      url: this.#redactUrlValue(initiator.url, "url", "network.initiator.url"),
      lineNumber: initiator.lineNumber,
      columnNumber: initiator.columnNumber,
    } as NetworkInitiator;
    this.#attachSourceMapResolveUrl(filtered, initiator.url);
    if (this.#captureSettings.captureInitiator === "short-stack" && initiator.stack) {
      filtered.stack = this.#redactStackTrace(
        this.#limitStackTrace(initiator.stack, 5),
        "network.initiator.stack",
      );
    }
    return filtered;
  }

  #redactInitiator(initiator: {
    type?: string;
    url?: string;
    lineNumber?: number;
    columnNumber?: number;
    stack?: CdpRawStackTrace;
  }): NetworkInitiator {
    const redacted = {
      type: initiator.type,
      url: this.#redactUrlValue(initiator.url, "url", "network.initiator.url"),
      lineNumber: initiator.lineNumber,
      columnNumber: initiator.columnNumber,
      stack: initiator.stack
        ? this.#redactStackTrace(initiator.stack, "network.initiator.stack")
        : undefined,
    };
    this.#attachSourceMapResolveUrl(redacted, initiator.url);
    return redacted;
  }

  #redactStackTrace(stack: CdpRawStackTrace, field: string): CdpRawStackTrace {
    return {
      callFrames: (stack.callFrames || []).map((frame, index) => {
        const redacted = {
          ...frame,
          url: this.#redactUrlValue(frame.url, "url", `${field}.${index}.url`) || "",
        };
        this.#attachSourceMapResolveUrl(redacted, frame.url);
        return redacted;
      }),
      description: stack.description,
      parent: stack.parent ? this.#redactStackTrace(stack.parent, `${field}.parent`) : undefined,
    };
  }

  #attachSourceMapResolveUrl<T extends object>(target: T, rawUrl: string | undefined): void {
    if (!rawUrl) return;
    Object.defineProperty(target, SOURCE_MAP_RESOLVE_URL_PROPERTY, {
      value: rawUrl,
      enumerable: false,
      configurable: true,
    });
  }

  #limitStackTrace(stack: CdpRawStackTrace, maxFrames: number): CdpRawStackTrace {
    return {
      callFrames: (stack.callFrames || []).slice(0, maxFrames),
      description: stack.description,
      parent:
        stack.parent && maxFrames > 0
          ? this.#limitStackTrace(stack.parent, Math.max(0, Math.floor(maxFrames / 2)))
          : undefined,
    };
  }

  #getWebSocketPayload(payload: string): string {
    if (!this.#captureSettings.captureWebSocketFrames) {
      return REDACTED_VALUE;
    }
    if (this.#captureSettings.maxWebSocketFrameBytes === 0) {
      return REDACTED_VALUE;
    }
    const maybeTruncated =
      this.#captureSettings.maxWebSocketFrameBytes == null ||
      payload.length <= this.#captureSettings.maxWebSocketFrameBytes
        ? payload
        : `${payload.slice(0, this.#captureSettings.maxWebSocketFrameBytes)}...(truncated)`;
    if (this.#privacySettings.redactWebSocketPayloads === "all") {
      this.#recordRedactionHits([
        {
          artifact: "websocket",
          class: "custom",
          action: "redacted",
          field: "websocket.payload",
          ruleId: "websocket-payload-all",
        },
      ]);
      return REDACTED_VALUE;
    }
    if (this.#privacySettings.redactWebSocketPayloads === "sensitive-fields") {
      const redaction = redactBodyText(
        maybeTruncated,
        this.#privacySettings,
        "websocket",
        "websocket.payload",
        "websocket",
      );
      this.#recordRedactionHits(redaction.applied);
      return redaction.value || "";
    }
    return maybeTruncated;
  }

  #redactUrlValue(
    value: string | undefined | null,
    artifact: "url" | "body" | "console" | "websocket" | "events" | "report" = "url",
    field = "url",
  ): string | undefined {
    const redaction = redactUrl(value, this.#privacySettings, artifact, field);
    this.#recordRedactionHits(redaction.applied);
    return redaction.value;
  }

  #redactBodyValue(
    value: string | null | undefined,
    field: string,
    isResponse = false,
  ): string | null {
    const shouldRedact = isResponse
      ? this.#privacySettings.redactResponseBodyFields
      : this.#privacySettings.redactRequestBodyFields;
    if (!shouldRedact) {
      return value ?? null;
    }
    const redaction = redactBodyText(value, this.#privacySettings, "body", field, "body");
    this.#recordRedactionHits(redaction.applied);
    return redaction.value;
  }

  // ════════════════════════════════════════════
  // Console / Runtime handlers
  // ════════════════════════════════════════════

  #onConsoleAPICalled(source: chrome.debugger.Debuggee, params: CdpConsoleAPICalledParams): void {
    if (!this.#captureSettings.captureConsole) return;

    // CDP console events only contain an object handle for class instances.
    // Serialize them in order so asynchronous property reads cannot reorder rows.
    const capture = this.#consoleCaptureQueue
      .catch(() => {})
      .then(() => this.#captureConsoleEntry(source, params));
    this.#consoleCaptureQueue = capture;
    this.#consoleCaptureFetches.add(capture);
    void capture.finally(() => this.#consoleCaptureFetches.delete(capture));
  }

  async #captureConsoleEntry(
    source: chrome.debugger.Debuggee,
    params: CdpConsoleAPICalledParams,
  ): Promise<void> {
    const level = this.#mapConsoleType(params.type);
    const entry: ConsoleEntry = {
      source: "console-api",
      level,
      timestamp: this.#toEpochMs(params.timestamp),
      args: await Promise.all(
        (params.args || []).map((arg) =>
          level === "error"
            ? this.#serializeRemoteObjectWithProperties(source, arg)
            : Promise.resolve(this.#serializeRemoteObject(arg)),
        ),
      ),
      stackTrace: this.#serializeStackTrace(params.stackTrace),
    };

    this.#storage.addConsoleEntry(entry);
  }

  async #serializeRemoteObjectWithProperties(
    source: chrome.debugger.Debuggee,
    obj: CdpRemoteObject,
  ): Promise<SerializedRemoteObject> {
    const serialized = this.#serializeRemoteObject(obj);
    if (obj.type !== "object" || !obj.objectId || serialized.preview?.properties?.length) {
      return serialized;
    }

    try {
      const response = (await this.#sendCommand(source, "Runtime.getProperties", {
        objectId: obj.objectId,
        ownProperties: false,
        generatePreview: true,
      })) as { result?: CdpPropertyDescriptor[] } | undefined;
      const properties = (response?.result || [])
        .filter((property) => property.name !== "__proto__" && property.value)
        .slice(0, MAX_CONSOLE_OBJECT_PROPERTIES)
        .map((property) => {
          const value = this.#serializeRemoteObject(property.value as CdpRemoteObject);
          return {
            name: property.name,
            type: value.type,
            value: value.description ?? (value.value == null ? undefined : String(value.value)),
            subtype: value.subtype,
            valuePreview: value.preview,
          };
        });

      if (properties.length) {
        serialized.preview = {
          type: "object",
          subtype: obj.subtype,
          description: obj.description || obj.className,
          overflow: (response?.result?.length || 0) > properties.length,
          properties,
        };
      }
    } catch {
      // Object handles can expire between Runtime.consoleAPICalled and this request.
    }

    return serialized;
  }

  #onExceptionThrown(params: CdpExceptionThrownParams): void {
    if (!this.#captureSettings.captureConsole) return;
    const details = params.exceptionDetails || {};
    const entry: ConsoleEntry = {
      source: "exception",
      level: "error",
      timestamp: this.#toEpochMs(params.timestamp),
      message: this.#describeExceptionMessage(details),
      args: details.exception ? [this.#serializeRemoteObject(details.exception)] : [],
      stackTrace: this.#serializeStackTrace(details.stackTrace),
      url: details.url,
      lineNumber: details.lineNumber,
      columnNumber: details.columnNumber,
    };

    this.#storage.addConsoleEntry(entry);
  }

  #describeExceptionMessage(
    details: NonNullable<CdpExceptionThrownParams["exceptionDetails"]>,
  ): string {
    const exception = details.exception;
    const description = exception?.description?.trim();
    if (description) {
      // Error descriptions commonly include a V8 stack; the structured stack is stored separately.
      const firstStackLine = description.search(/\n\s*at\s/);
      return firstStackLine >= 0 ? description.slice(0, firstStackLine) : description;
    }

    if (exception?.value !== undefined && exception.value !== null) {
      return String(exception.value);
    }

    return details.text || "Uncaught exception";
  }

  #onLogEntryAdded(params: CdpLogEntryAddedParams): void {
    if (!this.#captureSettings.captureConsole) return;
    const logEntry = params.entry || {};
    if (this.#shouldSuppressRecorderLog(logEntry)) return;
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

  #onExecutionContextCreated(
    source: chrome.debugger.Debuggee,
    params: CdpExecutionContextCreatedParams,
  ): void {
    const contextId = params.context?.id;
    const frameId = params.context?.auxData?.frameId;
    if (typeof contextId !== "number" || !frameId) return;
    this.#executionContextFrameIds.set(this.#executionContextKey(source, contextId), frameId);
    this.#retryPendingSourceMapAttempts();
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
    const errorStackTrace =
      obj.subtype === "error" ? this.#parseErrorStackTrace(obj.description) : undefined;
    if (errorStackTrace?.length) {
      result.stackTrace = errorStackTrace;
    }

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
        valuePreview: p.valuePreview ? this.#serializePreview(p.valuePreview) : undefined,
      })),
      entries: preview.entries
        ? preview.entries.map((e) => {
            const valuePreview = this.#serializePreview(e.value);
            return {
              key: e.key ? this.#serializePreview(e.key) : undefined,
              value: valuePreview ?? { type: e.value.type },
            };
          })
        : undefined,
    };
  }

  #parseErrorStackTrace(description: string | undefined): StackFrame[] | undefined {
    if (!description?.includes("\n")) {
      return undefined;
    }

    const frames: StackFrame[] = [];
    for (const line of description.split(/\r?\n/)) {
      const frame = this.#parseV8StackFrame(line);
      if (!frame) {
        continue;
      }
      frames.push(frame);
      if (frames.length >= MAX_PARSED_ERROR_STACK_FRAMES) {
        break;
      }
    }

    return frames.length ? frames : undefined;
  }

  #parseV8StackFrame(line: string): StackFrame | null {
    const withFunction = line.match(/^\s*at\s+(.+?)\s+\((.+):(\d+):(\d+)\)\s*$/);
    const bare = withFunction ? null : line.match(/^\s*at\s+(.+):(\d+):(\d+)\s*$/);
    const rawUrl = withFunction?.[2] ?? bare?.[1];
    if (!rawUrl || !this.#isResolvableStackUrl(rawUrl)) {
      return null;
    }

    const lineNumber = Number(withFunction?.[3] ?? bare?.[2]);
    const columnNumber = Number(withFunction?.[4] ?? bare?.[3]);
    if (!Number.isFinite(lineNumber) || lineNumber <= 0 || !Number.isFinite(columnNumber)) {
      return null;
    }

    // V8 string stacks use one-based coordinates, while CDP structured stack
    // frames and source maps in this code path use zero-based coordinates.
    const frame: StackFrame = {
      functionName: withFunction?.[1]?.trim() || "(anonymous)",
      url: rawUrl,
      lineNumber: lineNumber - 1,
      columnNumber: Math.max(0, columnNumber - 1),
    };
    this.#attachSourceMapResolveUrl(frame, rawUrl);
    return frame;
  }

  #isResolvableStackUrl(url: string): boolean {
    return /^(https?:|file:|blob:|webpack:)/.test(url);
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
        frames.push({
          asyncBoundary: parentDesc || "async",
          functionName: "",
          url: "",
          lineNumber: 0,
          columnNumber: 0,
        });
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
      const sessionId = this.#getSessionId(source);
      const executionContextId =
        typeof params.executionContextId === "number" ? params.executionContextId : undefined;
      const resolvedUrl = this.#resolveSourceMapUrl(params.sourceMapURL, params.url);
      const attempt: SourceMapLoadAttempt = {
        source,
        scriptUrl: params.url,
        sourceMapURL: params.sourceMapURL,
        resolvedUrl,
        sessionId,
        executionContextId,
        frameId:
          params.executionContextAuxData?.frameId ??
          (executionContextId != null
            ? this.#executionContextFrameIds.get(
                this.#executionContextKey(source, executionContextId),
              )
            : undefined),
        diagnostic: this.#createSourceMapDiagnostic(
          params.url,
          resolvedUrl,
          sessionId,
          executionContextId,
          params.executionContextAuxData?.frameId ??
            (executionContextId != null
              ? this.#executionContextFrameIds.get(
                  this.#executionContextKey(source, executionContextId),
                )
              : undefined),
        ),
      };
      this.#recordSourceMapDiagnostic(attempt.diagnostic);
      this.#scheduleSourceMapAttempt(attempt);
    }
  }

  #createSourceMapDiagnostic(
    scriptUrl: string,
    resolvedUrl: string,
    sessionId: string | undefined,
    executionContextId: number | undefined,
    frameId: string | undefined,
  ): SourceMapDiagnostic {
    return {
      generatedUrl: this.#redactUrlValue(scriptUrl, "url", "sourcemap.generatedUrl") || scriptUrl,
      sourceMapUrl: resolvedUrl.startsWith("data:")
        ? "data:"
        : this.#redactUrlValue(resolvedUrl, "url", "sourcemap.sourceMapUrl") || resolvedUrl,
      sourceType: resolvedUrl.startsWith("data:") ? "inline" : "external",
      targetType: this.#getSourceMapTargetType(sessionId),
      sessionId,
      executionContextId,
      frameId,
      status: "pending",
    };
  }

  #scheduleSourceMapAttempt(attempt: SourceMapLoadAttempt): void {
    if (this.#shouldWaitForSourceMapFrameId(attempt)) {
      attempt.diagnostic.status = "pending";
      attempt.diagnostic.reason = "pending-frame-id";
      this.#pendingSourceMapAttempts.set(this.#sourceMapAttemptKey(attempt), attempt);
      return;
    }

    this.#startSourceMapFetch(attempt);
  }

  #startSourceMapFetch(attempt: SourceMapLoadAttempt): void {
    attempt.diagnostic.status = "pending";
    attempt.diagnostic.reason = undefined;
    attempt.diagnostic.frameId = attempt.frameId;
    this.#pendingSourceMapAttempts.delete(this.#sourceMapAttemptKey(attempt));
    const promise = this.#trackSourceMapFetch(this.#fetchAndRegisterSourceMap(attempt));
    this.#sourceMapFetches.add(promise);
  }

  #shouldWaitForSourceMapFrameId(attempt: SourceMapLoadAttempt): boolean {
    return (
      !attempt.resolvedUrl.startsWith("data:") &&
      this.#sourceMapTargetNeedsFrameId(attempt.sessionId) &&
      !attempt.frameId &&
      attempt.executionContextId != null
    );
  }

  #retryPendingSourceMapAttempts(): void {
    for (const attempt of Array.from(this.#pendingSourceMapAttempts.values())) {
      if (!attempt.frameId && attempt.executionContextId != null) {
        attempt.frameId = this.#executionContextFrameIds.get(
          this.#executionContextKey(attempt.source, attempt.executionContextId),
        );
      }
      if (!this.#shouldWaitForSourceMapFrameId(attempt)) {
        this.#startSourceMapFetch(attempt);
      }
    }
  }

  #failPendingSourceMapAttempts(): void {
    for (const attempt of this.#pendingSourceMapAttempts.values()) {
      attempt.diagnostic.status = "failed";
      attempt.diagnostic.reason = "missing-frame-id";
    }
    this.#pendingSourceMapAttempts.clear();
  }

  #sourceMapAttemptKey(attempt: SourceMapLoadAttempt): string {
    return `${attempt.sessionId || "root"}:${attempt.executionContextId ?? "none"}:${attempt.scriptUrl}:${attempt.sourceMapURL}`;
  }

  #trackSourceMapFetch(promise: Promise<void>): Promise<void> {
    promise.finally(() => {
      this.#sourceMapFetches.delete(promise);
    });
    return promise;
  }

  async #fetchAndRegisterSourceMap(attempt: SourceMapLoadAttempt): Promise<void> {
    const { source, scriptUrl, resolvedUrl, diagnostic } = attempt;
    let content: string | null = null;
    try {
      content = await this.#fetchSourceMapContent(source, resolvedUrl, diagnostic);
    } catch {
      diagnostic.status = "failed";
      diagnostic.reason = "unsupported-url";
    }
    if (!content) {
      return;
    }

    const contentKind = this.#classifySourceMapContent(content);
    if (contentKind) {
      diagnostic.status = "failed";
      diagnostic.reason = contentKind;
      return;
    }

    try {
      const raw = JSON.parse(content);
      if (!this.#sourceMapResolver.addMap(scriptUrl, raw)) {
        diagnostic.status = "failed";
        diagnostic.reason = "unsupported-map";
        return;
      }
      diagnostic.status = "success";
      diagnostic.byteSize = content.length;
      diagnostic.sourcesCount = Array.isArray(raw?.sources) ? raw.sources.length : undefined;
      diagnostic.hasSourcesContent = Array.isArray(raw?.sourcesContent)
        ? raw.sourcesContent.some((item: unknown) => typeof item === "string" && item.length > 0)
        : undefined;
    } catch {
      diagnostic.status = "failed";
      diagnostic.reason = "json-parse-failed";
    }
  }

  #classifySourceMapContent(content: string): "html-fallback" | "non-json-response" | null {
    const first = content.trimStart()[0];
    if (first === "<") return "html-fallback";
    if (first !== "{" && first !== "[") return "non-json-response";
    return null;
  }

  #resolveSourceMapUrl(sourceMapURL: string, scriptUrl: string): string {
    if (sourceMapURL.startsWith("data:")) return sourceMapURL;
    try {
      return new URL(sourceMapURL, scriptUrl).href;
    } catch {
      return sourceMapURL;
    }
  }

  async #fetchSourceMapContent(
    source: chrome.debugger.Debuggee,
    url: string,
    diagnostic: SourceMapDiagnostic,
  ): Promise<string | null> {
    if (url.startsWith("data:")) {
      const commaIdx = url.indexOf(",");
      if (commaIdx < 0) {
        diagnostic.status = "failed";
        diagnostic.reason = "unsupported-url";
        return null;
      }
      const meta = url.slice(5, commaIdx);
      const data = url.slice(commaIdx + 1);
      if (data.length > SOURCE_MAP_MAX_BYTES) {
        diagnostic.status = "failed";
        diagnostic.reason = "too-large";
        return null;
      }
      return meta.includes("base64") ? atob(data) : decodeURIComponent(data);
    }

    if (!this.#attached || !this.#tabId) {
      diagnostic.status = "skipped";
      diagnostic.reason = "network-failed";
      return null;
    }
    return this.#loadSourceMapResource(source, url, diagnostic);
  }

  async #loadSourceMapResource(
    source: chrome.debugger.Debuggee,
    url: string,
    diagnostic: SourceMapDiagnostic,
  ): Promise<string | null> {
    this.#sourceMapResourceUrls.add(url);
    const targetType = diagnostic.targetType;
    const isWorkerTarget = targetType.includes("worker");
    const needsFrameId = this.#sourceMapTargetNeedsFrameId(undefined, targetType);
    if (needsFrameId && !diagnostic.frameId) {
      diagnostic.status = "failed";
      diagnostic.reason = "missing-frame-id";
      return null;
    }

    try {
      // Load maps through CDP rather than page-context fetch so enrichment does
      // not execute code in, or create requests from, the recorded page.
      const params: {
        frameId?: string;
        url: string;
        options: { disableCache: boolean; includeCredentials: boolean };
      } = {
        url,
        options: {
          disableCache: false,
          includeCredentials: true,
        },
      };
      if (!isWorkerTarget && diagnostic.frameId) {
        params.frameId = diagnostic.frameId;
      }

      const result = (await this.#sendCommand(source, "Network.loadNetworkResource", params)) as
        | CdpLoadNetworkResourceResult
        | undefined;

      const resource = result?.resource;
      diagnostic.httpStatusCode = resource?.httpStatusCode;
      diagnostic.netError = resource?.netErrorName || resource?.netError?.toString();
      const stream = resource?.success ? resource.stream : undefined;
      if (!stream) {
        diagnostic.status = "failed";
        diagnostic.reason =
          typeof resource?.httpStatusCode === "number" && resource.httpStatusCode >= 400
            ? "http-error"
            : "network-failed";
        return null;
      }
      const content = await this.#readProtocolStream(source, stream);
      if (!content) {
        diagnostic.status = "failed";
        diagnostic.reason = "stream-read-failed";
      }
      return content;
    } catch {
      diagnostic.status = "failed";
      diagnostic.reason = "network-failed";
      return null;
    }
  }

  #getSourceMapTargetType(sessionId: string | undefined): string {
    if (!sessionId) return "page";
    return this.#sessionTargetTypes.get(sessionId) || "unknown";
  }

  #sourceMapTargetNeedsFrameId(sessionId: string | undefined, targetType?: string): boolean {
    const normalized = targetType || this.#getSourceMapTargetType(sessionId);
    return !normalized.includes("worker") && normalized !== "unknown";
  }

  #recordSourceMapDiagnostic(diagnostic: SourceMapDiagnostic): void {
    this.#sourceMapDiagnostics.push(diagnostic);
    if (this.#sourceMapDiagnostics.length > SOURCE_MAP_DIAGNOSTIC_LIMIT) {
      this.#sourceMapDiagnostics.splice(
        0,
        this.#sourceMapDiagnostics.length - SOURCE_MAP_DIAGNOSTIC_LIMIT,
      );
    }
  }

  async #readProtocolStream(
    source: chrome.debugger.Debuggee,
    stream: string,
  ): Promise<string | null> {
    const decoder = new TextDecoder();
    let content = "";
    let bytesRead = 0;

    try {
      while (true) {
        const chunk = (await this.#sendCommand(source, "IO.read", {
          handle: stream,
          size: SOURCE_MAP_READ_CHUNK_BYTES,
        })) as CdpIoReadResult | undefined;

        const data = chunk?.data || "";
        if (chunk?.base64Encoded) {
          const bytes = this.#base64ToBytes(data);
          bytesRead += bytes.byteLength;
          if (bytesRead > SOURCE_MAP_MAX_BYTES) return null;
          content += decoder.decode(bytes, { stream: !chunk.eof });
        } else {
          bytesRead += data.length;
          if (bytesRead > SOURCE_MAP_MAX_BYTES) return null;
          content += data;
        }

        if (chunk?.eof) {
          if (chunk.base64Encoded) {
            content += decoder.decode();
          }
          return content || null;
        }
      }
    } catch {
      return null;
    } finally {
      await this.#sendCommand(source, "IO.close", { handle: stream }).catch(() => {});
    }
  }

  #base64ToBytes(value: string): Uint8Array {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  #shouldSuppressRecorderResource(url: string | undefined): boolean {
    return Boolean(
      this.#captureSettings.suppressRecorderInternalRequests &&
        url &&
        this.#sourceMapResourceUrls.has(url),
    );
  }

  #shouldSuppressRecorderLog(entry: NonNullable<CdpLogEntryAddedParams["entry"]>): boolean {
    if (!this.#captureSettings.suppressRecorderInternalRequests) return false;
    const text = entry.text || "";
    const url = entry.url || "";
    if (!url || !this.#sourceMapResourceUrls.has(url)) return false;
    return (
      url.endsWith(".map") && (/source\s*map/i.test(text) || /failed to load resource/i.test(text))
    );
  }

  #toEpochMs(ts: number | undefined): number {
    if (ts == null || !Number.isFinite(ts)) return Date.now();
    return coerceEpochMs(ts, ts * 1000) ?? Date.now();
  }

  /** Learn wall-clock offset from Network events that pair monotonic + wallTime. */
  #noteNetworkWallClock(
    monotonicSeconds: number | undefined,
    wallTimeSeconds: number | undefined,
  ): void {
    if (typeof monotonicSeconds !== "number" || typeof wallTimeSeconds !== "number") {
      return;
    }
    const hadOffset = this.#networkWallClockOffsetMs != null;
    const offset = wallClockOffsetFromNetworkPair(monotonicSeconds, wallTimeSeconds);
    if (offset != null) {
      this.#networkWallClockOffsetMs = offset;
      // WebSocket frames captured before any HTTP request used a Date.now()
      // fallback. Re-stamp them now that we can map monotonic → epoch.
      if (!hadOffset) {
        for (const ws of this.#pendingWebSockets.values()) {
          for (let index = 0; index < ws.frameMonotonicSeconds.length; index += 1) {
            const mono = ws.frameMonotonicSeconds[index];
            if (Number.isFinite(mono)) {
              ws.entry.frames[index].timestamp = monotonicSecondsToEpochMs(mono, offset);
            }
          }
        }
      }
    }
  }

  /** CDP WebSocket frame timestamps are Network.MonotonicTime (seconds). */
  #webSocketFrameEpochMs(monotonicSeconds: number | undefined): number {
    if (typeof monotonicSeconds !== "number" || !Number.isFinite(monotonicSeconds)) {
      return Date.now();
    }
    return monotonicSecondsToEpochMs(monotonicSeconds, this.#networkWallClockOffsetMs);
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

  #executionContextKey(source: chrome.debugger.Debuggee, contextId: number): string {
    return `${this.#getSessionId(source) || "root"}:${contextId}`;
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
      this.#sendCommand(target, "DOMStorage.enable").catch(() => {}),
      this.#sendCommand(target, "DOMSnapshot.enable").catch(() => {}),
    ]);

    try {
      await this.#sendCommand(target, "Network.setAttachDebugStack", { enabled: true }).catch(
        () => {},
      );
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
      // Pause new targets until Network/Runtime are enabled so early requests
      // from iframes/workers are not missed. #onAttachedToTarget always resumes.
      waitForDebuggerOnStart: true,
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
      if (
        (entry.status == null || entry.status === 0) &&
        typeof responseExtra.statusCode === "number"
      ) {
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

  /**
   * Captures a localStorage/sessionStorage/cookies snapshot for a single phase.
   * Delegates to `CdpStorageSnapshotCollector`; see that class for the capture
   * and redaction details. Pre: this.#attached === true; the `captureStorage`
   * toggle is gated by the caller (service-worker).
   */
  async captureStorageSnapshot(phase: "start" | "stop"): Promise<void> {
    if (!this.#tabId) return;
    await this.#storageSnapshot.captureStorageSnapshot(this.#tabId, phase);
  }

  /**
   * Captures a static DOM snapshot. Delegates to `CdpStorageSnapshotCollector`;
   * see that class for the flattening, masking, and size-guard details. Pre:
   * this.#attached === true; the `captureDomSnapshots` toggle is gated by the
   * caller (service-worker).
   */
  async captureDomSnapshot(label: string): Promise<void> {
    if (!this.#tabId) return;
    await this.#storageSnapshot.captureDomSnapshot(this.#tabId, label);
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
  /** Raw monotonic seconds for each frame, aligned with `entry.frames`. */
  frameMonotonicSeconds: number[];
}
