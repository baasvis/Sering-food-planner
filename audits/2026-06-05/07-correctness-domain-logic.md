# Correctness & Domain Logic

## Scope of review

This pass audited domain-logic correctness across batch deletion/stock invariants, ingredient stock deduction, supply/closed-service demand, inventory consolidation, West-reachability gating, recipe cost/nutrition unit handling, and recipe-replacement cook dates. Findings are sorted by adjusted severity.

## Findings

### CORR-1 — Patch-path batch delete (dbDeleteBatchIds) has no stock guard — bypasses the cannot-delete-with-stock invariant

**STATUS: FIXED 2026-06-05 — added exported `batchRowHasStock()` guard in `lib/db.ts` `dbDeleteBatchIds` (mirrors the `DELETE /api/batches/:id` invariant; skips stock-bearing ids on the patch path) + `test/batch-delete-guard.test.ts` (7 unit tests). Full Jest suite (582 tests) green.**

- **Severity**: High
- **Location**: lib/db.ts:602-606 (dbDeleteBatchIds) vs routes/batches.ts:123-142 (DELETE guard)
- **What**: dbDeleteBatchIds() runs prisma.batch.deleteMany with no inventory/shipment check, so a batch with real stock or pending shipments can be permanently deleted through POST /api/data/patch (deletedBatches), unlike the DELETE /api/batches/:id endpoint which refuses.
- **Why it matters**: The single most important unified-batch invariant ('cannot delete a batch with real food') is enforced on only one of two delete paths. Any client (or future code path) that routes a stocked batch id through deletedBatches destroys the food record with no server-side rejection — exactly the 'batch with food disappeared' class the 2026-05-16 report tried to close. Today the replace/delete UI guards with isBatchCooked, so it is latent, not actively exploited, but it is one missing UI check away from data loss.
- **Suggested fix**: In dbDeleteBatchIds, load the rows first and skip/throw for any whose inventory qty sum > 0 or whose shipments have a non-arrived entry — mirror the guard in routes/batches.ts DELETE so both delete paths enforce the same invariant.
- **Confidence**: High.
- **Verified**:

  lib/db.ts:602-606:
    export async function dbDeleteBatchIds(ids: string[]): Promise<void> {
      if (ids.length > 0) {
        await prisma.batch.deleteMany({ where: { id: { in: ids } } });
      }
    }

  routes/data.ts:82-84 (inside withWriteLock, no stock check):
    if (deletedBatches && deletedBatches.length) {
      await dbDeleteBatchIds(deletedBatches);
    }

  routes/batches.ts:128-134 (guard that exists ONLY on the DELETE /api/batches/:id path):
    const totalQty = inv.reduce((s, e) => s + (typeof e.qty === 'number' ? e.qty : 0), 0);
    const pendingShipmentQty = parseShipments(existing.shipments)
      .filter(s => !s.arrived)
      .reduce((sum, sh) => sum + (typeof sh.qty === 'number' ? sh.qty : 0), 0);
    if (totalQty > 0 || pendingShipmentQty > 0) {
      throw new AppError(400, 'Cannot delete batch with stock or pending shipments > 0');
    }
- **Reviewer notes**: The claim is literally true. The patch endpoint (POST /api/data/patch) routes deletedBatches through dbDeleteBatchIds which issues a bare deleteMany with zero inventory/shipment checking. The only stock guard in the codebase for batch deletion is in routes/batches.ts on the DELETE /api/batches/:id path. Any authenticated client can bypass it by sending IDs via the patch endpoint. Severity High is appropriate: it is a latent but real gap in a critical invariant — the only current mitigation is that the frontend happens to guard with isBatchCooked before populating deletedBatches, which is a UI-layer check rather than a server-side invariant.

### CORR-2 — Ingredient stock can be double-deducted: stockDeducted is written but never read as a guard

**STATUS: FIXED 2026-06-05 — new pure `resolveStockDeduction()` in public/js/recipe-editor.ts (used by brSave): deduct only when `batch.stockDeducted` is not already set; `stockDeducted` is now sticky (never regresses to false on an unticked save); the deduct checkbox is disabled + relabelled once a batch is deducted. Tests: test/data-integrity-pr1.test.ts.**

