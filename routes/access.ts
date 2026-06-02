// ─────────────────────────────────────────────────────────────────────────────
// ACCESS — director-only review of account-access requests.
//
// New people sign in with Google and land in the access_requests table as
// "pending" (see routes/auth.ts). A director approves/denies them here, can
// revoke a previously-approved user, and can edit the name. Approving adds the
// email to the effective login allowlist (env list UNION approved rows) — no
// env-var edit / redeploy — and creates/links a Training (competencies) person
// so the account is the source of that person's name. All endpoints are gated
// by requireDirector and mounted AFTER requireAuth so req.user is populated.
// ─────────────────────────────────────────────────────────────────────────────

import express, { Request, Response } from 'express';
import crypto from 'crypto';
import { CONFIG, asyncHandler, AppError } from '../lib/config';
import { prisma, dbAppendLog, withWriteLock } from '../lib/db';
import { requireDirector } from './auth';
import { addBackendEvent } from './telemetry';
import type { AccessRequestDTO } from '../shared/types';

const router = express.Router();
router.use(requireDirector);

interface AccessRow {
  id: string;
  email: string;
  name: string;
  firstName: string | null;
  lastName: string | null;
  picture: string | null;
  status: string;
  requestedAt: Date;
  decidedAt: Date | null;
  decidedBy: string | null;
  personId: string | null;
}

function toDTO(r: AccessRow): AccessRequestDTO {
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    firstName: r.firstName,
    lastName: r.lastName,
    picture: r.picture,
    status: r.status as AccessRequestDTO['status'],
    requestedAt: r.requestedAt.toISOString(),
    decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
    decidedBy: r.decidedBy,
    personId: r.personId,
  };
}

// GET /api/access/requests — every request/grant plus the read-only env
// allowlist (shown as "always allowed" so a director can't lock themselves out
// from the UI, and the team list is complete).
router.get('/requests', asyncHandler(async (_req: Request, res: Response) => {
  const rows = await prisma.accessRequest.findMany({ orderBy: [{ requestedAt: 'desc' }] });
  res.json({ requests: rows.map(toDTO), envEmails: CONFIG.ALLOWED_EMAILS });
}));

// GET /api/access/pending-count — lightweight count for the dashboard badge.
router.get('/pending-count', asyncHandler(async (_req: Request, res: Response) => {
  const count = await prisma.accessRequest.count({ where: { status: 'pending' } });
  res.json({ count });
}));

// PATCH /api/access/requests/:id — edit the person's first/last name. Keeps the
// display name and any linked Training person in sync.
router.patch('/requests/:id', asyncHandler(async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const fn = typeof req.body.firstName === 'string' ? req.body.firstName.trim() : '';
  const ln = typeof req.body.lastName === 'string' ? req.body.lastName.trim() : '';
  if (!fn || !ln) {
    return res.status(400).json({ error: 'name_required', message: 'First and last name are required.' });
  }
  const row = await prisma.accessRequest.findUnique({ where: { id } });
  if (!row) throw new AppError(404, 'Access request not found');
  const name = `${fn} ${ln}`;
  const updated = await prisma.accessRequest.update({
    where: { id },
    data: { firstName: fn, lastName: ln, name },
  });
  if (row.personId) {
    // Best-effort: keep the linked Training person's name aligned.
    await withWriteLock(() => prisma.person.update({ where: { id: row.personId as string }, data: { name } })).catch(() => {});
  }
  await dbAppendLog(req.user!.email, req.user!.name, 'access_rename', `${row.email} → ${name}`);
  res.json({ ok: true, request: toDTO(updated) });
}));

/** Find-or-create the Training (competencies) person for an approved account.
 *  Reuses an already-linked person; otherwise dedups by case-insensitive name
 *  so we don't duplicate a manually-added volunteer. Returns the person id. */
async function ensureTrainingPerson(row: AccessRow): Promise<string> {
  if (row.personId) {
    const existing = await prisma.person.findUnique({ where: { id: row.personId } });
    if (existing) return existing.id;
  }
  const name = row.name.trim();
  const match = await prisma.person.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } });
  if (match) return match.id;
  const created = await withWriteLock(() => prisma.person.create({
    data: { id: crypto.randomUUID(), name, location: 'centraal' },
  }));
  return created.id;
}

const DECISIONS = { approve: 'approved', deny: 'denied', revoke: 'revoked' } as const;
type DecisionAction = keyof typeof DECISIONS;

async function decide(req: Request, res: Response, action: DecisionAction): Promise<void> {
  const id = req.params.id as string;
  const row = await prisma.accessRequest.findUnique({ where: { id } });
  if (!row) throw new AppError(404, 'Access request not found');
  const status = DECISIONS[action];

  // Approving grants app access AND seeds/links a Training person. Denying or
  // revoking only changes the access status — a person stays in Training, since
  // people there (volunteers) don't need an account.
  const personId = action === 'approve' ? await ensureTrainingPerson(row) : row.personId;

  const updated = await prisma.accessRequest.update({
    where: { id },
    data: { status, decidedAt: new Date(), decidedBy: req.user?.email ?? null, personId },
  });
  await dbAppendLog(req.user!.email, req.user!.name, `access_${status}`, row.email);
  addBackendEvent('feature_use', `access_${action}`, { email: row.email });
  res.json({ ok: true, request: toDTO(updated) });
}

router.post('/requests/:id/approve', asyncHandler((req, res) => decide(req, res, 'approve')));
router.post('/requests/:id/deny', asyncHandler((req, res) => decide(req, res, 'deny')));
router.post('/requests/:id/revoke', asyncHandler((req, res) => decide(req, res, 'revoke')));

export default router;
