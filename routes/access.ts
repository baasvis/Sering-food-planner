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
import { Prisma } from '@prisma/client';
import { CONFIG, asyncHandler, AppError } from '../lib/config';
import { prisma, dbAppendLog, withWriteLock } from '../lib/db';
import { requireDirector } from './auth';
import { addBackendEvent } from './telemetry';
import { sendToEmails } from './events';
import type { AccessRequestDTO, RoleDTO, PagePermission } from '../shared/types';
import { GATEABLE_SCREENS } from '../shared/types';

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
  roleId: string | null;
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
    roleId: r.roleId,
  };
}

// ── Roles ────────────────────────────────────────────────────────────────────

const VALID_LEVELS = new Set<PagePermission>(['hidden', 'view', 'edit']);

/** Coerce an arbitrary input into a complete map over exactly the gateable
 *  screens, with valid levels only (unknown screen / level → fallback). */
function normalizePermissions(input: unknown, fallback: PagePermission = 'view'): Record<string, PagePermission> {
  const src = (input && typeof input === 'object') ? input as Record<string, unknown> : {};
  const out: Record<string, PagePermission> = {};
  for (const s of GATEABLE_SCREENS) {
    const v = src[s];
    out[s] = (typeof v === 'string' && VALID_LEVELS.has(v as PagePermission)) ? (v as PagePermission) : fallback;
  }
  return out;
}

interface RoleRow { id: string; name: string; permissions: unknown; isDefault: boolean; }
function roleToDTO(r: RoleRow): RoleDTO {
  return { id: r.id, name: r.name, permissions: normalizePermissions(r.permissions), isDefault: r.isDefault };
}

/** Seed a few sensible roles the first time the table is used. "Full access"
 *  is the default so newly-approved users keep today's full access until a
 *  director downgrades them. */
async function seedRolesIfEmpty(): Promise<void> {
  if (await prisma.role.count() > 0) return;
  await withWriteLock(async () => {
    if (await prisma.role.count() > 0) return; // re-check inside the lock
    const all = (level: PagePermission) => normalizePermissions({}, level);
    const kitchen = all('edit'); kitchen['finance'] = 'hidden'; kitchen['feedback-admin'] = 'hidden';
    const seeds = [
      { name: 'Full access', permissions: all('edit'), isDefault: true },
      { name: 'Kitchen', permissions: kitchen, isDefault: false },
      { name: 'View only', permissions: all('view'), isDefault: false },
    ];
    for (const s of seeds) {
      await prisma.role.create({ data: { id: crypto.randomUUID(), name: s.name, permissions: s.permissions as unknown as Prisma.InputJsonValue, isDefault: s.isDefault } });
    }
  });
}

// GET /api/access/roles — list roles (+ the gateable screen ids), seeding
// defaults on first use.
router.get('/roles', asyncHandler(async (_req: Request, res: Response) => {
  await seedRolesIfEmpty();
  const roles = await prisma.role.findMany({ orderBy: [{ isDefault: 'desc' }, { name: 'asc' }] });
  res.json({ roles: roles.map(roleToDTO), screens: GATEABLE_SCREENS });
}));

// POST /api/access/roles — create a role.
router.post('/roles', asyncHandler(async (req: Request, res: Response) => {
  const name = (typeof req.body.name === 'string' ? req.body.name.trim() : '').slice(0, 60);
  if (!name) return res.status(400).json({ error: 'name_required', message: 'Role name is required.' });
  const permissions = normalizePermissions(req.body.permissions, 'view') as unknown as Prisma.InputJsonValue;
  const makeDefault = req.body.isDefault === true;
  const role = await withWriteLock(() => prisma.$transaction(async (tx) => {
    if (makeDefault) await tx.role.updateMany({ data: { isDefault: false } });
    return tx.role.create({ data: { id: crypto.randomUUID(), name, permissions, isDefault: makeDefault } });
  }));
  await dbAppendLog(req.user!.email, req.user!.name, 'role_create', name);
  res.json({ ok: true, role: roleToDTO(role) });
}));

// PATCH /api/access/roles/:id — rename, update the matrix, and/or set default.
router.patch('/roles/:id', asyncHandler(async (req: Request, res: Response) => {
  const id = req.params.id as string;
  if (!(await prisma.role.findUnique({ where: { id } }))) throw new AppError(404, 'Role not found');
  const data: { name?: string; permissions?: Prisma.InputJsonValue; isDefault?: boolean } = {};
  if (typeof req.body.name === 'string' && req.body.name.trim()) data.name = req.body.name.trim().slice(0, 60);
  if (req.body.permissions && typeof req.body.permissions === 'object') {
    data.permissions = normalizePermissions(req.body.permissions) as unknown as Prisma.InputJsonValue;
  }
  const makeDefault = req.body.isDefault === true;
  const role = await withWriteLock(() => prisma.$transaction(async (tx) => {
    if (makeDefault) { await tx.role.updateMany({ data: { isDefault: false } }); data.isDefault = true; }
    return tx.role.update({ where: { id }, data });
  }));
  await dbAppendLog(req.user!.email, req.user!.name, 'role_update', role.name);
  if (data.permissions) {
    // A matrix change affects everyone with this role — refresh their tabs.
    const members = await prisma.accessRequest.findMany({ where: { roleId: id }, select: { email: true } });
    if (members.length) sendToEmails(members.map(m => m.email), 'permissions-changed');
  }
  res.json({ ok: true, role: roleToDTO(role) });
}));

