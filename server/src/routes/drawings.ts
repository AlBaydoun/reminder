import { Router } from 'express';
import { z } from 'zod';
import { db, newId, nowIso, parseJson } from '../db.js';
import { currentUser, requireAuth } from '../auth.js';
import { notFound, route } from '../lib/http.js';
import { getItemRow } from '../lib/items.js';

export const drawingsRouter = Router();
drawingsRouter.use(requireAuth);

/**
 * Strokes are stored as vectors, not pixels: every point keeps pressure and
 * tilt from the PointerEvent, so a drawing stays crisp at any zoom, can be
 * re-rendered in a different colour or theme, and can be fed to the stroke
 * recognizer later without any image processing.
 */
const pointSchema = z.object({
  x: z.number(),
  y: z.number(),
  p: z.number().min(0).max(1).optional(), // pressure
  tx: z.number().optional(), // tiltX
  ty: z.number().optional(), // tiltY
  t: z.number().optional(), // ms since stroke start
});

const strokeSchema = z.object({
  points: z.array(pointSchema).max(20_000),
  color: z.string().max(32).optional(),
  width: z.number().min(0.1).max(200).optional(),
  tool: z.enum(['pen', 'marker', 'pencil', 'highlighter', 'eraser']).optional(),
  pointerType: z.enum(['pen', 'touch', 'mouse']).optional(),
});

const drawingInput = z.object({
  itemId: z.string().uuid().nullable().optional(),
  title: z.string().trim().max(300).optional(),
  strokes: z.array(strokeSchema).max(5000),
  width: z.number().int().min(1).max(10_000),
  height: z.number().int().min(1).max(10_000),
  thumbnail: z
    .string()
    .max(1_500_000)
    .refine((v) => v === '' || v.startsWith('data:image/'), 'Thumbnail must be a data image URL')
    .optional(),
  recognizedText: z.string().max(10_000).optional(),
});

const serialize = (row: any) => ({
  id: row.id,
  itemId: row.item_id,
  title: row.title,
  strokes: parseJson<unknown[]>(row.strokes, []),
  width: row.width,
  height: row.height,
  thumbnail: row.thumbnail,
  recognizedText: row.recognized_text,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

drawingsRouter.get(
  '/',
  route((req, res) => {
    const user = currentUser(req);
    const itemId = typeof req.query.itemId === 'string' ? req.query.itemId : null;
    const rows = db
      .prepare(
        itemId
          ? `SELECT * FROM drawings WHERE user_id = ? AND item_id = ? AND deleted_at IS NULL ORDER BY created_at DESC`
          : `SELECT * FROM drawings WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at DESC`,
      )
      .all(...(itemId ? [user.id, itemId] : [user.id])) as any[];
    res.json({ drawings: rows.map(serialize) });
  }),
);

drawingsRouter.get(
  '/:id',
  route((req, res) => {
    const user = currentUser(req);
    const row = db
      .prepare(`SELECT * FROM drawings WHERE id = ? AND user_id = ? AND deleted_at IS NULL`)
      .get(req.params.id, user.id);
    if (!row) throw notFound('Drawing not found');
    res.json({ drawing: serialize(row) });
  }),
);

drawingsRouter.post(
  '/',
  route((req, res) => {
    const user = currentUser(req);
    const input = drawingInput.parse(req.body);
    if (input.itemId) getItemRow(user.id, input.itemId);

    const id = newId();
    const ts = nowIso();
    db.prepare(
      `INSERT INTO drawings (id, user_id, item_id, title, strokes, width, height, thumbnail,
                             recognized_text, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      user.id,
      input.itemId ?? null,
      input.title ?? '',
      JSON.stringify(input.strokes),
      input.width,
      input.height,
      input.thumbnail ?? '',
      input.recognizedText ?? '',
      ts,
      ts,
    );
    const row = db.prepare(`SELECT * FROM drawings WHERE id = ?`).get(id);
    res.status(201).json({ drawing: serialize(row) });
  }),
);

drawingsRouter.patch(
  '/:id',
  route((req, res) => {
    const user = currentUser(req);
    const patch = drawingInput.partial().parse(req.body);
    const row = db
      .prepare(`SELECT * FROM drawings WHERE id = ? AND user_id = ? AND deleted_at IS NULL`)
      .get(req.params.id, user.id) as any;
    if (!row) throw notFound('Drawing not found');

    db.prepare(
      `UPDATE drawings SET item_id = ?, title = ?, strokes = ?, width = ?, height = ?,
              thumbnail = ?, recognized_text = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`,
    ).run(
      patch.itemId !== undefined ? patch.itemId : row.item_id,
      patch.title ?? row.title,
      patch.strokes ? JSON.stringify(patch.strokes) : row.strokes,
      patch.width ?? row.width,
      patch.height ?? row.height,
      patch.thumbnail ?? row.thumbnail,
      patch.recognizedText ?? row.recognized_text,
      nowIso(),
      row.id,
      user.id,
    );
    res.json({ drawing: serialize(db.prepare(`SELECT * FROM drawings WHERE id = ?`).get(row.id)) });
  }),
);

drawingsRouter.delete(
  '/:id',
  route((req, res) => {
    const user = currentUser(req);
    const info = db
      .prepare(`UPDATE drawings SET deleted_at = ?, updated_at = ? WHERE id = ? AND user_id = ?`)
      .run(nowIso(), nowIso(), req.params.id, user.id);
    if (info.changes === 0) throw notFound('Drawing not found');
    res.json({ ok: true });
  }),
);
