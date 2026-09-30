/**
 * Response body capture via page-script fetch/XHR — the chosen alternative to
 * webRequest.filterResponseData(), which needs the "webRequestBlocking"
 * permission that Manifest V3 rejects outright ("requires manifest version of
 * 2 or lower"). Reading a body the page's own fetch/XHR already produced has
 * no such permission and no stream-hang risk: nothing is inserted into a real
 * network stream.
 *
 * Real behaviour, not source text: a real `Response` and a real `XMLHttpRequest`
 * shim drive `installFetchCapture` / `installXhrCapture`.
 */
import { describe, expect, it } from "vitest";
import type {
  ConsoleEntry,
  NetworkEntry,
  StorageSnapshot,
  WebSocketEntry,
} from "../schema/capture";
import { type InPageCaptureScope, installInPageCapture } from "./in-page-capture";

type CapturedEntry = ConsoleEntry | NetworkEntry | WebSocketEntry | StorageSnapshot;

function makeScope(overrides: Partial<InPageCaptureScope> = {}): InPageCaptureScope {
  return {
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} } as unknown as Console,
    fetch: undefined,
    XMLHttpRequest: undefined,
    ...overrides,
  };
}

/** A minimal Fetch Response double, real enough for `.clone()` and `.text()`. */
function fakeResponse(body: string, headers: Record<string, string>, status = 200): Response {
  return new Response(body, { status, headers });
}

describe("response body capture (fetch)", () => {
  it("attaches a text body when eligible and mode is not off", async () => {
    const captured: CapturedEntry[] = [];
    const scope = makeScope({
      fetch: (async () =>
        fakeResponse('{"ok":true}', { "content-type": "application/json" })) as typeof fetch,
    });

    const cleanup = installInPageCapture(
      scope,
      "s1",
      (_sid, _kind, entry) => captured.push(entry),
      {
        responseBodyMode: "eligible",
      },
    );

    await scope.fetch?.("https://example.com/api");
    // The body read is a second microtask hop after the metadata entry.
    await new Promise((r) => setTimeout(r, 0));
    cleanup();

    const networkEntries = captured.filter((e): e is NetworkEntry => "requestId" in e);
    expect(networkEntries).toHaveLength(2); // metadata row, then the body-bearing row
    expect(networkEntries[1]?.responseBody).toEqual({ body: '{"ok":true}', base64Encoded: false });
  });

  it("does not read the body when mode is off (the default)", async () => {
    const captured: CapturedEntry[] = [];
    const scope = makeScope({
      fetch: (async () => fakeResponse("secret", { "content-type": "text/plain" })) as typeof fetch,
    });

    const cleanup = installInPageCapture(scope, "s1", (_sid, _kind, entry) => captured.push(entry));
    await scope.fetch?.("https://example.com/");
    await new Promise((r) => setTimeout(r, 0));
    cleanup();

    const networkEntries = captured.filter((e): e is NetworkEntry => "requestId" in e);
    expect(networkEntries).toHaveLength(1);
    expect(networkEntries[0]?.responseBody).toBeNull();
  });

  it("does not read an ineligible MIME type even when mode is eligible", async () => {
    const captured: CapturedEntry[] = [];
    const scope = makeScope({
      fetch: (async () =>
        fakeResponse("binarydata", { "content-type": "application/octet-stream" })) as typeof fetch,
    });

    const cleanup = installInPageCapture(
      scope,
      "s1",
      (_sid, _kind, entry) => captured.push(entry),
      {
        responseBodyMode: "eligible",
      },
    );
    await scope.fetch?.("https://example.com/file.bin");
    await new Promise((r) => setTimeout(r, 0));
    cleanup();

    const networkEntries = captured.filter((e): e is NetworkEntry => "requestId" in e);
    expect(networkEntries).toHaveLength(1);
    expect(networkEntries[0]?.responseBody).toBeNull();
  });

  it("respects maxResponseBodyBytes and skips oversized bodies", async () => {
    const captured: CapturedEntry[] = [];
    const bigBody = "x".repeat(100);
    const scope = makeScope({
      fetch: (async () =>
        fakeResponse(bigBody, {
          "content-type": "text/plain",
          "content-length": String(bigBody.length),
        })) as typeof fetch,
    });

    const cleanup = installInPageCapture(
      scope,
      "s1",
      (_sid, _kind, entry) => captured.push(entry),
      {
        responseBodyMode: "eligible",
        maxResponseBodyBytes: 10,
      },
    );
    await scope.fetch?.("https://example.com/big");
    await new Promise((r) => setTimeout(r, 0));
    cleanup();

    const networkEntries = captured.filter((e): e is NetworkEntry => "requestId" in e);
    expect(networkEntries).toHaveLength(1); // only the metadata row
    expect(networkEntries[0]?.responseBody).toBeNull();
  });

  it("delivers the metadata row even if the body read later fails", async () => {
    const captured: CapturedEntry[] = [];
    const brokenResponse = fakeResponse("ok", { "content-type": "text/plain" });
    // Force the clone's text() to reject, simulating an unreadable stream.
    const original = brokenResponse.clone.bind(brokenResponse);
    brokenResponse.clone = () => {
      const clone = original();
      clone.text = () => Promise.reject(new Error("stream error"));
      return clone;
    };
    const scope = makeScope({ fetch: (async () => brokenResponse) as typeof fetch });

    const cleanup = installInPageCapture(
      scope,
      "s1",
      (_sid, _kind, entry) => captured.push(entry),
      {
        responseBodyMode: "eligible",
      },
    );
    await scope.fetch?.("https://example.com/");
    await new Promise((r) => setTimeout(r, 0));
    cleanup();

    const networkEntries = captured.filter((e): e is NetworkEntry => "requestId" in e);
    expect(networkEntries).toHaveLength(1);
    expect(networkEntries[0]?.status).toBe(200);
  });

  it("does not consume the response body the page's own code still needs", async () => {
    // The whole point of response.clone(): the page must still be able to
    // read the real response after capture has looked at a copy of it.
    const scope = makeScope({
      fetch: (async () =>
        fakeResponse("page needs this", { "content-type": "text/plain" })) as typeof fetch,
    });

    const cleanup = installInPageCapture(scope, "s1", () => {}, { responseBodyMode: "eligible" });
    const response = await scope.fetch?.("https://example.com/");
    const pageText = await response?.text();
    cleanup();

    expect(pageText).toBe("page needs this");
  });
});