- **Severity**: Medium
- **Location**: public/js/recipe-editor.ts:1672-1675 (brToggleDeduct), 1684-1762 (brSave), 1704/1726 (stockDeducted set, never checked)
- **What**: brSave() deducts ingredient stock whenever br.deductStock is true, with no check of batch.stockDeducted, so re-opening an already-cooked batch's recipe (openPostCookRecording/openResolveFlexible) and re-ticking 'deduct stock' subtracts the full recipe amount from ingredient stock a second time.
- **Why it matters**: Ingredient stock is the basis for the order screen; a silent double-deduction makes the planner under-report on-hand ingredients and over-order. The stockDeducted flag exists precisely to record that deduction already happened, but nothing consults it, so the safeguard is inert. The checkbox resetting to false on open mitigates the common case but not a deliberate re-tick.
- **Suggested fix**: Before deducting in brSave, short-circuit (or warn) when batch.stockDeducted is already true; or disable the deduct checkbox in renderBatchRecipe when batch.stockDeducted is true.
- **Confidence**: Medium.
- **Verified**:

  In public/js/recipe-editor.ts:

  Line 1317: `deductStock: false,` — always initialized to false on open, ignoring `batch.stockDeducted`.

  Line 1539: `<input type="checkbox" ${br.deductStock ? 'checked' : ''} onchange="brToggleDeduct(this.checked)" />` — renders solely from `br.deductStock`, no reference to `batch.stockDeducted`.

  Line 1704: `stockDeducted: br.deductStock,` — patch unconditionally overwrites `stockDeducted` with the current checkbox state. If the user opens the editor and saves without ticking, this resets a previously-true `stockDeducted` back to false, making the flag unreliable as a guard.

  Line 1732: `if (br.deductStock) { ... deduct stock ... }` — deduction fires with no check of `batch.stockDeducted`.

  There is no server-side guard in routes/batches.ts either (confirmed by grep returning no matches for `stockDeducted` in that file). The `stockDeducted` field exists in the schema (prisma/schema.prisma:25) and is read/written by lib/db.ts:315/364, but nothing in the save path consults it before deducting.
- **Reviewer notes**: The "default to false on open" behavior mitigates accidental double-deduction in the common case — a user who saves without ticking the checkbox will not re-deduct. However, the additional side effect that every save unconditionally overwrites stockDeducted with the checkbox state means the flag is actively corrupted: re-opening a batch that had stockDeducted=true and saving without ticking resets it to false, making the DB field worthless as an audit trail. The fix is twofold: (1) disable or warn on the checkbox when batch.stockDeducted is already true; (2) guard in brSave before deducting when batch.stockDeducted is already true.

### CORR-3 — Supply (toppings/bread) forward demand ignores closed services, so it over-orders for closed days

- **Severity**: Low
- **Location**: shared/supply-demand.ts:78-101 (computeSupplyDemand) vs public/js/core.ts:455-509 (buildRollMap/getEffectiveGuests)
- **What**: computeSupplyDemand sums guests[loc][dn] for every day in the horizon with no isServiceClosed check, while the batch demand engine zeroes closed slots and rolls their guests onto the previous open service — so on a closed day the supply demand still counts that day's full guest count.
- **Why it matters**: The two demand engines disagree about closed days: cooking litres correctly drop a closed service to 0, but bread/topping 'need ~N' over-counts it (and the rolled-onto open day is not credited either). Cooks ordering supplies off the inventory hint will over-prep for days the kitchen is shut. Lower impact than batch demand because it only affects supply quantities, not food cooked.
- **Suggested fix**: Pass closedServices into computeSupplyDemand (or have it consume getEffectiveGuests-style rolled guests) so closed-day supply demand rolls in lockstep with batch demand.
- **Confidence**: Medium.
- **Verified**: shared/supply-demand.ts:64-89 — computeSupplyDemand signature is (supply, guests: GuestsData, caterings, today) with no closedServices parameter. The inner loop at lines 78-89 iterates every day in the horizon and reads guests[loc][dn] where dn = dayName(d) (a day-of-week abbreviation) with zero isServiceClosed check. There is no import of isServiceClosed, no roll-map lookup, and no closed-service mitigation anywhere in the file (grep confirmed zero matches for "isServiceClosed", "closedServices", "isClosed", "rollMap"). By contrast, core.ts:getEffectiveGuests (line 506-509) explicitly returns 0 for closed slots and adds rolled-in demand from _rollMap, and buildRollMap (line 455+) is called at the top of recomputeBatchAllocations. The two demand engines are structurally disconnected: batch cooking demand honours closed services; supply (bread/toppings) demand does not.
- **Reviewer notes**: Severity Low is correctly calibrated. This only affects the "need ~N" hint shown on the Supplies card/planner inventory panel and the prep checklist quantity. It over-counts on closed days and does not credit the rolled-onto open day, so cooks may prep slightly too much supply on open days adjacent to a closed service. It does not affect food volume cooked, batch assignment, or ordering quantities sent to suppliers. The fix described in the claim (pass closedServices into computeSupplyDemand or give it a getEffectiveGuests-equivalent) is accurate, but note the GuestsData type uses day-of-week keys not ISO dates, so the fix also needs the specific ISO date per iteration — the loop already has iso available (line 81), it just needs a closedServices lookup threaded in.

