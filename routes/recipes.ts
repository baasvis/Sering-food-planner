import express, { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import crypto from 'crypto';
import multer from 'multer';
import { prisma, dbAppendLog, toRecipeFull, toRecipeIngredientFull, calcRecipeAllergens, calcRecipeCost, validateRecipe, withWriteLock, denormalizeRecipeIngredients, hydrateRecipeForDetail } from '../lib/db';
import { getSheetsClient } from '../lib/recipe-sheets';
import { asyncHandler, errMsg } from '../lib/config';
import { broadcast } from './events';
import type { RecipeIngredientFull, RecipeVersionSnapshot } from '../shared/types';

const upload = multer({ limits: { fileSize: 2 * 1024 * 1024 } }); // 2MB max

const router = express.Router();

// Legacy /api/recipe-index endpoints removed in S12. The RecipeIndex table is
// dropped; all recipes are now Recipe v2 (see /api/recipes). The frontend
// previously POSTed here from /core.ts (rate-after-served) and from the
// "Add legacy from Sheet" UI in /recipes.ts — both flows wrote to a table
// that was never returned to the client (dbReadAll forced recipeIndex: [])
// so any "saved" recipe disappeared on reload.

// External recipe reading — still uses Google Sheets API
router.get('/recipe', asyncHandler(async (req: Request, res: Response) => {
  const { sheetId } = req.query;
  if (!sheetId) return res.status(400).json({ error: 'sheetId required' });
  if (!/^[a-zA-Z0-9_-]+$/.test(sheetId as string)) return res.status(400).json({ error: 'Invalid sheetId format' });

  const sheets = getSheetsClient();
  if (!sheets) return res.status(503).json({ error: 'Google Sheets not configured' });

  const response = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: sheetId as string, ranges: ['C1','B3','D3','F3','H3','K2','K4','O3','O4','J6:N80','X6:X80','K6:K80'],
  });
  const vals = response.data.valueRanges!;
  const dishName    = vals[0].values?.[0]?.[0] || '';
  const serving     = parseFloat((vals[1].values?.[0]?.[0]||'280').toString().replace(',','.')) || 280;
  const allergens   = (vals[2].values?.[0]?.[0]||'').split(',').map((s: string)=>s.trim()).filter(Boolean);
  const servingTemp = vals[3].values?.[0]?.[0] || '';
  const structure   = vals[4].values?.[0]?.[0] || '';
  const dishType    = vals[5].values?.[0]?.[0] || '';
  const recipeVol   = parseFloat((vals[6].values?.[0]?.[0]||'0').toString().replace(',','.')) || 0;
  const seasonality = vals[7].values?.[0]?.[0] || '';
  const costPerServing = vals[8].values?.[0]?.[0] || '';
  const ingRows     = vals[9].values || [];
  const sourceRows  = vals[10].values || [];
  const unitRows    = vals[11].values || [];
  const ingredients: Array<{ name: string; amount: number; rawAmount: number; cookedAmount: number | null; unit: string; source: string }> = [];
  const seen = new Set<string>();
  ingRows.forEach((row: (string | undefined)[], i: number) => {
    if (!row[0]) return;
    const rawStr = row[2] ? String(row[2]).replace(',','.') : '';
    const cookedStr = row[3] ? String(row[3]).replace(',','.') : '';
    const rawAmt = parseFloat(rawStr) || 0;
    const cookedAmt = parseFloat(cookedStr) || 0;
    if (rawAmt <= 0 && cookedAmt <= 0) return;
    const amount = rawAmt > 0 ? rawAmt : cookedAmt;
    if (row[0].length > 80) return;
    const key = row[0].toLowerCase().trim();
    if (seen.has(key)) return;
    seen.add(key);
    const unit = (unitRows[i] && unitRows[i][0]) || 'Grams';
    ingredients.push({
      name: row[0],
      amount,
      rawAmount: rawAmt,
      cookedAmount: cookedAmt > 0 ? cookedAmt : null,
      unit,
      source: (sourceRows[i] && sourceRows[i][0]) || '',
    });
  });
  res.json({ dishName, serving, allergens, servingTemp, structure, dishType, recipeVolume: recipeVol, seasonality, costPerServing, ingredients });
}));

// ═════════════════════════════════════════════════════════════════════════════
// RECIPE V2 ENDPOINTS
// ═════════════════════════════════════════════════════════════════════════════

const includeIngredients = { ingredients: { orderBy: { sortOrder: 'asc' as const } } };

// List all recipes (with ingredients denormalized)
router.get('/recipes', asyncHandler(async (_req: Request, res: Response) => {
  const rows = await prisma.recipe.findMany({
    include: includeIngredients,
    orderBy: { name: 'asc' },
  });
  const recipes = rows.map(toRecipeFull);
  await denormalizeRecipeIngredients(recipes);
  res.json(recipes);
}));

