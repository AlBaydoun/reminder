import { arc, buildTemplates, DOWN, join, LEFT, line, polyline, RIGHT, TAU, UP, type Glyph, type Pt } from './geometry';
import type { PointCloud } from './pointcloud';

/**
 * Letter and digit templates for the offline handwriting reader.
 *
 * Every glyph is drawn in a 0–100 box with y pointing down. Both the capital
 * and the lower-case form of a letter are registered under the same lower-case
 * name, because the recognizer scale-normalises before matching: an "O" and an
 * "o" are the same point cloud, and the shapes that genuinely differ (a/A,
 * e/E, r/R …) simply become two ways of writing one character.
 *
 * This is a print-handwriting reader, not a cursive one. It is good at
 * separated letters and useless at joined script, which is why the canvas
 * always shows the transcription in an editable field rather than committing
 * to it silently.
 */

// ── Capitals ───────────────────────────────────────────────────────────────

const CAPITALS: Array<[string, Glyph]> = [
  ['a', [polyline([[18, 96], [50, 6], [82, 96]], 10), line([31, 62], [69, 62], 8)]],
  ['b', [
    line([26, 6], [26, 96], 12),
    join(arc(26, 28, 30, 22, UP, UP + Math.PI, 14)),
    join(arc(26, 72, 34, 24, UP, UP + Math.PI, 16)),
  ]],
  ['c', [arc(56, 50, 40, 45, Math.PI / 3, (5 * Math.PI) / 3, 26)]],
  ['d', [line([26, 6], [26, 96], 12), arc(26, 51, 44, 45, UP, UP + Math.PI, 22)]],
  ['e', [line([26, 6], [26, 96], 12), line([26, 6], [82, 6], 8), line([26, 50], [70, 50], 7), line([26, 96], [82, 96], 8)]],
  ['f', [line([26, 6], [26, 96], 12), line([26, 6], [82, 6], 8), line([26, 50], [68, 50], 7)]],
  ['g', [
    join(arc(56, 50, 40, 45, Math.PI / 3, (5 * Math.PI) / 3, 24)),
    polyline([[96, 50], [58, 50]], 6),
    line([96, 50], [96, 80], 5),
  ]],
  ['h', [line([22, 6], [22, 96], 12), line([78, 6], [78, 96], 12), line([22, 51], [78, 51], 8)]],
  ['i', [line([50, 8], [50, 94], 12)]],
  ['j', [join(line([70, 6], [70, 74], 10), arc(44, 74, 26, 22, RIGHT, LEFT, 12))]],
  ['k', [line([24, 6], [24, 96], 12), line([80, 6], [24, 52], 9), line([38, 44], [82, 96], 9)]],
  ['l', [line([28, 6], [28, 96], 12), line([28, 96], [82, 96], 8)]],
  ['m', [polyline([[16, 96], [16, 6], [50, 62], [84, 6], [84, 96]], 8)]],
  ['n', [polyline([[20, 96], [20, 6], [80, 96], [80, 6]], 10)]],
  ['o', [arc(50, 50, 40, 45, 0, TAU, 30)]],
  ['p', [line([26, 6], [26, 96], 12), arc(26, 30, 34, 24, UP, UP + Math.PI, 16)]],
  ['q', [arc(50, 48, 38, 42, 0, TAU, 26), line([64, 72], [92, 98], 6)]],
  ['r', [line([26, 6], [26, 96], 12), arc(26, 30, 34, 24, UP, UP + Math.PI, 16), line([34, 54], [80, 96], 9)]],
  ['s', [join(
    arc(54, 28, 28, 22, Math.PI / 8, LEFT + DOWN / 1.2, 16),
    arc(46, 72, 30, 24, UP + 0.4, DOWN + 1.2, 16),
  )]],
  ['t', [line([14, 8], [86, 8], 10), line([50, 8], [50, 96], 12)]],
  ['u', [join(line([18, 6], [18, 62], 8), arc(50, 62, 32, 34, LEFT, TAU, 14), line([82, 62], [82, 6], 8))]],
  ['v', [polyline([[16, 6], [50, 96], [84, 6]], 12)]],
  ['w', [polyline([[10, 6], [30, 96], [50, 34], [70, 96], [90, 6]], 8)]],
  ['x', [line([16, 8], [84, 94], 12), line([84, 8], [16, 94], 12)]],
  ['y', [polyline([[16, 6], [50, 50], [84, 6]], 9), line([50, 50], [50, 96], 8)]],
  ['z', [polyline([[16, 8], [84, 8], [16, 94], [84, 94]], 9)]],
];

