import type { Locale, Stroke } from '../types';
import { ALL_TEMPLATES, GESTURE_ACTIONS, type GestureAction } from './templates';
import { recognize, toCloud } from './pointcloud';
import { readHandwriting } from './words';

/**
 * Reading what was drawn, in three layers.
 *
 * 1. **Pen gestures.** One or two strokes that clearly form a checkmark, star,
 *    circle or strike are an instruction, not writing, and are caught first.
 * 2. **The platform handwriting engine**, where one exists (Chrome on ChromeOS
 *    and Windows). That is true on-device recognition, cursive included.
 * 3. **Nexus's own reader** everywhere else: strokes are split into lines and
 *    characters and matched against letter, digit and punctuation templates.
 *    It reads separated print well and joined cursive not at all.
 *
 * Whatever comes back is offered as an editable draft. The reader is good
 * enough to save typing and not good enough to be trusted silently, and the
 * interface is built around that fact rather than hiding it.
 */

interface HandwritingStroke {
  addPoint(point: { x: number; y: number; t: number }): void;
}

interface HandwritingDrawing {
  addStroke(stroke: HandwritingStroke): void;
  getPrediction(): Promise<Array<{ text: string }>>;
  startDrawing?(): void;
}

interface HandwritingRecognizer {
  startDrawing(hints?: Record<string, unknown>): HandwritingDrawing;
  finish?(): void;
}

interface HandwritingNavigator {
  createHandwritingRecognizer?(constraint: { languages: string[] }): Promise<HandwritingRecognizer>;
}

const LANGUAGE_TAG: Record<Locale, string> = { en: 'en', ar: 'ar', ru: 'ru' };

export function hasNativeHandwriting(): boolean {
  return typeof navigator !== 'undefined' && 'createHandwritingRecognizer' in navigator;
}

export type RecognitionSource = 'native' | 'reader' | 'gesture';

export interface HandwritingResult {
  text: string;
  source: RecognitionSource;
  /** 0–1; only meaningful for the built-in reader and gesture matches. */
  confidence: number;
  /** Set when the strokes were an instruction rather than writing. */
  gesture?: GestureAction;
  /** The shape name behind a gesture match. */
  shape?: string;
}

/** Try the platform engine. Returns null when unavailable or unsuccessful. */
async function recognizeNative(strokes: Stroke[], locale: Locale): Promise<string | null> {
  const nav = navigator as unknown as HandwritingNavigator;
  if (!nav.createHandwritingRecognizer) return null;

  try {
    const recognizer = await nav.createHandwritingRecognizer({
      languages: [LANGUAGE_TAG[locale] ?? 'en'],
    });
    const drawing = recognizer.startDrawing({ recognitionType: 'text', inputType: 'stylus' });

    for (const stroke of strokes) {
      const handwritingStroke = new (window as any).HandwritingStroke();
      stroke.points.forEach((point, index) => {
        handwritingStroke.addPoint({ x: point.x, y: point.y, t: point.t ?? index * 16 });
      });
      drawing.addStroke(handwritingStroke);
    }

    const predictions = await drawing.getPrediction();
    recognizer.finish?.();
    return predictions?.[0]?.text?.trim() || null;
  } catch {
    return null;
  }
}

/** Match the strokes against the pen-gesture set. */
export function readGesture(strokes: Stroke[]): HandwritingResult | null {
  const inked = strokes.filter((s) => s.tool !== 'eraser' && s.points.length >= 2);
  if (!inked.length) return null;

  const match = recognize(toCloud(inked), ALL_TEMPLATES);
  if (!match || match.score < 0.72) return null;
  const gesture = GESTURE_ACTIONS[match.name];
  if (!gesture) return null;
  return { text: match.name, source: 'gesture', confidence: match.score, gesture, shape: match.name };
}

export interface ReadOptions {
  /** Skip the gesture layer — used when the user explicitly asked to read text. */
  textOnly?: boolean;
}

export async function recognizeStrokes(
  strokes: Stroke[],
  locale: Locale,
  options: ReadOptions = {},
): Promise<HandwritingResult | null> {
  const inked = strokes.filter((s) => s.tool !== 'eraser' && s.points.length >= 2);
  if (!inked.length) return null;

  // A short mark is far more likely to be an instruction than a word.
  if (!options.textOnly && inked.length <= 2) {
    const gesture = readGesture(inked);
    if (gesture) return gesture;
  }

  const native = await recognizeNative(inked, locale);
  if (native) return { text: native, source: 'native', confidence: 1 };

  const read = readHandwriting(inked);
  if (read.text) return { text: read.text, source: 'reader', confidence: read.confidence };

  // Nothing legible — fall back to naming the shape, which is still useful.
  const shape = readGesture(inked);
  return shape;
}