// Get single recipe with full detail + nutrition
router.get('/recipes/:id', asyncHandler(async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const row = await prisma.recipe.findUnique({
    where: { id },
    include: includeIngredients,
  });
  if (!row) return res.status(404).json({ error: 'Recipe not found' });

  const recipe = toRecipeFull(row);

  // Single-query hydrate: denormalize names/allergens + compute cost +
  // compute nutrition from ONE ingredient.findMany. Does not write back —
  // cost is recalculated by /recipes/recalc-costs and when ingredient
  // prices change. See hydrateRecipeForDetail() docs in lib/db.ts for
  // the reasoning (fix for "recipe endpoints >1000ms" AI insight).
  await hydrateRecipeForDetail(recipe);

  // Short browser cache: users often bounce between the recipe detail and
  // the index in the same planning session. With 943ms avg per call
  // (AI insight #47), a 30s window eliminates most repeat round-trips.
  // PATCH /recipes/:id returns fresh data via broadcast, so staleness
  // window is ≤ 30s only for viewers who never edit.
  res.set('Cache-Control', 'private, max-age=30');
  res.json(recipe);
}));

// Create a new recipe
router.post('/recipes', asyncHandler(async (req: Request, res: Response) => {
  const body = req.body;
  const err = validateRecipe(body);
  if (err) return res.status(400).json({ error: err });

  const now = new Date().toISOString();
  const user = req.user || { email: 'anonymous', name: 'Anonymous' };
  const ingredients: RecipeIngredientFull[] = body.ingredients || [];

  // Calculate auto-allergens and cost
  const ingredientIds = ingredients.filter(i => i.ingredientId).map(i => i.ingredientId!);
  const autoAllergens = await calcRecipeAllergens(ingredientIds);
  const costPerServing = await calcRecipeCost(ingredients, body.servingSize || 280, body.recipeVolume || null, body.yieldType, body.outputCount);

  const recipe = await withWriteLock(async () => {
    return prisma.recipe.create({
      data: {
        id: body.id || crypto.randomUUID(),
        name: body.name,
        type: body.type || 'Soup',
        structure: body.structure || '',
        seasonality: body.seasonality || '',
        servingTemp: body.servingTemp || '',
        servingSize: body.servingSize || 280,
        recipeVolume: body.recipeVolume || null,
        yieldType: body.yieldType === 'count' ? 'count' : 'volume',
        outputCount: body.outputCount ?? null,
        outputUnit: body.outputUnit || null,
        autoAllergens,
        extraAllergens: body.extraAllergens || [],
        costPerServing,
        prepSteps: (body.prepSteps || []) as Prisma.InputJsonValue,
        coolingMethod: body.coolingMethod || '',
        storageMethod: body.storageMethod || '',
        isComplete: !!body.isComplete,
        versions: [] as unknown as Prisma.InputJsonValue,
        createdBy: user.email,
        createdAt: now,
        updatedAt: now,
        legacySheetId: body.legacySheetId || null,
        ingredients: {
          create: ingredients.map((ing, i) => ({
            id: ing.id || crypto.randomUUID(),
            ingredientId: ing.ingredientId || null,
            sortOrder: ing.sortOrder ?? i,
            rawAmount: ing.rawAmount,
            cookedAmount: ing.cookedAmount ?? null,
            unit: ing.unit || 'Grams',
            isFlexible: !!ing.isFlexible,
            flexCategory: ing.flexCategory || null,
            flexLabel: ing.flexLabel || null,
            suggestedNames: ing.suggestedNames || [],
          })),
        },
      },
      include: includeIngredients,
    });
  });

  dbAppendLog(user.email, user.name, 'recipe-create', `created "${body.name}"`);
  const result = toRecipeFull(recipe);
  broadcast(user.email, 'patch', { user: user.name, recipes: [result] });
  res.json(result);
}));

// Recalculate costs for all recipes (must be before /:id routes).
// withWriteLock prevents the loop's per-row updates from racing with
// concurrent recipe edits or another recalc trigger.
router.post('/recipes/recalculate-costs', asyncHandler(async (req: Request, res: Response) => {
  const user = req.user || { email: 'anonymous', name: 'Anonymous' };
  const recipes = await prisma.recipe.findMany({
    include: { ingredients: true },
  });

  const updated = await withWriteLock(async () => {
    let count = 0;
    for (const r of recipes) {
      try {
        const cost = await calcRecipeCost(r.ingredients, r.servingSize, r.recipeVolume, r.yieldType, r.outputCount);
        if (cost !== r.costPerServing) {
          await prisma.recipe.update({ where: { id: r.id }, data: { costPerServing: cost } });
          count++;
        }
      } catch (e: unknown) {
        console.warn(`Skipping recipe ${r.id} (${r.name}) cost recalc: ${errMsg(e)}`);
      }
    }
    return count;
  });

  if (updated > 0) {
    broadcast(user.email, 'patch', { user: user.name, recipesReload: true });
  }
  res.json({ ok: true, updated, total: recipes.length });
}));

