import express, { Request, Response } from 'express';
import fs from 'fs';
import { INGREDIENTS_SEED, asyncHandler } from '../lib/config';
import { Prisma } from '@prisma/client';
import { prisma, dbAppendLog, recalcRecipeCostsForIngredient, recalcAllRecipeCosts, withWriteLock, checkId, validateIngredients } from '../lib/db';
import { addBackendEvent } from './telemetry';
import { broadcast } from './events';
import { requireScreenEdit } from './auth';
import ingredientsImportRouter from './ingredients-import';
import type { Ingredient, LocationStock } from '../shared/types';

// Slim wire shape for SSE broadcasts. Mirrors the projection in the GET / handler
// below — keep the two in lockstep so a remote patch matches the GET response.
function toIngredientWire(ing: Ingredient) {
  return {
    id: ing.id,
    name: ing.name,
    supplierName: ing.supplierName,
    types: ing.types || [],
    category: ing.category,
    measureMode: ing.measureMode || 'weight',
    unit: ing.unit,
    supplier: ing.supplier,
    orderCode: ing.orderCode,
    orderUnit: ing.orderUnit,
    orderPrice: ing.orderPrice || '',
    orderUnitSize: ing.orderUnitSize || 0,
    priceLevel: ing.priceLevel || '',
    pricePer100: ing.pricePer100 || 0,
    priceAlert: ing.priceAlert || false,
    storageLocations: ing.storageLocations || {},
    stock: ing.stock || {},
    targetStock: ing.targetStock || {},
    allergens: ing.allergens,
    notes: ing.notes,
    active: ing.active,
  };
}

const router = express.Router();

// Mount import sub-router (upload-supplier)
router.use('/', ingredientsImportRouter);

// Helper: load ingredients (SLIM shape) from Postgres or fall back to seed file.
// Drops the heavy priceHistory/nutrition JSON columns the slim wire endpoints
// (GET /api/ingredients + the AI catalog) never return (audit PERF-8). The DB
// editor uses loadIngredientsFull() below.
export async function loadIngredients(): Promise<Ingredient[]> {
  try {
    const rows = await prisma.ingredient.findMany({
      select: {
        id: true, name: true, supplierName: true, types: true, category: true,
        measureMode: true, unit: true, supplier: true, orderCode: true, orderUnit: true,
        orderPrice: true, orderUnitSize: true, priceLevel: true, pricePer100: true,
        priceAlert: true, storageLocations: true, stock: true, targetStock: true,
        allergens: true, notes: true, active: true,
      },
    });
    if (rows.length > 0) return rows as unknown as Ingredient[];
  } catch (e: unknown) {
    console.error('DB ingredient load error:', e instanceof Error ? e.message : 'Unknown error');
  }
  if (fs.existsSync(INGREDIENTS_SEED)) {
    return JSON.parse(fs.readFileSync(INGREDIENTS_SEED, 'utf8'));
  }
  return [];
}

// Full ingredient rows (all columns incl priceHistory/nutrition) — for the
// ingredient-DB editor (GET /api/ingredients/full) only.
export async function loadIngredientsFull(): Promise<Ingredient[]> {
  try {
    const rows = await prisma.ingredient.findMany();
    if (rows.length > 0) return rows as unknown as Ingredient[];
  } catch (e: unknown) {
    console.error('DB ingredient load error:', e instanceof Error ? e.message : 'Unknown error');
  }
  if (fs.existsSync(INGREDIENTS_SEED)) {
    return JSON.parse(fs.readFileSync(INGREDIENTS_SEED, 'utf8'));
  }
  return [];
}

router.get('/', asyncHandler(async (_req: Request, res: Response) => {
  const ingredients = await loadIngredients();
  res.json(ingredients.map((ing: Ingredient) => ({
    id: ing.id,
    name: ing.name,
    supplierName: ing.supplierName,
    types: ing.types || [],
    category: ing.category,
    measureMode: ing.measureMode || 'weight',
    unit: ing.unit,
    supplier: ing.supplier,
    orderCode: ing.orderCode,
    orderUnit: ing.orderUnit,
    orderPrice: ing.orderPrice || '',
    orderUnitSize: ing.orderUnitSize || 0,
    priceLevel: ing.priceLevel || '',
    pricePer100: ing.pricePer100 || 0,
    priceAlert: ing.priceAlert || false,
    storageLocations: ing.storageLocations || {},
    stock: ing.stock || {},
    targetStock: ing.targetStock || {},
    allergens: ing.allergens,
    notes: ing.notes,
    active: ing.active,
  })));
}));

