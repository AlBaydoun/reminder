import { Router } from 'express';
import { z } from 'zod';
import { db, newId, nowIso } from '../db.js';
import { currentUser, requireAuth } from '../auth.js';
import { badRequest, notFound, route } from '../lib/http.js';
import {
  ancestorPath,
  assertNoCycle,
  childCounts,
  getItemRow,
  logActivity,
  nextPosition,
  resolvePath,
  serializeItem,
  subtreeIds,
  type ItemRow,
} from '../lib/items.js';
import { nextOccurrence, recurrenceSchema } from '../lib/recurrence.js';
import { rescheduleForItem } from '../lib/reminders.js';

export const itemsRouter = Router();
itemsRouter.use(requireAuth);

const itemInput = z.object({
  title: z.string().trim().min(1, 'Title is required').max(500),
  notes: z.string().max(20_000).optional(),
  icon: z.string().max(16).optional(),
  color: z.string().max(32).optional(),
  parentId: z.string().uuid().nullable().optional(),
  /** Alternative to parentId — a spoken path like ["cars", "corolla"]. */
  parentPath: z.array(z.string()).max(8).optional(),
  /** Create missing path segments instead of failing. Voice uses this. */
  createMissingPath: z.boolean().optional(),
  status: z.enum(['open', 'done', 'archived']).optional(),
  priority: z.number().int().min(0).max(4).optional(),
  energy: z.number().int().min(1).max(5).optional(),
  effortMinutes: z.number().int().min(0).max(100_000).optional(),
  dueAt: z.string().datetime().nullable().optional(),
  startAt: z.string().datetime().nullable().optional(),
  recurrence: recurrenceSchema.nullable().optional(),
  tags: z.array(z.string().trim().max(40)).max(30).optional(),
  blockedBy: z.array(z.string().uuid()).max(50).optional(),
  meta: z.record(z.unknown()).optional(),
  pinned: z.boolean().optional(),
  position: z.number().optional(),
  /** 'ink' renders this row as the handwriting it was written in. */
  displayMode: z.enum(['text', 'ink']).optional(),
  inkDrawingId: z.string().uuid().nullable().optional(),
});

type ItemInput = z.infer<typeof itemInput>;

/** Resolve `parentPath` to a real id, optionally creating the missing chain. */
function resolveParent(userId: string, input: ItemInput): string | null {
  if (input.parentId !== undefined) {
    if (input.parentId) getItemRow(userId, input.parentId); // existence + ownership check
    return input.parentId;
  }
  const segments = (input.parentPath ?? []).map((s) => s.trim()).filter(Boolean);
  if (!segments.length) return null;

  const found = resolvePath(userId, segments);
  if (found) return found;
  if (!input.createMissingPath) throw notFound(`No category matching "${segments.join(' / ')}"`);

  // Walk the path top-down, creating whichever segments do not exist yet.
  let parentId: string | null = null;
  for (const segment of segments) {
    parentId = findChildByTitle(userId, parentId, segment) ?? insertItem(userId, { title: segment, parentId });
  }
  return parentId;
}

function findChildByTitle(userId: string, parentId: string | null, title: string): string | null {
  const row = db
    .prepare(
      parentId === null
        ? `SELECT id FROM items WHERE user_id = ? AND parent_id IS NULL AND deleted_at IS NULL AND lower(title) = lower(?)`
        : `SELECT id FROM items WHERE user_id = ? AND parent_id = ? AND deleted_at IS NULL AND lower(title) = lower(?)`,
    )
    .get(...(parentId === null ? [userId, title] : [userId, parentId, title])) as
    | { id: string }
    | undefined;
  return row?.id ?? null;
}