// Bulk re-import cooked amounts from Google Sheets for all v2 recipes with legacySheetId
router.post('/recipes/import-cooked-amounts', asyncHandler(async (req: Request, res: Response) => {
  const user = req.user || { email: 'anonymous', name: 'Anonymous' };
  const sheets = getSheetsClient();
  if (!sheets) return res.status(503).json({ error: 'Google Sheets not configured' });

  const recipes = await prisma.recipe.findMany({
    where: { legacySheetId: { not: null } },
    include: { ingredients: { orderBy: { sortOrder: 'asc' } } },
  });

  // Pre-fetch all referenced ingredient names in ONE query, rather than doing
  // a per-row findUnique inside a nested loop. This was the N+1 hotspot —
  // previous runs took ~258s synchronously for 55 recipes with ~618 ingredient
  // rows between them, mostly because each row triggered its own DB roundtrip
  // AND each recipe's Google Sheets fetch ran sequentially.
  const allIngredientIds = Array.from(new Set(
    recipes.flatMap(r => r.ingredients.map(i => i.ingredientId).filter((id): id is string => !!id)),
  ));
  const ingredientNameRows = allIngredientIds.length > 0
    ? await prisma.ingredient.findMany({
        where: { id: { in: allIngredientIds } },
        select: { id: true, name: true },
      })
    : [];
  const nameById = new Map(ingredientNameRows.map(i => [i.id, i.name.toLowerCase().trim()]));

  let updated = 0;
  let skipped = 0;
  let failed = 0;
  const details: Array<{ name: string; status: string; count?: number }> = [];

  async function processRecipe(recipe: typeof recipes[number]): Promise<void> {
    if (!recipe.legacySheetId || recipe.ingredients.length === 0) {
      skipped++;
      details.push({ name: recipe.name, status: 'skipped' });
      return;
    }

    try {
      const response = await sheets!.spreadsheets.values.batchGet({
        spreadsheetId: recipe.legacySheetId,
        ranges: ['J6:N80', 'K6:K80'],
      });
      const ingRows = response.data.valueRanges?.[0]?.values || [];
      const unitRows = response.data.valueRanges?.[1]?.values || [];

      const sheetIngredients: Array<{ name: string; rawAmount: number; cookedAmount: number | null; unit: string }> = [];
      ingRows.forEach((row: (string | undefined)[], i: number) => {
        if (!row[0]) return;
        const rawStr = row[2] ? String(row[2]).replace(',', '.') : '';
        const cookedStr = row[3] ? String(row[3]).replace(',', '.') : '';
        const rawAmt = parseFloat(rawStr) || 0;
        const cookedAmt = parseFloat(cookedStr) || 0;
        if (rawAmt <= 0 && cookedAmt <= 0) return;
        const unit = (unitRows[i] && unitRows[i][0]) || 'Grams';
        sheetIngredients.push({
          name: row[0].toLowerCase().trim(),
          rawAmount: rawAmt,
          cookedAmount: cookedAmt > 0 ? cookedAmt : null,
          unit,
        });
      });

      // Match DB ingredients to sheet rows using the pre-fetched name map
      const updateOps: Array<{ id: string; cookedAmount: number }> = [];
      for (const dbIng of recipe.ingredients) {
        if (!dbIng.ingredientId) continue;
        const dbName = nameById.get(dbIng.ingredientId);
        if (!dbName) continue;

        const match = sheetIngredients.find(si =>
          si.name === dbName ||
          si.name.includes(dbName) ||
          dbName.includes(si.name)
        );

        if (match && match.cookedAmount != null && dbIng.cookedAmount == null) {
          updateOps.push({ id: dbIng.id, cookedAmount: match.cookedAmount });
        }
      }

      if (updateOps.length > 0) {
        // Apply all per-row updates in parallel
        await Promise.all(updateOps.map(op =>
          prisma.recipeIngredientRow.update({
            where: { id: op.id },
            data: { cookedAmount: op.cookedAmount },
          }),
        ));

        // Recompute volume directly from the in-memory rows (no extra query).
        // The ingredient rows we already have are stale for the just-updated
        // ones, so merge the new cooked amounts in.
        const cookedById = new Map(updateOps.map(op => [op.id, op.cookedAmount]));
        let totalML = 0;
        for (const ing of recipe.ingredients) {
          const cooked = cookedById.get(ing.id) ?? ing.cookedAmount ?? ing.rawAmount;
          if (!cooked) continue;
          switch (ing.unit) {
            case 'Kilos': case 'Liters': totalML += cooked * 1000; break;
            case 'ML': case 'Grams': default: totalML += cooked; break;
          }
        }
        const newVolume = Math.round(totalML) / 1000;
        if (newVolume > 0) {
          await prisma.recipe.update({ where: { id: recipe.id }, data: { recipeVolume: newVolume } });
        }

        updated++;
        details.push({ name: recipe.name, status: 'updated', count: updateOps.length });
      } else {
        details.push({ name: recipe.name, status: 'no-matches' });
      }
    } catch (e: unknown) {
      failed++;
      details.push({ name: recipe.name, status: `error: ${errMsg(e)}` });
    }
  }

  // Process recipes with bounded concurrency. Google Sheets API has per-minute
  // quota limits, so 5 in flight at once is a safe ceiling — enough to hide
  // network latency without triggering 429s.
  const CONCURRENCY = 5;
  for (let i = 0; i < recipes.length; i += CONCURRENCY) {
    const chunk = recipes.slice(i, i + CONCURRENCY);
    await Promise.all(chunk.map(processRecipe));
  }

  if (updated > 0) {
    broadcast(user.email, 'patch', { user: user.name, recipesReload: true });
  }
  res.json({ ok: true, updated, skipped, failed, total: recipes.length, details });
}));

