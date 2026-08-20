import { db, parseJson } from '../db.js';
import { badRequest, notFound } from './http.js';

export interface ItemRow {
  id: string;
  user_id: string;
  parent_id: string | null;
  title: string;
  notes: string;
  icon: string;
  color: string;
  status: string;
  priority: number;
  energy: number;
  effort_minutes: number;
  due_at: string | null;
  start_at: string | null;
  recurrence: string | null;
  tags: string;
  blocked_by: string;
  meta: string;
  position: number;
  pinned: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  deleted_at: string | null;
}

export interface Item {
  id: string;
  parentId: string | null;
  title: string;
  notes: string;
  icon: string;
  color: string;
  status: 'open' | 'done' | 'archived';
  priority: number;
  energy: number;
  effortMinutes: number;
  dueAt: string | null;
  startAt: string | null;
  recurrence: unknown | null;
  tags: string[];
  blockedBy: string[];
  meta: Record<string, unknown>;
  position: number;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  deletedAt: string | null;
}

export function serializeItem(row: ItemRow): Item {
  return {
    id: row.id,
    parentId: row.parent_id,
    title: row.title,
    notes: row.notes,
    icon: row.icon,
    color: row.color,
    status: row.status as Item['status'],
    priority: row.priority,
    energy: row.energy,
    effortMinutes: row.effort_minutes,
    dueAt: row.due_at,
    startAt: row.start_at,
    recurrence: row.recurrence ? parseJson<unknown>(row.recurrence, null) : null,
    tags: parseJson<string[]>(row.tags, []),
    blockedBy: parseJson<string[]>(row.blocked_by, []),
    meta: parseJson<Record<string, unknown>>(row.meta, {}),
    position: row.position,
    pinned: row.pinned === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    deletedAt: row.deleted_at,
  };
}

export function getItemRow(userId: string, id: string, includeDeleted = false): ItemRow {
  const row = db.prepare(`SELECT * FROM items WHERE id = ? AND user_id = ?`).get(id, userId) as
    | ItemRow
    | undefined;
  if (!row || (!includeDeleted && row.deleted_at)) throw notFound('Item not found');
  return row;
}

/** Every id in the subtree rooted at `id`, including `id` itself. */
export function subtreeIds(userId: string, id: string): string[] {
  const rows = db
    .prepare(
      `WITH RECURSIVE sub(id) AS (
         SELECT id FROM items WHERE id = ? AND user_id = ?
         UNION ALL
         SELECT i.id FROM items i JOIN sub ON i.parent_id = sub.id WHERE i.user_id = ?
       )
       SELECT id FROM sub`,
    )
    .all(id, userId, userId) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/** Root-to-node id path, useful for breadcrumbs and voice "under X > Y". */
export function ancestorPath(userId: string, id: string): string[] {
  const rows = db
    .prepare(
      `WITH RECURSIVE up(id, parent_id, depth) AS (
         SELECT id, parent_id, 0 FROM items WHERE id = ? AND user_id = ?
         UNION ALL
         SELECT i.id, i.parent_id, up.depth + 1
         FROM items i JOIN up ON i.id = up.parent_id WHERE i.user_id = ?
       )
       SELECT id FROM up ORDER BY depth DESC`,
    )
    .all(id, userId, userId) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/**
 * Reparenting must not create a cycle — a node cannot become a descendant of
 * itself, which would orphan the whole branch from the root.
 */
export function assertNoCycle(userId: string, id: string, newParentId: string | null) {
  if (!newParentId) return;
  if (newParentId === id) throw badRequest('An item cannot be its own parent');
  if (subtreeIds(userId, id).includes(newParentId)) {
    throw badRequest('Cannot move an item inside one of its own children');
  }
}

/** Next position value at the end of a parent's child list. */
export function nextPosition(userId: string, parentId: string | null): number {
  const row = db
    .prepare(
      parentId === null
        ? `SELECT MAX(position) AS m FROM items WHERE user_id = ? AND parent_id IS NULL AND deleted_at IS NULL`
        : `SELECT MAX(position) AS m FROM items WHERE user_id = ? AND parent_id = ? AND deleted_at IS NULL`,
    )
    .get(...(parentId === null ? [userId] : [userId, parentId])) as { m: number | null };
  return (row.m ?? 0) + 1000;
}

/**
 * Resolve a human path like ["cars", "land cruiser"] to an item id.
 * Matching is case-insensitive and accepts a unique prefix, which is what
 * makes voice input forgiving ("under cruiser" finds "Land Cruiser").
 */
export function resolvePath(userId: string, segments: string[]): string | null {
  let parentId: string | null = null;
  for (const segment of segments) {
    const needle = segment.trim().toLowerCase();
    if (!needle) continue;
    const candidates = db
      .prepare(
        parentId === null
          ? `SELECT id, title FROM items WHERE user_id = ? AND parent_id IS NULL AND deleted_at IS NULL`
          : `SELECT id, title FROM items WHERE user_id = ? AND parent_id = ? AND deleted_at IS NULL`,
      )
      .all(...(parentId === null ? [userId] : [userId, parentId])) as Array<{
      id: string;
      title: string;
    }>;

    const exact = candidates.find((c) => c.title.toLowerCase() === needle);
    const partial = candidates.filter((c) => c.title.toLowerCase().includes(needle));
    const hit = exact ?? (partial.length === 1 ? partial[0] : undefined);
    if (!hit) return null;
    parentId = hit.id;
  }
  return parentId;
}

export function childCounts(userId: string): Map<string, { total: number; done: number }> {
  const rows = db
    .prepare(
      `SELECT parent_id AS pid,
              COUNT(*) AS total,
              SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done
       FROM items
       WHERE user_id = ? AND deleted_at IS NULL AND parent_id IS NOT NULL
       GROUP BY parent_id`,
    )
    .all(userId) as Array<{ pid: string; total: number; done: number }>;
  const map = new Map<string, { total: number; done: number }>();
  for (const r of rows) map.set(r.pid, { total: r.total, done: r.done ?? 0 });
  return map;
}

export function logActivity(
  userId: string,
  kind: string,
  itemId: string | null,
  payload: Record<string, unknown> = {},
) {
  db.prepare(
    `INSERT INTO activity (id, user_id, kind, item_id, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(crypto.randomUUID(), userId, kind, itemId, JSON.stringify(payload), new Date().toISOString());
}
