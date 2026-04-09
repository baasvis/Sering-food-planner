// ─────────────────────────────────────────────────────────────────────────────
// POSTGRESQL DATA LAYER (PRISMA)
// ─────────────────────────────────────────────────────────────────────────────

import { PrismaClient, Prisma } from '@prisma/client';
import type { Batch, GuestsData, Catering, TransportItem, DataResponse, Service, RecipeEntry, RecipeFull, RecipeIngredientFull, PrepStep, RecipeVersionSnapshot, NutritionInfo, ActualIngredient } from '../shared/types';

export const prisma = new PrismaClient();

// Prisma interactive transaction client type
type TxClient = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

// ── Validation ──

const VALID_TYPES = ['Soup', 'Main course', 'Dessert'];
const VALID_STORAGE = ['Gastro', 'Frozen', 'Vac-packed'];
const VALID_LOCATIONS = ['west', 'centraal'];
const VALID_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const VALID_MEALS = ['lunch', 'dinner'];

export function validateBatch(b: Batch, prefix = ''): string | null {
  const p = prefix ? `${prefix}: ` : '';
  if (!b.id || typeof b.id !== 'string') return `${p}missing or invalid id`;
  if (!b.name || typeof b.name !== 'string' || b.name.length > 200) return `${p}invalid name`;
  if (!VALID_TYPES.includes(b.type)) return `${p}invalid type "${b.type}"`;
  if (typeof b.stock !== 'number' || b.stock < 0 || b.stock > 99999) return `${p}invalid stock`;
  if (typeof b.serving !== 'number' || b.serving < 1 || b.serving > 9999) return `${p}invalid serving`;
  if (!VALID_STORAGE.includes(b.storage)) return `${p}invalid storage`;
  if (!VALID_LOCATIONS.includes(b.location)) return `${p}invalid location "${b.location}"`;
  if (typeof b.inTransit !== 'undefined' && typeof b.inTransit !== 'boolean') return `${p}inTransit must be boolean`;
  if (typeof b.note !== 'undefined' && (typeof b.note !== 'string' || b.note.length > 1000)) return `${p}invalid note`;
  if (!Array.isArray(b.services)) return `${p}services must be an array`;
  for (const svc of b.services) {
    if (!VALID_LOCATIONS.includes(svc.loc)) return `${p}invalid service location`;
    if (!svc.date || typeof svc.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(svc.date)) return `${p}invalid service date (expected YYYY-MM-DD)`;
    if (!VALID_MEALS.includes(svc.meal)) return `${p}invalid service meal`;
  }
  return null;
}

export function validateBatches(batches: Batch[]): string | null {
  if (!Array.isArray(batches)) return 'batches must be an array';
  if (batches.length > 500) return 'Too many batches (max 500)';
  const ids = new Set<string>();
  for (let i = 0; i < batches.length; i++) {
    const b = batches[i];
    if (ids.has(b.id)) return `Batch ${i}: duplicate id "${b.id}"`;
    ids.add(b.id);
    const err = validateBatch(b, `Batch ${i}`);
    if (err) return err;
  }
  return null;
}

export function validateGuests(guests: GuestsData): string | null {
  if (!guests || typeof guests !== 'object') return 'guests must be an object';
  for (const loc of VALID_LOCATIONS) {
    if (!guests[loc]) return `guests.${loc} missing`;
    for (const day of VALID_DAYS) {
      if (!guests[loc][day]) return `guests.${loc}.${day} missing`;
      const g = guests[loc][day];
      if (typeof g.lunch !== 'number' || g.lunch < 0 || g.lunch > 9999) return `Invalid guest count`;
      if (typeof g.dinner !== 'number' || g.dinner < 0 || g.dinner > 9999) return `Invalid guest count`;
    }
  }
  return null;
}

// ── Default data ──

export function getDefaultGuests(): GuestsData {
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const west: Record<string, { lunch: number; dinner: number }> = {};
  const centraal: Record<string, { lunch: number; dinner: number }> = {};
  days.forEach(d => {
    west[d]     = { lunch: d === 'Sat' || d === 'Sun' ? 0 : 100, dinner: d === 'Sat' || d === 'Sun' ? 0 : 110 };
    centraal[d] = { lunch: d === 'Sat' || d === 'Sun' ? 0 : 80,  dinner: d === 'Sat' || d === 'Sun' ? 0 : 85  };
  });
  return { west, centraal };
}

