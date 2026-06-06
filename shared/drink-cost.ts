// ─────────────────────────────────────────────────────────────────────────────
// DRINKS — costing & pricing (pure, shared by backend recalc + frontend live
// preview; unit-tested directly). Mirrors shared/recipe-cost.ts as a dual-use
// module so the two cost engines never diverge.
//
// Recursive cost rollup over building blocks (a drink row can reference another
// Drink, ≥2 levels deep), cycle-safe + memoised. Labour amortisation, BTW,
// markup vs per-category target, suggested price. See DRINKS_DOMAIN.md §4.
// ─────────────────────────────────────────────────────────────────────────────

import type { Drink, DrinkConfig, DrinkIngredientRow } from './types';
import { toGrams } from './units';

/** Minimal ingredient shape needed for costing (from the Ingredient DB). */
export interface CostIngredient { id: string; pricePer100: number }

export interface CostContext {
  drinksById: Map<string, Drink>;
  ingredientsById: Map<string, CostIngredient>;
  cfg: DrinkConfig;
  memo: Map<string, number>; // drinkId → cost per ml (cache)
}

export function makeCostContext(
  drinks: Drink[],
  ingredients: CostIngredient[],
  cfg: DrinkConfig,
): CostContext {
  return {
    drinksById: new Map(drinks.map(d => [d.id, d])),
    ingredientsById: new Map(ingredients.map(i => [i.id, i])),
    cfg,
    memo: new Map(),
  };
}

/** Cost (€) per ml of a drink when referenced by volume in another recipe.
 *  - catalogue: costPrice (ex-BTW per order unit) ÷ orderUnitMl
 *  - building-block: batch ingredient cost ÷ batch.volumeMl
 *  - other served recipe: per-serve ingredient cost ÷ serveVolumeMl
 *  Recursive, cycle-safe (a cycle contributes 0), memoised per context. */
export function drinkCostPerMl(drink: Drink, ctx: CostContext, visiting: Set<string> = new Set()): number {
  const cached = ctx.memo.get(drink.id);
  if (cached !== undefined) return cached;
  if (visiting.has(drink.id)) return 0; // cycle — break at 0
  visiting.add(drink.id);

  let perMl = 0;
  if (drink.mode === 'catalogue') {
    perMl = (drink.costPrice != null && drink.orderUnitMl && drink.orderUnitMl > 0)
      ? drink.costPrice / drink.orderUnitMl
      : 0;
  } else {
    const isBlock = drink.category === 'building-block';
    const unitVol = isBlock ? (drink.batch?.volumeMl || 0) : (drink.serveVolumeMl || 0);
    const unitCost = rowsCost(drink.ingredientRows, ctx, visiting);
    perMl = unitVol > 0 ? unitCost / unitVol : 0;
  }

  visiting.delete(drink.id);
  ctx.memo.set(drink.id, perMl);
  return perMl;
}

/** Ingredient cost (€) of a set of rows, in the rows' own basis (per-serve for
 *  served recipes, per-batch for building blocks):
 *   - ingredient ref → toGrams(amount,unit)/100 × pricePer100
 *   - drink ref      → amount(ml) × drinkCostPerMl(refDrink) */
export function rowsCost(rows: DrinkIngredientRow[] | undefined, ctx: CostContext, visiting: Set<string> = new Set()): number {
  let total = 0;
  for (const r of rows || []) {
    if (r.amount == null) continue;
    if (r.refKind === 'drink' && r.refDrinkId) {
      const ref = ctx.drinksById.get(r.refDrinkId);
      if (ref) total += r.amount * drinkCostPerMl(ref, ctx, visiting);
    } else if (r.refKind === 'ingredient' && r.ingredientId) {
      const ing = ctx.ingredientsById.get(r.ingredientId);
      if (ing) total += (toGrams(r.amount, r.unit) / 100) * (ing.pricePer100 || 0);
    }
  }
  return total;
}

/** Servings one prebatch yields — explicit prebatchYieldServings if given, else
 *  derived from batch.volumeMl ÷ serveVolumeMl, else 1. Without this, a batch
 *  drink that omits the yield would amortise its whole prebatch over a single
 *  serve (e.g. a 4 L iced-tea batch costing 20 min of labour per glass). */
export function prebatchYield(drink: Drink): number {
  const pt = drink.prepTime;
  if (pt && pt.prebatchYieldServings && pt.prebatchYieldServings > 0) return pt.prebatchYieldServings;
  const bv = drink.batch?.volumeMl || 0;
  const sv = drink.serveVolumeMl || 0;
  return (bv > 0 && sv > 0) ? bv / sv : 1;
}

