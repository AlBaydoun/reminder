import express from 'express';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORS_ORIGINS, IS_PROD, PORT } from './config.js';
import { db, nowIso } from './db.js';
import { sendError } from './lib/http.js';
import { authRouter } from './routes/auth.js';
import { itemsRouter } from './routes/items.js';
import { remindersRouter } from './routes/reminders.js';
import { soundsRouter } from './routes/sounds.js';
import { drawingsRouter } from './routes/drawings.js';
import { backupsRouter } from './routes/backups.js';
import { brainRouter } from './routes/brain.js';
import { batchRouter } from './routes/batch.js';
import { startBackupSchedule } from './backup.js';
import { rescheduleAll } from './lib/reminders.js';

const app = express();
app.set('trust proxy', 1);

app.use(compression());
app.use(express.json({ limit: '8mb' }));
app.use(cookieParser());
app.use(
  cors({
    origin(origin, callback) {
      // Same-origin requests (and curl) send no Origin header at all.
      if (!origin || CORS_ORIGINS.includes(origin)) return callback(null, true);
      callback(new Error(`Origin ${origin} is not allowed`));
    },
    credentials: true,
  }),
);

// Credential endpoints get a tighter budget than the rest of the API.
app.use(
  '/api/auth/login',
  rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false }),
);
app.use(
  '/api/auth/signup',
  rateLimit({ windowMs: 60 * 60_000, limit: 10, standardHeaders: true, legacyHeaders: false }),
);
app.use('/api', rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: true, legacyHeaders: false }));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    serverTime: nowIso(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    users: (db.prepare(`SELECT COUNT(*) AS n FROM users`).get() as { n: number }).n,
  });
});

app.use('/api/auth', authRouter);
app.use('/api/items', itemsRouter);
app.use('/api/reminders', remindersRouter);
app.use('/api/sounds', soundsRouter);
app.use('/api/drawings', drawingsRouter);
app.use('/api/backups', backupsRouter);
app.use('/api/brain', brainRouter);
app.use('/api/batch', batchRouter);

app.use('/api', (_req, res) => res.status(404).json({ error: 'No such endpoint', code: 'not_found' }));

// In production the API also serves the built front-end, so cookies stay
// same-origin and there is a single process to deploy.
const here = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.resolve(here, '../../web/dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist, { maxAge: IS_PROD ? '1y' : 0, index: false }));
  app.get('*', (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
  console.log('[web] serving built front-end from', webDist);
}

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  sendError(res, err);
});

const server = app.listen(PORT, () => {
  console.log(`[nexus] API listening on http://localhost:${PORT}`);
  startBackupSchedule();

  // Clocks drift, machines sleep, timezones change. Recompute every pending
  // reminder at boot so nothing is left pointing at a stale fire time.
  const users = db.prepare(`SELECT id FROM users`).all() as Array<{ id: string }>;
  let total = 0;
  for (const u of users) total += rescheduleAll(u.id);
  if (total) console.log(`[nexus] re-armed ${total} reminder(s) across ${users.length} account(s)`);
});

const shutdown = (signal: string) => {
  console.log(`\n[nexus] ${signal} received, shutting down`);
  server.close(() => {
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.close();
    } catch (err) {
      console.error('[nexus] error closing database', err);
    }
    process.exit(0);
  });
  // Do not hang forever on a stuck connection.
  setTimeout(() => process.exit(1), 8000).unref();
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