### CORR-4 — S.deletedBatches is written by menu-fixer/replace but never read by the save path (dead tombstone list)

- **Severity**: Low
- **Location**: public/js/menu-fixer.ts:1202-1203,1221-1222 and public/js/planner.ts:1094-1095,1166-1167 (writes); public/js/utils.ts:118-161 (computePatch never reads it)
- **What**: computePatch() derives deletedBatches solely by diffing the _lastSaved snapshot against S.batches and never reads S.deletedBatches, so every push to S.deletedBatches is dead code.
- **Why it matters**: Deletions still propagate (via the snapshot diff), so there is no live bug today — but the redundant list is a trap: a future change that starts trusting S.deletedBatches (or that mutates S.batches without leaving the snapshot to diff) would behave inconsistently, and it obscures the single real delete-diff mechanism. It also accumulates ids that are never cleared after a save.
- **Suggested fix**: Remove the S.deletedBatches writes and the field from AppState, or wire computePatch to consume and clear it — but pick one source of truth (the snapshot diff is sufficient).
- **Confidence**: High.
- **Verified**:

  In utils.ts lines 118-133, computePatch() derives deletedBatches purely by diffing _lastSaved.batches against S.batches:

  ```
  for (const [id] of _lastSaved.batches) {
      if (!curBatchIds.has(id)) patch.deletedBatches!.push(id);
  }
  ```

  It never reads S.deletedBatches at all. Meanwhile, menu-fixer.ts lines 1202-1203 and 1221-1222, and planner.ts lines 1094-1095 and 1166-1167, all write to S.deletedBatches:

  ```
  if (!S.deletedBatches) S.deletedBatches = [];
  S.deletedBatches.push(old.id);  // or orphanIds / retireIds
  ```

  The deletedBatches field in AppState (state.ts line 200: `deletedBatches?: string[]`) is populated but never consumed by computePatch(). Deletions do propagate correctly via the snapshot diff, so there is no live data-loss bug. The claim is accurate.
- **Reviewer notes**: The finding is confirmed. S.deletedBatches is written in four places but computePatch() never reads it — it uses the _lastSaved snapshot diff instead. The patch.deletedBatches field (a PatchRequest field, distinct from S.deletedBatches) is correctly used in doSave(). Severity Low is appropriate: deletions work correctly today via the snapshot diff, but the dead writes obscure the real mechanism and could mislead future maintainers into trusting S.deletedBatches as authoritative.

### CORR-5 — Inventory storage cycling does not consolidate entries, leaving duplicate (loc,storage,cookDate) inventory rows

- **Severity**: Low
- **Location**: public/js/planner.ts:1676-1695 (cycleInventoryStorageAt), 1699-1713 (cycleEntryStorageAt)
- **What**: After flipping an entry's storage (and resetting cookDate to today on Gastro<->Frozen), neither cycle handler calls consolidateInventory, so cycling a Gastro entry to Frozen when a Frozen entry already exists at the same (loc, cookDate=today) produces two separate Frozen entries that the merge key would otherwise combine.
- **Why it matters**: Server /transfer and addInventory keep inventory[] canonical via the (loc,storage,cookDate) merge key; these client-side cycle paths break that invariant, leaving fragmented entries. getTotalStock still sums correctly so no quantity is lost, but the duplicate rows can confuse the Do-inventory modal's index-based qty editing (the stale-index class the 2026-05-16 report flagged) and any code that assumes one entry per key.
- **Suggested fix**: Call consolidateInventory(d) after mutating storage in both cycle handlers, matching addInventory/mergeIntoInventory.
- **Confidence**: High.
- **Verified**: In public/js/core.ts lines 102-120, `consolidateInventory` deduplicates by `(loc, storage, cookDate)` key, and `addInventory` calls it after every push. In public/js/planner.ts lines 1676-1695 (`cycleInventoryStorageAt`) and 1699-1713 (`cycleEntryStorageAt`), the storage field (and conditionally cookDate) is mutated in-place but neither function calls `consolidateInventory`. The planner.ts import on line 5 brings in `addInventory` from core.ts but not `consolidateInventory`, confirming the omission. If a Gastro entry is cycled to Frozen and a Frozen entry already exists at the same `(loc, cookDate=today)`, the result is two separate Frozen rows rather than one consolidated row.
- **Reviewer notes**: The claim is accurate as written. The severity calibration of Low is appropriate: `getTotalStock` sums all entries so no quantity is lost, but the fragmented inventory array can confuse index-based editing in the Do-inventory modal (power view) and violates the invariant maintained by the server-side `/transfer` and client-side `addInventory` paths. The fix is straightforward: import `consolidateInventory` from core.ts and call it on `d` after the mutation loop in both cycle handlers.