// Full ingredient list (for the ingredient DB editor tab)
router.get('/full', asyncHandler(async (_req: Request, res: Response) => {
  const ingredients = await loadIngredientsFull();
  // ~2100 rows, large JSON payload, changes rarely — the DB editor screen
  // is the only consumer. 1424ms avg (AI insight #31) was transfer-dominated
  // even after gzip. 30s browser cache eliminates repeat fetches when
  // flipping between tabs. Kept short because ingredient edits do NOT
  // broadcast via SSE, so other users would see stale prices/stock for
  // up to this window when they open the DB tab.
  res.set('Cache-Control', 'private, max-age=30');
  res.json(ingredients);
}));

// Audit T19a: column-by-column upsert spec. Used by the bulk POST below.
// Listed in the same order as the SQL placeholder/values arrays — keep
// them in lockstep when adding/removing columns. The `cast` is applied
// to the placeholder in the VALUES clause so Postgres knows to parse JSON
// strings as JSONB.
const INGREDIENT_UPSERT_COLUMNS: Array<{ name: string; cast: string }> = [
  { name: 'id', cast: '' },
  { name: 'name', cast: '' },
  { name: 'supplier_name', cast: '' },
  { name: 'types', cast: '::jsonb' },
  { name: 'category', cast: '' },
  { name: 'unit', cast: '' },
  { name: 'supplier', cast: '' },
  { name: 'order_code', cast: '' },
  { name: 'order_unit', cast: '' },
  { name: 'order_price', cast: '' },
  { name: 'price_level', cast: '' },
  { name: 'price_history', cast: '::jsonb' },
  { name: 'price_alert', cast: '' },
  { name: 'storage_locations', cast: '::jsonb' },
  { name: 'stock', cast: '::jsonb' },
  { name: 'nutrition', cast: '::jsonb' },
  { name: 'allergens', cast: '' },
  { name: 'notes', cast: '' },
  { name: 'active', cast: '' },
  { name: 'order_unit_size', cast: '' },
  { name: 'price_per_100', cast: '' },
  { name: 'measure_mode', cast: '' },
  { name: 'target_stock', cast: '::jsonb' },
];

function ingredientUpsertValues(ing: Ingredient): unknown[] {
  const orderPrice = ing.orderPrice != null ? parseFloat(String(ing.orderPrice)) || null : null;
  const orderUnitSize = parseFloat(String(ing.orderUnitSize)) || 0;
  const pricePer100 = (orderPrice && orderUnitSize > 0)
    ? Math.round((orderPrice / orderUnitSize) * 10000) / 100
    : 0;
  // ORDER MUST MATCH INGREDIENT_UPSERT_COLUMNS EXACTLY.
  return [
    ing.id,
    ing.name || '',
    ing.supplierName || '',
    JSON.stringify(ing.types || []),
    ing.category || '',
    ing.unit || 'Grams',
    ing.supplier || '',
    ing.orderCode || '',
    ing.orderUnit || '',
    orderPrice,
    ing.priceLevel || '',
    JSON.stringify(ing.priceHistory || []),
    !!ing.priceAlert,
    JSON.stringify(ing.storageLocations || {}),
    JSON.stringify(ing.stock || {}),
    JSON.stringify(ing.nutrition || {}),
    ing.allergens || '',
    ing.notes || '',
    ing.active !== false,
    orderUnitSize,
    pricePer100,
    ing.measureMode || 'weight',
    JSON.stringify(ing.targetStock || {}),
  ];
}

