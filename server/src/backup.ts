import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import cron from 'node-cron';
import { db, newId, nowIso } from './db.js';
import { BACKUP_CRON, BACKUP_DIR, BACKUP_KEEP_DAILY, BACKUP_KEEP_MONTHLY, DB_PATH } from './config.js';
import { purgeExpiredTokens } from './auth.js';

export const BACKUP_FORMAT_VERSION = 1;

export interface UserExport {
  format: 'nexus-backup';
  version: number;
  exportedAt: string;
  user: Record<string, unknown>;
  items: unknown[];
  reminders: unknown[];
  drawings: unknown[];
  sounds: unknown[];
  activity: unknown[];
  counts: Record<string, number>;
}

/**
 * Complete, self-contained export of one account. Custom alarm sounds are
 * base64-inlined so a restore on a fresh server reproduces the account exactly
 * — a backup that loses the user's alarm tones is not a backup.
 */
export function exportUser(userId: string, includeSounds = true): UserExport {
  const all = (sql: string) => db.prepare(sql).all(userId) as any[];

  const user = db
    .prepare(`SELECT id, email, name, locale, timezone, settings, created_at FROM users WHERE id = ?`)
    .get(userId) as Record<string, unknown> | undefined;
  if (!user) throw new Error(`No such user: ${userId}`);

  const items = all(`SELECT * FROM items WHERE user_id = ?`);
  const reminders = all(`SELECT * FROM reminders WHERE user_id = ?`);
  const drawings = all(`SELECT * FROM drawings WHERE user_id = ?`);
  const activity = all(`SELECT * FROM activity WHERE user_id = ? ORDER BY created_at DESC LIMIT 5000`);
  const soundRows = all(
    includeSounds
      ? `SELECT id, name, mime, size, data, created_at, deleted_at FROM sounds WHERE user_id = ?`
      : `SELECT id, name, mime, size, created_at, deleted_at FROM sounds WHERE user_id = ?`,
  );
  const sounds = soundRows.map((s) => ({
    ...s,
    data: s.data ? Buffer.from(s.data).toString('base64') : null,
  }));

  return {
    format: 'nexus-backup',
    version: BACKUP_FORMAT_VERSION,
    exportedAt: nowIso(),
    user,
    items,
    reminders,
    drawings,
    sounds,
    activity,
    counts: {
      items: items.length,
      reminders: reminders.length,
      drawings: drawings.length,
      sounds: sounds.length,
    },
  };
}

function stamp(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-').replace('Z', '');
}

