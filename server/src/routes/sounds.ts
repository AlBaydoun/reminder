import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { db, newId, nowIso } from '../db.js';
import { currentUser, requireAuth } from '../auth.js';
import { badRequest, notFound, route } from '../lib/http.js';
import { UPLOAD_LIMIT_BYTES } from '../config.js';

export const soundsRouter = Router();
soundsRouter.use(requireAuth);

/**
 * Built-in alarm tones are *synthesized in the browser* with the Web Audio API
 * rather than shipped as audio files: no binary assets, no licensing, instant
 * playback, and they stay crisp at any volume. The server only needs to know
 * the catalogue so it can validate ids and describe them to clients.
 */
export const BUILTIN_SOUNDS = [
  { key: 'chime', name: 'Chime', character: 'gentle' },
  { key: 'marimba', name: 'Marimba', character: 'gentle' },
  { key: 'harp', name: 'Harp Rise', character: 'gentle' },
  { key: 'bells', name: 'Temple Bells', character: 'calm' },
  { key: 'pulse', name: 'Pulse', character: 'neutral' },
  { key: 'radar', name: 'Radar', character: 'urgent' },
  { key: 'siren', name: 'Siren', character: 'urgent' },
  { key: 'klaxon', name: 'Klaxon', character: 'urgent' },
  { key: 'digital', name: 'Digital Alarm', character: 'urgent' },
  { key: 'birdsong', name: 'Birdsong', character: 'gentle' },
  { key: 'water', name: 'Water Drop', character: 'calm' },
  { key: 'cosmic', name: 'Cosmic', character: 'neutral' },
] as const;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: UPLOAD_LIMIT_BYTES, files: 1 },
});

const ALLOWED_AUDIO = /^audio\/(mpeg|mp3|wav|x-wav|wave|ogg|opus|webm|aac|mp4|x-m4a|flac)$/i;

soundsRouter.get(
  '/',
  route((req, res) => {
    const user = currentUser(req);
    const rows = db
      .prepare(
        `SELECT id, name, mime, size, created_at FROM sounds
         WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at DESC`,
      )
      .all(user.id) as Array<{ id: string; name: string; mime: string; size: number; created_at: string }>;
    res.json({
      builtin: BUILTIN_SOUNDS,
      custom: rows.map((r) => ({
        id: r.id,
        name: r.name,
        mime: r.mime,
        size: r.size,
        createdAt: r.created_at,
        url: `/api/sounds/${r.id}/audio`,
      })),
    });
  }),
);

/**
 * Upload a custom alarm sound. On a phone the browser's file picker offers the
 * device's own audio library, so "a sound from inside the phone" and "a sound
 * I made" are the same flow.
 */
soundsRouter.post(
  '/',
  upload.single('file'),
  route((req, res) => {
    const user = currentUser(req);
    const file = req.file;
    if (!file) throw badRequest('No audio file was uploaded');
    if (!ALLOWED_AUDIO.test(file.mimetype)) {
      throw badRequest(`Unsupported audio type "${file.mimetype}"`);
    }
    const name = z
      .string()
      .trim()
      .min(1)
      .max(120)
      .catch(file.originalname || 'Custom sound')
      .parse(req.body?.name ?? file.originalname);

    const id = newId();
    db.prepare(
      `INSERT INTO sounds (id, user_id, name, mime, size, data, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, user.id, name, file.mimetype, file.size, file.buffer, nowIso());

    res.status(201).json({
      sound: { id, name, mime: file.mimetype, size: file.size, url: `/api/sounds/${id}/audio` },
    });
  }),
);

soundsRouter.get(
  '/:id/audio',
  route((req, res) => {
    const user = currentUser(req);
    const row = db
      .prepare(`SELECT mime, data, size FROM sounds WHERE id = ? AND user_id = ? AND deleted_at IS NULL`)
      .get(req.params.id, user.id) as { mime: string; data: Buffer; size: number } | undefined;
    if (!row?.data) throw notFound('Sound not found');
    res.setHeader('Content-Type', row.mime);
    res.setHeader('Content-Length', String(row.size));
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.setHeader('Accept-Ranges', 'none');
    res.send(row.data);
  }),
);

soundsRouter.patch(
  '/:id',
  route((req, res) => {
    const user = currentUser(req);
    const body = z.object({ name: z.string().trim().min(1).max(120) }).parse(req.body);
    const info = db
      .prepare(`UPDATE sounds SET name = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL`)
      .run(body.name, req.params.id, user.id);
    if (info.changes === 0) throw notFound('Sound not found');
    res.json({ ok: true });
  }),
);

soundsRouter.delete(
  '/:id',
  route((req, res) => {
    const user = currentUser(req);
    const ts = nowIso();
    // Drop the blob immediately — a deleted sound should not keep occupying space.
    const info = db
      .prepare(`UPDATE sounds SET deleted_at = ?, data = NULL WHERE id = ? AND user_id = ?`)
      .run(ts, req.params.id, user.id);
    if (info.changes === 0) throw notFound('Sound not found');
    // Reminders pointing at it fall back to the default tone rather than going silent.
    db.prepare(`UPDATE reminders SET sound_id = NULL, updated_at = ? WHERE user_id = ? AND sound_id = ?`)
      .run(ts, user.id, req.params.id);
    res.json({ ok: true });
  }),
);
