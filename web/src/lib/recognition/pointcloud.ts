/**
 * The $P Point-Cloud Recognizer (Vatavu, Anthony & Wobbrock, ICMI 2012).
 *
 * Chosen over a neural approach because it is tiny, needs no training data,
 * no model download and no network, works from a single example per symbol,
 * and — unlike stroke-order-sensitive recognizers — does not care whether a
 * cross is drawn left-then-right or top-then-bottom. That matters when the
 * input can come from a stylus, a finger or a mouse.
 */

export interface CloudPoint {
  x: number;
  y: number;
  /** Index of the stroke this point came from. */
  id: number;
}

export interface PointCloud {
  name: string;
  points: CloudPoint[];
  /**
   * Width / height of the glyph before normalisation. Scaling throws this
   * away, which is why a dash and a "1" look identical to the matcher —
   * keeping it lets the caller apply an aspect-ratio prior.
   */
  aspect?: number;
}

export const NUM_POINTS = 32;

const distance = (a: CloudPoint, b: CloudPoint) => Math.hypot(b.x - a.x, b.y - a.y);

function pathLength(points: CloudPoint[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    // Only measure within a stroke — the pen-up jump between strokes is not ink.
    if (points[i].id === points[i - 1].id) total += distance(points[i - 1], points[i]);
  }
  return total;
}

export function resample(points: CloudPoint[], n = NUM_POINTS): CloudPoint[] {
  const interval = pathLength(points) / (n - 1);
  if (!Number.isFinite(interval) || interval <= 0) {
    // Degenerate input (a dot, or a single point) — pad it out so the maths holds.
    const first = points[0] ?? { x: 0, y: 0, id: 0 };
    return Array.from({ length: n }, () => ({ ...first }));
  }

  let accumulated = 0;
  const out: CloudPoint[] = [{ ...points[0] }];
  const working = [...points];

  for (let i = 1; i < working.length; i++) {
    if (working[i].id !== working[i - 1].id) continue;
    const d = distance(working[i - 1], working[i]);
    if (accumulated + d >= interval) {
      const ratio = (interval - accumulated) / d;
      const inserted: CloudPoint = {
        x: working[i - 1].x + ratio * (working[i].x - working[i - 1].x),
        y: working[i - 1].y + ratio * (working[i].y - working[i - 1].y),
        id: working[i].id,
      };
      out.push(inserted);
      working.splice(i, 0, inserted);
      accumulated = 0;
    } else {
      accumulated += d;
    }
  }

  // Floating point drift can leave us one point short.
  while (out.length < n) out.push({ ...working[working.length - 1] });
  return out.slice(0, n);
}

export function scaleToUnit(points: CloudPoint[]): CloudPoint[] {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  // Uniform scale keeps aspect ratio, which is what separates a circle from an ellipse.
  const size = Math.max(maxX - minX, maxY - minY) || 1;
  return points.map((p) => ({ x: (p.x - minX) / size, y: (p.y - minY) / size, id: p.id }));
}

export function translateToOrigin(points: CloudPoint[]): CloudPoint[] {
  const n = points.length || 1;
  const cx = points.reduce((s, p) => s + p.x, 0) / n;
  const cy = points.reduce((s, p) => s + p.y, 0) / n;
  return points.map((p) => ({ x: p.x - cx, y: p.y - cy, id: p.id }));
}

export function normalize(points: CloudPoint[], n = NUM_POINTS): CloudPoint[] {
  return translateToOrigin(scaleToUnit(resample(points, n)));
}

/**
 * Greedy nearest-neighbour matching from a given start index, with points
 * matched early weighted more heavily (the confidence in a match decays as
 * the remaining choices shrink).
 */
function cloudDistance(a: CloudPoint[], b: CloudPoint[], start: number): number {
  const matched = new Array<boolean>(b.length).fill(false);
  let sum = 0;
  let i = start;
  do {
    let best = Infinity;
    let index = -1;
    for (let j = 0; j < b.length; j++) {
      if (matched[j]) continue;
      const d = distance(a[i], b[j]);
      if (d < best) {
        best = d;
        index = j;
      }
    }
    if (index >= 0) matched[index] = true;
    const weight = 1 - ((i - start + a.length) % a.length) / a.length;
    sum += weight * best;
    i = (i + 1) % a.length;
  } while (i !== start);
  return sum;
}

function greedyCloudMatch(a: CloudPoint[], b: CloudPoint[]): number {
  const epsilon = 0.5;
  const step = Math.max(1, Math.floor(Math.pow(a.length, 1 - epsilon)));
  let min = Infinity;
  for (let i = 0; i < a.length; i += step) {
    min = Math.min(min, cloudDistance(a, b, i), cloudDistance(b, a, i));
  }
  return min;
}

export interface RecognitionResult {
  name: string;
  score: number;
  runnerUp?: { name: string; score: number };
}

export interface ScoredTemplate {
  name: string;
  score: number;
  aspect?: number;
}

/**
 * Score a point cloud against every template, best first, one entry per name.
 * `weigh` can adjust a template's score before ranking — the word reader uses
 * it to apply an aspect-ratio prior.
 */
export function scoreAgainst(
  points: CloudPoint[],
  templates: PointCloud[],
  weigh?: (template: PointCloud, score: number) => number,
): ScoredTemplate[] {
  if (points.length < 2 || !templates.length) return [];
  const candidate = normalize(points);

  const scored = templates
    .map((template) => {
      const d = greedyCloudMatch(candidate, template.points);
      // Distance 0 → perfect match, 2 → nothing alike.
      const raw = Math.max((d - 2) / -2, 0);
      return { name: template.name, score: weigh ? weigh(template, raw) : raw, aspect: template.aspect };
    })
    .sort((a, b) => b.score - a.score);

  // Several templates may share a name (different ways of drawing the same
  // symbol); keep only the best of each so the runner-up is a real rival.
  const seen = new Set<string>();
  return scored.filter((s) => (seen.has(s.name) ? false : (seen.add(s.name), true)));
}

export function recognize(
  points: CloudPoint[],
  templates: PointCloud[],
): RecognitionResult | null {
  const ranked = scoreAgainst(points, templates);
  if (!ranked.length) return null;
  return { name: ranked[0].name, score: ranked[0].score, runnerUp: ranked[1] };
}

/** Convert app strokes into the recognizer's flat point cloud. */
export function toCloud(strokes: Array<{ points: Array<{ x: number; y: number }> }>): CloudPoint[] {
  const out: CloudPoint[] = [];
  strokes.forEach((stroke, id) => {
    for (const p of stroke.points) out.push({ x: p.x, y: p.y, id });
  });
  return out;
}