// Bulk save all ingredients — frontend always sends the complete set
// (supplier-XLSX import via applySupplierUpdate). withWriteLock serialises
// against any concurrent ingredient edit so a single-row save during a bulk
// replace can't be silently dropped.
//
// Audit T19a: the previous shape was `deleteMany + createMany`. The FK
// `recipe_ingredients.ingredient_id` is `ON DELETE SET NULL`, so the
// deleteMany trigger NULLed every recipe→ingredient link, and the
// immediate createMany did NOT restore them. Result: every supplier
// import silently severed all recipe→ingredient pointers. Staging was
// 100% wiped (618/618 NULL); prod 21/625 NULL.
//
// Fix: a single `INSERT … ON CONFLICT (id) DO UPDATE` statement preserves
// existing rows in place (UPDATE never fires the SET NULL trigger). Rows
// the frontend has removed are still pruned by a targeted deleteMany —
// SET NULL fires only for those, which is correct (they're truly gone).
router.post('/', requireScreenEdit('orders'), asyncHandler(async (req: Request, res: Response) => {
  const ingredients = req.body;
  // Audit T20: per-row validation (length caps, types[] bounds, JSON
  // shapes) — was previously only "is it an array?" plus a checkId loop
  // for S2. validateIngredients also handles the array+duplicate-id
  // checks, so the early-out here is just to give a clean 400 instead of
  // a 500 from validateIngredients dereferencing a non-array.
  if (!Array.isArray(ingredients)) return res.status(400).json({ error: 'Expected array' });
  const validationErr = validateIngredients(ingredients);
  if (validationErr) return res.status(400).json({ error: validationErr });
  await withWriteLock(async () => {
    await prisma.$transaction(async (tx) => {
      const incomingIds = new Set(ingredients.map((i: Ingredient) => i.id));

      // Delete only ingredients the frontend has dropped from the set —
      // the SET NULL trigger fires for these, but those recipes are also
      // genuinely missing the ingredient now, so NULL is the right answer.
      const existing = await tx.ingredient.findMany({ select: { id: true } });
      const toDelete = existing.filter(e => !incomingIds.has(e.id)).map(e => e.id);
      if (toDelete.length > 0) {
        await tx.ingredient.deleteMany({ where: { id: { in: toDelete } } });
      }

      if (ingredients.length === 0) return;

      // Build a single INSERT … ON CONFLICT DO UPDATE. Parameterised values
      // (no SQL injection surface). 23 columns × N rows; each cell is one
      // bind parameter, with a per-column `::jsonb` cast where needed so
      // Postgres parses the JSON strings.
      //
      // Postgres caps bind params at 65,535 — at 23 cols/row that's a
      // ~2,849 row ceiling. Current load is ~1,162 ingredients on staging
      // so we have headroom; add chunked batching here if the table ever
      // grows past ~2,500 rows.
      const cols = INGREDIENT_UPSERT_COLUMNS;
      const allValues: unknown[] = [];
      const rowPlaceholders: string[] = [];
      for (let r = 0; r < ingredients.length; r++) {
        const offset = r * cols.length;
        const cells = cols.map((c, i) => `$${offset + i + 1}${c.cast}`).join(', ');
        rowPlaceholders.push(`(${cells})`);
        allValues.push(...ingredientUpsertValues(ingredients[r] as Ingredient));
      }
      const colList = cols.map(c => `"${c.name}"`).join(', ');
      const updateSet = cols
        .filter(c => c.name !== 'id')
        .map(c => `"${c.name}" = EXCLUDED."${c.name}"`)
        .join(', ');
      const sql =
        `INSERT INTO ingredients (${colList}) VALUES ${rowPlaceholders.join(', ')} ` +
        `ON CONFLICT (id) DO UPDATE SET ${updateSet}`;

      await tx.$executeRawUnsafe(sql, ...allValues);
      // The full-set upsert ships ~27K bind params in one statement; on a
      // high-latency link it legitimately exceeds Prisma's 5s default
      // transaction timeout, so give it real headroom.
    }, { timeout: 60_000 });
  });
  // Audit T19: bulk supplier-XLSX imports change pricePer100 across many
  // ingredients at once. The per-ingredient recalc loop below (POST /:id)
  // doesn't fire on this path, so without this every recipe's cached
  // costPerServing went stale until the next single-ingredient edit. Now
  // that T19a preserves recipe→ingredient FKs across the bulk POST, this
  // recalc actually produces real numbers (pre-T19a it would have seen
  // zero linked rows for every recipe). Awaited so the response only
  // returns once costs are consistent — bulk POST is already a heavy
  // one-shot user action; the extra latency is acceptable. Surfacing
  // recipeCostsUpdated in the response means a future regression that
  // accidentally drops the trigger fails-loud.
  let recalcUpdated = 0;
  try {
    recalcUpdated = await recalcAllRecipeCosts();
  } catch (e: unknown) {
    console.error('recalcAllRecipeCosts after bulk ingredient save failed:', e instanceof Error ? e.message : e);
  }
  const user = req.user || { email: 'anonymous', name: 'Anonymous' };
  dbAppendLog(user.email, user.name, 'ingredients-bulk', `saved ${ingredients.length} ingredients (recalculated ${recalcUpdated} recipe costs)`);
  // Bulk reload trigger — too many rows to ship through SSE; receivers re-fetch
  // both ingredients and recipes (since costs may have changed).
  broadcast(user.email, 'patch', {
    user: user.name,
    ingredientsBulkReload: true,
    ...(recalcUpdated > 0 ? { recipesReload: true as const } : {}),
  });
  res.json({ ok: true, count: ingredients.length, recipeCostsUpdated: recalcUpdated });
}));

