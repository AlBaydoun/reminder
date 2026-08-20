import { intlTag } from '../i18n';
import type { Dictionary } from '../i18n/en';
import type { Locale, Recurrence } from './types';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const cache = new Map<string, Intl.DateTimeFormat>();
function formatter(locale: Locale, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}:${JSON.stringify(options)}`;
  let fmt = cache.get(key);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(intlTag(locale), options);
    cache.set(key, fmt);
  }
  return fmt;
}

export const formatTime = (date: Date | string, locale: Locale) =>
  formatter(locale, { hour: '2-digit', minute: '2-digit' }).format(new Date(date));

export const formatDate = (date: Date | string, locale: Locale) =>
  formatter(locale, { day: 'numeric', month: 'short' }).format(new Date(date));

export const formatDateLong = (date: Date | string, locale: Locale) =>
  formatter(locale, { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(date));

export const formatDateTime = (date: Date | string, locale: Locale) =>
  formatter(locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(
    new Date(date),
  );

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** "Today 14:30", "Tomorrow 09:00", "Mon 12 Aug" — whichever a person would say. */
export function formatWhen(
  value: Date | string | null | undefined,
  locale: Locale,
  dict: Dictionary,
  now = new Date(),
): string {
  if (!value) return dict.item.noDue;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return dict.item.noDue;

  const tomorrow = new Date(now.getTime() + DAY);
  const yesterday = new Date(now.getTime() - DAY);
  const time = formatTime(date, locale);

  if (sameDay(date, now)) return `${dict.common.today} ${time}`;
  if (sameDay(date, tomorrow)) return `${dict.common.tomorrow} ${time}`;
  if (sameDay(date, yesterday)) return `${dict.common.yesterday} ${time}`;

  const withinWeek = Math.abs(date.getTime() - now.getTime()) < 6 * DAY;
  if (withinWeek) {
    const weekday = formatter(locale, { weekday: 'short' }).format(date);
    return `${weekday} ${time}`;
  }
  const sameYear = date.getFullYear() === now.getFullYear();
  return formatter(locale, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

/** "in 3 days" / "2 hours ago", using the platform's own relative-time rules. */
export function formatRelative(value: Date | string, locale: Locale, now = new Date()): string {
  const date = new Date(value);
  const diff = date.getTime() - now.getTime();
  const rtf = new Intl.RelativeTimeFormat(intlTag(locale), { numeric: 'auto' });
  const abs = Math.abs(diff);

  if (abs < MINUTE) return rtf.format(Math.round(diff / 1000), 'second');
  if (abs < HOUR) return rtf.format(Math.round(diff / MINUTE), 'minute');
  if (abs < DAY) return rtf.format(Math.round(diff / HOUR), 'hour');
  if (abs < 30 * DAY) return rtf.format(Math.round(diff / DAY), 'day');
  if (abs < 365 * DAY) return rtf.format(Math.round(diff / (30 * DAY)), 'month');
  return rtf.format(Math.round(diff / (365 * DAY)), 'year');
}

export function formatDuration(minutes: number, dict: Dictionary): string {
  if (minutes <= 0) return '—';
  if (minutes < 60) return dict.common.minutes.replace('{n}', String(minutes));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const hoursText = dict.common.hours.replace('{n}', String(hours));
  return rest ? `${hoursText} ${dict.common.minutes.replace('{n}', String(rest))}` : hoursText;
}

/** Turn a repeat rule into a sentence in the active language. */
export function describeRecurrence(
  rule: Recurrence | null | undefined,
  dict: Dictionary,
  locale: Locale,
): string {
  if (!rule) return dict.repeat.never;
  const interval = rule.interval ?? 1;

  const times = rule.at?.length
    ? dict.repeat.atTimes.replace(
        '{times}',
        rule.at
          .map((t) => `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`)
          .join(', '),
      )
    : '';

  const weekdayNames = (rule.byWeekday ?? []).map((day) => dict.weekday.short[day]).join(', ');
  const onDays = weekdayNames ? dict.repeat.onDays.replace('{days}', weekdayNames) : '';

  let base: string;
  if (rule.freq === 'weekly' && interval === 1) base = dict.repeat.weekly;
  else if (rule.freq === 'weekly' && interval === 2) base = dict.repeat.biweekly;
  else if (rule.freq === 'daily' && interval === 1) base = dict.repeat.daily;
  else if (rule.freq === 'monthly' && interval === 1) base = dict.repeat.monthly;
  else if (rule.freq === 'monthly' && interval === 3) base = dict.repeat.quarterly;
  else if (rule.freq === 'yearly' && interval === 1) base = dict.repeat.yearly;
  else {
    const unit =
      rule.freq === 'daily' || rule.freq === 'hourly' || rule.freq === 'minutely'
        ? dict.repeat.unitDay
        : rule.freq === 'weekly'
          ? dict.repeat.unitWeek
          : rule.freq === 'monthly'
            ? dict.repeat.unitMonth
            : dict.repeat.unitYear;
    base = dict.repeat.everyN.replace('{n}', String(interval)).replace('{unit}', unit);
  }

  const ending = rule.until
    ? dict.repeat.endsOn.replace('{date}', formatDate(rule.until, locale))
    : rule.count
      ? dict.repeat.endsAfter.replace('{n}', String(rule.count))
      : '';

  return [base, onDays, times, ending].filter(Boolean).join(' ');
}

export function isOverdue(item: { dueAt: string | null; status: string }, now = Date.now()): boolean {
  return item.status === 'open' && Boolean(item.dueAt) && new Date(item.dueAt!).getTime() < now;
}

export const PRIORITY_COLORS = ['var(--p0)', 'var(--p1)', 'var(--p2)', 'var(--p3)', 'var(--p4)'];

export function priorityLabel(priority: number, dict: Dictionary): string {
  return [dict.priority.p0, dict.priority.p1, dict.priority.p2, dict.priority.p3, dict.priority.p4][
    Math.max(0, Math.min(4, priority))
  ];
}

/** Local `datetime-local` input value from an ISO string, and back. */
export function toLocalInputValue(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function fromLocalInputValue(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
