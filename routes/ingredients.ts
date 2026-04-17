import express, { Request, Response } from 'express';
import fs from 'fs';
import { INGREDIENTS_SEED, asyncHandler } from '../lib/config';
import { Prisma } from '@prisma/client';
import { prisma, dbAppendLog, recalcRecipeCostsForIngredient } from '../lib/db';
import ingredientsImportRouter from './ingredients-import';
import type { Ingredient, LocationStock } from '../shared/types';

const router = express.Router();

// Mount import sub-router (upload-supplier, migrate)
router.use('/', ingredientsImportRouter);

// Helper: load ingredients from Postgres or fall back to seed file
export async function loadIngredients(): Promise<Ingredient[]> {
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
  const ingredients = await loadIngredients();
  // ~2100 rows, large JSON payload, changes rarely — the DB editor screen
  // is the only consumer. 1424ms avg (AI insight #31) was transfer-dominated
  // even after gzip. 30s browser cache eliminates repeat fetches when
  // flipping between tabs. Kept short because ingredient edits do NOT
  // broadcast via SSE, so other users would see stale prices/stock for
  // up to this window when they open the DB tab.
  res.set('Cache-Control', 'private, max-age=30');
  res.json(ingredients);
}));

// Bulk save all ingredients
router.post('/', asyncHandler(async (req: Request, res: Response) => {
  const ingredients = req.body;
  if (!Array.isArray(ingredients)) return res.status(400).json({ error: 'Expected array' });
  await prisma.$transaction([
    prisma.ingredient.deleteMany(),
    prisma.ingredient.createMany({
      data: ingredients.map((ing: Ingredient) => {
        const orderPrice = ing.orderPrice != null ? parseFloat(String(ing.orderPrice)) || null : null;
        const orderUnitSize = parseFloat(String(ing.orderUnitSize)) || 0;
        return {
          id: ing.id,
          name: ing.name || '',
          supplierName: ing.supplierName || '',
          types: ing.types || [],
          category: ing.category || '',
          measureMode: ing.measureMode || 'weight',
          unit: ing.unit || 'Grams',
          supplier: ing.supplier || '',
          orderCode: ing.orderCode || '',
          orderUnit: ing.orderUnit || '',
          orderPrice,
          orderUnitSize,
          priceLevel: ing.priceLevel || '',
          pricePer100: (orderPrice && orderUnitSize > 0) ? Math.round((orderPrice / orderUnitSize) * 10000) / 100 : 0,
          priceHistory: ing.priceHistory || [],
          priceAlert: !!ing.priceAlert,
          storageLocations: ing.storageLocations || {},
          stock: (ing.stock || {}) as unknown as Prisma.InputJsonValue,
          targetStock: ing.targetStock || {},
          nutrition: ing.nutrition || {},
          allergens: ing.allergens || '',
          notes: ing.notes || '',
          active: ing.active !== false,
        };
      }),
    }),
  ]);
  const user = req.user || { email: 'anonymous', name: 'Anonymous' };
  dbAppendLog(user.email, user.name, 'ingredients-bulk', `saved ${ingredients.length} ingredients`);
  res.json({ ok: true, count: ingredients.length });
}));

// Update target stock for a single ingredient at one location
router.post('/target-stock', asyncHandler(async (req: Request, res: Response) => {
  const { ingredientId, location, amount } = req.body;
  if (!ingredientId || !location) return res.status(400).json({ error: 'ingredientId and location required' });
  const ing = await prisma.ingredient.findUnique({ where: { id: ingredientId } });
  if (!ing) return res.status(404).json({ error: 'Ingredient not found' });
  const targetStock = (ing.targetStock || {}) as LocationStock;
  if (amount === null || amount === undefined || amount === '' || parseFloat(amount) <= 0) {
    delete targetStock[location];
  } else {
    targetStock[location] = parseFloat(amount);
  }
  await prisma.ingredient.update({ where: { id: ingredientId }, data: { targetStock: targetStock as unknown as Prisma.InputJsonValue } });
  res.json({ ok: true });
}));

// Update stock for a single ingredient at one location
router.post('/stock', asyncHandler(async (req: Request, res: Response) => {
  const { ingredientId, location, amount } = req.body;
  if (!ingredientId || !location) return res.status(400).json({ error: 'ingredientId and location required' });
  const ing = await prisma.ingredient.findUnique({ where: { id: ingredientId } });
  if (!ing) return res.status(404).json({ error: 'Ingredient not found' });
  const stock = (ing.stock || {}) as Record<string, { amount: number; date: string }>;
  stock[location] = { amount: parseFloat(amount) || 0, date: new Date().toISOString().slice(0, 10) };
  await prisma.ingredient.update({ where: { id: ingredientId }, data: { stock: stock as unknown as Prisma.InputJsonValue } });
  res.json({ ok: true });
}));

// Bulk stock update (for stocktake)
router.post('/stock/bulk', asyncHandler(async (req: Request, res: Response) => {
  const updates = req.body;
  if (!Array.isArray(updates)) return res.status(400).json({ error: 'Expected array' });
  await prisma.$transaction(async (tx) => {
    for (const u of updates) {
      const ing = await tx.ingredient.findUnique({ where: { id: u.ingredientId } });
      if (!ing) continue;
      const stock = (ing.stock || {}) as Record<string, { amount: number; date: string }>;
      stock[u.location] = { amount: parseFloat(u.amount) || 0, date: new Date().toISOString().slice(0, 10) };
      await tx.ingredient.update({ where: { id: u.ingredientId }, data: { stock: stock as unknown as Prisma.InputJsonValue } });
    }
  });
  const user = req.user || { email: 'anonymous', name: 'Anonymous' };
  dbAppendLog(user.email, user.name, 'stock-update', `bulk stock update: ${updates.length} items`);
  res.json({ ok: true, updated: updates.length });
}));

// Save single ingredient (create or update) — must be after specific routes
router.post('/:id', asyncHandler(async (req: Request, res: Response) => {
  const ingredient = req.body;
  if (!ingredient || !ingredient.name) return res.status(400).json({ error: 'name required' });
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
  await prisma.ingredient.upsert({
    where: { id: req.params.id as string },
    create: { id: req.params.id as string, ...data },
    update: data,
  });
  const user = req.user || { email: 'anonymous', name: 'Anonymous' };
  dbAppendLog(user.email, user.name, 'ingredient', `saved "${ingredient.name}"`);
  // Recalculate costs for any recipes using this ingredient (fire-and-forget)
  recalcRecipeCostsForIngredient(req.params.id as string).catch(e => {
    console.error(`Failed to recalculate recipe costs for ingredient ${req.params.id}:`, e);
  });
  res.json({ ok: true });
}));

// Delete ingredient
router.delete('/:id', asyncHandler(async (req: Request, res: Response) => {
  await prisma.ingredient.delete({ where: { id: req.params.id as string } });
  res.json({ ok: true });
}));

export default router;
