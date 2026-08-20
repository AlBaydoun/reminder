import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const bool = (v: string | undefined, fallback: boolean) =>
  v === undefined ? fallback : /^(1|true|yes|on)$/i.test(v);

const int = (v: string | undefined, fallback: number) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
};

export const NODE_ENV = process.env.NODE_ENV ?? 'development';
export const IS_PROD = NODE_ENV === 'production';
export const PORT = int(process.env.PORT, 4000);

export const DATA_DIR = path.resolve(process.env.DATA_DIR ?? './data');
export const DB_PATH = path.join(DATA_DIR, 'nexus.db');
export const BACKUP_DIR = path.join(DATA_DIR, 'backups');
export const UPLOAD_LIMIT_BYTES = 12 * 1024 * 1024; // 12 MB — plenty for a custom alarm sound

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });

/**
 * In production a JWT secret must be supplied explicitly — a server that
 * invents one on boot would silently invalidate every session on restart.
 * In development we persist a generated secret so restarts stay painless.
 */
function resolveJwtSecret(): string {
  const fromEnv = process.env.JWT_SECRET?.trim();
  if (fromEnv) return fromEnv;
  if (IS_PROD) {
    throw new Error(
      'JWT_SECRET is required in production. Generate one with:\n' +
        '  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"',
    );
  }
  const devSecretPath = path.join(DATA_DIR, '.dev-jwt-secret');
  if (fs.existsSync(devSecretPath)) return fs.readFileSync(devSecretPath, 'utf8').trim();
  const generated = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(devSecretPath, generated, { mode: 0o600 });
  console.warn('[config] No JWT_SECRET set — generated a development secret at', devSecretPath);
  return generated;
}

export const JWT_SECRET = resolveJwtSecret();
export const ACCESS_TOKEN_TTL = '30m';
export const REFRESH_TOKEN_TTL_DAYS = 30;

export const ALLOW_SIGNUP = bool(process.env.ALLOW_SIGNUP, true);
export const BACKUP_CRON = process.env.BACKUP_CRON ?? '0 3 * * *';
export const BACKUP_KEEP_DAILY = int(process.env.BACKUP_KEEP_DAILY, 30);
export const BACKUP_KEEP_MONTHLY = int(process.env.BACKUP_KEEP_MONTHLY, 12);

export const CORS_ORIGINS = (process.env.CORS_ORIGIN ?? 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
