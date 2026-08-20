import { normalize, type CloudPoint, type PointCloud } from './pointcloud';

/**
 * Templates are generated from parametric definitions rather than recorded by
 * hand: a formula gives perfectly even sampling, stays readable, and costs a
 * few hundred bytes instead of thousands of literal coordinates.
 */

type Pt = [number, number];

function line(from: Pt, to: Pt, steps = 12): Pt[] {
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = i / steps;
    return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t] as Pt;
  });
}

function arc(cx: number, cy: number, rx: number, ry: number, from: number, to: number, steps = 24): Pt[] {
  return Array.from({ length: steps + 1 }, (_, i) => {
    const angle = from + ((to - from) * i) / steps;
    return [cx + rx * Math.cos(angle), cy + ry * Math.sin(angle)] as Pt;
  });
}

function polyline(points: Pt[], stepsPerSegment = 8): Pt[] {
  const out: Pt[] = [];
  for (let i = 1; i < points.length; i++) {
    out.push(...line(points[i - 1], points[i], stepsPerSegment).slice(i === 1 ? 0 : 1));
  }
  return out;
}

const TAU = Math.PI * 2;

/** Star polygon: five outer points with inner vertices between them. */
function star(cx: number, cy: number, outer: number, inner: number): Pt[] {
  const vertices: Pt[] = [];
  for (let i = 0; i <= 10; i++) {
    const radius = i % 2 === 0 ? outer : inner;
    const angle = -Math.PI / 2 + (i * Math.PI) / 5;
    vertices.push([cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)]);
  }
  return polyline(vertices, 5);
}

function heart(): Pt[] {
  return Array.from({ length: 60 }, (_, i) => {
    const t = (i / 59) * TAU;
    return [16 * Math.sin(t) ** 3, -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t))] as Pt;
  });
}

function spiral(turns = 2.5): Pt[] {
  const steps = 70;
  return Array.from({ length: steps }, (_, i) => {
    const t = (i / (steps - 1)) * TAU * turns;
    const r = 4 + t * 5;
    return [r * Math.cos(t), r * Math.sin(t)] as Pt;
  });
}

/** A definition is one or more strokes; each stroke is a list of points. */
type Definition = Record<string, Pt[][]>;

const SHAPES: Definition = {
  check: [polyline([[0, 55], [30, 90], [95, 5]], 12)],
  circle: [arc(50, 50, 45, 45, 0, TAU, 36)],
  ellipse: [arc(50, 50, 48, 26, 0, TAU, 36)],
  triangle: [polyline([[50, 5], [95, 90], [5, 90], [50, 5]], 10)],
  rectangle: [polyline([[5, 15], [95, 15], [95, 85], [5, 85], [5, 15]], 10)],
  line: [line([0, 50], [100, 50], 24)],
  strike: [line([0, 50], [100, 46], 24)],
  arrow: [polyline([[0, 50], [80, 50]], 20), polyline([[55, 22], [82, 50], [55, 78]], 10)],
  cross: [line([10, 10], [90, 90], 16), line([90, 10], [10, 90], 16)],
  star: [star(50, 50, 46, 19)],
  heart: [heart()],
  plus: [line([50, 8], [50, 92], 16), line([8, 50], [92, 50], 16)],
  caret: [polyline([[10, 80], [50, 15], [90, 80]], 12)],
  vee: [polyline([[10, 15], [50, 85], [90, 15]], 12)],
  zigzag: [polyline([[5, 70], [30, 25], [55, 70], [80, 25]], 8)],
  spiral: [spiral()],
  exclaim: [line([50, 5], [50, 66], 16), arc(50, 88, 4, 4, 0, TAU, 10)],
  question: [
    [...arc(50, 28, 22, 22, Math.PI, TAU * 0.92, 20), ...line([53, 45], [50, 66], 8)],
    arc(50, 88, 4, 4, 0, TAU, 10),
  ],
  bracket: [polyline([[70, 10], [30, 10], [30, 90], [70, 90]], 10)],
  underline: [line([5, 80], [95, 80], 20)],
};

/** Digits, drawn the way most people write them. */
const DIGITS: Definition = {
  '0': [arc(50, 50, 32, 45, 0, TAU, 34)],
  '1': [polyline([[28, 22], [50, 8], [50, 92]], 12)],
  '2': [[...arc(50, 30, 30, 24, Math.PI, TAU * 0.92, 18), ...polyline([[72, 44], [18, 92], [84, 92]], 10)]],
  '3': [[...arc(48, 28, 26, 20, Math.PI, TAU * 0.5, 16), ...arc(48, 68, 28, 24, Math.PI * 1.5, TAU * 1.5 + Math.PI * 1.2, 18)]],
  '4': [polyline([[68, 8], [14, 66], [88, 66]], 12), line([68, 30], [68, 92], 12)],
  '5': [polyline([[80, 10], [26, 10], [22, 46]], 10), arc(52, 66, 30, 26, Math.PI, TAU * 1.4, 20)],
  '6': [[...arc(52, 50, 30, 42, Math.PI * 1.7, Math.PI * 3.1, 24), ...arc(52, 68, 28, 24, Math.PI, TAU + Math.PI, 20)]],
  '7': [polyline([[14, 10], [86, 10], [40, 92]], 12)],
  '8': [[...arc(50, 28, 24, 20, 0, TAU, 20), ...arc(50, 70, 30, 22, 0, TAU, 22)]],
  '9': [[...arc(50, 32, 28, 26, 0, TAU, 22), ...polyline([[78, 34], [66, 92]], 10)]],
};

function toCloudPoints(strokes: Pt[][]): CloudPoint[] {
  const out: CloudPoint[] = [];
  strokes.forEach((stroke, id) => {
    for (const [x, y] of stroke) out.push({ x, y, id });
  });
  return out;
}

function build(definitions: Definition): PointCloud[] {
  return Object.entries(definitions).map(([name, strokes]) => ({
    name,
    points: normalize(toCloudPoints(strokes)),
  }));
}

export const SHAPE_TEMPLATES: PointCloud[] = build(SHAPES);
export const DIGIT_TEMPLATES: PointCloud[] = build(DIGITS);
export const ALL_TEMPLATES: PointCloud[] = [...SHAPE_TEMPLATES, ...DIGIT_TEMPLATES];

/** Pen gestures that map to an action on the item the sketch is attached to. */
export type GestureAction =
  | 'complete'
  | 'make_category'
  | 'pin'
  | 'delete'
  | 'move'
  | 'raise_priority'
  | 'unclear';

export const GESTURE_ACTIONS: Record<string, GestureAction> = {
  check: 'complete',
  circle: 'make_category',
  ellipse: 'make_category',
  star: 'pin',
  strike: 'delete',
  line: 'delete',
  cross: 'delete',
  arrow: 'move',
  exclaim: 'raise_priority',
  question: 'unclear',
};

/** Names shown to the user, keyed to the i18n `canvas.gestures.*` entries. */
export const GESTURE_I18N: Record<GestureAction, string> = {
  complete: 'canvas.gestures.check',
  make_category: 'canvas.gestures.circle',
  pin: 'canvas.gestures.star',
  delete: 'canvas.gestures.strike',
  move: 'canvas.gestures.arrow',
  raise_priority: 'canvas.gestures.exclaim',
  unclear: 'canvas.gestures.question',
};
