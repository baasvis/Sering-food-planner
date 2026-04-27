# Batch Ingredients tab: total "Needed" overcounts when batches use mixed units

- **Date:** 2026-04-27
- **Reported by:** Daan
- **Severity:** High — produced absurd order quantities (126x Jerrycan 20L of sunflower oil instead of 1)
- **Surface:** Orders screen → **Batch Ingredients** tab (per-location, e.g. Sering West)

## Symptom

On Orders → Batch Ingredients, the "Needed" total for an ingredient was wildly higher than the per-batch breakdown added up to.

Example from the live screenshot (Sering West):

| Ingredient | Needed (total) | Breakdown |
|---|---|---|
| Sunflower oil | **126x Jerrycan 20 liter** | 1x Jerrycan (Carrot, Celeriac…) + 1x Jerrycan (Harrissa and tom…) — visually 2 |
| Tomato puree | 2x Blik 4550 gram | 2x Blik 4550 gram (single batch) — correct |

User expected ~2 jerrycans for sunflower oil; got 126.

## Root cause

[`renderBatchIngredientTable` in `public/js/orders.ts`](public/js/orders.ts:716) summed each batch's ingredient `amount` as a raw number, ignoring per-batch units, and then converted the *sum* once using whichever unit the **first** batch happened to declare.

```ts
combined[key].amount += ing.amount;          // raw sum, ignored ing.unit
// later:
const amtInGrams = toBaseUnit(ing.amount, ing.unit);   // applied first batch's unit only
```

`calcIngredientsFromRecipe` ([`public/js/core.ts:220`](public/js/core.ts:220)) returns each ingredient with the unit declared in **its own recipe** — `"L"`, `"ml"`, `"kg"`, `"g"`, `"Grams"`, etc. Two batches can both reference "Sunflower oil" using different units. When that happened:

- Per-batch breakdown was correct (each row called `toBaseUnit(pb.amount, pb.unit)` individually at [orders.ts:850](public/js/orders.ts:850)).
- Total was wrong because the raw amounts were summed across heterogeneous units.

Worked example matching the screenshot:
- Batch A recipe: `1 L` sunflower oil
- Batch B recipe: `2500 ml` sunflower oil
- Old code: `combined.amount = 1 + 2500 = 2501`, unit `"L"` → `toBaseUnit(2501, "L") = 2_501_000` ml → `ceil(2_501_000 / 20_000) = 126` jerrycans.
- Correct: 1000 ml + 2500 ml = 3500 ml → `ceil(3500 / 20_000) = 1` jerrycan.

The Combined Order tab and the Set Standard Inventory tab were unaffected — Combined Order normalizes to base units before summing ([orders.ts:909](public/js/orders.ts:909) and [orders.ts:1635](public/js/orders.ts:1635)), and Standard Inventory only does per-ingredient (target − stock).

## Fix

Two-line behavioural change plus one helper, all in [`public/js/orders.ts`](public/js/orders.ts):

1. New helper `baseUnitOf(unit)` next to `toBaseUnit` — mirrors the numeric conversion on the unit-string side: returns `'g'` for kg/g, `'ml'` for L/ml, otherwise the unit unchanged.
2. In `renderBatchIngredientTable`'s aggregation loop, sum each batch's amount converted to base units (`toBaseUnit(ing.amount, ing.unit)`), and store the accumulator's unit as the normalized base unit (`baseUnitOf(ing.unit)`) so the later `toBaseUnit` at [orders.ts:741](public/js/orders.ts:741) is idempotent.
3. Per-batch entries (`combined[key].perBatch`) intentionally keep each batch's raw `amount` + `unit`, so the colored breakdown chips still render correctly.

## Files changed

- `public/js/orders.ts` (+11 / −2)

## Verification

- **Math reproduction (standalone Node):** with `[ {amount: 1, unit: "L"}, {amount: 2500, unit: "ml"} ]` and `orderUnitSize = 20000`:
  - Pre-fix logic → 126 jerrycans (matches the bug screenshot exactly).
  - Post-fix logic → 1 jerrycan.
  - Per-batch breakdown unchanged: 1 + 1 (visually 2). The breakdown's per-batch ceil is independent of the total ceil — out of scope here, see "Out of scope" below.
- **Single-batch regression (math):** tomato puree `9100 g` (single batch) → 2 bliks of 4550 g — same before and after.
- **Tests:** `npm test` → 98/98 passed (against `DATABASE_URL_TEST`).
- **Backend typecheck:** `npm run typecheck` → clean.
- **Frontend Vite build:** clean (the bare `tsc -p tsconfig.json` pre-existing errors in `recipes.ts`/`state.ts`/etc. are unrelated to this change).
- **Live UI verification:** preview server in this worktree was missing dev deps and didn't come up cleanly; the math verification above is sufficient because the bug is purely in pre-render aggregation, not DOM rendering. Worth a 30-second eyeball on production after deploy: open Sering West → Orders → Batch Ingredients and confirm sunflower oil shows ~1‑2 jerrycans instead of 126.

## Out of scope (logged for later if user wants)

- The "ceil per batch vs ceil of sum" rounding asymmetry remains: two batches each needing 0.4 bag will still display as `1x + 1x` in the breakdown but `1` in the total. This is a separate semantic question (how to present "round per batch" vs "round once") and not what was reported here.

## Watch for after deploy

- Combined Order tab totals for the same ingredients should not change — that tab was already correct. If something *does* change there, it's a different bug.
- If anyone has a recipe declaring an ingredient in an unrecognized unit (e.g. `"el"` for tablespoon, `"stuk"` for piece), `baseUnitOf` returns the unit unchanged, so behaviour matches pre-fix for that ingredient. No regression risk; just no new normalization.
