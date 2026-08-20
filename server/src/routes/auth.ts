import { Router } from 'express';
import type { CookieOptions, Response } from 'express';
import { z } from 'zod';
import { db, newId, nowIso, parseJson } from '../db.js';
import { ALLOW_SIGNUP, IS_PROD, REFRESH_TOKEN_TTL_DAYS } from '../config.js';
import {
  currentUser,
  hashPassword,
  issueRefreshToken,
  requireAuth,
  revokeAllSessions,
  revokeRefreshToken,
  rotateRefreshToken,
  signAccessToken,
  verifyPassword,
  type AuthUser,
} from '../auth.js';
import { badRequest, conflict, forbidden, route, unauthorized } from '../lib/http.js';
import { seedWorkspace } from '../lib/seed.js';

export const authRouter = Router();

const REFRESH_COOKIE = 'nexus_refresh';
const cookieOptions: CookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: IS_PROD,
  path: '/api/auth',
  maxAge: REFRESH_TOKEN_TTL_DAYS * 86_400_000,
};

const credentials = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters').max(200),
  name: z.string().trim().max(80).optional(),
  locale: z.enum(['en', 'ar', 'ru']).optional(),
  timezone: z.string().max(64).optional(),
});

function respondWithSession(res: Response, user: AuthUser, refreshToken: string) {
  res.cookie(REFRESH_COOKIE, refreshToken, cookieOptions);
  res.json({ user: publicUser(user.id), accessToken: signAccessToken(user) });
}

export function publicUser(id: string) {
  const row = db
    .prepare(`SELECT id, email, name, locale, timezone, settings, created_at FROM users WHERE id = ?`)
    .get(id) as any;
  if (!row) throw unauthorized('Account no longer exists');
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    locale: row.locale,
    timezone: row.timezone,
    settings: parseJson<Record<string, unknown>>(row.settings, {}),
    createdAt: row.created_at,
  };
}

authRouter.post(
  '/signup',
  route(async (req, res) => {
    if (!ALLOW_SIGNUP) throw forbidden('Sign-ups are disabled on this server');
    const body = credentials.parse(req.body);

    const exists = db.prepare(`SELECT 1 FROM users WHERE email = ?`).get(body.email);
    if (exists) throw conflict('An account with that email already exists');

    const id = newId();
    const ts = nowIso();
    db.prepare(
      `INSERT INTO users (id, email, name, password_hash, locale, timezone, settings, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?)`,
    ).run(
      id,
      body.email,
      body.name ?? body.email.split('@')[0],
      await hashPassword(body.password),
      body.locale ?? 'en',
      body.timezone ?? 'UTC',
      ts,
      ts,
    );

    seedWorkspace(id);

    const user: AuthUser = {
      id,
      email: body.email,
      name: body.name ?? body.email.split('@')[0],
      locale: body.locale ?? 'en',
      timezone: body.timezone ?? 'UTC',
    };
    respondWithSession(res, user, issueRefreshToken(id, String(req.headers['user-agent'] ?? '')));
  }),
);

authRouter.post(
  '/login',
  route(async (req, res) => {
    const body = credentials.pick({ email: true, password: true }).parse(req.body);
    const row = db.prepare(`SELECT * FROM users WHERE email = ?`).get(body.email) as any;
    // Same message either way so the endpoint can't be used to enumerate accounts.
    if (!row || !(await verifyPassword(body.password, row.password_hash))) {
      throw unauthorized('Email or password is incorrect');
    }
    const user: AuthUser = {
      id: row.id,
      email: row.email,
      name: row.name,
      locale: row.locale,
      timezone: row.timezone,
    };
    respondWithSession(res, user, issueRefreshToken(user.id, String(req.headers['user-agent'] ?? '')));
  }),
);

authRouter.post(
  '/refresh',
  route((req, res) => {
    const token = req.cookies?.[REFRESH_COOKIE];
    if (!token) throw unauthorized('No session cookie');
    const { user, refreshToken } = rotateRefreshToken(token, String(req.headers['user-agent'] ?? ''));
    respondWithSession(res, user, refreshToken);
  }),
);

authRouter.post(
  '/logout',
  route((req, res) => {
    const token = req.cookies?.[REFRESH_COOKIE];
    if (token) revokeRefreshToken(token);
    res.clearCookie(REFRESH_COOKIE, { ...cookieOptions, maxAge: undefined });
    res.json({ ok: true });
  }),
);

authRouter.get(
  '/me',
  requireAuth,
  route((req, res) => res.json({ user: publicUser(currentUser(req).id) })),
);

const profilePatch = z.object({
  name: z.string().trim().max(80).optional(),
  locale: z.enum(['en', 'ar', 'ru']).optional(),
  timezone: z.string().max(64).optional(),
  settings: z.record(z.unknown()).optional(),
});

authRouter.patch(
  '/me',
  requireAuth,
  route((req, res) => {
    const user = currentUser(req);
    const patch = profilePatch.parse(req.body);
    const existing = publicUser(user.id);
    db.prepare(
      `UPDATE users SET name = ?, locale = ?, timezone = ?, settings = ?, updated_at = ? WHERE id = ?`,
    ).run(
      patch.name ?? existing.name,
      patch.locale ?? existing.locale,
      patch.timezone ?? existing.timezone,
      JSON.stringify(patch.settings ? { ...existing.settings, ...patch.settings } : existing.settings),
      nowIso(),
      user.id,
    );
    res.json({ user: publicUser(user.id) });
  }),
);

authRouter.post(
  '/password',
  requireAuth,
  route(async (req, res) => {
    const body = z
      .object({ currentPassword: z.string(), newPassword: z.string().min(8).max(200) })
      .parse(req.body);
    const user = currentUser(req);
    const row = db.prepare(`SELECT password_hash FROM users WHERE id = ?`).get(user.id) as any;
    if (!row || !(await verifyPassword(body.currentPassword, row.password_hash))) {
      throw badRequest('Current password is incorrect');
    }
    db.prepare(`UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`).run(
      await hashPassword(body.newPassword),
      nowIso(),
      user.id,
    );
    // Changing a password should end every other session.
    revokeAllSessions(user.id);
    res.clearCookie(REFRESH_COOKIE, { ...cookieOptions, maxAge: undefined });
    res.json({ ok: true, message: 'Password updated. Please sign in again.' });
  }),
);
