import type { BrushId, Stroke, StrokePoint } from './types';

/**
 * The brush collection.
 *
 * Each brush is a small set of physical parameters rather than a bespoke
 * routine: how much pressure changes the width, how much speed thins the line,
 * whether the nib is round or chisel-shaped, how grainy the deposit is. A
 * handful of numbers gives a fountain pen that swells on the downstroke and a
 * charcoal stick that drags, from the same code path.
 *
 * Everything reads pressure and tilt from the PointerEvent, so a stylus gets
 * genuine expression while a mouse gets a clean, even line instead of a
 * randomly wobbling one.
 */

export type NibShape = 'round' | 'chisel';

export interface Brush {
  id: BrushId;
  /** i18n key under `canvas.brushes`. */
  label: BrushId;
  /** Rough visual family, used to group the picker. */
  family: 'ink' | 'dry' | 'paint' | 'effect' | 'tool';
  opacity: number;
  widthScale: number;
  composite: GlobalCompositeOperation;
  nib: NibShape;
  /** Chisel angle in degrees; the classic calligraphic hold is about 40°. */
  nibAngle?: number;
  /** 0 = width ignores pressure, 1 = width is all pressure. */
  pressure: number;
  /** How much a fast stroke thins the line, as a real nib does. */
  velocity: number;
  /** Sideways scatter, in fractions of the stroke width. */
  grain?: number;
  /** Repeated passes build up tooth and irregularity. */
  passes?: number;
  glow?: number;
  dash?: [number, number];
  /** Airbrush spray radius, in fractions of the stroke width. */
  spray?: number;
  /** Draws a second line offset by this fraction of the width. */
  ribbon?: number;
  /** Tapers the last few points, the way lifting a brush does. */
  taper?: number;
}

export const BRUSHES: Brush[] = [
  { id: 'fineliner', label: 'fineliner', family: 'ink', opacity: 1, widthScale: 0.7, composite: 'source-over', nib: 'round', pressure: 0.15, velocity: 0 },
  { id: 'ballpoint', label: 'ballpoint', family: 'ink', opacity: 0.92, widthScale: 0.9, composite: 'source-over', nib: 'round', pressure: 0.45, velocity: 0.35, grain: 0.05 },
  { id: 'fountain', label: 'fountain', family: 'ink', opacity: 1, widthScale: 1.5, composite: 'source-over', nib: 'chisel', nibAngle: 40, pressure: 0.55, velocity: 0.9, taper: 0.55 },
  { id: 'calligraphy', label: 'calligraphy', family: 'ink', opacity: 1, widthScale: 2.6, composite: 'source-over', nib: 'chisel', nibAngle: 30, pressure: 0.2, velocity: 0 },
  { id: 'brush', label: 'brush', family: 'paint', opacity: 0.96, widthScale: 2.2, composite: 'source-over', nib: 'round', pressure: 0.85, velocity: 0.5, taper: 0.7 },
  { id: 'marker', label: 'marker', family: 'paint', opacity: 0.9, widthScale: 2.4, composite: 'source-over', nib: 'chisel', nibAngle: 55, pressure: 0.1, velocity: 0 },
  { id: 'pencil', label: 'pencil', family: 'dry', opacity: 0.7, widthScale: 0.85, composite: 'source-over', nib: 'round', pressure: 0.6, velocity: 0.2, grain: 0.35, passes: 2 },
  { id: 'charcoal', label: 'charcoal', family: 'dry', opacity: 0.5, widthScale: 2.1, composite: 'source-over', nib: 'round', pressure: 0.7, velocity: 0.3, grain: 0.9, passes: 4 },
  { id: 'crayon', label: 'crayon', family: 'dry', opacity: 0.55, widthScale: 1.9, composite: 'source-over', nib: 'round', pressure: 0.5, velocity: 0.15, grain: 0.7, passes: 3 },
  { id: 'highlighter', label: 'highlighter', family: 'effect', opacity: 0.28, widthScale: 4.2, composite: 'multiply', nib: 'chisel', nibAngle: 0, pressure: 0, velocity: 0 },
  { id: 'airbrush', label: 'airbrush', family: 'effect', opacity: 0.35, widthScale: 2.6, composite: 'source-over', nib: 'round', pressure: 0.5, velocity: 0.1, spray: 0.9 },
  { id: 'neon', label: 'neon', family: 'effect', opacity: 1, widthScale: 1.1, composite: 'source-over', nib: 'round', pressure: 0.3, velocity: 0, glow: 16 },
  { id: 'dashed', label: 'dashed', family: 'effect', opacity: 1, widthScale: 0.9, composite: 'source-over', nib: 'round', pressure: 0.2, velocity: 0, dash: [3, 4] },
  { id: 'ribbon', label: 'ribbon', family: 'effect', opacity: 0.95, widthScale: 0.8, composite: 'source-over', nib: 'round', pressure: 0.3, velocity: 0.2, ribbon: 2.6 },
  { id: 'eraser', label: 'eraser', family: 'tool', opacity: 1, widthScale: 3, composite: 'destination-out', nib: 'round', pressure: 0.2, velocity: 0 },
];

