/**
 * Buffers captured artifacts for a single recording session in memory.
 */

import { getPrivacyProfileSettings, redactConsoleEntry } from "../shared/privacy-redaction";
import type { PrivacyRedactionSettings, UploadSettings } from "../types/messages";
import type {
  CdpStackTrace,
  ConsoleEntry,
  NetworkEntry,
  RedactionHit,
  RedirectEntry,
  SerializedRemoteObject,
  SourceMapDiagnostic,
  SourceMapFrameStatus,
  SourceMapResolveResult,
  StackFrame,
  WebSocketEntry,
} from "../types/recording";
import { getSourceMapUrlKeys, type SourceMapResolver } from "./sourcemap-resolver";

type ConsoleCaptureSettings = Pick<
  UploadSettings,
  | "captureConsoleArgs"
  | "consolePreviewDepth"
  | "captureConsoleStacks"
  | "captureConsoleSourceSnippets"
  | "maxConsoleEntryBytes"
>;

const DEFAULT_CONSOLE_CAPTURE_SETTINGS: ConsoleCaptureSettings = {
  captureConsoleArgs: true,
  consolePreviewDepth: "shallow",
  captureConsoleStacks: "warnings-errors",
  captureConsoleSourceSnippets: "warnings-errors",
  maxConsoleEntryBytes: null,
};
const SOURCE_MAP_RESOLVE_URL_PROPERTY = "__gnSourceMapResolveUrl";

type SourceMapLocationTarget = {
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
  originalSource?: string;
  originalLine?: number;
  originalColumn?: number;
  originalName?: string;
  sourceSnippet?: StackFrame["sourceSnippet"];
  sourceMapStatus?: SourceMapFrameStatus;
};

