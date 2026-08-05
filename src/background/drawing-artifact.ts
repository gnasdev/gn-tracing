/**
 * Pure drawing-overlay package helpers (normalize strokes, build artifact JSON).
 *
 * Chrome I/O (inject / sendMessage / storage preference) stays in the service
 * worker; this module only shapes package data so it is unit-testable.
 */

import { DEFAULT_DRAW_COLOR, normalizeDrawColor } from "../shared/drawing";
import type { RecordingDrawingArtifact, RecordingDrawStroke } from "../types/recording";
import { normalizeFiniteNumber } from "./capture-environment";

export const MAX_DRAWING_STROKES = 2000;
export const MAX_DRAWING_POINTS_PER_STROKE = 500;
/** Soft cap on total points across all strokes in one session. */
export const MAX_TOTAL_DRAWING_POINTS = 100_000;
export const MAX_DRAWING_CLEARS = 100;

export function normalizeDrawingStroke(value: unknown): RecordingDrawStroke | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.strokeId !== "string" || !raw.strokeId) {
    return null;
  }
  const timestamp = normalizeFiniteNumber(raw.timestamp);
  if (!timestamp) {
    return null;
  }
  const color = normalizeDrawColor(raw.color) || DEFAULT_DRAW_COLOR;
  const width = normalizeFiniteNumber(raw.width) ?? 3;
  if (!Array.isArray(raw.points)) {
    return null;
  }
  const points: RecordingDrawStroke["points"] = [];
  for (const point of raw.points) {
    if (!point || typeof point !== "object") {
      continue;
    }
    const p = point as Record<string, unknown>;
    const x = normalizeFiniteNumber(p.x);
    const y = normalizeFiniteNumber(p.y);
    const t = normalizeFiniteNumber(p.t);
    if (x == null || y == null || t == null) {
      continue;
    }
    points.push({ x, y, t });
  }
  if (points.length === 0) {
    return null;
  }
  return {
    strokeId: raw.strokeId,
    timestamp,
    color,
    width,
    points: points.slice(0, MAX_DRAWING_POINTS_PER_STROKE),
  };
}

/**
 * Cap strokes/clears arrays in place when budgets are exceeded.
 * Returns true when a privacy limitation should be recorded for point budget.
 */
export function enforceDrawingBudgets(
  strokes: RecordingDrawStroke[],
  clears: number[],
): { droppedPoints: boolean } {
  let droppedPoints = false;
  if (strokes.length > MAX_DRAWING_STROKES) {
    strokes.splice(0, strokes.length - MAX_DRAWING_STROKES);
  }
  const totalPoints = () => strokes.reduce((sum, s) => sum + s.points.length, 0);
  if (totalPoints() > MAX_TOTAL_DRAWING_POINTS) {
    droppedPoints = true;
    while (strokes.length > 1 && totalPoints() > MAX_TOTAL_DRAWING_POINTS) {
      strokes.shift();
    }
  }
  if (clears.length > MAX_DRAWING_CLEARS) {
    clears.splice(0, clears.length - MAX_DRAWING_CLEARS);
  }
  return { droppedPoints };
}

export function buildDrawingArtifact(
  strokes: RecordingDrawStroke[],
  clears: number[],
): string | undefined {
  if (strokes.length === 0 && clears.length === 0) {
    return undefined;
  }
  const artifact: RecordingDrawingArtifact = { schemaVersion: 1, strokes };
  if (clears.length > 0) {
    artifact.clears = clears;
  }
  return JSON.stringify(artifact);
}
