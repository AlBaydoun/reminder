import { VOICES, isBuiltinKey, type BuiltinKey } from './synth';

/**
 * How to reach an uploaded sound. The server build fetches it from the API;
 * the static demo has no API, so it registers a blob URL instead. Whichever
 * backend is in play installs its resolver here at start-up.
 */
type SoundUrlResolver = (soundId: string) => string | undefined;
let resolveSoundUrl: SoundUrlResolver = (soundId) => `/api/sounds/${soundId}/audio`;

export function setSoundUrlResolver(resolver: SoundUrlResolver) {
  resolveSoundUrl = resolver;
}

/**
 * One place that owns sound playback: built-in synthesized tones and uploaded
 * audio files behave identically to callers.
 *
 * Browsers refuse to start audio until the page has been interacted with, so
 * the context is created lazily and `unlock()` is called from the first user
 * gesture. Everything degrades to silence rather than throwing — a failed
 * alarm sound must never take the alarm screen down with it.
 */

let context: AudioContext | null = null;
let master: GainNode | null = null;
let unlocked = false;
const unlockListeners = new Set<(ready: boolean) => void>();

export function audioContext(): AudioContext | null {
  if (context) return context;
  const Ctor = window.AudioContext ?? (window as any).webkitAudioContext;
  if (!Ctor) return null;
  try {
    context = new Ctor();
    master = context.createGain();
    master.gain.value = 1;
    master.connect(context.destination);
    return context;
  } catch {
    return null;
  }
}

export const isAudioUnlocked = () => unlocked;

export function onAudioUnlock(fn: (ready: boolean) => void) {
  unlockListeners.add(fn);
  return () => unlockListeners.delete(fn);
}

/** Call from a click/tap. Resumes the context and plays a silent blip to prime it. */
export async function unlockAudio(): Promise<boolean> {
  const ctx = audioContext();
  if (!ctx) return false;
  try {
    if (ctx.state === 'suspended') await ctx.resume();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0.0001;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.02);
    unlocked = ctx.state === 'running';
  } catch {
    unlocked = false;
  }
  for (const fn of unlockListeners) fn(unlocked);
  return unlocked;
}

export interface PlayHandle {
  stop(): void;
  readonly kind: 'builtin' | 'file';
}

const NULL_HANDLE: PlayHandle = { stop() {}, kind: 'builtin' };

/** Loop a synthesized tone until stopped. */
function playBuiltin(key: BuiltinKey, volume: number, loop: boolean): PlayHandle {
  const ctx = audioContext();
  if (!ctx || !master) return NULL_HANDLE;
  if (ctx.state === 'suspended') void ctx.resume();

  const gain = ctx.createGain();
  gain.gain.value = Math.max(0, Math.min(1, volume));
  gain.connect(master);

  let stopped = false;
  let timer: number | undefined;

  const cycle = () => {
    if (stopped || !context) return;
    // Schedule slightly ahead of the clock so the loop never gaps audibly.
    const length = VOICES[key].render(context, gain, context.currentTime + 0.05);
    if (loop) timer = window.setTimeout(cycle, Math.max(200, length * 1000 - 60));
  };
  cycle();

  return {
    kind: 'builtin',
    stop() {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
      try {
        gain.gain.setTargetAtTime(0, ctx.currentTime, 0.03);
        window.setTimeout(() => gain.disconnect(), 300);
      } catch {
        /* the context may already be closed */
      }
    },
  };
}

/** Play an uploaded sound file straight from the API. */
function playFile(url: string, volume: number, loop: boolean): PlayHandle {
  const audio = new Audio(url);
  audio.loop = loop;
  audio.volume = Math.max(0, Math.min(1, volume));
  audio.crossOrigin = 'use-credentials';
  void audio.play().catch(() => {
    /* blocked until the page has been interacted with — the unlock prompt covers this */
  });
  return {
    kind: 'file',
    stop() {
      audio.pause();
      audio.currentTime = 0;
      audio.src = '';
    },
  };
}

/**
 * `soundId` is either a built-in key like `builtin:radar`, a custom sound id,
 * or null for the default tone.
 */
export function playSound(
  soundId: string | null | undefined,
  options: { volume?: number; loop?: boolean; fallback?: BuiltinKey } = {},
): PlayHandle {
  const volume = options.volume ?? 0.9;
  const loop = options.loop ?? false;
  const fallback = options.fallback ?? 'chime';

  if (!soundId) return playBuiltin(fallback, volume, loop);
  if (soundId.startsWith('builtin:')) {
    const key = soundId.slice('builtin:'.length);
    return playBuiltin(isBuiltinKey(key) ? key : fallback, volume, loop);
  }
  if (isBuiltinKey(soundId)) return playBuiltin(soundId, volume, loop);

  const url = resolveSoundUrl(soundId);
  // A sound whose file has gone missing should still ring, just with the
  // default tone — silence would look like a broken alarm.
  return url ? playFile(url, volume, loop) : playBuiltin(fallback, volume, loop);
}

/** Short confirmation blips used by the UI itself, independent of alarms. */
export function playCue(kind: 'success' | 'error' | 'tick' | 'listen') {
  const ctx = audioContext();
  if (!ctx || !master || ctx.state !== 'running') return;
  const now = ctx.currentTime;
  const gain = ctx.createGain();
  gain.gain.value = 0.16;
  gain.connect(master);

  const beep = (freq: number, start: number, duration = 0.08, type: OscillatorType = 'sine') => {
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    env.gain.setValueAtTime(0.0001, start);
    env.gain.exponentialRampToValueAtTime(1, start + 0.005);
    env.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(env).connect(gain);
    osc.start(start);
    osc.stop(start + duration + 0.02);
  };

  if (kind === 'success') {
    beep(660, now);
    beep(990, now + 0.07);
  } else if (kind === 'error') {
    beep(220, now, 0.14, 'square');
  } else if (kind === 'listen') {
    beep(880, now, 0.06);
  } else {
    beep(1320, now, 0.03);
  }
  window.setTimeout(() => gain.disconnect(), 500);
}

/** Best-effort haptics — silently ignored where unsupported. */
export function vibrate(pattern: number | number[]) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* not supported */
  }
}
