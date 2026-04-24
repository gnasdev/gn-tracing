import type {
  ConsoleEntry,
  NetworkEntry,
  WebSocketEntry,
  StackFrame,
  CdpStackTrace,
} from "../types/recording";
import type { SourceMapResolver } from "./sourcemap-resolver";

const MAX_CONSOLE_ENTRY_SIZE = 32768;

interface FinalizedRecordingArtifacts {
  consoleLogs?: string;
  networkRequests?: string;
  webSocketLogs?: string;
  consoleLogCount: number;
  networkRequestCount: number;
}

export class StorageManager {
  #consoleLogs: ConsoleEntry[] = [];
  #networkEntries: NetworkEntry[] = [];
  #webSocketEntries: WebSocketEntry[] = [];
  #isPaused = false;

  beginSession(): void {
    this.#consoleLogs = [];
    this.#networkEntries = [];
    this.#webSocketEntries = [];
    this.#isPaused = false;
  }

  setPaused(isPaused: boolean): void {
    this.#isPaused = isPaused;
  }

  addConsoleEntry(entry: ConsoleEntry): void {
    if (this.#isPaused) {
      return;
    }

    const serialized = JSON.stringify(entry.args || entry.message);
    if (serialized && serialized.length > MAX_CONSOLE_ENTRY_SIZE) {
      if (entry.args) {
        entry.args = [{ type: "string", value: `${serialized.slice(0, MAX_CONSOLE_ENTRY_SIZE)}...(truncated)` }];
      } else if (entry.message) {
        entry.message = `${entry.message.slice(0, MAX_CONSOLE_ENTRY_SIZE)}...(truncated)`;
      }
    }

    this.#consoleLogs.push(entry);
  }

  addNetworkEntry(entry: NetworkEntry): void {
    if (this.#isPaused) {
      return;
    }
    this.#networkEntries.push(entry);
  }

  addWebSocketEntry(entry: WebSocketEntry): void {
    if (this.#isPaused) {
      return;
    }
    this.#webSocketEntries.push(entry);
  }

  getConsoleLogCount(): number {
    return this.#consoleLogs.length;
  }

  getNetworkEntryCount(): number {
    return this.#networkEntries.length;
  }

  clear(): void {
    this.beginSession();
  }

  resolveSourceMaps(resolver: SourceMapResolver): void {
    for (const entry of this.#consoleLogs) {
      if (entry.url && entry.lineNumber != null) {
        const resolved = resolver.resolve(entry.url, entry.lineNumber, entry.columnNumber || 0);
        if (resolved) {
          entry.originalSource = resolved.source ?? undefined;
          entry.originalLine = resolved.line;
          entry.originalColumn = resolved.column;
        }
      }
      if (entry.stackTrace) {
        this.#resolveFrames(resolver, entry.stackTrace);
      }
    }

    for (const entry of this.#networkEntries) {
      if (!entry.initiator) {
        continue;
      }

      if (entry.initiator.url && entry.initiator.lineNumber != null) {
        const resolved = resolver.resolve(
          entry.initiator.url,
          entry.initiator.lineNumber,
          entry.initiator.columnNumber || 0,
        );
        if (resolved) {
          entry.initiator.originalSource = resolved.source ?? undefined;
          entry.initiator.originalLine = resolved.line;
          entry.initiator.originalColumn = resolved.column;
        }
      }

      if (entry.initiator.stack) {
        this.#resolveCdpStack(resolver, entry.initiator.stack);
      }
    }
  }

  finalizeCurrentSession(): FinalizedRecordingArtifacts {
    const artifacts: FinalizedRecordingArtifacts = {
      consoleLogCount: this.#consoleLogs.length,
      networkRequestCount: this.#networkEntries.length,
      consoleLogs: this.#consoleLogs.length > 0 ? JSON.stringify(this.#consoleLogs, null, 2) : undefined,
      networkRequests: this.#networkEntries.length > 0
        ? JSON.stringify({
            log: {
              version: "1.0",
              creator: { name: "gn-tracing", version: "1.0.0" },
              entries: this.#networkEntries.map((entry) => ({
                _requestId: entry.requestId,
                request: {
                  method: entry.method,
                  url: entry.url,
                  headers: (entry.requestHeadersExtra || entry.requestHeaders)
                    ? Object.entries(entry.requestHeadersExtra || entry.requestHeaders || {}).map(([name, value]) => ({ name, value }))
                    : [],
                  postData: entry.postData ? { text: entry.postData } : undefined,
                },
                response: {
                  status: entry.status,
                  statusText: entry.statusText || "",
                  headers: (entry.responseHeadersExtra || entry.responseHeaders)
                    ? Object.entries(entry.responseHeadersExtra || entry.responseHeaders || {}).map(([name, value]) => ({ name, value }))
                    : [],
                  content: {
                    size: entry.encodedDataLength,
                    mimeType: entry.mimeType || "",
                    text: entry.responseBody ? entry.responseBody.body : undefined,
                    encoding: entry.responseBody?.base64Encoded ? "base64" : undefined,
                  },
                },
                timings: entry.timing
                  ? {
                      dns: Math.max(0, entry.timing.dnsEnd - entry.timing.dnsStart),
                      connect: Math.max(0, entry.timing.connectEnd - entry.timing.connectStart),
                      ssl: Math.max(0, entry.timing.sslEnd - entry.timing.sslStart),
                      send: Math.max(0, entry.timing.sendEnd - entry.timing.sendStart),
                      wait: Math.max(0, entry.timing.receiveHeadersEnd - entry.timing.sendEnd),
                    }
                  : {},
                time: entry.timing ? entry.timing.receiveHeadersEnd : 0,
                resourceType: entry.resourceType,
                serverIPAddress: entry.remoteIPAddress,
                wallTime: entry.wallTime || null,
                error: entry.error || undefined,
                servedFromCache: entry.servedFromCache || undefined,
                earlyHintsHeaders: entry.earlyHintsHeaders || undefined,
                redirectChain: entry.redirectChain || undefined,
                initiator: entry.initiator || undefined,
              })),
            },
          }, null, 2)
        : undefined,
      webSocketLogs: this.#webSocketEntries.length > 0 ? JSON.stringify(this.#webSocketEntries, null, 2) : undefined,
    };

    this.beginSession();
    return artifacts;
  }

  #resolveFrames(resolver: SourceMapResolver, frames: StackFrame[]): void {
    for (const frame of frames) {
      if (frame.asyncBoundary || !frame.url) {
        continue;
      }
      const resolved = resolver.resolve(frame.url, frame.lineNumber, frame.columnNumber || 0);
      if (resolved) {
        frame.originalSource = resolved.source ?? undefined;
        frame.originalLine = resolved.line;
        frame.originalColumn = resolved.column;
        if (resolved.name) {
          frame.originalName = resolved.name;
        }
      }
    }
  }

  #resolveCdpStack(resolver: SourceMapResolver, stack: CdpStackTrace): void {
    if (stack.callFrames) {
      for (const frame of stack.callFrames) {
        if (!frame.url) {
          continue;
        }
        const resolved = resolver.resolve(frame.url, frame.lineNumber || 0, frame.columnNumber || 0);
        if (resolved) {
          frame.originalSource = resolved.source ?? undefined;
          frame.originalLine = resolved.line;
          frame.originalColumn = resolved.column;
          if (resolved.name) {
            frame.originalName = resolved.name;
          }
        }
      }
    }

    if (stack.parent) {
      this.#resolveCdpStack(resolver, stack.parent);
    }
  }
}
