import { Router } from 'express';
import { z } from 'zod';
import { db, newId, nowIso } from '../db.js';
import { currentUser, requireAuth } from '../auth.js';
import { notFound, route } from '../lib/http.js';
import { getItemRow, logActivity } from '../lib/items.js';
import { recurrenceSchema } from '../lib/recurrence.js';
import {
  dueReminders,
  refreshReminder,
  rescheduleAll,
  serializeReminder,
  upcomingReminders,
  type ReminderRow,
} from '../lib/reminders.js';

export const remindersRouter = Router();
remindersRouter.use(requireAuth);

const reminderInput = z.object({
  itemId: z.string().uuid(),
  label: z.string().trim().max(300).optional(),
  fireAt: z.string().datetime(),
  rrule: recurrenceSchema.nullable().optional(),
  soundId: z.string().max(120).nullable().optional(),
  volume: z.number().min(0).max(1).optional(),
  vibrate: z.boolean().optional(),
  /** Extra "heads up" alerts N minutes before the main one. */
  leadMinutes: z.array(z.number().int().min(0).max(20_160)).max(8).optional(),
  snoozeMinutes: z.number().int().min(1).max(1440).optional(),
  /** Keep re-ringing until explicitly dismissed. */
  escalate: z.boolean().optional(),
  ringSeconds: z.number().int().min(5).max(900).optional(),
});

function getReminderRow(userId: string, id: string): ReminderRow {
  const row = db.prepare(`SELECT * FROM reminders WHERE id = ? AND user_id = ?`).get(id, userId) as
    | ReminderRow
    | undefined;
  if (!row || row.deleted_at) throw notFound('Reminder not found');
  return row;
}

remindersRouter.get(
  '/',
  route((req, res) => {
    const user = currentUser(req);
    const rows = db
      .prepare(
        `SELECT * FROM reminders WHERE user_id = ? AND deleted_at IS NULL ORDER BY next_fire_at ASC`,
      )
      .all(user.id) as ReminderRow[];
    res.json({ reminders: rows.map(serializeReminder) });
  }),
);

/** Everything that should be ringing right now. Polled by the alarm engine. */
remindersRouter.get(
  '/due',
  route((req, res) => {
    const user = currentUser(req);
    const lookahead = Math.min(Number(req.query.lookaheadMs ?? 0) || 0, 86_400_000);
    res.json({ due: dueReminders(user.id, lookahead), serverTime: nowIso() });
  }),
);

/** The next N hours, so the client can pre-arm precise in-page timers. */
remindersRouter.get(
  '/upcoming',
  route((req, res) => {
    const user = currentUser(req);
    const hours = Math.min(Number(req.query.hours ?? 24) || 24, 24 * 30);
    res.json({
      upcoming: upcomingReminders(user.id, hours * 3_600_000),
      serverTime: nowIso(),
    });
  }),
);

remindersRouter.post(
  '/',
  route((req, res) => {
    const user = currentUser(req);
    const input = reminderInput.parse(req.body);
    getItemRow(user.id, input.itemId);

    const id = newId();
    const ts = nowIso();
    db.prepare(
      `INSERT INTO reminders (id, user_id, item_id, label, fire_at, next_fire_at, rrule, sound_id,
                              volume, vibrate, lead_minutes, snooze_minutes, escalate, ring_seconds,
                              status, created_at, updated_at)
       VALUES (@id, @user_id, @item_id, @label, @fire_at, @fire_at, @rrule, @sound_id,
               @volume, @vibrate, @lead_minutes, @snooze_minutes, @escalate, @ring_seconds,
               'scheduled', @ts, @ts)`,
    ).run({
      id,
      user_id: user.id,
      item_id: input.itemId,
      label: input.label ?? '',
      fire_at: input.fireAt,
      rrule: input.rrule ? JSON.stringify(input.rrule) : null,
      sound_id: input.soundId ?? null,
      volume: input.volume ?? 0.9,
      vibrate: input.vibrate === false ? 0 : 1,
      lead_minutes: JSON.stringify(input.leadMinutes ?? []),
      snooze_minutes: input.snoozeMinutes ?? 9,
      escalate: input.escalate ? 1 : 0,
      ring_seconds: input.ringSeconds ?? 60,
      ts,
    });
    refreshReminder(id);
    logActivity(user.id, 'reminder.created', input.itemId, { reminderId: id, fireAt: input.fireAt });
    res.status(201).json({ reminder: serializeReminder(getReminderRow(user.id, id)) });
  }),
);

