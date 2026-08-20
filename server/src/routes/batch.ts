import { Router } from 'express';
import { z } from 'zod';
import { db, newId, nowIso } from '../db.js';
import { currentUser, requireAuth } from '../auth.js';
import { badRequest, notFound, route } from '../lib/http.js';
import { getItemRow, logActivity, resolvePath, serializeItem } from '../lib/items.js';
import { recurrenceSchema } from '../lib/recurrence.js';
import { refreshReminder, serializeReminder } from '../lib/reminders.js';
import { similarity } from '../lib/reasoning.js';
import { completeItem, insertItem } from './items.js';

export const batchRouter = Router();
batchRouter.use(requireAuth);

/**
 * One utterance can carry several instructions ("add oil change under cars,
 * remind me tomorrow at 8, and add cleaning"). The voice layer turns that into
 * an ordered op list and posts it here so the whole thing lands atomically —
 * a half-applied voice command is worse than one that clearly failed.
 */

const targetRef = z.object({
  /** Exact id when the client already knows it. */
  id: z.string().uuid().optional(),
  /** Spoken title, resolved by fuzzy match. */
  query: z.string().trim().max(300).optional(),
  /** Refer to the item created earlier in this same batch. */
  useLast: z.boolean().optional(),
});

const opSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('create_item'),
    title: z.string().trim().min(1).max(500),
    notes: z.string().max(20_000).optional(),
    icon: z.string().max(16).optional(),
    color: z.string().max(32).optional(),
    parentId: z.string().uuid().nullable().optional(),
    parentPath: z.array(z.string()).max(8).optional(),
    createMissingPath: z.boolean().optional(),
    dueAt: z.string().datetime().nullable().optional(),
    priority: z.number().int().min(0).max(4).optional(),
    energy: z.number().int().min(1).max(5).optional(),
    effortMinutes: z.number().int().min(0).max(100_000).optional(),
    recurrence: recurrenceSchema.nullable().optional(),
    tags: z.array(z.string().max(40)).max(30).optional(),
    pinned: z.boolean().optional(),
  }),
  z.object({ op: z.literal('complete_item'), target: targetRef, done: z.boolean().default(true), cascade: z.boolean().default(false) }),
  z.object({ op: z.literal('delete_item'), target: targetRef }),
  z.object({
    op: z.literal('update_item'),
    target: targetRef,
    title: z.string().trim().min(1).max(500).optional(),
    notes: z.string().max(20_000).optional(),
    dueAt: z.string().datetime().nullable().optional(),
    priority: z.number().int().min(0).max(4).optional(),
    pinned: z.boolean().optional(),
    tags: z.array(z.string().max(40)).max(30).optional(),
    icon: z.string().max(16).optional(),
    color: z.string().max(32).optional(),
  }),
  z.object({ op: z.literal('move_item'), target: targetRef, parentPath: z.array(z.string()).max(8).optional(), parentId: z.string().uuid().nullable().optional(), createMissingPath: z.boolean().optional() }),
  z.object({
    op: z.literal('create_reminder'),
    target: targetRef,
    fireAt: z.string().datetime(),
    label: z.string().max(300).optional(),
    rrule: recurrenceSchema.nullable().optional(),
    soundId: z.string().max(120).nullable().optional(),
    escalate: z.boolean().optional(),
    leadMinutes: z.array(z.number().int().min(0).max(20_160)).max(8).optional(),
  }),
]);

type Op = z.infer<typeof opSchema>;
type Inverse = { op: string; [k: string]: unknown };

function resolveTarget(userId: string, ref: z.infer<typeof targetRef>, last: string | null): string {
  if (ref.useLast) {
    if (!last) throw badRequest('Nothing was created earlier in this command to refer back to');
    return last;
  }
  if (ref.id) return getItemRow(userId, ref.id).id;
  const query = ref.query?.trim();
  if (!query) throw badRequest('No item was named');

  const rows = db
    .prepare(`SELECT id, title FROM items WHERE user_id = ? AND deleted_at IS NULL`)
    .all(userId) as Array<{ id: string; title: string }>;

  const needle = query.toLowerCase();
  const exact = rows.find((r) => r.title.toLowerCase() === needle);
  if (exact) return exact.id;

  const contains = rows.filter((r) => r.title.toLowerCase().includes(needle));
  if (contains.length === 1) return contains[0].id;

  let best: { id: string; score: number } | null = null;
  for (const r of rows) {
    const score = similarity(r.title, query);
    if (!best || score > best.score) best = { id: r.id, score };
  }
  if (best && best.score >= 0.4) return best.id;
  throw notFound(`Could not find anything called "${query}"`);
}

