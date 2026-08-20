import type { Locale, Stroke } from '../types';
import { ALL_TEMPLATES, GESTURE_ACTIONS, type GestureAction } from './templates';
import { recognize, toCloud } from './pointcloud';

/**
 * Handwriting and gesture recognition, in two layers.
 *
 * 1. The browser's own Handwriting Recognition API when it exists (Chrome on
 *    ChromeOS and Windows). That is real text recognition — cursive words,
 *    full sentences, multiple languages — and it runs on-device.
 * 2. Nexus's built-in $P recognizer everywhere else. It reliably reads shapes,
 *    pen gestures and digits, but it is not a general handwriting engine and
 *    the UI says so rather than pretending otherwise.
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
  createHandwritingRecognizer?(constraint: {
    languages: string[];
  }): Promise<HandwritingRecognizer>;
  queryHandwritingRecognizer?(constraint: {
    languages: string[];
  }): Promise<unknown | null>;
}

const LANGUAGE_TAG: Record<Locale, string> = { en: 'en', ar: 'ar', ru: 'ru' };

export function hasNativeHandwriting(): boolean {
  return typeof navigator !== 'undefined' && 'createHandwritingRecognizer' in navigator;
}

export interface HandwritingResult {
  text: string;
  source: 'native' | 'builtin';
  /** Set when the builtin recognizer matched a shape rather than text. */
  shape?: string;
  gesture?: GestureAction;
  score?: number;
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
      if (stroke.tool === 'eraser' || stroke.points.length < 2) continue;
      const handwritingStroke = new (window as any).HandwritingStroke();
      stroke.points.forEach((point, index) => {
        handwritingStroke.addPoint({ x: point.x, y: point.y, t: point.t ?? index * 16 });
      });
      drawing.addStroke(handwritingStroke);
    }

    const predictions = await drawing.getPrediction();
    recognizer.finish?.();
    const text = predictions?.[0]?.text?.trim();
    return text || null;
  } catch {
    return null;
  }
}

/**
 * Recognize a sketch. Text comes back when the platform can read handwriting;
 * otherwise a shape/gesture name, which the canvas turns into an action.
 */
export async function recognizeStrokes(
  strokes: Stroke[],
  locale: Locale,
  options: { preferGesture?: boolean } = {},
): Promise<HandwritingResult | null> {
  const inked = strokes.filter((s) => s.tool !== 'eraser' && s.points.length >= 2);
  if (!inked.length) return null;

  // A short single stroke is far more likely to be a gesture than a word, so
  // check the gesture set first and skip the round trip to the platform engine.
  const looksLikeGesture = options.preferGesture || inked.length <= 2;

  if (looksLikeGesture) {
    const match = recognize(toCloud(inked), ALL_TEMPLATES);
    if (match && match.score >= 0.72) {
      const gesture = GESTURE_ACTIONS[match.name];
      if (gesture) {
        return { text: match.name, source: 'builtin', shape: match.name, gesture, score: match.score };
      }
    }
  }

  const native = await recognizeNative(inked, locale);
  if (native) return { text: native, source: 'native' };

  const match = recognize(toCloud(inked), ALL_TEMPLATES);
  if (!match || match.score < 0.65) return null;
  return {
    text: match.name,
    source: 'builtin',
    shape: match.name,
    gesture: GESTURE_ACTIONS[match.name],
    score: match.score,
  };
}
