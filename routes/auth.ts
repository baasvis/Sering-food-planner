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

import express, { Request, Response, NextFunction, RequestHandler } from 'express';
import crypto from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import { CONFIG, cookieOpts, errMsg, asyncHandler } from '../lib/config';
import { prisma, dbAppendLog } from '../lib/db';
import type { AppUser } from '../shared/types';

const router = express.Router();
const authClient = new OAuth2Client(CONFIG.GOOGLE_CLIENT_ID);

// 7 days, matches cookieOpts().maxAge in lib/config.ts.
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function generateSessionId(): string {
  return crypto.randomBytes(32).toString('hex');
}

// Lightweight per-IP throttle for the unauthenticated /request-access endpoint
// (mirrors routes/telemetry.ts). Single-replica, so an in-memory map is fine.
const reqAccessRate = new Map<string, { count: number; resetAt: number }>();
const REQ_ACCESS_LIMIT = 10;       // requests per window per IP
const REQ_ACCESS_WINDOW = 60_000;  // 1 minute
function accessRequestRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = reqAccessRate.get(ip);
  if (!entry || now > entry.resetAt) {
    reqAccessRate.set(ip, { count: 1, resetAt: now + REQ_ACCESS_WINDOW });
    return false;
  }
  entry.count++;
  return entry.count > REQ_ACCESS_LIMIT;
}
const reqAccessCleanup = setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of reqAccessRate) if (now > entry.resetAt) reqAccessRate.delete(ip);
}, 5 * 60_000);
reqAccessCleanup.unref();

/** Compute whether the given email is on the director allowlist for the
 *  private AI recipe assistant. Exported so routes/recipe-ai.ts and any
 *  future director-gated feature share one source of truth. */
export function isDirectorEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return CONFIG.DIRECTOR_EMAILS.includes(email.toLowerCase());
}

/** Whether the given email is on the staff-lead allowlist — gates the
 *  Competencies admin actions (chunk sync, event corrections, people). */
export function isStaffLeadEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return CONFIG.STAFF_LEAD_EMAILS.includes(email.toLowerCase());
}

/** Whether the given email is a manager — director ∪ MANAGER_EMAILS. Gates the
 *  drinks-module money/supplier/publish writes (GOAL §5). Directors are always
 *  managers. Exported so routes/drinks.ts shares one source of truth. */
export function isManagerEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return isDirectorEmail(email) || CONFIG.MANAGER_EMAILS.includes(email.toLowerCase());
}

/** Director-only gate for admin endpoints. requireAuth must run first so
 *  req.user is populated. Shared by routes/access.ts and routes/recipe-ai.ts
 *  (one source of truth for the director check). */
export function requireDirector(req: Request, res: Response, next: NextFunction): void {
  if (!isDirectorEmail(req.user?.email)) {
    res.status(403).json({ error: 'Forbidden', message: 'Director access required.' });
    return;
  }
  next();
}

/** Manager-only gate for unconditionally manager-gated endpoints. requireAuth
 *  must run first so req.user is populated. (routes/drinks.ts mostly uses an
 *  inline manager check so it can keep recipe-mode drafting open while gating
 *  catalogue/money writes — but this middleware is the shared mechanism.) */
export function requireManager(req: Request, res: Response, next: NextFunction): void {
  if (!isManagerEmail(req.user?.email)) {
    res.status(403).json({ error: 'Forbidden', message: 'Manager access required.' });
    return;
  }
  next();
}

type RequestOutcome = 'pending' | 'approved' | 'denied' | 'revoked';

/** Effective login allowlist = CONFIG.ALLOWED_EMAILS (env — the bootstrap
 *  backbone) UNION access_requests rows with status="approved". Lets a director
 *  grant access from the Team screen without an env-var edit or redeploy.
 *  Purely additive: the env list and the production fail-closed boot guard in
 *  server.ts are unchanged, so an empty env allowlist in production still
 *  refuses to boot — DB approvals only ever add to the env backbone. */
export async function isEmailAllowed(email: string): Promise<boolean> {
  const e = email.toLowerCase();
  if (CONFIG.ALLOWED_EMAILS.includes(e)) return true;
  const row = await prisma.accessRequest.findUnique({ where: { email: e } });
  return row?.status === 'approved';
}

