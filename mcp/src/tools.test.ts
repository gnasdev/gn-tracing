/**
 * Tool-surface tests.
 *
 * These assert the promises the tool descriptions make to the model: results are
 * bounded, an absent artifact is reported as "not captured" rather than as an
 * empty result, bodies stay opt-in, a filter value the matcher does not
 * understand is rejected rather than answered with an empty page, and a tool
 * failure comes back as a readable result instead of a protocol error.
 */

import { describe, expect, it } from "vitest";
import {
  type ByteRangeSource,
  createBytesSource,
  EXTENSION_CAPABILITIES,
  SDK_CAPABILITIES,
} from "../../packages/replay-core/src/index";
import { buildSamplePackage } from "../../packages/replay-core/src/testing/fixture";
import {
  buildRecordingPackage,
  concatChunks,
  encodeJsonArtifact,
} from "../../packages/replay-core/src/write";
import { handleMessage } from "./protocol";
import { createRecordingStore, type RecordingStore } from "./resolver";
import { callTool, createToolRegistry, SERVER_INSTRUCTIONS, TOOL_DEFINITIONS } from "./tools";

const SAMPLE_URL = "https://tracing.gnas.dev/gdrive/1AbCdEfGhIjKlMnOp";

/** A producer that never claims it can capture network data, e.g. the SDK on a page that blocks it. */
const SDK_CAPABILITIES_WITHOUT_NETWORK = EXTENSION_CAPABILITIES.filter(
  (capability) => capability !== "network",
);

async function createStore(
  options: Parameters<typeof buildSamplePackage>[0] = {},
): Promise<RecordingStore> {
  const bytes = await buildSamplePackage(options);
  return createRecordingStore({
    openSource: async (): Promise<ByteRangeSource> => createBytesSource(bytes),
  });
}

async function open(store: RecordingStore): Promise<string> {
  const outcome = await callTool(store, "open_recording", { source: SAMPLE_URL });
  return (outcome.data as { recordingId: string }).recordingId;
}

/** Opens a package and returns the data of one tool call against it. */
async function call(
  options: Parameters<typeof buildSamplePackage>[0],
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const store = await createStore(options);
  const recordingId = await open(store);
  const outcome = await callTool(store, name, { recordingId, ...args });
  return outcome.data as Record<string, unknown>;
}

/**
 * A package whose instant-replay buffer is wider than one page and wider than
 * the per-call tree cap. The shared fixture holds two frames, which cannot
 * distinguish "the cap applied" from "that was every frame".
 */
async function createStoreWithFrames(count: number): Promise<RecordingStore> {
  const startTime = 1_760_000_000_000;
  const built = await buildRecordingPackage({
    producer: "extension",
    capabilities: EXTENSION_CAPABILITIES,
    packagedAt: new Date(startTime).toISOString(),
    zipFilename: "gn-tracing-frames.zip",
    startTime,
    url: "https://shop.example.com/checkout",
    artifacts: {
      instantReplay: encodeJsonArtifact({
        schemaVersion: 1,
        windowMs: 10_000,
        coveredMs: 10_000,
        droppedFrames: 0,
        frames: Array.from({ length: count }, (_, index) => ({
          capturedAt: startTime + index * 1_000,
          relativeMs: index * 1_000,
          documentUrl: "https://shop.example.com/checkout",
          viewport: { width: 1440, height: 900 },
          root: { nodeType: 1, nodeName: "HTML", marker: `frame-${index}` },
        })),
      }),
    },
  });

  const bytes = concatChunks(built.chunks);
  return createRecordingStore({
    openSource: async (): Promise<ByteRangeSource> => createBytesSource(bytes),
  });
}

