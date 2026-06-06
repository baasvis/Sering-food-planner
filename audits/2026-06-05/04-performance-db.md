# Performance & Database

## Scope of review

This pass focused on database access patterns and payload sizing across the unified-batch patch path, the new Competencies/Supplies/Notion endpoints, the recipe `versions` JSON, ingredient over-fetch, and migration apply-order. Findings are sorted by adjusted severity.

## Findings

### PERF-1 — Unified-batch inventory/shipments lost-update via /api/data/patch

**STATUS: FIXED 2026-06-05 — but NOT via the "Suggested fix" below, which is UNSAFE.** Stripping inventory/shipments in `dbUpsertBatches` would silently drop the manual inventory editor's edits (`openInventoryEditor`/`updateInventoryField` in dishes.ts persist `batch.inventory` through `/api/data/patch` → `scheduleSave`). Correct fix applied instead: `computePatch` (public/js/utils.ts) omits inventory/shipments only when *they* are unchanged vs the last snapshot; `applyRemotePatch` field-merges batches so an omitting patch doesn't strip them on other clients over SSE; `validateBatch` (lib/db.ts) tolerates absent inventory/shipments (strict when present). Tests: test/data-integrity-pr1.test.ts.

- **Severity**: Medium
- **Location**: lib/db.ts:587-598 (dbUpsertBatches), public/js/utils.ts:127-130 (computePatch), public/js/dishes.ts:555-566 (inlineEdit)
- **What**: Any batch field edit (e.g. name/note via inlineEdit) resends the whole batch including inventory[]/shipments[], and dbUpsertBatches merges `{...mapBatchRow(existing), ...b}` where `b` ALWAYS carries inventory/shipments, so a stale client array silently overwrites stock/shipment state changed concurrently by /ship,/transfer,/arrived.
- **Why it matters**: Stock is the highest-value data in the app. A cook ships 50L West->Centraal while another user edits the same batch's note; the note-save (debounced 1.5s) round-trips the pre-ship inventory and reverts the shipment, losing real food-movement records. The dedicated ship/transfer endpoints are race-safe in isolation, but the generic full-batch save path is not.
- **Suggested fix**: In dbUpsertBatches, strip inventory/shipments from the client object before merging (let dedicated endpoints own those fields), i.e. merge `{...mapBatchRow(existing), ...b, inventory: existing.inventory, shipments: existing.shipments}`; or omit inventory/shipments from computePatch's batch serialization entirely so the planner save never touches stock.
- **Confidence**: High.
- **Verified**: lib/db.ts:593 — `const merged = toBatchRow({ ...mapBatchRow(existing), ...b })` — the spread `...b` unconditionally overwrites `inventory` and `shipments` with whatever the client sent. The client always sends the full Batch object (computePatch at utils.ts:129 does `patch.batches!.push(d)` where `d` is the complete batch from `S.batches`). inlineEdit (dishes.ts:555-566) only changes `d.name`/`d.note` but then calls `scheduleSave()`, which triggers computePatch, which includes `d.inventory` and `d.shipments` from the potentially-stale in-memory state. No stripping or protection exists in routes/data.ts. SSE via applyRemotePatch (utils.ts:717) updates S.batches in real-time, but the 1.5s debounce save window still opens a race: if /ship or /arrived is called concurrently, the SSE patch and the debounced name-edit save can race, and if the save lands after the SSE update but before the debounce fires (or if the SSE is delayed), the stale inventory/shipments from the client overwrite the DB.
- **Reviewer notes**: The severity is correctly Medium rather than Critical: the race window is narrow (1.5s debounce) and SSE partially mitigates it by updating S.batches before the save fires in many cases. However the vulnerability is real and unmitigated at the server level. The proposed fix — stripping inventory/shipments from the merge in dbUpsertBatches so dedicated endpoints own those fields — is the correct approach.

### PERF-5 — GET /api/data and recipe SSE broadcasts ship the full unbounded `versions` JSON for every recipe