/** Record (or look up) an access request for a Google-authenticated email that
 *  isn't allowed yet. A brand-new email is stored as "pending". An existing
 *  "denied"/"revoked" row is NOT silently re-opened (a rejected person can't
 *  spam their way back in) — a director can re-approve it from the Team screen.
 *  Returns the resulting status so the login screen can show the right message. */
export async function recordAccessRequest(
  user: AppUser,
  names?: { firstName?: string; lastName?: string },
): Promise<RequestOutcome> {
  const e = user.email.toLowerCase();
  // Cap lengths so the unauthenticated request path can't store huge strings
  // (the only other bound is the global 2 MB JSON body limit).
  const firstName = names?.firstName?.trim().slice(0, 100) || null;
  const lastName = names?.lastName?.trim().slice(0, 100) || null;
  const structured = !!(firstName || lastName);
  // Explicit "request access" gives a first+last name; the auto-queue fallback
  // (a denied normal login) has only the Google display name.
  const fullName = (structured ? [firstName, lastName].filter(Boolean).join(' ') : user.name).slice(0, 200);
  const existing = await prisma.accessRequest.findUnique({ where: { email: e } });
  if (!existing) {
    try {
      await prisma.accessRequest.create({
        data: { id: crypto.randomUUID(), email: e, name: fullName, firstName, lastName, picture: user.picture ?? null, status: 'pending' },
      });
      await dbAppendLog(e, fullName, 'access_requested', 'New access request');
      return 'pending';
    } catch (err: unknown) {
      // Lost a race with a concurrent first-time request for the same email
      // (the email UNIQUE constraint, P2002) — treat it as an existing row.
      if ((err as { code?: string })?.code !== 'P2002') throw err;
      const row = await prisma.accessRequest.findUnique({ where: { email: e } });
      return (row?.status ?? 'pending') as RequestOutcome;
    }
  }
  // Refresh a still-pending request: prefer a freshly-supplied structured name;
  // otherwise only fall back to the Google name if no structured name exists yet
  // (so a denied re-login can't clobber a name the person already typed).
  if (existing.status === 'pending') {
    const data: { picture: string | null; name?: string; firstName?: string | null; lastName?: string | null } = { picture: user.picture ?? null };
    if (structured) { data.name = fullName; data.firstName = firstName; data.lastName = lastName; }
    else if (!existing.firstName && !existing.lastName) { data.name = user.name.slice(0, 200); }
    await prisma.accessRequest.update({ where: { email: e }, data });
  }
  return existing.status as RequestOutcome;
}

/** Login-screen message for each access-request outcome. */
function accessRequestMessage(status: RequestOutcome): string {
  switch (status) {
    case 'pending':
      return 'Your access request has been sent. Daan will approve it — you can log in as soon as that happens.';
    case 'approved':
      return 'You already have access — just sign in with Google.';
    case 'denied':
    case 'revoked':
      return 'Your account does not have access. Ask your team lead to add you.';
  }
}

// Stamp the derived auth flags onto a user object. Named `withDirector`
// historically; now also sets isManager (director ∪ MANAGER_EMAILS) so the
// drinks-module affordances light up for managers.
function withDirector(user: AppUser): AppUser {
  return { ...user, isDirector: isDirectorEmail(user.email), isManager: isManagerEmail(user.email) };
}

/** Resolve a user's per-screen page permissions from their assigned role.
 *  Empty map = no role = full edit (legacy behavior for env-listed / pre-role
 *  users). Directors ignore this (the frontend treats them as full edit). Called
 *  only at login / GET /auth/me — never per-request — so the extra queries are
 *  cheap. Frontend-only guardrail; nothing here gates server-side writes. */
export async function resolvePermissions(email: string): Promise<Record<string, string>> {
  const e = email.toLowerCase();
  const req = await prisma.accessRequest.findUnique({ where: { email: e }, select: { roleId: true } });
  if (!req?.roleId) return {};
  const role = await prisma.role.findUnique({ where: { id: req.roleId }, select: { permissions: true } });
  return (role?.permissions as Record<string, string>) ?? {};
}