// DELETE /api/access/roles/:id — refused while any user still has the role.
router.delete('/roles/:id', asyncHandler(async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const inUse = await prisma.accessRequest.count({ where: { roleId: id } });
  if (inUse > 0) {
    return res.status(409).json({ error: 'role_in_use', message: `${inUse} user(s) still have this role — reassign them first.` });
  }
  const role = await prisma.role.findUnique({ where: { id } });
  if (!role) throw new AppError(404, 'Role not found');
  await prisma.role.delete({ where: { id } });
  await dbAppendLog(req.user!.email, req.user!.name, 'role_delete', role.name);
  res.json({ ok: true });
}));

// PATCH /api/access/requests/:id/role — assign (or clear, with null) a user's role.
router.patch('/requests/:id/role', asyncHandler(async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const raw = req.body.roleId;
  const roleId = (raw === null || raw === undefined || raw === '') ? null : String(raw);
  const row = await prisma.accessRequest.findUnique({ where: { id } });
  if (!row) throw new AppError(404, 'Access request not found');
  if (roleId && !(await prisma.role.findUnique({ where: { id: roleId } }))) throw new AppError(404, 'Role not found');
  const updated = await prisma.accessRequest.update({ where: { id }, data: { roleId } });
  await dbAppendLog(req.user!.email, req.user!.name, 'access_role', `${row.email} → ${roleId ?? 'none'}`);
  sendToEmails([row.email], 'permissions-changed'); // live-refresh the user's tab
  res.json({ ok: true, request: toDTO(updated) });
}));

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
  const fn = (typeof req.body.firstName === 'string' ? req.body.firstName.trim() : '').slice(0, 100);
  const ln = (typeof req.body.lastName === 'string' ? req.body.lastName.trim() : '').slice(0, 100);
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

const DECISIONS = { approve: 'approved', deny: 'denied', revoke: 'revoked' } as const;
type DecisionAction = keyof typeof DECISIONS;

async function decide(req: Request, res: Response, action: DecisionAction): Promise<void> {
  const id = req.params.id as string;
  const row = await prisma.accessRequest.findUnique({ where: { id } });
  if (!row) throw new AppError(404, 'Access request not found');
  const status = DECISIONS[action];
  const decidedBy = req.user?.email ?? null;

  // Approving also find-or-creates + links a Training (competencies) person,
  // deduped by case-insensitive name (reusing an already-linked one). The
  // find-or-create + status update run in ONE write-locked transaction so a
  // failed update can't orphan a freshly-created person, and two concurrent
  // same-name approvals can't create duplicates. Deny/revoke only flip the
  // status — the person stays in Training (volunteers there need no account).
  const updated = action === 'approve'
    ? await withWriteLock(() => prisma.$transaction(async (tx) => {
        let personId = row.personId;
        if (personId && !(await tx.person.findUnique({ where: { id: personId } }))) personId = null;
        if (!personId) {
          const name = row.name.trim();
          const match = await tx.person.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } });
          personId = match ? match.id : (await tx.person.create({ data: { id: crypto.randomUUID(), name, location: 'centraal' } })).id;
        }
        // Role: an explicit choice passed with the approve action wins;
        // otherwise keep any existing role, else fall back to the default.
        let roleId = row.roleId;
        const requestedRole = typeof req.body?.roleId === 'string' && req.body.roleId ? req.body.roleId : null;
        if (requestedRole && (await tx.role.findUnique({ where: { id: requestedRole } }))) roleId = requestedRole;
        else if (!roleId) roleId = (await tx.role.findFirst({ where: { isDefault: true } }))?.id ?? null;
        return tx.accessRequest.update({ where: { id }, data: { status, decidedAt: new Date(), decidedBy, personId, roleId } });
      }))
    : await prisma.accessRequest.update({ where: { id }, data: { status, decidedAt: new Date(), decidedBy } });

  await dbAppendLog(req.user!.email, req.user!.name, `access_${status}`, row.email);
  addBackendEvent('feature_use', `access_${action}`, { email: row.email });
  res.json({ ok: true, request: toDTO(updated) });
}

router.post('/requests/:id/approve', asyncHandler((req, res) => decide(req, res, 'approve')));
router.post('/requests/:id/deny', asyncHandler((req, res) => decide(req, res, 'deny')));
router.post('/requests/:id/revoke', asyncHandler((req, res) => decide(req, res, 'revoke')));

export default router;
