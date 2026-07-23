import { afterEach, describe, expect, it, vi } from "vitest";
import { makeWebmSeekable } from "./webm-seek-fix";

vi.mock("webm-duration-fix", () => ({
  default: vi.fn(),
}));

import fixWebmDurationWithCues from "webm-duration-fix";

const mockedFix = vi.mocked(fixWebmDurationWithCues);

afterEach(() => {
  mockedFix.mockReset();
});

describe("makeWebmSeekable", () => {
  it("noops non-webm mime types without calling the library", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "video/mp4" });
    const result = await makeWebmSeekable(blob, { mimeType: "video/mp4" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.method).toBe("noop");
      expect(result.blob).toBe(blob);
    }
    expect(mockedFix).not.toHaveBeenCalled();
  });

  it("fails open on empty blob without calling the library", async () => {
    const blob = new Blob([], { type: "video/webm" });
    const result = await makeWebmSeekable(blob);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("empty-blob");
      expect(result.blob).toBe(blob);
    }
    expect(mockedFix).not.toHaveBeenCalled();
  });

  it("returns ok cues when the library produces a refined blob", async () => {
    const input = new Blob([new Uint8Array([0xaa])], { type: "video/webm" });
    const refined = new Blob([new Uint8Array([0xbb, 0xcc])], { type: "video/webm" });
    mockedFix.mockResolvedValueOnce(refined);

    const result = await makeWebmSeekable(input, { mimeType: "video/webm" });
    expect(mockedFix).toHaveBeenCalledOnce();
    expect(mockedFix).toHaveBeenCalledWith(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.method).toBe("cues");
      expect(result.blob).toBe(refined);
    }
  });

  it("fails open with original blob when the library throws (not silent success)", async () => {
    const input = new Blob([new Uint8Array([0x1a, 0x45])], { type: "video/webm" });
    mockedFix.mockRejectedValueOnce(new Error("parse failed"));

    const result = await makeWebmSeekable(input, { mimeType: "video/webm" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("parse failed");
      expect(result.blob).toBe(input);
    }
  });

  it("fails open when the library returns an empty blob", async () => {
    const input = new Blob([new Uint8Array([0x01])], { type: "video/webm" });
    mockedFix.mockResolvedValueOnce(new Blob([], { type: "video/webm" }));

    const result = await makeWebmSeekable(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("cues-rewrite-empty");
      expect(result.blob).toBe(input);
    }
  });

  it("does not report success for unfixed webm when Duration-like failure is only empty rewrite", async () => {
    // Regression guard for the old duration-only path that returned ok:true/noop
    // when Duration already existed but Cues did not.
    const input = new Blob([new Uint8Array([0x44, 0x89, 0x01])], { type: "video/webm" });
    mockedFix.mockRejectedValueOnce(new Error("no cues"));

    const result = await makeWebmSeekable(input);
    expect(result.ok).toBe(false);
    expect(result.blob).toBe(input);
  });
});