/** Middleware: require server-side 'edit' on a screen. Hard-locks the sensitive
 *  write paths (Finance, ingredient prices) so view-only is a real lock there,
 *  not just a UI guardrail. Directors and no-role (full-edit) users pass.
 *  resolvePermissions runs only on these gated endpoints — no hot-path cost. */
export function requireScreenEdit(screenId: string): RequestHandler {
  return asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const email = req.user?.email;
    // No authenticated user → dev-mode anonymous passthrough (in production
    // requireAuth already 401s before this point). Defer to that rather than
    // imposing stricter auth here than the rest of the app.
    if (!email) { next(); return; }
    if (isDirectorEmail(email)) { next(); return; }
    const perms = await resolvePermissions(email);
    const level = Object.keys(perms).length === 0 ? 'edit' : (perms[screenId] || 'hidden');
    if (level !== 'edit') {
      res.status(403).json({ error: 'view_only', message: 'You have view-only access to this page.' });
      return;
    }
    next();
  });
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

// Split-based cookie parser — deliberately does NOT build a RegExp from `name`
// (prior SEC-5/S14): interpolating a caller-supplied name into `new RegExp(...)`
// is a latent ReDoS / mis-match footgun.
//
// Behaviour matches the old `(?:^|;\s*)name=([^;]+)` regex on every real input
// (`name` is only ever the literal 'session', and `cookieHeader` is always
// `req.headers.cookie`, which per RFC 6265 is `a=1; b=2` with no leading
// whitespace before the first cookie): find the first cookie whose name equals
// `name`, return its value, or null when the cookie is absent or has an empty
// value. The one intentional difference is that this is slightly more lenient —
// it also trims whitespace before the *first* cookie name (the old regex only
// trimmed after a `;`), which the standard library cookie parsers do too and
// which never occurs on a real Cookie header.
function parseCookie(cookieHeader: string, name: string): string | null {
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1);
    // The old regex captured `([^;]+)` (one-or-more), so an empty value
    // (`session=`) did not match — preserve that by returning null.
    return value.length > 0 ? value : null;
  }
  return null;
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
  return withDirector({ email: row.email, name: row.name, picture: row.picture });
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

  // Dev mode: GOOGLE_CLIENT_ID empty AND AUTH_MODE != 'production'. The
  // AUTH_MODE check (audit S3/S4) means a prod deploy that loses
  // GOOGLE_CLIENT_ID via env-var rotation can't silently fall through to
  // the dev shortcut — server.ts refuses to boot in that state.
  if (!CONFIG.GOOGLE_CLIENT_ID && CONFIG.AUTH_MODE !== 'production') {
    const devUser: AppUser = withDirector({ email: 'dev@local', name: 'Dev Mode', picture: null });
    const sessionId = await createSession(devUser);
    res.cookie('session', sessionId, cookieOpts());
    return res.json({ ok: true, user: { email: devUser.email, name: devUser.name, isDirector: devUser.isDirector, isManager: devUser.isManager, permissions: await resolvePermissions(devUser.email) } });
  }

  try {
    const user = await verifyGoogleToken(idToken);
    // Defense-in-depth (audit S4): in production, an empty ALLOWED_EMAILS
    // means deny-all (the boot guard in server.ts also refuses to start in
    // this state, but the runtime check ensures fail-closed if the boot
    // guard is ever weakened).
    if (CONFIG.ALLOWED_EMAILS.length === 0) {
      if (CONFIG.AUTH_MODE === 'production') {
        console.error('Login denied: ALLOWED_EMAILS is empty in AUTH_MODE=production');
        return res.status(503).json({ error: 'not_configured', message: 'Auth is not configured. Contact your admin.' });
      }
      // Dev/staging: keep today's behaviour — log a clear warning instead.
      console.warn(`Allowing login for ${user.email} — ALLOWED_EMAILS is empty (dev mode).`);
    } else if (!(await isEmailAllowed(user.email))) {
      // Not on the env allowlist and not DB-approved. Don't dead-end: record a
      // pending access request (unless a prior deny/revoke decision stands) so a
      // director can approve from the Team screen, and tell the user what happened.
      const status = await recordAccessRequest(user);
      console.warn(`Login denied for ${user.email} — not allowed (access request: ${status})`);
      return res.status(403).json({ error: 'not_allowed', status, message: accessRequestMessage(status) });
    }
    const userWithRole = withDirector(user);
    const sessionId = await createSession(userWithRole);
    res.cookie('session', sessionId, cookieOpts());
    return res.json({ ok: true, user: { email: userWithRole.email, name: userWithRole.name, picture: userWithRole.picture, isDirector: userWithRole.isDirector, isManager: userWithRole.isManager, permissions: await resolvePermissions(userWithRole.email) } });
  } catch (e: unknown) {
    console.error('Auth error:', errMsg(e));
    return res.status(401).json({ error: 'Invalid token' });
  }
}));

