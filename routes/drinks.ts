// ─────────────────────────────────────────────────────────────────────────────
// DRINKS — catalogue + recipes, suppliers, module config, stock, orders,
// production, write-offs, assortments, menus. Per DRINKS_DOMAIN.md.
//
// Permissions (GOAL §5): all authed users may read everything and (M3+) draft
// recipe drinks; MANAGER-gated writes are prices, supplier data, markup targets,
// and menu publishing. Catalogue (bought-drink) CRUD is manager-gated wholesale
// — a catalogue drink is defined by its manager-owned fields (price, supplier,
// cost, par). See DECISIONS.md [m2].
// ─────────────────────────────────────────────────────────────────────────────

import express, { Request, Response } from 'express';
import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { asyncHandler, AppError } from '../lib/config';
import { prisma, dbAppendLog, withWriteLock, checkId } from '../lib/db';
import { isManagerEmail } from './auth';
import { broadcast } from './events';
import {
  toDrink, toDrinkSupplier, buildStockMap, stockByLocationFor, getDrinkConfig,
  mergeConfig, validateDrinkInput, buildDrinkData, buildRowData, recalcAllDrinkCosts,
  normalizeFormats, VALID_LOCATIONS, DrinkInput,
} from '../lib/drinks';
import { receivedStockDeltas } from '../shared/drink-order';
import { producedUnits, consumedBuildingBlocks, expiryDate } from '../shared/drink-production';

// Pseudo storage areas the stocktake reconciles away when a real count lands:
// seed bootstrap, order-receiving intake, and fresh production. A real count of
// the drink consumes all three.
const BOOTSTRAP_AREAS = ['Uncounted (pre-stocktake)', 'Delivery intake', 'Made (fresh)'];
const RECEIVING_AREA = 'Delivery intake';
const PRODUCTION_AREA = 'Made (fresh)';

const router = express.Router();

function actor(req: Request): { email: string; name: string } {
  return req.user ? { email: req.user.email, name: req.user.name } : { email: 'anonymous', name: 'Anonymous' };
}

/** Throw 403 unless the caller is a manager (director ∪ MANAGER_EMAILS). */
function assertManager(req: Request): void {
  if (!isManagerEmail(req.user?.email)) {
    throw new AppError(403, 'Manager access required.');
  }
}

/** Load a drink with rows + per-location pool stock, mapped to the shared shape. */
async function fetchDrinkShape(id: string) {
  const row = await prisma.drink.findUnique({
    where: { id },
    include: { ingredientRows: { orderBy: { sortOrder: 'asc' } } },
  });
  if (!row) return null;
  const stock = await stockByLocationFor(id);
  return toDrink(row, stock);
}

/** Non-managers may draft/edit recipe drinks but not set money fields. Keep the
 *  manager-set costPrice + per-format prices (or empty on create). */
function gateMoneyFields(
  data: Prisma.DrinkUncheckedUpdateInput,
  input: DrinkInput,
  existing: { costPrice: number | null; formats: Prisma.JsonValue } | null,
  mgr: boolean,
): void {
  if (mgr) return;
  data.costPrice = existing?.costPrice ?? null;
  if (input.formats !== undefined) {
    const existingFmts = existing ? normalizeFormats(existing.formats) : [];
    const priceByName = new Map(existingFmts.map(f => [f.name, f.price]));
    const incoming = (Array.isArray(input.formats) ? input.formats : []) as Array<{ name?: string; volumeMl?: number; glass?: string }>;
    data.formats = incoming.map(f => ({ ...f, price: priceByName.get(String(f.name)) ?? {} })) as unknown as Prisma.InputJsonValue;
  }
}

// ─── Drinks (catalogue + recipe) ───────────────────────────────────────────

/** List drinks with per-(location) pool stock. Reads are open to all users.
 *  Filtering by mode/category/search happens client-side (small dataset). */
router.get('/', asyncHandler(async (req: Request, res: Response) => {
  const includeArchived = req.query.includeArchived === '1' || req.query.includeArchived === 'true';
  const [rows, grouped] = await Promise.all([
    prisma.drink.findMany({
      where: includeArchived ? {} : { archived: false },
      include: { ingredientRows: { orderBy: { sortOrder: 'asc' } } },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
    }),
    prisma.drinkStock.groupBy({ by: ['drinkId', 'location'], _sum: { qty: true } }),
  ]);
  const stockMap = buildStockMap(grouped);
  res.json(rows.map(r => toDrink(r, stockMap[r.id] ?? {})));
}));

