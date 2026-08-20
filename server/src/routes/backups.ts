import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db.js';
import { BACKUP_DIR } from '../config.js';
import { currentUser, requireAuth } from '../auth.js';
import { badRequest, forbidden, notFound, route } from '../lib/http.js';
import {
  exportUser,
  readBackupFile,
  restoreUser,
  rotateBackups,
  runNightlyBackup,
  writeUserBackup,
  type UserExport,
} from '../backup.js';
import { rescheduleAll } from '../lib/reminders.js';

export const backupsRouter = Router();
backupsRouter.use(requireAuth);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 64 * 1024 * 1024, files: 1 } });

backupsRouter.get(
  '/',
  route((req, res) => {
    const user = currentUser(req);
    const rows = db
      .prepare(
        `SELECT id, kind, filename, size, item_count, created_at FROM backups
         WHERE user_id = ? ORDER BY created_at DESC LIMIT 200`,
      )
      .all(user.id) as any[];
    const next = db
      .prepare(`SELECT created_at FROM backups WHERE user_id = ? AND kind = 'nightly' ORDER BY created_at DESC LIMIT 1`)
      .get(user.id) as { created_at: string } | undefined;

    res.json({
      backups: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        filename: r.filename,
        size: r.size,
        itemCount: r.item_count,
        createdAt: r.created_at,
        // A backup row whose file was removed by hand should not look restorable.
        available: fs.existsSync(path.join(BACKUP_DIR, r.filename)),
      })),
      lastNightly: next?.created_at ?? null,
    });
  }),
);

/** Download the current state as a JSON file, without touching disk on the server. */
backupsRouter.get(
  '/export',
  route((req, res) => {
    const user = currentUser(req);
    const includeSounds = req.query.includeSounds !== 'false';
    const payload = exportUser(user.id, includeSounds);
    const filename = `nexus-${user.email.replace(/[^a-z0-9]+/gi, '-')}-${payload.exportedAt.slice(0, 10)}.json`;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(JSON.stringify(payload, null, 2));
  }),
);

/** Take a snapshot right now. */
backupsRouter.post(
  '/',
  route((req, res) => {
    const user = currentUser(req);
    const result = writeUserBackup(user.id, 'manual');
    rotateBackups();
    res.status(201).json({ backup: result });
  }),
);

backupsRouter.get(
  '/:id/download',
  route((req, res) => {
    const user = currentUser(req);
    const row = db
      .prepare(`SELECT filename, user_id FROM backups WHERE id = ?`)
      .get(req.params.id) as { filename: string; user_id: string | null } | undefined;
    if (!row) throw notFound('Backup not found');
    if (row.user_id !== user.id) throw forbidden('That backup belongs to another account');
    const file = path.join(BACKUP_DIR, path.basename(row.filename));
    if (!fs.existsSync(file)) throw notFound('Backup file is missing from disk');
    res.download(file, row.filename);
  }),
);

backupsRouter.post(
  '/:id/restore',
  route((req, res) => {
    const user = currentUser(req);
    const body = z.object({ mode: z.enum(['replace', 'merge']).default('replace') }).parse(req.body ?? {});
    const row = db
      .prepare(`SELECT filename, user_id FROM backups WHERE id = ?`)
      .get(req.params.id) as { filename: string; user_id: string | null } | undefined;
    if (!row) throw notFound('Backup not found');
    if (row.user_id !== user.id) throw forbidden('That backup belongs to another account');

    const payload = readBackupFile(row.filename);
    const result = restoreUser(user.id, payload, body.mode);
    rescheduleAll(user.id);
    res.json({ ok: true, ...result });
  }),
);

/** Restore from a file the user uploads (e.g. a backup they downloaded earlier). */
backupsRouter.post(
  '/import',
  upload.single('file'),
  route((req, res) => {
    const user = currentUser(req);
    const mode = req.body?.mode === 'merge' ? 'merge' : 'replace';
    let payload: UserExport;
    try {
      const text = req.file ? req.file.buffer.toString('utf8') : JSON.stringify(req.body?.payload ?? null);
      payload = JSON.parse(text) as UserExport;
    } catch {
      throw badRequest('That file is not valid JSON');
    }
    if (!payload || payload.format !== 'nexus-backup') throw badRequest('That is not a Nexus backup file');

    const result = restoreUser(user.id, payload, mode);
    rescheduleAll(user.id);
    res.json({ ok: true, ...result });
  }),
);

backupsRouter.delete(
  '/:id',
  route((req, res) => {
    const user = currentUser(req);
    const row = db
      .prepare(`SELECT filename, user_id FROM backups WHERE id = ?`)
      .get(req.params.id) as { filename: string; user_id: string | null } | undefined;
    if (!row) throw notFound('Backup not found');
    if (row.user_id !== user.id) throw forbidden('That backup belongs to another account');
    const file = path.join(BACKUP_DIR, path.basename(row.filename));
    if (fs.existsSync(file)) fs.unlinkSync(file);
    db.prepare(`DELETE FROM backups WHERE id = ?`).run(req.params.id);
    res.json({ ok: true });
  }),
);

/** Manual trigger for the full nightly pass — handy for verifying the setup. */
backupsRouter.post(
  '/run-nightly',
  route(async (_req, res) => {
    const result = await runNightlyBackup();
    res.json({ ok: true, ...result });
  }),
);
