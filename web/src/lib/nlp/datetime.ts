import type { Locale, Recurrence } from '../types';
import { lexiconFor, type Lexicon } from './lexicon';
import { normalize, wordToNumber } from './numbers';

/**
 * Natural-language date, time and repeat parser for English, Arabic and
 * Russian. It works on the *normalized* string and reports the character
 * ranges it consumed, so the caller can subtract them and be left with a
 * clean task title — "remind me to buy milk tomorrow at 8" leaves "buy milk".
 */

export interface WhenResult {
  at: Date | null;
  recurrence: Recurrence | null;
  /** [start, end) ranges of the normalized text that the parser used. */
  spans: Array<[number, number]>;
  hasExplicitTime: boolean;
  hasExplicitDate: boolean;
}

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * JavaScript's `\b` is defined over ASCII word characters only, so it never
 * fires next to Arabic or Cyrillic letters — `\bالاثنين\b` matches nothing at
 * all. These Unicode-aware lookarounds are the boundary the parser uses
 * everywhere instead.
 */
const WB = '(?<![\\p{L}\\p{N}_])';
const WE = '(?![\\p{L}\\p{N}_])';

/** Longest-first alternation so "tomorrow" wins over "tom". */
function alternation(words: string[]): string {
  return [...words].sort((a, b) => b.length - a.length).map(escape).join('|');
}

const empty = (): WhenResult => ({
  at: null,
  recurrence: null,
  spans: [],
  hasExplicitTime: false,
  hasExplicitDate: false,
});

interface TimeOfDay {
  hour: number;
  minute: number;
}

function setTime(base: Date, time: TimeOfDay): Date {
  const out = new Date(base);
  out.setHours(time.hour, time.minute, 0, 0);
  return out;
}

function startOfDay(date: Date): Date {
  const out = new Date(date);
  out.setHours(0, 0, 0, 0);
  return out;
}

/** Next date (today included when `allowToday`) whose weekday matches. */
function nextWeekday(from: Date, weekday: number, allowToday: boolean): Date {
  const out = startOfDay(from);
  let delta = (weekday - out.getDay() + 7) % 7;
  if (delta === 0 && !allowToday) delta = 7;
  out.setDate(out.getDate() + delta);
  return out;
}

const UNIT_MS: Record<string, number> = {
  minute: MINUTE,
  hour: HOUR,
  day: DAY,
  week: 7 * DAY,
};

const UNIT_FREQ: Record<string, Recurrence['freq']> = {
  minute: 'minutely',
  hour: 'hourly',
  day: 'daily',
  week: 'weekly',
  month: 'monthly',
  year: 'yearly',
};

export function parseWhen(
  rawText: string,
  locale: Locale,
  now: Date = new Date(),
  options: { defaultHour?: number } = {},
): WhenResult {
  const lex = lexiconFor(locale);
  const text = normalize(rawText, locale);
  const result = empty();
  if (!text) return result;

  const defaultHour = options.defaultHour ?? 9;
  const spans: Array<[number, number]> = [];
  const claim: Claim = (match, length) => {
    if (match?.index === undefined) return;
    spans.push([match.index, match.index + (length ?? match[0].length)]);
  };

  // ── 1. Repeat rule ──────────────────────────────────────────────────────
  const repeat = parseRecurrence(text, lex, locale, claim);

  // ── 2. Relative offset: "in 20 minutes" / "بعد ساعتين" / "через 2 часа" ──
  const offset = parseRelativeOffset(text, lex, locale, now, claim);

  // ── 3. Calendar day ─────────────────────────────────────────────────────
  const day = parseDay(text, lex, locale, now, claim);

  // ── 4. Time of day ──────────────────────────────────────────────────────
  const time = parseTimeOfDay(text, lex, locale, claim);

  result.spans = spans.sort((a, b) => a[0] - b[0]);
  result.hasExplicitTime = Boolean(time) || Boolean(offset && offset.unit !== 'day');
  result.hasExplicitDate = Boolean(day) || Boolean(offset);

  // ── 5. Compose an instant ───────────────────────────────────────────────
  let at: Date | null = null;

  if (offset) {
    at = offset.at;
    // "in 3 days at 8" — the offset picks the day, the clock time refines it.
    if (time && (offset.unit === 'day' || offset.unit === 'week' || offset.unit === 'month' || offset.unit === 'year')) {
      at = setTime(at, time);
    }
  } else if (day) {
    at = setTime(day, time ?? { hour: defaultHour, minute: 0 });
  } else if (time) {
    at = setTime(now, time);
    // A bare clock time that already passed today means tomorrow.
    if (at.getTime() <= now.getTime()) at = new Date(at.getTime() + DAY);
  }

  if (repeat) {
    // The repeat needs an anchor. Use whatever the sentence gave us; failing
    // that, the next slot that satisfies the rule.
    if (!at) at = anchorForRecurrence(repeat, now, time, defaultHour);
    if (repeat.at?.length && !time) {
      at = setTime(at, { hour: repeat.at[0].hour, minute: repeat.at[0].minute });
    } else if (time) {
      repeat.at = [{ hour: time.hour, minute: time.minute }];
      at = setTime(at, time);
    }
    if (at.getTime() <= now.getTime()) {
      at = advanceToFuture(repeat, at, now);
    }
    result.recurrence = repeat;
  }

  result.at = at;
  return result;
}