- **Severity**: Medium
- **Location**: lib/db.ts:683-715 (toRecipeFull), lib/db.ts:445/473-476 (dbReadAll), routes/recipes.ts:86,560,594
- **What**: toRecipeFull includes the entire `versions` array (each snapshot carrying a full ingredient list), and it is used by dbReadAll (GET /api/data, the heaviest endpoint), GET /api/recipes, and every recipe broadcast — even though a dedicated slim GET /api/recipes/:id/versions (select: versions only) already exists for the version panel.
- **Why it matters**: versions grows unbounded (one snapshot per recipe save; ~5KB each). With ~200 recipes versioned weekly for a year, /api/data balloons by hundreds of KB of version history that the dashboard/planner never read, and every single recipe edit broadcasts the full version blob to all connected clients over SSE.
- **Suggested fix**: Drop `versions` from toRecipeFull (or add a `select` excluding it in dbReadAll/GET /recipes/broadcast) and have the recipe-detail/version panel fetch the existing GET /recipes/:id/versions on demand; longer term move versions to a RecipeVersion table (prior P13).
- **Confidence**: High.
- **Verified**:

  lib/db.ts:708 — toRecipeFull includes `versions: (r.versions ?? []) as unknown as RecipeVersionSnapshot[]` with no exclusion.

  lib/db.ts:445 — dbReadAll fetches recipes with `prisma.recipe.findMany({ include: { ingredients: { orderBy: ... } } })` (no select to exclude versions), then maps at line 473 via `toRecipeFull`.

  routes/recipes.ts:82-88 — GET /recipes also calls `toRecipeFull` on all rows.

  routes/recipes.ts:180, 431, 496, 560, 594 — every recipe mutation broadcast calls `toRecipeFull(...)`, shipping full versions to all SSE-connected clients.

  RecipeVersionSnapshot (shared/types.ts:193-198) carries `ingredients: RecipeIngredientFull[]` per snapshot — each snapshot is effectively as large as a full recipe ingredient list.

  The slim endpoint exists: routes/recipes.ts:501-509 uses `select: { versions: true, name: true }` but none of the bulk paths use it.
- **Reviewer notes**: The finding is real and unmitigated. The `versions` JSON column (stored as a Prisma Json field in the `recipe` table) is included verbatim in every toRecipeFull call. Since RecipeVersionSnapshot embeds a full ingredients array, each snapshot is comparable in size to the recipe itself, and the array grows unbounded with every save. This directly inflates GET /api/data (the heaviest endpoint, hit on every page load), GET /api/recipes, and every SSE broadcast. The dedicated slim GET /api/recipes/:id/versions endpoint exists but is not used by any of the bulk/broadcast paths. Medium severity is appropriate: the problem is real and will worsen over time, but the app currently has a relatively small recipe count, so impact is currently tolerable.

### PERF-7 — recalcRecipeCostsForIngredient is N+1 and runs fire-and-forget outside the write lock

- **Severity**: Medium
- **Location**: lib/db.ts:1040-1062 (calcRecipeCost at 884-927 re-queries), routes/ingredients.ts:391
- **What**: On every single-ingredient save, recalcRecipeCostsForIngredient loops over affected recipes calling calcRecipeCost(r.ingredients,...), and each calcRecipeCost issues its own prisma.ingredient.findMany — N+1 sequential queries plus N updates — and the whole thing runs after the withWriteLock block closes (line 378-384) so its recipe.update calls are unserialized vs concurrent recipe edits.
- **Why it matters**: Carried over from prior P2/P3, still unfixed despite recalcAllRecipeCosts being optimized with a shared price map. An ingredient used by 50 recipes pins a DB connection for ~100 serial queries on each edit; a stocktake of 80 ingredients queues 80 such recalcs. The unserialized recipe.update can also clobber a concurrent recipe-editor cost write.
- **Suggested fix**: Reuse the recalcAllRecipeCosts approach scoped to the affected recipe IDs: one ingredient.findMany for the price map, then compute in memory; and run the recalc inside withWriteLock (or on a debounced tick) to serialize the recipe.update writes.
- **Confidence**: High.
- **Verified**:

  lib/db.ts:1040-1062 — recalcRecipeCostsForIngredient loops over N recipes calling calcRecipeCost per recipe. calcRecipeCost (lines 884-918) issues its own prisma.ingredient.findMany on each call (line 896), producing N sequential DB queries plus N prisma.recipe.update calls (line 1057).

  routes/ingredients.ts:378-398 — the withWriteLock block closes at line 384; recalcRecipeCostsForIngredient is called fire-and-forget at line 391, outside the lock. The recipe updates it fires are unserialized with respect to concurrent recipe edits.

  The optimized recalcAllRecipeCosts (lib/db.ts:1076-1121) builds one shared price map with a single findMany, but it is only used after bulk ingredient writes — not for single-ingredient saves. The per-ingredient path still uses the N+1 calcRecipeCost approach.