// ── Row transformers (frontend shape ↔ Prisma shape) ──

export function toBatchRow(b: Batch) {
  return {
    id: b.id,
    name: b.name,
    type: b.type,
    stock: b.stock,
    serving: b.serving || 280,
    storage: b.storage || 'Gastro',
    location: b.location || 'west',
    inTransit: !!b.inTransit,
    allergens: b.allergens || [],
    extraAllergens: b.extraAllergens || [],
    orderFor: !!b.orderFor,
    cookDate: b.cookDate || null,
    recipeSheetId: b.recipeSheetId || null,
    recipeVolume: b.recipeVolume || null,
    // Prisma Json fields need cast: our typed arrays lack the index signature Prisma expects
    recipeIngredients: (b.recipeIngredients || undefined) as Prisma.InputJsonValue | undefined,
    parentId: b.parentId || null,
    note: b.note || '',
    services: (b.services || []) as unknown as Prisma.InputJsonValue,
    createdAt: b.createdAt || new Date().toISOString(),
    recipeId: b.recipeId || null,
    actualIngredients: (b.actualIngredients || undefined) as Prisma.InputJsonValue | undefined,
    cookNotes: b.cookNotes || '',
    stockDeducted: !!b.stockDeducted,
  };
}

function toGuestRows(guests: GuestsData): Array<{ location: string; day: string; lunch: number; dinner: number }> {
  const rows: Array<{ location: string; day: string; lunch: number; dinner: number }> = [];
  for (const [loc, days] of Object.entries(guests)) {
    for (const [day, meals] of Object.entries(days)) {
      rows.push({ location: loc, day, lunch: meals.lunch || 0, dinner: meals.dinner || 0 });
    }
  }
  return rows;
}

function toCateringRow(c: Catering) {
  return {
    id: c.id,
    name: c.name || '',
    date: c.date || null,
    guestCount: c.guestCount || 0,
    deliveryMode: c.deliveryMode || 'pickup',
    dishes: (c.dishes || []) as unknown as Prisma.InputJsonValue,
    logisticsNotes: c.logisticsNotes || '',
    createdAt: c.createdAt || new Date().toISOString(),
  };
}

function toTransportRow(t: TransportItem) {
  return { id: t.id, text: t.text };
}

// ── Shared write logic ──

async function writeBatches(tx: TxClient, batches: Batch[]): Promise<void> {
  await tx.batch.deleteMany();
  if (batches.length > 0) {
    await tx.batch.createMany({ data: batches.map(toBatchRow) });
  }
}

async function writeGuests(tx: TxClient, guests: GuestsData): Promise<void> {
  await tx.guest.deleteMany();
  const guestData = toGuestRows(guests);
  if (guestData.length > 0) {
    await tx.guest.createMany({ data: guestData });
  }
}

async function writeCaterings(tx: TxClient, caterings: Catering[]): Promise<void> {
  await tx.catering.deleteMany();
  if (caterings && caterings.length > 0) {
    await tx.catering.createMany({ data: caterings.map(toCateringRow) });
  }
}

async function writeTransport(tx: TxClient, items: TransportItem[]): Promise<void> {
  await tx.transportItem.deleteMany();
  if (items && items.length > 0) {
    await tx.transportItem.createMany({ data: items.map(toTransportRow) });
  }
}

// ── High-level database operations ──

