/**
 * Correlates the webRequest event sequence into one NetworkEntry per request.
 * Fixtures mirror the exact field names MDN documents for each event.
 */
import { describe, expect, it } from "vitest";
import { WebRequestTable } from "./request-table";

describe("WebRequestTable", () => {
  it("assembles a full success sequence into one entry", () => {
    const table = new WebRequestTable();

    table.onBeforeRequest({
      requestId: "1",
      url: "https://example.com/api",
      method: "GET",
      type: "xmlhttprequest",
      timeStamp: 1_700_000_000_000,
      frameId: 0,
    });
    table.onSendHeaders({
      requestId: "1",
      requestHeaders: [{ name: "Accept", value: "application/json" }],
    });
    const entry = table.onCompleted({
      requestId: "1",
      statusCode: 200,
      statusLine: "HTTP/1.1 200 OK",
      responseHeaders: [{ name: "Content-Type", value: "application/json; charset=utf-8" }],
      fromCache: false,
      ip: "93.184.216.34",
    });

    expect(entry).not.toBeNull();
    expect(entry).toMatchObject({
      requestId: "1",
      url: "https://example.com/api",
      method: "GET",
      resourceType: "XHR",
      status: 200,
      statusText: "HTTP/1.1 200 OK",
      requestHeaders: { Accept: "application/json" },
      responseHeaders: { "Content-Type": "application/json; charset=utf-8" },
      mimeType: "application/json",
      remoteIPAddress: "93.184.216.34",
      servedFromCache: false,
      responseBody: null,
      error: null,
    });
  });

  it("removes a completed request from pending", () => {
    const table = new WebRequestTable();
    table.onBeforeRequest({
      requestId: "1",
      url: "https://example.com/",
      method: "GET",
      type: "main_frame",
      timeStamp: 0,
      frameId: 0,
    });
    expect(table.pendingCount).toBe(1);
    table.onCompleted({ requestId: "1", statusCode: 200 });
    expect(table.pendingCount).toBe(0);
  });

  it("produces an entry for a request that errored instead of completing", () => {
    const table = new WebRequestTable();
    table.onBeforeRequest({
      requestId: "2",
      url: "https://example.com/timeout",
      method: "GET",
      type: "xmlhttprequest",
      timeStamp: 0,
      frameId: 0,
    });

    const entry = table.onErrorOccurred({
      requestId: "2",
      error: "NS_ERROR_NET_TIMEOUT",
      timeStamp: 1,
    });

    expect(entry).toMatchObject({ requestId: "2", error: "NS_ERROR_NET_TIMEOUT", status: null });
  });

  it("ignores headers/completion events for a requestId it never saw", () => {
    // onSendHeaders etc. can theoretically race onBeforeRequest at extreme
    // load; a missing row must not throw.
    const table = new WebRequestTable();
    expect(() => table.onSendHeaders({ requestId: "ghost", requestHeaders: [] })).not.toThrow();
    expect(table.onCompleted({ requestId: "ghost", statusCode: 200 })).toBeNull();
    expect(table.onErrorOccurred({ requestId: "ghost", error: "x", timeStamp: 0 })).toBeNull();
  });

  it("drains requests still in flight at detach as incomplete entries", () => {
    const table = new WebRequestTable();
    table.onBeforeRequest({
      requestId: "3",
      url: "https://example.com/slow",
      method: "GET",
      type: "image",
      timeStamp: 0,
      frameId: 0,
    });

    const drained = table.drainIncomplete();

    expect(drained).toHaveLength(1);
    expect(drained[0]).toMatchObject({ requestId: "3", status: null });
    expect(table.pendingCount).toBe(0);
  });

  it("skips a null-valued header instead of writing the literal string 'null'", () => {
    const table = new WebRequestTable();
    table.onBeforeRequest({
      requestId: "4",
      url: "https://example.com/",
      method: "GET",
      type: "script",
      timeStamp: 0,
      frameId: 0,
    });
    table.onSendHeaders({
      requestId: "4",
      requestHeaders: [{ name: "X-Empty" }, { name: "Accept", value: "*/*" }],
    });
    const entry = table.onCompleted({ requestId: "4", statusCode: 200 });

    expect(entry?.requestHeaders).toEqual({ Accept: "*/*" });
  });

  it("maps resource type through the shared table", () => {
    const table = new WebRequestTable();
    table.onBeforeRequest({
      requestId: "5",
      url: "https://example.com/app.css",
      method: "GET",
      type: "stylesheet",
      timeStamp: 0,
      frameId: 0,
    });
    const entry = table.onCompleted({ requestId: "5", statusCode: 200 });
    expect(entry?.resourceType).toBe("Stylesheet");
  });

  it("reads Content-Type case-insensitively for mimeType", () => {
    // Bug caught by this exact test: webRequest preserves the server's header
    // casing (commonly title-case), and a lowercase-only lookup silently
    // returned null for every response.
    const table = new WebRequestTable();
    table.onBeforeRequest({
      requestId: "6",
      url: "https://example.com/data",
      method: "GET",
      type: "xmlhttprequest",
      timeStamp: 0,
      frameId: 0,
    });
    const entry = table.onCompleted({
      requestId: "6",
      statusCode: 200,
      responseHeaders: [{ name: "content-type", value: "text/plain" }],
    });
    expect(entry?.mimeType).toBe("text/plain");
  });
});