- **Reviewer notes**: All three claims are confirmed: (1) N+1 sequential findMany calls inside the per-recipe loop, (2) fire-and-forget execution outside the write lock, and (3) the optimized recalcAllRecipeCosts approach exists but is not applied here. The comment at line 387 ("fire-and-forget") and the inline audit reference at line 388 ("Audit T5") confirm the codebase is aware of the fire-and-forget nature but the N+1 has not been fixed for this path. Severity Medium is appropriate — the unserialized recipe.update is a real concurrency hazard and the N queries per ingredient save compound under stocktake load, but the window for a visible data corruption is narrow and the cost recalc is not on a user-blocking path.

### PERF-8 — loadIngredients() over-fetches heavy JSON columns the slim wire shape drops

- **Severity**: Medium
- **Location**: routes/ingredients.ts:45-56, called from routes/ingredients.ts:59 and routes/recipe-ai.ts:76
- **What**: loadIngredients does `prisma.ingredient.findMany()` with no `select`, so priceHistory (24-month JSON), nutrition, and other columns are hydrated from Postgres on the wire even though the GET /api/ingredients mapper and the AI catalog drop them.
- **Why it matters**: Carried over from prior P5, still unfixed. GET /api/ingredients is polled during Orders/stocktake usage and the AI recipe assistant re-fetches the full catalog on every chat turn; pulling ~2000 rows' priceHistory/nutrition blobs Postgres->Node on each call is wasted bandwidth and memory on the single dyno.
- **Suggested fix**: Add an explicit `select` to loadIngredients matching the slim wire shape (id,name,category,pricePer100,allergens,stock,etc.), or split a heavy loadIngredientsFull for the few callers that need priceHistory/nutrition.
- **Confidence**: High.
- **Verified**:

  routes/ingredients.ts:45-56 — `loadIngredients()` calls `prisma.ingredient.findMany()` with no `select`, fetching all columns including `priceHistory Json`, `nutrition Json`, `stock Json`, `storageLocations Json`, `targetStock Json`.

  The GET `/` handler (lines 58-83) maps to a slim shape explicitly dropping `priceHistory` and `nutrition`. The `GET /full` endpoint (line 86) is the only legitimate consumer of all columns (ingredient DB editor).

  lib/recipe-ai.ts:185-197 — `slimIngredient()` reduces each row to `{id, name, category, pricePer100, allergens}` only, and `buildSystemPrompt()` calls `ingredients.filter(...).map(slimIngredient)`. The full ingredient list including all JSON blobs is fetched on every chat turn via `loadIngredients()` at routes/recipe-ai.ts:76, then nearly all of it is thrown away.

  No `select` projection exists anywhere in `loadIngredients()` to avoid over-fetching.
- **Reviewer notes**: The finding is accurate. `loadIngredients()` over-fetches on every call. The `GET /full` route legitimately needs all columns, but the slim GET `/` response and the AI catalog only need a small subset. The fix would be to add a Prisma `select` to `loadIngredients()` matching the slim shape, and either pass `includeFull: true` for the `/full` endpoint or split into a separate `loadIngredientsFull()` function. Severity Medium is appropriate: the app has ~2100 ingredient rows with multiple JSON blobs per row, and this runs on a single dyno with every Orders/stocktake poll and every AI recipe chat turn.

