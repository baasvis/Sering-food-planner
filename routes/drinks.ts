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
  mergeConfig, validateDrinkInput, buildDrinkData, DrinkInput,
} from '../lib/drinks';

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
  // M2: catalogue CRUD is manager-gated. (M3 relaxes recipe-mode drafting for
  // all users with field-level price gating.)
  assertManager(req);
  const input = req.body as DrinkInput;
  validateDrinkInput(input, true);
  const data = buildDrinkData(input);
  const created = await withWriteLock(async () =>
    prisma.drink.create({
      data: { ...(data as Prisma.DrinkUncheckedCreateInput), id: input.id as string, archived: false },
      include: { ingredientRows: true },
    }),
  );
  const user = actor(req);
  dbAppendLog(user.email, user.name, 'drink-create', `created drink "${input.name}" (${input.mode})`);
  const shape = toDrink(created, {});
  broadcast(user.email, 'patch', { user: user.name, drinks: [shape] });
  res.json(shape);
}));

router.patch('/:id', asyncHandler(async (req: Request, res: Response) => {
  assertManager(req);
  const idErr = checkId(req.params.id as string, 'id');
  if (idErr) throw new AppError(400, idErr);
  const input = req.body as DrinkInput;
  validateDrinkInput(input, false);
  const data = buildDrinkData(input);
  const updated = await withWriteLock(async () => {
    const existing = await prisma.drink.findUnique({ where: { id: req.params.id as string } });
    if (!existing) return null;
    return prisma.drink.update({
      where: { id: req.params.id as string },
      data,
      include: { ingredientRows: { orderBy: { sortOrder: 'asc' } } },
    });
  });
  if (!updated) throw new AppError(404, 'Drink not found');
  const stock = await stockByLocationFor(updated.id);
  const user = actor(req);
  dbAppendLog(user.email, user.name, 'drink-update', `updated drink "${input.name}"`);
  const shape = toDrink(updated, stock);
  broadcast(user.email, 'patch', { user: user.name, drinks: [shape] });
  res.json(shape);
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
