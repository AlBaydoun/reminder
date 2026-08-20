import { useEffect, useMemo, useState } from 'react';
import { ensureFont, FONTS, fontById, scriptForLocale, warmFonts, type FontCategory } from '../lib/fonts';
import { useTranslation } from '../store/ui';

const ORDER: FontCategory[] = ['handwriting', 'display', 'serif', 'sans', 'mono'];

const CATEGORY_LABEL: Record<FontCategory, string> = {
  handwriting: 'Handwriting',
  display: 'Display',
  serif: 'Serif',
  sans: 'Sans',
  mono: 'Mono',
};

/**
 * Font chooser. Each name is drawn in its own face, which is the only way to
 * pick a typeface honestly — and the faces are fetched as they scroll into
 * view rather than all at once, so opening the picker does not download forty
 * stylesheets.
 */
export function FontPicker({
  value,
  onChange,
  /** Hide faces that cannot render the current language's script. */
  filterByLocale = true,
}: {
  value: string;
  onChange(id: string): void;
  filterByLocale?: boolean;
}) {
  const { dict, locale } = useTranslation();
  const [query, setQuery] = useState('');
  const script = scriptForLocale(locale);

  const available = useMemo(
    () => (filterByLocale ? FONTS.filter((f) => f.scripts.includes(script)) : FONTS),
    [filterByLocale, script],
  );

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? available.filter((f) => f.name.toLowerCase().includes(needle)) : available;
  }, [available, query]);

  // The selected face must be ready immediately; the rest can trickle in.
  useEffect(() => {
    void ensureFont(value);
  }, [value]);

  useEffect(() => {
    warmFonts(matches.slice(0, 14).map((f) => f.id));
  }, [matches]);

  return (
    <div className="font-picker">
      <input
        className="input font-picker__search"
        value={query}
        placeholder={dict.canvas.fontSearch}
        onChange={(event) => setQuery(event.target.value)}
        aria-label={dict.canvas.fontSearch}
      />

      <div className="font-picker__list">
        {ORDER.map((category) => {
          const group = matches.filter((f) => f.category === category);
          if (!group.length) return null;
          return (
            <div key={category} className="font-picker__group">
              <p className="font-picker__heading faint">{CATEGORY_LABEL[category]}</p>
              {group.map((font) => (
                <button
                  key={font.id}
                  className={`font-picker__item ${value === font.id ? 'is-active' : ''}`}
                  style={{ fontFamily: font.stack }}
                  onClick={() => {
                    void ensureFont(font.id);
                    onChange(font.id);
                  }}
                  onMouseEnter={() => void ensureFont(font.id)}
                  title={font.name}
                >
                  {font.name}
                </button>
              ))}
            </div>
          );
        })}
        {!matches.length && <p className="muted font-picker__empty">{dict.common.empty}</p>}
      </div>

      <p className="faint font-picker__preview" style={{ fontFamily: fontById(value)?.stack }}>
        {dict.item.titlePlaceholder}
      </p>
    </div>
  );
}
