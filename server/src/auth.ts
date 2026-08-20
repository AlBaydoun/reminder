import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';
import { db, newId, nowIso } from './db.js';
import { ACCESS_TOKEN_TTL, JWT_SECRET, REFRESH_TOKEN_TTL_DAYS } from './config.js';
import { unauthorized } from './lib/http.js';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  locale: string;
  timezone: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export const hashPassword = (plain: string) => bcrypt.hash(plain, 12);
export const verifyPassword = (plain: string, hash: string) => bcrypt.compare(plain, hash);

export function signAccessToken(user: AuthUser): string {
  return jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, {
    expiresIn: ACCESS_TOKEN_TTL,
  });
}

const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

export function issueRefreshToken(userId: string, userAgent = ''): string {
  const token = crypto.randomBytes(48).toString('base64url');
  const expires = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 86_400_000).toISOString();
  db.prepare(
    `INSERT INTO refresh_tokens (id, user_id, token_hash, user_agent, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(newId(), userId, hashToken(token), userAgent.slice(0, 255), expires, nowIso());
  return token;
}

/**
 * Refresh tokens rotate: presenting one consumes it and returns a fresh pair.
 * A revoked-but-valid token means the cookie was replayed, so we drop the whole
 * family and force a re-login rather than handing out new credentials.
 */
export function rotateRefreshToken(
  token: string,
  userAgent = '',
): { user: AuthUser; refreshToken: string } {
  const row = db
    .prepare(`SELECT * FROM refresh_tokens WHERE token_hash = ?`)
    .get(hashToken(token)) as
    | { id: string; user_id: string; expires_at: string; revoked_at: string | null }
    | undefined;

  if (!row) throw unauthorized('Session expired, please sign in again');

  if (row.revoked_at) {
    db.prepare(`UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`)
      .run(nowIso(), row.user_id);
    throw unauthorized('Session reuse detected, please sign in again');
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    throw unauthorized('Session expired, please sign in again');
  }

  db.prepare(`UPDATE refresh_tokens SET revoked_at = ? WHERE id = ?`).run(nowIso(), row.id);

  const user = getUserById(row.user_id);
  if (!user) throw unauthorized('Account no longer exists');
  return { user, refreshToken: issueRefreshToken(user.id, userAgent) };
}

export function revokeRefreshToken(token: string) {
  db.prepare(`UPDATE refresh_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL`)
    .run(nowIso(), hashToken(token));
}

export function revokeAllSessions(userId: string) {
  db.prepare(`UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`)
    .run(nowIso(), userId);
}

export function purgeExpiredTokens() {
  db.prepare(`DELETE FROM refresh_tokens WHERE expires_at < ?`).run(nowIso());
}

export function getUserById(id: string): AuthUser | undefined {
  const row = db
    .prepare(`SELECT id, email, name, locale, timezone FROM users WHERE id = ?`)
    .get(id) as AuthUser | undefined;
  return row;
}

/** Require a valid access token; populates `req.user`. */
export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return next(unauthorized());
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { sub?: string };
    if (!payload.sub) return next(unauthorized());
    const user = getUserById(payload.sub);
    if (!user) return next(unauthorized('Account no longer exists'));
    req.user = user;
    next();
  } catch {
    next(unauthorized('Session expired'));
  }
}

/** Convenience for routes that run after `requireAuth`. */
export function currentUser(req: Request): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}