describe("open_recording", () => {
  it("returns a reusable id, the replay link, and what the package holds", async () => {
    const store = await createStore();
    const outcome = await callTool(store, "open_recording", { source: SAMPLE_URL });
    const data = outcome.data as Record<string, unknown>;

    expect(data.recordingId).toBe("gdrive:1AbCdEfGhIjKlMnOp");
    expect(data.replayUrl).toBe(SAMPLE_URL);
    expect(data.page).toBe("https://shop.example.com/checkout");
    expect(data.availableArtifacts).toContain("console");
    expect(data.counts).toMatchObject({ errors: 2, networkFailed: 1 });
  });

  it("says which producer wrote the package and what it could capture", async () => {
    // Without these an absent artifact is unreadable: "the SDK cannot see this"
    // and "it did not happen" look identical.
    const store = await createStore({ capabilities: SDK_CAPABILITIES });
    const opened = (await callTool(store, "open_recording", { source: SAMPLE_URL })).data as {
      producer: string;
      capabilities: string[];
    };

    expect(opened.producer).toBe("extension");
    expect(opened.capabilities).toEqual(SDK_CAPABILITIES);
    // The declared list, not the default for the producer field.
    expect(opened.capabilities).not.toContain("video");
  });

  it("reports that a video exists, which no artifact id can express", async () => {
    const store = await createStore();
    const opened = (await callTool(store, "open_recording", { source: SAMPLE_URL })).data as {
      hasVideo: boolean;
      availableArtifacts: string[];
    };

    expect(opened.hasVideo).toBe(true);
    // The point of the flag: video lives in metadata, so it is invisible here.
    expect(opened.availableArtifacts).not.toContain("video");
  });

  it("rejects a source that is not a recording reference", async () => {
    const store = await createStore();
    await expect(
      callTool(store, "open_recording", { source: "not-a-link.example" }),
    ).rejects.toMatchObject({ code: "INVALID_SOURCE" });
  });

  it("refuses local paths unless the transport allows them", async () => {
    const store = await createStore();
    await expect(
      callTool(store, "open_recording", { source: "/tmp/recording.zip" }),
    ).rejects.toMatchObject({ code: "INVALID_SOURCE" });
  });
});

describe("get_overview", () => {
  it("ranks the errors and reports the capture limits", async () => {
    const store = await createStore();
    const recordingId = await open(store);
    const outcome = await callTool(store, "get_overview", { recordingId });
    const summary = outcome.data as Record<string, never>;

    expect(summary).toMatchObject({
      counts: { errors: 2, networkFailed: 1 },
      privacy: { responseBodies: false },
    });
  });

  it("works from a bare recording id without reopening explicitly", async () => {
    const store = await createStore();
    const outcome = await callTool(store, "get_overview", {
      recordingId: "gdrive:1AbCdEfGhIjKlMnOp",
    });

    expect(outcome.data).toMatchObject({ counts: { errors: 2 } });
  });

  it("reports an unknown recording id clearly", async () => {
    const store = await createStore();
    await expect(
      callTool(store, "get_overview", { recordingId: "nonsense" }),
    ).rejects.toMatchObject({ code: "UNKNOWN_RECORDING" });
  });

  it("returns session coverage from the package summary", async () => {
    const data = await call(
      {
        evidenceCoverage: {
          schemaVersion: 1,
          surfaces: { "network-lifecycle": { source: "web-request", quality: "full" } },
        },
      },
      "get_overview",
    );

    expect(data).toMatchObject({
      capture: {
        evidenceCoverage: {
          surfaces: { "network-lifecycle": { source: "web-request", quality: "full" } },
        },
      },
    });
  });
});

