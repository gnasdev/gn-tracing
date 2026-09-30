import { describe, expect, it } from "vitest";
import { coerceEpochMs } from "./time";

describe("coerceEpochMs", () => {
  it("returns null for non-finite or missing values", () => {
    expect(coerceEpochMs(undefined)).toBeNull();
    expect(coerceEpochMs(null)).toBeNull();
    expect(coerceEpochMs(Number.NaN)).toBeNull();
    expect(coerceEpochMs(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("treats values >= 1e11 as epoch ms", () => {
    expect(coerceEpochMs(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(coerceEpochMs(1e11)).toBe(1e11);
  });

  it("treats values >= 1e9 and < 1e11 as epoch seconds", () => {
    expect(coerceEpochMs(1_700_000_000)).toBe(1_700_000_000_000);
    expect(coerceEpochMs(1e9)).toBe(1e12);
  });

  it("returns fallback for values below the epoch-second threshold", () => {
    expect(coerceEpochMs(5_000)).toBeNull();
    expect(coerceEpochMs(5_000, 7_000)).toBe(7_000);
  });

  it("prefers detected epoch value over fallback", () => {
    expect(coerceEpochMs(1_700_000_000, 999)).toBe(1_700_000_000_000);
    expect(coerceEpochMs(1_700_000_000_000, 999)).toBe(1_700_000_000_000);
  });
});
