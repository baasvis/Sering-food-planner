// ─────────────────────────────────────────────────────────────────────────────
// SUPPLIES — toppings, breads, ferments, pickles, sauces.
// Standard supplies: per-guest ratio + prep horizon.
// One-offs: drip-feed unitsPerService until stock = 0, then auto-archive.
// ─────────────────────────────────────────────────────────────────────────────

import express, { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { asyncHandler, AppError } from '../lib/config';
import { prisma, dbAppendLog, withWriteLock, checkId } from '../lib/db';
import { isActiveLocation, isKnownLocation } from '../lib/locations';
import { broadcast } from './events';
import type { Supply, SupplyKind, SupplyPrepMode, SupplyStock } from '../shared/types';

const router = express.Router();

const VALID_KINDS: SupplyKind[] = ['standard', 'oneoff'];
const VALID_PREP_MODES: SupplyPrepMode[] = ['centralized', 'per-location'];
// Location validity comes from lib/locations.ts: new writes (prep/stock moves,
// one-off creation) target ACTIVE locations; PATCH of an existing row accepts
// KNOWN (incl. archived events) so edits don't brick after an event closes.

function emptyStock(): SupplyStock {
  return {
    west: { amount: 0, lastMakeDate: null },
    centraal: { amount: 0, lastMakeDate: null },
  };
}

function normalizeStock(raw: unknown): SupplyStock {
  const s = emptyStock();
  if (!raw || typeof raw !== 'object') return s;
  const r = raw as Record<string, unknown>;
  // Permanent keys always present; event-location keys are preserved. The
  // "ev-" prefix test (not just isKnownLocation) is deliberate fail-safety:
  // if the registry cache is legitimately empty (boot hydration failed and no
  // /api/data has run yet), a /prep or /stock write must NOT strip and
  // permanently erase festival stock keys. Junk keys are still dropped.
  for (const loc of Object.keys(r)) {
    if (loc !== 'west' && loc !== 'centraal' && !loc.startsWith('ev-') && !isKnownLocation(loc)) continue;
    const e = r[loc];
    if (e && typeof e === 'object') {
      const entry = e as Record<string, unknown>;
      const amount = typeof entry.amount === 'number' ? entry.amount : Number(entry.amount) || 0;
      const lastMakeDate = typeof entry.lastMakeDate === 'string' ? entry.lastMakeDate : null;
      s[loc] = { amount: Math.max(0, amount), lastMakeDate };
    }
  }
  return s;
}

function toSupplyShape(row: {
  id: string; name: string; kind: string; unit: string; recipeId: string | null;
  guestsPerUnit: number | null; prepHorizonDays: number | null; prepMode: string | null;
  oneoffLocation: string | null; unitsPerService: number | null; oneoffStartDate: string | null;
  stock: Prisma.JsonValue; costPerUnit: number | null; preservationMethod: string | null; archived: boolean;
  createdAt: Date; updatedAt: Date;
}): Supply {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as SupplyKind,
    unit: row.unit,
    recipeId: row.recipeId,
    guestsPerUnit: row.guestsPerUnit,
    prepHorizonDays: row.prepHorizonDays,
    prepMode: row.prepMode as SupplyPrepMode | null,
    oneoffLocation: row.oneoffLocation as Supply['oneoffLocation'],
    unitsPerService: row.unitsPerService,
    oneoffStartDate: row.oneoffStartDate,
    stock: normalizeStock(row.stock),
    costPerUnit: row.costPerUnit,
    preservationMethod: row.preservationMethod,
    archived: row.archived,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

interface SupplyInput {
  id?: string;
  name?: string;
  kind?: string;
  unit?: string;
  recipeId?: string | null;
  guestsPerUnit?: number | null;
  prepHorizonDays?: number | null;
  prepMode?: string | null;
  oneoffLocation?: string | null;
  unitsPerService?: number | null;
  oneoffStartDate?: string | null;
  costPerUnit?: number | null;
  preservationMethod?: string | null;
}

/** Validate the user-editable fields on a Supply. Throws AppError(400) on failure. */
function validateSupplyInput(input: SupplyInput, requireId = false): void {
  if (requireId) {
    if (typeof input.id !== 'string' || !input.id) throw new AppError(400, 'id required');
    const idErr = checkId(input.id, 'id');
    if (idErr) throw new AppError(400, idErr);
  }
  if (typeof input.name !== 'string' || input.name.length === 0 || input.name.length > 200) throw new AppError(400, 'invalid name');
  if (typeof input.kind !== 'string' || !VALID_KINDS.includes(input.kind as SupplyKind)) throw new AppError(400, `invalid kind`);
  if (typeof input.unit !== 'string' || input.unit.length === 0 || input.unit.length > 50) throw new AppError(400, 'invalid unit');
  if (input.recipeId != null) {
    const e = checkId(input.recipeId, 'recipeId');
    if (e) throw new AppError(400, e);
  }
  if (input.preservationMethod != null && (typeof input.preservationMethod !== 'string' || input.preservationMethod.length > 200)) {
    throw new AppError(400, 'invalid preservationMethod');
  }
  if (input.costPerUnit != null && (typeof input.costPerUnit !== 'number' || !Number.isFinite(input.costPerUnit) || input.costPerUnit < 0 || input.costPerUnit > 1_000_000)) {
    throw new AppError(400, 'invalid costPerUnit');
  }
  if (input.kind === 'standard') {
    const g = input.guestsPerUnit;
    if (typeof g !== 'number' || !Number.isFinite(g) || g <= 0 || g > 100000) throw new AppError(400, 'invalid guestsPerUnit');
    const h = input.prepHorizonDays;
    if (typeof h !== 'number' || !Number.isInteger(h) || h < 1 || h > 60) throw new AppError(400, 'invalid prepHorizonDays');
    if (typeof input.prepMode !== 'string' || !VALID_PREP_MODES.includes(input.prepMode as SupplyPrepMode)) throw new AppError(400, 'invalid prepMode');
  } else if (input.kind === 'oneoff') {
    // Create (requireId=true) targets an ACTIVE location; edits of an existing
    // row (PATCH) accept KNOWN so a row pointing at an archived event can
    // still be renamed/repriced without tripping on its location.
    const locValid = requireId ? isActiveLocation : isKnownLocation;
    if (typeof input.oneoffLocation !== 'string' || !locValid(input.oneoffLocation)) throw new AppError(400, 'invalid oneoffLocation');
    const u = input.unitsPerService;
    if (typeof u !== 'number' || !Number.isFinite(u) || u <= 0 || u > 100000) throw new AppError(400, 'invalid unitsPerService');
    if (typeof input.oneoffStartDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.oneoffStartDate)) throw new AppError(400, 'invalid oneoffStartDate');
  }
}

function buildSupplyData(input: SupplyInput): Prisma.SupplyCreateInput | Prisma.SupplyUncheckedUpdateInput {
  const base = {
    name: input.name as string,
    kind: input.kind as string,
    unit: input.unit as string,
    recipeId: input.recipeId ?? null,
    costPerUnit: input.costPerUnit ?? null,
    preservationMethod: input.preservationMethod ?? null,
  };
  if (input.kind === 'standard') {
    return {
      ...base,
      guestsPerUnit: input.guestsPerUnit as number,
      prepHorizonDays: input.prepHorizonDays as number,
      prepMode: input.prepMode as string,
      oneoffLocation: null,
      unitsPerService: null,
      oneoffStartDate: null,
    };
  }
  return {
    ...base,
    oneoffLocation: input.oneoffLocation as string,
    unitsPerService: input.unitsPerService as number,
    oneoffStartDate: input.oneoffStartDate as string,
    guestsPerUnit: null,
    prepHorizonDays: null,
    prepMode: null,
  };
}

// ── Endpoints ──

router.get('/', asyncHandler(async (req: Request, res: Response) => {
  const includeArchived = req.query.includeArchived === '1' || req.query.includeArchived === 'true';
  const rows = await prisma.supply.findMany({
    where: includeArchived ? {} : { archived: false },
    orderBy: [{ archived: 'asc' }, { name: 'asc' }],
  });
  res.json(rows.map(toSupplyShape));
}));

router.post('/', asyncHandler(async (req: Request, res: Response) => {
  const input = req.body as SupplyInput;
  validateSupplyInput(input, true);
  const data = buildSupplyData(input);
  const stockJson = emptyStock() as unknown as Prisma.InputJsonValue;
  const created = await withWriteLock(async () => {
    return prisma.supply.create({
      data: {
        ...(data as Prisma.SupplyCreateInput),
        id: input.id as string,
        stock: stockJson,
        archived: false,
      },
    });
  });
  const user = req.user || { email: 'anonymous', name: 'Anonymous' };
  dbAppendLog(user.email, user.name, 'supply-create', `created "${input.name}" (${input.kind})`);
  const shape = toSupplyShape(created);
  broadcast(user.email, 'patch', { user: user.name, supplies: [shape] });
  res.json(shape);
}));

router.patch('/:id', asyncHandler(async (req: Request, res: Response) => {
  const idErr = checkId(req.params.id, 'id');
  if (idErr) throw new AppError(400, idErr);
  const input = req.body as SupplyInput;
  validateSupplyInput(input, false);
  const updated = await withWriteLock(async () => {
    const existing = await prisma.supply.findUnique({ where: { id: req.params.id as string } });
    if (!existing) return null;
    const data = buildSupplyData(input);
    return prisma.supply.update({
      where: { id: req.params.id as string },
      data: data as Prisma.SupplyUncheckedUpdateInput,
    });
  });
  if (!updated) throw new AppError(404, 'Supply not found');
  const user = req.user || { email: 'anonymous', name: 'Anonymous' };
  dbAppendLog(user.email, user.name, 'supply-update', `updated "${input.name}"`);
  const shape = toSupplyShape(updated);
  broadcast(user.email, 'patch', { user: user.name, supplies: [shape] });
  res.json(shape);
}));

router.delete('/:id', asyncHandler(async (req: Request, res: Response) => {
  const idErr = checkId(req.params.id, 'id');
  if (idErr) throw new AppError(400, idErr);
  const result = await withWriteLock(async () => {
    const existing = await prisma.supply.findUnique({ where: { id: req.params.id as string } });
    if (!existing) return { notFound: true } as const;
    const stock = normalizeStock(existing.stock);
    const hasStock = Object.values(stock).some(e => (e?.amount ?? 0) > 0);
    if (hasStock) return { hasStock: true, name: existing.name } as const;
    await prisma.supply.delete({ where: { id: req.params.id as string } });
    return { ok: true, name: existing.name } as const;
  });
  if ('notFound' in result) throw new AppError(404, 'Supply not found');
  if ('hasStock' in result) throw new AppError(400, `Cannot delete "${result.name}": stock > 0 at one or more locations. Zero out stock first.`);
  const user = req.user || { email: 'anonymous', name: 'Anonymous' };
  dbAppendLog(user.email, user.name, 'supply-delete', `deleted "${result.name}"`);
  broadcast(user.email, 'patch', { user: user.name, deletedSupplies: [req.params.id as string] });
  res.json({ ok: true });
}));

interface PrepInput { location?: unknown; amount?: unknown }

/**
 * Log a prep event: ADD `amount` to `stock[location].amount` and stamp
 * lastMakeDate = today. Used by the "Log prep — made Z" button on the prep
 * checklist. Distinct from POST /stock which sets the pool to an absolute
 * value (used for stocktake corrections).
 */
router.post('/:id/prep', asyncHandler(async (req: Request, res: Response) => {
  const idErr = checkId(req.params.id, 'id');
  if (idErr) throw new AppError(400, idErr);
  const { location, amount } = req.body as PrepInput;
  if (typeof location !== 'string' || !isActiveLocation(location)) throw new AppError(400, 'invalid location');
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0 || amt > 1_000_000) throw new AppError(400, 'invalid amount');

  const result = await withWriteLock(async () => {
    const existing = await prisma.supply.findUnique({ where: { id: req.params.id as string } });
    if (!existing) return null;
    const stock = normalizeStock(existing.stock);
    const today = new Date();
    const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    stock[location] = {
      amount: (stock[location]?.amount ?? 0) + amt,
      lastMakeDate: todayIso,
    };
    return prisma.supply.update({
      where: { id: req.params.id as string },
      data: { stock: stock as unknown as Prisma.InputJsonValue },
    });
  });
  if (!result) throw new AppError(404, 'Supply not found');
  const user = req.user || { email: 'anonymous', name: 'Anonymous' };
  dbAppendLog(user.email, user.name, 'supply-prep', `+${amt} ${result.unit} ${result.name} @ ${location}`);
  const shape = toSupplyShape(result);
  broadcast(user.email, 'patch', { user: user.name, supplies: [shape] });
  res.json(shape);
}));

