/**
 * The font library.
 *
 * Faces are fetched from Google Fonts on demand — a stylesheet link is added
 * the first time a face is actually used, not up front, so opening the app
 * never pays for forty typefaces nobody picked. Every entry declares which
 * scripts it can render, because a beautiful Latin display face is useless for
 * an Arabic list and silently falls back to something ugly.
 */

export type FontCategory = 'handwriting' | 'display' | 'serif' | 'sans' | 'mono';
export type Script = 'latin' | 'arabic' | 'cyrillic';

export interface FontFace {
  id: string;
  /** Family name as Google Fonts knows it. */
  name: string;
  category: FontCategory;
  scripts: Script[];
  /** Weights to request; the first is the default. */
  weights: number[];
  /** Full CSS stack, with a sensible fallback for while it loads. */
  stack: string;
}

const fallbackFor = (category: FontCategory): string =>
  category === 'mono'
    ? "ui-monospace, 'SF Mono', Menlo, monospace"
    : category === 'serif'
      ? "Georgia, 'Times New Roman', serif"
      : category === 'handwriting'
        ? 'cursive'
        : "system-ui, -apple-system, 'Segoe UI', sans-serif";

const face = (
  name: string,
  category: FontCategory,
  scripts: Script[],
  weights: number[] = [400, 700],
): FontFace => ({
  id: name.toLowerCase().replace(/\s+/g, '-'),
  name,
  category,
  scripts,
  weights,
  stack: `'${name}', ${fallbackFor(category)}`,
});

export const FONTS: FontFace[] = [
  // Handwriting — the point of a sketch pad
  face('Caveat', 'handwriting', ['latin', 'cyrillic'], [400, 600, 700]),
  face('Kalam', 'handwriting', ['latin'], [300, 400, 700]),
  face('Patrick Hand', 'handwriting', ['latin'], [400]),
  face('Shadows Into Light', 'handwriting', ['latin'], [400]),
  face('Indie Flower', 'handwriting', ['latin'], [400]),
  face('Architects Daughter', 'handwriting', ['latin'], [400]),
  face('Permanent Marker', 'handwriting', ['latin'], [400]),
  face('Gloria Hallelujah', 'handwriting', ['latin'], [400]),
  face('Rock Salt', 'handwriting', ['latin'], [400]),
  face('Homemade Apple', 'handwriting', ['latin'], [400]),
  face('Nanum Pen Script', 'handwriting', ['latin'], [400]),
  face('Dancing Script', 'handwriting', ['latin'], [400, 700]),
  face('Sacramento', 'handwriting', ['latin'], [400]),
  face('Great Vibes', 'handwriting', ['latin'], [400]),
  face('Marck Script', 'handwriting', ['latin', 'cyrillic'], [400]),
  face('Aref Ruqaa', 'handwriting', ['arabic'], [400, 700]),

  // Display
  face('Bebas Neue', 'display', ['latin'], [400]),
  face('Anton', 'display', ['latin'], [400]),
  face('Righteous', 'display', ['latin'], [400]),
  face('Bungee', 'display', ['latin'], [400]),
  face('Alfa Slab One', 'display', ['latin'], [400]),
  face('Lobster', 'display', ['latin', 'cyrillic'], [400]),
  face('Reem Kufi', 'display', ['arabic'], [400, 700]),

  // Serif
  face('Playfair Display', 'serif', ['latin', 'cyrillic'], [400, 700, 900]),
  face('Lora', 'serif', ['latin', 'cyrillic'], [400, 700]),
  face('Merriweather', 'serif', ['latin', 'cyrillic'], [300, 400, 700]),
  face('EB Garamond', 'serif', ['latin', 'cyrillic'], [400, 600]),
  face('Cormorant Garamond', 'serif', ['latin', 'cyrillic'], [300, 400, 700]),
  face('Amiri', 'serif', ['arabic', 'latin'], [400, 700]),
  face('Noto Naskh Arabic', 'serif', ['arabic'], [400, 700]),

  // Sans
  face('Inter', 'sans', ['latin', 'cyrillic'], [400, 500, 700]),
  face('Outfit', 'sans', ['latin'], [300, 400, 600, 800]),
  face('Space Grotesk', 'sans', ['latin'], [400, 700]),
  face('Poppins', 'sans', ['latin'], [400, 600]),
  face('Montserrat', 'sans', ['latin', 'cyrillic'], [400, 700]),
  face('Work Sans', 'sans', ['latin'], [400, 600]),
  face('Cairo', 'sans', ['arabic', 'latin'], [400, 700]),
  face('Tajawal', 'sans', ['arabic'], [400, 700]),

  // Mono
  face('JetBrains Mono', 'mono', ['latin', 'cyrillic'], [400, 700]),
  face('IBM Plex Mono', 'mono', ['latin', 'cyrillic'], [400, 600]),
  face('Space Mono', 'mono', ['latin'], [400, 700]),
];

export const fontById = (id: string): FontFace | undefined => FONTS.find((f) => f.id === id);

export function fontsForScript(script: Script): FontFace[] {
  return FONTS.filter((f) => f.scripts.includes(script));
}

/** Which script the interface language needs. */
export function scriptForLocale(locale: string): Script {
  if (locale === 'ar') return 'arabic';
  if (locale === 'ru') return 'cyrillic';
  return 'latin';
}

const requested = new Set<string>();

/**
 * Make a face available, loading its stylesheet the first time it is asked
 * for. Resolves once the browser reports the face ready, or immediately if it
 * cannot tell — a font that never arrives must not block the interface.
 */
export async function ensureFont(id: string, weight = 400): Promise<void> {
  const font = fontById(id);
  if (!font || typeof document === 'undefined') return;

  if (!requested.has(font.id)) {
    requested.add(font.id);
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    const family = font.name.replace(/\s+/g, '+');
    const weights = font.weights.join(';');
    link.href = `https://fonts.googleapis.com/css2?family=${family}:wght@${weights}&display=swap`;
    link.dataset.font = font.id;
    document.head.appendChild(link);
  }

  try {
    await document.fonts?.load(`${weight} 16px '${font.name}'`);
  } catch {
    // Offline, or the CDN is blocked — the fallback stack takes over.
  }
}

/** Preload the faces a screen is about to show, without blocking it. */
export function warmFonts(ids: string[]) {
  for (const id of ids) void ensureFont(id);
}

export const DEFAULT_CANVAS_FONT = 'caveat';
export const DEFAULT_INTERFACE_FONT = 'outfit';
