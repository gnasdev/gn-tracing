/**
 * Query-layer tests.
 *
 * These pin the two properties an agent-facing API lives or dies by: results are
 * bounded (never a whole artifact), and a cursor cannot silently resume under
 * different filters — which would skip or repeat records without any error.
 */

import { describe, expect, it } from "vitest";
import { openRecordingPackageFromBytes } from "./artifacts";
import {
  createRecordingSession,
  getConsoleEntry,
  getNetworkRequest,
  listConsole,
  listNetwork,
  listUserEvents,
  listWebSocketFrames,
  listWebSockets,
  MAX_BODY_CHARS,
  MAX_DOM_HTML_CHARS,
  MAX_FRAME_PAYLOAD_CHARS,
  paginate,
  type RecordingSession,
  readDomSnapshots,
  readReporterReport,
  readSourceMapDiagnostics,
  readStorage,
  searchRecording,
} from "./query";
import { buildSamplePackage } from "./testing/fixture";

async function openSampleSession(
  options: Parameters<typeof buildSamplePackage>[0] = {},
): Promise<RecordingSession> {
  const bytes = await buildSamplePackage(options);
  return createRecordingSession(await openRecordingPackageFromBytes(bytes));
}

describe("listConsole", () => {
  it("filters by level, treating exceptions as errors", async () => {
    const session = await openSampleSession();
    const page = await listConsole(session, { level: "error" });

    expect(page.total).toBe(2);
    expect(page.items.every((item) => item.level === "error")).toBe(true);
  });

  it("filters by time window and free text", async () => {
    const session = await openSampleSession();

    const windowed = await listConsole(session, { fromMs: 60_000, toMs: 64_000 });
    expect(windowed.total).toBe(2);

    const searched = await listConsole(session, { query: "deprecated" });
    expect(searched.total).toBe(1);
    expect(searched.items[0].level).toBe("warning");
  });

  it("resolves the source-mapped origin of an error", async () => {
    const session = await openSampleSession();
    const page = await listConsole(session, { level: "error" });

    expect(page.items[0].location).toMatchObject({
      file: "src/checkout/cart.ts",
      line: 128,
      mapped: true,
    });
  });
});