export function insertItem(userId: string, input: ItemInput & { parentId?: string | null }): string {
  const id = newId();
  const ts = nowIso();
  const parentId = input.parentId ?? null;
  db.prepare(
    `INSERT INTO items (id, user_id, parent_id, title, notes, icon, color, status, priority, energy,
                        effort_minutes, due_at, start_at, recurrence, tags, blocked_by, meta,
                        position, pinned, display_mode, ink_drawing_id,
                        created_at, updated_at, completed_at)
     VALUES (@id, @user_id, @parent_id, @title, @notes, @icon, @color, @status, @priority, @energy,
             @effort_minutes, @due_at, @start_at, @recurrence, @tags, @blocked_by, @meta,
             @position, @pinned, @display_mode, @ink_drawing_id,
             @ts, @ts, @completed_at)`,
  ).run({
    id,
    user_id: userId,
    parent_id: parentId,
    title: input.title,
    notes: input.notes ?? '',
    icon: input.icon ?? '',
    color: input.color ?? '',
    status: input.status ?? 'open',
    priority: input.priority ?? 2,
    energy: input.energy ?? 3,
    effort_minutes: input.effortMinutes ?? 0,
    due_at: input.dueAt ?? null,
    start_at: input.startAt ?? null,
    recurrence: input.recurrence ? JSON.stringify(input.recurrence) : null,
    tags: JSON.stringify(input.tags ?? []),
    blocked_by: JSON.stringify(input.blockedBy ?? []),
    meta: JSON.stringify(input.meta ?? {}),
    position: input.position ?? nextPosition(userId, parentId),
    pinned: input.pinned ? 1 : 0,
    display_mode: input.displayMode ?? 'text',
    ink_drawing_id: input.inkDrawingId ?? null,
    ts,
    completed_at: input.status === 'done' ? ts : null,
  });
  logActivity(userId, 'item.created', id, { title: input.title });
  return id;
}

itemsRouter.get(
  '/',
  route((req, res) => {
    const user = currentUser(req);
    const includeDeleted = req.query.includeDeleted === 'true';
    const rows = db
      .prepare(
        includeDeleted
          ? `SELECT * FROM items WHERE user_id = ? ORDER BY position ASC, created_at ASC`
          : `SELECT * FROM items WHERE user_id = ? AND deleted_at IS NULL ORDER BY position ASC, created_at ASC`,
      )
      .all(user.id) as ItemRow[];
    const counts = childCounts(user.id);
    res.json({
      items: rows.map(serializeItem),
      counts: Object.fromEntries(counts),
    });
  }),
);

itemsRouter.get(
  '/:id',
  route((req, res) => {
    const user = currentUser(req);
    const row = getItemRow(user.id, req.params.id);
    const children = db
      .prepare(
        `SELECT * FROM items WHERE user_id = ? AND parent_id = ? AND deleted_at IS NULL
         ORDER BY position ASC`,
      )
      .all(user.id, row.id) as ItemRow[];
    res.json({
      item: serializeItem(row),
      children: children.map(serializeItem),
      path: ancestorPath(user.id, row.id),
    });
  }),
);

itemsRouter.post(
  '/',
  route((req, res) => {
    const user = currentUser(req);
    const input = itemInput.parse(req.body);
    const parentId = resolveParent(user.id, input);
    const id = insertItem(user.id, { ...input, parentId });
    res.status(201).json({ item: serializeItem(getItemRow(user.id, id)) });
  }),
);

const itemPatch = itemInput.partial().extend({ title: z.string().trim().min(1).max(500).optional() });

