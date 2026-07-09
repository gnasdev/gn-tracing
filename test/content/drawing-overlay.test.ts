import { describe, expect, it } from "vitest";
import {
  addStrokePoint,
  createStroke,
  DEFAULT_DRAW_COLOR,
  downsamplePoints,
  normalizeDrawColor,
} from "../../src/shared/drawing";

describe("drawing helpers", () => {
  describe("normalizeDrawColor", () => {
    it("accepts 3, 6, and 8 digit hex colors", () => {
      expect(normalizeDrawColor("#F00")).toBe("#f00");
      expect(normalizeDrawColor("#Ff6B6B")).toBe("#ff6b6b");
      expect(normalizeDrawColor("#ff6b6b80")).toBe("#ff6b6b80");
    });

    it("rejects invalid colors", () => {
      expect(normalizeDrawColor("red")).toBeNull();
      expect(normalizeDrawColor("#gg0000")).toBeNull();
      expect(normalizeDrawColor("")).toBeNull();
      expect(normalizeDrawColor(null)).toBeNull();
    });
  });

  describe("createStroke", () => {
    it("creates a stroke with defaults", () => {
      const stroke = createStroke({ strokeId: "s1", timestamp: 1000 });
      expect(stroke.strokeId).toBe("s1");
      expect(stroke.timestamp).toBe(1000);
      expect(stroke.color).toBe(DEFAULT_DRAW_COLOR);
      expect(stroke.width).toBe(3);
      expect(stroke.points).toEqual([]);
    });

    it("uses provided options", () => {
      const stroke = createStroke({
        strokeId: "s2",
        timestamp: 2000,
        color: "#00ff00",
        width: 5,
        points: [{ x: 1, y: 2, t: 0 }],
      });
      expect(stroke.color).toBe("#00ff00");
      expect(stroke.width).toBe(5);
      expect(stroke.points).toEqual([{ x: 1, y: 2, t: 0 }]);
    });
  });

  describe("addStrokePoint", () => {
    it("adds the first point with t=0", () => {
      const stroke = createStroke({ strokeId: "s1", timestamp: 1000 });
      const point = addStrokePoint(stroke, { x: 10, y: 20 }, 1000);
      expect(point).toEqual({ x: 10, y: 20, t: 0 });
      expect(stroke.points).toHaveLength(1);
    });

    it("skips points that are too close in time and distance", () => {
      const stroke = createStroke({ strokeId: "s1", timestamp: 1000 });
      addStrokePoint(stroke, { x: 0, y: 0 }, 1000);
      const next = addStrokePoint(stroke, { x: 1, y: 1 }, 1002);
      expect(next).toBeNull();
      expect(stroke.points).toHaveLength(1);
    });

    it("adds points that are far enough apart", () => {
      const stroke = createStroke({ strokeId: "s1", timestamp: 1000 });
      addStrokePoint(stroke, { x: 0, y: 0 }, 1000);
      const next = addStrokePoint(stroke, { x: 10, y: 0 }, 1002);
      expect(next).not.toBeNull();
      expect(stroke.points).toHaveLength(2);
    });

    it("respects the max point limit", () => {
      const stroke = createStroke({ strokeId: "s1", timestamp: 1000 });
      for (let i = 0; i < 5; i += 1) {
        addStrokePoint(stroke, { x: i * 100, y: 0 }, 1000 + i * 100, 1, 1, 3);
      }
      expect(stroke.points).toHaveLength(3);
    });
  });

  describe("downsamplePoints", () => {
    it("keeps the first point", () => {
      expect(downsamplePoints([{ x: 0, y: 0, t: 0 }])).toEqual([{ x: 0, y: 0, t: 0 }]);
    });

    it("removes redundant intermediate points", () => {
      const points = [
        { x: 0, y: 0, t: 0 },
        { x: 0, y: 0, t: 4 },
        { x: 0, y: 0, t: 7 },
        { x: 100, y: 0, t: 12 },
      ];
      expect(downsamplePoints(points)).toEqual([
        { x: 0, y: 0, t: 0 },
        { x: 100, y: 0, t: 12 },
      ]);
    });
  });
});
