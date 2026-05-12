# Unify Parent + Split into one Batch with per-location inventory

## Context

Today every batch is a single row with `location` + `stock` + `storage` + `inTransit` flags. When the cook makes 80L of Tom yum at West and sends 25L to Centraal, that's modelled as two separate rows (parent at West, child split at Centraal with `parentId`). The cook thinks of these as **one logical pot of food**. The mismatch breaks demand math, scoring, and capacity decisions across Fix My Menu and pack-for-Centraal — three previous fixes (PRs [#55](https://github.com/baasvis/Sering-food-planner/pull/55), [#57](https://github.com/baasvis/Sering-food-planner/pull/57), [#58](https://github.com/baasvis/Sering-food-planner/pull/58), plus an uncommitted drain pre-pass) chipped at the symptoms without resolving the model.

This plan replaces the parent/split rows with **one Batch row that owns a list of inventory entries (per loc + storage)** plus **a list of in-flight shipments**. Stock per location is first-class; family chain semantics disappear.

Why this is the right time: every "split-as-row" bug fix is now compounding complexity. We've validated the unified-model direction in three rounds of design discussion with Daan, and the storage-divergence and multi-shipment requirements are now clear.

## Decisions locked in (from discussion)

| Decision | Choice |
|---|---|
| Stock shape | Full inventory list `[{loc, storage, qty, cookDate}]` — multiple storages per loc allowed |
| Shipments | Separate `shipments[]` array (not status field on inventory) |
| In-transit count | Multiple shipments per batch allowed (8am + 1pm sends are common) |
| Cook confirm UX | Unchanged — confirm at one loc, one storage. Distribution happens later via "Send to ..." action |
| Edit modal | Normal view = single "where is it" + Transfer buttons; Power view = full inventory grid |
| List filter behaviour | "Centraal" filter shows batches with stock OR services at Centraal |
| Allergens | One list per batch (no per-loc overrides) |
| Stale-food | Per-inventory-entry `cookDate`; freezing resets it (freshness origin moves to freeze date) |
| Migration | One-shot collapse on deploy |
| PR strategy | Single big PR |
| Overship attempt | Auto-cap to available qty + toast warning |
| Finance cost | Per-batch total only (no per-loc split) |
| Planner slot badge | Two values: "X here + Y incoming" — show only non-zero side(s) |
| Mark arrived qty | No adjustment — full shipment qty arrives as-is; cook fixes discrepancy via Edit modal |
| Pack accumulate | Same-destination pending shipment accumulates (add qty to existing); separate batches still separate |
| Cancel shipment | Yes — explicit cancel button on pending shipments; returns qty to source inventory entry |
| Zero-qty entries | Keep — don't auto-prune; cook can manually remove via Edit modal |
| Phasing | Single PR with safety nets (maintenance banner + 503 during migration + force-reload on schema-version mismatch + DB snapshot) |
| Primary location | No `primaryLoc` field. Ingredient deduction uses `inventory[0].loc` (set at first confirmCooked, sticky). Other actions use `S.currentLoc` or explicit user choice. |
| Cross-batch same-recipe | Stay as separate batches/rows; cook can transfer between if needed. Today's behaviour preserved. |
| `stockDeducted` | Keep as single boolean on Batch. No per-entry split. |
| Deploy window | Coordinated in real-time with Daan when kitchen is quiet. |
| Shelf life | Gastro 3 days, Frozen 60 days, Vac-packed 10 days (from entry.cookDate) |
| Arrival merge rule | Merge if same `storage` AND same `cookDate`; else append as new entry |
| Cycle buttons | Delete both `cycleLocation` and `cycleStorage` — Transfer modal replaces them |
| Legacy v1 recipe paths | Delete in this PR — `searchNewDishModal`, `openNewDishScratch`, `refreshRecipe`, `GET /api/recipe?sheetId=`, and Batch fields `recipeSheetId`/`recipeVolume`/`recipeIngredients` |

## Schema (new shape)

### `shared/types.ts`

```typescript
export interface InventoryEntry {
  loc: Location;                   // 'west' | 'centraal'
  storage: Storage;                // 'Gastro' | 'Frozen' | 'Vac-packed'
  qty: number;                     // liters
  cookDate: string;                // DD/MM/YYYY — freshness origin (resets on freeze)
}

export interface Shipment {
  id: string;
  fromLoc: Location;
  toLoc: Location;
  storage: Storage;                // storage type during transit; default destination storage
  qty: number;
  sentAt: string;                  // ISO timestamp
  arrived: boolean;
  arrivedAt?: string;
  cookDate: string;                // carried from source inventory entry
}

export interface Batch {
  id: string;
  name: string;
  type: DishType;
  recipeId?: string | null;
  serving: number;
  cookDate?: string;               // primary cook date (= initial inventory entry cookDate)
  inventory: InventoryEntry[];     // settled stock, available to serve
  shipments: Shipment[];           // in-flight stock (NOT yet at destination)
  services: Service[];             // unchanged
  allergens: string[];
  extraAllergens: string[];
  note: string;
  cookNotes: string;
  actualIngredients: ActualIngredient[];
  orderFor: boolean;
  generated: boolean;              // Fix My Menu placeholder flag
  createdAt: string;
}
```

