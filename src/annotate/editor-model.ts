/**
 * Annotation editor state, with no DOM in sight.
 *
 * The editor's interesting behaviour is not the canvas — it is undo/redo, hit
 * testing for selection and deletion, and the rule that a report cannot be
 * saved while a redaction is still pending. Keeping that in a plain model means
 * it is testable, and it keeps `annotate.ts` down to wiring.
 */

import type {
  Annotation,
  AnnotationType,
  NormalizedPoint,
  NormalizedRect,
} from "../../packages/replay-core/src/schema/annotation";
import { normalizeRect } from "../../packages/replay-core/src/schema/annotation";

export type EditorTool = AnnotationType | "select";

/** How close a click must land to a shape to select it, in normalised units. */
const HIT_TOLERANCE = 0.02;

let idCounter = 0;

function nextId(): string {
  idCounter += 1;
  return `ann-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

export interface CreateShapeInput {
  tool: Exclude<EditorTool, "select">;
  from: NormalizedPoint;
  to: NormalizedPoint;
  color: string;
  /** Freehand path, when the tool is `freehand`. */
  points?: NormalizedPoint[];
  text?: string;
}

function rectFrom(from: NormalizedPoint, to: NormalizedPoint): NormalizedRect {
  return normalizeRect({ x: from.x, y: from.y, width: to.x - from.x, height: to.y - from.y });
}

/** Builds a shape from a completed drag. Returns null for a degenerate one. */
export function createShape(input: CreateShapeInput): Annotation | null {
  const base = { id: nextId(), createdAt: Date.now(), color: input.color };

  switch (input.tool) {
    case "arrow": {
      // A zero-length arrow is a stray click, not an annotation.
      const dx = input.to.x - input.from.x;
      const dy = input.to.y - input.from.y;
      if (Math.hypot(dx, dy) < 0.01) {
        return null;
      }
      return { ...base, type: "arrow", from: input.from, to: input.to };
    }
    case "rect":
    case "ellipse":
    case "highlight":
    case "redact": {
      const rect = rectFrom(input.from, input.to);
      if (rect.width < 0.005 || rect.height < 0.005) {
        return null;
      }
      if (input.tool === "redact") {
        // Starts pending on purpose: the pixels have not been destroyed yet,
        // and `assertReadyToSave` refuses to let it ship in that state.
        return { ...base, type: "redact", rect, applied: "pending" };
      }
      if (input.tool === "highlight") {
        return { ...base, type: "highlight", rect };
      }
      return { ...base, type: input.tool, rect };
    }
    case "freehand": {
      const points = input.points ?? [];
      if (points.length < 2) {
        return null;
      }
      return { ...base, type: "freehand", points };
    }
    case "text": {
      const text = (input.text ?? "").trim();
      if (!text) {
        return null;
      }
      return { ...base, type: "text", at: input.from, text };
    }
    default:
      return null;
  }
}

function rectContains(rect: NormalizedRect, point: NormalizedPoint): boolean {
  const oriented = normalizeRect(rect);
  return (
    point.x >= oriented.x - HIT_TOLERANCE &&
    point.x <= oriented.x + oriented.width + HIT_TOLERANCE &&
    point.y >= oriented.y - HIT_TOLERANCE &&
    point.y <= oriented.y + oriented.height + HIT_TOLERANCE
  );
}

function nearSegment(point: NormalizedPoint, from: NormalizedPoint, to: NormalizedPoint): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    return Math.hypot(point.x - from.x, point.y - from.y) <= HIT_TOLERANCE;
  }
  const t = Math.max(
    0,
    Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSquared),
  );
  return Math.hypot(point.x - (from.x + t * dx), point.y - (from.y + t * dy)) <= HIT_TOLERANCE;
}

/** Topmost shape under a point, or null. Later shapes win, as they are on top. */
export function hitTest(annotations: Annotation[], point: NormalizedPoint): Annotation | null {
  for (let index = annotations.length - 1; index >= 0; index -= 1) {
    const annotation = annotations[index];
    switch (annotation.type) {
      case "arrow":
        if (nearSegment(point, annotation.from, annotation.to)) {
          return annotation;
        }
        break;
      case "rect":
      case "ellipse":
      case "highlight":
      case "redact":
        if (rectContains(annotation.rect, point)) {
          return annotation;
        }
        break;
      case "freehand":
        for (let i = 1; i < annotation.points.length; i += 1) {
          if (nearSegment(point, annotation.points[i - 1], annotation.points[i])) {
            return annotation;
          }
        }
        break;
      case "text":
        if (
          Math.abs(point.x - annotation.at.x) < 0.12 &&
          Math.abs(point.y - annotation.at.y) < 0.05
        ) {
          return annotation;
        }
        break;
    }
  }
  return null;
}

/**
 * Undo/redo over whole annotation lists.
 *
 * Snapshotting the list rather than diffing operations: the lists are tiny, and
 * an editor whose undo silently diverges from what is on screen is worse than
 * one that spends a few hundred bytes per step.
 */
export class EditorHistory {
  #past: Annotation[][] = [];
  #future: Annotation[][] = [];
  #current: Annotation[] = [];

  constructor(initial: Annotation[] = []) {
    this.#current = [...initial];
  }

  get annotations(): Annotation[] {
    return this.#current;
  }

  get canUndo(): boolean {
    return this.#past.length > 0;
  }

  get canRedo(): boolean {
    return this.#future.length > 0;
  }

  commit(next: Annotation[]): void {
    this.#past.push([...this.#current]);
    this.#current = [...next];
    // A new edit invalidates the redo branch; keeping it would let a user
    // "redo" their way into a state that never followed from what they see.
    this.#future = [];
  }

  add(annotation: Annotation): void {
    this.commit([...this.#current, annotation]);
  }

  remove(id: string): void {
    this.commit(this.#current.filter((annotation) => annotation.id !== id));
  }

  undo(): void {
    const previous = this.#past.pop();
    if (!previous) {
      return;
    }
    this.#future.push([...this.#current]);
    this.#current = previous;
  }

  redo(): void {
    const next = this.#future.pop();
    if (!next) {
      return;
    }
    this.#past.push([...this.#current]);
    this.#current = next;
  }
}

/**
 * Throws when the report is not safe to package.
 *
 * The only current rule is the important one: a `redact` shape that is still
 * `pending` means the reporter drew a box over something private and the pixels
 * were never destroyed. Saving in that state would ship the very region they
 * were trying to hide.
 */
export function assertReadyToSave(annotations: Annotation[]): void {
  const pending = annotations.filter(
    (annotation) => annotation.type === "redact" && annotation.applied === "pending",
  );
  if (pending.length > 0) {
    // Not a user-facing failure in normal use: the save path bakes redactions
    // first. This guards the case where baking was skipped or failed.
    throw new Error(
      `${pending.length} redaction(s) have not been applied to the image yet. Refusing to save a screenshot whose hidden regions are still readable.`,
    );
  }
}