describe("list_console", () => {
  it("pages console entries and filters by level", async () => {
    const store = await createStore();
    const recordingId = await open(store);

    const errors = await callTool(store, "list_console", { recordingId, level: "error" });
    expect((errors.data as { total: number }).total).toBe(2);

    const firstPage = await callTool(store, "list_console", { recordingId, limit: 1 });
    const page = firstPage.data as { items: unknown[]; hasMore: boolean; nextCursor: string };
    expect(page.items).toHaveLength(1);
    expect(page.hasMore).toBe(true);

    const secondPage = await callTool(store, "list_console", {
      recordingId,
      limit: 1,
      cursor: page.nextCursor,
    });
    expect((secondPage.data as { items: unknown[] }).items).toHaveLength(1);
  });

  it("rejects a level no producer writes instead of returning an empty page", async () => {
    const store = await createStore();
    const recordingId = await open(store);

    // "errors" is the plausible typo, and the empty page it used to produce is
    // indistinguishable from "this recording has no errors" — the one conclusion
    // an agent must not draw wrongly.
    await expect(
      callTool(store, "list_console", { recordingId, level: "errors" }),
    ).rejects.toMatchObject({ code: "INVALID_SOURCE" });
  });

  it("accepts the warn alias the matcher understands", async () => {
    const store = await createStore();
    const recordingId = await open(store);
    const outcome = await callTool(store, "list_console", { recordingId, level: "warn" });

    expect((outcome.data as { total: number }).total).toBe(1);
  });

  it("says console was not captured instead of returning an empty list", async () => {
    const data = await call({ withConsole: false }, "list_console");

    expect(data).toMatchObject({ captured: false, artifact: "console" });
  });
});

