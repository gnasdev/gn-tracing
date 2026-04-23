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
  names?: string[];
  mappings: string;
  sourceRoot?: string;
}

export interface ResolvedLocation {
  source: string | null;
  line: number;
  column: number;
  name: string | null;
}
