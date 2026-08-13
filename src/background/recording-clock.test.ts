import { describe, expect, it } from "vitest";
import { elapsedFromRecordingStart } from "./recording-clock";

describe("elapsedFromRecordingStart", () => {
  it("uses the recording's epoch start as the duration origin", () => {
    expect(elapsedFromRecordingStart(1_700_000_000_250, 1_700_000_005_750)).toBe(5_500);
  });

  it("does not emit a negative duration when clocks are observed out of order", () => {
    expect(elapsedFromRecordingStart(1_700_000_005_750, 1_700_000_000_250)).toBe(0);
  });

  it("rejects a missing recording start", () => {
    expect(elapsedFromRecordingStart(null, 1_700_000_005_750)).toBe(0);
  });
});