### CORR-6 — calcRequiredAtLocLive omits catering demand while the West-reachability gate it feeds is reasoned about as total demand

- **Severity**: Low
- **Location**: public/js/core.ts:639-656 (calcRequiredAtLocLive, no cateringDemand) and public/js/menu-fixer.ts:1107-1110 (findCombinationTeam West branch)
- **What**: calcRequiredAtLocLive computes per-location service demand with no catering term, so the West-team capacity check in findCombinationTeam compares West service demand (catering-excluded) against West serveable stock without charging any catering load to West stock.
- **Why it matters**: Catering demand is not location-tagged, so excluding it is defensible, but it makes the fallback team's West-reachability check inconsistent with scoredHardConstraintsOk's West gate, which derives westDemand from calcReq (catering included, then differenced out). A batch heavily committed to West-dispatched catering could pass the fallback West-capacity check while genuinely lacking West stock to cover both the service share and the catering it is pinned to.
- **Suggested fix**: Either fold the West-attributable catering share into calcRequiredAtLocLive, or document that catering is intentionally treated as non-West-constrained and confirm scoredHardConstraintsOk and findCombinationTeam agree on that treatment.
- **Confidence**: Low.
- **Verified**:

  In scoredHardConstraintsOk (menu-fixer.ts:672-679):
    const totalDemand = calcReq(batch);          // includes cateringDemand
    batch.services = withNew.filter(s => s.loc !== 'west');
    const nonWestDemand = calcReq(batch);        // includes cateringDemand (catering has no loc)
    batch.services = withNew;
    const westDemand = Math.round((totalDemand - nonWestDemand) * 10) / 10;
    // => catering IS charged to West here (totalDemand-nonWestDemand includes catering delta=0 so catering stays in westDemand)

  In findCombinationTeam West branch (menu-fixer.ts:1107-1110):
    if (loc === 'west') {
      const westStock = getServeableStockAt(cand, 'west');
      if (westStock <= 0) continue;
      if (calcRequiredAtLocLive(cand, 'west', getGuestsFn) + shareLitersAtThisSlot > westStock) continue;
    }
  // calcRequiredAtLocLive (core.ts:639-656) sums only services where svc.loc === loc — no catering term at all.

  The docstring on calcRequiredAtLocLive (core.ts:633-638) explicitly says "catering excluded (it isn't location-tagged)" confirming the intentional omission. scoredHardConstraintsOk attributes all catering to West via the difference method; findCombinationTeam charges zero catering to West — the two gates disagree on catering treatment.
- **Reviewer notes**: The discrepancy is real and confirmed in the code. The severity is Low because: (1) catering jobs are relatively rare and typically not large enough to tip a batch over West capacity; (2) the scoredHardConstraintsOk path runs first and is the primary gating path — findCombinationTeam is only reached for slots no single batch can cover alone; (3) in practice a batch committed to catering is unlikely to simultaneously be pushed through findCombinationTeam's West team-fill path. The docstring on calcRequiredAtLocLive documents the intentional omission but does not acknowledge the inconsistency with scoredHardConstraintsOk. The proposed fix (document that catering is non-West-constrained and align scoredHardConstraintsOk) is reasonable.

### CORR-7 — Recipe cost/nutrition treats piece-measured ingredient amounts as grams (toGrams passes pieces through unchanged)

