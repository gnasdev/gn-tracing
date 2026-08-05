/**
 * Apply shared privacy-redaction policy to in-page / non-CDP evidence rows.
 *
 * The service worker used to own parallel field transforms for Instant Replay
 * and Firefox ingest. Those transforms already called `redactUrl` / headers /
 * body / JSON helpers; this module is that adapter only — policy lives in
 * `privacy-redaction` (replay-core).
 */

import type { PrivacyRedactionSettings } from "../types/messages";
import type {
  CookieRecord,
  NetworkEntry,
  RedactionHit,
  StorageKeyValue,
  StorageSnapshot,
  WebSocketEntry,
} from "../types/recording";
import {
  REDACTED_VALUE,
  redactBodyText,
  redactHeaderMap,
  redactJsonValue,
  redactUrl,
} from "./privacy-redaction";

export type RedactionHitSink = (hits: RedactionHit[] | undefined) => void;

/**
 * Redacts a network row from page instrumentation (URL, headers, postData).
 * Mutates and returns the same entry for storage-path convenience.
 */
export function redactInPageNetworkEntry(
  entry: NetworkEntry,
  settings: PrivacyRedactionSettings,
  onHits: RedactionHitSink = () => {},
): NetworkEntry {
  const urlResult = redactUrl(entry.url, settings, "url", "network.request.url");
  onHits(urlResult.applied);
  entry.url = urlResult.value || entry.url;

  if (entry.requestHeaders) {
    const headers = redactHeaderMap(entry.requestHeaders, settings, "headers");
    onHits(headers.applied);
    entry.requestHeaders = headers.value;
  }
  if (entry.responseHeaders) {
    const headers = redactHeaderMap(entry.responseHeaders, settings, "headers");
    onHits(headers.applied);
    entry.responseHeaders = headers.value;
  }
  if (entry.postData != null && settings.redactRequestBodyFields) {
    const body = redactBodyText(
      entry.postData,
      settings,
      "body",
      "network.request.postData",
      "body",
    );
    onHits(body.applied);
    entry.postData = body.value;
  }
  return entry;
}

function redactInPageWebSocketPayload(
  payload: string,
  settings: PrivacyRedactionSettings,
  onHits: RedactionHitSink,
): string {
  if (settings.redactWebSocketPayloads === "all") {
    onHits([
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
  if (settings.redactWebSocketPayloads === "sensitive-fields") {
    const redaction = redactBodyText(
      payload,
      settings,
      "websocket",
      "websocket.payload",
      "websocket",
    );
    onHits(redaction.applied);
    return redaction.value || "";
  }
  return payload;
}

/** Redacts a WebSocket entry from page instrumentation (URL + frame payloads). */
export function redactInPageWebSocketEntry(
  entry: WebSocketEntry,
  settings: PrivacyRedactionSettings,
  onHits: RedactionHitSink = () => {},
): WebSocketEntry {
  const urlResult = redactUrl(entry.url, settings, "websocket", "websocket.url");
  onHits(urlResult.applied);
  entry.url = urlResult.value || entry.url;
  entry.frames = entry.frames.map((frame) => ({
    ...frame,
    payloadData: redactInPageWebSocketPayload(frame.payloadData, settings, onHits),
  }));
  return entry;
}

function redactInPageStorageItems(
  items: StorageKeyValue[],
  fieldPrefix: string,
  settings: PrivacyRedactionSettings,
  onHits: RedactionHitSink,
): StorageKeyValue[] {
  return items.map((item) => {
    // Wrap as `{ [key]: value }` so the shared policy classifies the storage key
    // by name and still applies value-based rules (same pattern as cdp-manager).
    const result = redactJsonValue(
      { [item.key]: item.value },
      settings,
      "storage",
      fieldPrefix,
      "body",
    );
    if (result.applied.length > 0) {
      onHits(result.applied);
    }
    const redactedValue = (result.value as Record<string, unknown>)[item.key];
    return {
      key: item.key,
      value: typeof redactedValue === "string" ? redactedValue : String(redactedValue),
      redacted: result.applied.length > 0 ? true : item.redacted,
    };
  });
}

function redactInPageCookie(
  cookie: CookieRecord,
  settings: PrivacyRedactionSettings,
  onHits: RedactionHitSink,
): CookieRecord {
  const result = redactJsonValue(
    { [cookie.name]: cookie.value },
    settings,
    "storage",
    "storage.cookies",
    "body",
  );
  if (result.applied.length > 0) {
    onHits(result.applied);
  }
  const redactedValue = (result.value as Record<string, unknown>)[cookie.name];
  return {
    ...cookie,
    value: typeof redactedValue === "string" ? redactedValue : String(redactedValue),
    redacted: result.applied.length > 0 ? true : cookie.redacted,
  };
}

/**
 * Redacts a storage snapshot from page instrumentation, honoring
 * `redactStorageValues` the same way the CDP storage-capture path does.
 */
export function redactInPageStorageSnapshot(
  snapshot: StorageSnapshot,
  settings: PrivacyRedactionSettings,
  options: { redactStorageValues?: boolean; onHits?: RedactionHitSink } = {},
): StorageSnapshot {
  const onHits = options.onHits ?? (() => {});
  const redactValues = options.redactStorageValues ?? true;
  if (!redactValues) {
    return snapshot;
  }
  snapshot.localStorage = redactInPageStorageItems(
    snapshot.localStorage,
    "storage.localStorage",
    settings,
    onHits,
  );
  snapshot.sessionStorage = redactInPageStorageItems(
    snapshot.sessionStorage,
    "storage.sessionStorage",
    settings,
    onHits,
  );
  snapshot.cookies = snapshot.cookies.map((cookie) => redactInPageCookie(cookie, settings, onHits));
  return snapshot;
}