/** Write one account's export to disk and record it in the backups table. */
export function writeUserBackup(userId: string, kind: 'nightly' | 'manual' | 'pre-restore'): {
  id: string;
  filename: string;
  size: number;
} {
  const payload = exportUser(userId);
  const json = JSON.stringify(payload);
  const filename = `user-${userId}-${kind}-${stamp()}.json`;
  const target = path.join(BACKUP_DIR, filename);
  fs.writeFileSync(target, json, 'utf8');

  const id = newId();
  const size = Buffer.byteLength(json);
  db.prepare(
    `INSERT INTO backups (id, user_id, kind, filename, size, item_count, checksum, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    userId,
    kind,
    filename,
    size,
    payload.counts.items,
    crypto.createHash('sha256').update(json).digest('hex'),
    nowIso(),
  );
  return { id, filename, size };
}

/**
 * Byte-exact copy of the whole SQLite file via the online backup API. Safe to
 * run while the server is serving requests, unlike copying the file by hand.
 */
export async function writeDatabaseSnapshot(kind: 'nightly' | 'manual' = 'nightly'): Promise<string> {
  const filename = `database-${kind}-${stamp()}.sqlite`;
  const target = path.join(BACKUP_DIR, filename);
  await db.backup(target);
  const size = fs.statSync(target).size;
  db.prepare(
    `INSERT INTO backups (id, user_id, kind, filename, size, item_count, checksum, created_at)
     VALUES (?, NULL, ?, ?, ?, 0, '', ?)`,
  ).run(newId(), kind, filename, size, nowIso());
  return filename;
}

/**
 * Keep the last N nightly runs, plus the first run of each of the last M
 * months, so a mistake noticed weeks later is still recoverable.
 */
export function rotateBackups(): number {
  const rows = db
    .prepare(`SELECT * FROM backups WHERE kind = 'nightly' ORDER BY created_at DESC`)
    .all() as Array<{ id: string; filename: string; created_at: string; user_id: string | null }>;

  const keep = new Set<string>();
  const perTarget = new Map<string, number>();
  const monthlyKeeper = new Map<string, string>();

  for (const row of rows) {
    const target = row.user_id ?? '__db__';
    const seen = perTarget.get(target) ?? 0;
    if (seen < BACKUP_KEEP_DAILY) {
      keep.add(row.id);
      perTarget.set(target, seen + 1);
    }
    const monthKey = `${target}:${row.created_at.slice(0, 7)}`;
    if (!monthlyKeeper.has(monthKey)) monthlyKeeper.set(monthKey, row.id);
  }

  // Newest-first iteration means the first id seen per month is the most recent one.
  const months = [...monthlyKeeper.entries()].slice(0, BACKUP_KEEP_MONTHLY * 8);
  for (const [, id] of months) keep.add(id);

  let removed = 0;
  for (const row of rows) {
    if (keep.has(row.id)) continue;
    const file = path.join(BACKUP_DIR, row.filename);
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch (err) {
      console.warn('[backup] could not delete', row.filename, err);
    }
    db.prepare(`DELETE FROM backups WHERE id = ?`).run(row.id);
    removed++;
  }
  return removed;
}

/** One nightly pass: per-user exports + a whole-database snapshot + rotation. */
export async function runNightlyBackup(): Promise<{ users: number; removed: number; file: string }> {
  const started = Date.now();
  const users = db.prepare(`SELECT id FROM users`).all() as Array<{ id: string }>;
  for (const u of users) {
    try {
      writeUserBackup(u.id, 'nightly');
    } catch (err) {
      console.error('[backup] failed for user', u.id, err);
    }
  }
  const file = await writeDatabaseSnapshot('nightly');
  const removed = rotateBackups();
  purgeExpiredTokens();
  db.pragma('wal_checkpoint(TRUNCATE)');
  console.log(
    `[backup] nightly complete — ${users.length} account(s), ${removed} old file(s) pruned, ${Date.now() - started}ms`,
  );
  return { users: users.length, removed, file };
}

/**
 * Replace an account's contents with a previous export.
 * `merge` keeps rows that are not present in the backup; `replace` wipes first.
 * A safety copy is always written before anything is touched.
 */
export function restoreUser(
  userId: string,
  payload: UserExport,
  mode: 'replace' | 'merge' = 'replace',
): { restored: Record<string, number>; safetyBackup: string } {
  if (payload?.format !== 'nexus-backup') throw new Error('Not a Nexus backup file');
  if (payload.version > BACKUP_FORMAT_VERSION) {
    throw new Error(`Backup was made by a newer version (${payload.version}) of the app`);
  }

  const safety = writeUserBackup(userId, 'pre-restore');
  const restored: Record<string, number> = { items: 0, reminders: 0, drawings: 0, sounds: 0 };

  const run = db.transaction(() => {
    if (mode === 'replace') {
      db.prepare(`DELETE FROM drawings  WHERE user_id = ?`).run(userId);
      db.prepare(`DELETE FROM reminders WHERE user_id = ?`).run(userId);
      db.prepare(`DELETE FROM items     WHERE user_id = ?`).run(userId);
      db.prepare(`DELETE FROM sounds    WHERE user_id = ?`).run(userId);
    }

    const verb = mode === 'merge' ? 'INSERT OR REPLACE' : 'INSERT';

    // Items go in with foreign keys deferred: a child can appear before its
    // parent in the export, and self-referencing FKs would otherwise reject it.
    db.pragma('defer_foreign_keys = ON');

    for (const raw of payload.items ?? []) {
      const it = raw as Record<string, unknown>;
      db.prepare(
        `${verb} INTO items (id, user_id, parent_id, title, notes, icon, color, status, priority,
                             energy, effort_minutes, due_at, start_at, recurrence, tags, blocked_by,
                             meta, position, pinned, created_at, updated_at, completed_at, deleted_at)
         VALUES (@id, @user_id, @parent_id, @title, @notes, @icon, @color, @status, @priority,
                 @energy, @effort_minutes, @due_at, @start_at, @recurrence, @tags, @blocked_by,
                 @meta, @position, @pinned, @created_at, @updated_at, @completed_at, @deleted_at)`,
      ).run({ ...it, user_id: userId });
      restored.items++;
    }

    for (const raw of payload.sounds ?? []) {
      const s = raw as Record<string, any>;
      db.prepare(
        `${verb} INTO sounds (id, user_id, name, mime, size, data, created_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        s.id,
        userId,
        s.name,
        s.mime,
        s.size,
        s.data ? Buffer.from(String(s.data), 'base64') : null,
        s.created_at,
        s.deleted_at ?? null,
      );
      restored.sounds++;
    }

    for (const raw of payload.reminders ?? []) {
      const r = raw as Record<string, unknown>;
      db.prepare(
        `${verb} INTO reminders (id, user_id, item_id, label, fire_at, next_fire_at, rrule, sound_id,
                                 volume, vibrate, lead_minutes, snooze_minutes, snoozed_until,
                                 escalate, ring_seconds, status, last_fired_at, created_at,
                                 updated_at, deleted_at)
         VALUES (@id, @user_id, @item_id, @label, @fire_at, @next_fire_at, @rrule, @sound_id,
                 @volume, @vibrate, @lead_minutes, @snooze_minutes, @snoozed_until,
                 @escalate, @ring_seconds, @status, @last_fired_at, @created_at,
                 @updated_at, @deleted_at)`,
      ).run({ ...r, user_id: userId });
      restored.reminders++;
    }

    for (const raw of payload.drawings ?? []) {
      const d = raw as Record<string, unknown>;
      db.prepare(
        `${verb} INTO drawings (id, user_id, item_id, title, strokes, width, height, thumbnail,
                                recognized_text, created_at, updated_at, deleted_at)
         VALUES (@id, @user_id, @item_id, @title, @strokes, @width, @height, @thumbnail,
                 @recognized_text, @created_at, @updated_at, @deleted_at)`,
      ).run({ ...d, user_id: userId });
      restored.drawings++;
    }

    const settings = (payload.user as any)?.settings;
    if (settings) {
      db.prepare(`UPDATE users SET settings = ?, updated_at = ? WHERE id = ?`).run(
        typeof settings === 'string' ? settings : JSON.stringify(settings),
        nowIso(),
        userId,
      );
    }
  });

  run();
  db.pragma('defer_foreign_keys = OFF');
  return { restored, safetyBackup: safety.filename };
}