// Update recipe metadata and/or ingredients
router.patch('/recipes/:id', asyncHandler(async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const body = req.body;
  const user = req.user || { email: 'anonymous', name: 'Anonymous' };
  const now = new Date().toISOString();

  const existing = await prisma.recipe.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: 'Recipe not found' });

  // Validate every provided field — including ingredients[].ingredientId
  // and the body's id (defence against the S2 stored-XSS vector). Use the
  // existing name as a stand-in when the patch doesn't touch it, so the
  // required-name check inside validateRecipe doesn't reject partial updates.
  const err = validateRecipe({ ...body, name: body.name ?? existing.name });
  if (err) return res.status(400).json({ error: err });

  const recipe = await withWriteLock(async () => {
    // Wrap ingredient replacement + recipe update in a transaction so a
    // failed createMany cannot leave the recipe with zero ingredients.
    return prisma.$transaction(async (tx) => {
      // If ingredients are provided, replace them all
      if (body.ingredients) {
        const ingredients: RecipeIngredientFull[] = body.ingredients;
        await tx.recipeIngredientRow.deleteMany({ where: { recipeId: id } });
        if (ingredients.length > 0) {
          await tx.recipeIngredientRow.createMany({
            data: ingredients.map((ing, i) => ({
              id: ing.id || crypto.randomUUID(),
              recipeId: id,
              ingredientId: ing.ingredientId || null,
              sortOrder: ing.sortOrder ?? i,
              rawAmount: ing.rawAmount,
              cookedAmount: ing.cookedAmount ?? null,
              unit: ing.unit || 'Grams',
              isFlexible: !!ing.isFlexible,
              flexCategory: ing.flexCategory || null,
              flexLabel: ing.flexLabel || null,
              suggestedNames: ing.suggestedNames || [],
            })),
          });
        }
      }

      // Recalculate auto-allergens and cost from current ingredients
      const currentIngs = await tx.recipeIngredientRow.findMany({ where: { recipeId: id } });
      const ingredientIds = currentIngs.filter(i => i.ingredientId).map(i => i.ingredientId!);
      const autoAllergens = await calcRecipeAllergens(ingredientIds);
      const servingSize = body.servingSize ?? existing.servingSize;
      const recipeVolume = body.recipeVolume !== undefined ? body.recipeVolume : existing.recipeVolume;
      const yieldType = body.yieldType ?? existing.yieldType;
      const outputCount = body.outputCount !== undefined ? body.outputCount : existing.outputCount;
      const costPerServing = await calcRecipeCost(currentIngs, servingSize, recipeVolume, yieldType, outputCount);

      // Build update data (only provided fields)
      const updateData: Record<string, unknown> = {
        autoAllergens,
        costPerServing,
        updatedAt: now,
      };
      const allowedFields = ['name', 'type', 'structure', 'seasonality', 'servingTemp', 'servingSize',
        'recipeVolume', 'yieldType', 'outputCount', 'outputUnit', 'extraAllergens', 'coolingMethod',
        'storageMethod', 'isComplete', 'legacySheetId',
        'avgSkill', 'avgSpeed', 'avgBanger', 'timesServed'] as const;
      for (const field of allowedFields) {
        if (body[field] !== undefined) updateData[field] = body[field];
      }
      if (body.prepSteps !== undefined) {
        updateData.prepSteps = body.prepSteps as Prisma.InputJsonValue;
      }

      return tx.recipe.update({
        where: { id },
        data: updateData,
        include: includeIngredients,
      });
    });
  });

  dbAppendLog(user.email, user.name, 'recipe-update', `updated "${recipe.name}"`);
  const result = toRecipeFull(recipe);
  broadcast(user.email, 'patch', { user: user.name, recipes: [result] });
  res.json(result);
}));

