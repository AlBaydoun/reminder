import { create } from 'zustand';
import { detectLocale, dictionaryFor, localeMeta, translate, type Vars } from '../i18n';
import type { Dictionary } from '../i18n/en';
import type { Locale } from '../lib/types';

export type Theme = 'dark' | 'light';
export type MotionLevel = 'full' | 'balanced' | 'calm';

export interface Toast {
  id: string;
  message: string;
  tone: 'info' | 'success' | 'warn' | 'error';
  /** Optional inline action, e.g. "Undo" right after a voice command. */
  action?: { label: string; run: () => void };
  duration: number;
}

interface UiState {
  locale: Locale;
  dir: 'ltr' | 'rtl';
  dict: Dictionary;
  theme: Theme;
  motion: MotionLevel;
  /** Resolved from motion + device capability + prefers-reduced-motion. */
  effects: { threeD: boolean; particles: boolean; heavyBlur: boolean };
  toasts: Toast[];
  commandPaletteOpen: boolean;
  voiceOpen: boolean;
  detailItemId: string | null;

  setLocale(locale: Locale): void;
  setTheme(theme: Theme): void;
  setMotion(motion: MotionLevel): void;
  t(path: string, vars?: Vars): string;
  toast(message: string, tone?: Toast['tone'], options?: { action?: Toast['action']; duration?: number }): string;
  dismissToast(id: string): void;
  setCommandPalette(open: boolean): void;
  setVoiceOpen(open: boolean): void;
  openDetail(id: string | null): void;
}

/**
 * Devices tell us a surprising amount before we render anything: core count,
 * declared memory and the reduced-motion preference. A four-core phone with
 * 2 GB should not be asked to run a bloom-post-processed WebGL scene.
 */
function deviceTier(): MotionLevel {
  if (typeof window === 'undefined') return 'balanced';
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return 'calm';
  const memory = (navigator as any).deviceMemory as number | undefined;
  const cores = navigator.hardwareConcurrency ?? 4;
  if ((memory !== undefined && memory <= 2) || cores <= 2) return 'calm';
  if ((memory !== undefined && memory <= 4) || cores <= 4) return 'balanced';
  return 'full';
}

function hasWebGL(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

function effectsFor(motion: MotionLevel) {
  const reduced =
    typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (motion === 'calm' || reduced) return { threeD: false, particles: false, heavyBlur: false };
  if (motion === 'balanced') return { threeD: hasWebGL(), particles: false, heavyBlur: true };
  return { threeD: hasWebGL(), particles: true, heavyBlur: true };
}

function applyDocument(locale: Locale, theme: Theme, motion: MotionLevel) {
  if (typeof document === 'undefined') return;
  const meta = localeMeta(locale);
  const root = document.documentElement;
  root.lang = locale;
  root.dir = meta.dir;
  root.dataset.theme = theme;
  root.dataset.motion = motion;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', theme === 'light' ? '#eef1fb' : '#05060f');
}

const storedTheme = (): Theme =>
  (typeof localStorage !== 'undefined' && localStorage.getItem('nexus.theme')) === 'light' ? 'light' : 'dark';

const storedMotion = (): MotionLevel => {
  const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('nexus.motion') : null;
  return raw === 'full' || raw === 'balanced' || raw === 'calm' ? raw : deviceTier();
};

const initialLocale = detectLocale();
const initialTheme = storedTheme();
const initialMotion = storedMotion();
applyDocument(initialLocale, initialTheme, initialMotion);

export const useUi = create<UiState>((set, get) => ({
  locale: initialLocale,
  dir: localeMeta(initialLocale).dir,
  dict: dictionaryFor(initialLocale),
  theme: initialTheme,
  motion: initialMotion,
  effects: effectsFor(initialMotion),
  toasts: [],
  commandPaletteOpen: false,
  voiceOpen: false,
  detailItemId: null,

  setLocale(locale) {
    localStorage.setItem('nexus.locale', locale);
    applyDocument(locale, get().theme, get().motion);
    set({ locale, dir: localeMeta(locale).dir, dict: dictionaryFor(locale) });
  },

  setTheme(theme) {
    localStorage.setItem('nexus.theme', theme);
    applyDocument(get().locale, theme, get().motion);
    set({ theme });
  },

  setMotion(motion) {
    localStorage.setItem('nexus.motion', motion);
    applyDocument(get().locale, get().theme, motion);
    set({ motion, effects: effectsFor(motion) });
  },

  t(path, vars) {
    return translate(get().locale, path, vars);
  },

  toast(message, tone = 'info', options = {}) {
    const id = crypto.randomUUID();
    const duration = options.duration ?? (tone === 'error' ? 7000 : options.action ? 8000 : 4000);
    set((state) => ({ toasts: [...state.toasts, { id, message, tone, action: options.action, duration }] }));
    window.setTimeout(() => get().dismissToast(id), duration);
    return id;
  },

  dismissToast(id) {
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
  },

  setCommandPalette(open) {
    set({ commandPaletteOpen: open });
  },
  setVoiceOpen(open) {
    set({ voiceOpen: open });
  },
  openDetail(id) {
    set({ detailItemId: id });
  },
}));

/** Convenience hook: `const { t, dict } = useTranslation()`. */
export function useTranslation() {
  const t = useUi((s) => s.t);
  const dict = useUi((s) => s.dict);
  const locale = useUi((s) => s.locale);
  const dir = useUi((s) => s.dir);
  return { t, dict, locale, dir };
}