export async function dbReadAll(): Promise<DataResponse> {
  try {
    const [batchRows, guestRows, recipeRows, cateringRows, transportRows, recipeV2Rows] = await Promise.all([
      prisma.batch.findMany(),
      prisma.guest.findMany(),
      prisma.recipeIndex.findMany(),
      prisma.catering.findMany(),
      prisma.transportItem.findMany(),
      prisma.recipe.findMany({ include: { ingredients: { orderBy: { sortOrder: 'asc' } } } }),
    ]);

    const batches: Batch[] = batchRows.map(b => ({
      id: b.id,
      name: b.name,
      type: b.type as Batch['type'],
      stock: b.stock,
      serving: b.serving,
      storage: b.storage as Batch['storage'],
      location: b.location as Batch['location'],
      inTransit: b.inTransit,
      allergens: b.allergens,
      extraAllergens: b.extraAllergens,
      orderFor: b.orderFor,
      cookDate: b.cookDate,
      recipeSheetId: b.recipeSheetId,
      recipeVolume: b.recipeVolume,
      recipeIngredients: (b.recipeIngredients ?? null) as Batch['recipeIngredients'],
      parentId: b.parentId,
      note: b.note,
      services: Array.isArray(b.services) ? (b.services as unknown as Service[]) : [],
      createdAt: b.createdAt,
      recipeId: b.recipeId,
      actualIngredients: (b.actualIngredients ?? null) as ActualIngredient[] | null,
      cookNotes: b.cookNotes,
      stockDeducted: b.stockDeducted,
    }));

    const guests = getDefaultGuests();
    for (const row of guestRows) {
      if (guests[row.location] && guests[row.location][row.day]) {
        guests[row.location][row.day].lunch = row.lunch;
        guests[row.location][row.day].dinner = row.dinner;
      }
    }

    const recipeIndex: RecipeEntry[] = recipeRows.map(r => ({
      id: r.id,
      name: r.name,
      type: r.type,
      recipeSheetId: r.recipeSheetId,
      allergens: r.allergens,
      costPerServing: r.costPerServing,
      structure: r.structure,
      seasonality: r.seasonality,
      servingTemp: r.servingTemp,
      servingSize: r.servingSize,
      recipeVolume: r.recipeVolume,
      recipeIngredients: r.recipeIngredients as RecipeEntry['recipeIngredients'],
      createdAt: r.createdAt,
      avgSkill: r.avgSkill,
      avgSpeed: r.avgSpeed,
      avgBanger: r.avgBanger,
      timesServed: r.timesServed,
    }));

    const caterings: Catering[] = cateringRows.map(c => ({
      id: c.id,
      name: c.name,
      date: c.date,
      guestCount: c.guestCount,
      deliveryMode: c.deliveryMode,
      dishes: (c.dishes ?? []) as unknown as Catering['dishes'],
      logisticsNotes: c.logisticsNotes,
    }));

    const transportItems: TransportItem[] = transportRows.map(t => ({ id: t.id, text: t.text }));

    const recipes: RecipeFull[] = recipeV2Rows.map(toRecipeFull);

    return { batches, guests, recipeIndex, recipes, caterings, transportItems };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    console.error('dbReadAll error:', message);
    return { batches: [], guests: getDefaultGuests(), recipeIndex: [], recipes: [], caterings: [], transportItems: [] };
  }
}

export async function dbWriteAll(batches: Batch[], guests: GuestsData, caterings: Catering[], transportItems: TransportItem[]): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await writeBatches(tx, batches);
    await writeGuests(tx, guests);
    await writeCaterings(tx, caterings);
    await writeTransport(tx, transportItems);
  });
}

// ── Write lock — serialise writes to prevent data corruption ──

let writeLock: Promise<void> | null = null;
export async function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  while (writeLock) await writeLock;
  let resolve: () => void;
  writeLock = new Promise<void>(r => { resolve = r; });
  try { return await fn(); }
  finally { writeLock = null; resolve!(); }
}

// ── Per-entity write helpers (for patch saves) ──

export async function dbWriteBatches(batches: Batch[]): Promise<void> {
  await prisma.$transaction(async (tx) => writeBatches(tx, batches));
}

export async function dbWriteGuests(guests: GuestsData): Promise<void> {
  await prisma.$transaction(async (tx) => writeGuests(tx, guests));
}

export async function dbWriteCaterings(caterings: Catering[]): Promise<void> {
  await prisma.$transaction(async (tx) => writeCaterings(tx, caterings));
}

export async function dbWriteTransportItems(items: TransportItem[]): Promise<void> {
  await prisma.$transaction(async (tx) => writeTransport(tx, items));
}