### PERF-2 — Duplicate migration timestamp prefixes create a fragile lexicographic apply-order

- **Severity**: Low
- **Location**: prisma/migrations/ (20260516120000_add_competencies_module + _add_supplies; 20260516130000_add_chunk_locations + _recipe_yield_mode; 20260530120000_add_closed_services + _add_ritual_completions)
- **What**: Three pairs of migrations share identical timestamp prefixes, so `prisma migrate deploy` (run on every Railway push and on every fresh-DB replay) decides their apply order purely by the alphabetical suffix, not by intended time.
- **Why it matters**: It works today only because each same-timestamp pair is mutually independent (e.g. add_chunk_locations at 130000 depends on chunks created at 120000, which is fine). But the next same-timestamp migration with a cross-dependency, or a branch-merge that adds another collision, can replay a dependent migration before its dependency on a staging clone / PR review DB / migrate reset, producing a hard `relation/column does not exist` failure that prod (already-applied) never surfaces.
- **Suggested fix**: Adopt a strictly-increasing timestamp convention (CI lint that rejects duplicate prefixes); rename future colliding folders. No action needed on already-applied prod migrations, but document the rule in CLAUDE.md's migration Don't list.
- **Confidence**: High.
- **Verified**:

  Three confirmed duplicate-timestamp pairs in prisma/migrations/:
  - 20260516120000_add_competencies_module (creates chunks, people, teaching_events)
  - 20260516120000_add_supplies (alters caterings, creates supplies)
  - 20260516130000_add_chunk_locations (ALTER TABLE "chunks" ADD COLUMN "locations" TEXT[] — depends on chunks table from _add_competencies_module above)
  - 20260516130000_recipe_yield_mode (alters recipes — independent)
  - 20260530120000_add_closed_services (creates closed_services)
  - 20260530120000_add_ritual_completions (creates ritual_completions)

  The cross-dependency risk is real: add_chunk_locations (130000) references the chunks table created by add_competencies_module (120000). Within the 120000 pair, alphabetical ordering accidentally puts add_competencies_module before add_supplies (c < s), which is the correct order. If that ever reversed, add_chunk_locations would fail with "relation chunks does not exist" on a fresh replay.

  No CI lint or guard exists to prevent future timestamp collisions — no mention in CLAUDE.md's Don't list, no check in .github/workflows/pr-tests.yml or elsewhere.
- **Reviewer notes**: The severity calibration of Low is accurate. The current collisions happen to work correctly by accident (alphabetical suffix order matches the intended dependency order). The risk is latent — it would only manifest on a fresh DB replay with a future collision that has a cross-dependency and incorrect alphabetical order. The proposed fix (CI lint + CLAUDE.md doc) is appropriate and proportionate for the risk level.

### PERF-3 — GET /api/competencies returns the entire unbounded teaching-event ledger, unindexed sort

- **Severity**: Low
- **Location**: routes/competencies.ts:31, prisma/schema.prisma:483-502
- **What**: `prisma.teachingEvent.findMany({ orderBy: { createdAt: 'desc' } })` returns every teaching event with no `take` limit, and TeachingEvent has indexes only on chunkId/teacherId/learnerId — none on createdAt — so the whole table is sorted in memory on every Competencies screen load.
- **Why it matters**: The teaching ledger is explicitly designed to accumulate forever (no soft-delete, append-only public record). A busy kitchen logs many events per week; within a year the screen-load payload and the unindexed sort grow without bound, with no pagination escape hatch.
- **Suggested fix**: Add `take: 500` (or paginate) on the ledger query and an `@@index([createdAt])`; the people-by-chunk grid only needs the latest events per pair, which a bounded window covers.
- **Confidence**: High.
- **Verified**:

  routes/competencies.ts line 31:
    prisma.teachingEvent.findMany({ orderBy: { createdAt: 'desc' } })

  No `take` parameter anywhere in the query. prisma/schema.prisma lines 498-500:
    @@index([chunkId])
    @@index([teacherId])
    @@index([learnerId])

  `createdAt` has no index. The comment in routes/competencies.ts (line 22-26) explicitly describes the events field as "the full teaching-event ledger", confirming the unbounded intent.