itemsRouter.patch(
  '/:id',
  route((req, res) => {
    const user = currentUser(req);
    const patch = itemPatch.parse(req.body);
    const row = getItemRow(user.id, req.params.id);

    if (patch.parentId !== undefined) assertNoCycle(user.id, row.id, patch.parentId ?? null);
    if (patch.blockedBy?.includes(row.id)) throw badRequest('An item cannot block itself');

    const ts = nowIso();
    const completedAt =
      patch.status === undefined
        ? row.completed_at
        : patch.status === 'done'
          ? (row.completed_at ?? ts)
          : null;

    db.prepare(
      `UPDATE items SET
         parent_id = @parent_id, title = @title, notes = @notes, icon = @icon, color = @color,
         status = @status, priority = @priority, energy = @energy, effort_minutes = @effort_minutes,
         due_at = @due_at, start_at = @start_at, recurrence = @recurrence, tags = @tags,
         blocked_by = @blocked_by, meta = @meta, position = @position, pinned = @pinned,
         display_mode = @display_mode, ink_drawing_id = @ink_drawing_id,
         completed_at = @completed_at, updated_at = @ts
       WHERE id = @id AND user_id = @user_id`,
    ).run({
      id: row.id,
      user_id: user.id,
      parent_id: patch.parentId !== undefined ? patch.parentId : row.parent_id,
      title: patch.title ?? row.title,
      notes: patch.notes ?? row.notes,
      icon: patch.icon ?? row.icon,
      color: patch.color ?? row.color,
      status: patch.status ?? row.status,
      priority: patch.priority ?? row.priority,
      energy: patch.energy ?? row.energy,
      effort_minutes: patch.effortMinutes ?? row.effort_minutes,
      due_at: patch.dueAt !== undefined ? patch.dueAt : row.due_at,
      start_at: patch.startAt !== undefined ? patch.startAt : row.start_at,
      recurrence:
        patch.recurrence !== undefined
          ? patch.recurrence
            ? JSON.stringify(patch.recurrence)
            : null
          : row.recurrence,
      tags: patch.tags ? JSON.stringify(patch.tags) : row.tags,
      blocked_by: patch.blockedBy ? JSON.stringify(patch.blockedBy) : row.blocked_by,
      meta: patch.meta ? JSON.stringify({ ...JSON.parse(row.meta), ...patch.meta }) : row.meta,
      position: patch.position ?? row.position,
      pinned: patch.pinned === undefined ? row.pinned : patch.pinned ? 1 : 0,
      display_mode: patch.displayMode ?? row.display_mode,
      ink_drawing_id: patch.inkDrawingId !== undefined ? patch.inkDrawingId : row.ink_drawing_id,
      completed_at: completedAt,
      ts,
    });

    logActivity(user.id, 'item.updated', row.id, { fields: Object.keys(patch) });
    res.json({ item: serializeItem(getItemRow(user.id, row.id)) });
  }),
);

itemsRouter.post(
  '/:id/complete',
  route((req, res) => {
    const user = currentUser(req);
    const body = z
      .object({ done: z.boolean().default(true), cascade: z.boolean().default(false) })
      .parse(req.body ?? {});
    const row = getItemRow(user.id, req.params.id);
    const result = completeItem(user.id, row, body.done, body.cascade);
    res.json(result);
  }),
);

/**
 * Completing a repeating item does not close it — it rolls forward to the next
 * occurrence, which is what "every Monday" means to a person. Everything else
 * flips status, optionally cascading to the whole subtree.
 */
