/**
 * Tool-surface tests.
 *
 * These assert the promises the tool descriptions make to the model: results are
 * bounded, an absent artifact is reported as "not captured" rather than as an
 * empty result, bodies stay opt-in, and a tool failure comes back as a readable
 * result instead of a protocol error.
 */

import { describe, expect, it } from "vitest";
import { type ByteRangeSource, createBytesSource } from "../../packages/replay-core/src/index";
import { buildSamplePackage } from "../../packages/replay-core/src/testing/fixture";
import { handleMessage } from "./protocol";
import { createRecordingStore, type RecordingStore } from "./resolver";
import { callTool, createToolRegistry, SERVER_INSTRUCTIONS, TOOL_DEFINITIONS } from "./tools";

const SAMPLE_URL = "https://tracing.gnas.dev/gdrive/1AbCdEfGhIjKlMnOp";

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
    expect(outcome.data).toBeTruthy();
  });

  it("reports an unknown recording id clearly", async () => {
    const store = await createStore();
    await expect(
      callTool(store, "get_overview", { recordingId: "nonsense" }),
    ).rejects.toMatchObject({ code: "UNKNOWN_RECORDING" });
  });
});

describe("list tools", () => {
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

  it("returns only failed requests when asked", async () => {
    const store = await createStore();
    const recordingId = await open(store);
    const outcome = await callTool(store, "list_network", { recordingId, failedOnly: true });

    expect(outcome.data).toMatchObject({ total: 1 });
  });

  it("says an artifact was not captured instead of returning an empty list", async () => {
    const store = await createStore({ withNetwork: false });
    const recordingId = await open(store);
    const outcome = await callTool(store, "list_network", { recordingId });

    expect(outcome.data).toMatchObject({ captured: false, artifact: "network" });
    expect(String((outcome.data as { reason: string }).reason)).toContain("not evidence");
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

  it("explains a missing body that privacy settings excluded", async () => {
    const store = await createStore();
    const recordingId = await open(store);
    const outcome = await callTool(store, "get_network_request", {
      recordingId,
      id: "n-1",
      includeBody: true,
    });

    expect((outcome.data as { notes?: string[] }).notes?.join(" ")).toContain(
      "Response bodies were not captured",
    );
  });
});

describe("get_user_timeline and search", () => {
  it("returns the redacted user timeline", async () => {
    const store = await createStore();
    const recordingId = await open(store);
    const outcome = await callTool(store, "get_user_timeline", { recordingId });

    expect((outcome.data as { total: number }).total).toBe(2);
  });

  it("searches across scopes", async () => {
    const store = await createStore();
    const recordingId = await open(store);
    const outcome = await callTool(store, "search", { recordingId, query: "coupon" });

    expect((outcome.data as { total: number }).total).toBeGreaterThan(1);
  });
});

describe("get_privacy_summary", () => {
  it("returns the recording's own privacy artifact", async () => {
    const store = await createStore();
    const recordingId = await open(store);
    const outcome = await callTool(store, "get_privacy_summary", { recordingId });

    expect(outcome.data).toMatchObject({ available: true, profile: "balanced" });
  });

  it("says the capture scope is unknown when the artifact is absent", async () => {
    const store = await createStore({ withPrivacy: false });
    const recordingId = await open(store);
    const outcome = await callTool(store, "get_privacy_summary", { recordingId });

    expect(outcome.data).toMatchObject({ available: false });
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
});

describe("tool definitions", () => {
  it("describes screenshot annotations in words rather than returning pixels", async () => {
    const store = await createStore({ withScreenshots: true });
    const recordingId = await open(store);

    const outcome = await callTool(store, "list_screenshots", { recordingId });
    const data = outcome.data as {
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
    const store = await createStore({ withScreenshots: true });
    const recordingId = await open(store);

    const outcome = await callTool(store, "list_screenshots", { recordingId });
    expect(JSON.stringify(outcome.data)).toMatch(/destroyed before packaging/);
  });

  it("reports no screenshots as not-captured, not as an empty list", async () => {
    const store = await createStore();
    const recordingId = await open(store);

    const outcome = await callTool(store, "list_screenshots", { recordingId });
    const data = outcome.data as { captured: boolean; reason: string };

    expect(data.captured).toBe(false);
    expect(data.reason).toMatch(/not evidence that nothing happened/);
  });

  it("distinguishes the instant-replay window it held from the one configured", async () => {
    const store = await createStore({ withInstantReplay: true });
    const recordingId = await open(store);

    const outcome = await callTool(store, "get_instant_replay", { recordingId });
    const data = outcome.data as {
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
    const store = await createStore({ withInstantReplay: true });
    const recordingId = await open(store);

    const outcome = await callTool(store, "get_instant_replay", {
      recordingId,
      includeFrames: true,
    });
    const data = outcome.data as { frames: Array<{ root?: unknown }> };
    expect(data.frames[0].root).toBeDefined();
  });

  it("declares a schema for every implemented tool", async () => {
    const store = await createStore();
    const registry = createToolRegistry(store);
    const names = registry.list().map((tool) => tool.name);

    expect(names).toEqual([
      "open_recording",
      "get_overview",
      "list_console",
      "get_console_entry",
      "list_network",
      "get_network_request",
      "list_websocket",
      "get_user_timeline",
      "search",
      "get_privacy_summary",
      "list_screenshots",
      "get_instant_replay",
      "export_bug_report",
    ]);

    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.inputSchema).toMatchObject({ type: "object" });
    }
  });

  it("tells the model that recording content is untrusted", () => {
    expect(SERVER_INSTRUCTIONS).toContain("untrusted");
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
