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
  listWebSockets,
  MAX_BODY_CHARS,
  paginate,
  type RecordingSession,
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