// Delete recipe
router.delete('/recipes/:id', asyncHandler(async (req: Request, res: Response) => {
  const id = req.params.id as string;

  // Check if batches reference this recipe
  const batchCount = await prisma.batch.count({ where: { recipeId: id } });
  if (batchCount > 0) {
    return res.status(409).json({ error: `${batchCount} batch(es) reference this recipe. Remove batch links first.` });
  }

  await withWriteLock(async () => {
    await prisma.recipePhoto.deleteMany({ where: { recipeId: id } });
    await prisma.recipe.delete({ where: { id } });
  });

  const user = req.user || { email: 'anonymous', name: 'Anonymous' };
  dbAppendLog(user.email, user.name, 'recipe-delete', `deleted recipe ${id}`);
  broadcast(user.email, 'patch', { user: user.name, deletedRecipes: [id] });
  res.json({ ok: true });
}));

// Save new version (snapshot current state).
// Read-modify-write on the JSON `versions` array — withWriteLock prevents
// two simultaneous version saves from clobbering each other (audit §3.1).
router.post('/recipes/:id/version', asyncHandler(async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const user = req.user || { email: 'anonymous', name: 'Anonymous' };
  const notes = req.body.notes || '';

  const result = await withWriteLock(async () => {
    const recipe = await prisma.recipe.findUnique({
      where: { id },
      include: includeIngredients,
    });
    if (!recipe) return { notFound: true as const };

    const currentVersions = (recipe.versions as unknown as RecipeVersionSnapshot[]) ?? [];
    const nextVersion = currentVersions.length > 0 ? currentVersions[currentVersions.length - 1].version + 1 : 1;

    const snapshot: RecipeVersionSnapshot = {
      version: nextVersion,
      date: new Date().toISOString(),
      changedBy: user.email,
      ingredients: recipe.ingredients.map(toRecipeIngredientFull),
      notes,
    };

    const updated = await prisma.recipe.update({
      where: { id },
      data: {
        versions: [...currentVersions, snapshot] as unknown as Prisma.InputJsonValue,
        updatedAt: new Date().toISOString(),
      },
      include: includeIngredients,
    });
    return { notFound: false as const, recipe, nextVersion, updated };
  });

  if (result.notFound) return res.status(404).json({ error: 'Recipe not found' });
  dbAppendLog(user.email, user.name, 'recipe-version', `saved version ${result.nextVersion} of "${result.recipe.name}"`);
  const recipeFull = toRecipeFull(result.updated);
  broadcast(user.email, 'patch', { user: user.name, recipes: [recipeFull] });
  res.json(recipeFull);
}));

// Get version history
router.get('/recipes/:id/versions', asyncHandler(async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const recipe = await prisma.recipe.findUnique({
    where: { id },
    select: { versions: true, name: true },
  });
  if (!recipe) return res.status(404).json({ error: 'Recipe not found' });
  res.json({ name: recipe.name, versions: recipe.versions as unknown as RecipeVersionSnapshot[] });
}));

// Audit S8: whitelist of safe raster image mimetypes. Multer reads the
// mimetype from the client-supplied Content-Type header — startsWith('image/')
// would let `image/svg+xml` through, and SVGs can carry inline <script>
// payloads that execute when the file is rendered as a document. Confirmed
// staging+prod have zero existing photos at the time of this change so no
// migration needed for non-conforming legacy rows.
const PHOTO_MIME_WHITELIST: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

// Upload photo
router.post('/recipes/:id/photo', upload.single('photo'), asyncHandler(async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const user = req.user || { email: 'anonymous', name: 'Anonymous' };
  const existing = await prisma.recipe.findUnique({ where: { id }, select: { id: true } });
  if (!existing) return res.status(404).json({ error: 'Recipe not found' });

  const file = (req as Request & { file?: { mimetype: string; buffer: Buffer } }).file;
  if (!file) return res.status(400).json({ error: 'No photo uploaded' });
  const normalizedMime = (file.mimetype || '').toLowerCase();
  if (!PHOTO_MIME_WHITELIST[normalizedMime]) {
    return res.status(400).json({ error: 'Photo must be jpg, png, webp, or gif' });
  }

  const photoData = new Uint8Array(file.buffer);
  const photoUrl = `/api/recipes/${id}/photo`;
  await withWriteLock(async () => {
    await prisma.recipePhoto.upsert({
      where: { recipeId: id },
      create: {
        id: `photo-${id}`,
        recipeId: id,
        mimeType: normalizedMime,
        data: photoData,
        createdAt: new Date().toISOString(),
      },
      update: {
        mimeType: normalizedMime,
        data: photoData,
      },
    });
    await prisma.recipe.update({ where: { id }, data: { photoUrl } });
  });

  // Re-fetch with ingredients so the broadcast carries the canonical RecipeFull shape
  const updated = await prisma.recipe.findUnique({ where: { id }, include: includeIngredients });
  if (updated) broadcast(user.email, 'patch', { user: user.name, recipes: [toRecipeFull(updated)] });

  res.json({ ok: true, photoUrl });
}));

