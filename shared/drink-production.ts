// ─────────────────────────────────────────────────────────────────────────────
// DRINKS — production & write-off helpers (pure, shared + unit-tested).
// Production of a recipe drink yields premix bottles / litres (stock ↑) and
// consumes building blocks (stock ↓). Write-offs reduce stock by a reason.
// See DRINKS_DOMAIN.md §5. (Phase-1 does not auto-deduct shared Ingredient-DB
// stock — that consumption is recorded on the log; see DECISIONS.md [m6].)
// ─────────────────────────────────────────────────────────────────────────────

import type { Drink } from './types';
import { yieldBottles, prebatchYield } from './drink-cost';

export function round2(n: number): number { return Math.round(n * 100) / 100; }

export interface ProducedUnits { qty: number; unit: 'bottle' | 'liter' }

/** Stock produced by making `batches` of a recipe drink:
 *  - bottles when the batch bottles up (batch.volumeMl ÷ bottleSizeMl)
 *  - litres otherwise (batch.volumeMl ÷ 1000). */
export function producedUnits(drink: Drink, batches: number): ProducedUnits {
  const perBatchBottles = yieldBottles(drink);
  if (perBatchBottles > 0) return { qty: round2(batches * perBatchBottles), unit: 'bottle' };
  const litres = (drink.batch?.volumeMl || 0) / 1000;
  return { qty: round2(batches * litres), unit: 'liter' };
}

/** Building-block litres consumed making `batches`. Row amounts are per-serve
 *  for served recipes (× prebatchYield serves/batch) and per-batch for blocks. */
export function consumedBuildingBlocks(drink: Drink, batches: number): Array<{ drinkId: string; liters: number }> {
  const isBlock = drink.category === 'building-block';
  const servingsPerBatch = isBlock ? 1 : prebatchYield(drink);
  const byBlock = new Map<string, number>();
  for (const r of drink.ingredientRows || []) {
    if (r.refKind !== 'drink' || !r.refDrinkId || r.amount == null) continue;
    const ml = r.amount * servingsPerBatch * batches;
    byBlock.set(r.refDrinkId, (byBlock.get(r.refDrinkId) || 0) + ml);
  }
  return [...byBlock.entries()].map(([drinkId, ml]) => ({ drinkId, liters: round2(ml / 1000) }));
}

/** Write-off reduces stock by qty (clamped to ≥ 0 at apply time). */
export function writeOffDelta(qty: number): number { return qty > 0 ? -qty : 0; }

/** Expiry date = madeOn + shelfLifeDays (ISO YYYY-MM-DD), or null if no shelf life. */
export function expiryDate(madeOnIso: string, shelfLifeDays: number | null | undefined): string | null {
  if (!shelfLifeDays || shelfLifeDays <= 0) return null;
  const d = new Date(madeOnIso + 'T00:00:00Z');
  if (isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + shelfLifeDays);
  return d.toISOString().slice(0, 10);
}
