// ─────────────────────────────────────────────────────────────────────────────
// POSTGRESQL DATA LAYER (PRISMA)
// ─────────────────────────────────────────────────────────────────────────────

import { PrismaClient, Prisma } from '@prisma/client';
import type { Batch, GuestsData, Catering, TransportItem, DataResponse, Service, RecipeFull, RecipeIngredientFull, PrepStep, RecipeVersionSnapshot, NutritionInfo, ActualIngredient, Ingredient } from '../shared/types';
import { toGrams } from '../shared/units';

export const prisma = new PrismaClient();

// Prisma interactive transaction client type
type TxClient = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

// ── Validation ──

const VALID_TYPES = ['Soup', 'Main course', 'Dessert'];
const VALID_STORAGE = ['Gastro', 'Frozen', 'Vac-packed'];
const VALID_LOCATIONS = ['west', 'centraal'];
const VALID_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const VALID_MEALS = ['lunch', 'dinner'];

// Audit S2: ids flow into onclick="" attributes via raw template-literal
// interpolation in the frontend. Constrain to UUID-shaped (alphanumerics,
// hyphen, underscore) so a write-side payload like `'); alert(1); //` is
// rejected at the API boundary instead of stored and reflected at render.
// Existing prod + staging IDs (1256 + 1251 rows checked 2026-05-03) all match.
const VALID_ID_PATTERN = /^[a-zA-Z0-9_-]{1,200}$/;

/** Validate an id-shaped string field. Pass `field` for a useful error. */
export function checkId(value: unknown, field: string): string | null {
  if (typeof value !== 'string' || !VALID_ID_PATTERN.test(value)) {
    return `invalid ${field}`;
  }
  return null;
}

