// ─────────────────────────────────────────────────────────────────────────────
// DRINKS — backend helpers shared by routes/drinks.ts and prisma/seed.js logic.
// Row↔shape mapping, validation, BTW + (M3) costing, config singleton access.
// See DRINKS_DOMAIN.md for the domain spec.
// ─────────────────────────────────────────────────────────────────────────────

import { Prisma } from '@prisma/client';
import { prisma } from './db';
import { AppError } from './config';
import type {
  Drink, DrinkMode, DrinkStatus, DrinkServingFormat, DrinkLocationInfo, DrinkInfo,
  DrinkBatchDef, DrinkPrepTime, DrinkIngredientRow, DrinkRefKind, DrinkSupplier,
  DrinkConfig, DrinkSupplierContact,
} from '../shared/types';
import { DEFAULT_DRINK_STORAGE_AREAS } from '../shared/types';
import { makeCostContext, drinkTotalCostExBtw, suggestedPriceInclBtw, targetMarkupFor, effectiveBtw } from '../shared/drink-cost';
export { effectiveBtw };

export const VALID_LOCATIONS = ['west', 'centraal'];
export const VALID_DRINK_MODES: DrinkMode[] = ['catalogue', 'recipe'];
export const VALID_DRINK_STATUSES: DrinkStatus[] = ['draft', 'published'];
export const VALID_REF_KINDS: DrinkRefKind[] = ['ingredient', 'drink'];
export const VALID_UNITS = ['ml', 'g', 'piece'];

// Default module config — used when the DrinkConfig singleton is missing/empty.
// Values from drinks-assortments.json `config` (DRINKS_DOMAIN §4).
export const DEFAULT_DRINK_CONFIG: DrinkConfig = {
  labourRatePerMin: 0.29,
  priceRounding: 0.1,
  btwRule: { alcoholicAbvThreshold: 0.5, alcoholic: 21, nonAlcoholic: 9 },
  markupTargets: { defaultMultiple: 4.0 },
  demandNudgeThresholdPct: 25,
  defaultShelfLifeDays: 7,
  storageAreas: DEFAULT_DRINK_STORAGE_AREAS,
};

// ── JSON normalizers (defensive: bad/legacy JSON never crashes a read) ──

