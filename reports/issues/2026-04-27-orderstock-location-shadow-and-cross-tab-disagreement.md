# Orders: location-shadow & cross-tab disagreement in the per-session stock cushion

- **Date:** 2026-04-27
- **Reported by:** Daan
- **Severity:** Medium-high — quietly produced wrong "in stock" / "to order" numbers when switching locations or moving between Orders tabs
- **Surface:** Orders → Batch Ingredients & Combined Order tabs (Set Standard Inventory unaffected)

## Symptom

The Orders screen kept two separate in-memory scratchpads holding the user's last-typed stock values (`orderInventory` for Batch Ingredients, `combinedOrderStock` for Combined Order). Both were keyed only by lowercase ingredient name and never cleared on location switch.

That produced two real bugs:

1. **Location shadow.** Type stock for "Sunflower oil" at Sering West, switch to Centraal: the row at Centraal kept showing the West value because the in-memory map preferred its own (location-less) entry over the location-specific DB value.
2. **Cross-tab disagreement.** Type "5" on Batch Ingredients → switch to Combined Order, type "3" → switch back to Batch Ingredients: it still showed "5" because each tab read its own in-memory scratchpad.

Plus one minor consequence: SSE patches from coworkers updated the DB but were masked locally for any ingredient the user had touched in the current session, until reload.

## Why the scratchpads exist

Found the rationale via git history before changing anything:

- `e5a8a42` ("Fix stock persistence: save to DB, sync across tabs, survive reloads") added DB persistence *alongside* the in-memory stores. The stores were kept as a UX cushion.
- `43870a5` ("Stocktake empty-vs-zero") relies on `delete store[key]` (when the input is cleared) to distinguish "untouched" from "counted zero". Removing the store would re-introduce that bug.
- `7087c52` ("stock 0 counts as ordered") layered more logic on top of empty-vs-zero.

So the right move is to keep the cushion's behaviour, just fix how it's keyed.

## Fix

Single file changed: [`public/js/orders.ts`](public/js/orders.ts), with one one-line import update in [`public/js/main.ts`](public/js/main.ts).

1. **Merged the two stores into one** — `orderStock: Record<string, number>` ([orders.ts:90](public/js/orders.ts:90)). Both Batch Ingredients and Combined Order now read/write the same map, killing cross-tab disagreement.
2. **New key helper** `stockKey(db, ingName, loc)` ([orders.ts:171](public/js/orders.ts:171)). Returns `${db.id}:${loc}` for known ingredients (preferred) or `name:${lowercase}:${loc}` for orphans (recipe ingredients with no DB entry). Embedding `loc` kills the location shadow; keying by `id` fixes the related "onion" vs "onions" name-variant divergence.
3. **Rewrote 6 read sites** ([orders.ts:842, 977, 1080, 1248, 1283, 1340](public/js/orders.ts:842)) to derive their key via `stockKey()` and read from `orderStock`.
4. **Added two data attributes per row** (`data-row-key`, `data-ing-id`, `data-ing-name`) at [orders.ts:887](public/js/orders.ts:887) (Batch Ingredients) and [orders.ts:1118](public/js/orders.ts:1118) (Combined Order) so inline keystrokes can find their row without re-deriving the key.
5. **Collapsed `updateOrderStock` and `updateCombinedOrderStock`** into one `updateOrderStockInput(ingredientId, ingName, val)` ([orders.ts:1558](public/js/orders.ts:1558)). The inline `oninput` handlers in both tabs now call the same function. The two old names are kept as backward-compat shims so any cached HTML still works.
6. **Hanos collectors** (`collectHanosItems`, `hanosAddSingle`, `collectHanosBatchItems`) read the unified store via the same `stockKey()`, picking up `data-row-key` from the DOM row when present.

## What this preserves

- Empty input still does `delete orderStock[skey]` → row falls back to "enter stock →" placeholder. Empty-vs-zero distinction intact.
- Debounced 600ms DB save unchanged. Mid-typing values still survive a re-render because the in-memory store remembers them.
- Stocktake's separate `stocktakeValues` store is untouched.
- Set Standard Inventory tab's `updateSiStock` flow is untouched (already keyed by id + loc).

## Files changed

- [public/js/orders.ts](public/js/orders.ts) — main change (~50 lines net change spread across 8 sites + new helper)
- [public/js/main.ts](public/js/main.ts) — register `updateOrderStockInput` on `window` for the inline handler

## Verification

Live preview, dev-mode login, against the test DB at Centraal/West:

- **Cross-tab agreement.** Typed `7` for "Carrot (winterpeen)" on Batch Ingredients (West). Switched to Combined Order (still West) — same row showed `7`. Pre-fix: it showed whatever was in `combinedOrderStock`, often empty.
- **Location-shadow gone.** Typed `99` for "Flour (white)" at Centraal Combined Order. Switched to West Combined Order — row showed West's own value (`0`), not `99`. Verified the DB after: `stock.centraal.amount = 990000`, `stock.west.amount = 0`. Pre-fix: West would have shown `99` because the in-memory map ignored location.
- **No console errors** on the Orders screen under both tabs and during location switches.
- **Tests:** `npm test` → 98/98 passed (one flaky run hit an unrelated DB-race test that passed on retry).
- **Production build:** `vite build` clean. Bundle grew by ~600 bytes.
- **Test data restored** in the testing DB after verification.

## Out of scope (intentionally)

- The `currentStock >= target` early-exit for Standard Inventory items in Combined Order ([orders.ts:920](public/js/orders.ts:920)) — separate concern, not part of this bug.
- The total-value calc at [orders.ts:980](public/js/orders.ts:980) treating manual stock as base units while the row render treats it as order units. Pre-existing inconsistency, preserved as-is here. Worth fixing separately.
- Cleared-input semantics across reloads — clearing a value still writes 0 to the DB rather than deleting the entry, so reload surfaces it as "counted zero". This pre-dates the current fix and is not in scope.

## Watch for after deploy

- If anyone has the page open during deploy, the cached HTML might still emit the old `oninput="updateOrderStock(...)"` calls — the backward-compat shims I left in place handle that gracefully (they delegate into the new function with an empty `ingredientId`, falling back to name-based lookup).
- The Standard Inventory tab and stocktake should be unchanged. If they regress in any way, the change to `persistIngredientStock`'s call-site shape is the most likely culprit (it wasn't changed but the surrounding code was rearranged).