describe("getConsoleEntry", () => {
  it("returns mapped frames and the captured source snippet", async () => {
    const session = await openSampleSession();
    const page = await listConsole(session, { level: "error" });
    const detail = await getConsoleEntry(session, page.items[0].id);

    expect(detail.frames[0]).toMatchObject({
      function: "applyCoupon",
      file: "src/checkout/cart.ts",
      line: 128,
      mapped: true,
    });
    expect(detail.frames[0].snippet).toEqual(["const id = cart.item.id;"]);
    expect(detail.framesTruncated).toBe(false);
  });

  it("reports an unknown id instead of guessing", async () => {
    const session = await openSampleSession();
    await expect(getConsoleEntry(session, "c-999")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("listNetwork", () => {
  it("returns only failures when asked", async () => {
    const session = await openSampleSession();
    const page = await listNetwork(session, { failedOnly: true });

    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({ method: "POST", status: 500 });
  });

  it("matches a status class and an exact status", async () => {
    const session = await openSampleSession();

    expect((await listNetwork(session, { statusClass: "5xx" })).total).toBe(1);
    expect((await listNetwork(session, { statusClass: "500" })).total).toBe(1);
    expect((await listNetwork(session, { statusClass: "2xx" })).total).toBe(1);
    expect((await listNetwork(session, { statusClass: "4xx" })).total).toBe(0);
  });

  it("filters by method and URL substring", async () => {
    const session = await openSampleSession();

    expect((await listNetwork(session, { method: "post" })).total).toBe(1);
    expect((await listNetwork(session, { urlContains: "/cart/apply" })).total).toBe(1);
  });
});

describe("getNetworkRequest", () => {
  it("omits headers and bodies unless they are requested", async () => {
    const session = await openSampleSession();
    const lean = await getNetworkRequest(session, "n-0");

    expect(lean.requestHeaders).toBeNull();
    expect(lean.responseBody).toBeNull();

    const full = await getNetworkRequest(session, "n-0", {
      includeHeaders: true,
      includeBody: true,
    });
    expect(full.requestHeaders).toMatchObject({ accept: "application/json" });
    expect(full.responseBody).toMatchObject({ text: '{"items":[]}', truncated: false });
  });

  it("truncates an oversized body and says so", async () => {
    const session = await openSampleSession();
    const raw = (await session.rawNetwork())[0] as Record<string, unknown>;
    (raw.responseBody as Record<string, unknown>).body = "x".repeat(MAX_BODY_CHARS * 2);

    const detail = await getNetworkRequest(session, "n-0", { includeBody: true });
    expect(detail.responseBody?.truncated).toBe(true);
    expect(detail.responseBody?.totalChars).toBe(MAX_BODY_CHARS * 2);
    expect(detail.responseBody?.text.length).toBeLessThanOrEqual(MAX_BODY_CHARS + 1);
  });
});

describe("listUserEvents / listWebSockets", () => {
  it("returns the redacted user timeline in order", async () => {
    const session = await openSampleSession();
    const page = await listUserEvents(session);

    expect(page.items.map((item) => item.kind)).toEqual(["navigation", "click"]);
    expect(page.items[1]).toMatchObject({ atMs: 61_200, label: "Apply coupon" });
  });

  it("summarizes websocket connections", async () => {
    const session = await openSampleSession();
    const page = await listWebSockets(session);

    expect(page.items[0]).toMatchObject({ frameCount: 2, sentCount: 1, receivedCount: 1 });
  });
});

describe("searchRecording", () => {
  it("finds hits across scopes, ordered by time", async () => {
    const session = await openSampleSession();
    const page = await searchRecording(session, "coupon");

    expect(page.total).toBeGreaterThan(1);
    expect(new Set(page.items.map((hit) => hit.scope)).size).toBeGreaterThan(1);
    const times = page.items.map((hit) => hit.atMs ?? Number.POSITIVE_INFINITY);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("drops hits with no wall-clock anchor when a time window is given", async () => {
    const session = await openSampleSession();

    const unwindowed = await searchRecording(session, "example.com");
    const websocketHits = unwindowed.items.filter((hit) => hit.scope === "websocket");
    expect(websocketHits.length).toBeGreaterThan(0);
    expect(websocketHits.every((hit) => hit.atMs === null)).toBe(true);
    expect(unwindowed.excludedWithoutTimestamp).toBe(0);

    const windowed = await searchRecording(session, "example.com", { fromMs: 0, toMs: 120_000 });
    expect(windowed.items.some((hit) => hit.scope === "websocket")).toBe(false);
    expect(windowed.items.every((hit) => hit.atMs !== null)).toBe(true);
    expect(windowed.excludedWithoutTimestamp).toBe(websocketHits.length);
    expect(windowed.total).toBe(unwindowed.total - websocketHits.length);
  });

  it("narrows to the requested window", async () => {
    const session = await openSampleSession();
    const page = await searchRecording(session, "cart", { fromMs: 0, toMs: 10_000 });

    expect(page.total).toBeGreaterThan(0);
    expect(page.items.every((hit) => (hit.atMs ?? -1) <= 10_000)).toBe(true);
  });

  it("rejects an empty query", async () => {
    const session = await openSampleSession();
    await expect(searchRecording(session, "  ")).rejects.toMatchObject({ code: "INVALID_SOURCE" });
  });
});

describe("paginate", () => {
  const items = Array.from({ length: 25 }, (_, index) => index);

  it("bounds a page and hands back a cursor", () => {
    const first = paginate(items, { limit: 10 }, ["k"]);
    expect(first.items).toHaveLength(10);
    expect(first.total).toBe(25);
    expect(first.hasMore).toBe(true);

    const second = paginate(items, { limit: 10, cursor: first.nextCursor }, ["k"]);
    expect(second.items[0]).toBe(10);

    const third = paginate(items, { limit: 10, cursor: second.nextCursor }, ["k"]);
    expect(third.items).toEqual([20, 21, 22, 23, 24]);
    expect(third.hasMore).toBe(false);
    expect(third.nextCursor).toBeUndefined();
  });

  it("clamps the limit to the documented maximum", () => {
    expect(paginate(items, { limit: 10_000 }, ["k"]).items).toHaveLength(25);
    expect(paginate(items, { limit: 0 }, ["k"]).items).toHaveLength(1);
  });

  it("refuses a cursor minted under different filters", () => {
    const first = paginate(items, { limit: 10 }, ["level:error"]);
    expect(() =>
      paginate(items, { limit: 10, cursor: first.nextCursor }, ["level:warning"]),
    ).toThrow(/different query/);
  });
});

describe("createRecordingSession", () => {
  it("computes the summary for a package that predates agent-summary.json", async () => {
    const session = await openSampleSession();
    const summary = await session.summary();

    expect(summary.schemaVersion).toBe(1);
    expect(summary.counts.errors).toBe(2);
  });

  it("prefers a stored agent-summary.json over recomputing it", async () => {
    const session = await openSampleSession({
      agentSummary: { schemaVersion: 1, marker: "stored" },
    });
    const summary = (await session.summary()) as unknown as { marker?: string };

    expect(summary.marker).toBe("stored");
  });

  it("reads each artifact at most once", async () => {
    const session = await openSampleSession();
    const first = await session.consoleViews();
    const second = await session.consoleViews();

    expect(second).toBe(first);
  });
});

describe("readStorage", () => {
  it("distinguishes an absent artifact from a captured empty one", async () => {
    expect(await readStorage(await openSampleSession())).toBeNull();
    expect(await readStorage(await openSampleSession({ withEmptyArtifacts: true }))).toEqual({
      snapshots: [],
    });
  });

  it("reports key presence and never the value", async () => {
    const session = await openSampleSession({ withStorage: true });
    const report = await readStorage(session);
    const stop = report?.snapshots.find((snapshot) => snapshot.phase === "stop");

    expect(stop).toMatchObject({
      localStorageCount: 2,
      sessionStorageCount: 1,
      cookieCount: 1,
      atMs: 120_000,
      keysTruncated: false,
    });
    expect(stop?.localStorage).toContainEqual({
      key: "auth_token",
      valueChars: 32,
      redacted: true,
    });
    expect(stop?.cookies[0]).toMatchObject({
      name: "session",
      domain: ".shop.example.com",
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      redacted: true,
    });

    // The one guarantee the whole reader exists for: no captured value string
    // may appear anywhere in the serialized result.
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("SUPERSECRET");
    expect(serialized).not.toContain("TOPSECRET");
    expect(serialized).not.toContain("SUMMER");
  });
});

describe("readDomSnapshots", () => {
  it("distinguishes an absent artifact from a captured empty one", async () => {
    expect(await readDomSnapshots(await openSampleSession())).toBeNull();
    expect(await readDomSnapshots(await openSampleSession({ withEmptyArtifacts: true }))).toEqual({
      snapshots: [],
    });
  });

  it("indexes tree shape without returning the tree", async () => {
    const session = await openSampleSession({ withDom: true });
    const index = await readDomSnapshots(session);

    expect(index?.snapshots.map((snapshot) => snapshot.label)).toEqual(["start", "stop"]);
    expect(index?.snapshots[1]).toMatchObject({
      index: 1,
      documentUrl: "https://shop.example.com/checkout",
      atMs: 120_000,
      nodeCount: 4,
      maxDepth: 3,
      maskedNodeCount: 1,
    });
    expect(index?.snapshots[1].html).toBeUndefined();
  });

  it("filters by label and renders HTML only on request", async () => {
    const session = await openSampleSession({ withDom: true });
    const index = await readDomSnapshots(session, { label: "stop", includeHtml: true });

    expect(index?.snapshots).toHaveLength(1);
    expect(index?.snapshots[0].html?.text).toContain('id="total"');
    expect(index?.snapshots[0].html?.truncated).toBe(false);
  });

  it("truncates rendered HTML at the documented ceiling", async () => {
    const session = await openSampleSession({ withDom: true });
    const raw = (await session.artifact<{
      snapshots: Array<{ root: { children: unknown[] } }>;
    }>("dom")) as { snapshots: Array<{ root: { children: unknown[] } }> };
    // Grow the captured tree past the ceiling in place: the reader reads the
    // memoized artifact, so this is the same object it will summarize.
    raw.snapshots[1].root.children = Array.from({ length: 4000 }, () => ({
      nodeType: 1,
      nodeName: "P",
      children: [{ nodeType: 3, nodeName: "#text", nodeValue: "padding text" }],
    }));

    const index = await readDomSnapshots(session, { label: "stop", includeHtml: true });
    const html = index?.snapshots[0].html;

    expect(html?.totalChars).toBeGreaterThan(MAX_DOM_HTML_CHARS);
    expect(html?.truncated).toBe(true);
    expect(html?.text.length).toBeLessThanOrEqual(MAX_DOM_HTML_CHARS + 1);
  });
});

describe("readSourceMapDiagnostics", () => {
  it("distinguishes an absent artifact from a captured empty one", async () => {
    expect(await readSourceMapDiagnostics(await openSampleSession())).toBeNull();
    expect(
      await readSourceMapDiagnostics(await openSampleSession({ withEmptyArtifacts: true })),
    ).toMatchObject({ total: 0, countByStatus: {}, failures: [] });
  });

  it("groups failures by status, reason, and HTTP status", async () => {
    const session = await openSampleSession({ withDiagnostics: true });
    const summary = await readSourceMapDiagnostics(session);

    expect(summary).toMatchObject({
      total: 4,
      countByStatus: { success: 1, failed: 2, skipped: 1 },
      failureGroupsTruncated: false,
    });
    expect(summary?.failures[0]).toMatchObject({
      status: "failed",
      reason: "fetch-failed",
      httpStatusCode: 404,
      count: 2,
    });
    expect(summary?.failures[0].exampleGeneratedUrl).toContain("vendor.min.js");
    expect(summary?.failures.map((group) => group.status)).not.toContain("success");
  });
});

describe("readReporterReport", () => {
  it("returns the reporter's expected-versus-actual statement", async () => {
    const session = await openSampleSession({ withReporterFields: true });

    expect(await readReporterReport(session)).toMatchObject({
      title: "Coupon apply fails",
      expected: "Total stays $42.00 with a $5 discount.",
      actual: "Total drops to $0.00 and checkout is blocked.",
      severity: "high",
      reference: "SHOP-4821",
      pageUrl: "https://shop.example.com/checkout",
      pageTitle: "Checkout",
    });
  });

  it("nulls the optional fields a reporter left blank", async () => {
    const report = await readReporterReport(await openSampleSession());

    expect(report).toMatchObject({
      title: "Coupon apply fails",
      description: null,
      expected: null,
      actual: null,
      severity: null,
      reference: null,
    });
  });
});

describe("listWebSocketFrames", () => {
  it("returns frame direction, opcode, and payload for a connection", async () => {
    const session = await openSampleSession();
    const page = await listWebSocketFrames(session, "w-0");

    expect(page.total).toBe(2);
    expect(page.items[0]).toMatchObject({ index: 0, direction: "sent", opcode: 1 });
    expect(page.items[0].payload.text).toBe("ping");
    // Monotonic-seconds timestamps carry no wall-clock anchor.
    expect(page.items[0].atMs).toBeNull();
  });

  it("accepts the producer request id and rejects an unknown one", async () => {
    const session = await openSampleSession();

    expect((await listWebSocketFrames(session, "ws-1")).total).toBe(2);
    await expect(listWebSocketFrames(session, "w-9")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("pages frames and truncates each payload at the frame ceiling", async () => {
    const session = await openSampleSession({
      websocketFrames: { count: 5, payloadChars: MAX_FRAME_PAYLOAD_CHARS + 500 },
    });
    const first = await listWebSocketFrames(session, "w-0", { limit: 2 });

    expect(first.total).toBe(5);
    expect(first.items).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    expect(first.items[0]).toMatchObject({ atMs: 0, direction: "sent" });
    expect(first.items[1].atMs).toBe(100);

    const payload = first.items[0].payload;
    expect(payload.totalChars).toBe(MAX_FRAME_PAYLOAD_CHARS + 500);
    expect(payload.truncated).toBe(true);
    expect(payload.text.length).toBe(MAX_FRAME_PAYLOAD_CHARS + 1);

    const second = await listWebSocketFrames(session, "w-0", {
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.items[0].index).toBe(2);
  });
});
