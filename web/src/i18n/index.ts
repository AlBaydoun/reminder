import { en, type Dictionary } from './en';
import { ar } from './ar';
import { ru } from './ru';

export type Locale = 'en' | 'ar' | 'ru';

export const DICTIONARIES: Record<Locale, Dictionary> = { en, ar, ru };

export interface LocaleMeta {
  code: Locale;
  /** Name written in the language itself. */
  native: string;
  english: string;
  dir: 'ltr' | 'rtl';
  /** BCP-47 tags handed to the Web Speech API, best match first. */
  speech: string[];
  flag: string;
}

export const LOCALES: LocaleMeta[] = [
  { code: 'en', native: 'English', english: 'English', dir: 'ltr', speech: ['en-US', 'en-GB'], flag: '🇬🇧' },
  { code: 'ar', native: 'العربية', english: 'Arabic', dir: 'rtl', speech: ['ar-SA', 'ar-LB', 'ar-EG'], flag: '🇸🇦' },
  { code: 'ru', native: 'Русский', english: 'Russian', dir: 'ltr', speech: ['ru-RU'], flag: '🇷🇺' },
];

export const localeMeta = (locale: Locale): LocaleMeta =>
  LOCALES.find((l) => l.code === locale) ?? LOCALES[0];

/** Read a dotted path out of a dictionary, falling back to English then the key. */
function lookup(dict: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, dict);
}

export type Vars = Record<string, string | number | undefined | null>;

/** Replace `{name}` placeholders. Unknown placeholders are left visible on purpose. */
export function interpolate(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    vars[key] === undefined || vars[key] === null ? match : String(vars[key]),
  );
}

export function translate(locale: Locale, path: string, vars?: Vars): string {
  const value = lookup(DICTIONARIES[locale], path) ?? lookup(en, path);
  if (typeof value !== 'string') return path;
  return interpolate(value, vars);
}

export function dictionaryFor(locale: Locale): Dictionary {
  return DICTIONARIES[locale] ?? en;
}

export function detectLocale(): Locale {
  const stored = typeof localStorage !== 'undefined' ? localStorage.getItem('nexus.locale') : null;
  if (stored === 'en' || stored === 'ar' || stored === 'ru') return stored;
  const nav = typeof navigator !== 'undefined' ? navigator.language.slice(0, 2).toLowerCase() : 'en';
  return nav === 'ar' || nav === 'ru' ? (nav as Locale) : 'en';
}

/** Intl tags used for date/number formatting per locale. */
const INTL_TAG: Record<Locale, string> = { en: 'en-GB', ar: 'ar', ru: 'ru-RU' };
export const intlTag = (locale: Locale) => INTL_TAG[locale] ?? 'en-GB';

export type { Dictionary };
