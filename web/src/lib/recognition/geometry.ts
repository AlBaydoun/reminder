import { normalize, type CloudPoint, type PointCloud } from './pointcloud';

/**
 * Shared geometry for building recognizer templates.
 *
 * Templates are generated from parametric definitions rather than recorded by
 * hand: a formula samples evenly, stays readable, and costs a few hundred
 * bytes instead of thousands of literal coordinates. All shapes are authored
 * in a 0–100 box with y pointing down, like screen coordinates.
 */

export type Pt = [number, number];
/** One glyph: a list of strokes, each a list of points. */
export type Glyph = Pt[][];

export function line(from: Pt, to: Pt, steps = 10): Pt[] {
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = i / steps;
    return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t] as Pt;
  });
}

export function arc(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  from: number,
  to: number,
  steps = 20,
): Pt[] {
  return Array.from({ length: steps + 1 }, (_, i) => {
    const angle = from + ((to - from) * i) / steps;
    return [cx + rx * Math.cos(angle), cy + ry * Math.sin(angle)] as Pt;
  });
}

export function polyline(points: Pt[], stepsPerSegment = 8): Pt[] {
  const out: Pt[] = [];
  for (let i = 1; i < points.length; i++) {
    out.push(...line(points[i - 1], points[i], stepsPerSegment).slice(i === 1 ? 0 : 1));
  }
  return out;
}

/** Join several point runs into one continuous stroke. */
export const join = (...runs: Pt[][]): Pt[] => runs.flat();

export const TAU = Math.PI * 2;
/** Quarter turns, with y pointing down: RIGHT → DOWN → LEFT → UP. */
export const RIGHT = 0;
export const DOWN = Math.PI / 2;
export const LEFT = Math.PI;
export const UP = (3 * Math.PI) / 2;

export function toCloudPoints(strokes: Glyph): CloudPoint[] {
  const out: CloudPoint[] = [];
  strokes.forEach((stroke, id) => {
    for (const [x, y] of stroke) out.push({ x, y, id });
  });
  return out;
}

/**
 * Build point clouds from named glyphs. Several glyphs may share a name —
 * different ways of drawing the same character — and the recognizer keeps the
 * best match per name.
 */
export function buildTemplates(definitions: Array<[string, Glyph]>): PointCloud[] {
  return definitions.map(([name, strokes]) => {
    const raw = toCloudPoints(strokes);
    const xs = raw.map((p) => p.x);
    const ys = raw.map((p) => p.y);
    // Recorded before normalisation, which is where the aspect ratio is lost.
    const width = Math.max(...xs) - Math.min(...xs);
    const height = Math.max(...ys) - Math.min(...ys);
    return {
      name,
      points: normalize(raw),
      aspect: Math.max(width, 1) / Math.max(height, 1),
    };
  });
}
