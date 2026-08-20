import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { DB_PATH } from './config.js';

export const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');

export const newId = (): string => crypto.randomUUID();
export const nowIso = (): string => new Date().toISOString();

/**
 * Migrations are plain, append-only SQL steps keyed by `user_version`.
 * Never edit an existing step — add a new one.
 */
const MIGRATIONS: Array<(d: Database.Database) => void> = [
  // 1 — core schema
  (d) => {
    d.exec(`
      CREATE TABLE users (
        id            TEXT PRIMARY KEY,
        email         TEXT NOT NULL UNIQUE,
        name          TEXT NOT NULL DEFAULT '',
        password_hash TEXT NOT NULL,
        locale        TEXT NOT NULL DEFAULT 'en',
        timezone      TEXT NOT NULL DEFAULT 'UTC',
        settings      TEXT NOT NULL DEFAULT '{}',
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );

      CREATE TABLE refresh_tokens (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        user_agent TEXT NOT NULL DEFAULT '',
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_refresh_user ON refresh_tokens(user_id);

      -- The heart of the model: one table for BOTH categories and tasks.
      -- A row with children behaves as a category; a leaf behaves as a task.
      -- Either way it can carry reminders, drawings, a due date and a status.
      CREATE TABLE items (
        id             TEXT PRIMARY KEY,
        user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        parent_id      TEXT REFERENCES items(id) ON DELETE CASCADE,
        title          TEXT NOT NULL,
        notes          TEXT NOT NULL DEFAULT '',
        icon           TEXT NOT NULL DEFAULT '',
        color          TEXT NOT NULL DEFAULT '',
        status         TEXT NOT NULL DEFAULT 'open',      -- open | done | archived
        priority       INTEGER NOT NULL DEFAULT 2,        -- 0 lowest .. 4 critical
        energy         INTEGER NOT NULL DEFAULT 3,        -- 1 easy .. 5 draining
        effort_minutes INTEGER NOT NULL DEFAULT 0,
        due_at         TEXT,
        start_at       TEXT,
        recurrence     TEXT,                              -- JSON rule or NULL
        tags           TEXT NOT NULL DEFAULT '[]',
        blocked_by     TEXT NOT NULL DEFAULT '[]',        -- JSON array of item ids
        meta           TEXT NOT NULL DEFAULT '{}',        -- per-category custom fields
        position       REAL NOT NULL DEFAULT 0,
        pinned         INTEGER NOT NULL DEFAULT 0,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        completed_at   TEXT,
        deleted_at     TEXT
      );
      CREATE INDEX idx_items_user       ON items(user_id, deleted_at);
      CREATE INDEX idx_items_parent     ON items(user_id, parent_id);
      CREATE INDEX idx_items_due        ON items(user_id, due_at);
      CREATE INDEX idx_items_updated    ON items(user_id, updated_at);

      CREATE TABLE reminders (
        id             TEXT PRIMARY KEY,
        user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        item_id        TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        label          TEXT NOT NULL DEFAULT '',
        fire_at        TEXT NOT NULL,                     -- first occurrence, UTC ISO
        next_fire_at   TEXT,                              -- next pending occurrence, UTC ISO
        rrule          TEXT,                              -- JSON repeat rule or NULL
        sound_id       TEXT,                              -- sounds.id or 'builtin:<key>'
        volume         REAL NOT NULL DEFAULT 0.9,
        vibrate        INTEGER NOT NULL DEFAULT 1,
        lead_minutes   TEXT NOT NULL DEFAULT '[]',        -- JSON array of pre-alerts
        snooze_minutes INTEGER NOT NULL DEFAULT 9,
        snoozed_until  TEXT,
        escalate       INTEGER NOT NULL DEFAULT 0,        -- keep re-ringing until dismissed
        ring_seconds   INTEGER NOT NULL DEFAULT 60,
        status         TEXT NOT NULL DEFAULT 'scheduled', -- scheduled|snoozed|fired|dismissed|done
        last_fired_at  TEXT,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        deleted_at     TEXT
      );
      CREATE INDEX idx_rem_user ON reminders(user_id, deleted_at);
      CREATE INDEX idx_rem_item ON reminders(item_id);
      CREATE INDEX idx_rem_next ON reminders(user_id, next_fire_at);

      CREATE TABLE sounds (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name        TEXT NOT NULL,
        mime        TEXT NOT NULL DEFAULT 'audio/mpeg',
        size        INTEGER NOT NULL DEFAULT 0,
        data        BLOB,
        created_at  TEXT NOT NULL,
        deleted_at  TEXT
      );
      CREATE INDEX idx_sounds_user ON sounds(user_id, deleted_at);

      CREATE TABLE drawings (
        id              TEXT PRIMARY KEY,
        user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        item_id         TEXT REFERENCES items(id) ON DELETE CASCADE,
        title           TEXT NOT NULL DEFAULT '',
        strokes         TEXT NOT NULL DEFAULT '[]',       -- JSON vector strokes (pressure + tilt)
        width           INTEGER NOT NULL DEFAULT 0,
        height          INTEGER NOT NULL DEFAULT 0,
        thumbnail       TEXT NOT NULL DEFAULT '',         -- data: URL preview
        recognized_text TEXT NOT NULL DEFAULT '',
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        deleted_at      TEXT
      );
      CREATE INDEX idx_draw_user ON drawings(user_id, deleted_at);
      CREATE INDEX idx_draw_item ON drawings(item_id);

      -- Append-only event log. Powers streaks, habit stats and the insight engine.
      CREATE TABLE activity (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind       TEXT NOT NULL,
        item_id    TEXT,
        payload    TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_activity_user ON activity(user_id, created_at);

      CREATE TABLE backups (
        id         TEXT PRIMARY KEY,
        user_id    TEXT,                                  -- NULL = whole-database snapshot
        kind       TEXT NOT NULL,                         -- nightly | manual | pre-restore
        filename   TEXT NOT NULL,
        size       INTEGER NOT NULL DEFAULT 0,
        item_count INTEGER NOT NULL DEFAULT 0,
        checksum   TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_backups_created ON backups(created_at);
    `);
  },

  // 2 — handwritten entries and canvas text layers
  (d) => {
    d.exec(`
      -- An item can display as its own handwriting rather than as typed text.
      -- The title still holds the transcribed words, so search, voice and every
      -- other feature keep working on a handwritten row exactly as on a typed one.
      ALTER TABLE items ADD COLUMN display_mode TEXT NOT NULL DEFAULT 'text';
      ALTER TABLE items ADD COLUMN ink_drawing_id TEXT;

      -- Typed text placed on the canvas, alongside the ink strokes.
      ALTER TABLE drawings ADD COLUMN texts TEXT NOT NULL DEFAULT '[]';
    `);
    d.exec(`CREATE INDEX idx_items_ink ON items(user_id, ink_drawing_id);`);
  },
];

function migrate() {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    const step = MIGRATIONS[v];
    const run = db.transaction(() => {
      step(db);
      db.pragma(`user_version = ${v + 1}`);
    });
    run();
    console.log(`[db] migrated to schema version ${v + 1}`);
  }
}

migrate();

/** Parse a JSON column, falling back to a default when the value is bad or NULL. */
export function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw.length === 0) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