function asObj(v: Prisma.JsonValue | undefined): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function asArr(v: Prisma.JsonValue | undefined): unknown[] {
  return Array.isArray(v) ? v : [];
}
function num(v: unknown): number | null {
  // null/''/undefined must stay null — Number(null) is 0, which would silently
  // turn an unset price/par into a real 0 (e.g. a free drink) on read.
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function normalizeFormats(raw: Prisma.JsonValue | undefined): DrinkServingFormat[] {
  return asArr(raw).map((f) => {
    const o = (f && typeof f === 'object' ? f : {}) as Record<string, unknown>;
    const price: Record<string, number | null> = {};
    const rawPrice = (o.price && typeof o.price === 'object' ? o.price : {}) as Record<string, unknown>;
    for (const loc of Object.keys(rawPrice)) price[loc] = num(rawPrice[loc]);
    return {
      name: String(o.name ?? ''),
      volumeMl: num(o.volumeMl) ?? 0,
      glass: o.glass ? String(o.glass) : undefined,
      price,
    };
  });
}

export function normalizeLocations(raw: Prisma.JsonValue | undefined): Record<string, DrinkLocationInfo> {
  const o = asObj(raw);
  const out: Record<string, DrinkLocationInfo> = {};
  for (const loc of Object.keys(o)) {
    const e = (o[loc] && typeof o[loc] === 'object' ? o[loc] : {}) as Record<string, unknown>;
    out[loc] = { par: num(e.par), active: e.active !== false, area: typeof e.area === 'string' && e.area ? e.area : undefined };
  }
  return out;
}

export function normalizeInfo(raw: Prisma.JsonValue | undefined): DrinkInfo {
  const o = asObj(raw);
  const info: DrinkInfo = {};
  for (const k of ['producer', 'region', 'country', 'vintage', 'soil', 'grapes', 'profile', 'notes', 'extra'] as const) {
    if (typeof o[k] === 'string') info[k] = o[k] as string;
  }
  if (typeof o.natural === 'boolean') info.natural = o.natural;
  if (typeof o.bio === 'boolean') info.bio = o.bio;
  return info;
}

export function normalizeBatch(raw: Prisma.JsonValue | undefined): DrinkBatchDef {
  const o = asObj(raw);
  return {
    volumeMl: num(o.volumeMl) ?? 0,
    bottleSizeMl: num(o.bottleSizeMl),
    note: typeof o.note === 'string' ? o.note : undefined,
  };
}

export function normalizePrepTime(raw: Prisma.JsonValue | undefined): DrinkPrepTime {
  const o = asObj(raw);
  return {
    prebatchMin: num(o.prebatchMin) ?? 0,
    prebatchYieldServings: num(o.prebatchYieldServings),
    perServeMin: num(o.perServeMin) ?? 0,
  };
}

export function normalizeStrArr(raw: Prisma.JsonValue | undefined): string[] {
  return asArr(raw).filter((x): x is string => typeof x === 'string');
}

// ── Row → shape mappers ──

type DrinkRowRelations = Prisma.DrinkGetPayload<{ include: { ingredientRows: true } }>;
// A row that may or may not have ingredientRows included.
type DrinkRowMaybe = Omit<DrinkRowRelations, 'ingredientRows'> & { ingredientRows?: DrinkRowRelations['ingredientRows'] };

export function toDrinkIngredientRow(r: {
  id: string; drinkId: string; sortOrder: number; refKind: string;
  ingredientId: string | null; refDrinkId: string | null; amount: number | null;
  unit: string; note: string;
}): DrinkIngredientRow {
  return {
    id: r.id,
    drinkId: r.drinkId,
    sortOrder: r.sortOrder,
    refKind: r.refKind as DrinkRefKind,
    ingredientId: r.ingredientId,
    refDrinkId: r.refDrinkId,
    amount: r.amount,
    unit: r.unit,
    note: r.note,
  };
}

/** Map a Prisma drink row → shared Drink. Pass `stockByLocation` (pre-aggregated
 *  via a groupBy) so list reads don't load every DrinkStock row. */
export function toDrink(row: DrinkRowMaybe, stockByLocation?: Record<string, number>): Drink {
  return {
    id: row.id,
    name: row.name,
    mode: row.mode as DrinkMode,
    category: row.category,
    subtype: row.subtype,
    abv: row.abv,
    btwRate: row.btwRate,
    status: row.status as DrinkStatus,
    archived: row.archived,
    sellable: row.sellable,
    supplier: row.supplier,
    orderUnit: row.orderUnit,
    orderUnitMl: row.orderUnitMl,
    packNote: row.packNote,
    itemId: row.itemId,
    deposit: row.deposit,
    costPrice: row.costPrice,
    costNote: row.costNote,
    formats: normalizeFormats(row.formats),
    locations: normalizeLocations(row.locations),
    info: normalizeInfo(row.info),
    tebiProductNames: row.tebiProductNames ?? [],
    serveVolumeMl: row.serveVolumeMl,
    glass: row.glass,
    glassVolumeMl: row.glassVolumeMl,
    servingTemp: row.servingTemp,
    characteristics: row.characteristics ?? [],
    garnish: row.garnish ?? [],
    seasonality: row.seasonality,
    serviceInstructions: row.serviceInstructions,
    prepSteps: normalizeStrArr(row.prepSteps),
    batch: normalizeBatch(row.batch),
    prepTime: normalizePrepTime(row.prepTime),
    shelfLifeDays: row.shelfLifeDays,
    costPerServe: row.costPerServe,
    suggestedPrice: row.suggestedPrice,
    photoUrl: row.photoUrl ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ingredientRows: (row.ingredientRows ?? []).map(toDrinkIngredientRow),
    stockByLocation: stockByLocation ?? {},
  };
}

export function toDrinkSupplier(row: {
  id: string; name: string; products: string; orderDays: string[]; orderDaysNote: string;
  orderCutoff: string; deliveryWindow: string; contact: Prisma.JsonValue; minimumOrder: string;
  notes: string; priceListRef: string;
}): DrinkSupplier {
  return {
    id: row.id,
    name: row.name,
    products: row.products,
    orderDays: row.orderDays ?? [],
    orderDaysNote: row.orderDaysNote,
    orderCutoff: row.orderCutoff,
    deliveryWindow: row.deliveryWindow,
    contact: asObj(row.contact) as DrinkSupplierContact,
    minimumOrder: row.minimumOrder,
    notes: row.notes,
    priceListRef: row.priceListRef,
  };
}

// ── Stock aggregation: pool per (drink, location) = Σ qty over storage areas ──

/** Build { [drinkId]: { [location]: poolQty } } from a groupBy result. */
export function buildStockMap(
  grouped: Array<{ drinkId: string; location: string; _sum: { qty: number | null } }>,
): Record<string, Record<string, number>> {
  const map: Record<string, Record<string, number>> = {};
  for (const g of grouped) {
    if (!map[g.drinkId]) map[g.drinkId] = {};
    map[g.drinkId][g.location] = g._sum.qty ?? 0;
  }
  return map;
}

/** One drink's pool-by-location, fetched via groupBy. */
export async function stockByLocationFor(drinkId: string): Promise<Record<string, number>> {
  const grouped = await prisma.drinkStock.groupBy({
    by: ['location'],
    where: { drinkId },
    _sum: { qty: true },
  });
  const out: Record<string, number> = {};
  for (const g of grouped) out[g.location] = g._sum.qty ?? 0;
  return out;
}

// ── BTW + config ──

/** Read the DrinkConfig singleton, merged over defaults. */
export async function getDrinkConfig(): Promise<DrinkConfig> {
  const row = await prisma.drinkConfig.findUnique({ where: { id: 'default' } });
  const stored = row ? asObj(row.config) : {};
  return mergeConfig(stored);
}

/** Merge a stored (possibly partial) config object over the defaults. */
export function mergeConfig(stored: Record<string, unknown>): DrinkConfig {
  const d = DEFAULT_DRINK_CONFIG;
  const btw = asObj(stored.btwRule as Prisma.JsonValue);
  const markup = asObj(stored.markupTargets as Prisma.JsonValue);
  const markupTargets: DrinkConfig['markupTargets'] = {
    defaultMultiple: num(markup.defaultMultiple) ?? d.markupTargets.defaultMultiple,
  };
  for (const k of Object.keys(markup)) {
    if (k === 'defaultMultiple') continue;
    markupTargets[k] = num(markup[k]); // null allowed
  }
  return {
    labourRatePerMin: num(stored.labourRatePerMin) ?? d.labourRatePerMin,
    priceRounding: num(stored.priceRounding) ?? d.priceRounding,
    btwRule: {
      alcoholicAbvThreshold: num(btw.alcoholicAbvThreshold) ?? d.btwRule.alcoholicAbvThreshold,
      alcoholic: num(btw.alcoholic) ?? d.btwRule.alcoholic,
      nonAlcoholic: num(btw.nonAlcoholic) ?? d.btwRule.nonAlcoholic,
    },
    markupTargets,
    demandNudgeThresholdPct: num(stored.demandNudgeThresholdPct) ?? d.demandNudgeThresholdPct,
    defaultShelfLifeDays: num(stored.defaultShelfLifeDays) ?? d.defaultShelfLifeDays,
    storageAreas: mergeStorageAreas(stored.storageAreas),
  };
}

/** Per-location area lists: stored non-empty string arrays win, defaults fill
 *  the gaps (a location with no/empty stored list keeps its built-in areas). */
function mergeStorageAreas(raw: unknown): Record<string, string[]> {
  const stored = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? (raw as Record<string, unknown>) : {};
  const out: Record<string, string[]> = {};
  for (const loc of Object.keys(DEFAULT_DRINK_STORAGE_AREAS)) {
    const list = Array.isArray(stored[loc])
      ? [...new Set((stored[loc] as unknown[]).filter((a): a is string => typeof a === 'string' && a.trim().length > 0).map(a => a.trim()))]
      : [];
    out[loc] = list.length ? list : DEFAULT_DRINK_STORAGE_AREAS[loc];
  }
  return out;
}

// ── Input validation + Prisma data builder (catalogue + recipe shared) ──

export interface DrinkInput {
  id?: string;
  name?: string;
  mode?: string;
  category?: string;
  subtype?: string;
  abv?: number;
  btwRate?: number | null;
  status?: string;
  sellable?: boolean;
  supplier?: string;
  orderUnit?: string;
  orderUnitMl?: number | null;
  packNote?: string;
  itemId?: string | null;
  deposit?: number;
  costPrice?: number | null;
  costNote?: string;
  formats?: unknown;
  locations?: unknown;
  info?: unknown;
  tebiProductNames?: string[];
  serveVolumeMl?: number | null;
  glass?: string;
  glassVolumeMl?: number | null;
  servingTemp?: string;
  characteristics?: string[];
  garnish?: string[];
  seasonality?: string;
  serviceInstructions?: string;
  prepSteps?: unknown;
  batch?: unknown;
  prepTime?: unknown;
  shelfLifeDays?: number | null;
  ingredientRows?: unknown[];
}

const ID_RE = /^[a-zA-Z0-9_-]{1,200}$/;

function reqNum(v: unknown, field: string, min: number, max: number): void {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
    throw new AppError(400, `invalid ${field}`);
  }
}
function optNum(v: unknown, field: string, min: number, max: number): void {
  if (v == null) return;
  reqNum(v, field, min, max);
}
function optStr(v: unknown, field: string, max: number): void {
  if (v == null) return;
  if (typeof v !== 'string' || v.length > max) throw new AppError(400, `invalid ${field}`);
}