export async function dbAppendLog(userEmail: string, userName: string, action: string, details: string): Promise<void> {
  try {
    await prisma.log.create({
      data: {
        timestamp: new Date().toISOString(),
        email: userEmail,
        name: userName,
        action,
        details,
      },
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    console.error('Log append error:', message);
  }
}

// ── Recipe v2 helpers ──

// Type for Recipe row with included ingredients from Prisma
type RecipeWithIngredients = Awaited<ReturnType<typeof prisma.recipe.findFirst<{ include: { ingredients: true } }>>>;

export function toRecipeIngredientFull(row: { id: string; ingredientId: string | null; sortOrder: number; rawAmount: number; cookedAmount: number | null; unit: string; isFlexible: boolean; flexCategory: string | null; flexLabel: string | null; suggestedNames: string[] }): RecipeIngredientFull {
  return {
    id: row.id,
    ingredientId: row.ingredientId,
    sortOrder: row.sortOrder,
    rawAmount: row.rawAmount,
    cookedAmount: row.cookedAmount,
    unit: row.unit,
    isFlexible: row.isFlexible,
    flexCategory: row.flexCategory,
    flexLabel: row.flexLabel,
    suggestedNames: row.suggestedNames,
  };
}

export function toRecipeFull(r: NonNullable<RecipeWithIngredients>): RecipeFull {
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    structure: r.structure,
    seasonality: r.seasonality,
    servingTemp: r.servingTemp,
    servingSize: r.servingSize,
    recipeVolume: r.recipeVolume,
    autoAllergens: r.autoAllergens,
    extraAllergens: r.extraAllergens,
    costPerServing: r.costPerServing,
    avgSkill: r.avgSkill,
    avgSpeed: r.avgSpeed,
    avgBanger: r.avgBanger,
    timesServed: r.timesServed,
    prepSteps: (r.prepSteps ?? []) as unknown as PrepStep[],
    coolingMethod: r.coolingMethod,
    storageMethod: r.storageMethod,
    photoUrl: r.photoUrl,
    isComplete: r.isComplete,
    versions: (r.versions ?? []) as unknown as RecipeVersionSnapshot[],
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    legacySheetId: r.legacySheetId,
    ingredients: (r.ingredients || []).map(toRecipeIngredientFull),
  };
}

/** Compute auto-allergens by looking up each linked ingredient's allergens */
export async function calcRecipeAllergens(ingredientIds: string[]): Promise<string[]> {
  if (ingredientIds.length === 0) return [];
  const ingredients = await prisma.ingredient.findMany({
    where: { id: { in: ingredientIds } },
    select: { allergens: true },
  });
  const allergenSet = new Set<string>();
  for (const ing of ingredients) {
    if (ing.allergens) {
      // allergens field is a comma-separated string on Ingredient
      for (const a of ing.allergens.split(',')) {
        const trimmed = a.trim();
        if (trimmed) allergenSet.add(trimmed);
      }
    }
  }
  return [...allergenSet].sort();
}

/** Compute cost per serving from ingredient prices and amounts */
export async function calcRecipeCost(
  ingredients: Array<{ ingredientId: string | null; rawAmount: number; unit: string; isFlexible: boolean }>,
  servingSize: number,
  recipeVolume: number | null,
): Promise<number | null> {
  const linkedIds = ingredients.filter(i => i.ingredientId && !i.isFlexible).map(i => i.ingredientId!);
  if (linkedIds.length === 0 || !recipeVolume) return null;

  const dbIngredients = await prisma.ingredient.findMany({
    where: { id: { in: linkedIds } },
    select: { id: true, pricePer100g: true, pricePer100: true },
  });
  const priceMap = new Map(dbIngredients.map(i => [i.id, i.pricePer100g || i.pricePer100 || 0]));

  const baseServings = (recipeVolume * 1000) / servingSize;
  if (baseServings <= 0) return null;

  let totalCost = 0;
  for (const ing of ingredients) {
    if (!ing.ingredientId || ing.isFlexible) continue;
    const pricePer100 = priceMap.get(ing.ingredientId) || 0;
    // Convert rawAmount to grams for cost calc (amounts stored in recipe unit)
    const amountGrams = toGrams(ing.rawAmount, ing.unit);
    totalCost += (amountGrams / 100) * pricePer100;
  }

  return Math.round((totalCost / baseServings) * 100) / 100;
}

/** Compute nutrition per serving from ingredient nutrition data */
export async function calcRecipeNutrition(
  ingredients: Array<{ ingredientId: string | null; rawAmount: number; unit: string; isFlexible: boolean }>,
  servingSize: number,
  recipeVolume: number | null,
): Promise<NutritionInfo | null> {
  const linkedIds = ingredients.filter(i => i.ingredientId && !i.isFlexible).map(i => i.ingredientId!);
  if (linkedIds.length === 0 || !recipeVolume) return null;

  const dbIngredients = await prisma.ingredient.findMany({
    where: { id: { in: linkedIds } },
    select: { id: true, nutrition: true },
  });
  const nutritionMap = new Map(dbIngredients.map(i => [i.id, i.nutrition as Record<string, number> | null]));

  const baseServings = (recipeVolume * 1000) / servingSize;
  if (baseServings <= 0) return null;

  const totals = { energyKcal: 0, energyKj: 0, fat: 0, saturatedFat: 0, carbs: 0, sugar: 0, fiber: 0, protein: 0, salt: 0 };
  let withData = 0;
  let total = 0;

  for (const ing of ingredients) {
    if (!ing.ingredientId || ing.isFlexible) continue;
    total++;
    const nutr = nutritionMap.get(ing.ingredientId);
    if (!nutr || Object.keys(nutr).length === 0) continue;
    withData++;
    const amountGrams = toGrams(ing.rawAmount, ing.unit);
    const factor = amountGrams / 100; // nutrition is per 100g
    totals.energyKcal += (nutr.energyKcal || 0) * factor;
    totals.energyKj += (nutr.energyKj || 0) * factor;
    totals.fat += (nutr.fat || 0) * factor;
    totals.saturatedFat += (nutr.saturatedFat || 0) * factor;
    totals.carbs += (nutr.carbs || 0) * factor;
    totals.sugar += (nutr.sugar || 0) * factor;
    totals.fiber += (nutr.fiber || 0) * factor;
    totals.protein += (nutr.protein || 0) * factor;
    totals.salt += (nutr.salt || 0) * factor;
  }

  // Divide by servings to get per-serving values
  const result: NutritionInfo = {
    energyKcal: Math.round(totals.energyKcal / baseServings),
    energyKj: Math.round(totals.energyKj / baseServings),
    fat: Math.round(totals.fat / baseServings * 10) / 10,
    saturatedFat: Math.round(totals.saturatedFat / baseServings * 10) / 10,
    carbs: Math.round(totals.carbs / baseServings * 10) / 10,
    sugar: Math.round(totals.sugar / baseServings * 10) / 10,
    fiber: Math.round(totals.fiber / baseServings * 10) / 10,
    protein: Math.round(totals.protein / baseServings * 10) / 10,
    salt: Math.round(totals.salt / baseServings * 100) / 100,
    completeness: total > 0 ? withData / total : 0,
  };
  return result;
}

/** Convert amount in recipe unit to grams */
function toGrams(amount: number, unit: string): number {
  switch (unit.toLowerCase()) {
    case 'kilos': case "kilo's": case 'kg': return amount * 1000;
    case 'liters': case 'l': return amount * 1000; // 1L ≈ 1000g for liquids
    case 'ml': return amount;
    case 'grams': case 'g': default: return amount;
  }
}

/** Validate a recipe for required fields */
export function validateRecipe(r: { name?: string; type?: string; servingSize?: number }): string | null {
  if (!r.name || typeof r.name !== 'string' || r.name.length > 200) return 'invalid name';
  if (r.type && !VALID_TYPES.includes(r.type)) return `invalid type "${r.type}"`;
  if (r.servingSize !== undefined && (typeof r.servingSize !== 'number' || r.servingSize < 1 || r.servingSize > 9999)) return 'invalid servingSize';
  return null;
}

/** Recalculate cost for all recipes that use a specific ingredient */
export async function recalcRecipeCostsForIngredient(ingredientId: string): Promise<number> {
  const rows = await prisma.recipeIngredientRow.findMany({
    where: { ingredientId },
    select: { recipeId: true },
  });
  const recipeIds = [...new Set(rows.map(r => r.recipeId))];
  if (recipeIds.length === 0) return 0;

  const recipes = await prisma.recipe.findMany({
    where: { id: { in: recipeIds } },
    include: { ingredients: true },
  });

  let updated = 0;
  for (const r of recipes) {
    const cost = await calcRecipeCost(r.ingredients, r.servingSize, r.recipeVolume);
    if (cost !== r.costPerServing) {
      await prisma.recipe.update({ where: { id: r.id }, data: { costPerServing: cost } });
      updated++;
    }
  }
  return updated;
}