// Update target stock for a single ingredient at one location.
// withWriteLock prevents the read-modify-write on the JSON targetStock column
// from racing with a concurrent edit.
router.post('/target-stock', requireScreenEdit('orders'), asyncHandler(async (req: Request, res: Response) => {
  const { ingredientId, location, amount } = req.body;
  if (!ingredientId || !location) return res.status(400).json({ error: 'ingredientId and location required' });
  const result = await withWriteLock(async () => {
    const ing = await prisma.ingredient.findUnique({ where: { id: ingredientId } });
    if (!ing) return { notFound: true };
    const targetStock = (ing.targetStock || {}) as LocationStock;
    if (amount === null || amount === undefined || amount === '' || parseFloat(amount) <= 0) {
      delete targetStock[location];
    } else {
      targetStock[location] = parseFloat(amount);
    }
    await prisma.ingredient.update({ where: { id: ingredientId }, data: { targetStock: targetStock as unknown as Prisma.InputJsonValue } });
    return { notFound: false };
  });
  if (result.notFound) return res.status(404).json({ error: 'Ingredient not found' });
  const user = req.user || { email: 'anonymous', name: 'Anonymous' };
  const updated = await prisma.ingredient.findUnique({ where: { id: ingredientId } });
  if (updated) {
    broadcast(user.email, 'patch', { user: user.name, ingredients: [toIngredientWire(updated as unknown as Ingredient)] });
  }
  res.json({ ok: true });
}));

// Update stock for a single ingredient at one location.
// withWriteLock prevents two concurrent stock edits from clobbering each other
// when both read the JSON `stock` column at the same time. Was the lost-update
// bug from audit §3.1.
router.post('/stock', requireScreenEdit('orders'), asyncHandler(async (req: Request, res: Response) => {
  const { ingredientId, location, amount } = req.body;
  if (!ingredientId || !location) return res.status(400).json({ error: 'ingredientId and location required' });
  const result = await withWriteLock(async () => {
    const ing = await prisma.ingredient.findUnique({ where: { id: ingredientId } });
    if (!ing) return { notFound: true };
    const stock = (ing.stock || {}) as Record<string, { amount: number; date: string }>;
    stock[location] = { amount: parseFloat(amount) || 0, date: new Date().toISOString().slice(0, 10) };
    await prisma.ingredient.update({ where: { id: ingredientId }, data: { stock: stock as unknown as Prisma.InputJsonValue } });
    return { notFound: false };
  });
  if (result.notFound) return res.status(404).json({ error: 'Ingredient not found' });
  const user = req.user || { email: 'anonymous', name: 'Anonymous' };
  const updated = await prisma.ingredient.findUnique({ where: { id: ingredientId } });
  if (updated) {
    broadcast(user.email, 'patch', { user: user.name, ingredients: [toIngredientWire(updated as unknown as Ingredient)] });
  }
  res.json({ ok: true });
}));

// Bulk stock update (for stocktake). Per-row read-modify-write inside a
// transaction; withWriteLock ensures two stocktake submissions don't race.
router.post('/stock/bulk', requireScreenEdit('orders'), asyncHandler(async (req: Request, res: Response) => {
  const updates = req.body;
  if (!Array.isArray(updates)) return res.status(400).json({ error: 'Expected array' });
  await withWriteLock(async () => {
    await prisma.$transaction(async (tx) => {
      for (const u of updates) {
        const ing = await tx.ingredient.findUnique({ where: { id: u.ingredientId } });
        if (!ing) continue;
        const stock = (ing.stock || {}) as Record<string, { amount: number; date: string }>;
        stock[u.location] = { amount: parseFloat(u.amount) || 0, date: new Date().toISOString().slice(0, 10) };
        await tx.ingredient.update({ where: { id: u.ingredientId }, data: { stock: stock as unknown as Prisma.InputJsonValue } });
      }
    });
  });
  const user = req.user || { email: 'anonymous', name: 'Anonymous' };
  dbAppendLog(user.email, user.name, 'stock-update', `bulk stock update: ${updates.length} items`);
  // Re-fetch the affected rows in one query and broadcast as ingredient upserts
  const ids = Array.from(new Set(updates.map((u: { ingredientId: string }) => u.ingredientId).filter(Boolean)));
  if (ids.length > 0) {
    const rows = await prisma.ingredient.findMany({ where: { id: { in: ids } } });
    if (rows.length > 0) {
      broadcast(user.email, 'patch', {
        user: user.name,
        ingredients: rows.map(r => toIngredientWire(r as unknown as Ingredient)),
      });
    }
  }
  res.json({ ok: true, updated: updates.length });
}));

