// Per-100g price estimate for flexible ("open amount") recipe ingredients.
// A flexible slot has no pinned product, so its cost can't be looked up — it's
// estimated. Slots labelled "any vegetables" are priced higher than the
// generic flex default.
//
// Used by both the backend recipe-cost calc (lib/db.ts) and the frontend
// recipe editor's live cost preview (public/js/recipe-editor.ts) — keep this
// the single source of truth so the two never diverge.

const FLEX_PRICE_DEFAULT_PER_100G = 0.15;         // €1.50 / kg
const FLEX_PRICE_ANY_VEGETABLES_PER_100G = 0.175; // €1.75 / kg

/** Per-100g price for a flexible ingredient, keyed off its free-text label.
 *  Matches any label starting with "any vegetables" so labels that tack on a
 *  quantity — e.g. "Any vegetables (2.4 kg)" — are still recognised. */
export function flexPricePer100g(flexLabel: string | null | undefined): number {
  return (flexLabel || '').trim().toLowerCase().startsWith('any vegetables')
    ? FLEX_PRICE_ANY_VEGETABLES_PER_100G
    : FLEX_PRICE_DEFAULT_PER_100G;
}
