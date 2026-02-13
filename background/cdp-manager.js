import { SourceMapResolver } from "./sourcemap-resolver.js";

export class CdpManager {
  #tabId = null;
  #pendingRequests = new Map();
  #pendingWebSockets = new Map();
  #storage;
  #attached = false;
  #boundEventHandler;
  #boundDetachHandler;
  #sourceMapResolver = new SourceMapResolver();
  #sourceMapFetches = [];

  constructor(storage) {
    this.#storage = storage;
    this.#boundEventHandler = this.#handleDebuggerEvent.bind(this);
    this.#boundDetachHandler = this.#handleDetach.bind(this);
  }

  get sourceMapResolver() {
    return this.#sourceMapResolver;
  }

  async flushSourceMaps() {
    await Promise.allSettled(this.#sourceMapFetches);
    this.#sourceMapFetches = [];
  }

  async attach(tabId) {
    this.#tabId = tabId;
    this.#pendingRequests.clear();
    this.#pendingWebSockets.clear();
    this.#sourceMapResolver.clear();
    this.#sourceMapFetches = [];

    await chrome.debugger.attach({ tabId }, "1.3");
    this.#attached = true;

    // Register listeners BEFORE enabling domains to avoid race condition
    chrome.debugger.onEvent.addListener(this.#boundEventHandler);
    chrome.debugger.onDetach.addListener(this.#boundDetachHandler);

    // Enable core CDP domains (must succeed)
    await Promise.all([
      chrome.debugger.sendCommand({ tabId }, "Network.enable", {
        maxPostDataSize: 65536,
      }),
      chrome.debugger.sendCommand({ tabId }, "Runtime.enable", {
        generatePreviews: true,
      }),
      chrome.debugger.sendCommand({ tabId }, "Log.enable"),
    ]);

    // Enable Debugger domain for async stack traces (optional, may fail if DevTools is open)
    try {
      await chrome.debugger.sendCommand({ tabId }, "Debugger.enable");
      await chrome.debugger.sendCommand({ tabId }, "Debugger.setAsyncCallStackDepth", {
        maxDepth: 32,
      });
    } catch {
      // Debugger domain failed — async stacks won't be available but everything else works
    }
  }

  async detach() {
    chrome.debugger.onEvent.removeListener(this.#boundEventHandler);
    chrome.debugger.onDetach.removeListener(this.#boundDetachHandler);

    if (this.#attached && this.#tabId) {
      try {
        await chrome.debugger.detach({ tabId: this.#tabId });
      } catch {
        // Already detached
      }
    }

    // Flush pending requests
    for (const [, entry] of this.#pendingRequests) {
      this.#storage.addNetworkEntry(entry);
    }
    this.#pendingRequests.clear();

    // Flush pending WebSockets
    for (const [, ws] of this.#pendingWebSockets) {
      this.#storage.addWebSocketEntry(ws);
    }
    this.#pendingWebSockets.clear();

    this.#attached = false;
  }

  #handleDetach(source, reason) {
    if (source.tabId === this.#tabId) {
      this.#attached = false;
      chrome.debugger.onEvent.removeListener(this.#boundEventHandler);
      chrome.debugger.onDetach.removeListener(this.#boundDetachHandler);
    }
  }

  #handleDebuggerEvent(source, method, params) {
    if (source.tabId !== this.#tabId) return;

    switch (method) {
      // ── Network events ──
      case "Network.requestWillBeSent":
        this.#onRequestWillBeSent(params);
        break;
      case "Network.responseReceived":
        this.#onResponseReceived(params);
        break;
      case "Network.loadingFinished":
        this.#onLoadingFinished(source, params);
        break;
      case "Network.loadingFailed":
        this.#onLoadingFailed(params);
        break;

      // ── WebSocket events ──
      case "Network.webSocketCreated":
        this.#onWebSocketCreated(params);
        break;
      case "Network.webSocketFrameSent":
        this.#onWebSocketFrameSent(params);
        break;
      case "Network.webSocketFrameReceived":
        this.#onWebSocketFrameReceived(params);
        break;
      case "Network.webSocketClosed":
        this.#onWebSocketClosed(params);
        break;

      // ── Console / Runtime events ──
      case "Runtime.consoleAPICalled":
        this.#onConsoleAPICalled(params);
        break;
      case "Runtime.exceptionThrown":
        this.#onExceptionThrown(params);
        break;
      case "Log.entryAdded":
        this.#onLogEntryAdded(params);
        break;

      // ── Debugger events ──
      case "Debugger.scriptParsed":
        this.#onScriptParsed(params);
        break;
      case "Debugger.paused":
        // Resume immediately — we only enable Debugger for async stacks, not breakpoints
        chrome.debugger.sendCommand({ tabId: this.#tabId }, "Debugger.resume").catch(() => {});
        break;
    }
  }

  // ════════════════════════════════════════════
  // Network handlers
  // ════════════════════════════════════════════

  #onRequestWillBeSent(params) {
    // Handle redirect chain
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
        // Update to new URL after redirect
        existing.url = params.request.url;
        existing.method = params.request.method;
        existing.requestHeaders = params.request.headers;
        existing.postData = params.request.postData;
        existing.timestamp = params.timestamp;
        existing.wallTime = params.wallTime;
        return;
      }
    }

    const entry = {
      requestId: params.requestId,
      url: params.request.url,
      method: params.request.method,
      requestHeaders: params.request.headers,
      postData: params.request.postData,
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

    // Fetch large POST body if not included inline
    if (params.request.hasPostData && !params.request.postData) {
      this.#fetchPostData(params.requestId);
    }
  }

  async #fetchPostData(requestId) {
    try {
      const result = await chrome.debugger.sendCommand(
        { tabId: this.#tabId },
        "Network.getRequestPostData",
        { requestId }
      );
      const entry = this.#pendingRequests.get(requestId);
      if (entry && result) {
        entry.postData = result.postData;
      }
    } catch {
      // Request may have been completed already
    }
  }

  #onResponseReceived(params) {
    const entry = this.#pendingRequests.get(params.requestId);
    if (entry) {
      entry.status = params.response.status;
      entry.statusText = params.response.statusText;
      entry.responseHeaders = params.response.headers;
      entry.mimeType = params.response.mimeType;
      entry.timing = params.response.timing;
      entry.protocol = params.response.protocol;
      entry.remoteIPAddress = params.response.remoteIPAddress;
    }
  }

  #onLoadingFinished(source, params) {
    const entry = this.#pendingRequests.get(params.requestId);
    if (entry) {
      entry.encodedDataLength = params.encodedDataLength;

      // Fetch response body for text-based responses
      if (this.#shouldFetchBody(entry)) {
        this.#fetchResponseBody(source, params.requestId, entry);
      } else {
        this.#storage.addNetworkEntry(entry);
        this.#pendingRequests.delete(params.requestId);
      }
    }
  }

  #shouldFetchBody(entry) {
    if (!entry.mimeType) return false;
    if (entry.encodedDataLength > 1024 * 1024) return false; // Skip > 1MB

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
    return textTypes.some((t) => entry.mimeType.startsWith(t));
  }

  async #fetchResponseBody(source, requestId, entry) {
    try {
      const result = await chrome.debugger.sendCommand(
        { tabId: this.#tabId },
        "Network.getResponseBody",
        { requestId }
      );
      if (result) {
        entry.responseBody = {
          body: result.body,
          base64Encoded: result.base64Encoded,
        };
      }
    } catch {
      // Response body may have been evicted
    }
    this.#storage.addNetworkEntry(entry);
    this.#pendingRequests.delete(requestId);
  }

  #onLoadingFailed(params) {
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

  #onWebSocketCreated(params) {
    this.#pendingWebSockets.set(params.requestId, {
      requestId: params.requestId,
      url: params.url,
      initiator: params.initiator,
      frames: [],
      closed: false,
    });
  }

  #onWebSocketFrameSent(params) {
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

  #onWebSocketFrameReceived(params) {
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

  #onWebSocketClosed(params) {
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

  #onConsoleAPICalled(params) {
    const entry = {
      source: "console-api",
      level: this.#mapConsoleType(params.type),
      timestamp: this.#toEpochMs(params.timestamp),
      args: (params.args || []).map((arg) => this.#serializeRemoteObject(arg)),
      stackTrace: this.#serializeStackTrace(params.stackTrace),
    };

    this.#storage.addConsoleEntry(entry);
  }

  #onExceptionThrown(params) {
    const details = params.exceptionDetails || {};
    const entry = {
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

  #onLogEntryAdded(params) {
    const logEntry = params.entry || {};
    const entry = {
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

  #serializeRemoteObject(obj) {
    if (!obj) return { type: "undefined", value: undefined };

    const result = {
      type: obj.type,
      subtype: obj.subtype || undefined,
      value: obj.value,
      description: obj.description || undefined,
      className: obj.className || undefined,
    };

    // Include preview for objects/arrays (contains property tree)
    if (obj.preview) {
      result.preview = this.#serializePreview(obj.preview);
    }

    return result;
  }

  #serializePreview(preview) {
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
            value: this.#serializePreview(e.value),
          }))
        : undefined,
    };
  }

  #serializeStackTrace(stackTrace) {
    if (!stackTrace) return undefined;

    const frames = (stackTrace.callFrames || []).map((f) => ({
      functionName: f.functionName || "(anonymous)",
      url: f.url,
      lineNumber: f.lineNumber,
      columnNumber: f.columnNumber,
    }));

    // Flatten async stack traces
    if (stackTrace.parent) {
      const parentDesc = stackTrace.parent.description;
      const parentFrames = this.#serializeStackTrace(stackTrace.parent);
      if (parentFrames && parentFrames.length > 0) {
        frames.push({ asyncBoundary: parentDesc || "async" });
        frames.push(...parentFrames);
      }
    }

    return frames;
  }

  // ════════════════════════════════════════════
  // Sourcemap collection
  // ════════════════════════════════════════════

  #onScriptParsed(params) {
    if (params.sourceMapURL && params.url) {
      const promise = this.#fetchAndRegisterSourceMap(params.url, params.sourceMapURL);
      this.#sourceMapFetches.push(promise);
    }
  }

  async #fetchAndRegisterSourceMap(scriptUrl, sourceMapURL) {
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

  #resolveSourceMapUrl(sourceMapURL, scriptUrl) {
    if (sourceMapURL.startsWith("data:")) return sourceMapURL;
    try {
      return new URL(sourceMapURL, scriptUrl).href;
    } catch {
      return sourceMapURL;
    }
  }

  async #fetchSourceMapContent(url) {
    // Handle data URLs directly
    if (url.startsWith("data:")) {
      const commaIdx = url.indexOf(",");
      if (commaIdx < 0) return null;
      const meta = url.slice(5, commaIdx);
      const data = url.slice(commaIdx + 1);
      return meta.includes("base64") ? atob(data) : decodeURIComponent(data);
    }

    // Fetch via page context using CDP Runtime.evaluate
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
      );
      return result?.result?.value || null;
    } catch {
      return null;
    }
  }

  /** Normalize CDP timestamp to epoch milliseconds.
   *  CDP domains are inconsistent: some send seconds, some ms.
   *  Auto-detect based on magnitude. */
  #toEpochMs(ts) {
    if (!ts) return Date.now();
    // Current epoch in seconds is ~1.7e9, in ms is ~1.7e12
    // If < 1e11, it's definitely seconds
    return ts < 1e11 ? ts * 1000 : ts;
  }

  #mapConsoleType(type) {
    const map = {
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
