/**
 * Recording artifact models used by capture, storage, upload, and replay flows.
 *
 * These are the *strict* producer-side models: the shape a producer must emit.
 * The reader in `../views.ts` stays deliberately permissive because it parses
 * packages written by any shipped version, but both sides now name the same
 * types, so a producer change that breaks replay is a type error rather than a
 * runtime surprise.
 *
 * Every producer shares this file — the extension (`src/`), the browser SDK
 * (`packages/sdk/`), and the package writer in `../write/`. Nothing here may
 * reference `chrome.*` or the DOM.
 */
export interface SerializedRemoteObject {
  type: string;
  subtype?: string;
  value?: unknown;
  description?: string;
  className?: string;
  preview?: ObjectPreview;
  stackTrace?: StackFrame[];
}

export interface ObjectPreview {
  type: string;
  subtype?: string;
  description?: string;
  overflow?: boolean;
  properties?: PreviewProperty[];
  entries?: PreviewEntry[];
}

interface PreviewProperty {
  name: string;
  type: string;
  value?: string;
  subtype?: string;
  valuePreview?: ObjectPreview;
}

interface PreviewEntry {
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

type SourceMapDiagnosticStatus = "pending" | "success" | "failed" | "skipped";

type SourceMapDiagnosticReason =
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

type SourceMapResolveStatus =
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
  /** Epoch milliseconds. */
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
  /** CDP Network.MonotonicTime: seconds since browser process start. */
  timestamp: number;
  /** Epoch seconds (wall clock). */
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

interface CdpCallFrame {
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

interface NetworkTiming {
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

interface ResponseBody {
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

interface WebSocketFrame {
  direction: "sent" | "received";
  /** Epoch milliseconds. Legacy packages may still carry CDP monotonic seconds. */
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

interface SourceMapSection {
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

interface CaptureViewport {
  width: number;
  height: number;
  devicePixelRatio: number;
}

interface CaptureScreen {
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
      /** CSS viewport size at event time (for accurate replay mapping). */
      viewportWidth?: number;
      viewportHeight?: number;
    }
  | {
      type: "contextmenu";
      timestamp: number;
      selector?: string;
      text?: string;
      role?: string;
      x?: number;
      y?: number;
      viewportWidth?: number;
      viewportHeight?: number;
    }
  | {
      type: "scroll";
      timestamp: number;
      selector?: string;
      x?: number;
      y?: number;
      direction: "up" | "down";
      deltaY?: number;
      viewportWidth?: number;
      viewportHeight?: number;
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
    }
  | {
      type: "key";
      timestamp: number;
      key: string;
      code?: string;
      ctrlKey?: boolean;
      altKey?: boolean;
      shiftKey?: boolean;
      metaKey?: boolean;
      selector?: string;
    };

export interface RecordingUserEventArtifact {
  schemaVersion: 1;
  events: RecordingUserEvent[];
}

export interface RecordingDrawPoint {
  x: number;
  y: number;
  /** Milliseconds offset from the stroke start timestamp. */
  t: number;
}

export interface RecordingDrawStroke {
  /** Unique id, useful for debugging/deduplication. */
  strokeId: string;
  /** Epoch ms — start of the stroke (pointerdown). */
  timestamp: number;
  color: string;
  width: number;
  points: RecordingDrawPoint[];
}

export interface RecordingDrawingArtifact {
  schemaVersion: 1;
  strokes: RecordingDrawStroke[];
  /** Epoch ms timestamps when the overlay canvas was cleared (e.g. Esc/undraw). */
  clears?: number[];
}

export type RedactionArtifact =
  | "headers"
  | "url"
  | "body"
  | "console"
  | "websocket"
  | "events"
  | "report"
  | "visual"
  | "storage"
  | "dom";

export type RedactionClass =
  | "credential"
  | "personal"
  | "payment"
  | "location"
  | "opaque-id"
  | "custom";

type RedactionAction = "redacted" | "removed" | "masked" | "truncated" | "skipped";

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
    storage: boolean;
    dom: boolean;
  };
  counts: Array<{
    artifact: RedactionArtifact;
    class: RedactionClass;
    action: RedactionAction;
    count: number;
  }>;
  limitations: string[];
}

export interface StorageKeyValue {
  key: string;
  value: string;
  redacted?: boolean;
}

export interface CookieRecord {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  size?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  redacted?: boolean;
}

export interface StorageSnapshot {
  phase: "start" | "stop";
  capturedAt: number;
  localStorage: StorageKeyValue[];
  sessionStorage: StorageKeyValue[];
  cookies: CookieRecord[];
}

export interface StorageArtifact {
  schemaVersion: 1;
  snapshots: StorageSnapshot[];
}
export interface DomNode {
  nodeType: number;
  nodeName: string;
  nodeValue?: string;
  attributes?: Record<string, string>;
  children?: DomNode[];
  masked?: boolean;
}

export interface DomSnapshot {
  label: "start" | "stop" | string;
  capturedAt: number;
  documentUrl: string;
  root: DomNode;
}

export interface DomArtifact {
  schemaVersion: 1;
  snapshots: DomSnapshot[];
}
