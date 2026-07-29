/**
 * Integration test: successful report-style upload history uses the shipped
 * builder + saveUploadHistory path (same family as IR/screenshot success).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildReportUploadHistoryEntry } from "../shared/instant-replay-policy";

beforeEach(() => {
  vi.resetModules();
});

describe("report upload history (IR / screenshot path)", () => {
  it("persists a recordingUrl entry through the real saveUploadHistory", async () => {
    const { getUploadHistory, saveUploadHistory, MAX_UPLOAD_HISTORY_ITEMS } = await import(
      "./settings-store"
    );

    const entry = buildReportUploadHistoryEntry({
      recordingUrl: "https://player.example/r/ir-1",
      pageUrl: "https://app.example/page",
      indexFileId: "zip-file-id",
      targetFolderId: "/gn-tracing",
      durationMs: 12_000,
      provider: "dropbox",
      uploadedAt: 1_710_000_000_000,
    });

    // Mirror persistReportUploadHistory: prepend + cap + save.
    const history = [entry, ...(await getUploadHistory())].slice(0, MAX_UPLOAD_HISTORY_ITEMS);
    await saveUploadHistory(history);

    const stored = await getUploadHistory();
    expect(stored.length).toBeGreaterThanOrEqual(1);
    expect(stored[0].recordingUrl).toBe("https://player.example/r/ir-1");
    expect(stored[0].provider).toBe("dropbox");
    expect(stored[0].pageUrl).toBe("https://app.example/page");
    expect(stored[0].durationMs).toBe(12_000);
  });
});
