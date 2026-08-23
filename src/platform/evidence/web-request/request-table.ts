/**
 * Correlate `webRequest` events into one `NetworkEntry` per `requestId`.
 *
 * `webRequest` reports one request as a sequence of events over time
 * (onBeforeRequest -> onSendHeaders -> onHeadersReceived -> onCompleted, or
 * -> onErrorOccurred), each carrying a different slice of the same request. A
 * `NetworkEntry` is one row with everything filled in, so this table holds
 * partial rows keyed by `requestId` until they are complete enough to emit,
 * the same shape CDP's own request/response pairing needs and that
 * `cdp-manager.ts` already solves for the CDP path.
 *
 * Kept framework-free (no chrome.* calls) so it is testable with plain event
 * payload fixtures.
 */

import type {
  NetworkEntry,
  NetworkInitiator,
} from "../../../../packages/replay-core/src/schema/capture";
import { toCdpResourceType } from "./resource-type";

export interface WebRequestBeforeRequestDetails {
  requestId: string;
  url: string;
  method: string;
  type: string;
  timeStamp: number;
  frameId: number;
  originUrl?: string;
  documentUrl?: string;
}

export interface WebRequestSendHeadersDetails {
  requestId: string;
  requestHeaders?: Array<{ name: string; value?: string }>;
}

export interface WebRequestHeadersReceivedDetails {
  requestId: string;
  statusCode: number;
  statusLine?: string;
  responseHeaders?: Array<{ name: string; value?: string }>;
}

export interface WebRequestCompletedDetails extends WebRequestHeadersReceivedDetails {
  fromCache?: boolean;
  ip?: string;
}

export interface WebRequestErrorDetails {
  requestId: string;
  error: string;
  timeStamp: number;
}

function headersToRecord(headers: Array<{ name: string; value?: string }> | undefined) {
  if (!headers) {
    return null;
  }
  const record: Record<string, string> = {};
  for (const header of headers) {
    if (header.value != null) {
      record[header.name] = header.value;
    }
  }
  return record;
}

/**
 * Header lookup is case-insensitive: HTTP header names are, and `webRequest`
 * preserves whatever case the server sent (commonly title-case, e.g.
 * `Content-Type`), unlike this codebase's other convention of lowercasing keys.
 */
function readMimeType(headers: Record<string, string> | null): string | null {
  if (!headers) {
    return null;
  }
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "content-type") {
      return value.split(";")[0]?.trim() ?? null;
    }
  }
  return null;
}

/** One request's accumulated state, mutated as more events arrive. */
class PendingRequest {
  requestId = "";
  url = "";
  method = "";
  resourceType = "Other";
  startedAtMs = 0;
  requestHeaders: Record<string, string> | null = null;
  statusCode: number | null = null;
  statusText: string | null = null;
  responseHeaders: Record<string, string> | null = null;
  servedFromCache = false;
  remoteIPAddress: string | null = null;
  initiator: NetworkInitiator | null = null;
  error: string | null = null;

  toEntry(): NetworkEntry {
    return {
      requestId: this.requestId,
      url: this.url,
      method: this.method,
      requestHeaders: this.requestHeaders,
      postData: null,
      // webRequest gives epoch milliseconds; CDP's field is documented as
      // MonotonicTime (seconds since browser process start). The two are not
      // the same clock, so this stays in the epoch-second field the schema
      // already carries rather than being coerced into a meaning it is not.
      timestamp: this.startedAtMs / 1000,
      wallTime: this.startedAtMs / 1000,
      initiator: this.initiator,
      resourceType: this.resourceType,
      status: this.statusCode,
      statusText: this.statusText,
      responseHeaders: this.responseHeaders,
      mimeType: readMimeType(this.responseHeaders),
      timing: null,
      protocol: null,
      remoteIPAddress: this.remoteIPAddress,
      encodedDataLength: 0,
      error: this.error,
      // webRequest has no body-reading API; that gap is declared in
      // FIREFOX_EXTENSION_CAPABILITIES / the collector's limitations, not
      // papered over here.
      responseBody: null,
      redirectChain: null,
      servedFromCache: this.servedFromCache,
    };
  }
}

export class WebRequestTable {
  readonly #pending = new Map<string, PendingRequest>();

  onBeforeRequest(details: WebRequestBeforeRequestDetails): void {
    const row = new PendingRequest();
    row.requestId = details.requestId;
    row.url = details.url;
    row.method = details.method;
    row.resourceType = toCdpResourceType(details.type);
    row.startedAtMs = details.timeStamp;
    const originUrl = details.originUrl || details.documentUrl;
    if (originUrl) {
      row.initiator = { type: "script", url: originUrl };
    }
    this.#pending.set(details.requestId, row);
  }

  onSendHeaders(details: WebRequestSendHeadersDetails): void {
    const row = this.#pending.get(details.requestId);
    if (!row) {
      return;
    }
    row.requestHeaders = headersToRecord(details.requestHeaders);
  }

  onHeadersReceived(details: WebRequestHeadersReceivedDetails): void {
    const row = this.#pending.get(details.requestId);
    if (!row) {
      return;
    }
    row.statusCode = details.statusCode;
    row.statusText = details.statusLine ?? null;
    row.responseHeaders = headersToRecord(details.responseHeaders);
  }

  /** Terminal event: finalize the row and return it for the caller to emit. */
  onCompleted(details: WebRequestCompletedDetails): NetworkEntry | null {
    const row = this.#pending.get(details.requestId);
    if (!row) {
      return null;
    }
    this.#pending.delete(details.requestId);
    row.statusCode = details.statusCode;
    row.statusText = details.statusLine ?? row.statusText;
    if (details.responseHeaders) {
      row.responseHeaders = headersToRecord(details.responseHeaders);
    }
    row.servedFromCache = details.fromCache ?? false;
    row.remoteIPAddress = details.ip ?? null;
    return row.toEntry();
  }

  /** Terminal event: a request that never completed. Still worth a row. */
  onErrorOccurred(details: WebRequestErrorDetails): NetworkEntry | null {
    const row = this.#pending.get(details.requestId);
    if (!row) {
      return null;
    }
    this.#pending.delete(details.requestId);
    row.error = details.error;
    return row.toEntry();
  }

  /** Requests still in flight when the collector detaches. */
  drainIncomplete(): NetworkEntry[] {
    const rows = Array.from(this.#pending.values(), (row) => row.toEntry());
    this.#pending.clear();
    return rows;
  }

  get pendingCount(): number {
    return this.#pending.size;
  }
}
