/**
 * Recording artifact models used by capture, storage, upload, and replay flows.
 */
export interface SerializedRemoteObject {
  type: string;
  subtype?: string;
  value?: unknown;
  description?: string;
  className?: string;
  preview?: ObjectPreview;
}

export interface ObjectPreview {
  type: string;
  subtype?: string;
  description?: string;
  overflow?: boolean;
  properties?: PreviewProperty[];
  entries?: PreviewEntry[];
}

export interface PreviewProperty {
  name: string;
  type: string;
  value?: string;
  subtype?: string;
  valuePreview?: ObjectPreview;
}

export interface PreviewEntry {
  key?: ObjectPreview;
  value: ObjectPreview;
}

export interface SourceCodeSnippet {
  source: string;
  startLine: number;
  line: number;
  column?: number;
  lines: string[];
  truncated?: boolean;
}

export type SourceMapDiagnosticStatus = "pending" | "success" | "failed" | "skipped";

export type SourceMapDiagnosticReason =
  | "pending-frame-id"
  | "missing-frame-id"
  | "unsupported-target"
  | "unsupported-url"
  | "too-large"
  | "network-failed"
  | "http-error"
  | "stream-read-failed"
  | "html-fallback"
  | "non-json-response"
  | "json-parse-failed"
  | "unsupported-map"
  | "no-map-for-generated-url"
  | "no-generated-line"
  | "no-segment-for-column"
  | "no-original-segment";

export type SourceMapResolveStatus =
  | "mapped"
  | "no-map-for-generated-url"
  | "no-generated-line"
  | "no-segment-for-column"
  | "no-original-segment";

export interface SourceMapDiagnostic {
  generatedUrl: string;
  sourceMapUrl: string;
  sourceType: "inline" | "external";
  targetType: string;
  sessionId?: string;
  executionContextId?: number;
  frameId?: string;
  status: SourceMapDiagnosticStatus;
  reason?: SourceMapDiagnosticReason;
  httpStatusCode?: number;
  netError?: string;
  byteSize?: number;
  sourcesCount?: number;
  hasSourcesContent?: boolean;
}

export interface SourceMapDiagnosticsArtifact {
  schemaVersion: 1;
  generatedAt: string;
  sourceMaps: SourceMapDiagnostic[];
}

export interface SourceMapFrameStatus {
  status: "unresolved";
  reason: Exclude<SourceMapResolveStatus, "mapped"> | SourceMapDiagnosticReason;
  sourceMapUrl?: string;
  httpStatusCode?: number;
}

export interface SourceMapResolveResult {
  status: SourceMapResolveStatus;
  location?: ResolvedLocation;
}

/**
 * Recording artifact data models.
 *
 * These interfaces describe the serialized console, network, WebSocket, and
 * source-map-enriched records that move from CDP collection into JSON artifacts
 * and finally into the replay player.
 */
export interface StackFrame {
  functionName: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
  asyncBoundary?: string;
  originalSource?: string;
  originalLine?: number;
  originalColumn?: number;
  originalName?: string;
  sourceSnippet?: SourceCodeSnippet;
  sourceMapStatus?: SourceMapFrameStatus;
}

export interface ConsoleEntry {
  source: "console-api" | "exception" | "browser";
  level: string;
  timestamp: number;
  message?: string;
  args?: SerializedRemoteObject[];
  stackTrace?: StackFrame[];
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
  originalSource?: string;
  originalLine?: number;
  originalColumn?: number;
  originalName?: string;
  sourceSnippet?: SourceCodeSnippet;
  sourceMapStatus?: SourceMapFrameStatus;
}

export interface NetworkEntry {
  requestId: string;
  url: string;
  method: string;
  requestHeaders: Record<string, string> | null;
  requestHeadersExtra?: Record<string, string> | null;
  postData: string | null;
  timestamp: number;
  wallTime: number;
  initiator: NetworkInitiator | null;
  resourceType: string;
  status: number | null;
  statusText: string | null;
  responseHeaders: Record<string, string> | null;
  responseHeadersExtra?: Record<string, string> | null;
  earlyHintsHeaders?: Record<string, string> | null;
  mimeType: string | null;
  timing: NetworkTiming | null;
  protocol: string | null;
  remoteIPAddress: string | null;
  encodedDataLength: number;
  error: string | null;
  responseBody: ResponseBody | null;
  redirectChain: RedirectEntry[] | null;
  servedFromCache?: boolean;
  canceled?: boolean;
}