const BY_ID = new Map(BRUSHES.map((b) => [b.id, b]));
export const brushById = (id: BrushId | undefined): Brush => BY_ID.get(id ?? 'fineliner') ?? BRUSHES[0];

/** Deterministic per-stroke noise, so a redraw does not reshuffle the grain. */
function noiseFor(seed: number): () => number {
  let state = seed || 1;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296 - 0.5;
  };
}

const distance = (a: StrokePoint, b: StrokePoint) => Math.hypot(b.x - a.x, b.y - a.y);

/**
 * Width at a point, from the brush's physics.
 *
 * A mouse reports a constant 0.5 pressure, so pressure response is only
 * applied to real pen input — otherwise every mouse line would come out the
 * same slightly-wrong thickness and the brushes would be indistinguishable.
 */
function widthAt(
  stroke: Stroke,
  brush: Brush,
  index: number,
  baseWidth: number,
  speed: number,
): number {
  const point = stroke.points[index];
  const isPen = stroke.pointerType === 'pen';
  const pressure = isPen ? (point.p ?? 0.5) : 0.5;

  let width = baseWidth * brush.widthScale;
  width *= 1 - brush.pressure + brush.pressure * (pressure * 1.8);

  if (brush.velocity > 0) {
    // Faster movement lays down less ink, as a nib does.
    width *= 1 / (1 + speed * brush.velocity * 0.06);
  }

  // Tilting a stylus broadens the mark.
  if (isPen && brush.nib === 'chisel') {
    width *= 1 + Math.min(0.5, Math.abs(point.tx ?? 0) / 90);
  }

  if (brush.taper) {
    // Ease the width down over the last stretch, like lifting the brush.
    const fromEnd = stroke.points.length - 1 - index;
    const window = Math.max(2, Math.round(stroke.points.length * 0.18));
    if (fromEnd < window) {
      const t = fromEnd / window;
      width *= 1 - brush.taper * (1 - t);
    }
  }

  return Math.max(0.4, width);
}

/** Per-point speed in px/ms, smoothed a little so the line does not chatter. */
function speeds(points: StrokePoint[]): number[] {
  const out: number[] = new Array(points.length).fill(0);
  for (let i = 1; i < points.length; i++) {
    const dt = Math.max(1, (points[i].t ?? i * 16) - (points[i - 1].t ?? (i - 1) * 16));
    const raw = distance(points[i - 1], points[i]) / dt;
    out[i] = out[i - 1] * 0.6 + raw * 0.4;
  }
  if (out.length > 1) out[0] = out[1];
  return out;
}

/** A round-nib line whose width follows pressure and speed. */
function paintRound(
  ctx: CanvasRenderingContext2D,
  stroke: Stroke,
  brush: Brush,
  baseWidth: number,
  velocity: number[],
  rand: () => number,
) {
  const points = stroke.points;
  const grain = brush.grain ?? 0;

  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1];
    const to = points[i];
    const width = (widthAt(stroke, brush, i - 1, baseWidth, velocity[i - 1]) +
      widthAt(stroke, brush, i, baseWidth, velocity[i])) / 2;
    const wobble = grain * width;

    ctx.beginPath();
    ctx.lineWidth = width;
    ctx.moveTo(from.x + rand() * wobble, from.y + rand() * wobble);
    // Smoothing through the midpoint removes the polygon look of raw samples.
    const midX = (from.x + to.x) / 2;
    const midY = (from.y + to.y) / 2;
    ctx.quadraticCurveTo(from.x, from.y, midX, midY);
    ctx.lineTo(to.x + rand() * wobble, to.y + rand() * wobble);
    ctx.stroke();
  }
}

/**
 * A chisel nib: instead of a round cap the mark is a ribbon between two
 * offset edges, so the line is broad across the nib and thin along it. This is
 * what makes calligraphy and fountain strokes swell and taper with direction.
 */
