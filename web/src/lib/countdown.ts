import type { Dictionary } from '../i18n/en';

/**
 * Turning "when is this due" into something you can act on at a glance.
 *
 * The unit shown shrinks as the deadline approaches — days, then hours, then
 * minutes, then seconds — so the number on screen is always the one that
 * matters. Once a task is late the clock counts *up*, because "3h overdue" is
 * information and a frozen "0:00" is not.
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How alarming this deadline is. Drives colour, nothing else. */
export type Urgency = 'overdue' | 'imminent' | 'soon' | 'today' | 'upcoming' | 'distant';

export interface CountdownParts {
  urgency: Urgency;
  /** The short form, e.g. "2d 4h", "12:05", "3h overdue". */
  text: string;
  /** True when the deadline has passed. */
  late: boolean;
  /** Milliseconds remaining; negative when late. */
  remaining: number;
}

export function urgencyOf(remaining: number): Urgency {
  if (remaining <= 0) return 'overdue';
  if (remaining < 15 * MINUTE) return 'imminent';
  if (remaining < 2 * HOUR) return 'soon';
  if (remaining < 12 * HOUR) return 'today';
  if (remaining < 3 * DAY) return 'upcoming';
  return 'distant';
}

const pad = (n: number) => String(n).padStart(2, '0');

export function formatCountdown(
  dueAt: string | number | Date,
  dict: Dictionary,
  now = Date.now(),
): CountdownParts | null {
  const target = new Date(dueAt).getTime();
  if (!Number.isFinite(target)) return null;

  const remaining = target - now;
  const late = remaining <= 0;
  const abs = Math.abs(remaining);
  const units = dict.countdown;

  let text: string;
  if (abs >= 2 * DAY) {
    const days = Math.floor(abs / DAY);
    const hours = Math.floor((abs % DAY) / HOUR);
    text = hours ? `${days}${units.day} ${hours}${units.hour}` : `${days}${units.day}`;
  } else if (abs >= HOUR) {
    const hours = Math.floor(abs / HOUR);
    const minutes = Math.floor((abs % HOUR) / MINUTE);
    text = minutes ? `${hours}${units.hour} ${minutes}${units.minute}` : `${hours}${units.hour}`;
  } else if (abs >= MINUTE) {
    // Under an hour the seconds matter, so show a real clock.
    const minutes = Math.floor(abs / MINUTE);
    const seconds = Math.floor((abs % MINUTE) / SECOND);
    text = `${minutes}:${pad(seconds)}`;
  } else {
    text = `${Math.max(0, Math.floor(abs / SECOND))}${units.second}`;
  }

  return {
    urgency: urgencyOf(remaining),
    text: late ? units.overdueBy.replace('{time}', text) : text,
    late,
    remaining,
  };
}

/** Longer phrasing for screen readers and tooltips. */
export function describeCountdown(
  dueAt: string | number | Date,
  dict: Dictionary,
  now = Date.now(),
): string {
  const parts = formatCountdown(dueAt, dict, now);
  if (!parts) return '';
  return parts.late
    ? parts.text
    : dict.countdown.remaining.replace('{time}', parts.text);
}