- **Reviewer notes**: The claim is accurate in every detail. The query at routes/competencies.ts:31 fetches all rows from teaching_events ordered by created_at desc with no LIMIT, and the schema has no index on created_at. The severity of Low is appropriate: this is a kitchen app with a modest staff roster, so the table will grow slowly (maybe dozens of events per week), and the sort will only become a real problem after months or years of use. The fix is straightforward (add take + @@index([createdAt])) but not urgent today.

### PERF-4 — Notion chunk sync holds the global write lock across a per-chunk upsert loop

- **Severity**: Low
- **Location**: lib/notion-sync.ts:163-173
- **What**: syncChunksFromNotion wraps the entire `for (const c of ready) await prisma.chunk.upsert(...)` loop in a single withWriteLock, so every other write in the app (batch saves, ship/arrive, ingredient edits) blocks for the full duration of N sequential chunk upserts.
- **Why it matters**: withWriteLock is a single app-wide mutex (lib/db.ts:542). The sync runs on a daily cron and on a staff-lead button; while it runs, cooks saving the planner during the window stall until all chunk upserts finish. N is small today but the lock scope is wrong — a network-slow Postgres turns this into a multi-second global write freeze.
- **Suggested fix**: Hold the lock per-upsert (acquire/release inside the loop) or use a single `prisma.$transaction([...upserts])` so the wire round-trips are batched, rather than holding the global mutex across all of them.
- **Confidence**: High.
- **Verified**:

  // lib/notion-sync.ts lines 157-173:
  // Phase 2 — upsert. The write lock is held only for the DB writes.
  const synced: string[] = [];
  const warned: { name: string; warnings: string[] }[] = [];
  try {
    await withWriteLock(async () => {
      for (const c of ready) {
        await prisma.chunk.upsert({
          where: { id: c.id },
          create: { id: c.id, ...c.fields },
          update: c.fields,
        });
        if (c.warnings.length) warned.push({ name: c.name, warnings: c.warnings });
        else synced.push(c.name);
      }
    });
  }

  // lib/db.ts lines 539-547:
  let writeLock: Promise<void> | null = null;
  export async function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    while (writeLock) await writeLock;
    let resolve: () => void;
    writeLock = new Promise<void>(r => { resolve = r; });
    try { return await fn(); }
    finally { writeLock = null; resolve!(); }
  }
- **Reviewer notes**: The finding is accurate. A single `withWriteLock` call wraps the entire sequential upsert loop in notion-sync.ts lines 163-173. The global mutex in lib/db.ts is a single module-level `let writeLock` variable, confirming it blocks all other app writes for the full duration. The comment on line 157 says "held only for the DB writes" which is technically true but misleading — it is held across N sequential network round-trips. Severity Low is correct: the sync runs infrequently (daily cron or manual), chunk counts are small today, and this is not in a hot path. The proposed fix (acquire/release per upsert, or a single prisma.$transaction) would be a genuine improvement.

### PERF-6 — dbUpsertCaterings/dbUpsertTransportItems still issue one upsert per row inside the write lock

