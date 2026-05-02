// ─────────────────────────────────────────────────────────────────────────────
// SHARED UNIT CONVERSION
//
// Canonical implementation of unit → base-unit conversion. Three duplicates
// were drifting:
//   - lib/db.ts toGrams (backend, lowercased switch)
//   - public/js/recipe-editor.ts toGrams (frontend, case-sensitive — broken
//     for "kg" / "L" inputs)
//   - public/js/orders.ts toBaseUnit (frontend, most lenient — apostrophes
//     stripped, broadest accepted forms)
//
// This module is the single source of truth. Lenient on input casing /
// apostrophes / typographic variants ("kilo's", "kilos", "Kg" all → ×1000).
// ─────────────────────────────────────────────────────────────────────────────

/** Convert an amount in any common unit to grams (or millilitres for liquids).
 *  We treat 1 L ≈ 1000 g — the planner doesn't distinguish ml from g for the
 *  cost / nutrition calculations the codebase does today. */
export function toGrams(amount: number, unit: string): number {
  const u = (unit || '').toLowerCase().replace(/'/g, '').replace(/[`’]/g, '').trim();
  if (u === 'kilos' || u === 'kilo' || u === 'kg' || u === 'kgs') return amount * 1000;
  if (u === 'liters' || u === 'liter' || u === 'litres' || u === 'litre' || u === 'l') return amount * 1000;
  // 'ml', 'g', 'grams', 'gram', '' (default), pieces — leave amount as-is.
  return amount;
}

/** Returns the canonical base-unit string ('g' | 'ml' | original) so callers
 *  can label normalized totals correctly. */
export function baseUnitOf(unit: string): string {
  const u = (unit || '').toLowerCase().replace(/'/g, '').replace(/[`’]/g, '').trim();
  if (u === 'kilos' || u === 'kilo' || u === 'kg' || u === 'kgs' || u === 'grams' || u === 'gram' || u === 'g') return 'g';
  if (u === 'liters' || u === 'liter' || u === 'litres' || u === 'litre' || u === 'l' || u === 'ml') return 'ml';
  return unit || 'g';
}