/** Validate user-editable drink fields. Throws AppError(400). `requireId` for create. */
export function validateDrinkInput(input: DrinkInput, requireId = false): void {
  if (requireId) {
    if (typeof input.id !== 'string' || !ID_RE.test(input.id)) throw new AppError(400, 'invalid id');
  }
  if (typeof input.name !== 'string' || input.name.length === 0 || input.name.length > 200) throw new AppError(400, 'invalid name');
  if (typeof input.mode !== 'string' || !VALID_DRINK_MODES.includes(input.mode as DrinkMode)) throw new AppError(400, 'invalid mode');
  if (typeof input.category !== 'string' || input.category.length === 0 || input.category.length > 60) throw new AppError(400, 'invalid category');
  optStr(input.subtype, 'subtype', 60);
  optNum(input.abv, 'abv', 0, 100);
  if (input.btwRate != null) reqNum(input.btwRate, 'btwRate', 0, 100);
  if (input.status != null && !VALID_DRINK_STATUSES.includes(input.status as DrinkStatus)) throw new AppError(400, 'invalid status');
  optStr(input.supplier, 'supplier', 200);
  optStr(input.orderUnit, 'orderUnit', 100);
  optNum(input.orderUnitMl, 'orderUnitMl', 0, 10_000_000);
  optStr(input.packNote, 'packNote', 500);
  optStr(input.itemId, 'itemId', 100);
  optNum(input.deposit, 'deposit', 0, 100_000);
  optNum(input.costPrice, 'costPrice', 0, 1_000_000);
  optStr(input.costNote, 'costNote', 500);
  optNum(input.serveVolumeMl, 'serveVolumeMl', 0, 100_000);
  optStr(input.glass, 'glass', 100);
  optNum(input.glassVolumeMl, 'glassVolumeMl', 0, 100_000);
  optStr(input.servingTemp, 'servingTemp', 100);
  optStr(input.seasonality, 'seasonality', 100);
  optStr(input.serviceInstructions, 'serviceInstructions', 5000);
  optNum(input.shelfLifeDays, 'shelfLifeDays', 0, 3650);
  if (input.formats != null && !Array.isArray(input.formats)) throw new AppError(400, 'formats must be an array');
  if (Array.isArray(input.formats) && input.formats.length > 20) throw new AppError(400, 'too many formats');
  if (input.locations != null && (typeof input.locations !== 'object' || Array.isArray(input.locations))) throw new AppError(400, 'locations must be an object');
  if (input.info != null && (typeof input.info !== 'object' || Array.isArray(input.info))) throw new AppError(400, 'info must be an object');
  if (input.characteristics != null && (!Array.isArray(input.characteristics) || input.characteristics.length > 10)) throw new AppError(400, 'invalid characteristics');
  if (input.garnish != null && (!Array.isArray(input.garnish) || input.garnish.length > 20)) throw new AppError(400, 'invalid garnish');
  if (input.tebiProductNames != null && (!Array.isArray(input.tebiProductNames) || input.tebiProductNames.length > 50)) throw new AppError(400, 'invalid tebiProductNames');
  if (input.prepSteps != null && !Array.isArray(input.prepSteps)) throw new AppError(400, 'prepSteps must be an array');
  if (input.ingredientRows != null) {
    if (!Array.isArray(input.ingredientRows)) throw new AppError(400, 'ingredientRows must be an array');
    if (input.ingredientRows.length > 60) throw new AppError(400, 'too many ingredient rows (max 60)');
    for (const r of input.ingredientRows) {
      const rr = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
      if (rr.refKind !== 'ingredient' && rr.refKind !== 'drink') throw new AppError(400, 'invalid row refKind');
      if (rr.refKind === 'ingredient' && rr.ingredientId != null && !ID_RE.test(String(rr.ingredientId))) throw new AppError(400, 'invalid row ingredientId');
      if (rr.refKind === 'drink' && rr.refDrinkId != null && !ID_RE.test(String(rr.refDrinkId))) throw new AppError(400, 'invalid row refDrinkId');
      if (rr.amount != null && (typeof rr.amount !== 'number' || !Number.isFinite(rr.amount) || rr.amount < 0 || rr.amount > 1_000_000)) throw new AppError(400, 'invalid row amount');
      if (rr.unit != null && !VALID_UNITS.includes(String(rr.unit))) throw new AppError(400, 'invalid row unit');
    }
  }
}