function anchorForRecurrence(
  rule: Recurrence,
  now: Date,
  time: TimeOfDay | null,
  defaultHour: number,
): Date {
  const clock = time ?? (rule.at?.[0] ? { hour: rule.at[0].hour, minute: rule.at[0].minute } : { hour: defaultHour, minute: 0 });
  if (rule.freq === 'weekly' && rule.byWeekday?.length) {
    const candidates = rule.byWeekday
      .map((wd) => setTime(nextWeekday(now, wd, true), clock))
      .filter((d) => d.getTime() > now.getTime());
    if (candidates.length) return candidates.sort((a, b) => a.getTime() - b.getTime())[0];
    return setTime(nextWeekday(now, rule.byWeekday[0], false), clock);
  }
  if (rule.freq === 'minutely' || rule.freq === 'hourly') return new Date(now.getTime() + MINUTE);
  const today = setTime(now, clock);
  return today.getTime() > now.getTime() ? today : new Date(today.getTime() + DAY);
}

/** Step a repeat forward until it is in the future — used when the sentence named a past time. */
function advanceToFuture(rule: Recurrence, from: Date, now: Date): Date {
  const step =
    rule.freq === 'minutely' ? MINUTE * rule.interval
      : rule.freq === 'hourly' ? HOUR * rule.interval
        : rule.freq === 'daily' ? DAY * rule.interval
          : rule.freq === 'weekly' ? 7 * DAY * rule.interval
            : 0;
  let out = new Date(from);
  if (step > 0) {
    const gap = now.getTime() - out.getTime();
    out = new Date(out.getTime() + Math.ceil((gap + 1) / step) * step);
    return out;
  }
  // Monthly / yearly walk by calendar units so day-of-month is preserved.
  let guard = 0;
  while (out.getTime() <= now.getTime() && guard++ < 120) {
    if (rule.freq === 'monthly') out.setMonth(out.getMonth() + rule.interval);
    else out.setFullYear(out.getFullYear() + rule.interval);
  }
  return out;
}

type Claim = (m: RegExpMatchArray | null, length?: number) => void;