// Self-service access request: a Google-authenticated user who isn't on the
// allowlist asks to be let in. Verifying the Google token first means every
// request is a real account (no anonymous spam), and the per-email upsert in
// recordAccessRequest means one account can't flood the table. Mounted under
// /api/auth (before requireAuth), like /google.
router.post('/request-access', asyncHandler(async (req: Request, res: Response) => {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  if (accessRequestRateLimited(ip)) {
    return res.status(429).json({ error: 'rate_limited', message: 'Too many requests. Please wait a minute and try again.' });
  }
  const { idToken, firstName, lastName } = req.body;
  if (!idToken) return res.status(400).json({ error: 'idToken required' });
  const fn = typeof firstName === 'string' ? firstName.trim() : '';
  const ln = typeof lastName === 'string' ? lastName.trim() : '';
  if (!fn || !ln) {
    return res.status(400).json({ error: 'name_required', message: 'First and last name are required.' });
  }
  const names = { firstName: fn, lastName: ln };

  // Dev mode (no GOOGLE_CLIENT_ID, not production): synthesise a requester so
  // the flow is exercisable locally without real Google auth.
  if (!CONFIG.GOOGLE_CLIENT_ID && CONFIG.AUTH_MODE !== 'production') {
    const devUser: AppUser = { email: 'requester@local', name: `${fn} ${ln}`, picture: null };
    const status = await recordAccessRequest(devUser, names);
    return res.json({ ok: true, status, message: accessRequestMessage(status) });
  }

  try {
    const user = await verifyGoogleToken(idToken);
    if (await isEmailAllowed(user.email)) {
      // Already allowed — nothing to request; point them at the normal login.
      return res.json({ ok: true, status: 'approved', message: accessRequestMessage('approved') });
    }
    const status = await recordAccessRequest(user, names);
    return res.json({ ok: true, status, message: accessRequestMessage(status) });
  } catch (e: unknown) {
    console.error('Access request error:', errMsg(e));
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
  const permissions = await resolvePermissions(user.email);
  res.json({ user: { ...user, permissions } });
}));

// Middleware: protect all /api/* except auth + health
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (req.path.startsWith('/auth/') || req.path === '/health') { next(); return; }
  // Dev mode bypass: only when GOOGLE_CLIENT_ID is empty AND AUTH_MODE is
  // not 'production'. server.ts refuses to boot if AUTH_MODE='production'
  // and GOOGLE_CLIENT_ID is empty, so the prod-with-rotated-env-var
  // scenario can't reach this fallthrough. (Audit S3/S4.)
  const devMode = !CONFIG.GOOGLE_CLIENT_ID && CONFIG.AUTH_MODE !== 'production';
  // getSessionUser is now async (Postgres lookup). The middleware contract
  // can't itself be async without breaking Express's type definitions, so we
  // resolve the promise and forward via the next() callback.
  // Always attempt to populate req.user — even in dev mode — so downstream
  // role checks (e.g. requireDirector) and audit-log helpers see who's
  // logged in. Dev mode only relaxes the "must have a session to proceed"
  // requirement; it doesn't deliberately strip identity.
  getSessionUser(req).then(user => {
    if (user) {
      req.user = user;
      next();
      return;
    }
    if (devMode) {
      // No session yet — let the request through anonymously (the login
      // page calls /api/auth/google to get one).
      next();
      return;
    }
    res.status(401).json({ error: 'Authentication required' });
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
