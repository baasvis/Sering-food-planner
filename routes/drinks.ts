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

const SEED_BOOTSTRAP_AREA = 'Uncounted (pre-stocktake)';

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
        if (area !== SEED_BOOTSTRAP_AREA) {
          await txc.drinkStock.deleteMany({ where: { drinkId: id, location, area: SEED_BOOTSTRAP_AREA } });
        }
        saved++;
      }
    });
  });
  dbAppendLog(user.email, user.name, 'drink-stocktake', `${saved} counts @ ${location}/${area}`);
  broadcast(user.email, 'patch', { user: user.name, drinksReload: true });
  res.json({ saved });
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