/** Build DrinkIngredientRow create-data from a validated input row array. Rows
 *  are replaced wholesale on every save, so ids are deterministic per index. */
export function buildRowData(rows: unknown[] | undefined, drinkId: string) {
  return (rows || []).map((r, i) => {
    const rr = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
    const refKind: DrinkRefKind = rr.refKind === 'drink' ? 'drink' : 'ingredient';
    return {
      id: `${drinkId}-row-${i}`,
      drinkId,
      sortOrder: i,
      refKind,
      ingredientId: refKind === 'ingredient' && typeof rr.ingredientId === 'string' ? rr.ingredientId : null,
      refDrinkId: refKind === 'drink' && typeof rr.refDrinkId === 'string' ? rr.refDrinkId : null,
      amount: typeof rr.amount === 'number' && Number.isFinite(rr.amount) ? rr.amount : null,
      unit: typeof rr.unit === 'string' ? rr.unit : 'ml',
      note: typeof rr.note === 'string' ? rr.note.slice(0, 500) : '',
    };
  });
}

function round2(n: number): number { return Math.round(n * 100) / 100; }

/** Recompute costPerServe (ex-BTW) + suggestedPrice (incl-BTW) for every
 *  recipe-mode drink, using the full drink + ingredient graph so building-block
 *  changes propagate to dependents. Returns the number of rows updated. */