export function validateBatch(b: Batch, prefix = ''): string | null {
  const p = prefix ? `${prefix}: ` : '';
  if (!b.id || typeof b.id !== 'string') return `${p}missing or invalid id`;
  if (!VALID_ID_PATTERN.test(b.id)) return `${p}invalid id charset`;
  if (b.parentId !== null && b.parentId !== undefined && !VALID_ID_PATTERN.test(b.parentId)) return `${p}invalid parentId charset`;
  if (b.recipeId !== null && b.recipeId !== undefined && !VALID_ID_PATTERN.test(b.recipeId)) return `${p}invalid recipeId charset`;
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

export function validateCatering(c: Catering, prefix = ''): string | null {
  const p = prefix ? `${prefix}: ` : '';
  if (!c.id || typeof c.id !== 'string') return `${p}missing or invalid id`;
  if (!VALID_ID_PATTERN.test(c.id)) return `${p}invalid id charset`;
  if (typeof c.name !== 'string' || c.name.length > 200) return `${p}invalid name`;
  if (c.date !== null && c.date !== undefined && (typeof c.date !== 'string' || (c.date !== '' && !/^\d{2}\/\d{2}\/\d{4}$/.test(c.date)))) {
    return `${p}invalid date (expected DD/MM/YYYY)`;
  }
  if (typeof c.guestCount !== 'number' || c.guestCount < 0 || c.guestCount > 9999) return `${p}invalid guestCount`;
  if (typeof c.deliveryMode !== 'string' || c.deliveryMode.length > 50) return `${p}invalid deliveryMode`;
  if (!Array.isArray(c.dishes)) return `${p}dishes must be an array`;
  for (const d of c.dishes) {
    if (!d.dishId || typeof d.dishId !== 'string') return `${p}dish missing dishId`;
    if (!VALID_ID_PATTERN.test(d.dishId)) return `${p}dish has invalid dishId charset`;
    if (typeof d.name !== 'string' || d.name.length > 200) return `${p}dish has invalid name`;
    if (typeof d.type !== 'string') return `${p}dish has invalid type`;
  }
  if (typeof c.logisticsNotes !== 'string' || c.logisticsNotes.length > 5000) return `${p}invalid logisticsNotes`;
  return null;
}

export function validateCaterings(caterings: Catering[]): string | null {
  if (!Array.isArray(caterings)) return 'caterings must be an array';
  if (caterings.length > 500) return 'Too many caterings (max 500)';
  const ids = new Set<string>();
  for (let i = 0; i < caterings.length; i++) {
    const c = caterings[i];
    if (ids.has(c.id)) return `Catering ${i}: duplicate id "${c.id}"`;
    ids.add(c.id);
    const err = validateCatering(c, `Catering ${i}`);
    if (err) return err;
  }
  return null;
}

export function validateTransportItem(t: TransportItem, prefix = ''): string | null {
  const p = prefix ? `${prefix}: ` : '';
  if (!t.id || typeof t.id !== 'string') return `${p}missing or invalid id`;
  if (!VALID_ID_PATTERN.test(t.id)) return `${p}invalid id charset`;
  if (typeof t.text !== 'string' || t.text.length > 500) return `${p}invalid text`;
  return null;
}

export function validateTransportItems(items: TransportItem[]): string | null {
  if (!Array.isArray(items)) return 'transportItems must be an array';
  if (items.length > 200) return 'Too many transport items (max 200)';
  const ids = new Set<string>();
  for (let i = 0; i < items.length; i++) {
    const t = items[i];
    if (ids.has(t.id)) return `TransportItem ${i}: duplicate id "${t.id}"`;
    ids.add(t.id);
    const err = validateTransportItem(t, `TransportItem ${i}`);
    if (err) return err;
  }
  return null;
}

// Audit T20: bulk POST /api/ingredients used to validate only that the
// payload was an array (no per-row checks). A subverted supplier file or
// hand-crafted POST could plant XSS-shaped ids (S2) or oversized
// strings at scale. validateIngredient mirrors validateBatch's shape:
// per-field type/length/range checks. PRICE_LEVELS is the domain set the
// frontend sends; '' is also accepted because it's the default for
// hand-entered ingredients with no level set.
const VALID_PRICE_LEVELS = ['', 'cheap', 'medium', 'expensive'];
const VALID_MEASURE_MODES = ['weight', 'volume', 'amount'];

export function validateIngredient(ing: Ingredient, prefix = ''): string | null {
  const p = prefix ? `${prefix}: ` : '';
  if (!ing.id || typeof ing.id !== 'string') return `${p}missing or invalid id`;
  if (!VALID_ID_PATTERN.test(ing.id)) return `${p}invalid id charset`;
  if (typeof ing.name !== 'string' || ing.name.length === 0 || ing.name.length > 200) return `${p}invalid name`;
  if (typeof ing.supplierName !== 'string' || ing.supplierName.length > 500) return `${p}invalid supplierName`;
  if (!Array.isArray(ing.types)) return `${p}types must be an array`;
  if (ing.types.length > 20) return `${p}too many types (max 20)`;
  for (const t of ing.types) {
    if (typeof t !== 'string' || t.length > 50) return `${p}invalid types entry`;
  }
  if (typeof ing.category !== 'string' || ing.category.length > 100) return `${p}invalid category`;
  if (ing.measureMode !== undefined && (typeof ing.measureMode !== 'string' || (ing.measureMode !== '' && !VALID_MEASURE_MODES.includes(ing.measureMode)))) return `${p}invalid measureMode`;
  if (typeof ing.unit !== 'string' || ing.unit.length > 50) return `${p}invalid unit`;
  if (typeof ing.supplier !== 'string' || ing.supplier.length > 100) return `${p}invalid supplier`;
  if (typeof ing.orderCode !== 'string' || ing.orderCode.length > 100) return `${p}invalid orderCode`;
  if (typeof ing.orderUnit !== 'string' || ing.orderUnit.length > 100) return `${p}invalid orderUnit`;
  if (ing.orderPrice !== null && ing.orderPrice !== undefined) {
    const n = typeof ing.orderPrice === 'number' ? ing.orderPrice : parseFloat(String(ing.orderPrice));
    if (!Number.isFinite(n) || n < 0 || n > 1_000_000) return `${p}invalid orderPrice`;
  }
  if (ing.orderUnitSize !== undefined) {
    const n = typeof ing.orderUnitSize === 'number' ? ing.orderUnitSize : parseFloat(String(ing.orderUnitSize));
    if (!Number.isFinite(n) || n < 0 || n > 10_000_000) return `${p}invalid orderUnitSize`;
  }
  if (ing.priceLevel !== undefined && !VALID_PRICE_LEVELS.includes(ing.priceLevel)) return `${p}invalid priceLevel`;
  if (ing.pricePer100 !== undefined) {
    const n = typeof ing.pricePer100 === 'number' ? ing.pricePer100 : parseFloat(String(ing.pricePer100));
    if (!Number.isFinite(n) || n < 0 || n > 1_000_000) return `${p}invalid pricePer100`;
  }
  if (ing.priceAlert !== undefined && typeof ing.priceAlert !== 'boolean') return `${p}invalid priceAlert`;
  if (typeof ing.allergens !== 'string' || ing.allergens.length > 500) return `${p}invalid allergens`;
  if (typeof ing.notes !== 'string' || ing.notes.length > 5000) return `${p}invalid notes`;
  if (ing.active !== undefined && typeof ing.active !== 'boolean') return `${p}invalid active`;
  // Loose JSON shape checks: must be an object, not an array (Prisma JSON
  // would accept either but the runtime code expects the documented shapes).
  if (ing.storageLocations !== undefined && (typeof ing.storageLocations !== 'object' || ing.storageLocations === null || Array.isArray(ing.storageLocations))) return `${p}invalid storageLocations`;
  if (ing.stock !== undefined && (typeof ing.stock !== 'object' || ing.stock === null || Array.isArray(ing.stock))) return `${p}invalid stock`;
  if (ing.targetStock !== undefined && (typeof ing.targetStock !== 'object' || ing.targetStock === null || Array.isArray(ing.targetStock))) return `${p}invalid targetStock`;
  if (ing.nutrition !== undefined && ing.nutrition !== null && (typeof ing.nutrition !== 'object' || Array.isArray(ing.nutrition))) return `${p}invalid nutrition`;
  if (ing.priceHistory !== undefined && ing.priceHistory !== null) {
    if (!Array.isArray(ing.priceHistory)) return `${p}invalid priceHistory`;
    if (ing.priceHistory.length > 240) return `${p}too many priceHistory entries (max 240)`;
    for (const h of ing.priceHistory) {
      if (!h || typeof h !== 'object' || typeof h.month !== 'string' || h.month.length > 20) return `${p}invalid priceHistory entry`;
      if (typeof h.price !== 'number' || !Number.isFinite(h.price) || h.price < 0) return `${p}invalid priceHistory entry`;
    }
  }
  return null;
}

export function validateIngredients(ingredients: Ingredient[]): string | null {
  if (!Array.isArray(ingredients)) return 'ingredients must be an array';
  if (ingredients.length > 5000) return 'Too many ingredients (max 5000)';
  const ids = new Set<string>();
  for (let i = 0; i < ingredients.length; i++) {
    const ing = ingredients[i];
    if (ing && ids.has(ing.id)) return `Ingredient ${i}: duplicate id "${ing.id}"`;
    if (ing && ing.id) ids.add(ing.id);
    const err = validateIngredient(ing, `Ingredient ${i}`);
    if (err) return err;
  }
  return null;
}

/** Validate an array of string IDs (for deletedBatches/Caterings/TransportItems). */
export function validateIdList(ids: unknown, fieldName: string, max = 500): string | null {
  if (!Array.isArray(ids)) return `${fieldName} must be an array`;
  if (ids.length > max) return `${fieldName}: too many ids (max ${max})`;
  for (let i = 0; i < ids.length; i++) {
    if (typeof ids[i] !== 'string' || !VALID_ID_PATTERN.test(ids[i] as string)) {
      return `${fieldName}[${i}]: invalid id`;
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
    generated: !!b.generated,
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
  // Audit A10/T7: do NOT wrap this in try/catch returning empty defaults.
  // A swallowed DB error returned a 200 with empty arrays, which the planner
  // rendered as "no batches, no recipes" — visually identical to a fresh
  // install. Throw instead, asyncHandler routes to the global 500 handler,
  // and the frontend's apiGet shows the persistent error banner via
  // showDataError (public/js/utils.ts).
  const [batchRows, guestRows, cateringRows, transportRows, recipeV2Rows] = await Promise.all([
    prisma.batch.findMany(),
    prisma.guest.findMany(),
    // Legacy recipeIndex table kept in DB as backup but no longer served to frontend
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
    generated: b.generated,
  }));

  const guests = getDefaultGuests();
  for (const row of guestRows) {
    if (guests[row.location] && guests[row.location][row.day]) {
      guests[row.location][row.day].lunch = row.lunch;
      guests[row.location][row.day].dinner = row.dinner;
    }
  }

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
  // Denormalize ingredient names/allergens/cost so S.recipes on the frontend
  // has usable display data (otherwise batch recipe editor shows "Unknown").
  await denormalizeRecipeIngredients(recipes);

  return { batches, guests, recipes, caterings, transportItems };
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

// ── Per-entity write helpers (for full saves) ──

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

// ── Targeted patch helpers (upsert/delete only changed items) ──

/**
 * Sanitize a proposed parentId value: if it references a batch that does not
 * exist in the DB (and is not being created in the same save), return null
 * instead to avoid FK constraint violations.
 *
 * Fixes AI insight #20: `batches_parent_id_fkey` errors caused silent save
 * failures when a user had stale local state referencing a batch another user
 * had already deleted. onDelete: SetNull nulls the column on delete, but a
 * client update with the stale parentId would reintroduce the bad reference.
 */
export async function sanitizeParentId(
  parentId: string | null | undefined,
  siblingIds: Set<string> = new Set(),
): Promise<string | null> {
  if (!parentId) return null;
  if (siblingIds.has(parentId)) return parentId;
  const exists = await prisma.batch.findUnique({ where: { id: parentId }, select: { id: true } });
  if (!exists) {
    console.warn(`[dbUpsertBatches] dropping stale parentId ${parentId} (referenced batch no longer exists)`);
    return null;
  }
  return parentId;
}

/** Upsert batches: merge field-by-field with existing DB rows to prevent stale overwrites */
export async function dbUpsertBatches(batches: Batch[]): Promise<void> {
  if (batches.length === 0) return;

  // Process parents before children so a newly-created parent exists when its
  // child's insert references it. Batches without parentId go first.
  const sorted = [...batches].sort((a, b) => (a.parentId ? 1 : 0) - (b.parentId ? 1 : 0));
  const siblingIds = new Set(sorted.map(b => b.id));

  // Batch the read queries up front to eliminate 2N sequential round-trips
  // inside the loop (fix for /patch avg 760ms AI insight #12/#23). Railway
  // EU→Postgres EU RTT is 10–50ms, so on a 10-batch patch this replaces
  // 20 sequential queries with 2 parallel ones.
  const incomingIds = sorted.map(b => b.id);
  const parentIds = Array.from(new Set(
    sorted.map(b => b.parentId).filter((p): p is string => !!p && !siblingIds.has(p)),
  ));
  const [existingRows, existingParents] = await Promise.all([
    prisma.batch.findMany({ where: { id: { in: incomingIds } } }),
    parentIds.length > 0
      ? prisma.batch.findMany({ where: { id: { in: parentIds } }, select: { id: true } })
      : Promise.resolve([]),
  ]);
  const existingMap = new Map(existingRows.map(r => [r.id, r]));
  const validParentIds = new Set(existingParents.map(p => p.id));

  for (const b of sorted) {
    // Resolve parentId against batched parent-existence check (no DB round-trip)
    const safeParentId = !b.parentId
      ? null
      : siblingIds.has(b.parentId) || validParentIds.has(b.parentId)
        ? b.parentId
        : (console.warn(`[dbUpsertBatches] dropping stale parentId ${b.parentId} (referenced batch no longer exists)`), null);
    const bSafe: Batch = { ...b, parentId: safeParentId };

    const existing = existingMap.get(b.id);
    try {
      if (existing) {
        // Merge: incoming fields overwrite existing, but fields not sent by client
        // are preserved from the DB (protects against stale-field overwrites).
        // Force the sanitized parentId so a stale client value can't reintroduce
        // a dangling FK.
        const merged = toBatchRow({ ...existing as unknown as Batch, ...bSafe, parentId: safeParentId });
        await prisma.batch.update({ where: { id: b.id }, data: merged });
      } else {
        await prisma.batch.create({ data: toBatchRow(bSafe) });
      }
    } catch (e: unknown) {
      // Last-resort retry: if Prisma still raises a FK error (P2003), retry
      // with parentId cleared. Avoids dropping user edits for an obscure race.
      const code = (e as { code?: string })?.code;
      if (code === 'P2003') {
        console.warn(`[dbUpsertBatches] retrying batch ${b.id} with parentId=null after P2003`);
        const retryBatch: Batch = { ...bSafe, parentId: null };
        if (existing) {
          const merged = toBatchRow({ ...existing as unknown as Batch, ...retryBatch, parentId: null });
          await prisma.batch.update({ where: { id: b.id }, data: merged });
        } else {
          await prisma.batch.create({ data: toBatchRow(retryBatch) });
        }
      } else {
        throw e;
      }
    }
  }
}

/** Delete specific batches by ID */
export async function dbDeleteBatchIds(ids: string[]): Promise<void> {
  if (ids.length > 0) {
    await prisma.batch.deleteMany({ where: { id: { in: ids } } });
  }
}

/** Upsert caterings by ID */
export async function dbUpsertCaterings(caterings: Catering[]): Promise<void> {
  for (const c of caterings) {
    const row = toCateringRow(c);
    await prisma.catering.upsert({
      where: { id: c.id },
      create: row,
      update: row,
    });
  }
}

/** Delete specific caterings by ID */
export async function dbDeleteCateringIds(ids: string[]): Promise<void> {
  if (ids.length > 0) {
    await prisma.catering.deleteMany({ where: { id: { in: ids } } });
  }
}

/** Upsert transport items by ID */
export async function dbUpsertTransportItems(items: TransportItem[]): Promise<void> {
  for (const t of items) {
    const row = toTransportRow(t);
    await prisma.transportItem.upsert({
      where: { id: t.id },
      create: row,
      update: row,
    });
  }
}

/** Delete specific transport items by ID */
export async function dbDeleteTransportItemIds(ids: string[]): Promise<void> {
  if (ids.length > 0) {
    await prisma.transportItem.deleteMany({ where: { id: { in: ids } } });
  }
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

/**
 * Populate denormalized ingredient fields (ingredientName, ingredientAllergens, costPer100)
 * on a batch of recipes. Uses a single batched findMany across all linked ingredient IDs
 * to avoid N+1 queries. Mutates the recipes in place.
 *
 * Extracted so the same logic runs for dbReadAll(), GET /recipes list, and GET /recipes/:id.
 */
export async function denormalizeRecipeIngredients(recipes: RecipeFull[]): Promise<void> {
  if (recipes.length === 0) return;
  const idSet = new Set<string>();
  for (const r of recipes) {
    for (const ing of r.ingredients) {
      if (ing.ingredientId) idSet.add(ing.ingredientId);
    }
  }
  if (idSet.size === 0) return;
  const dbIngs = await prisma.ingredient.findMany({
    where: { id: { in: Array.from(idSet) } },
    select: { id: true, name: true, allergens: true, pricePer100: true },
  });
  const ingMap = new Map(dbIngs.map(i => [i.id, i]));
  for (const r of recipes) {
    for (const ing of r.ingredients) {
      if (ing.ingredientId) {
        const dbIng = ingMap.get(ing.ingredientId);
        if (dbIng) {
          ing.ingredientName = dbIng.name;
          ing.ingredientAllergens = dbIng.allergens;
          ing.costPer100 = dbIng.pricePer100 || 0;
        }
      }
    }
  }
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

/**
 * Hydrate a single recipe for the detail view: denormalize ingredient
 * names/allergens/price, compute cost per serving, and compute nutrition —
 * all with a SINGLE `ingredient.findMany` query instead of three.
 *
 * Also explicitly does NOT write-back the recomputed cost. The previous
 * `/recipes/:id` handler updated the row on every GET if the floating-point
 * cost differed, causing unnecessary write contention on a read-heavy path.
 * Recipe costs are recalculated via the explicit "Recalculate costs" button
 * and via `recalcRecipeCostsForIngredient()` when a price changes.
 *
 * Fix for AI insight: "All recipe endpoints exceed 1000ms avg — likely N+1".
 */
export async function hydrateRecipeForDetail(recipe: RecipeFull): Promise<void> {
  const linkedIds = Array.from(new Set(
    recipe.ingredients
      .filter(i => i.ingredientId && !i.isFlexible)
      .map(i => i.ingredientId!),
  ));

  if (linkedIds.length === 0 || !recipe.recipeVolume) {
    // Nothing to hydrate beyond what's already on the row
    return;
  }

  const dbIngs = await prisma.ingredient.findMany({
    where: { id: { in: linkedIds } },
    select: {
      id: true,
      name: true,
      allergens: true,
      pricePer100: true,
      nutrition: true,
    },
  });
  const ingMap = new Map(dbIngs.map(i => [i.id, i]));

  // Denormalize name / allergens / cost per row
  for (const ing of recipe.ingredients) {
    if (!ing.ingredientId) continue;
    const dbIng = ingMap.get(ing.ingredientId);
    if (!dbIng) continue;
    ing.ingredientName = dbIng.name;
    ing.ingredientAllergens = dbIng.allergens;
    ing.costPer100 = dbIng.pricePer100 || 0;
  }

  // Compute cost and nutrition from the same map
  const baseServings = (recipe.recipeVolume * 1000) / recipe.servingSize;
  if (baseServings <= 0) return;

  const FLEX_PRICE_PER_100G = 0.15;
  let totalCost = 0;

  const totals = { energyKcal: 0, energyKj: 0, fat: 0, saturatedFat: 0, carbs: 0, sugar: 0, fiber: 0, protein: 0, salt: 0 };
  let withData = 0;
  let totalLinked = 0;

  for (const ing of recipe.ingredients) {
    const amountGrams = toGrams(ing.rawAmount, ing.unit);
    if (ing.isFlexible) {
      totalCost += (amountGrams / 100) * FLEX_PRICE_PER_100G;
      continue;
    }
    if (!ing.ingredientId) continue;
    const dbIng = ingMap.get(ing.ingredientId);
    if (!dbIng) continue;
    const pricePer100 = dbIng.pricePer100 || 0;
    totalCost += (amountGrams / 100) * pricePer100;

    totalLinked++;
    const nutr = dbIng.nutrition as Record<string, number> | null;
    if (!nutr || Object.keys(nutr).length === 0) continue;
    withData++;
    const factor = amountGrams / 100;
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

  recipe.costPerServing = Math.round((totalCost / baseServings) * 100) / 100;

  if (totalLinked > 0) {
    recipe.nutrition = {
      energyKcal: Math.round(totals.energyKcal / baseServings),
      energyKj: Math.round(totals.energyKj / baseServings),
      fat: Math.round(totals.fat / baseServings * 10) / 10,
      saturatedFat: Math.round(totals.saturatedFat / baseServings * 10) / 10,
      carbs: Math.round(totals.carbs / baseServings * 10) / 10,
      sugar: Math.round(totals.sugar / baseServings * 10) / 10,
      fiber: Math.round(totals.fiber / baseServings * 10) / 10,
      protein: Math.round(totals.protein / baseServings * 10) / 10,
      salt: Math.round(totals.salt / baseServings * 100) / 100,
      completeness: totalLinked > 0 ? withData / totalLinked : 0,
    };
  }
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
    select: { id: true, pricePer100: true },
  });
  const priceMap = new Map(dbIngredients.map(i => [i.id, i.pricePer100 || 0]));

  const baseServings = (recipeVolume * 1000) / servingSize;
  if (baseServings <= 0) return null;

  const FLEX_PRICE_PER_100G = 0.15; // €1.50/kg default for flex ingredients

  let totalCost = 0;
  for (const ing of ingredients) {
    const amountGrams = toGrams(ing.rawAmount, ing.unit);
    if (ing.isFlexible) {
      totalCost += (amountGrams / 100) * FLEX_PRICE_PER_100G;
      continue;
    }
    if (!ing.ingredientId) continue;
    const pricePer100 = priceMap.get(ing.ingredientId) || 0;
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

// toGrams: see shared/units.ts (single source of truth — was duplicated here,
// in public/js/recipe-editor.ts, and in public/js/orders.ts as toBaseUnit).

/** Validate a recipe for required fields. Catches the servingSize=0 edge case
 *  that previously caused division-by-zero in hydrateRecipeForDetail. */
export function validateRecipe(r: {
  id?: unknown;
  name?: string;
  type?: string;
  servingSize?: number;
  recipeVolume?: number | null;
  ingredients?: Array<{ id?: unknown; rawAmount?: unknown; cookedAmount?: unknown; unit?: unknown; ingredientId?: unknown; isFlexible?: unknown }>;
  extraAllergens?: unknown;
  prepSteps?: Array<{ step?: unknown; text?: unknown }>;
}): string | null {
  if (r.id !== undefined && r.id !== null && (typeof r.id !== 'string' || !VALID_ID_PATTERN.test(r.id))) return 'invalid id';
  if (!r.name || typeof r.name !== 'string' || r.name.length > 200) return 'invalid name';
  if (r.type && !VALID_TYPES.includes(r.type)) return `invalid type "${r.type}"`;
  if (r.servingSize !== undefined && (typeof r.servingSize !== 'number' || r.servingSize < 1 || r.servingSize > 9999)) return 'invalid servingSize';
  if (r.recipeVolume !== undefined && r.recipeVolume !== null && (typeof r.recipeVolume !== 'number' || r.recipeVolume < 0 || r.recipeVolume > 9999)) return 'invalid recipeVolume';
  if (r.extraAllergens !== undefined) {
    if (!Array.isArray(r.extraAllergens)) return 'extraAllergens must be an array';
    if (r.extraAllergens.length > 50) return 'too many extraAllergens';
    for (const a of r.extraAllergens) if (typeof a !== 'string' || a.length > 100) return 'invalid extraAllergens entry';
  }
  if (r.ingredients !== undefined) {
    if (!Array.isArray(r.ingredients)) return 'ingredients must be an array';
    if (r.ingredients.length > 200) return 'too many ingredients (max 200)';
    for (let i = 0; i < r.ingredients.length; i++) {
      const ing = r.ingredients[i];
      if (ing.id !== undefined && ing.id !== null && (typeof ing.id !== 'string' || !VALID_ID_PATTERN.test(ing.id))) return `ingredient ${i}: invalid id`;
      if (typeof ing.rawAmount !== 'number' || ing.rawAmount < 0 || ing.rawAmount > 999999) return `ingredient ${i}: invalid rawAmount`;
      if (ing.cookedAmount !== undefined && ing.cookedAmount !== null && (typeof ing.cookedAmount !== 'number' || ing.cookedAmount < 0 || ing.cookedAmount > 999999)) return `ingredient ${i}: invalid cookedAmount`;
      if (ing.unit !== undefined && (typeof ing.unit !== 'string' || ing.unit.length > 20)) return `ingredient ${i}: invalid unit`;
      if (ing.ingredientId !== undefined && ing.ingredientId !== null && (typeof ing.ingredientId !== 'string' || !VALID_ID_PATTERN.test(ing.ingredientId))) return `ingredient ${i}: invalid ingredientId`;
      if (ing.isFlexible !== undefined && typeof ing.isFlexible !== 'boolean') return `ingredient ${i}: isFlexible must be boolean`;
    }
  }
  if (r.prepSteps !== undefined) {
    if (!Array.isArray(r.prepSteps)) return 'prepSteps must be an array';
    if (r.prepSteps.length > 50) return 'too many prepSteps';
    for (let i = 0; i < r.prepSteps.length; i++) {
      const ps = r.prepSteps[i];
      if (typeof ps.step !== 'number') return `prepStep ${i}: step must be a number`;
      if (typeof ps.text !== 'string' || ps.text.length > 5000) return `prepStep ${i}: invalid text`;
    }
  }
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

/**
 * Recalculate cost for EVERY recipe in one pass. Used after a bulk ingredient
 * write (supplier-XLSX import / POST /api/ingredients) where pricePer100 may
 * have changed for many rows at once. Audit T19 — calling
 * recalcRecipeCostsForIngredient per row would be ~2N queries; this helper
 * is two reads plus N writes (one per recipe whose cost actually changed).
 *
 * Becomes meaningful only with T19a's FK-preserving bulk POST in place.
 * Pre-T19a the bulk POST wiped recipe→ingredient links so the recalc found
 * zero linked rows for every recipe and produced null. Post-T19a (PR #33)
 * the FKs survive and the recalc produces real numbers.
 */
export async function recalcAllRecipeCosts(): Promise<number> {
  const recipes = await prisma.recipe.findMany({
    include: { ingredients: true },
  });
  if (recipes.length === 0) return 0;

  // Pull every linked ingredient's pricePer100 in one query, then reproduce
  // calcRecipeCost's math in memory — sharing the price map across recipes
  // avoids the N findManys that calling calcRecipeCost per recipe would do.
  const allIngredientIds = [...new Set(
    recipes.flatMap(r => r.ingredients.filter(i => i.ingredientId && !i.isFlexible).map(i => i.ingredientId as string)),
  )];
  const dbIngredients = allIngredientIds.length > 0
    ? await prisma.ingredient.findMany({ where: { id: { in: allIngredientIds } }, select: { id: true, pricePer100: true } })
    : [];
  const priceMap = new Map(dbIngredients.map(i => [i.id, i.pricePer100 || 0]));
  const FLEX_PRICE_PER_100G = 0.15;

  let updated = 0;
  for (const r of recipes) {
    const linkedRows = r.ingredients.filter(i => i.ingredientId && !i.isFlexible);
    let newCost: number | null = null;
    if (linkedRows.length > 0 && r.recipeVolume) {
      const baseServings = (r.recipeVolume * 1000) / r.servingSize;
      if (baseServings > 0) {
        let totalCost = 0;
        for (const ing of r.ingredients) {
          const amountGrams = toGrams(ing.rawAmount, ing.unit);
          if (ing.isFlexible) {
            totalCost += (amountGrams / 100) * FLEX_PRICE_PER_100G;
            continue;
          }
          if (!ing.ingredientId) continue;
          const pricePer100 = priceMap.get(ing.ingredientId) || 0;
          totalCost += (amountGrams / 100) * pricePer100;
        }
        newCost = Math.round((totalCost / baseServings) * 100) / 100;
      }
    }
    if (newCost !== r.costPerServing) {
      await prisma.recipe.update({ where: { id: r.id }, data: { costPerServing: newCost } });
      updated++;
    }
  }
  return updated;
}
