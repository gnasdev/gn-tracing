import { describe, expect, it } from "vitest";
import {
  buildDrawingArtifact,
  enforceDrawingBudgets,
  MAX_DRAWING_STROKES,
  normalizeDrawingStroke,
} from "./drawing-artifact";

describe("normalizeDrawingStroke", () => {
  it("accepts a valid stroke and drops bad points", () => {
    const stroke = normalizeDrawingStroke({
      strokeId: "s1",
      timestamp: 100,
      color: "#ff0000",
      width: 2,
      points: [
        { x: 1, y: 2, t: 0 },
        { x: "bad", y: 3, t: 1 },
        { x: 4, y: 5, t: 2 },
      ],
    });
    expect(stroke).not.toBeNull();
    expect(stroke?.strokeId).toBe("s1");
    expect(stroke?.points).toHaveLength(2);
  });

  it("rejects strokes without points or id", () => {
    expect(normalizeDrawingStroke({ timestamp: 1, points: [] })).toBeNull();
    expect(normalizeDrawingStroke(null)).toBeNull();
  });
});

describe("enforceDrawingBudgets", () => {
  it("trims oldest strokes past MAX_DRAWING_STROKES", () => {
    const strokes = Array.from({ length: MAX_DRAWING_STROKES + 5 }, (_, i) => ({
      strokeId: `s${i}`,
      timestamp: i,
      color: "#000",
      width: 1,
      points: [{ x: 0, y: 0, t: 0 }],
    }));
    enforceDrawingBudgets(strokes, []);
    expect(strokes).toHaveLength(MAX_DRAWING_STROKES);
    expect(strokes[0]?.strokeId).toBe("s5");
  });
});

describe("buildDrawingArtifact", () => {
  it("returns undefined when empty", () => {
    expect(buildDrawingArtifact([], [])).toBeUndefined();
  });

  it("serializes strokes and clears", () => {
    const json = buildDrawingArtifact(
      [
        {
          strokeId: "s1",
          timestamp: 1,
          color: "#fff",
          width: 1,
          points: [{ x: 0, y: 0, t: 0 }],
        },
      ],
      [10, 20],
    );
    expect(json).toBeDefined();
    if (!json) {
      throw new Error("expected drawing artifact JSON");
    }
    const parsed = JSON.parse(json);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.strokes).toHaveLength(1);
    expect(parsed.clears).toEqual([10, 20]);
  });
});
