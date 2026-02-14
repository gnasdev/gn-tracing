import type {
  ConsoleEntry,
  NetworkEntry,
  WebSocketEntry,
  StackFrame,
  CdpStackTrace,
} from "../types/recording";
import type { SourceMapResolver } from "./sourcemap-resolver";

const MAX_CONSOLE_ENTRY_SIZE = 32768; // 32KB per entry

export class StorageManager {
  #consoleLogs: ConsoleEntry[] = [];
  #networkEntries: NetworkEntry[] = [];
  #webSocketEntries: WebSocketEntry[] = [];

  addConsoleEntry(entry: ConsoleEntry): void {
    const serialized = JSON.stringify(entry.args || entry.message);
    if (serialized && serialized.length > MAX_CONSOLE_ENTRY_SIZE) {
      if (entry.args) {
        entry.args = [{ type: "string", value: serialized.slice(0, MAX_CONSOLE_ENTRY_SIZE) + "...(truncated)" }];
      } else if (entry.message) {
        entry.message = entry.message.slice(0, MAX_CONSOLE_ENTRY_SIZE) + "...(truncated)";
      }
    }
    this.#consoleLogs.push(entry);
  }

  addNetworkEntry(entry: NetworkEntry): void {
    this.#networkEntries.push(entry);
  }

  addWebSocketEntry(entry: WebSocketEntry): void {
    this.#webSocketEntries.push(entry);
  }

  getConsoleLogCount(): number {
    return this.#consoleLogs.length;
  }

  getNetworkEntryCount(): number {
    return this.#networkEntries.length;
  }

  getConsoleLogs(): ConsoleEntry[] {
    return this.#consoleLogs;
  }

  getNetworkEntries(): NetworkEntry[] {
    return this.#networkEntries;
  }

  getWebSocketEntries(): WebSocketEntry[] {
    return this.#webSocketEntries;
  }

  clear(): void {
    this.#consoleLogs = [];
    this.#networkEntries = [];
    this.#webSocketEntries = [];
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
      if (entry.initiator) {
        if (entry.initiator.url && entry.initiator.lineNumber != null) {
          const resolved = resolver.resolve(entry.initiator.url, entry.initiator.lineNumber, entry.initiator.columnNumber || 0);
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
  }

  #resolveFrames(resolver: SourceMapResolver, frames: StackFrame[]): void {
    for (const frame of frames) {
      if (frame.asyncBoundary || !frame.url) continue;
      const resolved = resolver.resolve(frame.url, frame.lineNumber, frame.columnNumber || 0);
      if (resolved) {
        frame.originalSource = resolved.source ?? undefined;
        frame.originalLine = resolved.line;
        frame.originalColumn = resolved.column;
        if (resolved.name) frame.originalName = resolved.name;
      }
    }
  }

  #resolveCdpStack(resolver: SourceMapResolver, stack: CdpStackTrace): void {
    if (stack.callFrames) {
      for (const frame of stack.callFrames) {
        if (!frame.url) continue;
        const resolved = resolver.resolve(frame.url, frame.lineNumber || 0, frame.columnNumber || 0);
        if (resolved) {
          frame.originalSource = resolved.source ?? undefined;
          frame.originalLine = resolved.line;
          frame.originalColumn = resolved.column;
          if (resolved.name) frame.originalName = resolved.name;
        }
      }
    }
    if (stack.parent) {
      this.#resolveCdpStack(resolver, stack.parent);
    }
  }

  exportConsoleJSON(): string {
    return JSON.stringify(this.#consoleLogs, null, 2);
  }

  exportNetworkJSON(): string {
    return JSON.stringify({
      log: {
        version: "1.0",
        creator: { name: "ns-tracing", version: "1.0.0" },
        entries: this.#networkEntries.map((e) => ({
          request: {
            method: e.method,
            url: e.url,
            headers: e.requestHeaders
              ? Object.entries(e.requestHeaders).map(([name, value]) => ({ name, value }))
              : [],
            postData: e.postData ? { text: e.postData } : undefined,
          },
          response: {
            status: e.status,
            statusText: e.statusText || "",
            headers: e.responseHeaders
              ? Object.entries(e.responseHeaders).map(([name, value]) => ({ name, value }))
              : [],
            content: {
              size: e.encodedDataLength,
              mimeType: e.mimeType || "",
              text: e.responseBody ? e.responseBody.body : undefined,
              encoding: e.responseBody && e.responseBody.base64Encoded ? "base64" : undefined,
            },
          },
          timings: e.timing
            ? {
                dns: Math.max(0, e.timing.dnsEnd - e.timing.dnsStart),
                connect: Math.max(0, e.timing.connectEnd - e.timing.connectStart),
                ssl: Math.max(0, e.timing.sslEnd - e.timing.sslStart),
                send: Math.max(0, e.timing.sendEnd - e.timing.sendStart),
                wait: Math.max(0, e.timing.receiveHeadersEnd - e.timing.sendEnd),
              }
            : {},
          time: e.timing ? e.timing.receiveHeadersEnd : 0,
          resourceType: e.resourceType,
          serverIPAddress: e.remoteIPAddress,
          wallTime: e.wallTime || null,
          error: e.error || undefined,
          redirectChain: e.redirectChain || undefined,
          initiator: e.initiator || undefined,
        })),
      },
    }, null, 2);
  }

  exportWebSocketJSON(): string {
    return JSON.stringify(this.#webSocketEntries, null, 2);
  }
}