// Serve photo. Defense-in-depth alongside the upload whitelist:
//   - X-Content-Type-Options: nosniff stops a browser from reinterpreting
//     the bytes as something other than the declared image/* type.
//   - Content-Disposition: inline + a controlled filename means a direct
//     navigation renders inline (still our intent) but the filename never
//     comes from user input.
// (Audit S8.)
router.get('/recipes/:id/photo', asyncHandler(async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const photo = await prisma.recipePhoto.findUnique({ where: { recipeId: id } });
  if (!photo) return res.status(404).json({ error: 'No photo' });
  const ext = PHOTO_MIME_WHITELIST[(photo.mimeType || '').toLowerCase()] || 'bin';
  res.set('Content-Type', photo.mimeType);
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Disposition', `inline; filename="recipe-${id}.${ext}"`);
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(photo.data);
}));

// Delete photo
router.delete('/recipes/:id/photo', asyncHandler(async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const user = req.user || { email: 'anonymous', name: 'Anonymous' };
  await withWriteLock(async () => {
    await prisma.recipePhoto.deleteMany({ where: { recipeId: id } });
    await prisma.recipe.update({ where: { id }, data: { photoUrl: null } });
  });

  const updated = await prisma.recipe.findUnique({ where: { id }, include: includeIngredients });
  if (updated) broadcast(user.email, 'patch', { user: user.name, recipes: [toRecipeFull(updated)] });

  res.json({ ok: true });
}));

// Suggest ingredients for a flexible slot (by category, sorted by stock at location)
router.get('/ingredients/suggest', asyncHandler(async (req: Request, res: Response) => {
  const category = req.query.category as string | undefined;
  if (!category) return res.status(400).json({ error: 'category required' });

  const ingredients = await prisma.ingredient.findMany({
    where: {
      category,
      active: true,
    },
    select: {
      id: true, name: true, category: true, unit: true,
      stock: true, pricePer100: true, allergens: true,
    },
    orderBy: { name: 'asc' },
  });

  // Sort by stock at the requested location (descending — most stock first)
  const loc = (req.query.location as string) || 'west';
  const sorted = ingredients.sort((a, b) => {
    const stockA = (a.stock as Record<string, { amount: number }> | null)?.[loc]?.amount ?? 0;
    const stockB = (b.stock as Record<string, { amount: number }> | null)?.[loc]?.amount ?? 0;
    return stockB - stockA;
  });

  res.json(sorted);
}));

// ── Printable A4 recipe page ──

const includeIngredientsForPrint = { ingredients: { include: { ingredient: true }, orderBy: { sortOrder: 'asc' as const } } };