// ── Lower case, only where the shape genuinely differs ──────────────────────

const LOWERCASE: Array<[string, Glyph]> = [
  ['a', [arc(46, 62, 26, 30, 0, TAU, 22), line([72, 34], [72, 94], 8)]],
  ['b', [line([26, 4], [26, 94], 12), arc(26, 64, 32, 28, UP, UP + Math.PI, 16)]],
  ['d', [arc(48, 64, 26, 28, 0, TAU, 22), line([74, 4], [74, 94], 12)]],
  ['e', [join(line([22, 62], [74, 62], 7), arc(48, 62, 26, 30, RIGHT, RIGHT + 1.55 * Math.PI, 20))]],
  ['f', [join(arc(58, 24, 22, 20, RIGHT, LEFT + 0.4, 12), line([36, 24], [36, 94], 9)), line([18, 50], [62, 50], 6)]],
  ['g', [arc(48, 60, 26, 26, 0, TAU, 22), join(line([74, 40], [74, 86], 6), arc(52, 86, 22, 16, RIGHT, LEFT, 10))]],
  ['h', [line([24, 4], [24, 94], 12), join(arc(50, 58, 26, 24, LEFT, TAU, 12), line([76, 58], [76, 94], 7))]],
  ['i', [line([50, 40], [50, 94], 8), arc(50, 16, 4, 4, 0, TAU, 8)]],
  ['j', [join(line([62, 40], [62, 84], 7), arc(40, 84, 22, 16, RIGHT, LEFT, 10)), arc(62, 16, 4, 4, 0, TAU, 8)]],
  ['k', [line([26, 4], [26, 94], 12), line([72, 44], [26, 72], 8), line([40, 64], [74, 94], 7)]],
  ['m', [line([12, 40], [12, 94], 8), join(arc(32, 56, 20, 16, LEFT, TAU, 10), line([52, 56], [52, 94], 7)), join(arc(72, 56, 20, 16, LEFT, TAU, 10), line([92, 56], [92, 94], 7))]],
  ['n', [line([26, 40], [26, 94], 8), join(arc(52, 58, 26, 20, LEFT, TAU, 12), line([78, 58], [78, 94], 7))]],
  ['q', [arc(48, 60, 26, 28, 0, TAU, 22), line([74, 40], [74, 98], 8)]],
  ['r', [line([30, 40], [30, 94], 8), arc(52, 56, 22, 18, LEFT, UP + 0.3, 10)]],
  ['t', [line([46, 12], [46, 94], 11), line([22, 40], [70, 40], 6)]],
  ['u', [join(line([24, 40], [24, 74], 6), arc(50, 74, 26, 20, LEFT, TAU, 12), line([76, 74], [76, 94], 6))]],
  ['y', [polyline([[24, 40], [50, 82], [76, 40]], 8), line([50, 82], [38, 100], 5)]],
];

// ── Digits ─────────────────────────────────────────────────────────────────

const DIGITS: Array<[string, Glyph]> = [
  ['0', [arc(50, 50, 32, 45, 0, TAU, 30)]],
  ['1', [polyline([[28, 22], [50, 8], [50, 92]], 12)]],
  ['2', [join(arc(50, 30, 30, 24, LEFT, TAU * 0.92, 18), polyline([[72, 44], [18, 92], [84, 92]], 9))]],
  ['3', [join(arc(48, 28, 26, 20, LEFT, RIGHT, 14), arc(48, 68, 28, 24, UP, DOWN + 1.2, 18))]],
  ['4', [polyline([[68, 8], [14, 66], [88, 66]], 10), line([68, 30], [68, 92], 10)]],
  ['5', [polyline([[80, 10], [26, 10], [22, 46]], 8), arc(52, 66, 30, 26, LEFT, TAU * 1.4, 18)]],
  ['6', [join(arc(52, 50, 30, 42, Math.PI * 1.7, Math.PI * 3.1, 22), arc(52, 68, 28, 24, LEFT, TAU + LEFT, 18))]],
  ['7', [polyline([[14, 10], [86, 10], [40, 92]], 12)]],
  ['8', [join(arc(50, 28, 24, 20, 0, TAU, 18), arc(50, 70, 30, 22, 0, TAU, 20))]],
  ['9', [arc(50, 32, 28, 26, 0, TAU, 20), polyline([[78, 34], [66, 92]], 8)]],
];

