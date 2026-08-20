import type { Stroke } from '../types';
import { CHARACTER_TEMPLATES, isAmbiguousWith, SMALL_GLYPHS } from './letters';
import { scoreAgainst, type CloudPoint } from './pointcloud';

/**
 * Reads handwritten words offline.
 *
 * The single-symbol recognizer only ever sees one glyph, so the work here is
 * everything around it: splitting a page of ink into lines, lines into
 * characters, deciding where the spaces are, and being honest about how sure
 * it is. Each character is then matched with the same $P recognizer used for
 * shapes and gestures.
 *
 * It reads separated print. It cannot read joined cursive — a word written in
 * one continuous stroke has no character boundaries to find — which is why the
 * result is always offered as an editable draft rather than applied silently.
 */

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
  cx: number;
  cy: number;
}

export interface CharacterGuess {
  char: string;
  score: number;
  box: Box;
  alternatives: Array<{ char: string; score: number }>;
}

export interface WordReadResult {
  text: string;
  /** 0–1. Low means "show this but expect the user to correct it". */
  confidence: number;
  lines: CharacterGuess[][];
  characterCount: number;
}

function boxOf(points: Array<{ x: number; y: number }>): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
  };
}

const mergeBoxes = (a: Box, b: Box): Box =>
  boxOf([
    { x: Math.min(a.minX, b.minX), y: Math.min(a.minY, b.minY) },
    { x: Math.max(a.maxX, b.maxX), y: Math.max(a.maxY, b.maxY) },
  ]);

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

interface Piece {
  stroke: Stroke;
  box: Box;
}

/**
 * Group strokes into text lines.
 *
 * Only substantial strokes define where a line sits — a dot over an "i" is
 * higher than everything around it and would otherwise invent a line of its
 * own. Small marks are then attached to whichever line is nearest.
 */
function groupIntoLines(pieces: Piece[]): Piece[][] {
  if (pieces.length <= 1) return pieces.length ? [pieces] : [];

  const heights = pieces.map((p) => p.box.height);
  const typicalHeight = Math.max(median(heights), 1);
  const substantial = pieces.filter((p) => p.box.height >= typicalHeight * 0.4);
  const small = pieces.filter((p) => p.box.height < typicalHeight * 0.4);

  const lines: Array<{ pieces: Piece[]; box: Box }> = [];
  for (const piece of [...substantial].sort((a, b) => a.box.cy - b.box.cy)) {
    const line = lines.find((l) => {
      // Same line when the vertical spans genuinely overlap, not merely when
      // the centres happen to be close.
      const overlap = Math.min(l.box.maxY, piece.box.maxY) - Math.max(l.box.minY, piece.box.minY);
      return overlap > Math.min(l.box.height, piece.box.height) * 0.35;
    });
    if (line) {
      line.pieces.push(piece);
      line.box = mergeBoxes(line.box, piece.box);
    } else {
      lines.push({ pieces: [piece], box: piece.box });
    }
  }

  if (!lines.length) return [pieces];

  for (const piece of small) {
    let best = lines[0];
    let bestDistance = Infinity;
    for (const line of lines) {
      // Distance to the line's band, zero when the mark sits inside it.
      const vertical =
        piece.box.cy < line.box.minY
          ? line.box.minY - piece.box.cy
          : piece.box.cy > line.box.maxY
            ? piece.box.cy - line.box.maxY
            : 0;
      const horizontal =
        piece.box.cx < line.box.minX
          ? line.box.minX - piece.box.cx
          : piece.box.cx > line.box.maxX
            ? piece.box.cx - line.box.maxX
            : 0;
      const distance = vertical + horizontal * 0.25;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = line;
      }
    }
    best.pieces.push(piece);
    best.box = mergeBoxes(best.box, piece.box);
  }

  return lines
    .sort((a, b) => a.box.minY - b.box.minY)
    .map((l) => l.pieces.sort((a, b) => a.box.minX - b.box.minX));
}

interface CharacterCluster {
  pieces: Piece[];
  box: Box;
}

/**
 * Split one line into characters.
 *
 * Strokes join into the same character when they overlap horizontally or sit
 * almost touching — which is what keeps the two strokes of a "t", the dot of
 * an "i" and the crossbar of an "A" attached to their letter.
 */
function groupIntoCharacters(line: Piece[], lineHeight: number): CharacterCluster[] {
  const clusters: CharacterCluster[] = [];
  // A stroke drawn straight down has zero width, so an unpadded overlap test
  // could never attach the crossbar of a "t" or the dot of an "i" to its stem.
  const pad = Math.max(lineHeight * 0.05, 0.5);

  for (const piece of [...line].sort((a, b) => a.box.minX - b.box.minX)) {
    const current = clusters[clusters.length - 1];
    if (!current) {
      clusters.push({ pieces: [piece], box: piece.box });
      continue;
    }

    const overlap =
      Math.min(current.box.maxX, piece.box.maxX) - Math.max(current.box.minX, piece.box.minX) + pad * 2;
    const narrower = Math.min(current.box.width, piece.box.width) + pad * 2;

    // Overlap only. Merging on mere closeness swallowed the second letter of
    // pairs like "oo", which then matched a single wide glyph such as "m".
    if (overlap >= narrower * 0.35) {
      current.pieces.push(piece);
      current.box = mergeBoxes(current.box, piece.box);
    } else {
      clusters.push({ pieces: [piece], box: piece.box });
    }
  }
  return clusters;
}