export function readBackupFile(filename: string): UserExport {
  // Defend against path traversal — only plain filenames inside BACKUP_DIR.
  const safe = path.basename(filename);
  const file = path.join(BACKUP_DIR, safe);
  if (!fs.existsSync(file)) throw new Error('Backup file is missing from disk');
  return JSON.parse(fs.readFileSync(file, 'utf8')) as UserExport;
}

let scheduled: cron.ScheduledTask | null = null;

export function startBackupSchedule() {
  if (scheduled) return;
  if (!cron.validate(BACKUP_CRON)) {
    console.error(`[backup] invalid BACKUP_CRON "${BACKUP_CRON}" — nightly backups are disabled`);
    return;
  }
  scheduled = cron.schedule(BACKUP_CRON, () => {
    runNightlyBackup().catch((err) => console.error('[backup] nightly run failed', err));
  });
  console.log(`[backup] nightly backups scheduled (${BACKUP_CRON}, server local time)`);

  // If the machine was asleep or the process was down at the scheduled hour,
  // catch up shortly after boot rather than skipping a night entirely.
  setTimeout(() => {
    const last = db
      .prepare(`SELECT created_at FROM backups WHERE kind = 'nightly' ORDER BY created_at DESC LIMIT 1`)
      .get() as { created_at: string } | undefined;
    const staleMs = Date.now() - (last ? new Date(last.created_at).getTime() : 0);
    if (staleMs > 26 * 3_600_000) {
      console.log('[backup] no recent nightly backup found — running a catch-up pass');
      runNightlyBackup().catch((err) => console.error('[backup] catch-up run failed', err));
    }
  }, 20_000).unref();
}
