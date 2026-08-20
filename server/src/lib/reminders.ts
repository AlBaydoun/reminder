import { db, nowIso, parseJson } from '../db.js';
import { nextOccurrence, type Recurrence } from './recurrence.js';

export interface ReminderRow {
  id: string;
  user_id: string;
  item_id: string;
  label: string;
  fire_at: string;
  next_fire_at: string | null;
  rrule: string | null;
  sound_id: string | null;
  volume: number;
  vibrate: number;
  lead_minutes: string;
  snooze_minutes: number;
  snoozed_until: string | null;
  escalate: number;
  ring_seconds: number;
  status: string;
  last_fired_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface Reminder {
  id: string;
  itemId: string;
  label: string;
  fireAt: string;
  nextFireAt: string | null;
  rrule: Recurrence | null;
  soundId: string | null;
  volume: number;
  vibrate: boolean;
  leadMinutes: number[];
  snoozeMinutes: number;
  snoozedUntil: string | null;
  escalate: boolean;
  ringSeconds: number;
  status: 'scheduled' | 'snoozed' | 'fired' | 'dismissed' | 'done';
  lastFiredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function serializeReminder(row: ReminderRow): Reminder {
  return {
    id: row.id,
    itemId: row.item_id,
    label: row.label,
    fireAt: row.fire_at,
    nextFireAt: row.next_fire_at,
    rrule: row.rrule ? parseJson<Recurrence | null>(row.rrule, null) : null,
    soundId: row.sound_id,
    volume: row.volume,
    vibrate: row.vibrate === 1,
    leadMinutes: parseJson<number[]>(row.lead_minutes, []),
    snoozeMinutes: row.snooze_minutes,
    snoozedUntil: row.snoozed_until,
    escalate: row.escalate === 1,
    ringSeconds: row.ring_seconds,
    status: row.status as Reminder['status'],
    lastFiredAt: row.last_fired_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function userTimezone(userId: string): string {
  const row = db.prepare(`SELECT timezone FROM users WHERE id = ?`).get(userId) as
    | { timezone: string }
    | undefined;
  return row?.timezone || 'UTC';
}

/**
 * The single source of truth for "when does this ring next".
 *
 * Order matters: an active snooze always wins, then a not-yet-passed first
 * occurrence, then the repeat rule rolled forward past `now`. A one-shot
 * reminder whose time has passed and which was never acknowledged stays
 * pending so it still rings when the user opens the app again — a missed
 * alarm that silently disappears is the worst possible failure for this app.
 */
export function computeNextFire(row: ReminderRow, timeZone: string, now = new Date()): string | null {
  if (row.status === 'done' || row.deleted_at) return null;

  if (row.snoozed_until && new Date(row.snoozed_until) > now) return row.snoozed_until;

  const first = new Date(row.fire_at);
  const rule = row.rrule ? parseJson<Recurrence | null>(row.rrule, null) : null;

  if (!rule) {
    if (row.status === 'dismissed') return null;
    // Either still in the future, or overdue and unacknowledged — ring either way.
    return row.last_fired_at ? null : row.fire_at;
  }

  if (first > now) return row.fire_at;
  const next = nextOccurrence(rule, first, now, timeZone);
  return next ? next.toISOString() : null;
}

export function refreshReminder(reminderId: string, now = new Date()): void {
  const row = db.prepare(`SELECT * FROM reminders WHERE id = ?`).get(reminderId) as
    | ReminderRow
    | undefined;
  if (!row) return;
  const next = computeNextFire(row, userTimezone(row.user_id), now);
  db.prepare(`UPDATE reminders SET next_fire_at = ?, updated_at = ? WHERE id = ?`).run(
    next,
    nowIso(),
    reminderId,
  );
}

export function rescheduleForItem(userId: string, itemId: string, now = new Date()): void {
  const rows = db
    .prepare(`SELECT id FROM reminders WHERE user_id = ? AND item_id = ? AND deleted_at IS NULL`)
    .all(userId, itemId) as Array<{ id: string }>;
  for (const r of rows) refreshReminder(r.id, now);
}

/** Recompute every pending reminder for a user — cheap, and keeps clocks honest. */
export function rescheduleAll(userId: string, now = new Date()): number {
  const rows = db
    .prepare(`SELECT * FROM reminders WHERE user_id = ? AND deleted_at IS NULL AND status != 'done'`)
    .all(userId) as ReminderRow[];
  const tz = userTimezone(userId);
  const stmt = db.prepare(`UPDATE reminders SET next_fire_at = ?, updated_at = ? WHERE id = ?`);
  const ts = nowIso();
  db.transaction(() => {
    for (const row of rows) stmt.run(computeNextFire(row, tz, now), ts, row.id);
  })();
  return rows.length;
}

/**
 * Reminders that should be ringing right now (or within `lookaheadMs`),
 * joined with enough of the item for the client to render the alarm screen
 * without a second round trip.
 */
export function dueReminders(userId: string, lookaheadMs = 0, now = new Date()) {
  const horizon = new Date(now.getTime() + lookaheadMs).toISOString();
  const rows = db
    .prepare(
      `SELECT r.*, i.title AS item_title, i.icon AS item_icon, i.color AS item_color, i.status AS item_status
       FROM reminders r
       JOIN items i ON i.id = r.item_id
       WHERE r.user_id = ?
         AND r.deleted_at IS NULL
         AND i.deleted_at IS NULL
         AND r.status != 'done'
         AND r.next_fire_at IS NOT NULL
         AND r.next_fire_at <= ?
       ORDER BY r.next_fire_at ASC`,
    )
    .all(userId, horizon) as Array<ReminderRow & Record<string, any>>;

  return rows.map((row) => ({
    ...serializeReminder(row),
    item: {
      id: row.item_id,
      title: row.item_title,
      icon: row.item_icon,
      color: row.item_color,
      status: row.item_status,
    },
  }));
}

/** Upcoming reminders in a window — powers the agenda and the alarm pre-arming. */
export function upcomingReminders(userId: string, windowMs: number, now = new Date()) {
  return dueReminders(userId, windowMs, now).filter(
    (r) => r.nextFireAt && new Date(r.nextFireAt) > now,
  );
}