remindersRouter.patch(
  '/:id',
  route((req, res) => {
    const user = currentUser(req);
    const patch = reminderInput.partial().omit({ itemId: true }).parse(req.body);
    const row = getReminderRow(user.id, req.params.id);
    const ts = nowIso();

    db.prepare(
      `UPDATE reminders SET label = @label, fire_at = @fire_at, rrule = @rrule, sound_id = @sound_id,
              volume = @volume, vibrate = @vibrate, lead_minutes = @lead_minutes,
              snooze_minutes = @snooze_minutes, escalate = @escalate, ring_seconds = @ring_seconds,
              status = @status, snoozed_until = @snoozed_until, last_fired_at = @last_fired_at,
              updated_at = @ts
       WHERE id = @id AND user_id = @user_id`,
    ).run({
      id: row.id,
      user_id: user.id,
      label: patch.label ?? row.label,
      fire_at: patch.fireAt ?? row.fire_at,
      rrule:
        patch.rrule !== undefined ? (patch.rrule ? JSON.stringify(patch.rrule) : null) : row.rrule,
      sound_id: patch.soundId !== undefined ? patch.soundId : row.sound_id,
      volume: patch.volume ?? row.volume,
      vibrate: patch.vibrate === undefined ? row.vibrate : patch.vibrate ? 1 : 0,
      lead_minutes: patch.leadMinutes ? JSON.stringify(patch.leadMinutes) : row.lead_minutes,
      snooze_minutes: patch.snoozeMinutes ?? row.snooze_minutes,
      escalate: patch.escalate === undefined ? row.escalate : patch.escalate ? 1 : 0,
      ring_seconds: patch.ringSeconds ?? row.ring_seconds,
      // Changing the time re-arms a reminder that had already gone off.
      status: patch.fireAt ? 'scheduled' : row.status,
      snoozed_until: patch.fireAt ? null : row.snoozed_until,
      last_fired_at: patch.fireAt ? null : row.last_fired_at,
      ts,
    });
    refreshReminder(row.id);
    res.json({ reminder: serializeReminder(getReminderRow(user.id, row.id)) });
  }),
);

/** The alarm rang. Record it and roll a repeating reminder to its next slot. */
remindersRouter.post(
  '/:id/fired',
  route((req, res) => {
    const user = currentUser(req);
    const row = getReminderRow(user.id, req.params.id);
    const ts = nowIso();
    db.prepare(
      `UPDATE reminders SET last_fired_at = ?, status = 'fired', snoozed_until = NULL, updated_at = ?
       WHERE id = ? AND user_id = ?`,
    ).run(ts, ts, row.id, user.id);
    refreshReminder(row.id);
    logActivity(user.id, 'reminder.fired', row.item_id, { reminderId: row.id });
    res.json({ reminder: serializeReminder(getReminderRow(user.id, row.id)) });
  }),
);

remindersRouter.post(
  '/:id/snooze',
  route((req, res) => {
    const user = currentUser(req);
    const body = z.object({ minutes: z.number().int().min(1).max(1440).optional() }).parse(req.body ?? {});
    const row = getReminderRow(user.id, req.params.id);
    const minutes = body.minutes ?? row.snooze_minutes;
    const until = new Date(Date.now() + minutes * 60_000).toISOString();
    const ts = nowIso();
    db.prepare(
      `UPDATE reminders SET snoozed_until = ?, status = 'snoozed', updated_at = ? WHERE id = ? AND user_id = ?`,
    ).run(until, ts, row.id, user.id);
    refreshReminder(row.id);
    logActivity(user.id, 'reminder.snoozed', row.item_id, { reminderId: row.id, minutes });
    res.json({ reminder: serializeReminder(getReminderRow(user.id, row.id)), snoozedUntil: until });
  }),
);

remindersRouter.post(
  '/:id/dismiss',
  route((req, res) => {
    const user = currentUser(req);
    const row = getReminderRow(user.id, req.params.id);
    const ts = nowIso();
    // A repeating reminder is only dismissed for this occurrence; a one-shot is finished.
    db.prepare(
      `UPDATE reminders SET status = ?, snoozed_until = NULL, last_fired_at = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`,
    ).run(row.rrule ? 'scheduled' : 'dismissed', ts, ts, row.id, user.id);
    refreshReminder(row.id);
    logActivity(user.id, 'reminder.dismissed', row.item_id, { reminderId: row.id });
    res.json({ reminder: serializeReminder(getReminderRow(user.id, row.id)) });
  }),
);

remindersRouter.delete(
  '/:id',
  route((req, res) => {
    const user = currentUser(req);
    const row = getReminderRow(user.id, req.params.id);
    const ts = nowIso();
    db.prepare(`UPDATE reminders SET deleted_at = ?, updated_at = ? WHERE id = ? AND user_id = ?`)
      .run(ts, ts, row.id, user.id);
    res.json({ ok: true });
  }),
);

/** Called after a timezone change or a long offline stretch. */
remindersRouter.post(
  '/resync',
  route((req, res) => {
    const user = currentUser(req);
    const count = rescheduleAll(user.id);
    res.json({ ok: true, rescheduled: count, serverTime: nowIso() });
  }),
);