function paintChisel(
  ctx: CanvasRenderingContext2D,
  stroke: Stroke,
  brush: Brush,
  baseWidth: number,
  velocity: number[],
) {
  const points = stroke.points;
  if (points.length < 2) return;

  const angle = ((brush.nibAngle ?? 40) * Math.PI) / 180;
  const nx = Math.cos(angle);
  const ny = Math.sin(angle);

  const left: Array<[number, number]> = [];
  const right: Array<[number, number]> = [];

  for (let i = 0; i < points.length; i++) {
    const half = widthAt(stroke, brush, i, baseWidth, velocity[i]) / 2;
    left.push([points[i].x - nx * half, points[i].y - ny * half]);
    right.push([points[i].x + nx * half, points[i].y + ny * half]);
  }

  ctx.beginPath();
  ctx.moveTo(left[0][0], left[0][1]);
  for (let i = 1; i < left.length; i++) ctx.lineTo(left[i][0], left[i][1]);
  for (let i = right.length - 1; i >= 0; i--) ctx.lineTo(right[i][0], right[i][1]);
  ctx.closePath();
  ctx.fill();
  // A hairline along the edge keeps very thin sections from disappearing.
  ctx.lineWidth = 0.6;
  ctx.stroke();
}

/** Scattered dots along the path, densest at the centre. */
function paintSpray(
  ctx: CanvasRenderingContext2D,
  stroke: Stroke,
  brush: Brush,
  baseWidth: number,
  velocity: number[],
  rand: () => number,
) {
  const points = stroke.points;
  for (let i = 0; i < points.length; i++) {
    const width = widthAt(stroke, brush, i, baseWidth, velocity[i]);
    const radius = width * (brush.spray ?? 1);
    const dots = Math.max(3, Math.round(width * 1.4));
    for (let d = 0; d < dots; d++) {
      // Two random offsets sum toward the middle, so the spray has a soft core.
      const ox = (rand() + rand()) * radius;
      const oy = (rand() + rand()) * radius;
      ctx.beginPath();
      ctx.arc(points[i].x + ox, points[i].y + oy, Math.max(0.4, width * 0.09), 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/** Paint one stroke with its brush. */
export function paintStroke(
  ctx: CanvasRenderingContext2D,
  stroke: Stroke,
  fallbackColor: string,
  fallbackWidth: number,
) {
  const brush = brushById(stroke.tool);
  const points = stroke.points;
  if (!points.length) return;

  const color = stroke.color ?? fallbackColor;
  const baseWidth = stroke.width ?? fallbackWidth;
  const velocity = speeds(points);

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalCompositeOperation = brush.composite;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.globalAlpha = brush.opacity;
  if (brush.dash) ctx.setLineDash(brush.dash.map((d) => d * baseWidth));

  if (points.length === 1) {
    // A tap should still leave a mark.
    ctx.beginPath();
    ctx.arc(points[0].x, points[0].y, Math.max(0.5, (baseWidth * brush.widthScale) / 2), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  if (brush.glow) {
    // The glow is a wide, soft pass under a bright core.
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = brush.glow;
    ctx.globalAlpha = 0.55;
    paintRound(ctx, stroke, { ...brush, widthScale: brush.widthScale * 2.1 }, baseWidth, velocity, noiseFor(1));
    ctx.restore();
  }

  if (brush.spray) {
    paintSpray(ctx, stroke, brush, baseWidth, velocity, noiseFor(points.length * 7 + 3));
  } else if (brush.nib === 'chisel') {
    paintChisel(ctx, stroke, brush, baseWidth, velocity);
  } else {
    const passes = brush.passes ?? 1;
    // Multiple offset passes build up the tooth of a dry medium.
    for (let pass = 0; pass < passes; pass++) {
      ctx.globalAlpha = brush.opacity / Math.sqrt(passes);
      paintRound(ctx, stroke, brush, baseWidth, velocity, noiseFor(points.length * 31 + pass * 977 + 11));
    }
  }

  if (brush.ribbon) {
    // A second line running parallel to the first.
    const offset = baseWidth * brush.ribbon;
    ctx.globalAlpha = brush.opacity * 0.75;
    const shifted: Stroke = {
      ...stroke,
      points: points.map((p, i) => {
        const next = points[Math.min(points.length - 1, i + 1)];
        const prev = points[Math.max(0, i - 1)];
        const dx = next.x - prev.x;
        const dy = next.y - prev.y;
        const length = Math.hypot(dx, dy) || 1;
        return { ...p, x: p.x - (dy / length) * offset, y: p.y + (dx / length) * offset };
      }),
    };
    paintRound(ctx, shifted, brush, baseWidth, velocity, noiseFor(5));
  }

  ctx.restore();
}