export interface NetworkInitiator {
  type?: string;
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
  stack?: CdpStackTrace;
  originalSource?: string;
  originalLine?: number;
  originalColumn?: number;
  originalName?: string;
  sourceMapStatus?: SourceMapFrameStatus;
}

export interface CdpStackTrace {
  callFrames: CdpCallFrame[];
  parent?: CdpStackTrace;
  description?: string;
}

export interface CdpCallFrame {
  functionName: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
  originalSource?: string;
  originalLine?: number;
  originalColumn?: number;
  originalName?: string;
  sourceMapStatus?: SourceMapFrameStatus;
}

export interface NetworkTiming {
  dnsStart: number;
  dnsEnd: number;
  connectStart: number;
  connectEnd: number;
  sslStart: number;
  sslEnd: number;
  sendStart: number;
  sendEnd: number;
  receiveHeadersEnd: number;
}

export interface ResponseBody {
  body: string;
  base64Encoded: boolean;
}

export interface RedirectEntry {
  url: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
}

export interface WebSocketEntry {
  requestId: string;
  url: string;
  initiator?: NetworkInitiator;
  frames: WebSocketFrame[];
  closed: boolean;
}

export interface WebSocketFrame {
  direction: "sent" | "received";
  timestamp: number;
  opcode: number;
  payloadData: string;
}

export interface SourceMapRaw {
  version: number;
  sources?: string[];
  sourcesContent?: Array<string | null>;
  names?: string[];
  mappings?: string;
  sourceRoot?: string;
  sections?: SourceMapSection[];
}

export interface SourceMapSection {
  offset: {
    line: number;
    column: number;
  };
  map?: SourceMapRaw;
  url?: string;
}

export interface ResolvedLocation {
  source: string | null;
  line: number;
  column: number;
  name: string | null;
  sourceSnippet?: SourceCodeSnippet;
}

export interface CaptureViewport {
  width: number;
  height: number;
  devicePixelRatio: number;
}

export interface CaptureScreen {
  width: number;
  height: number;
}

export interface CaptureEnvironment {
  extensionVersion: string;
  userAgent: string;
  language: string;
  timezone: string;
  browserName?: string;
  browserVersion?: string;
  viewport?: CaptureViewport;
  screen?: CaptureScreen;
}

export interface RecordingReport {
  schemaVersion: 1;
  title: string;
  description?: string;
  expected?: string;
  actual?: string;
  severity?: "low" | "medium" | "high" | "critical";
  reference?: string;
  source: "extension";
  createdAt: string;
  page: {
    url: string;
    title?: string;
  };
  environment: CaptureEnvironment;
}

export type RecordingUserEvent =
  | {
      type: "navigation";
      timestamp: number;
      url: string;
      title?: string;
    }
  | {
      type: "click";
      timestamp: number;
      selector?: string;
      text?: string;
      role?: string;
      x?: number;
      y?: number;
    }
  | {
      type: "focus";
      timestamp: number;
      selector?: string;
      inputType?: string;
    }
  | {
      type: "submit";
      timestamp: number;
      selector?: string;
    };

export interface RecordingUserEventArtifact {
  schemaVersion: 1;
  events: RecordingUserEvent[];
}

export type RedactionArtifact =
  | "headers"
  | "url"
  | "body"
  | "console"
  | "websocket"
  | "events"
  | "report"
  | "visual";

export type RedactionClass =
  | "credential"
  | "personal"
  | "payment"
  | "location"
  | "opaque-id"
  | "custom";

export type RedactionAction = "redacted" | "removed" | "masked" | "truncated" | "skipped";

export interface RedactionHit {
  artifact: RedactionArtifact;
  class: RedactionClass;
  action: RedactionAction;
  field?: string;
  ruleId: string;
}

export interface RecordingPrivacySummary {
  schemaVersion: 1;
  policyVersion: 1;
  profile: string;
  createdAt: string;
  artifactFlags: {
    video: boolean;
    screenshot: boolean;
    report: boolean;
    events: boolean;
    console: boolean;
    network: boolean;
    websocket: boolean;
    requestBodies: boolean;
    responseBodies: boolean;
    websocketPayloads: boolean;
    sourceSnippets: boolean;
  };
  counts: Array<{
    artifact: RedactionArtifact;
    class: RedactionClass;
    action: RedactionAction;
    count: number;
  }>;
  limitations: string[];
}
