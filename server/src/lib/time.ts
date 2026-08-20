/**
 * Timezone helpers built on Intl so the server can schedule "every weekday at
 * 07:30 in Asia/Beirut" correctly across DST changes without a date library.
 */

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  second: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, fmt);
  }
  return fmt;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    formatterFor(tz).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock fields of `date` as seen in `timeZone`. */
export function toZonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(date);
  const pick = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const hour = pick('hour');
  return {
    year: pick('year'),
    month: pick('month'),
    day: pick('day'),
    hour: hour === 24 ? 0 : hour, // some ICU builds report midnight as 24
    minute: pick('minute'),
    second: pick('second'),
  };
}

/** Milliseconds to add to a UTC instant to get that zone's wall clock. */
export function zoneOffsetMs(date: Date, timeZone: string): number {
  const p = toZonedParts(date, timeZone);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // Round to the second: Date.UTC drops the ms that the original instant had.
  return asIfUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/**
 * Turn wall-clock fields in `timeZone` into the matching UTC instant.
 * Two passes settle the chicken-and-egg between the offset and the instant,
 * which is what makes DST transitions land on the right side.
 */
export function zonedPartsToUtc(parts: ZonedParts, timeZone: string): Date {
  const naive = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  let guess = naive - zoneOffsetMs(new Date(naive), timeZone);
  guess = naive - zoneOffsetMs(new Date(guess), timeZone);
  return new Date(guess);
}

/** Day of week in the given zone. 0 = Sunday. */
export function zonedWeekday(date: Date, timeZone: string): number {
  const p = toZonedParts(date, timeZone);
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
}

/** YYYY-MM-DD as seen in the zone — the key used for "same day" grouping. */
export function zonedDateKey(date: Date, timeZone: string): string {
  const p = toZonedParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;
