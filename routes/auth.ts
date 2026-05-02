// ─────────────────────────────────────────────────────────────────────────────
// AUTHENTICATION ROUTES
//
// Sessions are persisted in Postgres (table `sessions`). Previously they lived
// in an in-process `Map<string, AppUser>` which was cleared on every Railway
// restart — the cookie outlived the server-side state and users had to log in
// again. (Triage U1, audit §2.4.)
//
// The cookie's `maxAge` (7 days, see lib/config.ts#cookieOpts) is mirrored on
// the row's `expiresAt`. Stale rows are pruned by a daily cron in server.ts.
// ─────────────────────────────────────────────────────────────────────────────

import express, { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import { CONFIG, cookieOpts, errMsg, asyncHandler } from '../lib/config';
import { prisma } from '../lib/db';
import type { AppUser } from '../shared/types';

const router = express.Router();
const authClient = new OAuth2Client(CONFIG.GOOGLE_CLIENT_ID);

// 7 days, matches cookieOpts().maxAge in lib/config.ts.
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function generateSessionId(): string {
  return crypto.randomBytes(32).toString('hex');
}

async function verifyGoogleToken(idToken: string): Promise<AppUser> {
  const ticket = await authClient.verifyIdToken({
    idToken,
    audience: CONFIG.GOOGLE_CLIENT_ID,
  });
  const payload = ticket.getPayload()!;
  return {
    email: payload.email!.toLowerCase(),
    name: payload.name || payload.email!,
    picture: payload.picture || null,
  };
}

function parseCookie(cookieHeader: string, name: string): string | null {
  const match = cookieHeader.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return match ? match[1] : null;
}

/** Resolve a request's session cookie to a user record, or null if the
 *  cookie is missing/unknown/expired. Expired rows are deleted lazily on
 *  read so a stale cookie can't be reused after expiry even if the daily
 *  cleanup hasn't run yet. */
async function getSessionUser(req: Request): Promise<AppUser | null> {
  const sessionId = parseCookie(req.headers.cookie || '', 'session');
  if (!sessionId) return null;
  const row = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!row) return null;
  if (row.expiresAt.getTime() < Date.now()) {
    // Lazy expiry: drop the row so the cookie can't be reused on the next
    // request either. Safe to ignore failures — daily cron will sweep.
    prisma.session.delete({ where: { id: sessionId } }).catch(() => {});
    return null;
  }
  return { email: row.email, name: row.name, picture: row.picture };
}

async function createSession(user: AppUser): Promise<string> {
  const sessionId = generateSessionId();
  await prisma.session.create({
    data: {
      id: sessionId,
      email: user.email,
      name: user.name,
      picture: user.picture ?? null,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    },
  });
  return sessionId;
}

// Auth: exchange Google ID token for session cookie
router.post('/google', asyncHandler(async (req: Request, res: Response) => {
  const { idToken } = req.body;
  if (!idToken) return res.status(400).json({ error: 'idToken required' });

  // Dev mode: no GOOGLE_CLIENT_ID configured
  if (!CONFIG.GOOGLE_CLIENT_ID) {
    const devUser: AppUser = { email: 'dev@local', name: 'Dev Mode', picture: null };
    const sessionId = await createSession(devUser);
    res.cookie('session', sessionId, cookieOpts());
    return res.json({ ok: true, user: { email: devUser.email, name: devUser.name } });
  }

  try {
    const user = await verifyGoogleToken(idToken);
    if (CONFIG.ALLOWED_EMAILS.length > 0 && !CONFIG.ALLOWED_EMAILS.includes(user.email)) {
      console.warn(`Login denied for ${user.email} — not in ALLOWED_EMAILS`);
      return res.status(403).json({ error: 'not_allowed', message: 'Je account heeft geen toegang. Vraag je teamleider om je e-mail toe te voegen.' });
    }
    const sessionId = await createSession(user);
    res.cookie('session', sessionId, cookieOpts());
    return res.json({ ok: true, user: { email: user.email, name: user.name, picture: user.picture } });
  } catch (e: unknown) {
    console.error('Auth error:', errMsg(e));
    return res.status(401).json({ error: 'Invalid token' });
  }
}));

router.post('/logout', asyncHandler(async (req: Request, res: Response) => {
  const sessionId = parseCookie(req.headers.cookie || '', 'session');
  if (sessionId) {
    // Delete is best-effort — if the row's already gone, that's fine.
    await prisma.session.deleteMany({ where: { id: sessionId } });
  }
  res.clearCookie('session');
  res.json({ ok: true });
}));

router.get('/me', asyncHandler(async (req: Request, res: Response) => {
  const user = await getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ user });
}));

// Middleware: protect all /api/* except auth + health
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (req.path.startsWith('/auth/') || req.path === '/health') { next(); return; }
  if (!CONFIG.GOOGLE_CLIENT_ID) { next(); return; } // dev mode bypass
  // getSessionUser is now async (Postgres lookup). The middleware contract
  // can't itself be async without breaking Express's type definitions, so we
  // resolve the promise and forward via the next() callback.
  getSessionUser(req).then(user => {
    if (!user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    req.user = user;
    next();
  }).catch(next);
}

/** Delete every expired session in one query. Used by the daily cron in
 *  server.ts so the table doesn't grow unboundedly. */
export async function cleanupExpiredSessions(): Promise<number> {
  const result = await prisma.session.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return result.count;
}

export default router;
