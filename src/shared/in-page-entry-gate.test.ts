import { describe, expect, it } from "vitest";
import { shouldAcceptInPageEntry } from "./in-page-entry-gate";

const base = {
  sessionId: "sess-1",
  activeSessionId: "sess-1",
  senderTabId: 7,
  activeTabId: 7,
  isRecording: true,
  drainSessionId: null as string | null,
};

describe("shouldAcceptInPageEntry", () => {
  it("accepts matching live recording traffic", () => {
    expect(shouldAcceptInPageEntry(base)).toBe(true);
  });

  it("rejects wrong session even while recording", () => {
    expect(shouldAcceptInPageEntry({ ...base, sessionId: "other" })).toBe(false);
  });

  it("rejects wrong tab", () => {
    expect(shouldAcceptInPageEntry({ ...base, senderTabId: 99 })).toBe(false);
  });

  it("rejects when not recording and not draining", () => {
    expect(shouldAcceptInPageEntry({ ...base, isRecording: false })).toBe(false);
  });

  it("accepts drain-window entries after stop for the same session/tab", () => {
    expect(
      shouldAcceptInPageEntry({
        ...base,
        isRecording: false,
        drainSessionId: "sess-1",
      }),
    ).toBe(true);
  });

  it("rejects drain entries for a different session", () => {
    expect(
      shouldAcceptInPageEntry({
        ...base,
        isRecording: false,
        drainSessionId: "sess-other",
      }),
    ).toBe(false);
  });

  it("rejects missing sender tab id", () => {
    expect(shouldAcceptInPageEntry({ ...base, senderTabId: undefined })).toBe(false);
  });
});
