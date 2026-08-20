/**
 * Assertion suite for the offline handwriting reader.
 * Run with: npm run test:handwriting
 *
 * Words are synthesised from the same parametric glyphs the templates come
 * from, then roughened the way a real hand roughens them: per-letter jitter,
 * varying size and baseline, uneven letter spacing, and slant. A reader that
 * only works on pristine input is worthless, so the noise is the point.
 */
import { readHandwriting } from '../web/src/lib/recognition/words';
import type { Stroke } from '../web/src/lib/types';

// Reproducible noise, so a failure is a real regression and not bad luck.
let seed = 20260820;
const random = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const jitter = (amount: number) => (random() - 0.5) * amount;

type Pt = [number, number];
const line = (a: Pt, b: Pt, n = 10): Pt[] =>
  Array.from({ length: n + 1 }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n] as Pt);
const arc = (cx: number, cy: number, rx: number, ry: number, from: number, to: number, n = 20): Pt[] =>
  Array.from({ length: n + 1 }, (_, i) => {
    const a = from + ((to - from) * i) / n;
    return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)] as Pt;
  });
const poly = (pts: Pt[], n = 8): Pt[] => {
  const out: Pt[] = [];
  for (let i = 1; i < pts.length; i++) out.push(...line(pts[i - 1], pts[i], n).slice(i === 1 ? 0 : 1));
  return out;
};
const TAU = Math.PI * 2;
const UP = (3 * Math.PI) / 2;
const LEFT = Math.PI;

/**
 * How a person writes each character. Deliberately NOT the same construction
 * as the templates in every case — different stroke counts and proportions —
 * so the test measures recognition rather than echoing the template back.
 */
const HAND: Record<string, Pt[][]> = {
  a: [poly([[20, 95], [50, 8], [80, 95]]), line([32, 60], [68, 60])],
  b: [line([26, 5], [26, 95]), arc(26, 28, 29, 23, UP, UP + Math.PI, 14), arc(26, 71, 33, 24, UP, UP + Math.PI, 16)],
  c: [arc(56, 50, 40, 45, Math.PI / 3, (5 * Math.PI) / 3, 26)],
  d: [line([26, 5], [26, 95]), arc(26, 50, 43, 45, UP, UP + Math.PI, 22)],
  e: [line([26, 5], [26, 95]), line([26, 5], [80, 5]), line([26, 50], [68, 50]), line([26, 95], [80, 95])],
  h: [line([22, 5], [22, 95]), line([78, 5], [78, 95]), line([22, 50], [78, 50])],
  i: [line([50, 8], [50, 94])],
  k: [line([24, 5], [24, 95]), line([80, 5], [24, 52]), line([38, 44], [82, 95])],
  l: [line([28, 5], [28, 95]), line([28, 95], [82, 95])],
  m: [poly([[16, 95], [16, 6], [50, 62], [84, 6], [84, 95]])],
  n: [poly([[20, 95], [20, 6], [80, 95], [80, 6]])],
  o: [arc(50, 50, 40, 45, 0, TAU, 30)],
  p: [line([26, 5], [26, 95]), arc(26, 30, 33, 25, UP, UP + Math.PI, 16)],
  r: [line([26, 5], [26, 95]), arc(26, 30, 33, 25, UP, UP + Math.PI, 16), line([34, 54], [80, 95])],
  s: [[...arc(54, 28, 28, 22, Math.PI / 8, LEFT + 1.3, 16), ...arc(46, 72, 30, 24, UP + 0.4, Math.PI / 2 + 1.2, 16)]],
  t: [line([14, 8], [86, 8]), line([50, 8], [50, 95])],
  u: [[...line([18, 6], [18, 62]), ...arc(50, 62, 32, 34, LEFT, TAU, 14), ...line([82, 62], [82, 6])]],
  v: [poly([[16, 6], [50, 95], [84, 6]])],
  w: [poly([[10, 6], [30, 95], [50, 34], [70, 95], [90, 6]])],
  x: [line([16, 8], [84, 94]), line([84, 8], [16, 94])],
  y: [poly([[16, 6], [50, 50], [84, 6]]), line([50, 50], [50, 95])],
  g: [[...arc(56, 50, 40, 45, Math.PI / 3, (5 * Math.PI) / 3, 24)], line([96, 50], [58, 50]), line([96, 50], [96, 80])],
  '2': [[...arc(50, 30, 30, 24, LEFT, TAU * 0.92, 18), ...poly([[72, 44], [18, 92], [84, 92]])]],
  '3': [[...arc(48, 28, 26, 20, LEFT, 0, 14), ...arc(48, 68, 28, 24, UP, Math.PI / 2 + 1.2, 18)]],
  '5': [poly([[80, 10], [26, 10], [22, 46]]), arc(52, 66, 30, 26, LEFT, TAU * 1.4, 18)],
  '7': [poly([[14, 10], [86, 10], [40, 92]])],
};

