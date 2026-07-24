/**
 * Unit tests for upload-history open-remote routing (Drive + Dropbox).
 */
import { describe, expect, it, vi } from "vitest";
import type { UploadHistoryEntry } from "../types/messages";
import { handleUploadHistoryAction, renderUploadHistoryList } from "./upload-history-ui";

function makeEntry(overrides: Partial<UploadHistoryEntry>): UploadHistoryEntry {
  return {
    id: "entry-1",
    uploadedAt: Date.now(),
    pageUrl: "https://example.com/app",
    recordingUrl: "https://tracing.gnas.dev/gdrive/1AbCdEfGhIjKlMn",
    recordingFolderId: null,
    targetFolderId: null,
    durationMs: 12_000,
    ...overrides,
  };
}

describe("renderUploadHistoryList open-remote", () => {
  it("emits open-remote for Drive with recording URL", () => {
    const html = renderUploadHistoryList([
      makeEntry({
        provider: "google-drive",
        recordingUrl: "https://tracing.gnas.dev/gdrive/1AbCdEfGhIjKlMn",
        recordingFolderId: "1DriveFolderId",
      }),
    ]);
    expect(html).toContain('data-action="open-remote"');
    expect(html).toContain('data-provider="google-drive"');
    expect(html).toContain("1AbCdEfGhIjKlMn");
  });

  it("emits open-remote for Dropbox with shared-link recording URL", () => {
    const replayId = "scl/fi/abc/file.zip?rlkey=xyz";
    const html = renderUploadHistoryList([
      makeEntry({
        provider: "dropbox",
        recordingUrl: `https://tracing.gnas.dev/dropbox/${encodeURIComponent(replayId)}`,
        recordingFolderId: "/gn-tracing",
      }),
    ]);
    expect(html).toContain('data-action="open-remote"');
    expect(html).toContain('data-provider="dropbox"');
    expect(html).toContain('data-folder-id="/gn-tracing"');
  });

  it("still emits open-remote when only recording URL exists (no folder)", () => {
    const html = renderUploadHistoryList([
      makeEntry({
        provider: "google-drive",
        recordingUrl: "https://tracing.gnas.dev/gdrive/1AbCdEfGhIjKlMn",
        recordingFolderId: null,
        targetFolderId: null,
      }),
    ]);
    expect(html).toContain('data-action="open-remote"');
  });
});

describe("handleUploadHistoryAction open-remote", () => {
  function makeButton(attrs: Record<string, string>): HTMLElement {
    const all: Record<string, string> = { "data-action": "open-remote", ...attrs };
    const el = {
      getAttribute(name: string) {
        return all[name] ?? null;
      },
      closest() {
        return el;
      },
    };
    return el as unknown as HTMLElement;
  }

  it("opens Google Drive file view from recording URL", async () => {
    const openExternalUrl = vi.fn();
    const button = makeButton({
      "data-recording-url": "https://tracing.gnas.dev/gdrive/1AbCdEfGhIjKlMn",
      "data-provider": "google-drive",
      "data-folder-id": "1FolderXXXXXX",
    });
    await handleUploadHistoryAction(button, {
      openExternalUrl,
      copyLink: vi.fn(),
      deleteHistoryEntry: vi.fn(),
    });
    expect(openExternalUrl).toHaveBeenCalledWith(
      "https://drive.google.com/file/d/1AbCdEfGhIjKlMn/view",
    );
  });

  it("opens Dropbox shared-link view from recording URL", async () => {
    const openExternalUrl = vi.fn();
    const replayId = "scl/fi/abc/file.zip?rlkey=xyz";
    const button = makeButton({
      "data-recording-url": `https://tracing.gnas.dev/dropbox/${encodeURIComponent(replayId)}`,
      "data-provider": "dropbox",
      "data-folder-id": "/gn-tracing",
    });
    await handleUploadHistoryAction(button, {
      openExternalUrl,
      copyLink: vi.fn(),
      deleteHistoryEntry: vi.fn(),
    });
    expect(openExternalUrl).toHaveBeenCalledWith(
      "https://www.dropbox.com/scl/fi/abc/file.zip?rlkey=xyz&dl=0",
    );
  });

  it("falls back to Dropbox folder home when no shared-link id", async () => {
    const openExternalUrl = vi.fn();
    const button = makeButton({
      "data-action": "open-folder",
      "data-provider": "dropbox",
      "data-folder-id": "/gn-tracing",
    });
    await handleUploadHistoryAction(button, {
      openExternalUrl,
      copyLink: vi.fn(),
      deleteHistoryEntry: vi.fn(),
    });
    expect(openExternalUrl).toHaveBeenCalledWith("https://www.dropbox.com/home/gn-tracing");
  });
});