function resolveParentForOp(
  userId: string,
  parentId: string | null | undefined,
  parentPath: string[] | undefined,
  createMissing: boolean | undefined,
): string | null {
  if (parentId !== undefined) return parentId;
  if (!parentPath?.length) return null;
  const segments = parentPath.map((s) => s.trim()).filter(Boolean);
  const found = resolvePath(userId, segments);
  if (found) return found;
  if (!createMissing) throw notFound(`No category matching "${segments.join(' / ')}"`);

  let cursor: string | null = null;
  for (const segment of segments) {
    const child = db
      .prepare(
        cursor === null
          ? `SELECT id FROM items WHERE user_id = ? AND parent_id IS NULL AND deleted_at IS NULL AND lower(title) = lower(?)`
          : `SELECT id FROM items WHERE user_id = ? AND parent_id = ? AND deleted_at IS NULL AND lower(title) = lower(?)`,
      )
      .get(...(cursor === null ? [userId, segment] : [userId, cursor, segment])) as { id: string } | undefined;
    cursor = child?.id ?? insertItem(userId, { title: segment, parentId: cursor });
  }
  return cursor;
}

batchRouter.post(
  '/',
  route((req, res) => {
    const user = currentUser(req);
    const body = z
      .object({ ops: z.array(opSchema).min(1).max(40), transcript: z.string().max(2000).optional() })
      .parse(req.body);

    const results: unknown[] = [];
    const inverse: Inverse[] = [];
    let lastItemId: string | null = null;

    const run = db.transaction(() => {
      for (const op of body.ops) {
        switch (op.op) {
          case 'create_item': {
            const parentId = resolveParentForOp(user.id, op.parentId, op.parentPath, op.createMissingPath);
            const id = insertItem(user.id, { ...op, parentId });
            lastItemId = id;
            inverse.unshift({ op: 'hard_delete_item', id });
            results.push({ op: op.op, item: serializeItem(getItemRow(user.id, id)) });
            break;
          }
          case 'complete_item': {
            const id = resolveTarget(user.id, op.target, lastItemId);
            const before = getItemRow(user.id, id);
            const result = completeItem(user.id, before, op.done, op.cascade);
            lastItemId = id;
            inverse.unshift({ op: 'restore_status', id, status: before.status, dueAt: before.due_at, completedAt: before.completed_at });
            results.push({ op: op.op, ...result });
            break;
          }
          case 'delete_item': {
            const id = resolveTarget(user.id, op.target, lastItemId);
            const ts = nowIso();
            db.prepare(`UPDATE items SET deleted_at = ?, updated_at = ? WHERE id = ? AND user_id = ?`)
              .run(ts, ts, id, user.id);
            inverse.unshift({ op: 'undelete_item', id });
            results.push({ op: op.op, id });
            break;
          }
          case 'update_item': {
            const id = resolveTarget(user.id, op.target, lastItemId);
            const before = getItemRow(user.id, id);
            lastItemId = id;
            db.prepare(
              `UPDATE items SET title = ?, notes = ?, due_at = ?, priority = ?, pinned = ?,
                                tags = ?, icon = ?, color = ?, updated_at = ?
               WHERE id = ? AND user_id = ?`,
            ).run(
              op.title ?? before.title,
              op.notes ?? before.notes,
              op.dueAt !== undefined ? op.dueAt : before.due_at,
              op.priority ?? before.priority,
              op.pinned === undefined ? before.pinned : op.pinned ? 1 : 0,
              op.tags ? JSON.stringify(op.tags) : before.tags,
              op.icon ?? before.icon,
              op.color ?? before.color,
              nowIso(),
              id,
              user.id,
            );
            inverse.unshift({
              op: 'restore_fields',
              id,
              fields: {
                title: before.title,
                notes: before.notes,
                due_at: before.due_at,
                priority: before.priority,
                pinned: before.pinned,
                tags: before.tags,
                icon: before.icon,
                color: before.color,
              },
            });
            results.push({ op: op.op, item: serializeItem(getItemRow(user.id, id)) });
            break;
          }
          case 'move_item': {
            const id = resolveTarget(user.id, op.target, lastItemId);
            const before = getItemRow(user.id, id);
            const parentId = resolveParentForOp(user.id, op.parentId, op.parentPath, op.createMissingPath);
            if (parentId === id) throw badRequest('An item cannot be moved into itself');
            db.prepare(`UPDATE items SET parent_id = ?, updated_at = ? WHERE id = ? AND user_id = ?`)
              .run(parentId, nowIso(), id, user.id);
            lastItemId = id;
            inverse.unshift({ op: 'restore_parent', id, parentId: before.parent_id });
            results.push({ op: op.op, item: serializeItem(getItemRow(user.id, id)) });
            break;
          }
          case 'create_reminder': {
            const itemId = resolveTarget(user.id, op.target, lastItemId);
            const id = newId();
            const ts = nowIso();
            db.prepare(
              `INSERT INTO reminders (id, user_id, item_id, label, fire_at, next_fire_at, rrule, sound_id,
                                      volume, vibrate, lead_minutes, snooze_minutes, escalate, ring_seconds,
                                      status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0.9, 1, ?, 9, ?, 60, 'scheduled', ?, ?)`,
            ).run(
              id,
              user.id,
              itemId,
              op.label ?? '',
              op.fireAt,
              op.fireAt,
              op.rrule ? JSON.stringify(op.rrule) : null,
              op.soundId ?? null,
              JSON.stringify(op.leadMinutes ?? []),
              op.escalate ? 1 : 0,
              ts,
              ts,
            );
            refreshReminder(id);
            lastItemId = itemId;
            inverse.unshift({ op: 'hard_delete_reminder', id });
            const row = db.prepare(`SELECT * FROM reminders WHERE id = ?`).get(id) as any;
            results.push({ op: op.op, reminder: serializeReminder(row) });
            break;
          }
        }
      }
    });

    run();

    const undoId = newId();
    db.prepare(
      `INSERT INTO activity (id, user_id, kind, item_id, payload, created_at) VALUES (?, ?, 'batch', NULL, ?, ?)`,
    ).run(undoId, user.id, JSON.stringify({ inverse, transcript: body.transcript ?? '' }), nowIso());

    res.json({ results, undoId, applied: body.ops.length });
  }),
);