### Fields removed from `Batch`
- `parentId` — no more parent/split relation
- `location` — replaced by inventory entries
- `stock` — derived: `sum(inventory.qty)`
- `storage` — per-entry
- `inTransit` — replaced by `shipments[]`
- Legacy v1 fields: `recipeSheetId`, `recipeVolume`, `recipeIngredients` (drop in same migration — already unused)

### `prisma/schema.prisma`
- Add `inventory Json` and `shipments Json` columns
- Drop `parentId`, `location`, `stock`, `storage`, `inTransit` columns (after data migration completes)
- Drop the `parentId` index and `Batch.parentId` self-FK
- Migration name: `20260511_unified_batch_inventory`

## Migration (one-shot, runs in deploy migration)

Logic in the migration's `up.sql` + a Prisma `npx prisma migrate` data-massage script:

1. **Group batches by family root** — walk `parentId` chain (cycle-safe per existing `getRootId`)
2. **Pick canonical row** — root batch (oldest `createdAt`); if root deleted, oldest surviving member by `createdAt`
3. **Collapse inventory** — for each non-in-transit family member:
   - Append `{loc: m.location, storage: m.storage, qty: m.stock, cookDate: m.cookDate ?? canonical.cookDate}` to canonical's `inventory[]`
4. **Collapse shipments** — for each in-transit family member:
   - Append `{id: uuid(), fromLoc: <root.location or best guess>, toLoc: m.location, storage: m.storage, qty: m.stock, sentAt: m.createdAt, arrived: false, cookDate: m.cookDate}` to canonical's `shipments[]`
   - "Best guess" for `fromLoc`: opposite of `toLoc` (the only two locations)