router.get('/config', asyncHandler(async (_req: Request, res: Response) => {
  res.json(await getDrinkConfig());
}));

/** Save the module config singleton (labour rate, markup targets, …). Manager. */
router.post('/config', asyncHandler(async (req: Request, res: Response) => {
  assertManager(req);
  const incoming = (req.body && typeof req.body === 'object' && !Array.isArray(req.body))
    ? (req.body as Record<string, unknown>) : {};
  const merged = mergeConfig(incoming);
  await withWriteLock(async () => {
    await prisma.drinkConfig.upsert({
      where: { id: 'default' },
      create: { id: 'default', config: merged as unknown as Prisma.InputJsonValue },
      update: { config: merged as unknown as Prisma.InputJsonValue },
    });
  });
  const user = actor(req);
  dbAppendLog(user.email, user.name, 'drink-config-save', 'updated drinks module config');
  broadcast(user.email, 'patch', { user: user.name, drinkConfig: merged });
  res.json(merged);
}));

/** Recompute costPerServe + suggestedPrice for every recipe drink. Idempotent;
 *  open to all authed users (recompute is harmless). Broadcasts a drinks reload. */
router.post('/recalculate-costs', asyncHandler(async (req: Request, res: Response) => {
  const updated = await withWriteLock(() => recalcAllDrinkCosts());
  const user = actor(req);
  dbAppendLog(user.email, user.name, 'drink-recalc-costs', `recomputed ${updated} drink costs`);
  broadcast(user.email, 'patch', { user: user.name, drinksReload: true });
  res.json({ updated });
}));

// ─── Stock (per-area counts; pool per location = Σ areas) ───────────────────
// Reads + counts are open to all authed users (GOAL §5). Defined BEFORE /:id so
// the param route doesn't shadow /stock.

router.get('/stock', asyncHandler(async (req: Request, res: Response) => {
  const location = String(req.query.location || '');
  const rows = await prisma.drinkStock.findMany({
    where: location ? { location } : {},
    orderBy: [{ drinkId: 'asc' }, { area: 'asc' }],
  });
  res.json(rows.map(r => ({
    id: r.id, drinkId: r.drinkId, location: r.location, area: r.area, qty: r.qty,
    countedBy: r.countedBy, countedAt: r.countedAt ? r.countedAt.toISOString() : null,
  })));
}));

interface StockBulkInput { location?: string; area?: string; items?: Array<{ drinkId?: string; qty?: number }> }

/** Bulk stocktake save: set each counted drink's qty for (location, area).
 *  Consumes the seed "Uncounted" bootstrap row for that drink+location so the
 *  pool isn't double-counted on the first real count. */
router.post('/stock/bulk', asyncHandler(async (req: Request, res: Response) => {
  const { location, area, items } = (req.body || {}) as StockBulkInput;
  if (typeof location !== 'string' || !VALID_LOCATIONS.includes(location)) throw new AppError(400, 'invalid location');
  if (typeof area !== 'string' || !area || area.length > 100) throw new AppError(400, 'invalid area');
  if (!Array.isArray(items) || items.length === 0) throw new AppError(400, 'no items to save');
  if (items.length > 500) throw new AppError(400, 'too many items (max 500)');
  const user = actor(req);
  const now = new Date();
  const areaKey = area.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'area';
  let saved = 0;
  await withWriteLock(async () => {
    await prisma.$transaction(async (txc) => {
      for (const it of items) {
        const id = it.drinkId;
        if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(id)) continue;
        const qty = Number(it.qty);
        if (!Number.isFinite(qty) || qty < 0 || qty > 1_000_000) continue;
        await txc.drinkStock.upsert({
          where: { drinkId_location_area: { drinkId: id, location, area } },
          create: { id: `${id}-${location}-${areaKey}`, drinkId: id, location, area, qty, countedBy: user.email, countedAt: now },
          update: { qty, countedBy: user.email, countedAt: now },
        });
        // A real count reconciles the bootstrap + delivery-intake pseudo-areas.
        await txc.drinkStock.deleteMany({ where: { drinkId: id, location, area: { in: BOOTSTRAP_AREAS }, NOT: { area } } });
        saved++;
      }
    });
  });
  dbAppendLog(user.email, user.name, 'drink-stocktake', `${saved} counts @ ${location}/${area}`);
  broadcast(user.email, 'patch', { user: user.name, drinksReload: true });
  res.json({ saved });
}));