export function completeItem(userId: string, row: ItemRow, done: boolean, cascade: boolean) {
  const ts = nowIso();
  const user = db.prepare(`SELECT timezone FROM users WHERE id = ?`).get(userId) as {
    timezone: string;
  };

  if (done && row.recurrence) {
    const rule = JSON.parse(row.recurrence);
    const anchor = new Date(row.due_at ?? row.created_at);
    const next = nextOccurrence(rule, anchor, new Date(), user.timezone || 'UTC');
    if (next) {
      db.prepare(`UPDATE items SET due_at = ?, completed_at = ?, updated_at = ? WHERE id = ?`).run(
        next.toISOString(),
        ts,
        ts,
        row.id,
      );
      logActivity(userId, 'item.recurred', row.id, { nextDueAt: next.toISOString() });
      rescheduleForItem(userId, row.id);
      return {
        item: serializeItem(getItemRow(userId, row.id)),
        rolledForwardTo: next.toISOString(),
      };
    }
  }

  const ids = cascade ? subtreeIds(userId, row.id) : [row.id];
  const update = db.prepare(
    `UPDATE items SET status = ?, completed_at = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
  );
  db.transaction(() => {
    for (const id of ids) update.run(done ? 'done' : 'open', done ? ts : null, ts, id, userId);
  })();

  logActivity(userId, done ? 'item.completed' : 'item.reopened', row.id, { cascade, count: ids.length });
  return { item: serializeItem(getItemRow(userId, row.id)), affected: ids };
}

itemsRouter.post(
  '/:id/move',
  route((req, res) => {
    const user = currentUser(req);
    const body = z
      .object({ parentId: z.string().uuid().nullable(), position: z.number().optional() })
      .parse(req.body);
    const row = getItemRow(user.id, req.params.id);
    assertNoCycle(user.id, row.id, body.parentId);
    if (body.parentId) getItemRow(user.id, body.parentId);

    db.prepare(`UPDATE items SET parent_id = ?, position = ?, updated_at = ? WHERE id = ? AND user_id = ?`)
      .run(body.parentId, body.position ?? nextPosition(user.id, body.parentId), nowIso(), row.id, user.id);
    res.json({ item: serializeItem(getItemRow(user.id, row.id)) });
  }),
);

itemsRouter.post(
  '/reorder',
  route((req, res) => {
    const user = currentUser(req);
    const body = z
      .object({ ids: z.array(z.string().uuid()).max(2000), parentId: z.string().uuid().nullable() })
      .parse(req.body);
    const stmt = db.prepare(
      `UPDATE items SET position = ?, parent_id = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
    );
    const ts = nowIso();
    db.transaction(() => {
      body.ids.forEach((id, index) => stmt.run(index * 1000, body.parentId, ts, id, user.id));
    })();
    res.json({ ok: true });
  }),
);

itemsRouter.delete(
  '/:id',
  route((req, res) => {
    const user = currentUser(req);
    const hard = req.query.hard === 'true';
    const row = getItemRow(user.id, req.params.id, true);
    const ids = subtreeIds(user.id, row.id);

    if (hard) {
      db.prepare(`DELETE FROM items WHERE id = ? AND user_id = ?`).run(row.id, user.id);
    } else {
      const ts = nowIso();
      const stmt = db.prepare(`UPDATE items SET deleted_at = ?, updated_at = ? WHERE id = ? AND user_id = ?`);
      db.transaction(() => {
        for (const id of ids) stmt.run(ts, ts, id, user.id);
      })();
      db.prepare(`UPDATE reminders SET deleted_at = ?, updated_at = ? WHERE item_id IN (${ids.map(() => '?').join(',')}) AND user_id = ?`)
        .run(ts, ts, ...ids, user.id);
    }
    logActivity(user.id, hard ? 'item.purged' : 'item.deleted', row.id, { count: ids.length });
    res.json({ ok: true, affected: ids });
  }),
);

itemsRouter.post(
  '/:id/restore',
  route((req, res) => {
    const user = currentUser(req);
    const row = getItemRow(user.id, req.params.id, true);
    const ids = subtreeIds(user.id, row.id);
    const ts = nowIso();
    const stmt = db.prepare(`UPDATE items SET deleted_at = NULL, updated_at = ? WHERE id = ? AND user_id = ?`);
    db.transaction(() => {
      for (const id of ids) stmt.run(ts, id, user.id);
    })();
    // A restored child whose parent is still in the trash would vanish from the
    // tree, so lift it to the root instead of leaving it unreachable.
    if (row.parent_id) {
      const parent = db.prepare(`SELECT deleted_at FROM items WHERE id = ?`).get(row.parent_id) as any;
      if (!parent || parent.deleted_at) {
        db.prepare(`UPDATE items SET parent_id = NULL, updated_at = ? WHERE id = ?`).run(ts, row.id);
      }
    }
    res.json({ ok: true, affected: ids });
  }),
);

itemsRouter.get(
  '/:id/breadcrumb',
  route((req, res) => {
    const user = currentUser(req);
    const ids = ancestorPath(user.id, req.params.id);
    const rows = ids.map((id) => serializeItem(getItemRow(user.id, id)));
    res.json({ path: rows.map((r) => ({ id: r.id, title: r.title, icon: r.icon })) });
  }),
);
