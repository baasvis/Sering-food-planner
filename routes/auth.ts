// ─────────────────────────────────────────────────────────────────────────────
// AUTHENTICATION ROUTES
// ─────────────────────────────────────────────────────────────────────────────

import express, { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import { CONFIG, cookieOpts } from '../lib/config';
import type { AppUser } from '../shared/types';

const router = express.Router();
const authClient = new OAuth2Client(CONFIG.GOOGLE_CLIENT_ID);
const sessions = new Map<string, AppUser>();

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

function getSessionUser(req: Request): AppUser | null {
  const sessionId = parseCookie(req.headers.cookie || '', 'session');
  if (!sessionId) return null;
  return sessions.get(sessionId) || null;
}

// Auth: exchange Google ID token for session cookie
router.post('/google', async (req: Request, res: Response) => {
  const { idToken } = req.body;
  if (!idToken) return res.status(400).json({ error: 'idToken required' });

  // Dev mode: no GOOGLE_CLIENT_ID configured
  if (!CONFIG.GOOGLE_CLIENT_ID) {
    const sessionId = generateSessionId();
    sessions.set(sessionId, { email: 'dev@local', name: 'Dev Mode', picture: null });
    res.cookie('session', sessionId, cookieOpts());
    return res.json({ ok: true, user: { email: 'dev@local', name: 'Dev Mode' } });
  }

  try {
    const user = await verifyGoogleToken(idToken);
    if (CONFIG.ALLOWED_EMAILS.length > 0 && !CONFIG.ALLOWED_EMAILS.includes(user.email)) {
      console.warn(`Login denied for ${user.email} — not in ALLOWED_EMAILS`);
      return res.status(403).json({ error: 'not_allowed', message: 'Je account heeft geen toegang. Vraag je teamleider om je e-mail toe te voegen.' });
    }
    const sessionId = generateSessionId();
    sessions.set(sessionId, user);
    res.cookie('session', sessionId, cookieOpts());
    return res.json({ ok: true, user: { email: user.email, name: user.name, picture: user.picture } });
  } catch (e: any) {
    console.error('Auth error:', e.message);
    return res.status(401).json({ error: 'Invalid token' });
  }
});

router.post('/logout', (req: Request, res: Response) => {
  const sessionId = parseCookie(req.headers.cookie || '', 'session');
  if (sessionId) sessions.delete(sessionId);
  res.clearCookie('session');
  res.json({ ok: true });
});

router.get('/me', (req: Request, res: Response) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ user });
});

// Middleware: protect all /api/* except auth + health
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (req.path.startsWith('/auth/') || req.path === '/health') return next();
  if (!CONFIG.GOOGLE_CLIENT_ID) return next(); // dev mode
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Authentication required' });
  req.user = user;
  next();
}

export default router;
