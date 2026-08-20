import { z } from 'zod';
import { DAY, HOUR, MINUTE, daysInMonth, toZonedParts, zonedPartsToUtc, zonedWeekday } from './time.js';

/**
 * A deliberately small subset of RFC 5545 — enough for every repeat a person
 * actually asks a reminder app for, and small enough to reason about.
 * The server is the sole owner of occurrence maths; clients only send rules.
 */
export const recurrenceSchema = z.object({
  freq: z.enum(['minutely', 'hourly', 'daily', 'weekly', 'monthly', 'yearly']),
  interval: z.number().int().min(1).max(1000).default(1),
  /** 0 = Sunday … 6 = Saturday. Only meaningful for weekly. */
  byWeekday: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  /** 1..31, or -1 for "last day of the month". Only meaningful for monthly/yearly. */
  byMonthDay: z.array(z.number().int().min(-1).max(31)).max(31).optional(),
  /** 1..12. Only meaningful for yearly. */
  byMonth: z.array(z.number().int().min(1).max(12)).max(12).optional(),
  /** Times of day to fire at. Multiple entries = several alarms per day. */
  at: z
    .array(z.object({ hour: z.number().int().min(0).max(23), minute: z.number().int().min(0).max(59) }))
    .max(24)
    .optional(),
  count: z.number().int().min(1).max(10_000).optional(),
  until: z.string().datetime().optional(),
  /** Skip occurrences that land on these YYYY-MM-DD days (e.g. dismissed once). */
  exceptions: z.array(z.string()).max(500).optional(),
});

export type Recurrence = z.infer<typeof recurrenceSchema>;

const SAFETY_ITERATIONS = 4000;

/**
 * Next occurrence strictly after `after`.
 *
 * `anchor` is the rule's first occurrence — it fixes the phase of the
 * interval (e.g. "every 3 days" counts from the anchor, not from today) and
 * supplies the time of day when the rule has no explicit `at` list.
 */
export function nextOccurrence(
  rule: Recurrence,
  anchor: Date,
  after: Date,
  timeZone: string,
  occurrencesSoFar = 0,
): Date | null {
  if (rule.count !== undefined && occurrencesSoFar >= rule.count) return null;
  const untilMs = rule.until ? new Date(rule.until).getTime() : Infinity;
  if (Number.isNaN(untilMs)) return null;

  const exceptions = new Set(rule.exceptions ?? []);
  const interval = Math.max(1, rule.interval || 1);
  const from = Math.max(after.getTime(), anchor.getTime() - 1);

  // Fixed-length frequencies are pure arithmetic — no calendar walking needed.
  if (rule.freq === 'minutely' || rule.freq === 'hourly') {
    const step = (rule.freq === 'minutely' ? MINUTE : HOUR) * interval;
    const elapsed = from - anchor.getTime();
    const steps = elapsed < 0 ? 0 : Math.floor(elapsed / step) + 1;
    const next = anchor.getTime() + steps * step;
    return next <= untilMs ? new Date(next) : null;
  }

  const anchorParts = toZonedParts(anchor, timeZone);
  const times =
    rule.at?.length ? [...rule.at] : [{ hour: anchorParts.hour, minute: anchorParts.minute }];
  times.sort((a, b) => a.hour - b.hour || a.minute - b.minute);

  // Walk candidate days forward from the day containing `from`.
  let cursor = toZonedParts(new Date(Math.max(from, anchor.getTime())), timeZone);
  let dayUtc = Date.UTC(cursor.year, cursor.month - 1, cursor.day);

  for (let i = 0; i < SAFETY_ITERATIONS; i++) {
    const probe = new Date(dayUtc);
    const y = probe.getUTCFullYear();
    const m = probe.getUTCMonth() + 1;
    const d = probe.getUTCDate();

    if (dayMatches(rule, interval, anchor, timeZone, y, m, d)) {
      for (const t of times) {
        const candidate = zonedPartsToUtc(
          { year: y, month: m, day: d, hour: t.hour, minute: t.minute, second: 0 },
          timeZone,
        );
        const ms = candidate.getTime();
        if (ms <= from) continue;
        if (ms > untilMs) return null;
        const key = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        if (exceptions.has(key)) break; // whole day was excluded
        return candidate;
      }
    }
    dayUtc += DAY;
  }
  return null;
}

