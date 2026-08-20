import { paintStroke } from './brushes';
import { fontById } from './fonts';
import { GLYPHS } from './recognition/letters';
import type { CanvasText, Stroke } from './types';

/**
 * Writes a line of text as ink strokes, and renders ink to an image.
 *
 * The glyph shapes are the same ones the recognizer matches against, so the
 * app can produce genuine handwriting-shaped strokes — used to give the demo a
 * real handwritten entry, and as a safety net for rendering a thumbnail that
 * was never generated. It is not a font: the point is stroke data, not looks.
 */

export interface WriteOptions {
  /** Cap height in pixels. */
  size?: number;
  x?: number;
  y?: number;
  color?: string;
  width?: number;
  /** 0 = mechanical, 1 = very shaky. */
  waver?: number;
  seed?: number;
}

export function writeInk(text: string, options: WriteOptions = {}): Stroke[] {
  const size = options.size ?? 40;
  const color = options.color ?? '#eef1ff';
  const waver = options.waver ?? 0.5;

  let state = options.seed ?? 12345;
  const random = () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296 - 0.5;
  };
  const jitter = (amount: number) => random() * amount * waver;

  const strokes: Stroke[] = [];
  let cursor = options.x ?? 12;
  const baseline = options.y ?? 10;

  for (const raw of text) {
    const char = raw.toLowerCase();
    if (char === ' ') {
      cursor += size * 0.5;
      continue;
    }
    const glyph = GLYPHS[char];
    if (!glyph) {
      cursor += size * 0.4;
      continue;
    }

    const xs = glyph.flat().map(([x]) => x);
    const inkLeft = Math.min(...xs) / 100;
    const inkRight = Math.max(...xs) / 100;

    // Every letter is a slightly different size, sits slightly off the line and
    // leans a little — which is what stops it looking like a font.
    const scale = size * (0.9 + Math.abs(random()) * 0.2);
    const drop = jitter(size * 0.08);
    const slant = jitter(0.18);

    for (const stroke of glyph) {
      strokes.push({
        tool: 'ballpoint',
        color,
        width: options.width ?? Math.max(1.4, size * 0.055),
        pointerType: 'pen',
        points: stroke.map(([gx, gy], index) => {
          const nx = (gx / 100 - inkLeft) * scale;
          const ny = (gy / 100) * scale;
          return {
            x: cursor + nx + ny * slant + jitter(size * 0.035),
            y: baseline + ny + drop + jitter(size * 0.035),
            // A little pressure variation so the line has life.
            p: 0.45 + Math.abs(random()) * 0.35,
            t: index * 12,
          };
        }),
      });
    }
    cursor += (inkRight - inkLeft) * scale + size * 0.14;
  }

  return strokes;
}

/** Width and height the work occupies, plus a little breathing room. */
export function inkBounds(strokes: Stroke[], texts: CanvasText[] = [], padding = 8) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const stroke of strokes) {
    for (const point of stroke.points) {
      if (point.x < minX) minX = point.x;
      if (point.x > maxX) maxX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.y > maxY) maxY = point.y;
    }
  }
  for (const text of texts) {
    // Approximate: measuring properly would need the face to have loaded.
    const rows = text.text.split('\n');
    const width = Math.max(...rows.map((r) => r.length)) * text.size * 0.55;
    const height = rows.length * text.size * 1.25;
    if (text.x < minX) minX = text.x;
    if (text.x + width > maxX) maxX = text.x + width;
    if (text.y - text.size < minY) minY = text.y - text.size;
    if (text.y + height > maxY) maxY = text.y + height;
  }
  if (!Number.isFinite(minX)) return { width: 1, height: 1, minX: 0, minY: 0 };
  return {
    minX: minX - padding,
    minY: minY - padding,
    width: maxX - minX + padding * 2,
    height: maxY - minY + padding * 2,
  };
}

/**
 * Render ink to a PNG data URL, cropped to the ink itself. Used for the
 * thumbnail a handwritten task shows in the list.
 */
export function renderInk(
  strokes: Stroke[],
  texts: CanvasText[] = [],
  options: { maxWidth?: number; scale?: number } = {},
): string {
  if (typeof document === 'undefined' || (!strokes.length && !texts.length)) return '';

  const bounds = inkBounds(strokes, texts);
  const scale = options.scale ?? Math.min(2, (options.maxWidth ?? 560) / Math.max(1, bounds.width));

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bounds.width * scale));
  canvas.height = Math.max(1, Math.round(bounds.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  ctx.setTransform(scale, 0, 0, scale, -bounds.minX * scale, -bounds.minY * scale);
  for (const stroke of strokes) paintStroke(ctx, stroke, stroke.color ?? '#eef1ff', stroke.width ?? 3);

  for (const text of texts) {
    ctx.save();
    ctx.translate(text.x, text.y);
    if (text.rotation) ctx.rotate((text.rotation * Math.PI) / 180);
    ctx.font = `${text.italic ? 'italic ' : ''}${text.weight ?? 400} ${text.size}px ${fontById(text.font)?.stack ?? text.font}`;
    ctx.fillStyle = text.color;
    text.text.split('\n').forEach((row, index) => ctx.fillText(row, 0, index * text.size * 1.25));
    ctx.restore();
  }

  return canvas.toDataURL('image/png');
}
