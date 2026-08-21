import { Check, Pipette } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from '../store/ui';

const RECENTS_KEY = 'nexus.recentColors';
const MAX_RECENTS = 10;

/** Quick picks, chosen to stay legible on both the dark and light canvas. */
export const SWATCHES = [
  '#7ce7ff', '#4cc2ff', '#a68bff', '#ff7ce0',
  '#3ddc97', '#ffc46b', '#ff8a5c', '#ff6b8a',
  '#eef1ff', '#9aa3c7', '#0b1020', '#000000',
];

/** Translucent inks that read as marker over other work. */
export const HIGHLIGHT_SWATCHES = [
  '#ffe066', '#b5ff6b', '#6bffd5', '#6bc4ff',
  '#c98bff', '#ff8bd5', '#ff9d6b', '#ffffff',
];

function loadRecents(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((c) => typeof c === 'string').slice(0, MAX_RECENTS) : [];
  } catch {
    return [];
  }
}

export function rememberColor(color: string) {
  const next = [color, ...loadRecents().filter((c) => c !== color)].slice(0, MAX_RECENTS);
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    /* private mode — recents are a convenience, not data */
  }
}

/**
 * Colour chooser: quick swatches, anything at all through the system picker,
 * and the colours you actually used recently. Highlighter inks are a separate
 * set because a highlight has to be light enough to read through.
 */
export function ColorPicker({
  value,
  onChange,
  palette = 'ink',
  compact = false,
}: {
  value: string;
  onChange(color: string): void;
  palette?: 'ink' | 'highlight';
  compact?: boolean;
}) {
  const { dict } = useTranslation();
  const [recents, setRecents] = useState<string[]>(loadRecents);
  const nativeInput = useRef<HTMLInputElement>(null);

  // Recents are shared across every brush, so refresh them when reopening.
  useEffect(() => setRecents(loadRecents()), [value]);

  const swatches = palette === 'highlight' ? HIGHLIGHT_SWATCHES : SWATCHES;

  const pick = (color: string) => {
    rememberColor(color);
    setRecents(loadRecents());
    onChange(color);
  };

  const Swatch = ({ color }: { color: string }) => (
    <button
      className={`swatch ${value.toLowerCase() === color.toLowerCase() ? 'is-active' : ''}`}
      style={{ background: color }}
      onClick={() => pick(color)}
      aria-label={color}
      title={color}
    >
      {value.toLowerCase() === color.toLowerCase() && <Check size={11} className="swatch__tick" />}
    </button>
  );

  return (
    <div className={`color-picker ${compact ? 'is-compact' : ''}`}>
      <div className="color-picker__row">
        {swatches.map((color) => (
          <Swatch key={color} color={color} />
        ))}

        <button
          className="swatch swatch--custom"
          onClick={() => nativeInput.current?.click()}
          title={dict.canvas.color.custom}
          aria-label={dict.canvas.color.custom}
          style={{ background: value }}
        >
          <Pipette size={12} />
        </button>
        <input
          ref={nativeInput}
          type="color"
          className="sr-only"
          value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#7ce7ff'}
          onChange={(event) => pick(event.target.value)}
          aria-label={dict.canvas.color.custom}
        />
      </div>

      {recents.length > 0 && !compact && (
        <div className="color-picker__row color-picker__recents">
          <span className="faint color-picker__label">{dict.canvas.color.recent}</span>
          {recents.map((color) => (
            <Swatch key={`recent-${color}`} color={color} />
          ))}
        </div>
      )}
    </div>
  );
}