function parseRecurrence(text: string, lex: Lexicon, locale: Locale, claim: Claim): Recurrence | null {
  const every = alternation(lex.every);
  const weekdayWords = alternation(Object.keys(lex.weekdays));
  const unitWords = alternation([...Object.keys(lex.units), ...Object.keys(lex.dualUnits)]);
  const shorthand = alternation(Object.keys(lex.weekdayShorthand));

  // "daily" / "يوميا" / "еженедельно"
  const freqWord = new RegExp(`${WB}(${alternation(Object.keys(lex.frequencyWords))})${WE}`, 'u');
  const freqMatch = Object.keys(lex.frequencyWords).length ? text.match(freqWord) : null;
  if (freqMatch) {
    claim(freqMatch);
    const named = lex.frequencyWords[freqMatch[1]];
    return { freq: named === 'daily' ? 'daily' : named === 'weekly' ? 'weekly' : named === 'monthly' ? 'monthly' : 'yearly', interval: 1 };
  }

  if (!lex.every.length) return null;

  // "every weekday" / "every weekend"
  const shorthandMatch = shorthand ? text.match(new RegExp(`${WB}(${every})\\s+(${shorthand})${WE}`, 'u')) : null;
  if (shorthandMatch) {
    claim(shorthandMatch);
    return { freq: 'weekly', interval: 1, byWeekday: lex.weekdayShorthand[shorthandMatch[2]] };
  }

  // "every monday", "every monday and thursday"
  const weekdayMatch = text.match(
    new RegExp(`${WB}(${every})\\s+(${weekdayWords})(?:\\s*(?:,|and|و|и)\\s*(${weekdayWords}))?`, 'u'),
  );
  if (weekdayMatch) {
    claim(weekdayMatch);
    const days = [lex.weekdays[weekdayMatch[2]]];
    if (weekdayMatch[3] !== undefined) days.push(lex.weekdays[weekdayMatch[3]]);
    return { freq: 'weekly', interval: 1, byWeekday: [...new Set(days)].sort() };
  }

  // "every 3 weeks", "every other day", "every ساعتين"
  const nWordPattern = '[\\p{L}\\d]+(?:\\s+[\\p{L}]+)?';
  const intervalMatch = text.match(
    new RegExp(`${WB}(${every})\\s+(?:(${nWordPattern})\\s+)?(${unitWords})${WE}`, 'u'),
  );
  if (intervalMatch) {
    claim(intervalMatch);
    const unitToken = intervalMatch[3];
    const dual = lex.dualUnits[unitToken];
    const unit = dual?.unit ?? lex.units[unitToken];
    if (unit) {
      let interval = dual?.count ?? 1;
      const countToken = intervalMatch[2];
      if (countToken) {
        if (/^(other|второй|اخر)$/u.test(countToken)) interval = 2;
        else interval = wordToNumber(countToken, locale) ?? interval;
      }
      return { freq: UNIT_FREQ[unit], interval: Math.max(1, interval) };
    }
  }

  // "every morning" / "every evening"
  const dayPartMatch = text.match(new RegExp(`${WB}(${every})\\s+(${alternation(Object.keys(lex.dayParts))})${WE}`, 'u'));
  if (dayPartMatch) {
    claim(dayPartMatch);
    return { freq: 'daily', interval: 1, at: [{ hour: lex.dayParts[dayPartMatch[2]], minute: 0 }] };
  }

  return null;
}

function parseRelativeOffset(
  text: string,
  lex: Lexicon,
  locale: Locale,
  now: Date,
  claim: Claim,
): { at: Date; unit: string } | null {
  const inWords = alternation(lex.inWords);
  const unitWords = alternation(Object.keys(lex.units));
  const dualWords = Object.keys(lex.dualUnits);

  // Dual forms carry their own count: "بعد ساعتين" = in two hours.
  if (dualWords.length) {
    const dualMatch = text.match(new RegExp(`${WB}(${inWords})\\s+(${alternation(dualWords)})${WE}`, 'u'));
    if (dualMatch) {
      claim(dualMatch);
      const { unit, count } = lex.dualUnits[dualMatch[2]];
      return { at: addUnits(now, unit, count), unit };
    }
  }

  const match = text.match(
    new RegExp(`${WB}(${inWords})\\s+([\\p{L}\\d]+(?:\\s+[\\p{L}]+)?)\\s*(${unitWords})${WE}`, 'u'),
  );
  if (!match) return null;
  const count = wordToNumber(match[2], locale);
  const unit = lex.units[match[3]];
  if (count === null || !unit) return null;
  claim(match);
  return { at: addUnits(now, unit, count), unit };
}

function addUnits(from: Date, unit: string, count: number): Date {
  if (unit in UNIT_MS) return new Date(from.getTime() + UNIT_MS[unit] * count);
  const out = new Date(from);
  if (unit === 'month') out.setMonth(out.getMonth() + count);
  else if (unit === 'year') out.setFullYear(out.getFullYear() + count);
  return out;
}