- **Severity**: Low
- **Location**: lib/db.ts:609-618, lib/db.ts:628-637
- **What**: Both helpers loop `await prisma.<model>.upsert(...)` per row, so N caterings/transport items = N sequential round-trips held inside withWriteLock, unlike dbUpsertBatches which pre-fetches in one findMany.
- **Why it matters**: Carried over from prior audit P1 and still unfixed. /api/data/patch is the heaviest write surface; a bulk catering operation balloons the lock-hold time, blocking all other writers app-wide. Absolute cost is small for typical 1-2 caterings but the pattern doesn't scale and was explicitly fixed for batches only.
- **Suggested fix**: Mirror dbUpsertBatches: pre-fetch existing IDs in one findMany, partition create vs update, use createMany + per-row update; or wrap the upserts in a single prisma.$transaction([...]) so the wire transport is one batched call.
- **Confidence**: High.
- **Verified**:

  lib/db.ts lines 609-618 and 628-637:

  ```ts
  export async function dbUpsertCaterings(caterings: Catering[]): Promise<void> {
    for (const c of caterings) {
      const row = toCateringRow(c);
      await prisma.catering.upsert({
        where: { id: c.id },
        create: row,
        update: row,
      });
    }
  }

  export async function dbUpsertTransportItems(items: TransportItem[]): Promise<void> {
    for (const t of items) {
      const row = toTransportRow(t);
      await prisma.transportItem.upsert({
        where: { id: t.id },
        create: row,
        update: row,
      });
    }
  }
  ```

  Both are called inside `withWriteLock` in routes/data.ts (lines 112, 122). No `findMany` pre-fetch and no `prisma.$transaction([...])` batching. The claim about dbUpsertBatches pre-fetching is confirmed (line 584: `prisma.batch.findMany({ where: { id: { in: incomingIds } } })`), but that only avoids N reads — the writes there are also still sequential per-row. Severity Low is appropriate given typical 1-2 catering rows in practice.
- **Reviewer notes**: The finding is accurate. Both helpers issue one upsert per row inside the write lock with no batching. The comparison to dbUpsertBatches is also correct: batches pre-fetches existing rows in one findMany (the perf fix mentioned in an audit comment at line 578), but caterings/transport items skip even that optimization. The practical severity is low because caterings and transport items are typically small in number (1-2 per save), but the pattern is real and unfixed.

### PERF-9 — ritual-completions POST runs an unindexed full-table deleteMany on every save and skips loc validation

- **Severity**: Nit
- **Location**: routes/inventory.ts:283-298, prisma/schema.prisma:232-241
- **What**: Every POST /ritual-completions does `deleteMany({ where: { updatedAt: { lt: cutoff } } })` while RitualCompletion has no index on updatedAt (only @@unique([loc,date])), and the handler does not validate `loc` against the allowed set (unlike inventory-completions which checks INV_LOCS).
- **Why it matters**: The cleanup scans the table on every tick. The table is self-bounded to ~3 days so the scan is cheap today, but the missing loc validation lets an arbitrary loc string create rows the dashboard never reads, and the per-write delete is an avoidable scan that should be a periodic cron like the other cleanups.
- **Suggested fix**: Validate loc against {'west','centraal'} as inventory-completions does; move the >3-day cleanup to a daily cron (or add @@index([updatedAt])) instead of running it on every save.
- **Confidence**: Medium.
- **Verified**:

  routes/inventory.ts lines 283-298:

    router.post('/ritual-completions', asyncHandler(async (req: Request, res: Response) => {
      const { loc, date, completed } = req.body;
      if (!loc || !date) return res.status(400).json({ error: 'loc and date required' });
      // ... no loc validation against {'west','centraal'} ...
      await prisma.ritualCompletion.deleteMany({
        where: { updatedAt: { lt: cutoff } },
      });

  vs inventory-completions at line 318:
    if (!INV_LOCS.has(loc)) throw new AppError(400, 'loc must be "west" or "centraal"');

  prisma/schema.prisma lines 232-241:
    model RitualCompletion {
      id        Int      @id @default(autoincrement())
      loc       String
      date      String
      completed Json     @default("[]")
      updatedAt DateTime @default(now()) @map("updated_at")
      @@unique([loc, date])   // no @@index([updatedAt])
      @@map("ritual_completions")
    }
- **Reviewer notes**: All three claims are confirmed in the current code. The deleteMany on updatedAt runs on every POST (lines 295-297), there is no index on updatedAt in the schema (only @@unique([loc,date])), and loc is not validated against the allowed set unlike the parallel inventory-completions handler. Severity Nit is appropriate: the table is self-bounded to 3 days so the unindexed scan touches negligible rows, and the missing loc validation is a minor data-quality issue (phantom rows never rendered) rather than a security or correctness bug.
