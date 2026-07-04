/**
 * Pure drawing-stroke helpers shared by the overlay content script and tests.
 */

export interface RawDrawPoint {
  x: number;
  y: number;
  t: number;
}

export interface RawDrawStroke {
  strokeId: string;
  timestamp: number;
  color: string;
  width: number;
  points: RawDrawPoint[];
}

export interface CreateStrokeOptions {
  strokeId: string;
  timestamp: number;
  color?: string;
  width?: number;
  points?: RawDrawPoint[];
}

export function createStroke(options: CreateStrokeOptions): RawDrawStroke {
  return {
    strokeId: options.strokeId,
    timestamp: options.timestamp,
    color: options.color || "#ff6b6b",
    width: options.width ?? 3,
    points: options.points ? [...options.points] : [],
  };
}

export function downsamplePoints(
  points: RawDrawPoint[],
  minDistancePx = 2,
  minTimeMs = 8,
): RawDrawPoint[] {
  if (points.length === 0) {
    return [];
  }

  const minDistanceSquared = minDistancePx * minDistancePx;
  const result: RawDrawPoint[] = [points[0]];

  for (let i = 1; i < points.length; i += 1) {
    const prev = result[result.length - 1];
    const current = points[i];
    const dx = current.x - prev.x;
    const dy = current.y - prev.y;
    const dt = current.t - prev.t;
    if (dt >= minTimeMs || dx * dx + dy * dy >= minDistanceSquared) {
      result.push(current);
    }
  }

  return result;
}

export function addStrokePoint(
  stroke: RawDrawStroke,
  point: Omit<RawDrawPoint, "t">,
  now: number,
  minDistancePx = 2,
  minTimeMs = 8,
  maxPoints = 500,
): RawDrawPoint | null {
  const points = stroke.points;
  const t = Math.max(0, now - stroke.timestamp);
  const candidate: RawDrawPoint = { x: point.x, y: point.y, t };

  if (points.length >= maxPoints) {
    return null;
  }

  if (points.length > 0) {
    const last = points[points.length - 1];
    const dt = candidate.t - last.t;
    const dx = candidate.x - last.x;
    const dy = candidate.y - last.y;
    if (dt < minTimeMs && dx * dx + dy * dy < minDistancePx * minDistancePx) {
      return null;
    }
  }

  points.push(candidate);
  return candidate;
}
