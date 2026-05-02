// ─────────────────────────────────────────────────────────────────────────────
// STOCKTAKE — shared persistence helper.
//
// Two stocktake UI shapes coexist by design: a full-screen renderer in
// orders.ts (used from the Orders tab — has the "to order" calculation column
// useful when actually placing an order) and a modal in dashboard.ts (used
// from the Dashboard chip — quick check without leaving the dashboard).
//
// Their renderers stay separate because the visual containers differ. But the
// persistence step is identical and was duplicated. This module owns that.
// ─────────────────────────────────────────────────────────────────────────────

import { S } from './state';
import { apiPost, toastError, toast } from './utils';
import type { Ingredient } from '@shared/types';

/** A stocktake-eligible ingredient is the runtime shape returned by
 *  getIngredientsForArea — Ingredient + a few computed fields. We only need
 *  id and orderUnitSize for the save step. */
interface StocktakeSaveItem {
  id: string;
  orderUnitSize: number;
}

/** Persist stocktake values for one area: convert per-item input value
 *  ("how many order-units do I see?") into a base-unit amount, send a single
 *  `stock/bulk` call, and update S.ingredientDb in memory so the UI reflects
 *  the new stock immediately. Returns the number of items saved (= number of
 *  items the user typed a value for; 0 = nothing to do).
 *
 *  `values[id]` is the user-typed value. `undefined` = not counted, skip.
 *  `0` = counted as zero — must be persisted. */
export async function saveStocktakeForArea(
  items: StocktakeSaveItem[],
  values: Record<string, number | undefined>,
  loc: string,
): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  const updates: Array<{ ingredientId: string; location: string; amount: number }> = [];

  items.forEach(ing => {
    const val = values[ing.id];
    if (val === undefined) return; // not touched — skip
    const baseAmount = ing.orderUnitSize > 0 ? val * ing.orderUnitSize : val;
    updates.push({ ingredientId: ing.id, location: loc, amount: baseAmount });
  });

  if (updates.length === 0) return 0;

  try {
    await apiPost('/api/ingredients/stock/bulk', updates);
  } catch (e: unknown) {
    toastError('Failed to save stock: ' + (e instanceof Error ? e.message : 'Unknown error'));
    throw e;
  }

  // Update both ingredient DB caches in memory so the order-related screens
  // pick up new stock without a refresh. (S13 will collapse these into one
  // source of truth.)
  updates.forEach(u => {
    const dbIng = (S.ingredientDb as Ingredient[]).find(i => i.id === u.ingredientId);
    if (dbIng) {
      if (!dbIng.stock) dbIng.stock = {} as Ingredient['stock'];
      (dbIng.stock as Record<string, { amount: number; date: string }>)[u.location] = {
        amount: u.amount,
        date: today,
      };
    }
  });

  return updates.length;
}

/** Convenience wrapper: save and toast the count. */
export async function saveStocktakeWithToast(
  areaName: string,
  items: StocktakeSaveItem[],
  values: Record<string, number | undefined>,
  loc: string,
): Promise<number> {
  const saved = await saveStocktakeForArea(items, values, loc);
  toast(`${areaName}: ${saved} items saved`);
  return saved;
}