function cloudFor(cluster: CharacterCluster): CloudPoint[] {
  const out: CloudPoint[] = [];
  cluster.pieces.forEach((piece, id) => {
    for (const point of piece.stroke.points) out.push({ x: point.x, y: point.y, id });
  });
  return out;
}

/**
 * Match one character, weighted by how closely the template's proportions match
 * what was actually drawn. Without this a dash, a "1" and an "l" are the same
 * point cloud once scaled, and the matcher picks between them at random.
 */
function readCharacter(cluster: CharacterCluster, lineHeight: number): CharacterGuess | null {
  const drawnAspect = Math.max(cluster.box.width, 1) / Math.max(cluster.box.height, 1);
  // How tall this mark is compared with the tallest thing on its line.
  const relativeHeight = cluster.box.height / Math.max(lineHeight, 1);

  const ranked = scoreAgainst(cloudFor(cluster), CHARACTER_TEMPLATES, (template, score) => {
    let weighted = score;

    if (template.aspect) {
      // Compare in log space so "twice as wide" costs the same as "half as wide".
      const difference = Math.abs(Math.log(drawnAspect / template.aspect));
      weighted *= 1 - Math.min(0.45, difference * 0.22);
    }

    // Normalisation throws size away, so a full stop and an "o" score
    // identically. Height relative to the line is what separates them.
    const small = SMALL_GLYPHS.has(template.name);
    if (small && relativeHeight > 0.45) weighted *= 0.3;
    else if (!small && relativeHeight < 0.28) weighted *= 0.5;

    return weighted;
  });
  if (!ranked.length) return null;

  const best = ranked[0];
  const rival = ranked.find((r) => !isAmbiguousWith(r.name, best.name) && r.name !== best.name);

  // A confident-looking match means little if a completely different character
  // scored nearly as well.
  const margin = rival ? Math.max(0, best.score - rival.score) : best.score;
  const confidence = best.score * (0.55 + Math.min(0.45, margin * 3));

  return {
    char: best.name,
    score: confidence,
    box: cluster.box,
    alternatives: ranked.slice(1, 4).map((r) => ({ char: r.name, score: r.score })),
  };
}

/** Read every word in a sketch. */
export function readHandwriting(strokes: Stroke[]): WordReadResult {
  const pieces: Piece[] = strokes
    .filter((stroke) => stroke.tool !== 'eraser' && stroke.points.length >= 2)
    .map((stroke) => ({ stroke, box: boxOf(stroke.points) }));

  if (!pieces.length) return { text: '', confidence: 0, lines: [], characterCount: 0 };

  const lines = groupIntoLines(pieces);
  const readLines: CharacterGuess[][] = [];
  const textLines: string[] = [];
  let totalScore = 0;
  let totalChars = 0;

  for (const line of lines) {
    const lineHeight = Math.max(...line.map((p) => p.box.height), 1);
    const clusters = groupIntoCharacters(line, lineHeight);

    const guesses: CharacterGuess[] = [];
    for (const cluster of clusters) {
      const guess = readCharacter(cluster, lineHeight);
      if (guess) guesses.push(guess);
    }
    if (!guesses.length) continue;

    // Word breaks. An absolute threshold does not work: the blank to the right
    // of a "p" is wider than the gap after an "l", so a fixed fraction of the
    // line height splits words in the middle. Judge each gap against the other
    // gaps on the same line, and only look for spaces when one gap genuinely
    // stands out — otherwise the line is a single word.
    const gaps: number[] = [];
    for (let i = 1; i < guesses.length; i++) {
      gaps.push(Math.max(0, guesses[i].box.minX - guesses[i - 1].box.maxX));
    }
    const typicalGap = median(gaps);
    const widestGap = gaps.length ? Math.max(...gaps) : 0;
    const hasWordBreaks = widestGap > Math.max(typicalGap * 2.2, lineHeight * 0.18);
    const spaceThreshold = hasWordBreaks
      ? Math.max((typicalGap + widestGap) / 2, typicalGap * 1.8)
      : Infinity;

    let text = guesses[0].char;
    for (let i = 1; i < guesses.length; i++) {
      if (gaps[i - 1] > spaceThreshold) text += ' ';
      text += guesses[i].char;
    }

    readLines.push(guesses);
    textLines.push(text);
    totalScore += guesses.reduce((sum, g) => sum + g.score, 0);
    totalChars += guesses.length;
  }

  return {
    text: textLines.join('\n').trim(),
    confidence: totalChars ? totalScore / totalChars : 0,
    lines: readLines,
    characterCount: totalChars,
  };
}