5. **Union services** — canonical.services = union(all members' services) (deduplicate by `${loc}-${date}-${meal}`)
6. **Union allergens / extraAllergens** — union(arrays)
7. **Concat notes** — `[parent.note, child1.note, ...].filter(Boolean).join('\n')` (rare divergence)
8. **Update Catering refs** — any `Catering.dishes[].dishId` pointing at a deleted child rewrites to canonical id
9. **Delete child rows** — after canonical is updated
10. **Drop columns** — `parentId`, `location`, `stock`, `storage`, `inTransit`, legacy v1 fields

Implement as a TypeScript script (`prisma/migrations/20260511_unified_batch_inventory/data-migrate.ts`) callable from a `migration.sql` shim that runs `node`. Dry-run mode: print all proposed mutations to stdout without writing, run against staging first.

**Safety net:** before deploy, snapshot prod DB. If migration fails partway, restore from snapshot.

## Backend changes

### `routes/batches.ts`
- Drop `sanitizeParentId` (no more `parentId`)
- Update validators to require `inventory: InventoryEntry[]` and `shipments: Shipment[]`
- Default for new batches: `inventory: []`, `shipments: []`
- Add three new endpoints (each wrapped in `withWriteLock`, broadcasts via SSE):
  - `POST /api/batches/:id/ship` — body: `{toLoc, qty, storage?, fromInventoryIdx?}` → creates shipment + reduces inventory at source
  - `POST /api/batches/:id/shipments/:shipmentId/arrived` → flips `arrived=true`, merges qty into inventory at `toLoc` (matches by storage + cookDate, otherwise appends)
  - `POST /api/batches/:id/transfer` — body: `{fromLoc, fromStorage, toLoc, toStorage, qty}` → moves stock between inventory entries within same batch (used for freeze, thaw, redistribute)

### `lib/db.ts`
- Row transformer: parse `inventory`/`shipments` JSON
- Drop any logic referencing the dropped columns

### `routes/data.ts`
- `GET /api/data` returns the new shape (consumers updated in same PR)
- `POST /api/data/patch` validators updated

### `routes/events.ts`
- SSE shape unchanged (broadcast batch upserts) but payloads carry new shape

## Frontend changes

### `public/js/state.ts`
- `S.batches` typed with new `Batch` shape
- No new constants needed (`STORAGE`/`LOCATIONS` unchanged)

### `public/js/core.ts` (the heart of the rewrite)

Delete:
- `getRootId`, `getFamilyMembers`, `getFamilyStock`, `consolidateFamilies`, `recomputeFamilyAllocations` (family pool logic)

Add:
- `getTotalStock(b)` → `b.inventory.reduce((s,e)=>s+e.qty, 0)`
- `getStockAt(b, loc, storage?)` → filtered sum
- `getPendingFromShipments(b, loc)` → sum of `!arrived` shipments with `toLoc=loc`
- `consolidateInventory(b)` → merge entries with same `(loc, storage, cookDate)`
- `addInventory(b, entry)` / `removeInventory(b, idx)` mutation helpers
- `isStaleEntry(entry)` → uses `entry.cookDate` + `entry.storage` + per-storage shelf-life

Rewrite:
- `rebuildPlanner` — likely no change (already uses `service.loc`)
- `calcRequiredAtService(b, svc)` — simpler now: pure per-batch (peer share split across same-type batches at the slot)
- `calcRequired(b)` — sum over services, same as today but no family roll-up
- `calcRequiredBreakdown(b)` — same display, no family complications

### `public/js/dishes.ts`
- `renderBatchTile` — Normal view shows "Centraal: 25L Gastro" if filtered to Centraal, plus "West: 55L Gastro" badge; Power view shows full inventory grid
- `renderDishesOverview` — filter `(loc, storage)` looks at `getStockAt(b, loc, storage) > 0 || b.services.some(s => s.loc === loc)`
- `confirmCooked` — sets `inventory = [{loc: cookLoc, storage: 'Gastro', qty: calcRequired(b), cookDate: today}]`
- `openEditModal` — add inventory editor (normal + power modes), "Transfer" action button
- DELETE: `doSplit`, `renderSplitBar`, `renderFamilyGrouped` (replaced by inventory-aware rendering)
- Add: `openTransferModal(b)` — pick from-entry, to-loc/storage, qty
- Add: `openSendModal(b)` — pick from-entry, to-loc, qty → POST /ship

### `public/js/planner.ts`
- Transport tab: `S.batches.flatMap(b => b.shipments.filter(s => !s.arrived).map(s => ({batch: b, shipment: s})))`
- "Mark arrived" → POST `/api/batches/:id/shipments/:shipmentId/arrived`
- Delete `markSelectedArrived`'s `consolidateFamilies` call (no families)
- Service add/remove unchanged (services are on batch, not entry)

### `public/js/transport-card.ts` (Pack for Centraal)
- `computeTransportPlan` — same shape, but per-batch: `getStockAt(b, 'centraal')` replaces "scan split batches for centraal"
  - Lean / Bulk modes unchanged
- `confirmTransportPlan` — loop calls `sendTo(batchId, 'centraal', sendQty)` instead of `doSplit(true, 'centraal', true)`

### `public/js/menu-fixer.ts` (Fix My Menu)
Significant simplification because family-pool logic disappears:
- `scoredHardConstraintsOk` → per-batch capacity: `getTotalStock(b)` vs `calcRequired(b)` (no family pool override)
- The per-location stock check uses `getStockAt(b, loc) >= demandAtLoc` for "can this batch reasonably satisfy Centraal demand without overshipping"
- Drop `drainCentraalStockFirst` pre-pass (resolved structurally)
- Drop `forcedAssignmentPrePass` family-aware branches
- `CENTRAAL_STOCK_AT_CENTRAAL` scoring becomes the per-loc stock check inside scored constraints
- Auto-retire (PR #58): retire when `getTotalStock(b) === 0 && all services in past` (no per-member check)

### `public/js/dashboard.ts`
- `dish.location === f.loc` → `getStockAt(dish, f.loc) > 0 || dish.services.some(s => s.loc === f.loc)`

### `public/js/finance.ts`
- Cost tracking per location: split batch.cost weighted by inventory qty per loc (small change)

### Other files touching `b.location` / `b.parentId` / `b.inTransit` / `b.stock` / `b.storage`
- `init.ts`, `undo.ts`, `feedback.ts`: no batch logic, no change
- `orders.ts`: stocktake stays ingredient-aware; the "Batch ingredients" tab aggregation needs `getTotalStock`
- `feedback-admin.ts`, `telemetry.ts`: no change
- `recipe-editor.ts`: post-cook recording flow needs to set `inventory[0]` instead of `stock` + `location`

## UX flows (concrete)

### Confirming a cook
Same UI as today (`Mark cooked` button). Behind the scenes:
- Old: `b.stock = calcRequired(b); b.cookDate = today; b.location = currentLoc`
- New: `b.inventory = [{loc: currentLoc, storage: 'Gastro', qty: calcRequired(b), cookDate: today}]; b.cookDate = today`

### Sending stock from West to Centraal (pack flow unchanged from cook's POV)
- Old: each row → new child batch with `inTransit=true` at `location='centraal'`
- New: each row → POST `/api/batches/:id/ship` with `{toLoc: 'centraal', qty, storage: 'Gastro'}`; reduces source inventory entry; appends to `b.shipments`

### Marking arrived
- Old: select inTransit batches → flip `inTransit=false` → `consolidateFamilies()` merges duplicates
- New: select shipments → POST arrived → shipment.arrived=true → qty merges into inventory[loc=toLoc, storage, cookDate=match] (append if no match)

### Freezing leftover stock at the same location
- Open batch edit modal → Transfer → from West Gastro, to West Frozen, qty 20L
- Creates new entry `{loc:west, storage:Frozen, qty:20, cookDate:today}` (freshness reset)
- Reduces existing west-Gastro entry by 20

### Re-pack mid-day (8am + 1pm shipments)
- Each pack-and-send creates a new shipment record
- Transport tab shows both as separate rows (grouped by batch + sentAt)
- Mark arrived per shipment, not all-at-once

## Verification

Order matters — these gate each other.

1. **Unit tests** for new helpers: `getTotalStock`, `getStockAt`, `getPendingFromShipments`, `consolidateInventory`, `isStaleEntry`. Tests live in `test/inventory.test.ts` (new).
2. **Migration script** — run against staging DB (`shuttle.proxy.rlwy.net:52350`) first. Verify:
   - Same total batch count after migration as before, minus expected child collapses
   - Sum of all `inventory.qty` ≈ sum of old `stock` across all rows (allow rounding)
   - No catering.dishes references point to deleted batch ids
   - Spot-check 3 known parent+split families: collapsed inventory matches reality
3. **`npm test`** — passes (Jest unit tests). Update existing tests to use new shape.
4. **`npm run test:e2e`** — passes. Update specs if they reference old fields (`b.stock`, `b.location`).
5. **Preview server (`preview_start name: "preview"`)** — manual smoke:
   - Create batch → confirm cook at West → verify inventory entry
   - Pack-for-Centraal sends 25L → shipment appears in transport tab
   - Mark shipment arrived → 25L lands in centraal Gastro inventory
   - Run Fix My Menu → verify it doesn't over-extend stock at any location
   - Re-pack 10L more → second shipment appears, doesn't merge with first
   - Edit modal → transfer 20L West Gastro → West Frozen → two entries with different cookDate
6. **Live sync verification** — open two browser windows, do a send action in one, confirm SSE patches the other correctly
7. **Migration dry-run against prod snapshot** (separate scratch DB restored from prod backup) — no errors, output looks right

Manual sign-off before merging to `main`: walk through pack-for-Centraal with realistic data (use seeded staging DB) and confirm no over-shipping or under-shipping vs current behaviour.

## Risk register

| Risk | Mitigation |
|---|---|
| Migration data-loss / corruption | Dry-run on staging + prod snapshot; full DB backup taken before deploy; rollback plan = restore snapshot |
| Fix My Menu regressions | Capture current allocation output for 3 representative cook weeks (prod data export), re-run new algorithm, diff |
| In-flight SSE sessions get stuck on old shape | Bump `state.ts` schema version constant; frontend detects mismatch and force-reloads |
| Pack-for-Centraal silently changes suggestion quantities | Side-by-side comparison: old `computeTransportPlan` vs new on same input data; should be near-identical sendQty per row |
| Stale-food detection edge cases (freeze→thaw→re-freeze) | Document the rule "freezing resets cookDate to freeze date" in code comment + unit tests for the common transitions |
| Edit modal complexity (two modes) | Build Power mode first (more capable), Normal mode is a simplified view of the same data |

## Out of scope

- Renaming `Batch` to anything else (no value, lots of churn — file stays `dishes.ts`)
- Per-location allergen overrides (one list per batch, dropped historical divergence)
- Merge-back UI (vestigial, no longer needed — Transfer covers any move)
- Touching legacy v1 recipe import (those fields drop in this migration; v1 already sunset)
- Re-architecting transport for multi-leg trips (assumes binary west↔centraal forever)

## Critical files

| Path | What changes |
|---|---|
| [prisma/schema.prisma](prisma/schema.prisma) | Add `inventory` + `shipments` JSON cols; drop legacy cols |
| `prisma/migrations/20260511_unified_batch_inventory/` | New migration + data-migrate.ts script |
| [shared/types.ts](shared/types.ts) | `Batch` interface + new `InventoryEntry`, `Shipment` types |
| [routes/batches.ts](routes/batches.ts) | Validators + 3 new endpoints (ship, arrived, transfer); drop sanitizeParentId |
| [lib/db.ts](lib/db.ts) | Row transformers for new JSON cols |
| [public/js/core.ts](public/js/core.ts) | Delete family helpers; add inventory helpers; rewrite calcRequired |
| [public/js/dishes.ts](public/js/dishes.ts) | Rewrite tile + edit modal; delete doSplit/renderSplitBar/renderFamilyGrouped; add openSendModal + openTransferModal |
| [public/js/planner.ts](public/js/planner.ts) | Rewrite Transport tab to render shipments |
| [public/js/transport-card.ts](public/js/transport-card.ts) | Rewrite confirmTransportPlan to call /ship endpoint |
| [public/js/menu-fixer.ts](public/js/menu-fixer.ts) | Drop family-pool logic, drainCentraalStockFirst; simplify constraint checks |
| [public/js/dashboard.ts](public/js/dashboard.ts) | Update location filters to use getStockAt |
| [test/inventory.test.ts](test/inventory.test.ts) | New — helpers unit tests |
| Updated tests | [test/api.test.ts](test/api.test.ts), e2e specs that reference old Batch fields |

## Risk audit findings (from adversarial review)

A background risk-audit agent found ~40 issues. Headlines below; full list lives in this section.

### Showstoppers (gaps the plan didn't cover)

- **S1 — `stockDeducted` field:** `Batch.stockDeducted: boolean` exists today and is read/written by [public/js/recipe-editor.ts:1591](public/js/recipe-editor.ts:1591) and [lib/db.ts:272](lib/db.ts:272). Decision needed: keep or migrate.
- **S2 — DELETE batch check:** [routes/batches.ts:105](routes/batches.ts:105) rejects when `stock > 0`. Must become `getTotalStock(b) > 0`. Affects e2e specs.
- **S3 — `validateBatch`:** [lib/db.ts:37-58](lib/db.ts:37) hardcodes `stock`, `serving`, `storage`, `location`, `inTransit`. Every save fails until rewritten.
- **S4 — SSE stale-shape:** `applyRemotePatch` in [public/js/utils.ts:606-612](public/js/utils.ts:606) does wholesale merge. Stale tab during deploy = silent zombie fields. Must add schema-version field on Batch + force-reload on mismatch.
- **S5 — `dbUpsertBatches`:** [lib/db.ts:473-537](lib/db.ts:473) sorts and retries by parentId FK. Central save path — must be rewritten cleanly.
- **S6 — Catering double-counting:** Today caterings can reference both parent.id AND split.id (two refs = two peers = half demand each). After migration both rewrite to canonical = still two peers (wrong). Migration step must dedup `Catering.dishes` by `dishId`.
- **S7 — Cross-batch duplicates of same recipe:** Today's `consolidateFamilies` only merges same-family. Two unrelated cook events of "Tomato Soup West" still produce two batches. Today the family allocator handled this via peer-share; in the new model `consolidateInventory` merges *within* a batch only. Algorithm needs to handle "multiple batches of same recipe at same loc" via per-batch peer-share, not consolidation.
- **S8 — `consolidateFamilies` call sites:** Called from 4 different flows ([core.ts:706](public/js/core.ts:706), [dishes.ts:675](public/js/dishes.ts:675), [planner.ts:540](public/js/planner.ts:540), [menu-fixer.ts:1825](public/js/menu-fixer.ts:1825)) — each with different post-processing. Find-and-replace alone leaves dead code paths.
- **S9, S11 — Inventory modal at [planner.ts:1144-1212](public/js/planner.ts:1144):** This is the cook's most-used button ("Do inventory 13:45"). It filters by `b.location === loc` and edits `b.stock` directly. Today it shows one row per batch; in the new model each batch may have multiple inventory entries. Modal needs full redesign.
- **S12 — Pack-for-Centraal cross-batch dedup:** [transport-card.ts:259-296](public/js/transport-card.ts:259) uses `dishIdentity` to dedup destination stock across all West batches of same recipe. Still works conceptually in new model, but logic and tests need careful rewrite.
- **S13 — Catering refs when parent deleted:** Migration must rewrite refs from deleted-parent and deleted-children both to the canonical id; then dedup.
- **S14 — Production deploy timing:** Cooks active 7am–22:00. During `ALTER TABLE`, writes hang. Stale browser tabs send old-shape after migration → 400 silently. Must add maintenance banner + 503 during migration window + force-reload on schema-version mismatch.
- **S15 — `getRootId` cycle handling:** Stale parentId references (P2003 patterns in production logs) could yield cycles. Migration script should log any family with >5 members or visited-cycle and sanity-check before commit.
- **S16 — AI analyzer daily cron:** [lib/ai-analyzer.ts:44-60, 127-138](lib/ai-analyzer.ts:44) queries `prisma.batch.findMany({where: {stock: {gt: 0}, storage: {not: 'Frozen'}}})` — both fields gone. **Throws every day at 7am after deploy.** Must rewrite query + system prompt at [lib/ai-analyzer.ts:208-226](lib/ai-analyzer.ts:208) in the same PR.

### Hidden gotchas (40 items, summarised)

- **`cycleLocation` / `cycleStorage` / `chipClass(d.inTransit)` / `logisticsBadge`** all hang off the old shape — must delete or rewrite explicitly. Plan deleted family helpers but missed these.
- **`recipe-editor.ts:1597`** `computeStockDeductionUpdates(actualIngredients, batch.location, ...)` — what's "the batch's location" in the new model? Needs **primary location** rule defined.
- **`inlineEdit('stock')` / `inlineEdit('location')` / `updateInventoryStock`** all need rewrite for multi-entry inventory.
- **`renderMergedSameLocationTile`** at [dishes.ts:178-216](public/js/dishes.ts:178) — built for unmerged splits. New model: cross-recipe-id duplicates can still exist. Decide: merge by recipe identity, or accept duplicates.
- **AI analyzer prompt template** at [lib/ai-analyzer.ts:213](lib/ai-analyzer.ts:213) describes the old model — AI gives bad insights until updated.
- **`scripts/sync-prod-to-staging.js`, `scripts/seed-staging.js`** — both break on schema change. Update or `npm test` against staging breaks.
- **3 dead test files (`consolidate-families.test.ts`, `family-aware-demand.test.ts`, `family-aware-pass4.test.ts`)** — 33 tests to delete entirely.
- **`test/menu-fixer.test.ts` — ~114 tests** — every `makeBatch({location, stock, storage, ...})` factory call must be rewritten. ~25 hours estimate.
- **e2e specs** — `batch-cooked.spec.ts`, `batch-create.spec.ts`, `batch-assign-modal.spec.ts`, `batch-delete.spec.ts` all reference DOM `#nd-stock` input which goes away.
- **`recipe-editor.ts:1191`** `batchLiters = batch.stock || 0 ? batch.stock : recipeVolume` — batch recipe scaling.
- **`orders.ts:607,641,663,688,748,921,1154,1169,1199,1625,1659`** — heavy use of `b.location === curLoc` in the breakfast order brief (the morning supplier order tool). Wrong filter = wrong order list.
- **`legacy v1 recipe fields` (`recipeSheetId`, `recipeVolume`, `recipeIngredients`)** — plan said "drop in same migration" but the legacy `searchNewDishModal` / `openNewDishScratch` / `refreshRecipe` UX still calls `GET /api/recipe?sheetId=`. Need to verify these code paths are dead OR keep the endpoint and stop writing the fields to Batch.

### Revised cost estimate

- Frontend rewrite: ~1500 LOC touched across `dishes.ts` (1329 LOC), `menu-fixer.ts` (2652 LOC), `planner.ts` (1274 LOC), `transport-card.ts` (511 LOC)
- Test rewrites: ~25 hours alone
- Total: **40–60 hours of focused work**, not the "1-PR weekend" the original plan implied

### Strong audit recommendation: split into 3 phases

Instead of one big PR:
- **Phase 1** — Backend dual-write: add `inventory`/`shipments` JSON columns alongside the old columns, dual-write on POST/PATCH. Migrate data into the JSON cols. Deploy. Old code paths still work.
- **Phase 2** — Frontend rewrite: all batch consumers read new shape only. Deploy. Validates the new shape under load.
- **Phase 3** — Drop old columns after ~1 week of clean operation. Deploy.

Mitigates: migration-day risk, stale-tab silent failures, in-flight cook write loss, ability to roll back cleanly without snapshot restore.

## Remaining defaults (sensible — flagged here for visibility)

These were not explicitly asked but the plan needs a default to execute:

1. **Thaw cookDate behavior** — when stock moves from Frozen to Gastro at the same loc, the new Gastro entry's `cookDate = today` (the food is "as fresh as today" from a Gastro shelf-life perspective). If you want it to inherit the pre-freeze cookDate instead, flag it before coding.
2. **`generated:true` placeholder initial state** — empty `inventory: []`, empty `shipments: []`. Fix My Menu's placeholder logic unchanged.
3. **Activity log message format** — new endpoints log specific action strings: `batch-ship`, `batch-transfer`, `shipment-arrived`, `shipment-cancelled`. Migration logs once as `system / migration / unified-batch-collapse` (not N times per row).
4. **Cook-confirm location selection** — uses `S.currentLoc` at confirm time. If cook is on Dashboard (no location), modal forces them to pick one before confirming.

## Check-in protocol (REQUIRED for the execute-plan team lead)

This is a high-stakes rewrite of a live production app (kitchen runs on it daily). The team lead **must pause at each of the 6 checkpoints below**, summarize what was done, show the key diffs/output, then **wait for Daan to type "go" before proceeding to the next checkpoint**. Do not chain checkpoints.

At each checkpoint, the team lead presents:
- **What got done** — files changed, key decisions made
- **Proof it works** — test output, preview screenshots, dry-run results (whatever's applicable)
- **What's next** — the upcoming checkpoint's scope
- **Any deviations from the plan** — flag them explicitly and ask before continuing

### Checkpoint 1 — Schema + migration script ready (playbook steps 1–5)
After: `pg_dump` snapshot taken, migration script written with dry-run mode, `shared/types.ts` updated, `lib/db.ts` rewritten, `routes/batches.ts` + `routes/data.ts` updated with new endpoints.
**Show Daan:** the migration dry-run output against staging DB (counts of families collapsed, catering refs rewritten, any oddities); the diff of `shared/types.ts` and `prisma/schema.prisma`. Wait for "go."

### Checkpoint 2 — Frontend core + live-sync safety (playbook steps 6–7)
After: `public/js/core.ts` rewritten (family helpers deleted, inventory helpers added); `public/js/utils.ts` updated with `__v: 2` schema-version check + force-reload on mismatch; `_lastSaved` clears on version bump.
**Show Daan:** diff of `core.ts` (delta in calcRequired family logic), demo of force-reload behavior in two browser windows during a simulated version bump. Wait for "go."

### Checkpoint 3 — Main UI rewrite (playbook steps 8–10, 13)
After: `dishes.ts` (tile + edit modal normal/power), `planner.ts` (Transport tab + Inventory modal redesign), `transport-card.ts` (Pack-and-Send to `/ship`), `ai-analyzer.ts` query+prompt updated.
**Show Daan:** preview screenshots of: cook → confirm at West, send 25L to Centraal, mark arrived, cancel a pending shipment, transfer between West/Centraal storage, freeze 20L. Verify badges show only non-zero values. Wait for "go."

### Checkpoint 4 — Fix My Menu rewrite (playbook step 11)
After: `menu-fixer.ts` simplified (family-pool logic deleted, drain pre-pass removed, scored constraints rewritten on per-batch inventory).
**Show Daan:** run Fix My Menu against 3 representative cook-week scenarios (use seeded staging DB), diff the new assignments vs. current production behaviour. Specifically check: Tom yum at Centraal stock fully drained before West shipping; no batch over-extended beyond total inventory. Wait for "go."

### Checkpoint 5 — Remaining consumers + tests green (playbook steps 12, 14–19)
After: `orders.ts`, `dashboard.ts`, `recipe-editor.ts`, `caterings.ts` updated; sync/seed scripts rewritten; 3 dead test files deleted; menu-fixer/transport-card/api tests rewritten; new test files added (`inventory-helpers.test.ts`, `shipment-flow.test.ts`, `migration.test.ts`); telemetry events + coverage manifest updated.
**Show Daan:** `npm test` output (all pass), `npm run test:e2e` output (all pass), preview smoke walkthrough of every screen Daan uses daily — Dashboard, Planner (each tab), Dishes, Orders. Wait for "go."

### Checkpoint 6 — Deploy go/no-go (playbook steps 20–22)
After: migration dry-run executed against fresh prod snapshot (separate scratch DB), discrepancies logged, hand-verified.
**Show Daan:** dry-run report (counts, anomalies, any families that didn't collapse cleanly); preview smoke against migrated snapshot data; the exact deploy checklist (maintenance banner copy, 503 window, rollback procedure). Wait for Daan to nominate a specific deploy window and trigger the actual deploy himself.

**Hard rules for the team lead:**
- Never push to `main` autonomously.
- Never run `npx prisma migrate deploy` against the production DB.
- Never bypass a checkpoint, even for "trivial" follow-ups.
- If a test fails or preview shows a bug, fix it before requesting check-in.
- If you discover a fact that conflicts with the plan, **stop and ask Daan** before deciding.
- If implementation runs longer than expected (>1 day per checkpoint), pause and report.

## Implementation playbook (in order)

When implementation starts, execute in this order to minimize broken states:

1. **Snapshot prod DB** — `pg_dump` to local file. Verify restore works on scratch DB. [done — `scripts/snapshot-db.js` written; actual prod snapshot happens at Checkpoint 6 by Daan during deploy window]
2. **Write migration script** with dry-run mode. Test against staging DB (full prod copy). Verify family-collapse correctness on 3 hand-picked families. [done — `prisma/migrations/20260511120000_unified_batch_inventory_add_cols/data-migrate.ts` written; staging dry-run verified 24 families, 6 multi-member parent+split pairs collapsed correctly, 0 anomalies. Drop_cols migration moved to Checkpoint 3 alongside dependent consumers.]
3. **Update `shared/types.ts`** — new Batch shape with `inventory[]`, `shipments[]`, drop dropped fields. Add `__v: 2` schema version constant for SSE staleness detection. [done]
4. **Update `lib/db.ts`** — `validateBatch`, `dbReadAll`, `toBatchRow`, `dbUpsertBatches`, `dbDeleteBatchIds`. All in one sweep. [done]
5. **Update `routes/batches.ts` + `routes/data.ts`** — validators, defaults, DELETE rule, new endpoints (/ship, /transfer, /shipments/:id/arrived, /shipments/:id/cancel). [done]
6. **Update `public/js/core.ts`** — delete family helpers; add inventory helpers (`getTotalStock`, `getStockAt`, `getPendingFromShipments`, `consolidateInventory`, `isStaleEntry`); rewrite `calcRequired` and friends. [done — added 7 inventory helpers + `recomputeBatchAllocations` (pure peer-share) + new `_batchAllocations` cache; calc functions switched to read from new cache; legacy family helpers marked @deprecated (deletion in C5 after menu-fixer.ts rewrite). Schema-version field also lives in `routes/events.ts` broadcast() — one-line change covers all 25+ SSE call sites.]
7. **Update `public/js/utils.ts`** — `applyRemotePatch` schema-version check + force-reload on mismatch. Clear `_lastSaved` on bump. [done — schema mismatch triggers toast → 400ms delay → `localStorage.removeItem('lastSaved')` (defensive) → `window.location.reload()`. Undefined version treated as compatible (defensive for partial-deploy window).]
8. **Update `public/js/dishes.ts`** — tile rendering, edit modal (normal + power), delete doSplit/renderSplitBar/renderFamilyGrouped/renderMergedSameLocationTile, add Transfer/Send modals. [done — tile + Edit modal Normal/Power; openSendModal + openTransferModal; B3 chooser fix; C1 Transfer locked same-loc; BL1 cross-loc warning on tile Served. Plus isBatchCooked predicate fix in core.ts (legacy stock read returning false everywhere).]
9. **Update `public/js/planner.ts`** — Transport tab rewrites to render shipments, Inventory modal redesign for multi-entry, drag-drop helpers. [done — Transport tab per-shipment rows with Mark arrived + × Cancel send; Inventory modal location-scoped DEFAULT (Daan-critical safety) + Power mode toggle, FIFO distribution, openServedDialogForLoc routes loc-scoped path; CO1 Cancel via 5s pushUndo manager.]
10. **Update `public/js/transport-card.ts`** — `confirmTransportPlan` calls `/ship`; pack accumulation logic. [done — getStockAt-based filters; per-row /ship calls; backend handles pack-accumulate.]
11. **Update `public/js/menu-fixer.ts`** — drop family-pool logic, drain pre-pass; simplify constraint checks. [done — 2652→1704 LOC (-1266 dead code + family-pool / drain pre-pass / Pass 1-5 dead exports deleted; +318 new helpers + rewrites). Per-batch capacity via getTotalStock + getStockAt; cross-batch same-recipe peers first-class (audit S7); consolidateFamilies call site gone (audit S8 cleared); auto-retire adds pending-shipment guard; move-to-freezer client-side flips per-entry storage + resets cookDate; ResultsReport "Merged → Retired" wording.]
12. **Update `public/js/orders.ts`, `dashboard.ts`, `recipe-editor.ts`, `caterings.ts`** — replace `b.location` reads.
13. **Update `lib/ai-analyzer.ts`** — Prisma query + system prompt. [done — both queries rewritten with module-local `sumInventoryQty` + `sumNonFrozenInventoryQty` helpers; system prompt updated with 2 bullets describing inventory[] shape + stock-field semantic. Schema strip + db.ts fallback removal + recipes.ts:642 fix + DEPLOY.md production-safe restructure (psql-based drop_cols + `migrate diff`-based reconciliation) all also landed in this checkpoint.]
14. **Update `scripts/sync-prod-to-staging.js` + `scripts/seed-staging.js`** — new shape.
15. **Delete dead test files** (`consolidate-families.test.ts`, `family-aware-demand.test.ts`, `family-aware-pass4.test.ts`).
16. **Rewrite tests** — `menu-fixer.test.ts` factories, `transport-card.test.ts`, `api.test.ts`, e2e specs.
17. **Add new test files** — `inventory-helpers.test.ts`, `shipment-flow.test.ts`, `migration.test.ts`.
18. **Add new telemetry events** (`batch_ship`, `batch_transfer`, `shipment_mark_arrived`, `shipment_cancel`) + coverage manifest entries.
19. **Run full test suite + e2e suite** — fix every failure.
20. **Preview smoke** — cook → ship → arrive → re-ship → cancel → transfer → freeze → thaw → run Fix My Menu → live sync between two windows.
21. **Migration dry-run against fresh prod snapshot** — log discrepancies, hand-verify.
22. **Deploy coordination with Daan** — pick a quiet window, run migration, monitor.
