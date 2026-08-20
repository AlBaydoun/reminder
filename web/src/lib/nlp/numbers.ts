import type { Locale } from '../types';

/**
 * Spoken numbers, per language. Speech recognition returns "eight" as often
 * as "8", and Arabic recognizers return Arabic-Indic digits, so every number
 * the parser meets has to be normalized before any maths happens.
 */

/** Arabic-Indic (٠-٩) and Extended Arabic-Indic (۰-۹) digits → ASCII. */
export function normalizeDigits(text: string): string {
  return text.replace(/[٠-٩۰-۹]/g, (ch) => {
    const code = ch.charCodeAt(0);
    const base = code >= 0x06f0 ? 0x06f0 : 0x0660;
    return String(code - base);
  });
}

/** Strip Arabic diacritics and unify alef/ya/ta-marbuta spellings for matching. */
export function normalizeArabic(text: string): string {
  return text
    .replace(/[ً-ْٰـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه');
}

const EN_UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, quarter: 15, half: 30, a: 1, an: 1, couple: 2, few: 3,
};

const AR_UNITS: Record<string, number> = {
  'صفر': 0, 'واحد': 1, 'واحدة': 1, 'اثنين': 2, 'اثنان': 2, 'اثنتين': 2, 'ثنتين': 2,
  'ثلاثة': 3, 'ثلاث': 3, 'اربعة': 4, 'أربعة': 4, 'اربع': 4, 'أربع': 4,
  'خمسة': 5, 'خمس': 5, 'ستة': 6, 'ست': 6, 'سبعة': 7, 'سبع': 7,
  'ثمانية': 8, 'ثماني': 8, 'تسعة': 9, 'تسع': 9, 'عشرة': 10, 'عشر': 10,
  'احدعشر': 11, 'اثناعشر': 12, 'عشرين': 20, 'ثلاثين': 30, 'اربعين': 40, 'أربعين': 40,
  'خمسين': 50, 'ستين': 60, 'ربع': 15, 'نص': 30, 'نصف': 30, 'ثلث': 20,
};

const RU_UNITS: Record<string, number> = {
  'ноль': 0, 'один': 1, 'одну': 1, 'одна': 1, 'два': 2, 'две': 2, 'три': 3, 'четыре': 4,
  'пять': 5, 'шесть': 6, 'семь': 7, 'восемь': 8, 'девять': 9, 'десять': 10,
  'одиннадцать': 11, 'двенадцать': 12, 'тринадцать': 13, 'четырнадцать': 14,
  'пятнадцать': 15, 'шестнадцать': 16, 'семнадцать': 17, 'восемнадцать': 18,
  'девятнадцать': 19, 'двадцать': 20, 'тридцать': 30, 'сорок': 40, 'пятьдесят': 50,
  'шестьдесят': 60, 'четверть': 15, 'полчаса': 30, 'пол': 30, 'пару': 2, 'несколько': 3,
};

/**
 * Arabic input is normalized (diacritics stripped, أإآ→ا, ى→ي, ة→ه) before it
 * is matched, so the lookup table has to be normalized identically or nothing
 * would ever match.
 */
function normalizeKeys(table: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(table)) out[normalizeArabic(key)] = value;
  return out;
}

export const NUMBER_WORDS: Record<Locale, Record<string, number>> = {
  en: EN_UNITS,
  ar: normalizeKeys(AR_UNITS),
  ru: RU_UNITS,
};

export function normalize(text: string, locale: Locale): string {
  let out = normalizeDigits(text).toLowerCase().replace(/\s+/g, ' ').trim();
  if (locale === 'ar') out = normalizeArabic(out);
  return out;
}

/**
 * Read a number that may be digits ("20"), a single word ("twenty"), or a
 * compound ("twenty five", "خمسة وعشرين", "двадцать пять").
 */
export function wordToNumber(token: string, locale: Locale): number | null {
  const cleaned = normalize(token, locale);
  if (/^\d+$/.test(cleaned)) return Number(cleaned);

  const words = NUMBER_WORDS[locale];
  if (cleaned in words) return words[cleaned];

  // Compound forms: "twenty five" / "خمسة وعشرين" / "двадцать пять".
  const parts = cleaned.split(/[\s،,]+|و(?=[؀-ۿ])/).filter(Boolean);
  if (parts.length > 1) {
    let total = 0;
    let matched = 0;
    for (const part of parts) {
      const value = part in words ? words[part] : /^\d+$/.test(part) ? Number(part) : null;
      if (value === null) continue;
      total += value;
      matched++;
    }
    if (matched >= 2) return total;
  }
  return null;
}

/** Regex fragment matching any number word in a locale, longest first. */
export function numberWordPattern(locale: Locale): string {
  const keys = Object.keys(NUMBER_WORDS[locale]).sort((a, b) => b.length - a.length);
  return `\\d+|${keys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}`;
}
