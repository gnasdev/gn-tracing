/**
 * Test data factories.
 *
 * Construct valid domain objects with sensible defaults and override hooks so
 * tests stay readable and property generators have building blocks to compose.
 *
 * The privacy factories moved to `packages/replay-core/src/testing/factories.ts`
 * alongside the redaction policy they build inputs for; they are re-exported
 * here so extension tests keep one import path.
 */
import type { NetworkEntry } from "../packages/replay-core/src/schema/capture";
import type { RecordingTabLike } from "../src/shared/recording-target";

export {
  makeHeaderMap,
  makePrivacySettings,
} from "../packages/replay-core/src/testing/factories";

/**
 * Build a valid {@link RecordingTabLike} that passes recording-target
 * validation by default (numeric id + recordable https URL). Pass `overrides`
 * to construct edge cases such as missing ids or unsupported URLs.
 */
export function makeTab(overrides?: Partial<RecordingTabLike>): RecordingTabLike {
  return {
    id: 1,
    url: "https://example.com/",
    ...overrides,
  };
}

/** Minimal network entry for storage/player tests. */
export function makeNetworkEntry(overrides?: Partial<NetworkEntry>): NetworkEntry {
  return {
    requestId: "req-1",
    url: "https://api.example.com/items",
    method: "GET",
    requestHeaders: null,
    postData: null,
    timestamp: 1,
    wallTime: 1,
    initiator: null,
    resourceType: "XHR",
    status: 200,
    statusText: "OK",
    responseHeaders: { "content-type": "application/json" },
    mimeType: "application/json",
    timing: null,
    protocol: "h2",
    remoteIPAddress: null,
    encodedDataLength: 12,
    error: null,
    responseBody: { body: '{"ok":true}', base64Encoded: false },
    redirectChain: null,
    ...overrides,
  };
}

/** CDP-shaped params for Network.requestWillBeSent. */
export function makeCdpRequestWillBeSent(args?: {
  requestId?: string;
  url?: string;
  method?: string;
  type?: string;
  timestamp?: number;
  wallTime?: number;
}) {
  return {
    requestId: args?.requestId ?? "req-1",
    request: {
      url: args?.url ?? "https://api.example.com/items",
      method: args?.method ?? "GET",
      headers: {},
    },
    timestamp: args?.timestamp ?? 1,
    wallTime: args?.wallTime ?? 1_700_000_000,
    type: args?.type ?? "XHR",
    initiator: { type: "script" },
  };
}

/** CDP-shaped params for Network.responseReceived. */
export function makeCdpResponseReceived(args?: {
  requestId?: string;
  status?: number;
  mimeType?: string | null;
  headers?: Record<string, string>;
}) {
  return {
    requestId: args?.requestId ?? "req-1",
    response: {
      status: args?.status ?? 200,
      statusText: "OK",
      mimeType: args?.mimeType === undefined ? "application/json" : args.mimeType,
      headers: args?.headers ?? { "content-type": "application/json" },
      protocol: "h2",
      timing: {
        requestTime: 1,
        proxyStart: -1,
        proxyEnd: -1,
        dnsStart: 0,
        dnsEnd: 1,
        connectStart: 1,
        connectEnd: 2,
        sslStart: 1,
        sslEnd: 2,
        workerStart: -1,
        workerReady: -1,
        sendStart: 2,
        sendEnd: 2,
        receiveHeadersEnd: 5,
      },
    },
  };
}

/** CDP-shaped params for Network.loadingFinished. */
export function makeCdpLoadingFinished(args?: { requestId?: string; encodedDataLength?: number }) {
  return {
    requestId: args?.requestId ?? "req-1",
    encodedDataLength: args?.encodedDataLength ?? 42,
    timestamp: 2,
  };
}

/** CDP-shaped params for Network.loadingFailed. */
export function makeCdpLoadingFailed(args?: {
  requestId?: string;
  errorText?: string;
  canceled?: boolean;
}) {
  return {
    requestId: args?.requestId ?? "req-1",
    errorText: args?.errorText ?? "net::ERR_FAILED",
    canceled: args?.canceled ?? false,
    timestamp: 2,
  };
}