export async function recalcAllDrinkCosts(): Promise<number> {
  const cfg = await getDrinkConfig();
  const [drinkRows, ingRows] = await Promise.all([
    prisma.drink.findMany({ include: { ingredientRows: { orderBy: { sortOrder: 'asc' } } } }),
    prisma.ingredient.findMany({ select: { id: true, pricePer100: true } }),
  ]);
  const drinks = drinkRows.map(r => toDrink(r));
  const ctx = makeCostContext(drinks, ingRows.map(i => ({ id: i.id, pricePer100: i.pricePer100 || 0 })), cfg);
  let updated = 0;
  for (const drink of drinks) {
    if (drink.mode !== 'recipe') continue; // catalogue cost is derived on read, not stored
    const totalCost = round2(drinkTotalCostExBtw(drink, ctx));
    const btw = effectiveBtw(drink.abv, drink.btwRate, cfg);
    const target = targetMarkupFor(drink.category, cfg);
    const suggested = suggestedPriceInclBtw(drinkTotalCostExBtw(drink, ctx), btw, target, cfg);
    if (totalCost !== drink.costPerServe || suggested !== drink.suggestedPrice) {
      await prisma.drink.update({ where: { id: drink.id }, data: { costPerServe: totalCost, suggestedPrice: suggested } });
      updated++;
    }
  }
  return updated;
}

/** Build the Prisma create/update data object from a validated input. Omits
 *  ingredient rows (handled separately) and never sets id (create sets it). */
export function buildDrinkData(input: DrinkInput): Prisma.DrinkUncheckedUpdateInput {
  const j = (v: unknown): Prisma.InputJsonValue => (v ?? null) as Prisma.InputJsonValue;
  const data: Prisma.DrinkUncheckedUpdateInput = {
    name: input.name,
    mode: input.mode,
    category: input.category,
    subtype: input.subtype ?? '',
    abv: input.abv ?? 0,
    btwRate: input.btwRate ?? null,
    status: input.status ?? 'draft',
    sellable: input.sellable ?? true,
    supplier: input.supplier ?? '',
    orderUnit: input.orderUnit ?? '',
    orderUnitMl: input.orderUnitMl ?? null,
    packNote: input.packNote ?? '',
    itemId: input.itemId ?? null,
    deposit: input.deposit ?? 0,
    costPrice: input.costPrice ?? null,
    costNote: input.costNote ?? '',
    tebiProductNames: input.tebiProductNames ?? [],
    serveVolumeMl: input.serveVolumeMl ?? null,
    glass: input.glass ?? '',
    glassVolumeMl: input.glassVolumeMl ?? null,
    servingTemp: input.servingTemp ?? '',
    characteristics: input.characteristics ?? [],
    garnish: input.garnish ?? [],
    seasonality: input.seasonality ?? '',
    serviceInstructions: input.serviceInstructions ?? '',
    shelfLifeDays: input.shelfLifeDays ?? null,
  };
  if (input.formats !== undefined) data.formats = j(input.formats);
  if (input.locations !== undefined) data.locations = j(input.locations);
  if (input.info !== undefined) data.info = j(input.info);
  if (input.prepSteps !== undefined) data.prepSteps = j(input.prepSteps);
  if (input.batch !== undefined) data.batch = j(input.batch);
  if (input.prepTime !== undefined) data.prepTime = j(input.prepTime);
  return data;
}