/**
 * Manual stocktake: SET `stock[location].amount` to an absolute value.
 * Used for corrections / non-prep restocks (supplier delivery of fried onions).
 *
 * For one-off supplies, setting amount to 0 also archives the row (auto-archive
 * on depletion). Standard supplies can sit at 0 stock without archiving.
 */
router.post('/:id/stock', asyncHandler(async (req: Request, res: Response) => {
  const idErr = checkId(req.params.id, 'id');
  if (idErr) throw new AppError(400, idErr);
  const { location, amount } = req.body as PrepInput;
  // Absolute stocktake SET accepts KNOWN (incl. archived events): zeroing
  // leftover stock at a closed festival is legitimate cleanup, and without it
  // a supply with archived-event stock could never pass the delete guard.
  // /prep (additive) stays ACTIVE-only above.
  if (typeof location !== 'string' || !isKnownLocation(location)) throw new AppError(400, 'invalid location');
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt < 0 || amt > 1_000_000) throw new AppError(400, 'invalid amount');

  const result = await withWriteLock(async () => {
    const existing = await prisma.supply.findUnique({ where: { id: req.params.id as string } });
    if (!existing) return null;
    const stock = normalizeStock(existing.stock);
    stock[location] = {
      amount: amt,
      lastMakeDate: stock[location]?.lastMakeDate ?? null,
    };
    const archived = shouldAutoArchive(existing.kind, existing.oneoffLocation, stock);
    return prisma.supply.update({
      where: { id: req.params.id as string },
      data: {
        stock: stock as unknown as Prisma.InputJsonValue,
        archived,
      },
    });
  });
  if (!result) throw new AppError(404, 'Supply not found');
  const user = req.user || { email: 'anonymous', name: 'Anonymous' };
  dbAppendLog(user.email, user.name, 'supply-stock', `${result.name} @ ${location} = ${amt} ${result.unit}${result.archived ? ' (archived)' : ''}`);
  const shape = toSupplyShape(result);
  broadcast(user.email, 'patch', { user: user.name, supplies: [shape] });
  res.json(shape);
}));

/**
 * One-off auto-archive rule: when a one-off's stock at its `oneoffLocation`
 * drops to 0 (or below), the supply is finished and shouldn't appear in any
 * forward demand or plating list. Standards stay non-archived even at 0
 * stock (they're meant to be replenished).
 */
function shouldAutoArchive(kind: string, oneoffLocation: string | null, stock: SupplyStock): boolean {
  if (kind !== 'oneoff' || !oneoffLocation) return false;
  return (stock[oneoffLocation]?.amount ?? 0) <= 0;
}

export default router;
