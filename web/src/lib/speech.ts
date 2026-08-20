import type { Locale } from './types';
import { localeMeta } from '../i18n';

/**
 * Thin wrapper over the Web Speech API.
 *
 * The API is still vendor-prefixed in Safari and its TypeScript definitions
 * are not in the DOM lib, so the shapes are declared here. Everything is
 * wrapped in try/catch: a browser that half-implements this should degrade to
 * "voice unavailable", never crash the app.
 */

interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}
interface SpeechRecognitionResult {
  readonly length: number;
  isFinal: boolean;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
}
interface SpeechRecognitionResultList {
  readonly length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}
interface SpeechRecognitionEventLike extends Event {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}
interface SpeechRecognitionErrorEventLike extends Event {
  error: string;
  message?: string;
}
interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
  onspeechend: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function recognitionConstructor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as any;
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as SpeechRecognitionCtor | null;
}

export const isSpeechSupported = (): boolean => recognitionConstructor() !== null;

export type SpeechErrorKind = 'denied' | 'no-speech' | 'network' | 'unsupported' | 'aborted' | 'other';

export interface SpeechHandlers {
  onInterim?(text: string): void;
  onFinal?(text: string, confidence: number): void;
  onStart?(): void;
  onEnd?(): void;
  onError?(kind: SpeechErrorKind, detail?: string): void;
}

export class SpeechController {
  private recognition: SpeechRecognitionLike | null = null;
  private stopping = false;
  private restartOnEnd = false;

  constructor(private handlers: SpeechHandlers = {}) {}

  get supported(): boolean {
    return isSpeechSupported();
  }

  /**
   * @param continuous keep the microphone open for several commands in a row.
   */
  start(locale: Locale, continuous = false): boolean {
    const Ctor = recognitionConstructor();
    if (!Ctor) {
      this.handlers.onError?.('unsupported');
      return false;
    }
    this.stop();

    try {
      const recognition = new Ctor();
      recognition.lang = localeMeta(locale).speech[0];
      recognition.continuous = continuous;
      recognition.interimResults = true;
      // Extra alternatives cost nothing and give the parser a second chance.
      recognition.maxAlternatives = 3;

      recognition.onstart = () => this.handlers.onStart?.();

      recognition.onresult = (event) => {
        let interim = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          const best = result[0];
          if (result.isFinal) {
            this.handlers.onFinal?.(best.transcript.trim(), best.confidence ?? 0);
          } else {
            interim += best.transcript;
          }
        }
        if (interim) this.handlers.onInterim?.(interim.trim());
      };

      recognition.onerror = (event) => {
        const map: Record<string, SpeechErrorKind> = {
          'not-allowed': 'denied',
          'service-not-allowed': 'denied',
          'no-speech': 'no-speech',
          network: 'network',
          aborted: 'aborted',
        };
        this.restartOnEnd = false;
        this.handlers.onError?.(map[event.error] ?? 'other', event.message ?? event.error);
      };

      recognition.onend = () => {
        // Chrome ends the session on its own after a pause; in continuous mode
        // restart so the user is not silently cut off mid-thought.
        if (this.restartOnEnd && !this.stopping) {
          try {
            recognition.start();
            return;
          } catch {
            /* fall through to a normal end */
          }
        }
        this.handlers.onEnd?.();
      };

      this.recognition = recognition;
      this.restartOnEnd = continuous;
      this.stopping = false;
      recognition.start();
      return true;
    } catch (error) {
      this.handlers.onError?.('other', (error as Error).message);
      return false;
    }
  }

  stop() {
    this.restartOnEnd = false;
    this.stopping = true;
    try {
      this.recognition?.stop();
    } catch {
      /* already stopped */
    }
    this.recognition = null;
  }

  abort() {
    this.restartOnEnd = false;
    this.stopping = true;
    try {
      this.recognition?.abort();
    } catch {
      /* already stopped */
    }
    this.recognition = null;
  }
}

/**
 * Microphone permission, asked separately from recognition so the UI can
 * explain *why* before the browser prompt appears.
 */
export async function requestMicrophone(): Promise<boolean> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // We only wanted the permission — release the device immediately.
    stream.getTracks().forEach((track) => track.stop());
    return true;
  } catch {
    return false;
  }
}