// ─── Orders (lifecycle: draft → ordered → received / cancelled) ─────────────
// Manager-gated (supplier/ordering is manager territory, GOAL §5). Receiving
// applies line receivedQty (routing substitutions) to stock.

type DrinkOrderRow = Prisma.DrinkOrderGetPayload<{ include: { lines: true } }>;

function toDrinkOrder(row: DrinkOrderRow) {
  return {
    id: row.id, location: row.location, supplier: row.supplier, status: row.status,
    orderedBy: row.orderedBy, orderedAt: row.orderedAt ? row.orderedAt.toISOString() : null,
    expectedDelivery: row.expectedDelivery, receivedBy: row.receivedBy,
    receivedAt: row.receivedAt ? row.receivedAt.toISOString() : null,
    note: row.note, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    lines: (row.lines || []).slice().sort((a, b) => a.sortOrder - b.sortOrder).map(l => ({
      id: l.id, orderId: l.orderId, drinkId: l.drinkId, ingredientId: l.ingredientId, name: l.name,
      orderedQty: l.orderedQty, orderUnit: l.orderUnit, receivedQty: l.receivedQty,
      substitutedBy: l.substitutedBy, deposit: l.deposit, sortOrder: l.sortOrder,
    })),
  };
}

async function fetchOrderShape(id: string) {
  const row = await prisma.drinkOrder.findUnique({ where: { id }, include: { lines: { orderBy: { sortOrder: 'asc' } } } });
  return row ? toDrinkOrder(row) : null;
}

