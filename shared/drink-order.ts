// ─────────────────────────────────────────────────────────────────────────────
// DRINKS — ordering helpers (pure, shared by the order generator + unit tests).
// Suggested order = par − stock per supplier; receiving applies received qty to
// stock. See DRINKS_DOMAIN.md §5.
// ─────────────────────────────────────────────────────────────────────────────

import type { Drink } from './types';

export interface OrderSuggestionLine {
  drinkId: string;
  name: string;
  orderUnit: string;
  par: number;
  stock: number;
  orderQty: number;
  deposit: number;
}

/** Suggested order quantity in whole order units to refill to par. Returns 0
 *  when par is unset/zero or stock already meets it. Fractional need rounds up
 *  (you order whole kegs/crates/bottles). */
export function suggestedOrderQty(par: number | null | undefined, stock: number): number {
  if (par == null || par <= 0) return 0;
  const need = par - (stock || 0);
  return need > 0 ? Math.ceil(need - 1e-9) : 0;
}

/** Suggested order lines for a supplier at a location: par − stock per active,
 *  non-archived drink of that supplier, positives only, sorted by name. */
export function buildOrderSuggestions(drinks: Drink[], supplier: string, location: string): OrderSuggestionLine[] {
  const out: OrderSuggestionLine[] = [];
  for (const d of drinks) {
    if (d.archived || d.supplier !== supplier) continue;
    const locInfo = d.locations?.[location];
    if (locInfo && locInfo.active === false) continue;
    const par = locInfo?.par ?? null;
    const stock = d.stockByLocation?.[location] ?? 0;
    const orderQty = suggestedOrderQty(par, stock);
    if (orderQty <= 0) continue;
    out.push({ drinkId: d.id, name: d.name, orderUnit: d.orderUnit || 'unit', par: par ?? 0, stock, orderQty, deposit: d.deposit || 0 });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Total deposit (€) for a set of order lines. */
export function orderDepositTotal(lines: Array<{ orderQty: number; deposit: number }>): number {
  return Math.round(lines.reduce((s, l) => s + l.orderQty * (l.deposit || 0), 0) * 100) / 100;
}

export interface ReceiveLineLike {
  drinkId: string | null;
  receivedQty: number | null;
  substitutedByDrinkId?: string | null;
}

/** Stock deltas to apply when an order is received: each line's receivedQty is
 *  added to its drink (or its substitute, if one was recorded). Positives only. */
export function receivedStockDeltas(lines: ReceiveLineLike[]): Array<{ drinkId: string; qty: number }> {
  const byDrink = new Map<string, number>();
  for (const l of lines) {
    if (l.receivedQty == null || l.receivedQty <= 0) continue;
    const target = l.substitutedByDrinkId || l.drinkId;
    if (!target) continue;
    byDrink.set(target, (byDrink.get(target) || 0) + l.receivedQty);
  }
  return [...byDrink.entries()].map(([drinkId, qty]) => ({ drinkId, qty }));
}

/**
 * Demand nudge: true when the upcoming week's total guests at a location exceed
 * the trailing baseline by more than thresholdPct. Used to suggest upping
 * par-driven order quantities (no auto-change). Inputs are already-summed totals.
 */
export function demandNudge(upcomingGuests: number, trailingAvgGuests: number, thresholdPct: number): boolean {
  if (trailingAvgGuests <= 0) return false;
  return (upcomingGuests - trailingAvgGuests) / trailingAvgGuests > thresholdPct / 100;
}