describe("get_console_entry", () => {
  it("returns the source-mapped stack for one entry", async () => {
    const store = await createStore();
    const recordingId = await open(store);
    const errors = await callTool(store, "list_console", { recordingId, level: "error" });
    const id = (errors.data as { items: Array<{ id: string }> }).items[0].id;

    const outcome = await callTool(store, "get_console_entry", { recordingId, id });
    const detail = outcome.data as {
      frames: Array<{ file: string; mapped: boolean }>;
      framesTruncated: boolean;
    };

    expect(detail.frames[0]).toMatchObject({ file: "src/checkout/cart.ts", mapped: true });
    expect(detail.framesTruncated).toBe(false);
  });

  it("says console was not captured rather than failing to find the entry", async () => {
    // Without the guard this reported a missing id, which reads as "that entry
    // does not exist" instead of "no console data was captured at all".
    const data = await call({ withConsole: false }, "get_console_entry", { id: "c-0" });

    expect(data).toMatchObject({ captured: false, artifact: "console" });
  });

  it("reports an id that is not in a captured console artifact", async () => {
    const store = await createStore();
    const recordingId = await open(store);

    await expect(
      callTool(store, "get_console_entry", { recordingId, id: "c-999" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("list_network", () => {
  it("returns only failed requests when asked", async () => {
    const data = await call({}, "list_network", { failedOnly: true });

    expect(data).toMatchObject({ total: 1 });
  });

  it("filters by status class and by exact code", async () => {
    const store = await createStore();
    const recordingId = await open(store);

    const byClass = await callTool(store, "list_network", { recordingId, statusClass: "5xx" });
    expect((byClass.data as { total: number }).total).toBe(1);

    const byCode = await callTool(store, "list_network", { recordingId, statusClass: "500" });
    expect((byCode.data as { total: number }).total).toBe(1);
  });

  it("rejects a status filter the matcher cannot apply", async () => {
    const store = await createStore();
    const recordingId = await open(store);

    for (const statusClass of ["5XXX", "server-error", "50x", "6xx"]) {
      await expect(
        callTool(store, "list_network", { recordingId, statusClass }),
      ).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    }
  });

  it("says an artifact was not captured instead of returning an empty list", async () => {
    const data = await call({ withNetwork: false }, "list_network");

    expect(data).toMatchObject({
      captured: false,
      artifact: "network",
      supportedByProducer: true,
    });
    expect(String(data.reason)).toContain("not evidence");
  });

  it("says the producer cannot capture network data, not that the session was silent", async () => {
    const data = await call(
      { withNetwork: false, capabilities: SDK_CAPABILITIES_WITHOUT_NETWORK },
      "list_network",
    );

    expect(data).toMatchObject({
      captured: false,
      artifact: "network",
      supportedByProducer: false,
    });
    expect(String(data.reason)).toContain("cannot capture");
  });
});

describe("get_network_request", () => {
  it("keeps headers and bodies opt-in", async () => {
    const store = await createStore();
    const recordingId = await open(store);

    const lean = await callTool(store, "get_network_request", { recordingId, id: "n-0" });
    expect((lean.data as { requestHeaders: unknown }).requestHeaders).toBeNull();

    const full = await callTool(store, "get_network_request", {
      recordingId,
      id: "n-0",
      includeHeaders: true,
      includeBody: true,
    });
    expect((full.data as { requestHeaders: unknown }).requestHeaders).toBeTruthy();
  });

  it("explains a missing response body that privacy settings excluded", async () => {
    const data = await call({}, "get_network_request", { id: "n-1", includeBody: true });

    expect((data.notes as string[]).join(" ")).toContain("Response bodies were not captured");
  });

  it("does not claim a request body was excluded when the recording captured them", async () => {
    // The request-body note is conditioned on the privacy flag, not on the body
    // being absent — the fixture captures request bodies, so only the response
    // note applies here.
    const data = await call({}, "get_network_request", { id: "n-1", includeBody: true });
    const notes = (data.notes as string[]).join(" ");

    expect(notes).not.toContain("Request bodies were not captured");
    expect(data.requestBody).toMatchObject({ text: '{"coupon":"SUMMER"}' });
  });
});

describe("list_websocket", () => {
  it("lists connections with their close state", async () => {
    const data = await call({}, "list_websocket");
    const page = data as { total: number; items: Array<{ id: string; closed: boolean }> };

    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({ id: "w-0", closed: true });
  });

  it("says WebSocket activity was not captured instead of returning an empty list", async () => {
    const data = await call({ withWebsocket: false }, "list_websocket");

    expect(data).toMatchObject({ captured: false, artifact: "websocket" });
  });
});

describe("list_websocket_frames", () => {
  it("returns the frames of one connection with their payloads", async () => {
    const data = await call({}, "list_websocket_frames", { connectionId: "w-0" });
    const page = data as {
      total: number;
      items: Array<{ direction: string; payload: { text: string; totalChars: number } }>;
    };

    expect(page.total).toBe(2);
    expect(page.items[0]).toMatchObject({ direction: "sent", opcode: 1 });
    expect(page.items[0].payload).toMatchObject({ text: "ping", totalChars: 4 });
    expect(page.items[1].direction).toBe("received");
  });

  it("accepts the producer's own connection id as well as the view id", async () => {
    const byRequestId = await call({}, "list_websocket_frames", { connectionId: "ws-1" });

    expect(byRequestId).toMatchObject({ total: 2 });
  });

  it("reports an unknown connection id", async () => {
    const store = await createStore();
    const recordingId = await open(store);

    await expect(
      callTool(store, "list_websocket_frames", { recordingId, connectionId: "w-99" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("says WebSocket activity was not captured rather than reporting a missing connection", async () => {
    const data = await call({ withWebsocket: false }, "list_websocket_frames", {
      connectionId: "w-0",
    });

    expect(data).toMatchObject({ captured: false, artifact: "websocket" });
  });
});

describe("get_user_timeline", () => {
  it("returns the redacted user timeline", async () => {
    const data = await call({}, "get_user_timeline");

    expect(data).toMatchObject({ total: 2 });
  });

  it("says user events were not captured instead of returning an empty timeline", async () => {
    const data = await call({ withEvents: false }, "get_user_timeline");

    expect(data).toMatchObject({ captured: false, artifact: "events" });
  });
});

describe("search", () => {
  it("searches every scope by default", async () => {
    const data = await call({}, "search", { query: "coupon" });

    expect((data.total as number) > 1).toBe(true);
  });

  it("narrows to the requested scope", async () => {
    const data = await call({}, "search", { query: "cart", scopes: ["network"] });
    const hits = data as { items: Array<{ scope: string }> };

    expect(hits.items.length).toBeGreaterThan(0);
    expect(hits.items.every((hit) => hit.scope === "network")).toBe(true);
  });

  it("rejects an unknown scope rather than widening to every scope", async () => {
    const store = await createStore();
    const recordingId = await open(store);

    // The old behaviour filtered the bad value out, leaving an empty list, which
    // `searchRecording` reads as "all scopes" — the opposite of what was asked.
    for (const scopes of [["consoles"], ["console", "netwrok"], [], "console"]) {
      await expect(
        callTool(store, "search", { recordingId, query: "x", scopes }),
      ).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    }
  });

  it("reports how many hits a time window could not place", async () => {
    // A WebSocket connection carries no wall-clock anchor, so any window drops
    // it. A silent drop would read as "the string does not appear".
    const data = await call({}, "search", { query: "live", scopes: ["websocket"], fromMs: 0 });

    expect(data).toMatchObject({ total: 0, excludedWithoutTimestamp: 1 });

    const unwindowed = await call({}, "search", { query: "live", scopes: ["websocket"] });
    expect(unwindowed).toMatchObject({ total: 1, excludedWithoutTimestamp: 0 });
  });

  it("says the searched scopes were not captured when none has an artifact", async () => {
    const data = await call({ withWebsocket: false }, "search", {
      query: "coupon",
      scopes: ["websocket"],
    });

    expect(data).toMatchObject({ captured: false, artifact: "websocket" });
  });

  it("still searches when only some of the requested scopes are present", async () => {
    const data = await call({ withWebsocket: false }, "search", {
      query: "coupon",
      scopes: ["console", "websocket"],
    });

    // An absent scope beside a present one is a narrower search, not a failure.
    expect(data.captured).toBeUndefined();
    expect((data.total as number) >= 1).toBe(true);
  });
});

describe("get_privacy_summary", () => {
  it("returns the recording's own privacy artifact", async () => {
    const data = await call({}, "get_privacy_summary");

    expect(data).toMatchObject({ available: true, profile: "balanced" });
  });

  it("says the capture scope is unknown when the artifact is absent", async () => {
    const data = await call({ withPrivacy: false }, "get_privacy_summary");

    expect(data).toMatchObject({ available: false });
  });
});

describe("get_reporter_report", () => {
  it("returns the human's own expected-versus-actual statement", async () => {
    const data = await call({ withReporterFields: true }, "get_reporter_report");

    expect(data).toMatchObject({
      captured: true,
      title: "Coupon apply fails",
      expected: "Total stays $42.00 with a $5 discount.",
      actual: "Total drops to $0.00 and checkout is blocked.",
      severity: "high",
      reference: "SHOP-4821",
    });
  });

  it("returns the title even when the reporter filled nothing else in", async () => {
    const data = await call({}, "get_reporter_report");

    expect(data).toMatchObject({ captured: true, title: "Coupon apply fails", expected: null });
  });
});

describe("get_storage", () => {
  it("reports key presence and length without ever returning a value", async () => {
    const data = await call({ withStorage: true }, "get_storage");
    const report = data as {
      snapshots: Array<{
        phase: string;
        localStorage: Array<{ key: string; valueChars: number; redacted: boolean }>;
        cookies: Array<{ name: string; httpOnly: boolean; redacted: boolean }>;
      }>;
    };

    expect(report.snapshots.map((snapshot) => snapshot.phase)).toEqual(["start", "stop"]);
    const stop = report.snapshots[1];
    expect(stop.localStorage).toContainEqual({
      key: "auth_token",
      valueChars: "eyJhbGciOiJIUzI1NiJ9.SUPERSECRET".length,
      redacted: true,
    });
    expect(stop.cookies[0]).toMatchObject({ name: "session", httpOnly: true, redacted: true });

    // The whole point of the tool: a live credential must not be reachable.
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain("SUPERSECRET");
    expect(serialized).not.toContain("sid-TOPSECRET");
  });

  it("distinguishes an empty storage snapshot from an uncaptured one", async () => {
    const empty = await call({ withEmptyArtifacts: true }, "get_storage");
    expect(empty).toMatchObject({ captured: true, snapshots: [] });

    const absent = await call({}, "get_storage");
    expect(absent).toMatchObject({ captured: false, artifact: "storage" });
  });
});

describe("get_dom_snapshots", () => {
  it("indexes the snapshots without returning their markup", async () => {
    const data = await call({ withDom: true }, "get_dom_snapshots");
    const index = data as {
      snapshots: Array<{
        label: string;
        nodeCount: number;
        maskedNodeCount: number;
        html?: unknown;
      }>;
    };

    expect(index.snapshots.map((snapshot) => snapshot.label)).toEqual(["start", "stop"]);
    expect(index.snapshots[1].nodeCount).toBeGreaterThan(1);
    expect(index.snapshots[1].maskedNodeCount).toBe(1);
    expect(index.snapshots[1].html).toBeUndefined();
  });

  it("returns markup only when asked, and only for the requested label", async () => {
    const data = await call({ withDom: true }, "get_dom_snapshots", {
      label: "stop",
      includeHtml: true,
    });
    const index = data as {
      snapshots: Array<{ label: string; html: { text: string; truncated: boolean } }>;
    };

    expect(index.snapshots).toHaveLength(1);
    expect(index.snapshots[0].label).toBe("stop");
    expect(index.snapshots[0].html.text).toContain("$0.00");
    expect(index.snapshots[0].html.truncated).toBe(false);
  });

  it("says DOM snapshots were not captured instead of returning an empty index", async () => {
    const data = await call({}, "get_dom_snapshots");

    expect(data).toMatchObject({ captured: false, artifact: "DOM snapshot" });
  });
});

describe("get_source_map_diagnostics", () => {
  it("groups the failures so an unmapped stack has an explanation", async () => {
    const data = await call({ withDiagnostics: true }, "get_source_map_diagnostics");
    const summary = data as {
      total: number;
      countByStatus: Record<string, number>;
      failures: Array<{ status: string; reason: string; httpStatusCode: number; count: number }>;
      failureGroupsTruncated: boolean;
    };

    expect(summary.total).toBe(4);
    expect(summary.countByStatus).toMatchObject({ success: 1, failed: 2, skipped: 1 });
    // Two scripts failed the same way; grouping is what makes that legible.
    expect(summary.failures[0]).toMatchObject({
      status: "failed",
      reason: "fetch-failed",
      httpStatusCode: 404,
      count: 2,
    });
    expect(summary.failureGroupsTruncated).toBe(false);
  });

  it("says diagnostics were not captured instead of implying every map resolved", async () => {
    const data = await call({}, "get_source_map_diagnostics");

    expect(data).toMatchObject({ captured: false, artifact: "source-map diagnostics" });
  });
});

describe("list_screenshots", () => {
  it("describes screenshot annotations in words rather than returning pixels", async () => {
    const data = (await call({ withScreenshots: true }, "list_screenshots")) as {
      captured: boolean;
      screenshots: Array<{
        caption?: string;
        annotations: string[];
        notes: string[];
        imagePath: string | null;
      }>;
    };

    expect(data.captured).toBe(true);
    expect(data.screenshots[0].caption).toContain("Total shows $0");
    // The reporter's own words are the highest-signal field in the package.
    expect(data.screenshots[0].notes).toContain("should be $42");
    expect(data.screenshots[0].annotations.join(" ")).toMatch(/Arrow drawn from/);
    // The path is present for a human, but no image bytes are returned.
    expect(data.screenshots[0].imagePath).toBe("screenshots/shot-1.png");
    expect(JSON.stringify(data)).not.toContain("base64");
  });

  it("says a redacted region is unrecoverable rather than merely hidden", async () => {
    const data = await call({ withScreenshots: true }, "list_screenshots");

    expect(JSON.stringify(data)).toMatch(/destroyed before packaging/);
  });

  it("reports no screenshots as not-captured, not as an empty list", async () => {
    const data = await call({}, "list_screenshots");

    expect(data.captured).toBe(false);
    expect(String(data.reason)).toMatch(/not evidence that nothing happened/);
  });
});

describe("get_instant_replay", () => {
  it("distinguishes the window it held from the one configured", async () => {
    const data = (await call({ withInstantReplay: true }, "get_instant_replay")) as {
      configuredWindowMs: number;
      actuallyCoveredMs: number;
      frames: Array<{ root?: unknown }>;
      note: string;
    };

    expect(data.configuredWindowMs).toBe(120_000);
    expect(data.actuallyCoveredMs).toBe(4_200);
    // The gap between the two is exactly the thing a model must not paper over.
    expect(data.note).toMatch(/absence of an event here is not evidence/);
    // Frame trees stay out unless asked for: they are large and rarely needed.
    expect(data.frames[0].root).toBeUndefined();
  });

  it("returns frame trees only when asked", async () => {
    const data = (await call({ withInstantReplay: true }, "get_instant_replay", {
      includeFrames: true,
    })) as { frames: Array<{ root?: unknown }>; treesReturned: number; treesTruncated: boolean };

    expect(data.frames[0].root).toBeDefined();
    expect(data.treesReturned).toBe(2);
    expect(data.treesTruncated).toBe(false);
  });

  it("caps the serialized trees per call, independently of the page size", async () => {
    const store = await createStoreWithFrames(10);
    const recordingId = await open(store);

    const outcome = await callTool(store, "get_instant_replay", {
      recordingId,
      includeFrames: true,
    });
    const data = outcome.data as {
      frames: Array<{ relativeMs: number; root?: unknown }>;
      treesReturned: number;
      treesTruncated: boolean;
    };

    // One DOM tree can exceed every other tool's whole response, so the page
    // returning ten frame headers must not return ten trees with them.
    expect(data.frames.length).toBe(10);
    expect(data.treesReturned).toBe(3);
    expect(data.treesTruncated).toBe(true);
    expect(data.frames.filter((frame) => frame.root !== undefined)).toHaveLength(3);
    // The trees that came back are the first ones in the page, not an arbitrary set.
    expect(data.frames.slice(0, 3).every((frame) => frame.root !== undefined)).toBe(true);
  });

  it("reaches later trees through the window, since the cap does not page", async () => {
    const store = await createStoreWithFrames(10);
    const recordingId = await open(store);

    const outcome = await callTool(store, "get_instant_replay", {
      recordingId,
      includeFrames: true,
      fromMs: 7_000,
    });
    const data = outcome.data as {
      frames: Array<{ relativeMs: number; root?: { marker: string } }>;
      treesTruncated: boolean;
    };

    expect(data.frames[0].relativeMs).toBe(7_000);
    expect(data.frames[0].root?.marker).toBe("frame-7");
    expect(data.treesTruncated).toBe(false);
  });

  it("pages the frame index and keeps the buffer facts on every page", async () => {
    const store = await createStore({ withInstantReplay: true });
    const recordingId = await open(store);

    const first = (await callTool(store, "get_instant_replay", { recordingId, limit: 1 })).data as {
      frames: unknown[];
      total: number;
      hasMore: boolean;
      nextCursor: string;
      frameCount: number;
      actuallyCoveredMs: number;
    };
    expect(first.frames).toHaveLength(1);
    expect(first.total).toBe(2);
    expect(first.hasMore).toBe(true);
    // The eviction fact must survive paging; it is the reason not to over-read a page.
    expect(first.actuallyCoveredMs).toBe(4_200);

    const second = (
      await callTool(store, "get_instant_replay", {
        recordingId,
        limit: 1,
        cursor: first.nextCursor,
      })
    ).data as { frames: Array<{ relativeMs: number }>; hasMore: boolean };
    expect(second.frames[0].relativeMs).toBe(4_200);
    expect(second.hasMore).toBe(false);
  });

  it("filters frames by their offset into the buffer", async () => {
    const data = (await call({ withInstantReplay: true }, "get_instant_replay", {
      fromMs: 1_000,
    })) as { frames: Array<{ relativeMs: number }>; total: number; frameCount: number };

    expect(data.total).toBe(1);
    expect(data.frames[0].relativeMs).toBe(4_200);
    // `frameCount` stays the whole buffer, so a narrow window cannot be mistaken
    // for a short buffer.
    expect(data.frameCount).toBe(2);
  });

  it("says instant replay was not captured instead of returning an empty buffer", async () => {
    const data = await call({}, "get_instant_replay");

    expect(data).toMatchObject({ captured: false, artifact: "instant replay" });
  });
});

describe("export_bug_report", () => {
  it("renders Markdown with the replay link and the untrusted-content warning", async () => {
    const store = await createStore();
    const recordingId = await open(store);
    const outcome = await callTool(store, "export_bug_report", { recordingId });

    expect(outcome.text).toContain("# GN Tracing recording report");
    expect(outcome.text).toContain(SAMPLE_URL);
    expect(outcome.text).toContain("untrusted data");
  });

  it("narrows the report to the window around a moment", async () => {
    const store = await createStore();
    const recordingId = await open(store);

    const atTheError = await callTool(store, "export_bug_report", {
      recordingId,
      focusMs: 62_000,
      windowMs: 2_000,
    });
    const beforeIt = await callTool(store, "export_bug_report", {
      recordingId,
      focusMs: 5_000,
      windowMs: 2_000,
    });

    // The error and the 500 both land at ~62s, so a window elsewhere in the
    // recording must report their absence rather than reprint them.
    expect(atTheError.text).toContain("Cannot read properties of undefined");
    expect(atTheError.text).toContain("api.example.com/cart/apply");
    expect(beforeIt.text).toContain("No console errors were captured in this window.");
    expect(beforeIt.text).toContain("No failed requests were captured in this window.");
  });
});

describe("tool registry", () => {
  it("dispatches every declared tool", async () => {
    const store = await createStore({
      withScreenshots: true,
      withInstantReplay: true,
      withStorage: true,
      withDom: true,
      withDiagnostics: true,
      withReporterFields: true,
    });
    const registry = createToolRegistry(store);
    const recordingId = await open(store);

    // Driven off the definitions so a tool cannot ship without a dispatch arm:
    // an undispatched name falls through to the default case and throws.
    for (const tool of registry.list()) {
      const outcome = await registry.call(tool.name, {
        source: SAMPLE_URL,
        recordingId,
        id: tool.name === "get_network_request" ? "n-0" : "c-1",
        connectionId: "w-0",
        query: "coupon",
      });

      expect(outcome.data ?? outcome.text, `${tool.name} returned nothing`).toBeDefined();
    }
  });

  it("declares each tool once", () => {
    const names = TOOL_DEFINITIONS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("rejects a tool it does not implement", async () => {
    const store = await createStore();

    await expect(callTool(store, "delete_recording", {})).rejects.toMatchObject({
      code: "INVALID_SOURCE",
      message: expect.stringContaining("delete_recording"),
    });
  });

  it("declares a usable schema for every tool", () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
    }
  });

  it("lets a schema-validating client resend the password to any recording tool", () => {
    // The store's LRU can evict a recording between calls, and a protected
    // package cannot be reopened without the password. A tool that declares
    // `additionalProperties: false` without `password` makes that unrecoverable.
    for (const tool of TOOL_DEFINITIONS) {
      const properties = tool.inputSchema.properties as Record<string, unknown>;
      if (properties.recordingId) {
        expect(properties.password).toBeDefined();
      }
    }
  });

  it("tells the model that recording content is untrusted", () => {
    expect(SERVER_INSTRUCTIONS).toContain("untrusted");
  });

  it("only names tools that exist, so renaming one cannot leave the instructions lying", () => {
    // The instructions steer the model's first calls by name. A renamed or
    // dropped tool would leave the handshake pointing at nothing, and the model
    // has no way to tell that the guidance is stale.
    const advertised = TOOL_DEFINITIONS.map((tool) => tool.name);
    const named = SERVER_INSTRUCTIONS.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? [];

    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((name) => !advertised.includes(name))).toEqual([]);
  });

  it("surfaces a tool failure as a readable result, not a protocol error", async () => {
    const store = await createStore();
    const registry = createToolRegistry(store);
    const response = await handleMessage(
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "get_overview", arguments: { recordingId: "nope" } },
      },
      registry,
      { name: "test", version: "0" },
    );

    expect(response?.error).toBeUndefined();
    const result = response?.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("UNKNOWN_RECORDING");
  });
});