/** Undo a whole voice command in one step. */
batchRouter.post(
  '/undo/:undoId',
  route((req, res) => {
    const user = currentUser(req);
    const row = db
      .prepare(`SELECT payload FROM activity WHERE id = ? AND user_id = ? AND kind = 'batch'`)
      .get(req.params.undoId, user.id) as { payload: string } | undefined;
    if (!row) throw notFound('Nothing to undo');

    const { inverse } = JSON.parse(row.payload) as { inverse: Inverse[] };
    const ts = nowIso();

    db.transaction(() => {
      for (const step of inverse) {
        switch (step.op) {
          case 'hard_delete_item':
            db.prepare(`DELETE FROM items WHERE id = ? AND user_id = ?`).run(step.id, user.id);
            break;
          case 'hard_delete_reminder':
            db.prepare(`DELETE FROM reminders WHERE id = ? AND user_id = ?`).run(step.id, user.id);
            break;
          case 'undelete_item':
            db.prepare(`UPDATE items SET deleted_at = NULL, updated_at = ? WHERE id = ? AND user_id = ?`)
              .run(ts, step.id, user.id);
            break;
          case 'restore_status':
            db.prepare(`UPDATE items SET status = ?, due_at = ?, completed_at = ?, updated_at = ? WHERE id = ? AND user_id = ?`)
              .run(step.status, step.dueAt ?? null, step.completedAt ?? null, ts, step.id, user.id);
            break;
          case 'restore_parent':
            db.prepare(`UPDATE items SET parent_id = ?, updated_at = ? WHERE id = ? AND user_id = ?`)
              .run(step.parentId ?? null, ts, step.id, user.id);
            break;
          case 'restore_fields': {
            const f = step.fields as Record<string, any>;
            db.prepare(
              `UPDATE items SET title = ?, notes = ?, due_at = ?, priority = ?, pinned = ?, tags = ?,
                                icon = ?, color = ?, updated_at = ?
               WHERE id = ? AND user_id = ?`,
            ).run(f.title, f.notes, f.due_at, f.priority, f.pinned, f.tags, f.icon, f.color, ts, step.id, user.id);
            break;
          }
        }
      }
      db.prepare(`DELETE FROM activity WHERE id = ?`).run(req.params.undoId);
    })();

    logActivity(user.id, 'batch.undone', null, { steps: inverse.length });
    res.json({ ok: true, reverted: inverse.length });
  }),
);