- **Severity**: Low
- **Location**: shared/units.ts:19-25 (toGrams) used by lib/db.ts:834,907,948 (calcRecipeCost/calcRecipeNutrition/hydrateRecipeForDetail)
- **What**: toGrams returns the amount unchanged for 'pieces'/'stuks'/'' units, so a recipe ingredient like '6 eggs' contributes (6/100)*pricePer100 to cost and (6/100)*nutrition-per-100g — i.e. 6 grams — rather than its real weight.
- **Why it matters**: For any recipe ingredient measured in pieces and linked to a per-100g priced ingredient, both costPerServing and the nutrition panel are silently wrong (under-counted by the piece weight). This is a pre-existing simplification documented in units.ts, but it directly undermines the new cost-per-guest steering the dashboard now surfaces.
- **Suggested fix**: When unit is pieces, multiply by the ingredient's grams-per-piece (orderUnitSize where it represents piece weight) before costing/nutrition, or exclude piece ingredients from completeness and flag them, rather than counting them as grams.
- **Confidence**: Medium.
- **Verified**:

  shared/units.ts line 23-24:
  // 'ml', 'g', 'grams', 'gram', '' (default), pieces — leave amount as-is.
  return amount;

  lib/db.ts line 834: const amountGrams = toGrams(ing.rawAmount, ing.unit);
  lib/db.ts line 843: totalCost += (amountGrams / 100) * pricePer100;
  lib/db.ts line 907: const amountGrams = toGrams(ing.rawAmount, ing.unit);
  lib/db.ts line 914: totalCost += (amountGrams / 100) * pricePer100;
  lib/db.ts line 948: const amountGrams = toGrams(ing.rawAmount, ing.unit);
  lib/db.ts line 949: const factor = amountGrams / 100; // nutrition is per 100g

  orderUnitSize is never referenced in any of the three cost/nutrition loops — it is only used for order-quantity display and pricePer100 derivation.
- **Reviewer notes**: The finding is literally correct: toGrams passes piece/stuks/empty-unit amounts through unchanged, so a recipe ingredient of "6 eggs" with unit "pieces" is treated as 6 grams in all cost and nutrition math. The comment in units.ts explicitly acknowledges this. No mitigation or workaround exists in the cost/nutrition paths. The Low severity is appropriate — this is a documented simplification that affects any ingredient priced per-100g and measured in pieces (e.g. eggs, cans), but many such ingredients in practice may have their unit left as grams or have pricing set in a way that partially compensates. The new cost-per-guest dashboard feature described in memory does increase the practical impact slightly.

### CORR-8 — replaceWithV2Recipe copies the old batch's (possibly past) cookDate onto a brand-new, never-cooked replacement

- **Severity**: Low
- **Location**: public/js/planner.ts:1115-1173 (replaceWithV2Recipe), 1146 (cookDate: old.cookDate || null)
- **What**: replaceWithV2Recipe creates the replacement with empty inventory but cookDate = old.cookDate, so if the old planned batch carried a cook date already in the past, the new uncooked batch is born with a stale past cookDate and zero stock.
- **Why it matters**: A non-generated batch with a past cookDate and no stock is an inconsistent state: it renders in the wrong cook grouping, and because findStalePlaceholders only retires generated batches, it is never auto-cleaned. isServableBy on a past cookDate also lets Fix-My-Menu reason about it oddly. Minor because replace is only offered for uncooked batches, but the cookDate carry-over is still incorrect for a fresh dish.
- **Suggested fix**: Only carry old.cookDate to the replacement when it is today or later; otherwise set cookDate to null (the cook sets it at confirm-cook time).
- **Confidence**: Medium.
- **Verified**:

  public/js/planner.ts line 1146: `cookDate: old.cookDate || null,`

  The guard at line 928 only blocks replacement of cooked batches:
  `if (isBatchCooked(old)) { toast('Cannot replace a cooked batch'); return; }`

  `isBatchCooked` (core.ts line 20–26) returns true only when `inventory.some(e => e.qty > 0)` or a pending shipment exists. A PLANNED batch with no stock but a past cookDate passes the guard, and its stale cookDate is copied verbatim onto the new batch.

  `findStalePlaceholders` (menu-fixer.ts line 214) explicitly skips non-generated batches: `if (b.generated !== true) return false;` — so the replacement batch (which has `generated: false`, line 1154) is never auto-retired.

  All three legs of the claim are verified: (1) unconditional cookDate copy at 1146, (2) guard does not prevent past-cookDate old batches from being replaced, (3) stale-placeholder cleanup never touches non-generated batches.
- **Reviewer notes**: The scenario is realistic: a planned batch can have a cookDate set when it was first scheduled (e.g., added via the planner day picker — line 904 sets cookDate at creation time), never cooked (so isBatchCooked=false), and then replaced. The new batch inherits the past date. Fix: `cookDate: (old.cookDate && old.cookDate >= todayIso()) ? old.cookDate : null` — only carry forward a present-or-future cook date.