// ── Punctuation people actually use in a to-do list ────────────────────────

const PUNCTUATION: Array<[string, Glyph]> = [
  ['-', [line([12, 50], [88, 50], 12)]],
  ['.', [arc(50, 50, 6, 6, 0, TAU, 10)]],
  [',', [polyline([[56, 40], [50, 56], [40, 68]], 6)]],
  ['!', [line([50, 6], [50, 66], 10), arc(50, 88, 5, 5, 0, TAU, 8)]],
  ['?', [join(arc(50, 28, 22, 22, LEFT, TAU * 0.92, 18), line([53, 45], [50, 66], 6)), arc(50, 88, 5, 5, 0, TAU, 8)]],
  ['+', [line([50, 12], [50, 88], 10), line([12, 50], [88, 50], 10)]],
  ['/', [line([80, 8], [20, 92], 12)]],
  ['(', [arc(74, 50, 34, 46, DOWN + 0.9, DOWN + TAU / 2 + 2.35, 16)]],
  [')', [arc(26, 50, 34, 46, UP + 0.9 - Math.PI, UP + 2.35, 16)]],
  [':', [arc(50, 30, 6, 6, 0, TAU, 8), arc(50, 70, 6, 6, 0, TAU, 8)]],
];

/**
 * The glyph shapes themselves, keyed by character, preferring the lower-case
 * form where one exists. Besides feeding the recognizer these can be *drawn* —
 * which is how the app can write a line in "handwriting" for a demo workspace
 * or a preview without shipping an image.
 */
export const GLYPHS: Record<string, Glyph> = (() => {
  const out: Record<string, Glyph> = {};
  for (const [name, glyph] of [...CAPITALS, ...DIGITS, ...PUNCTUATION]) out[name] = glyph;
  for (const [name, glyph] of LOWERCASE) out[name] = glyph;
  return out;
})();

export const LETTER_TEMPLATES: PointCloud[] = buildTemplates([...CAPITALS, ...LOWERCASE]);
export const NUMBER_TEMPLATES: PointCloud[] = buildTemplates(DIGITS);
export const PUNCTUATION_TEMPLATES: PointCloud[] = buildTemplates(PUNCTUATION);

/** Everything the word reader matches a single character against. */
export const CHARACTER_TEMPLATES: PointCloud[] = [
  ...LETTER_TEMPLATES,
  ...NUMBER_TEMPLATES,
  ...PUNCTUATION_TEMPLATES,
];

/**
 * Characters whose shapes are genuinely indistinguishable once scaled, so a
 * confident-looking match between them means nothing. Used to damp confidence
 * rather than to hide the result.
 */
export const AMBIGUOUS_GROUPS: string[][] = [
  ['i', 'l', '1', '/'],
  ['o', '0'],
  ['s', '5'],
  ['z', '2'],
  ['b', '6'],
  ['g', '9'],
  ['.', ','],
  ['-', '_'],
];

/**
 * Marks that only ever occupy a fraction of the line height. Scaling makes a
 * full stop and a lower-case "o" the same point cloud — a circle is a circle —
 * so size relative to the line is the only thing that can tell them apart.
 */
export const SMALL_GLYPHS = new Set(['.', ',', ':', '-', "'"]);

export function isAmbiguousWith(a: string, b: string): boolean {
  if (a === b) return true;
  return AMBIGUOUS_GROUPS.some((group) => group.includes(a) && group.includes(b));
}