function parseDay(text: string, lex: Lexicon, locale: Locale, now: Date, claim: Claim): Date | null {
  // "day after tomorrow" must be tried before "tomorrow".
  const relWords = alternation(Object.keys(lex.relativeDays));
  const relMatch = text.match(new RegExp(`${WB}(${relWords})${WE}`, 'u'));
  if (relMatch) {
    claim(relMatch);
    const out = startOfDay(now);
    out.setDate(out.getDate() + lex.relativeDays[relMatch[1]]);
    return out;
  }

  // Numeric dates: 15/07, 15-07-2026, 2026-07-15
  const isoMatch = text.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/u);
  if (isoMatch) {
    claim(isoMatch);
    return new Date(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3]));
  }
  const dmyMatch = text.match(/\b(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?\b/u);
  if (dmyMatch) {
    claim(dmyMatch);
    const year = dmyMatch[3]
      ? Number(dmyMatch[3].length === 2 ? `20${dmyMatch[3]}` : dmyMatch[3])
      : now.getFullYear();
    const candidate = new Date(year, Number(dmyMatch[2]) - 1, Number(dmyMatch[1]));
    // A bare day/month that already passed almost always means next year.
    if (!dmyMatch[3] && candidate < startOfDay(now)) candidate.setFullYear(year + 1);
    return candidate;
  }

  // "3 july" / "july 3" / "الثالث من تموز" (numeric form) / "3 июля"
  const monthWords = alternation(Object.keys(lex.months));
  if (monthWords) {
    const dayMonth = text.match(new RegExp(`${WB}(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+|من\\s+)?(${monthWords})${WE}`, 'u'));
    const monthDay = text.match(new RegExp(`${WB}(${monthWords})\\s+(\\d{1,2})(?:st|nd|rd|th)?${WE}`, 'u'));
    const hit = dayMonth ?? monthDay;
    if (hit) {
      claim(hit);
      const dayNum = Number(dayMonth ? hit[1] : hit[2]);
      const monthNum = lex.months[dayMonth ? hit[2] : hit[1]];
      const candidate = new Date(now.getFullYear(), monthNum - 1, dayNum);
      if (candidate < startOfDay(now)) candidate.setFullYear(now.getFullYear() + 1);
      return candidate;
    }
  }

  // "on the 15th" — a day number with no month means the next time it comes round.
  const ordinal = text.match(
    new RegExp(`${WB}(?:${alternation(lex.onWords)}|on)\\s+(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th|-го)?${WE}`, 'u'),
  );
  if (ordinal) {
    const dayNum = Number(ordinal[1]);
    if (dayNum >= 1 && dayNum <= 31) {
      claim(ordinal);
      const candidate = new Date(now.getFullYear(), now.getMonth(), dayNum);
      if (candidate < startOfDay(now)) candidate.setMonth(candidate.getMonth() + 1);
      return candidate;
    }
  }

  // "next week" / "next month"
  const nextWords = alternation(lex.nextWords);
  const unitWords = alternation(Object.keys(lex.units));
  const nextUnit =
    text.match(new RegExp(`${WB}(${nextWords})\\s+(${unitWords})${WE}`, 'u')) ??
    text.match(new RegExp(`${WB}(${unitWords})\\s+(${nextWords})${WE}`, 'u'));
  if (nextUnit) {
    const unitToken = lex.units[nextUnit[2]] ? nextUnit[2] : nextUnit[1];
    const unit = lex.units[unitToken];
    if (unit && unit !== 'minute' && unit !== 'hour') {
      claim(nextUnit);
      return startOfDay(addUnits(now, unit, 1));
    }
  }

  // "next monday" / "on friday" / bare "friday"
  const weekdayWords = alternation(Object.keys(lex.weekdays));
  const onWords = alternation(lex.onWords);
  const withNext = text.match(new RegExp(`${WB}(${nextWords})\\s+(${weekdayWords})${WE}`, 'u'));
  if (withNext) {
    claim(withNext);
    return nextWeekday(now, lex.weekdays[withNext[2]], false);
  }
  const withOn = onWords ? text.match(new RegExp(`${WB}(${onWords})\\s+(${weekdayWords})${WE}`, 'u')) : null;
  if (withOn) {
    claim(withOn);
    return nextWeekday(now, lex.weekdays[withOn[2]], true);
  }
  const bare = text.match(new RegExp(`${WB}(${weekdayWords})${WE}`, 'u'));
  if (bare) {
    claim(bare);
    return nextWeekday(now, lex.weekdays[bare[1]], true);
  }

  return null;
}