/** Lay a phrase out as strokes, roughening it like a real hand. */
function write(phrase: string): Stroke[] {
  const strokes: Stroke[] = [];
  let cursor = 40;
  const baseSize = 46;

  for (const ch of phrase) {
    if (ch === ' ') {
      cursor += baseSize * 0.55; // a word gap, wider than the gap between letters
      continue;
    }
    const glyph = HAND[ch];
    if (!glyph) throw new Error(`no hand sample for "${ch}"`);

    // Every letter is a slightly different size and sits slightly off the line.
    const size = baseSize * (0.86 + random() * 0.28);
    const baseline = 60 + jitter(size * 0.1);
    const slant = jitter(0.1);

    // Advance by the glyph's own ink width, not a fixed step. People write the
    // next letter a small constant distance from the last bit of ink, so a
    // narrow "l" is followed closely while a wide "w" pushes the cursor along.
    const xs = glyph.flat().map(([x]) => x);
    const inkLeft = Math.min(...xs) / 100;
    const inkRight = Math.max(...xs) / 100;

    for (const stroke of glyph) {
      strokes.push({
        points: stroke.map(([x, y]) => {
          const nx = (x / 100 - inkLeft) * size;
          const ny = (y / 100) * size;
          return {
            x: cursor + nx + ny * slant + jitter(size * 0.045),
            y: baseline + ny + jitter(size * 0.045),
            p: 0.5,
          };
        }),
        tool: 'fineliner',
        pointerType: 'pen',
      });
    }
    cursor += (inkRight - inkLeft) * size + size * 0.14 + jitter(size * 0.05);
  }
  return strokes;
}

const CASES = [
  'milk',
  'oil',
  'car',
  'buy milk',
  'wash car',
  'pay rent',
  'call mum',
  'water plants',
  'book train',
  'clean kitchen',
];

let exact = 0;
let charMatches = 0;
let charTotal = 0;

const distance = (a: string, b: string): number => {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
};

console.log('reading synthetic handwriting\n');
for (const phrase of CASES) {
  const result = readHandwriting(write(phrase));
  const got = result.text.toLowerCase();
  const errors = distance(phrase, got);
  const accuracy = 1 - errors / Math.max(phrase.length, got.length, 1);
  if (got === phrase) exact++;
  charMatches += Math.max(0, phrase.length - errors);
  charTotal += phrase.length;
  const mark = got === phrase ? ' ok ' : accuracy >= 0.7 ? 'near' : 'FAIL';
  console.log(
    `${mark}  wrote "${phrase}"${' '.repeat(Math.max(0, 16 - phrase.length))} read "${got}"` +
      `${' '.repeat(Math.max(0, 16 - got.length))} chars=${result.characterCount} conf=${result.confidence.toFixed(2)}`,
  );
}

const charAccuracy = charMatches / charTotal;
console.log(`\nexact phrases: ${exact}/${CASES.length}`);
console.log(`character accuracy: ${(charAccuracy * 100).toFixed(1)}%`);

// The reader is a print-handwriting aid with an editable result, not an OCR
// engine. These floors are what makes it useful rather than frustrating.
if (charAccuracy < 0.9) {
  console.error(`\ncharacter accuracy ${(charAccuracy * 100).toFixed(1)}% is below the 90% floor`);
  process.exit(1);
}
if (exact < CASES.length * 0.7) {
  console.error(`\nonly ${exact}/${CASES.length} phrases read exactly; at least 70% must`);
  process.exit(1);
}
