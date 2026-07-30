/**
 * Structural tests: extension chrome icons must use Phosphor, not inline SVG.
 */
import { describe, expect, it } from "vitest";
import type { UploadHistoryEntry } from "../types/messages";
import { Icons, phIcon } from "./icons";
import { renderUploadHistoryList } from "./upload-history-ui";

describe("phIcon / Icons", () => {
  it('emits Phosphor <i class="ph ph-…"> markup, never inline SVG', () => {
    const html = phIcon("gear");
    expect(html).toMatch(/^<i class="ph ph-gear" aria-hidden="true"><\/i>$/);
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("viewBox");
  });

  it("accepts an extra class for section-title style hosts", () => {
    const html = phIcon("list", "section-title-icon");
    expect(html).toContain('class="ph ph-list section-title-icon"');
    expect(html).not.toContain("<svg");
  });

  it("covers every Icons catalog entry with Phosphor classes only", () => {
    for (const [key, factory] of Object.entries(Icons)) {
      const html = factory();
      expect(html, key).toMatch(/class="ph ph-[a-z0-9-]+"/);
      expect(html, key).not.toContain("<svg");
      expect(html, key).not.toContain("viewBox");
      expect(html, key).toContain('aria-hidden="true"');
    }
  });
});

describe("upload-history-ui icon markup", () => {
  function makeEntry(overrides: Partial<UploadHistoryEntry> = {}): UploadHistoryEntry {
    return {
      id: "entry-1",
      uploadedAt: Date.now(),
      pageUrl: "https://example.com/app",
      recordingUrl: "https://tracing.gnas.dev/gdrive/1AbCdEfGhIjKlMn",
      recordingFolderId: "folder-1",
      targetFolderId: null,
      durationMs: 12_000,
      provider: "google-drive",
      ...overrides,
    };
  }

  it("renders history action buttons with Phosphor icons, not custom SVG paths", () => {
    const html = renderUploadHistoryList([makeEntry()]);
    expect(html).toContain("history-icon-button");
    // Replay / copy / open-remote / delete all go through shared icon helpers.
    expect(html).toContain("ph ph-play-circle");
    expect(html).toContain("ph ph-copy");
    expect(html).toContain("ph ph-folder-open");
    expect(html).toContain("ph ph-trash");
    expect(html).not.toContain("<svg");
    expect(html).not.toMatch(/viewBox="0 0 24/);
  });
});
