import { Router } from 'express';
import { z } from 'zod';
import { db, parseJson } from '../db.js';
import { currentUser, requireAuth } from '../auth.js';
import { route } from '../lib/http.js';
import {
  buildInsights,
  dependencyReport,
  findDuplicates,
  scoreItems,
  streaks,
  suggestCategories,
  suggestSlots,
  workloadForecast,
} from '../lib/reasoning.js';
import { isValidTimeZone } from '../lib/time.js';

export const brainRouter = Router();
brainRouter.use(requireAuth);

function userContext(userId: string) {
  const row = db.prepare(`SELECT timezone, settings FROM users WHERE id = ?`).get(userId) as {
    timezone: string;
    settings: string;
  };
  const settings = parseJson<Record<string, any>>(row.settings, {});
  const timeZone = isValidTimeZone(row.timezone) ? row.timezone : 'UTC';
  return {
    timeZone,
    capacity: Number(settings.dailyCapacityMinutes) || 240,
    workStartHour: Number(settings.workStartHour ?? 9),
    workEndHour: Number(settings.workEndHour ?? 19),
  };
}

/** Everything the dashboard needs, in one round trip. */
brainRouter.get(
  '/overview',
  route((req, res) => {
    const user = currentUser(req);
    const ctx = userContext(user.id);
    const now = new Date();
    const scored = scoreItems(user.id, now.getTime());

    res.json({
      focus: scored.slice(0, 25),
      insights: buildInsights(user.id, ctx.timeZone, ctx.capacity, now),
      forecast: workloadForecast(user.id, ctx.timeZone, ctx.capacity, 14, now),
      streak: streaks(user.id, ctx.timeZone, now),
      dependencies: dependencyReport(user.id),
      totals: {
        open: scored.length,
        blocked: scored.filter((s) => s.blocked).length,
        overdue: scored.filter((s) => s.item.dueAt && new Date(s.item.dueAt) < now).length,
      },
      timeZone: ctx.timeZone,
      serverTime: now.toISOString(),
    });
  }),
);

brainRouter.get(
  '/focus',
  route((req, res) => {
    const user = currentUser(req);
    const limit = Math.min(Number(req.query.limit ?? 20) || 20, 200);
    const includeBlocked = req.query.includeBlocked === 'true';
    let scored = scoreItems(user.id);
    if (!includeBlocked) scored = scored.filter((s) => !s.blocked);
    res.json({ focus: scored.slice(0, limit) });
  }),
);

brainRouter.get(
  '/duplicates',
  route((req, res) => {
    const user = currentUser(req);
    const threshold = Math.min(Math.max(Number(req.query.threshold ?? 0.55) || 0.55, 0.2), 0.95);
    res.json({ duplicates: findDuplicates(user.id, threshold) });
  }),
);

brainRouter.post(
  '/categorize',
  route((req, res) => {
    const user = currentUser(req);
    const body = z.object({ title: z.string().trim().min(1).max(500) }).parse(req.body);
    res.json({ suggestions: suggestCategories(user.id, body.title) });
  }),
);

brainRouter.post(
  '/schedule',
  route((req, res) => {
    const user = currentUser(req);
    const body = z
      .object({ effortMinutes: z.number().int().min(5).max(1440).default(30), days: z.number().int().min(1).max(30).optional() })
      .parse(req.body ?? {});
    const ctx = userContext(user.id);
    res.json({
      slots: suggestSlots(user.id, ctx.timeZone, body.effortMinutes, {
        workStartHour: ctx.workStartHour,
        workEndHour: ctx.workEndHour,
        days: body.days ?? 7,
        capacity: ctx.capacity,
      }),
    });
  }),
);

brainRouter.get(
  '/forecast',
  route((req, res) => {
    const user = currentUser(req);
    const ctx = userContext(user.id);
    const days = Math.min(Number(req.query.days ?? 14) || 14, 60);
    res.json({ forecast: workloadForecast(user.id, ctx.timeZone, ctx.capacity, days) });
  }),
);

/** Full-text-ish search across titles, notes and tags. */
brainRouter.get(
  '/search',
  route((req, res) => {
    const user = currentUser(req);
    const q = String(req.query.q ?? '').trim();
    if (!q) return res.json({ results: [] });
    const like = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    // Handwritten rows are found the same way as typed ones: the transcription
    // lives in the title, and any sketch attached to an item is searched too,
    // so ink is never a dead end in search.
    const rows = db
      .prepare(
        `SELECT i.id, i.title, i.notes, i.icon, i.color, i.parent_id, i.status, i.due_at, i.tags,
                i.display_mode, i.ink_drawing_id
         FROM items i
         WHERE i.user_id = ? AND i.deleted_at IS NULL
           AND (
             i.title LIKE ? ESCAPE '\\'
             OR i.notes LIKE ? ESCAPE '\\'
             OR i.tags  LIKE ? ESCAPE '\\'
             OR EXISTS (
               SELECT 1 FROM drawings d
               WHERE d.item_id = i.id AND d.deleted_at IS NULL
                 AND d.recognized_text LIKE ? ESCAPE '\\'
             )
           )
         ORDER BY CASE WHEN i.title LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END, i.updated_at DESC
         LIMIT 60`,
      )
      .all(user.id, like, like, like, like, like) as any[];
    res.json({
      results: rows.map((r) => ({
        id: r.id,
        title: r.title,
        icon: r.icon,
        color: r.color,
        parentId: r.parent_id,
        status: r.status,
        dueAt: r.due_at,
        tags: parseJson<string[]>(r.tags, []),
        displayMode: r.display_mode === 'ink' ? 'ink' : 'text',
        inkDrawingId: r.ink_drawing_id,
        snippet: String(r.notes ?? '').slice(0, 160),
      })),
    });
  }),
);
