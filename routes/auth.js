// ─────────────────────────────────────────────────────────────────────────────
// AUTHENTICATION ROUTES
// ─────────────────────────────────────────────────────────────────────────────

const router = require('express').Router();
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const { CONFIG, cookieOpts } = require('../lib/config');

const authClient = new OAuth2Client(CONFIG.GOOGLE_CLIENT_ID);
const sessions = new Map(); // sessionId → { email, name, picture }

function generateSessionId() {
  return crypto.randomBytes(32).toString('hex');
}

async function verifyGoogleToken(idToken) {
  const ticket = await authClient.verifyIdToken({
    idToken,
    audience: CONFIG.GOOGLE_CLIENT_ID,
  });
  const payload = ticket.getPayload();
  return {
    email: payload.email.toLowerCase(),
    name: payload.name || payload.email,
    picture: payload.picture || null,
  };
}

function parseCookie(cookieHeader, name) {
  const match = cookieHeader.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return match ? match[1] : null;
}

function getSessionUser(req) {
  const sessionId = parseCookie(req.headers.cookie || '', 'session');
  if (!sessionId) return null;
  return sessions.get(sessionId) || null;
}

// Auth: exchange Google ID token for session cookie
router.post('/google', async (req, res) => {
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
  } catch (e) {
    console.error('Auth error:', e.message);
    return res.status(401).json({ error: 'Invalid token' });
  }
});

router.post('/logout', (req, res) => {
  const sessionId = parseCookie(req.headers.cookie || '', 'session');
  if (sessionId) sessions.delete(sessionId);
  res.clearCookie('session');
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ user });
});

// Middleware: protect all /api/* except auth + health
function requireAuth(req, res, next) {
  if (req.path.startsWith('/auth/') || req.path === '/health') return next();
  if (!CONFIG.GOOGLE_CLIENT_ID) return next(); // dev mode
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Authentication required' });
  req.user = user;
  next();
}

module.exports = router;
module.exports.requireAuth = requireAuth;
