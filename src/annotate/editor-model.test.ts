/**
 * Editor model tests.
 *
 * Undo/redo and hit testing are the parts a user notices immediately when they
 * are wrong, and the pending-redaction guard is the part that would leak data
 * quietly if it were wrong.
 */

import { describe, expect, it } from "vitest";
import type { Annotation } from "../../packages/replay-core/src/schema/annotation";
import { assertReadyToSave, createShape, EditorHistory, hitTest } from "./editor-model";

const RED = "#ff3b30";

describe("createShape", () => {
  it("rejects a stray click as an arrow", () => {
    expect(
      createShape({
        tool: "arrow",
        from: { x: 0.5, y: 0.5 },
        to: { x: 0.502, y: 0.501 },
        color: RED,
      }),
    ).toBeNull();
  });

  it("orients a box drawn bottom-right to top-left", () => {
    const shape = createShape({
      tool: "rect",
      from: { x: 0.8, y: 0.9 },
      to: { x: 0.4, y: 0.5 },
      color: RED,
    });

    expect(shape).toMatchObject({
      type: "rect",
      rect: { x: 0.4, y: 0.5 },
    });
  });

  it("creates redactions pending, never pre-applied", () => {
    const shape = createShape({
      tool: "redact",
      from: { x: 0.1, y: 0.1 },
      to: { x: 0.4, y: 0.2 },
      color: RED,
    });

    // Marking it applied at creation time would mean the editor claims the
    // pixels are gone before anything has touched them.
    expect(shape).toMatchObject({ type: "redact", applied: "pending" });
  });

  it("drops an empty text note rather than storing a blank shape", () => {
    expect(
      createShape({
        tool: "text",
        from: { x: 0.5, y: 0.5 },
        to: { x: 0.5, y: 0.5 },
        color: RED,
        text: "   ",
      }),
    ).toBeNull();
  });

  it("needs at least two points for a freehand stroke", () => {
    expect(
      createShape({
        tool: "freehand",
        from: { x: 0, y: 0 },
        to: { x: 0, y: 0 },
        color: RED,
        points: [{ x: 0.1, y: 0.1 }],
      }),
    ).toBeNull();
  });
});

describe("hitTest", () => {
  const arrow: Annotation = {
    id: "a1",
    createdAt: 1,
    type: "arrow",
    from: { x: 0.1, y: 0.1 },
    to: { x: 0.9, y: 0.1 },
  };
  const box: Annotation = {
    id: "a2",
    createdAt: 2,
    type: "rect",
    rect: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 },
  };

  it("finds a shape under the pointer", () => {
    expect(hitTest([arrow, box], { x: 0.5, y: 0.5 })?.id).toBe("a2");
    expect(hitTest([arrow, box], { x: 0.5, y: 0.1 })?.id).toBe("a1");
  });

  it("returns null on empty space", () => {
    expect(hitTest([arrow, box], { x: 0.05, y: 0.95 })).toBeNull();
  });

  it("prefers the shape drawn last, since that is the one on top", () => {
    const overlapping: Annotation = { ...box, id: "a3", createdAt: 3 };
    expect(hitTest([box, overlapping], { x: 0.5, y: 0.5 })?.id).toBe("a3");
  });
});

describe("EditorHistory", () => {
  const shape = (id: string): Annotation => ({
    id,
    createdAt: 1,
    type: "rect",
    rect: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 },
  });

  it("undoes and redoes an add", () => {
    const history = new EditorHistory();
    history.add(shape("a"));
    history.add(shape("b"));
    expect(history.annotations.map((a) => a.id)).toEqual(["a", "b"]);

    history.undo();
    expect(history.annotations.map((a) => a.id)).toEqual(["a"]);
    history.redo();
    expect(history.annotations.map((a) => a.id)).toEqual(["a", "b"]);
  });

  it("does nothing when there is nothing to undo", () => {
    const history = new EditorHistory();
    expect(history.canUndo).toBe(false);
    history.undo();
    expect(history.annotations).toEqual([]);
  });

  it("discards the redo branch after a new edit", () => {
    const history = new EditorHistory();
    history.add(shape("a"));
    history.add(shape("b"));
    history.undo();

    history.add(shape("c"));

    // "b" is unreachable now, which is what a user expects: they undid it and
    // then did something else.
    expect(history.canRedo).toBe(false);
    expect(history.annotations.map((a) => a.id)).toEqual(["a", "c"]);
  });

  it("removes by id", () => {
    const history = new EditorHistory([shape("a"), shape("b")]);
    history.remove("a");
    expect(history.annotations.map((a) => a.id)).toEqual(["b"]);
    history.undo();
    expect(history.annotations.map((a) => a.id)).toEqual(["a", "b"]);
  });
});

describe("assertReadyToSave", () => {
  it("refuses a screenshot whose redaction was never applied", () => {
    expect(() =>
      assertReadyToSave([
        {
          id: "r1",
          createdAt: 1,
          type: "redact",
          rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 },
          applied: "pending",
        },
      ]),
    ).toThrow(/still readable/i);
  });

  it("accepts a redaction that has been baked", () => {
    expect(() =>
      assertReadyToSave([
        {
          id: "r1",
          createdAt: 1,
          type: "redact",
          rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 },
          applied: "blur",
        },
      ]),
    ).not.toThrow();
  });
});