router.get('/recipes/:id/print', asyncHandler(async (req: Request, res: Response) => {
  const recipe = await prisma.recipe.findUnique({
    where: { id: req.params.id as string },
    include: includeIngredientsForPrint,
  });
  if (!recipe) return res.status(404).send('Recipe not found');

  // Optional scaling — via batchId or direct scale/liters param
  const batchId = req.query.batchId as string | undefined;
  const scaleParam = req.query.scale ? parseFloat(req.query.scale as string) : null;
  const litersParam = req.query.liters ? parseFloat(req.query.liters as string) : null;
  let scaleFactor = 1;
  let batchLabel = '';
  if (batchId) {
    const batch = await prisma.batch.findUnique({ where: { id: batchId } });
    if (batch && recipe.recipeVolume && recipe.servingSize) {
      const recipeLiters = recipe.recipeVolume;
      // Total inventory across all entries — unified-batch model means
      // there's no scalar `stock` field; the batch holds inventory across
      // (loc, storage) pairs. For print-scaling we just want total liters
      // in the pot, so we sum across every entry regardless of location.
      const inv = Array.isArray(batch.inventory) ? (batch.inventory as Array<{ qty: number }>) : [];
      const totalStock = inv.reduce((s, e) => s + (typeof e.qty === 'number' ? e.qty : 0), 0);
      const batchLiters = totalStock > 0 ? totalStock : recipeLiters;
      if (recipeLiters > 0 && batchLiters > 0) {
        scaleFactor = batchLiters / recipeLiters;
      }
      batchLabel = batch.name || '';
    }
  } else if (litersParam && litersParam > 0 && recipe.recipeVolume && recipe.recipeVolume > 0) {
    scaleFactor = litersParam / recipe.recipeVolume;
  } else if (scaleParam && scaleParam > 0) {
    scaleFactor = scaleParam;
  }

  const ingredients = recipe.ingredients.map(ing => {
    const name = ing.isFlexible
      ? (ing.flexLabel || 'Flexible ingredient')
      : (ing.ingredient?.name || 'Unknown');
    const amountScaled = Math.round(ing.rawAmount * scaleFactor * 10) / 10;
    const allergens = ing.ingredient?.allergens || '';
    return { name, amount: amountScaled, unit: ing.unit, isFlexible: ing.isFlexible, allergens };
  });

  const prepSteps = (recipe.prepSteps as unknown as Array<{ step: number; text: string; note?: string }>) || [];
  const autoAllergens = recipe.autoAllergens as string[] || [];
  const extraAllergens = recipe.extraAllergens as string[] || [];
  const allAllergens = [...new Set([...autoAllergens, ...extraAllergens])].sort();
  const servings = recipe.recipeVolume && recipe.servingSize
    ? Math.round((recipe.recipeVolume * 1000) / recipe.servingSize * scaleFactor)
    : null;

  // Length-based density tiers so the page always fits on a single A4.
  // Drop photo first, then storage box, then shrink font / use 2-col ingredient list.
  const ingCount = ingredients.length;
  const stepCount = prepSteps.length;
  const longBody = ingCount >= 14 || stepCount >= 12;
  const veryLongBody = ingCount >= 18 || stepCount >= 16 || (ingCount + stepCount) >= 28;
  const showPhoto = !!recipe.photoUrl && !longBody;
  const showStorage = !veryLongBody;
  const compact = veryLongBody;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(recipe.name)} — De Sering Recipe</title>
<style>
  @page { size: A4; margin: ${compact ? '12mm' : '15mm'} ${compact ? '12mm' : '14mm'}; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: auto; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: ${compact ? '10.5px' : '12px'}; line-height: ${compact ? '1.35' : '1.45'}; color: #000; }
  h1 { font-size: ${compact ? '18px' : '22px'}; margin-bottom: 2px; color: #000; }
  h2 { font-size: ${compact ? '12px' : '13px'}; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #000; margin: ${compact ? '8px 0 4px' : '10px 0 6px'}; border-bottom: 1px solid #000; padding-bottom: 3px; page-break-after: avoid; }
  .header { display: flex; gap: 14px; align-items: flex-start; margin-bottom: ${compact ? '6px' : '10px'}; }
  .header-photo { width: ${compact ? '78px' : '90px'}; height: ${compact ? '78px' : '90px'}; object-fit: cover; border-radius: 6px; flex-shrink: 0; }
  .meta { display: flex; gap: 8px; flex-wrap: wrap; font-size: 10px; color: #000; margin-bottom: 6px; }
  .meta span { border: 1px solid #000; padding: 1px 7px; border-radius: 10px; }
  .allergens { display: flex; gap: 3px; flex-wrap: wrap; margin-bottom: 0; }
  .allergen { border: 1px solid #000; color: #000; font-size: 9.5px; padding: 1px 7px; border-radius: 10px; font-weight: 700; }
  table { width: 100%; border-collapse: collapse; font-size: ${compact ? '10.5px' : '12px'}; margin-bottom: ${compact ? '6px' : '10px'}; }
  th { text-align: left; font-size: 10px; font-weight: 700; text-transform: uppercase; color: #000; padding: ${compact ? '2px 4px' : '3px 5px'}; border-bottom: 2px solid #000; }
  td { padding: ${compact ? '2px 4px' : '3px 5px'}; border-bottom: 1px solid #000; vertical-align: top; color: #000; }
  tr.flexible td { font-style: italic; color: #000; font-weight: 600; }
  td.amt { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; width: 60px; }
  td.unit { white-space: nowrap; width: 60px; color: #000; font-size: 10.5px; }
  .steps { counter-reset: step; padding: 0; list-style: none; }
  .steps li { counter-increment: step; padding: ${compact ? '3px 0 3px 22px' : '5px 0 5px 26px'}; position: relative; border-bottom: 1px solid #000; break-inside: avoid; color: #000; }
  .steps li::before { content: counter(step); position: absolute; left: 0; width: ${compact ? '17px' : '19px'}; height: ${compact ? '17px' : '19px'}; background: #000; color: #fff; border-radius: 50%; font-size: ${compact ? '9px' : '10px'}; font-weight: 700; display: flex; align-items: center; justify-content: center; top: ${compact ? '4px' : '5px'}; }
  .step-note { font-size: ${compact ? '10px' : '11px'}; color: #000; font-style: italic; font-weight: 600; margin-top: 1px; }
  .storage-box { border: 1px solid #000; border-radius: 6px; padding: 6px 10px; margin-bottom: 6px; font-size: 11px; color: #000; }
  .storage-box strong { display: block; font-size: 10px; text-transform: uppercase; color: #000; margin-bottom: 2px; }
  .footer { margin-top: 10px; padding-top: 6px; border-top: 1px solid #000; font-size: 9px; color: #000; display: flex; justify-content: space-between; }
  ${scaleFactor !== 1 ? '.scale-note { border: 1px solid #000; color: #000; padding: 4px 8px; border-radius: 5px; font-size: 10.5px; margin-bottom: 8px; font-weight: 700; }' : ''}
  @media print {
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .no-print { display: none; }
  }
  @media screen {
    body { max-width: 700px; margin: 20px auto; padding: 20px; }
    .print-btn { position: fixed; top: 12px; right: 12px; padding: 8px 16px; background: #1a1a18; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-size: 13px; }
    .print-btn:hover { opacity: 0.85; }
  }
</style>
</head>
<body>
<button class="print-btn no-print" onclick="window.print()">Print (Ctrl+P)</button>

<div class="header">
  ${showPhoto ? `<img src="/api/recipes/${recipe.id}/photo" class="header-photo" />` : ''}
  <div style="flex:1;min-width:0;">
    <h1>${esc(recipe.name)}</h1>
    <div class="meta">
      <span>${esc(recipe.type)}</span>
      ${recipe.structure ? `<span>${esc(recipe.structure)}</span>` : ''}
      ${recipe.seasonality ? `<span>${esc(recipe.seasonality)}</span>` : ''}
      ${recipe.servingTemp ? `<span>${esc(recipe.servingTemp)}</span>` : ''}
      ${servings ? `<span>${servings} servings</span>` : ''}
      ${recipe.servingSize ? `<span>${recipe.servingSize} ml/serving</span>` : ''}
      ${recipe.costPerServing != null ? `<span>&euro;${recipe.costPerServing.toFixed(2)}/serving</span>` : ''}
    </div>
    ${allAllergens.length > 0 ? `<div class="allergens">${allAllergens.map(a => `<span class="allergen">${esc(a)}</span>`).join('')}</div>` : ''}
  </div>
</div>

${scaleFactor !== 1 ? `<div class="scale-note">Scaled ${scaleFactor > 1 ? 'up' : 'down'} &times;${scaleFactor.toFixed(2)}${batchLabel ? ` for batch: ${esc(batchLabel)}` : ''}</div>` : ''}

${ingredients.length > 0 ? `
<h2>Ingredients</h2>
<table>
  <thead><tr><th>Ingredient</th><th class="amt">Amounts</th><th class="unit">Unit</th></tr></thead>
  <tbody>
    ${ingredients.map(i => `<tr${i.isFlexible ? ' class="flexible"' : ''}>
      <td>${esc(i.name)}${i.allergens ? ` <span style="font-size:9px;color:#000;font-weight:600;">(${esc(i.allergens)})</span>` : ''}</td>
      <td class="amt">${i.amount}</td>
      <td class="unit">${esc(i.unit)}</td>
    </tr>`).join('')}
  </tbody>
</table>` : ''}

${prepSteps.length > 0 ? `
<h2>Prep Steps</h2>
<ol class="steps">
  ${prepSteps.map(ps => `<li>${esc(ps.text)}${ps.note ? `<div class="step-note">${esc(ps.note)}</div>` : ''}</li>`).join('')}
</ol>` : ''}

${showStorage && (recipe.coolingMethod || recipe.storageMethod) ? `
<h2>Storage</h2>
<div style="display:flex;gap:8px;flex-wrap:wrap;">
  ${recipe.coolingMethod ? `<div class="storage-box" style="flex:1;min-width:200px;"><strong>Cooling</strong>${esc(recipe.coolingMethod)}</div>` : ''}
  ${recipe.storageMethod ? `<div class="storage-box" style="flex:1;min-width:200px;"><strong>Storage</strong>${esc(recipe.storageMethod)}</div>` : ''}
</div>` : ''}

<div class="footer">
  <span>De Sering — ${esc(recipe.name)}</span>
  <span>Printed ${new Date().toLocaleDateString('en-GB')}</span>
</div>
</body>
</html>`;

  res.type('html').send(html);
}));

// HTML-escape helper for print view
function esc(str: unknown): string {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export default router;