function dayMatches(
  rule: Recurrence,
  interval: number,
  anchor: Date,
  timeZone: string,
  year: number,
  month: number,
  day: number,
): boolean {
  const anchorParts = toZonedParts(anchor, timeZone);
  const anchorDayUtc = Date.UTC(anchorParts.year, anchorParts.month - 1, anchorParts.day);
  const dayUtc = Date.UTC(year, month - 1, day);
  if (dayUtc < anchorDayUtc) return false;

  switch (rule.freq) {
    case 'daily': {
      const diffDays = Math.round((dayUtc - anchorDayUtc) / DAY);
      return diffDays % interval === 0;
    }
    case 'weekly': {
      const weekdays = rule.byWeekday?.length
        ? rule.byWeekday
        : [zonedWeekday(anchor, timeZone)];
      const weekday = new Date(dayUtc).getUTCDay();
      if (!weekdays.includes(weekday)) return false;
      // Compare ISO-ish week indexes so "every 2 weeks" stays in phase.
      const weekIndex = Math.floor(dayUtc / (7 * DAY));
      const anchorWeekIndex = Math.floor(anchorDayUtc / (7 * DAY));
      return (weekIndex - anchorWeekIndex) % interval === 0;
    }
    case 'monthly': {
      const monthsApart = (year - anchorParts.year) * 12 + (month - anchorParts.month);
      if (monthsApart < 0 || monthsApart % interval !== 0) return false;
      return monthDayMatches(rule.byMonthDay ?? [anchorParts.day], year, month, day);
    }
    case 'yearly': {
      const yearsApart = year - anchorParts.year;
      if (yearsApart < 0 || yearsApart % interval !== 0) return false;
      const months = rule.byMonth?.length ? rule.byMonth : [anchorParts.month];
      if (!months.includes(month)) return false;
      return monthDayMatches(rule.byMonthDay ?? [anchorParts.day], year, month, day);
    }
    default:
      return false;
  }
}

function monthDayMatches(wanted: number[], year: number, month: number, day: number): boolean {
  const last = daysInMonth(year, month);
  for (const w of wanted) {
    if (w === -1) {
      if (day === last) return true;
    } else if (w === day) {
      return true;
    } else if (w > last && day === last) {
      // "the 31st" in a 30-day month clamps to the last day rather than skipping.
      return true;
    }
  }
  return false;
}

/** Expand up to `limit` occurrences in `[from, to]` — used by agenda/forecast views. */
export function expandOccurrences(
  rule: Recurrence,
  anchor: Date,
  from: Date,
  to: Date,
  timeZone: string,
  limit = 200,
): Date[] {
  const out: Date[] = [];
  let cursor = new Date(Math.max(from.getTime(), anchor.getTime()) - 1);
  if (anchor >= from && anchor <= to) out.push(anchor);
  let guard = 0;
  while (out.length < limit && guard++ < limit * 4) {
    const next = nextOccurrence(rule, anchor, cursor, timeZone, out.length);
    if (!next || next > to) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

/** Compact, language-neutral summary the client turns into localized text. */
export function describeRecurrence(rule: Recurrence): {
  freq: string;
  interval: number;
  byWeekday?: number[];
  byMonthDay?: number[];
  times?: string[];
} {
  return {
    freq: rule.freq,
    interval: rule.interval ?? 1,
    byWeekday: rule.byWeekday,
    byMonthDay: rule.byMonthDay,
    times: rule.at?.map((t) => `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`),
  };
}