function parseTimeOfDay(text: string, lex: Lexicon, locale: Locale, claim: Claim): TimeOfDay | null {
  const atWords = alternation(lex.atWords);
  const am = alternation(lex.amWords);
  const pm = alternation(lex.pmWords);
  const meridiem = alternation([...lex.amWords, ...lex.pmWords]);

  const applyMeridiem = (hour: number, marker: string | undefined): number => {
    if (!marker) return hour;
    const isPm = lex.pmWords.some((w) => marker.startsWith(w) || w.startsWith(marker));
    const isAm = lex.amWords.some((w) => marker.startsWith(w) || w.startsWith(marker));
    if (isPm && hour < 12) return hour + 12;
    if (isAm && hour === 12) return 0;
    return hour;
  };

  // "half past eight" / "quarter past nine" — English only phrasing.
  if (locale === 'en') {
    const past = text.match(/\b(?:at\s+)?(half|quarter|\d{1,2})\s+past\s+(\d{1,2}|[a-z]+)\b/u);
    if (past) {
      const minutes = past[1] === 'half' ? 30 : past[1] === 'quarter' ? 15 : Number(past[1]);
      const hour = wordToNumber(past[2], 'en');
      if (hour !== null && Number.isFinite(minutes)) {
        claim(past);
        return { hour: hour % 24, minute: minutes % 60 };
      }
    }
    const to = text.match(/\b(?:at\s+)?(quarter|\d{1,2})\s+to\s+(\d{1,2}|[a-z]+)\b/u);
    if (to) {
      const minutes = to[1] === 'quarter' ? 15 : Number(to[1]);
      const hour = wordToNumber(to[2], 'en');
      if (hour !== null && Number.isFinite(minutes)) {
        claim(to);
        return { hour: (hour + 23) % 24, minute: (60 - minutes) % 60 };
      }
    }
  }

  // "at 8:30 pm" / "8:30pm" / "الساعه 8:30 مساء" / "в 8:30 вечера"
  const explicit = text.match(
    new RegExp(`(?:${WB}(?:${atWords})\\s+)?${WB}(\\d{1,2})[:.](\\d{2})\\s*(${meridiem})?${WE}`, 'u'),
  );
  if (explicit) {
    claim(explicit);
    return {
      hour: applyMeridiem(Number(explicit[1]) % 24, explicit[3]),
      minute: Number(explicit[2]) % 60,
    };
  }

  // "at 8 pm", "8pm", "at eight", "الساعه ثمانيه", "в восемь"
  const numberish = '\\d{1,2}|[\\p{L}]+(?:\\s+[\\p{L}]+)?';
  // Try every "<at-word> …" position independently. A plain `matchAll` would
  // not do: in "в понедельник в девять утра" the first candidate swallows the
  // second one and then fails, hiding the only real clock time in the phrase.
  const anchored = new RegExp(`(?:${atWords})\\s+(${numberish})\\s*(${meridiem})?${WE}`, 'uy');
  const atPositions = [...text.matchAll(new RegExp(`${WB}(?:${atWords})${WE}`, 'gu'))];

  for (const position of atPositions) {
    if (position.index === undefined) continue;
    anchored.lastIndex = position.index;
    const loose = anchored.exec(text);
    if (!loose) continue;

    const phrase = loose[1];
    let hour = wordToNumber(phrase, locale);
    let consumedLength = loose[0].length;

    if (hour === null && /\s/u.test(phrase)) {
      // "تسعة صباحا" / "девять утра": the trailing word is a day-part, not part
      // of the number, so retry with the first word and claim only that much.
      const first = phrase.split(/\s+/u)[0];
      const single = wordToNumber(first, locale);
      if (single !== null) {
        hour = single;
        consumedLength = loose[0].indexOf(phrase) + first.length;
      }
    }

    if (hour !== null && hour >= 0 && hour <= 24) {
      claim({ ...loose, index: position.index } as RegExpMatchArray, consumedLength);
      const marker = loose[2] ?? phrase.split(/\s+/u)[1];
      return { hour: applyMeridiem(hour % 24, marker), minute: 0 };
    }
  }

  // A meridiem marker is strong enough on its own: "8 pm", "٨ مساء".
  const withMarker = text.match(new RegExp(`${WB}(\\d{1,2})\\s*(${meridiem})${WE}`, 'u'));
  if (withMarker) {
    claim(withMarker);
    return { hour: applyMeridiem(Number(withMarker[1]) % 24, withMarker[2]), minute: 0 };
  }

  // Named parts of the day: "in the morning", "المساء", "вечером".
  const partWords = alternation(Object.keys(lex.dayParts));
  const part = text.match(new RegExp(`${WB}(${partWords})${WE}`, 'u'));
  if (part) {
    claim(part);
    return { hour: lex.dayParts[part[1]], minute: 0 };
  }

  return null;
}

/** Remove the consumed ranges, leaving the words that describe the task itself. */
export function stripSpans(text: string, spans: Array<[number, number]>): string {
  if (!spans.length) return text.trim();
  const merged: Array<[number, number]> = [];
  for (const span of [...spans].sort((a, b) => a[0] - b[0])) {
    const last = merged[merged.length - 1];
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([...span]);
  }
  let out = '';
  let cursor = 0;
  for (const [start, end] of merged) {
    out += text.slice(cursor, start) + ' ';
    cursor = end;
  }
  out += text.slice(cursor);
  return out.replace(/\s+/g, ' ').trim();
}