router.get('/orders', asyncHandler(async (req: Request, res: Response) => {
  const location = String(req.query.location || '');
  const rows = await prisma.drinkOrder.findMany({
    where: location ? { location } : {},
    include: { lines: { orderBy: { sortOrder: 'asc' } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json(rows.map(toDrinkOrder));
}));

interface OrderLineInput { drinkId?: string; ingredientId?: string; name?: string; orderedQty?: number; orderUnit?: string; deposit?: number }
interface OrderInput { id?: string; location?: string; supplier?: string; note?: string; lines?: OrderLineInput[] }

router.post('/orders', asyncHandler(async (req: Request, res: Response) => {
  assertManager(req);
  const input = req.body as OrderInput;
  const idErr = checkId(input.id, 'id');
  if (idErr) throw new AppError(400, idErr);
  if (typeof input.location !== 'string' || !VALID_LOCATIONS.includes(input.location)) throw new AppError(400, 'invalid location');
  if (typeof input.supplier !== 'string' || !input.supplier || input.supplier.length > 200) throw new AppError(400, 'invalid supplier');
  if (!Array.isArray(input.lines) || input.lines.length === 0) throw new AppError(400, 'no order lines');
  if (input.lines.length > 200) throw new AppError(400, 'too many lines (max 200)');
  const id = input.id as string;
  await withWriteLock(async () => {
    await prisma.$transaction(async (txc) => {
      await txc.drinkOrder.create({
        data: { id, location: input.location as string, supplier: input.supplier as string, status: 'draft', note: typeof input.note === 'string' ? input.note.slice(0, 2000) : '' },
      });
      const lineData = (input.lines || []).map((l, i) => ({
        id: `${id}-l${i}`, orderId: id,
        drinkId: typeof l.drinkId === 'string' ? l.drinkId : null,
        ingredientId: typeof l.ingredientId === 'string' ? l.ingredientId : null,
        name: typeof l.name === 'string' ? l.name.slice(0, 200) : '',
        orderedQty: Number(l.orderedQty) || 0, orderUnit: typeof l.orderUnit === 'string' ? l.orderUnit.slice(0, 50) : '',
        deposit: Number(l.deposit) || 0, sortOrder: i,
      }));
      await txc.drinkOrderLine.createMany({ data: lineData });
    });
  });
  const full = await fetchOrderShape(id);
  const user = actor(req);
  dbAppendLog(user.email, user.name, 'drink-order-create', `draft order for ${input.supplier} @ ${input.location}`);
  res.json(full);
}));

interface OrderPatchInput { status?: string; expectedDelivery?: string | null; lines?: Array<{ id?: string; receivedQty?: number | null; substitutedBy?: string | null }> }

router.patch('/orders/:id', asyncHandler(async (req: Request, res: Response) => {
  assertManager(req);
  const id = req.params.id as string;
  const idErr = checkId(id, 'id');
  if (idErr) throw new AppError(400, idErr);
  const body = req.body as OrderPatchInput;
  const user = actor(req);
  const ok = await withWriteLock(async () => {
    const existing = await prisma.drinkOrder.findUnique({ where: { id } });
    if (!existing) return false;
    await prisma.$transaction(async (txc) => {
      const data: Prisma.DrinkOrderUncheckedUpdateInput = {};
      if (body.status === 'ordered') { data.status = 'ordered'; data.orderedBy = user.email; data.orderedAt = new Date(); if (typeof body.expectedDelivery === 'string') data.expectedDelivery = body.expectedDelivery.slice(0, 100); }
      else if (body.status === 'cancelled') { data.status = 'cancelled'; }
      else if (body.status === 'received') { data.status = 'received'; data.receivedBy = user.email; data.receivedAt = new Date(); }
      if (Array.isArray(body.lines)) {
        for (const lu of body.lines) {
          if (typeof lu.id !== 'string') continue;
          await txc.drinkOrderLine.updateMany({
            where: { id: lu.id, orderId: id },
            data: {
              receivedQty: lu.receivedQty != null && Number.isFinite(Number(lu.receivedQty)) ? Number(lu.receivedQty) : null,
              substitutedBy: typeof lu.substitutedBy === 'string' && lu.substitutedBy ? lu.substitutedBy : null,
            },
          });
        }
      }
      if (Object.keys(data).length) await txc.drinkOrder.update({ where: { id }, data });
      if (body.status === 'received') {
        const lines = await txc.drinkOrderLine.findMany({ where: { orderId: id } });
        const deltas = receivedStockDeltas(lines.map(l => ({ drinkId: l.drinkId, receivedQty: l.receivedQty, substitutedByDrinkId: l.substitutedBy })));
        for (const dlt of deltas) {
          await txc.drinkStock.upsert({
            where: { drinkId_location_area: { drinkId: dlt.drinkId, location: existing.location, area: RECEIVING_AREA } },
            create: { id: `${dlt.drinkId}-${existing.location}-delivery-intake`, drinkId: dlt.drinkId, location: existing.location, area: RECEIVING_AREA, qty: dlt.qty, countedBy: user.email, countedAt: new Date() },
            update: { qty: { increment: dlt.qty }, countedAt: new Date() },
          });
        }
      }
    });
    return true;
  });
  if (!ok) throw new AppError(404, 'Order not found');
  const full = await fetchOrderShape(id);
  dbAppendLog(user.email, user.name, 'drink-order-update', `order ${id} → ${body.status || 'updated'}`);
  // Receiving changes stock → tell other clients to refetch the catalogue pools.
  if (body.status === 'received') broadcast(user.email, 'patch', { user: user.name, drinksReload: true });
  res.json(full);
}));

router.delete('/orders/:id', asyncHandler(async (req: Request, res: Response) => {
  assertManager(req);
  const id = req.params.id as string;
  const idErr = checkId(id, 'id');
  if (idErr) throw new AppError(400, idErr);
  const result = await withWriteLock(async () => {
    const o = await prisma.drinkOrder.findUnique({ where: { id } });
    if (!o) return { notFound: true } as const;
    if (o.status !== 'draft') return { notDraft: true } as const;
    await prisma.drinkOrder.delete({ where: { id } }); // cascade deletes lines
    return { ok: true } as const;
  });
  if ('notFound' in result) throw new AppError(404, 'Order not found');
  if ('notDraft' in result) throw new AppError(400, 'Only draft orders can be deleted.');
  const user = actor(req);
  dbAppendLog(user.email, user.name, 'drink-order-delete', `deleted order ${id}`);
  res.json({ ok: true });
}));

// ─── Production & write-offs (corrections) ──────────────────────────────────
// Open to all authed users (§5). Production: premix/building-block stock ↑ +
// consumed building blocks ↓. Shared Ingredient-DB stock is NOT auto-deducted
// in Phase 1 (read-only touch-point — see DECISIONS.md [m6]). Write-offs reduce
// drink stock by a reason.

/** Reduce a drink's pool by `amount` (largest area first, clamped at 0). */
async function decrementDrinkStock(txc: Prisma.TransactionClient, drinkId: string, location: string, amount: number): Promise<void> {
  if (amount <= 0) return;
  const rows = await txc.drinkStock.findMany({ where: { drinkId, location }, orderBy: { qty: 'desc' } });
  let remaining = amount;
  for (const r of rows) {
    if (remaining <= 0) break;
    const take = Math.min(r.qty, remaining);
    await txc.drinkStock.update({ where: { id: r.id }, data: { qty: Math.max(0, r.qty - take) } });
    remaining -= take;
  }
}

/** Add `qty` to a drink's stock in a pseudo-area (production / receiving). */
async function incrementDrinkStock(txc: Prisma.TransactionClient, drinkId: string, location: string, area: string, qty: number): Promise<void> {
  if (qty <= 0) return;
  const areaKey = area.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'area';
  await txc.drinkStock.upsert({
    where: { drinkId_location_area: { drinkId, location, area } },
    create: { id: `${drinkId}-${location}-${areaKey}`, drinkId, location, area, qty, countedBy: 'production', countedAt: new Date() },
    update: { qty: { increment: qty }, countedAt: new Date() },
  });
}

router.get('/production', asyncHandler(async (req: Request, res: Response) => {
  const location = String(req.query.location || '');
  const rows = await prisma.drinkProductionLog.findMany({ where: location ? { location } : {}, orderBy: { createdAt: 'desc' }, take: 100 });
  res.json(rows.map(r => ({ id: r.id, drinkId: r.drinkId, location: r.location, batchesMade: r.batchesMade, volumeMl: r.volumeMl, bottlesYielded: r.bottlesYielded, madeBy: r.madeBy, madeOn: r.madeOn, expiresOn: r.expiresOn, status: r.status, note: r.note, createdAt: r.createdAt.toISOString() })));
}));

interface ProductionInput { id?: string; drinkId?: string; location?: string; batches?: number; madeBy?: string; madeOn?: string }

router.post('/production', asyncHandler(async (req: Request, res: Response) => {
  const input = req.body as ProductionInput;
  const idErr = checkId(input.id, 'id');
  if (idErr) throw new AppError(400, idErr);
  if (typeof input.drinkId !== 'string') throw new AppError(400, 'invalid drinkId');
  if (typeof input.location !== 'string' || !VALID_LOCATIONS.includes(input.location)) throw new AppError(400, 'invalid location');
  const batches = Number(input.batches);
  if (!Number.isFinite(batches) || batches <= 0 || batches > 10000) throw new AppError(400, 'invalid batches');
  const drinkRow = await prisma.drink.findUnique({ where: { id: input.drinkId }, include: { ingredientRows: true } });
  if (!drinkRow) throw new AppError(404, 'Drink not found');
  const drink = toDrink(drinkRow);
  const made = producedUnits(drink, batches);
  const consumed = consumedBuildingBlocks(drink, batches);
  const madeOn = typeof input.madeOn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.madeOn) ? input.madeOn : new Date().toISOString().slice(0, 10);
  const expiresOn = expiryDate(madeOn, drink.shelfLifeDays);
  await withWriteLock(async () => {
    await prisma.$transaction(async (txc) => {
      await incrementDrinkStock(txc, drink.id, input.location as string, PRODUCTION_AREA, made.qty);
      for (const c of consumed) await decrementDrinkStock(txc, c.drinkId, input.location as string, c.liters);
      await txc.drinkProductionLog.create({ data: {
        id: input.id as string, drinkId: drink.id, location: input.location as string, batchesMade: batches,
        volumeMl: batches * (drink.batch?.volumeMl || 0), bottlesYielded: made.unit === 'bottle' ? made.qty : 0,
        madeBy: typeof input.madeBy === 'string' ? input.madeBy.slice(0, 200) : '', madeOn, expiresOn, status: 'fresh',
      } });
    });
  });
  const user = actor(req);
  dbAppendLog(user.email, user.name, 'drink-production', `made ${batches}× ${drink.name} @ ${input.location}`);
  broadcast(user.email, 'patch', { user: user.name, drinksReload: true });
  res.json({ ok: true, made });
}));

router.post('/production/:id/discard', asyncHandler(async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const idErr = checkId(id, 'id');
  if (idErr) throw new AppError(400, idErr);
  const user = actor(req);
  const result = await withWriteLock(async () => {
    const log = await prisma.drinkProductionLog.findUnique({ where: { id } });
    if (!log) return null;
    const amt = log.bottlesYielded || (log.volumeMl / 1000);
    await prisma.$transaction(async (txc) => {
      await decrementDrinkStock(txc, log.drinkId, log.location, amt);
      await txc.drinkWriteOff.create({ data: { id: `${id}-wo`, refKind: 'drink', drinkId: log.drinkId, name: '', location: log.location, qty: amt, unit: log.bottlesYielded ? 'bottle' : 'liter', reason: 'expired', note: `discarded production ${id}`, who: user.email } });
      await txc.drinkProductionLog.update({ where: { id }, data: { status: 'discarded' } });
    });
    return log;
  });
  if (!result) throw new AppError(404, 'Production log not found');
  dbAppendLog(user.email, user.name, 'drink-discard', `discarded production ${id}`);
  broadcast(user.email, 'patch', { user: user.name, drinksReload: true });
  res.json({ ok: true });
}));

router.get('/write-offs', asyncHandler(async (req: Request, res: Response) => {
  const location = String(req.query.location || '');
  const rows = await prisma.drinkWriteOff.findMany({ where: location ? { location } : {}, orderBy: { createdAt: 'desc' }, take: 100 });
  res.json(rows.map(r => ({ id: r.id, refKind: r.refKind, drinkId: r.drinkId, ingredientId: r.ingredientId, name: r.name, location: r.location, qty: r.qty, unit: r.unit, reason: r.reason, note: r.note, who: r.who, createdAt: r.createdAt.toISOString() })));
}));

interface WriteOffInput { id?: string; refKind?: string; drinkId?: string; ingredientId?: string; name?: string; location?: string; qty?: number; unit?: string; reason?: string; note?: string }
const VALID_WO_REASONS = ['breakage', 'spillage', 'expired', 'staff-drink', 'comp', 'other'];

router.post('/write-offs', asyncHandler(async (req: Request, res: Response) => {
  const input = req.body as WriteOffInput;
  const idErr = checkId(input.id, 'id');
  if (idErr) throw new AppError(400, idErr);
  if (input.refKind !== 'drink' && input.refKind !== 'ingredient') throw new AppError(400, 'invalid refKind');
  if (typeof input.location !== 'string' || !VALID_LOCATIONS.includes(input.location)) throw new AppError(400, 'invalid location');
  const qty = Number(input.qty);
  if (!Number.isFinite(qty) || qty <= 0 || qty > 1_000_000) throw new AppError(400, 'invalid qty');
  if (typeof input.reason !== 'string' || !VALID_WO_REASONS.includes(input.reason)) throw new AppError(400, 'invalid reason');
  const user = actor(req);
  // Capture validated values as consts — TS loses property narrowing inside the
  // transaction closure below.
  const id = input.id as string;
  const refKind = input.refKind;
  const location = input.location;
  const reason = input.reason;
  const drinkId = typeof input.drinkId === 'string' ? input.drinkId : null;
  const ingredientId = typeof input.ingredientId === 'string' ? input.ingredientId : null;
  const name = typeof input.name === 'string' ? input.name.slice(0, 200) : '';
  const unit = typeof input.unit === 'string' ? input.unit.slice(0, 50) : '';
  const note = typeof input.note === 'string' ? input.note.slice(0, 500) : '';
  await withWriteLock(async () => {
    await prisma.$transaction(async (txc) => {
      // Phase 1: only DRINK stock is auto-deducted; ingredient write-offs are
      // recorded but don't touch the shared Ingredient DB (read-only touch-point).
      if (refKind === 'drink' && drinkId) {
        await decrementDrinkStock(txc, drinkId, location, qty);
      }
      await txc.drinkWriteOff.create({ data: { id, refKind, drinkId, ingredientId, name, location, qty, unit, reason, note, who: user.email } });
    });
  });
  dbAppendLog(user.email, user.name, 'drink-write-off', `${qty} ${name} (${reason}) @ ${location}`);
  broadcast(user.email, 'patch', { user: user.name, drinksReload: true });
  res.json({ ok: true });
}));

// ─── Suppliers ──────────────────────────────────────────────────────────────

router.get('/suppliers', asyncHandler(async (_req: Request, res: Response) => {
  const rows = await prisma.drinkSupplier.findMany({ orderBy: { name: 'asc' } });
  res.json(rows.map(toDrinkSupplier));
}));

interface SupplierInput {
  id?: string; name?: string; products?: string; orderDays?: string[]; orderDaysNote?: string;
  orderCutoff?: string; deliveryWindow?: string; contact?: unknown; minimumOrder?: string;
  notes?: string; priceListRef?: string;
}

function validateSupplierInput(input: SupplierInput, requireId: boolean): void {
  if (requireId) {
    const e = checkId(input.id, 'id');
    if (e) throw new AppError(400, e);
  }
  if (typeof input.name !== 'string' || input.name.length === 0 || input.name.length > 200) throw new AppError(400, 'invalid name');
  if (input.orderDays != null && (!Array.isArray(input.orderDays) || input.orderDays.length > 7)) throw new AppError(400, 'invalid orderDays');
  if (input.contact != null && (typeof input.contact !== 'object' || Array.isArray(input.contact))) throw new AppError(400, 'invalid contact');
  for (const [k, max] of [['products', 2000], ['orderDaysNote', 500], ['orderCutoff', 200], ['deliveryWindow', 200], ['minimumOrder', 500], ['notes', 5000], ['priceListRef', 500]] as const) {
    const v = (input as Record<string, unknown>)[k];
    if (v != null && (typeof v !== 'string' || v.length > max)) throw new AppError(400, `invalid ${k}`);
  }
}

function buildSupplierData(input: SupplierInput) {
  return {
    name: input.name as string,
    products: input.products ?? '',
    orderDays: input.orderDays ?? [],
    orderDaysNote: input.orderDaysNote ?? '',
    orderCutoff: input.orderCutoff ?? '',
    deliveryWindow: input.deliveryWindow ?? '',
    contact: (input.contact ?? {}) as Prisma.InputJsonValue,
    minimumOrder: input.minimumOrder ?? '',
    notes: input.notes ?? '',
    priceListRef: input.priceListRef ?? '',
  };
}

router.post('/suppliers', asyncHandler(async (req: Request, res: Response) => {
  assertManager(req);
  const input = req.body as SupplierInput;
  validateSupplierInput(input, true);
  const created = await withWriteLock(async () =>
    prisma.drinkSupplier.create({ data: { id: input.id as string, ...buildSupplierData(input) } }),
  );
  const user = actor(req);
  dbAppendLog(user.email, user.name, 'drink-supplier-create', `created supplier "${input.name}"`);
  const shape = toDrinkSupplier(created);
  broadcast(user.email, 'patch', { user: user.name, drinkSuppliers: [shape] });
  res.json(shape);
}));

router.patch('/suppliers/:id', asyncHandler(async (req: Request, res: Response) => {
  assertManager(req);
  const idErr = checkId(req.params.id as string, 'id');
  if (idErr) throw new AppError(400, idErr);
  const input = req.body as SupplierInput;
  validateSupplierInput(input, false);
  const updated = await withWriteLock(async () => {
    const existing = await prisma.drinkSupplier.findUnique({ where: { id: req.params.id as string } });
    if (!existing) return null;
    return prisma.drinkSupplier.update({ where: { id: req.params.id as string }, data: buildSupplierData(input) });
  });
  if (!updated) throw new AppError(404, 'Supplier not found');
  const user = actor(req);
  dbAppendLog(user.email, user.name, 'drink-supplier-update', `updated supplier "${input.name}"`);
  const shape = toDrinkSupplier(updated);
  broadcast(user.email, 'patch', { user: user.name, drinkSuppliers: [shape] });
  res.json(shape);
}));

router.delete('/suppliers/:id', asyncHandler(async (req: Request, res: Response) => {
  assertManager(req);
  const idErr = checkId(req.params.id as string, 'id');
  if (idErr) throw new AppError(400, idErr);
  const result = await withWriteLock(async () => {
    const existing = await prisma.drinkSupplier.findUnique({ where: { id: req.params.id as string } });
    if (!existing) return null;
    await prisma.drinkSupplier.delete({ where: { id: req.params.id as string } });
    return existing;
  });
  if (!result) throw new AppError(404, 'Supplier not found');
  const user = actor(req);
  dbAppendLog(user.email, user.name, 'drink-supplier-delete', `deleted supplier "${result.name}"`);
  broadcast(user.email, 'patch', { user: user.name, deletedDrinkSuppliers: [req.params.id as string] });
  res.json({ ok: true });
}));

// ─── Single drink + CRUD ────────────────────────────────────────────────────

router.get('/:id', asyncHandler(async (req: Request, res: Response) => {
  const idErr = checkId(req.params.id as string, 'id');
  if (idErr) throw new AppError(400, idErr);
  const row = await prisma.drink.findUnique({
    where: { id: req.params.id as string },
    include: { ingredientRows: { orderBy: { sortOrder: 'asc' } } },
  });
  if (!row) throw new AppError(404, 'Drink not found');
  const stock = await stockByLocationFor(row.id);
  res.json(toDrink(row, stock));
}));

router.post('/', asyncHandler(async (req: Request, res: Response) => {
  const input = req.body as DrinkInput;
  const mgr = isManagerEmail(req.user?.email);
  // Catalogue (bought) drinks are manager-gated; recipe drinks are open to all
  // (with money fields gated below). See DECISIONS.md [m2]/[m3].
  if (input.mode === 'catalogue' && !mgr) throw new AppError(403, 'Manager access required.');
  validateDrinkInput(input, true);
  const id = input.id as string;
  const data = buildDrinkData(input);
  gateMoneyFields(data, input, null, mgr);
  const shape = await withWriteLock(async () => {
    await prisma.$transaction(async (txc) => {
      await txc.drink.create({ data: { ...(data as Prisma.DrinkUncheckedCreateInput), id, archived: false } });
      if (input.mode === 'recipe') {
        const rowData = buildRowData(input.ingredientRows, id);
        if (rowData.length) await txc.drinkIngredientRow.createMany({ data: rowData });
      }
    });
    await recalcAllDrinkCosts();
    return fetchDrinkShape(id);
  });
  if (!shape) throw new AppError(500, 'Create failed');
  const user = actor(req);
  dbAppendLog(user.email, user.name, 'drink-create', `created drink "${input.name}" (${input.mode})`);
  broadcast(user.email, 'patch', { user: user.name, drinks: [shape] });
  res.json(shape);
}));

router.patch('/:id', asyncHandler(async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const idErr = checkId(id, 'id');
  if (idErr) throw new AppError(400, idErr);
  const input = req.body as DrinkInput;
  const mgr = isManagerEmail(req.user?.email);
  if (input.mode === 'catalogue' && !mgr) throw new AppError(403, 'Manager access required.');
  validateDrinkInput(input, false);
  const result = await withWriteLock(async () => {
    const existing = await prisma.drink.findUnique({ where: { id } });
    if (!existing) return null;
    // Block non-managers from editing an existing catalogue drink even if the
    // payload claims a different mode.
    if (existing.mode === 'catalogue' && !mgr) throw new AppError(403, 'Manager access required.');
    const data = buildDrinkData(input);
    gateMoneyFields(data, input, existing, mgr);
    await prisma.$transaction(async (txc) => {
      await txc.drink.update({ where: { id }, data });
      const effectiveMode = input.mode || existing.mode;
      if (effectiveMode === 'recipe' && input.ingredientRows !== undefined) {
        await txc.drinkIngredientRow.deleteMany({ where: { drinkId: id } });
        const rowData = buildRowData(input.ingredientRows, id);
        if (rowData.length) await txc.drinkIngredientRow.createMany({ data: rowData });
      }
    });
    await recalcAllDrinkCosts();
    return fetchDrinkShape(id);
  });
  if (!result) throw new AppError(404, 'Drink not found');
  const user = actor(req);
  dbAppendLog(user.email, user.name, 'drink-update', `updated drink "${input.name}"`);
  broadcast(user.email, 'patch', { user: user.name, drinks: [result] });
  res.json(result);
}));

router.delete('/:id', asyncHandler(async (req: Request, res: Response) => {
  assertManager(req);
  const idErr = checkId(req.params.id as string, 'id');
  if (idErr) throw new AppError(400, idErr);
  const result = await withWriteLock(async () => {
    const existing = await prisma.drink.findUnique({ where: { id: req.params.id as string } });
    if (!existing) return { notFound: true } as const;
    // Real bottles/kegs exist → block delete (mirrors the batch/supply rule).
    const grouped = await prisma.drinkStock.groupBy({ by: ['drinkId'], where: { drinkId: req.params.id as string }, _sum: { qty: true } });
    const totalStock = grouped.reduce((s, g) => s + (g._sum?.qty ?? 0), 0);
    if (totalStock > 0) return { hasStock: true, name: existing.name } as const;
    // ON DELETE CASCADE clears ingredient rows / stock rows; refDrink FKs SET NULL.
    await prisma.drink.delete({ where: { id: req.params.id as string } });
    return { ok: true, name: existing.name } as const;
  });
  if ('notFound' in result) throw new AppError(404, 'Drink not found');
  if ('hasStock' in result) throw new AppError(400, `Cannot delete "${result.name}": stock > 0. Zero it out (or write it off) first.`);
  const user = actor(req);
  dbAppendLog(user.email, user.name, 'drink-delete', `deleted drink "${result.name}"`);
  broadcast(user.email, 'patch', { user: user.name, deletedDrinks: [req.params.id as string] });
  res.json({ ok: true });
}));

export default router;