/**
 * In-memory artifact buffer for the current recording.
 *
 * Nothing here is durable storage. The service worker uses this class to collect
 * CDP-derived console/network/WebSocket entries, enrich them with source-map
 * data at stop time, and serialize only the artifacts that actually contain
 * entries for upload or replay.
 */
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
  #captureSettings: ConsoleCaptureSettings = { ...DEFAULT_CONSOLE_CAPTURE_SETTINGS };
  #privacySettings: PrivacyRedactionSettings = getPrivacyProfileSettings("standard");
  #recordRedactionHits: (hits: RedactionHit[]) => void = () => {};

  beginSession(): void {
    this.#consoleLogs = [];
    this.#networkEntries = [];
    this.#webSocketEntries = [];
  }

  setCaptureSettings(settings: Partial<ConsoleCaptureSettings>): void {
    this.#captureSettings = {
      ...DEFAULT_CONSOLE_CAPTURE_SETTINGS,
      ...settings,
    };
  }

  setPrivacySettings(
    settings: PrivacyRedactionSettings,
    recordRedactionHits?: (hits: RedactionHit[]) => void,
  ): void {
    this.#privacySettings = settings;
    this.#recordRedactionHits = recordRedactionHits || (() => {});
  }

  addConsoleEntry(entry: ConsoleEntry): void {
    this.#prepareConsoleEntry(entry);
    const serialized = JSON.stringify(entry.args || entry.message);
    if (
      serialized &&
      this.#captureSettings.maxConsoleEntryBytes != null &&
      serialized.length > this.#captureSettings.maxConsoleEntryBytes
    ) {
      if (entry.args) {
        entry.args = [
          {
            type: "string",
            value: `${serialized.slice(0, this.#captureSettings.maxConsoleEntryBytes)}...(truncated)`,
          },
        ];
      } else if (entry.message) {
        entry.message = `${entry.message.slice(0, this.#captureSettings.maxConsoleEntryBytes)}...(truncated)`;
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

  clear(): void {
    this.beginSession();
  }

  resolveSourceMaps(resolver: SourceMapResolver, diagnostics: SourceMapDiagnostic[] = []): void {
    for (const entry of this.#consoleLogs) {
      if (entry.url && entry.lineNumber != null) {
        this.#resolveLocation(
          resolver,
          diagnostics,
          entry,
          entry.url,
          this.#getSourceMapResolveUrl(entry) || entry.url,
          entry.lineNumber,
          entry.columnNumber || 0,
        );
      }
      if (entry.stackTrace) {
        this.#resolveFrames(resolver, diagnostics, entry.stackTrace);
        this.#promoteStackFrameLocation(entry, this.#findFirstResolvedFrame(entry.stackTrace));
      }
      this.#applyConsoleSourceSnippetPolicy(entry);
    }

    for (const entry of this.#networkEntries) {
      if (!entry.initiator) {
        continue;
      }

      if (entry.initiator.url && entry.initiator.lineNumber != null) {
        this.#resolveLocation(
          resolver,
          diagnostics,
          entry.initiator,
          entry.initiator.url,
          this.#getSourceMapResolveUrl(entry.initiator) || entry.initiator.url,
          entry.initiator.lineNumber,
          entry.initiator.columnNumber || 0,
        );
      }

      if (entry.initiator.stack) {
        this.#resolveCdpStack(resolver, diagnostics, entry.initiator.stack);
        this.#promoteStackFrameLocation(
          entry.initiator,
          this.#findFirstResolvedCdpFrame(entry.initiator.stack),
        );
      }
    }
  }

  finalizeCurrentSession(): FinalizedRecordingArtifacts {
    const consoleLogs = this.#consoleLogs.map((entry) => {
      const redacted = redactConsoleEntry(entry, this.#privacySettings);
      this.#recordRedactionHits(redacted.applied);
      return redacted.value;
    });
    const artifacts: FinalizedRecordingArtifacts = {
      consoleLogCount: this.#consoleLogs.length,
      networkRequestCount: this.#networkEntries.length,
      consoleLogs: consoleLogs.length > 0 ? JSON.stringify(consoleLogs) : undefined,
      networkRequests:
        this.#networkEntries.length > 0
          ? JSON.stringify({
              schemaVersion: 2,
              entries: this.#networkEntries.map((entry) => this.#compactNetworkEntry(entry)),
            })
          : undefined,
      webSocketLogs:
        this.#webSocketEntries.length > 0 ? JSON.stringify(this.#webSocketEntries) : undefined,
    };

    this.beginSession();
    return artifacts;
  }

  #resolveFrames(
    resolver: SourceMapResolver,
    diagnostics: SourceMapDiagnostic[],
    frames: StackFrame[],
  ): void {
    for (const frame of frames) {
      if (frame.asyncBoundary || !frame.url) {
        continue;
      }
      this.#resolveLocation(
        resolver,
        diagnostics,
        frame,
        frame.url,
        this.#getSourceMapResolveUrl(frame) || frame.url,
        frame.lineNumber,
        frame.columnNumber || 0,
      );
    }
  }

  #prepareConsoleEntry(entry: ConsoleEntry): void {
    if (!this.#shouldKeepConsoleStack(entry.level)) {
      entry.stackTrace = undefined;
    }

    if (!this.#captureSettings.captureConsoleArgs && entry.args?.length) {
      entry.message = this.#formatConsoleArgs(entry.args);
      entry.args = undefined;
    } else if (entry.args) {
      entry.args = entry.args.map((arg) => this.#compactRemoteObject(arg, 0));
    }
  }

  #compactRemoteObject(arg: SerializedRemoteObject, depth: number): SerializedRemoteObject {
    const maxDepth =
      this.#captureSettings.consolePreviewDepth === "full"
        ? 3
        : this.#captureSettings.consolePreviewDepth === "shallow"
          ? 1
          : 0;
    const compact: SerializedRemoteObject = {
      type: arg.type,
    };

    if (arg.subtype) compact.subtype = arg.subtype;
    if (arg.value != null) compact.value = arg.value;
    if (arg.description) compact.description = arg.description;
    if (this.#captureSettings.consolePreviewDepth !== "none" && arg.className) {
      compact.className = arg.className;
    }

    if (arg.preview && depth < maxDepth) {
      compact.preview = {
        type: arg.preview.type,
        subtype: arg.preview.subtype,
        description: arg.preview.description,
        overflow: arg.preview.overflow,
        properties: arg.preview.properties?.slice(0, 12).map((property) => ({
          name: property.name,
          type: property.type,
          value: property.value,
          subtype: property.subtype,
          valuePreview:
            property.valuePreview && depth + 1 < maxDepth
              ? this.#compactPreview(property.valuePreview, depth + 1)
              : undefined,
        })),
        entries: arg.preview.entries?.slice(0, 12).map((entry) => ({
          key:
            entry.key && depth + 1 < maxDepth
              ? this.#compactPreview(entry.key, depth + 1)
              : undefined,
          value: this.#compactPreview(entry.value, depth + 1),
        })),
      };
    }

    return compact;
  }

  #compactPreview(
    preview: NonNullable<SerializedRemoteObject["preview"]>,
    depth: number,
  ): NonNullable<SerializedRemoteObject["preview"]> {
    const maxDepth = this.#captureSettings.consolePreviewDepth === "full" ? 3 : 1;
    return {
      type: preview.type,
      subtype: preview.subtype,
      description: preview.description,
      overflow: preview.overflow,
      properties:
        depth < maxDepth
          ? preview.properties?.slice(0, 12).map((property) => ({
              name: property.name,
              type: property.type,
              value: property.value,
              subtype: property.subtype,
            }))
          : undefined,
    };
  }

  #formatConsoleArgs(args: SerializedRemoteObject[]): string {
    return args
      .map((arg) => {
        if (arg.value != null) return String(arg.value);
        if (arg.description) return arg.description;
        if (arg.subtype) return `${arg.type}:${arg.subtype}`;
        return arg.type;
      })
      .join(" ");
  }

  #shouldKeepConsoleStack(level: string | undefined): boolean {
    const normalized = String(level || "").toLowerCase();
    const mode = this.#captureSettings.captureConsoleStacks;
    if (mode === "all") return true;
    if (mode === "off") return false;
    if (mode === "errors") return normalized === "error";
    return normalized === "error" || normalized === "warning" || normalized === "warn";
  }

  #shouldKeepConsoleSourceSnippet(level: string | undefined): boolean {
    const normalized = String(level || "").toLowerCase();
    const mode = this.#captureSettings.captureConsoleSourceSnippets;
    if (mode === "all") return true;
    if (mode === "off") return false;
    if (mode === "errors") return normalized === "error";
    return normalized === "error" || normalized === "warning" || normalized === "warn";
  }

  #applyConsoleSourceSnippetPolicy(entry: ConsoleEntry): void {
    if (this.#shouldKeepConsoleSourceSnippet(entry.level)) {
      return;
    }
    entry.sourceSnippet = undefined;
    entry.stackTrace?.forEach((frame) => {
      frame.sourceSnippet = undefined;
    });
  }

  #compactNetworkEntry(entry: NetworkEntry): Record<string, unknown> {
    const canonicalRequestHeaders = entry.requestHeadersExtra || entry.requestHeaders || null;
    const canonicalResponseHeaders = entry.responseHeadersExtra || entry.responseHeaders || null;
    return this.#omitEmptyFields({
      requestId: entry.requestId,
      url: entry.url,
      method: entry.method,
      requestHeaders: canonicalRequestHeaders,
      postData: entry.postData,
      timestamp: entry.timestamp,
      wallTime: entry.wallTime,
      initiator: entry.initiator,
      resourceType: entry.resourceType,
      status: entry.status,
      statusText: entry.statusText,
      responseHeaders: canonicalResponseHeaders,
      earlyHintsHeaders: entry.earlyHintsHeaders,
      mimeType: entry.mimeType,
      timing: entry.timing,
      protocol: entry.protocol,
      remoteIPAddress: entry.remoteIPAddress,
      encodedDataLength: entry.encodedDataLength,
      error: entry.error,
      responseBody: entry.responseBody,
      redirectChain: entry.redirectChain?.map((redirect) => this.#compactRedirectEntry(redirect)),
      servedFromCache: entry.servedFromCache,
      canceled: entry.canceled,
    });
  }

  #compactRedirectEntry(entry: RedirectEntry): Record<string, unknown> {
    return this.#omitEmptyFields({
      url: entry.url,
      status: entry.status,
      statusText: entry.statusText,
      headers: entry.headers,
    });
  }

  #omitEmptyFields<T extends Record<string, unknown>>(value: T): Partial<T> {
    return Object.fromEntries(
      Object.entries(value).filter(([, item]) => {
        if (item == null || item === "" || item === false) return false;
        if (Array.isArray(item)) return item.length > 0;
        if (typeof item === "object") return Object.keys(item).length > 0;
        return true;
      }),
    ) as Partial<T>;
  }

  #findFirstResolvedFrame(frames: StackFrame[]): StackFrame | undefined {
    return frames.find((frame) => !frame.asyncBoundary && Boolean(frame.originalSource));
  }

  #findFirstResolvedCdpFrame(stack: CdpStackTrace): StackFrame | undefined {
    const frame = stack.callFrames?.find((callFrame) => Boolean(callFrame.originalSource));
    if (frame) {
      return frame;
    }
    return stack.parent ? this.#findFirstResolvedCdpFrame(stack.parent) : undefined;
  }

  #promoteStackFrameLocation(
    target: {
      originalSource?: string;
      originalLine?: number;
      originalColumn?: number;
      originalName?: string;
      sourceSnippet?: StackFrame["sourceSnippet"];
    },
    frame: StackFrame | undefined,
  ): void {
    if (!frame) {
      return;
    }

    // Console API entries and some network initiators only expose location via
    // stack frames. Promote the resolved frame so item-level renderers can use
    // the source-mapped location directly instead of knowing stack internals.
    if (!target.originalSource) {
      target.originalSource = frame.originalSource;
      target.originalLine = frame.originalLine;
      target.originalColumn = frame.originalColumn;
    }
    if (!target.sourceSnippet && frame.sourceSnippet) {
      target.sourceSnippet = frame.sourceSnippet;
    }
    if (!target.originalName && frame.originalName) {
      target.originalName = frame.originalName;
    }
  }

  #resolveCdpStack(
    resolver: SourceMapResolver,
    diagnostics: SourceMapDiagnostic[],
    stack: CdpStackTrace,
  ): void {
    if (stack.callFrames) {
      for (const frame of stack.callFrames) {
        if (!frame.url) {
          continue;
        }
        this.#resolveLocation(
          resolver,
          diagnostics,
          frame,
          frame.url,
          this.#getSourceMapResolveUrl(frame) || frame.url,
          frame.lineNumber || 0,
          frame.columnNumber || 0,
        );
      }
    }

    if (stack.parent) {
      this.#resolveCdpStack(resolver, diagnostics, stack.parent);
    }
  }

  #resolveLocation(
    resolver: SourceMapResolver,
    diagnostics: SourceMapDiagnostic[],
    target: SourceMapLocationTarget,
    artifactUrl: string,
    resolveUrl: string,
    line: number,
    column: number,
  ): void {
    const result = resolver.resolveWithStatus(resolveUrl, line, column);
    if (result.status === "mapped" && result.location) {
      this.#applyResolvedLocation(target, result);
      return;
    }

    const diagnostic = this.#findSourceMapDiagnostic(diagnostics, resolveUrl, artifactUrl);
    if (result.status === "no-map-for-generated-url" && !diagnostic) {
      return;
    }

    const reason: SourceMapFrameStatus["reason"] =
      result.status === "no-map-for-generated-url" && diagnostic?.reason
        ? diagnostic.reason
        : (result.status as SourceMapFrameStatus["reason"]);
    target.sourceMapStatus = {
      status: "unresolved",
      reason,
      sourceMapUrl: diagnostic?.sourceMapUrl,
      httpStatusCode: diagnostic?.httpStatusCode,
    };
  }

  #applyResolvedLocation(target: SourceMapLocationTarget, result: SourceMapResolveResult): void {
    const resolved = result.location;
    if (!resolved) return;
    target.originalSource = resolved.source ?? undefined;
    target.originalLine = resolved.line;
    target.originalColumn = resolved.column;
    target.sourceSnippet = resolved.sourceSnippet;
    if (resolved.name) {
      target.originalName = resolved.name;
    }
    target.sourceMapStatus = undefined;
  }

  #findSourceMapDiagnostic(
    diagnostics: SourceMapDiagnostic[],
    resolveUrl: string,
    artifactUrl: string,
  ): SourceMapDiagnostic | undefined {
    const candidateKeys = new Set([
      ...getSourceMapUrlKeys(resolveUrl),
      ...getSourceMapUrlKeys(artifactUrl),
    ]);
    return diagnostics.find((diagnostic) =>
      getSourceMapUrlKeys(diagnostic.generatedUrl).some((key) => candidateKeys.has(key)),
    );
  }

  #getSourceMapResolveUrl(value: object): string | undefined {
    const raw = (value as Record<string, unknown>)[SOURCE_MAP_RESOLVE_URL_PROPERTY];
    return typeof raw === "string" && raw ? raw : undefined;
  }
}