// Save single ingredient (create or update) — must be after specific routes
router.post('/:id', requireScreenEdit('orders'), asyncHandler(async (req: Request, res: Response) => {
  const ingredient = req.body;
  if (!ingredient || !ingredient.name) return res.status(400).json({ error: 'name required' });
  const idErr = checkId(req.params.id, 'id');
  if (idErr) return res.status(400).json({ error: idErr });
  const orderPrice = ingredient.orderPrice != null ? parseFloat(ingredient.orderPrice) || null : null;
  const orderUnitSize = parseFloat(ingredient.orderUnitSize) || 0;
  const data = {
    name: ingredient.name || '',
    supplierName: ingredient.supplierName || '',
    types: ingredient.types || [],
    category: ingredient.category || '',
    measureMode: ingredient.measureMode || 'weight',
    unit: ingredient.unit || 'Grams',
    supplier: ingredient.supplier || '',
    orderCode: ingredient.orderCode || '',
    orderUnit: ingredient.orderUnit || '',
    orderPrice,
    orderUnitSize,
    priceLevel: ingredient.priceLevel || '',
    pricePer100: (orderPrice && orderUnitSize > 0) ? Math.round((orderPrice / orderUnitSize) * 10000) / 100 : 0,
    priceHistory: ingredient.priceHistory || [],
    priceAlert: !!ingredient.priceAlert,
    storageLocations: ingredient.storageLocations || {},
    stock: ingredient.stock || {},
    targetStock: ingredient.targetStock || {},
    nutrition: ingredient.nutrition || {},
    allergens: ingredient.allergens || '',
    notes: ingredient.notes || '',
    active: ingredient.active !== false,
  };
  await withWriteLock(async () => {
    await prisma.ingredient.upsert({
      where: { id: req.params.id as string },
      create: { id: req.params.id as string, ...data },
      update: data,
    });
  });
  const user = req.user || { email: 'anonymous', name: 'Anonymous' };
  dbAppendLog(user.email, user.name, 'ingredient', `saved "${ingredient.name}"`);
  // Recalculate costs for any recipes using this ingredient (fire-and-forget).
  // Audit T5: failures previously only hit stderr (same shape as the 31-day
  // silent finance-sync incident). Surface via addBackendEvent so the AI
  // insights cron / telemetry summary picks up sustained failure.
  // Serialize the recalc's recipe.update writes with other writers so they can't
  // clobber a concurrent recipe-editor cost write (audit PERF-7 pt2). Still
  // fire-and-forget — the response doesn't await it, so saves stay fast.
  withWriteLock(() => recalcRecipeCostsForIngredient(req.params.id as string)).catch((e: unknown) => {
    const message = e instanceof Error ? e.message : 'Unknown error';
    console.error(`Failed to recalculate recipe costs for ingredient ${req.params.id}:`, message);
    addBackendEvent('error', 'recipe_cost_recalc_failed', {
      ingredientId: req.params.id,
      message,
    });
  });
  // Re-fetch and broadcast. Recipe-cost staleness from this path's
  // fire-and-forget recalc is accepted for v1 — recipe cost displays update
  // on next page load.
  const updated = await prisma.ingredient.findUnique({ where: { id: req.params.id as string } });
  if (updated) {
    broadcast(user.email, 'patch', { user: user.name, ingredients: [toIngredientWire(updated as unknown as Ingredient)] });
  }
  res.json({ ok: true });
}));

// Delete ingredient
router.delete('/:id', requireScreenEdit('orders'), asyncHandler(async (req: Request, res: Response) => {
  const id = req.params.id as string;
  await withWriteLock(async () => {
    await prisma.ingredient.delete({ where: { id } });
  });
  const user = req.user || { email: 'anonymous', name: 'Anonymous' };
  dbAppendLog(user.email, user.name, 'ingredient-delete', `deleted ingredient ${id}`);
  broadcast(user.email, 'patch', { user: user.name, deletedIngredients: [id] });
  res.json({ ok: true });
}));

export default router;