/** Labour € per serve = (prebatchMin ÷ prebatchYield + perServeMin) × rate. */
export function labourPerServe(drink: Drink, cfg: DrinkConfig): number {
  const pt = drink.prepTime || { prebatchMin: 0, perServeMin: 0 };
  const prebatchPerServe = (pt.prebatchMin || 0) / prebatchYield(drink);
  return (prebatchPerServe + (pt.perServeMin || 0)) * cfg.labourRatePerMin;
}

/** The serving volume used for catalogue markup — the first priced format's
 *  volume, else the first format, else 0. */
function catalogueServeVolMl(drink: Drink, loc: string): number {
  const fmts = drink.formats || [];
  const priced = fmts.find(f => f.price?.[loc] != null) || fmts[0];
  return priced?.volumeMl || 0;
}

/** Total ex-BTW cost of one serve-equivalent:
 *   - served recipe: ingredient (per-serve rows) + labour
 *   - building block: cost per litre (costPerMl × 1000) — it isn't "served"
 *   - catalogue: costPerMl × the serve format's volume (for markup) */
export function drinkTotalCostExBtw(drink: Drink, ctx: CostContext, loc = 'west'): number {
  if (drink.mode === 'catalogue') {
    return drinkCostPerMl(drink, ctx) * catalogueServeVolMl(drink, loc);
  }
  if (drink.category === 'building-block') {
    return drinkCostPerMl(drink, ctx) * 1000; // €/L
  }
  return rowsCost(drink.ingredientRows, ctx) + labourPerServe(drink, ctx.cfg);
}

/** Bottles a batch yields = batch.volumeMl ÷ bottleSizeMl (0 if not derivable). */
export function yieldBottles(drink: Drink): number {
  const b = drink.batch;
  if (!b || !b.volumeMl || !b.bottleSizeMl || b.bottleSizeMl <= 0) return 0;
  return b.volumeMl / b.bottleSizeMl;
}

/** Target markup multiple for a category: the per-category target if set
 *  (>0), else the config default multiple. */
export function targetMarkupFor(category: string, cfg: DrinkConfig): number {
  const t = cfg.markupTargets[category];
  return (typeof t === 'number' && t > 0) ? t : cfg.markupTargets.defaultMultiple;
}

/** Effective BTW rate: explicit override wins, else auto from ABV via the config rule. */
export function effectiveBtw(abv: number, btwRate: number | null, cfg: DrinkConfig): number {
  if (btwRate != null) return btwRate;
  return abv >= cfg.btwRule.alcoholicAbvThreshold ? cfg.btwRule.alcoholic : cfg.btwRule.nonAlcoholic;
}

/** Round to the nearest step (e.g. €0.10). */
export function roundToStep(value: number, step: number): number {
  if (!step || step <= 0) return value;
  return Math.round(value / step) * step;
}

/** Suggested incl-BTW price = totalCostExBtw × targetMarkup, grossed up by BTW,
 *  rounded to the config's price-rounding step (€0.10). */
export function suggestedPriceInclBtw(totalCostExBtw: number, btwRate: number, targetMult: number, cfg: DrinkConfig): number {
  if (totalCostExBtw <= 0) return 0;
  const exBtw = totalCostExBtw * targetMult;
  const inclBtw = exBtw * (1 + btwRate / 100);
  return roundToStep(inclBtw, cfg.priceRounding);
}

/** Actual markup = price_exBTW ÷ totalCostExBtw, or null if cost unknown. */
export function actualMarkup(priceInclBtw: number | null | undefined, btwRate: number, totalCostExBtw: number): number | null {
  if (priceInclBtw == null || totalCostExBtw <= 0) return null;
  const priceExBtw = priceInclBtw / (1 + btwRate / 100);
  return priceExBtw / totalCostExBtw;
}

export type MarkupLight = 'green' | 'amber' | 'red' | 'none';

/** Traffic-light vs the category target: green within ±10%, amber outside the
 *  band on the high side (pricey), red below target (under-priced). */
export function markupLight(actual: number | null, target: number): MarkupLight {
  if (actual == null || !target) return 'none';
  const lower = target * 0.9;
  const upper = target * 1.1;
  if (actual < lower) return 'red';      // under-priced vs target
  if (actual > upper) return 'amber';    // over-priced (pricey) vs target
  return 'green';
}
