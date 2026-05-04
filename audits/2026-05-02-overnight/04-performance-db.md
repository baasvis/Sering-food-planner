# Performance & DB / Prisma

## Scope of review

- Prisma schema: [prisma/schema.prisma](prisma/schema.prisma) — every model, every index.
- Backend query patterns: [lib/db.ts](lib/db.ts), [routes/recipes.ts](routes/recipes.ts), [routes/ingredients.ts](routes/ingredients.ts), [routes/inventory.ts](routes/inventory.ts), [routes/finance.ts](routes/finance.ts), [routes/guests.ts](routes/guests.ts), [routes/data.ts](routes/data.ts), [lib/ai-analyzer.ts](lib/ai-analyzer.ts).
- Frontend bundle/perf surface: [public/index.html](public/index.html), [vite.config.ts](vite.config.ts), [public/js/utils.ts](public/js/utils.ts), [public/js/init.ts](public/js/init.ts), [public/js/core.ts](public/js/core.ts), [public/js/orders.ts](public/js/orders.ts) (selected sections).
- Caching/HTTP: [app.ts](app.ts) (compression + static cache headers), per-route `Cache-Control` annotations.
- Deployment: [railway.toml](railway.toml), [railpack.json](railpack.json), `engines.node`.

I did not run a real load test or `EXPLAIN ANALYZE` on the prod DB. The findings are static-analysis-driven; the AI-insights system (acknowledged in code comments, e.g. "AI insight #12/#23 — /patch avg 760ms") is the team's existing source of empirical perf signal.

## Findings

### P1 — `dbUpsertCaterings` and `dbUpsertTransportItems` issue one upsert per row inside the write lock
- **Severity**: Medium
- **Location**: [lib/db.ts:454-462](lib/db.ts), [lib/db.ts:473-482](lib/db.ts).
- **What**: 
  ```ts
  for (const c of caterings) {
    await prisma.catering.upsert({ where: { id: c.id }, create: row, update: row });
  }
  ```
  N caterings = N round-trips. Held for the duration of `withWriteLock` so other writers wait. A patch that touches 5 caterings is 5×(20–50ms RTT) = 100–250ms even with the DB hot, all inside the lock.
- **Why it matters**: `/api/data/patch` is the heaviest write surface. A typical save touches 1–2 caterings + several batches, so the absolute cost today is small. But this pattern doesn't scale: a rare bulk operation (e.g. "save 30 caterings") balloons. The same pattern in `dbUpsertBatches` was specifically optimised ([lib/db.ts:380-444](lib/db.ts)) — caterings/transport were missed.
- **Suggested fix**: Mirror the batch fix. Pre-fetch existing rows in one `findMany`, partition into create vs update sets, then `createMany` for new + per-row `update` only for the changed ones (or use Prisma's `transaction` with a list of operations). Cleanest: `prisma.$transaction([upsert1, upsert2, ...])` — even if it's per-row, the *transport* over the wire is a single batched call.
- **Confidence**: High.

### P2 — `recalcRecipeCostsForIngredient` is N+1 in a fire-and-forget background path
- **Severity**: Medium
- **Location**: [lib/db.ts:858-881](lib/db.ts), called from [routes/ingredients.ts:217-219](routes/ingredients.ts).
- **What**: When a single ingredient is saved (`POST /api/ingredients/:id`), the route fires-and-forgets a recalc:
  ```ts
  recalcRecipeCostsForIngredient(req.params.id).catch(...);
  ```
  Inside, `findMany` returns recipes that use the ingredient (good), then a `for` loop calls `calcRecipeCost(r.ingredients, …)` per recipe. **Each `calcRecipeCost` call issues its own `prisma.ingredient.findMany`** ([lib/db.ts:728](lib/db.ts:728)). For an ingredient used by 50 recipes, that's 50 sequential queries (each fetching all that recipe's linked ingredients), plus an `update` per changed recipe. Total: ~100 queries serial.
- **Why it matters**: Background, so the user doesn't see latency. But it pins the DB connection for several seconds, can starve other writers (it's *not* inside the write lock — actually a separate concern, see P3). It also runs on every single ingredient edit; a stocktake of 80 ingredients would queue 80 of these recalcs in series via the natural call ordering.
- **Suggested fix**:
  1. Aggregate: do ONE `findMany` of all ingredients across all recipes that use the changed ingredient, build a price map, then iterate recipes locally.
  2. Even better, pull the cost-calc business logic out of `lib/db.ts` (see Architecture A4) and feed it the price map directly without re-fetching.
  3. Consider whether to debounce: if the user edits 5 ingredients in quick succession, batch the recalc.
- **Confidence**: High.

### P3 — `recalcRecipeCostsForIngredient` runs outside `withWriteLock`
- **Severity**: Low
- **Location**: [routes/ingredients.ts:217-219](routes/ingredients.ts), [lib/db.ts:858-881](lib/db.ts).
- **What**: The recalc loop calls `prisma.recipe.update({ where: { id }, data: { costPerServing } })` per recipe with no write-lock. If a user is editing the same recipe via the recipe editor (`PATCH /api/recipes/:id`) at the same time, the recipe-editor's wrapped-in-lock update can race with the unwrapped recalc update. Usually the recalc-only writes a single field (`costPerServing`), and the editor writes everything else, so the lost update is one column — the editor's value wins because it merges from the existing row, but it would re-write the just-recalculated cost with the pre-calc value if the timing aligns.
- **Why it matters**: Mostly inconsequential because `costPerServing` is recomputed deterministically from inputs. A stale value will be corrected on next recalc trigger.
- **Suggested fix**: Put the recalc inside `withWriteLock`. Or — cleaner — make recalc batched and run on a debounced cron tick rather than fire-and-forget per ingredient save.
- **Confidence**: Medium — the actual user-visible impact requires a specific race window.

### P4 — `dbReadAll` triggers a denormalize pass on every page load
- **Severity**: Medium
- **Location**: [lib/db.ts:241-313](lib/db.ts), [lib/db.ts:566-592](lib/db.ts).
- **What**: `GET /api/data` runs 5 parallel `findMany`s (good), then `denormalizeRecipeIngredients(recipes)` which does an additional `prisma.ingredient.findMany({ where: { id: { in: idSet } }, ... })`. With ~200 recipes × ~10 ingredients each, that's a single query of ~500-1000 ingredient ids. Not a query-count problem, but the response payload includes the denormalized `ingredientName`, `ingredientAllergens`, `costPer100` *for every ingredient row in every recipe*. With 200 recipes × 10 ingredients × ~40 bytes of denormalization, that's 80KB of redundancy per `/api/data` response, on top of the actual recipe payload.
- **Why it matters**: `/api/data` is the heaviest endpoint (acknowledged in [app.ts:14-17](app.ts) — "352 calls/day, 888ms avg"). Compression helps; total wire is probably 200-400KB compressed for a typical kitchen. The denormalization is needed for the frontend (per [lib/db.ts:303-305](lib/db.ts)), but only for the recipe-editor screen. The dashboard / planner / orders mostly don't read `recipe.ingredients[i].ingredientName`.
- **Suggested fix**: 
  1. Stop denormalizing in `/api/data`; rely on the per-recipe `GET /api/recipes/:id` (which already does `hydrateRecipeForDetail`) for the editor.
  2. If `/api/data` consumers really need denormalized names, send only an `id → name` map (`recipeIngredientNames: Record<string, string>`) — single dictionary, no per-row repetition.
- **Confidence**: High.

### P5 — `loadIngredients()` over-fetches columns the slim endpoint doesn't return
- **Severity**: Medium (covered as A11 in architecture)
- **Location**: [routes/ingredients.ts:15-26](routes/ingredients.ts).
- **What**: `prisma.ingredient.findMany()` with no `select`. The slim mapper drops `priceHistory`, `nutrition`, `pricePer100g`. Postgres still hydrates those columns on the wire from DB to Node.
- **Why it matters**: 2100 ingredients × `priceHistory` (24-month JSON each) × 3 calls/min during peak Orders-screen usage = significant bandwidth between Railway's Postgres and the Node dyno.
- **Suggested fix**: Add explicit `select` matching the slim mapper. See A11 in [01-architecture.md](01-architecture.md).
- **Confidence**: High.

### P6 — `Cache-Control: private, max-age=30` is short for read-heavy endpoints with no SSE invalidation
- **Severity**: Low
- **Location**: [routes/recipes.ts:187](routes/recipes.ts) (recipe detail), [routes/ingredients.ts:64](routes/ingredients.ts) (ingredients/full), [routes/guests.ts:80](routes/guests.ts) (guest history), [routes/guests.ts:188](routes/guests.ts) (guests-next-weeks).
- **What**: 30s and 60s caches are appropriate for the trade-off the comments describe ("ingredient edits don't broadcast via SSE so other users would see stale prices for up to this window"). But the cache is per-browser, so a new tab or a hard refresh re-fetches. There's no shared cache (Railway edge doesn't cache `private` responses).
- **Why it matters**: Mostly fine. Worth flagging because:
  - `/api/recipes/:id` is heavy (943ms avg per the inline comment) and 30s is short for content that rarely changes outside an active editor.
  - The CLAUDE.md "Don't" list doesn't include caching guidelines, so future endpoints may inherit a 30s cache for things that should be 5 minutes.
- **Suggested fix**: Bump to a longer max-age where staleness is genuinely tolerable; trigger an SSE `recipe-update` broadcast on edit so caches can self-invalidate. Already partly done — `broadcast(user.email, 'recipe', { action: 'update', recipe })` exists on PATCH ([routes/recipes.ts:488](routes/recipes.ts:488)). Could lift recipe detail cache to 5 minutes.
- **Confidence**: Medium.

### P7 — Missing index on `Batch.parentId` for child-batch lookups
- **Severity**: Low
- **Location**: [prisma/schema.prisma:35-42](prisma/schema.prisma).
- **What**: `Batch.parent` is an FK relation (`@relation("BatchParent", fields: [parentId], references: [id])`). Postgres does not auto-index foreign keys. Queries that walk the relation (`prisma.batch.findUnique({ include: { childBatches: true } })`) or filter by `parentId` would full-scan today.
- **Why it matters**: I haven't seen a `where: { parentId: ... }` query in the routes I read, so the impact is theoretical. But the `cleanCateringRefs` flow ([public/js/dishes.ts:472](public/js/dishes.ts:472)) and the split-batch logic ([reports mention "split-child"](audits)) likely walk parentId at some point. If you ever add a query like "find all child batches of this parent," the missing index will bite.
- **Suggested fix**: `@@index([parentId])` in the next migration. Cheap, no downside.
- **Confidence**: Medium — based on schema analysis, not a profiled slow query.

### P8 — `DailyRevenue` and `ProductRevenue` queries are date-range-orderBy without a single-column date index
- **Severity**: Low
- **Location**: [prisma/schema.prisma:227-256](prisma/schema.prisma), [routes/finance.ts:18-25](routes/finance.ts), [routes/finance.ts:35-41](routes/finance.ts).
- **What**: `DailyRevenue` has `@@unique([date, location])` — a multi-column unique index. The query `findMany({ where: { date: { gte, lte } }, orderBy: [{ date: 'asc' }, ...] })` can use the unique index *because* date is the leading column. So this is OK. Same for `ProductRevenue` — date is the leading column of the unique key.
- **Why it matters**: Was about to flag this as missing; verified the unique covers it. Listed as a "looked good" data point rather than a finding.
- **Suggested fix**: None.
- **Confidence**: High.

### P9 — Frontend bundles all 26 modules upfront via `main.ts`
- **Severity**: Medium
- **Location**: [public/js/main.ts:6-27](public/js/main.ts), [vite.config.ts](vite.config.ts).
- **What**: `main.ts` does ~25 import statements, each pulling a screen module. Vite bundles them into a single chunk (no `import()` lazy splits anywhere in the codebase). On first page load, the browser parses ~16,488 LOC of TS/JS even though the user only sees the dashboard.
- **Why it matters**: 
  - First-load JS parse cost on a low-end Android phone is real (often 200-400ms for a ~500KB bundle).
  - The 60s background refresh interval ([public/js/init.ts:154-162](public/js/init.ts:154-162)) calls `rerenderCurrentView`, which means *every screen renderer is alive in memory* permanently.
  - Screen-module changes invalidate the entire chunk, not just the touched screen, so deploys force everyone to re-download the whole bundle.
- **Suggested fix**: Lazy-load by screen. `showScreen('orders')` would `await import('./orders')` if not already loaded. The renderer registry already exists ([navigate.ts](public/js/navigate.ts)) — extend it so registration is the import side-effect, and `showScreen` triggers a dynamic import for unknown registry keys. Vite splits dynamic imports automatically. Bonus: `menu-fixer.ts` (1425 LOC) is only used from one button and could land in its own chunk.
- **Confidence**: High.

### P10 — `setInterval` in `initApp` runs `rerenderCurrentView` every 60s with no leak guard
- **Severity**: Low
- **Location**: [public/js/init.ts:154-162](public/js/init.ts).
- **What**: 
  ```ts
  setInterval(() => { rebuildPlanner(); ... rerenderCurrentView(); }, 60000);
  ```
  The interval is set in `initApp`, which can run multiple times: after login, after location-chooser selectLocation, etc. Each call adds another interval; nothing clears the previous one.
- **Why it matters**: After 5 sequential logout/login cycles in the same tab, you have 5 timers all firing every 60s — 5x the work, 5x the screen flickers.
- **Suggested fix**: Store the interval id (e.g. `S._refreshTimer`) and `clearInterval` on logout / re-init.
- **Confidence**: High.

### P11 — `rebuildPlanner()` is called liberally (>10 sites), runs O(N batches × services) every time
- **Severity**: Low
- **Location**: [public/js/core.ts:71-80](public/js/core.ts), 12 callers in `dishes.ts`, `dashboard.ts`, etc.
- **What**: `rebuildPlanner` iterates every batch's services, indexing them into `S.planner` keyed by `loc-date-meal`. With ~200 batches × ~3 services each, that's ~600 entries — fast in absolute terms, but called from every save, every undo, every screen change. The `forEach` inside `forEach` does an `Array.find` to dedupe — O(N²) in the worst case where all services share a key.
- **Why it matters**: Probably fine today (200 batches is small). Scales linearly with active batches; the team plans expansion to 6 locations.
- **Suggested fix**: Replace the dedup `find` with a Set lookup. Memoize against `S.batches` reference equality (only rebuild when batches actually change). Each individual fix is small but adds up.
- **Confidence**: Medium.

### P12 — `loadData` triggers four parallel "secondary" loads, then doesn't await them
- **Severity**: Low
- **Location**: [public/js/utils.ts:228-235](public/js/utils.ts).
- **What**: After `apiGet('/api/data')` resolves and state is populated, `loadData` fires off (without await) `loadIngredientDb`, `loadStorageConfig`, `loadKitchenEquipment`, `loadGuestHistory`, `loadGuestsNextWeeks`. The user sees the dashboard render immediately — good. But these in-flight loads can land in any order, and screen renderers that depend on them have their own reactive listeners (`window.addEventListener('ingredientDbReady', …)` in `orders.ts`). The pattern is consistent for ingredient DB, but storage config and kitchen equipment have no such listener — code that needs them simply gets `null`.
- **Why it matters**: Race-y. The Orders tab handles it; other tabs that read `S.storageConfig` may render a slightly-broken state if the load is still in flight.
- **Suggested fix**: One of:
  - Have all background loads dispatch a generic `dataReady` event with a payload key, and have screens that need a specific dataset listen for it.
  - Make `S.kitchenEquipment` etc. lazy: a getter that returns the cached value or kicks off a load + a Promise<value>.
  - Simplest: `await Promise.all([…])` before showing the app, eating the extra ~1s of cold-load latency. Probably wrong trade-off given Daan's mobile use.
- **Confidence**: Medium.

### P13 — Recipe `versions` JSON column grows unbounded
- **Severity**: Low
- **Location**: [prisma/schema.prisma:279](prisma/schema.prisma) (`versions Json @default("[]")`), [routes/recipes.ts:516-553](routes/recipes.ts) (POST /recipes/:id/version).
- **What**: Each version save appends a snapshot to the JSON array. The full ingredient list is captured in each version. After 100 saves of a recipe (a year of weekly tweaks), that's 100 snapshots × ~5KB each = 500KB in one row. Loading the recipe loads the whole `versions` blob.
- **Why it matters**: Slow growth, not urgent. The frontend never displays full version history by default; only when the user opens the version panel. But every `findUnique` on the recipe pulls `versions` because Prisma doesn't auto-`select`.
- **Suggested fix**: Move `versions` to a separate `RecipeVersion` table (one row per snapshot). Migration is pure-additive: read existing JSON → insert one row per snapshot → drop the column when ready. Fixes the growth and removes the read overhead.
- **Confidence**: Medium — the trigger threshold is "popular recipe with weekly versioning;" not there yet but visible on the horizon.

### P14 — `prisma.$queryRaw` in `aggregateTelemetry` returns dates as `Date` objects then stringifies
- **Severity**: Nit
- **Location**: [lib/ai-analyzer.ts:155-203](lib/ai-analyzer.ts).
- **What**: Six raw SQL queries run in parallel — that's the right pattern. Worth noting: each individually returns a small result set (LIMIT 20 max), so there's no row-cardinality concern. The `last_seen` coercion does `String(e.last_seen)` which gives the JSON-stringified Date — fine for the UI, but inconsistent with other timestamps which are already ISO strings.
- **Why it matters**: Low. Mostly an inconsistency, not a perf issue.
- **Suggested fix**: Use `last_seen: e.last_seen.toISOString()`.
- **Confidence**: High.

### P15 — Static-asset cache is correctly aggressive, index.html correctly revalidates
- **Severity**: (Positive)
- **Location**: [app.ts:34-52](app.ts).
- **What**: Hashed assets in `/assets/*` get `max-age=31536000, immutable`. Other files (`index.html`) get `no-cache`. Express adds ETag automatically.
- **Why it matters**: This is the right shape for a Vite-built app. AI-insight-driven optimization that visibly addressed a real metric ("eliminates revalidation round-trips that currently cost 600–900ms on / GET").
- **Suggested fix**: None.
- **Confidence**: High.

### P16 — Per-row `prisma.recipeIngredientRow.update` inside a `Promise.all` is good for the import-cooked-amounts path
- **Severity**: (Positive)
- **Location**: [routes/recipes.ts:362-369](routes/recipes.ts).
- **What**: Bulk re-import of cooked amounts hits Google Sheets API per recipe (slow), then updates ingredients in parallel via `Promise.all`. The pre-fetch of all ingredient names ([routes/recipes.ts:296-305](routes/recipes.ts:296-305)) eliminated the previous N+1.
- **Why it matters**: A documented win — comment cites previous 258s for 55 recipes.
- **Suggested fix**: None. Good template for future bulk operations.
- **Confidence**: High.

### P17 — SSE keep-alive at 30s; Railway proxy idle is ~60s; no client-side reconnect strategy
- **Severity**: Low
- **Location**: [routes/events.ts:30-32](routes/events.ts), [public/js/utils.ts:445-468](public/js/utils.ts).
- **What**: Server sends a keep-alive every 30s. EventSource auto-reconnects on disconnect (browser default). Client code only logs `connection lost, reconnecting...` — no exponential backoff (browser handles it, defaults to 3s).
- **Why it matters**: If Railway's edge has a 60s idle timeout, 30s keep-alive is correct. If the actual idle is shorter (e.g. 30s exactly), the browser would see a disconnect every minute. No empirical signal that this is happening.
- **Suggested fix**: Verify the timeout on Railway's edge proxy by leaving an SSE connection open and observing. Drop keep-alive to 15s if needed.
- **Confidence**: Medium.

### P18 — `inlineEdit` does a full save trigger but only patches one DOM cell
- **Severity**: Nit
- **Location**: [public/js/dishes.ts:499-520](public/js/dishes.ts).
- **What**: After `inlineEdit`, the code calls `rebuildPlanner()` (full O(N) rebuild), `scheduleSave()` (which queues the patch save), AND a manual DOM patch of `.col-diff` to update the diff display without re-rendering the row. The DOM patch is a perf win (preserves focus). But `rebuildPlanner` is called even when the field is just `name` or `note` — neither affects the planner index.
- **Why it matters**: 200 batches → 600 service entries → not slow per call, but every keystroke if the change is debounced poorly. The current `scheduleSave` debounces to 1.5s, but rebuildPlanner runs on every change.
- **Suggested fix**: Skip `rebuildPlanner` for fields that don't affect it (`name`, `note`). Or compute it lazily on first read.
- **Confidence**: Medium.

## Patterns & themes

- **The team has been actively profiling and fixing real perf bottlenecks**. AI-insight references in code (`#12`, `#23`, `#33`, `#47`) tie commits to measurable telemetry. The pattern is healthy: collect → analyse → fix → measure. The remaining issues in this audit are second-order — places the same discipline hasn't yet reached.
- **N+1 in loops with await is the most common shape**. `dbUpsertCaterings`, `dbUpsertTransportItems`, `recalcRecipeCostsForIngredient`. Each is fixable with the same "pre-fetch in one findMany, then iterate locally" pattern that `dbUpsertBatches` already uses.
- **Caching is short and tactical**. `private, max-age=30` for endpoints that mutate via SSE works well. The model is "soft cache + push invalidation via broadcast" — solid; just needs to be consistent.
- **Static assets are perfect**. Vite-hashed + `immutable` + revalidating index.html. Don't touch.
- **The frontend bundle is monolithic by construction** — every screen module is in `main.ts`. Lazy-loading would be the single biggest first-load win.
- **Indexes match query patterns well in critical paths**. Batch / Recipe / Telemetry are indexed correctly. Gaps (parentId, single-column date) are minor.

## What looked good

- **`dbUpsertBatches` parent-FK batching** ([lib/db.ts:380-444](lib/db.ts)) — comments cite "AI insight #12/#23 — /patch avg 760ms" and the fix is precisely what you'd want to see (eliminate 2N round-trips).
- **`hydrateRecipeForDetail`** ([lib/db.ts:627-717](lib/db.ts)) — single `findMany` for denormalize + cost + nutrition. Comment explicitly explains why no write-back on read. The right shape.
- **Telemetry buffering** ([routes/telemetry.ts:24-49](routes/telemetry.ts)) — 60s flush, max-buffer cap, drop-on-overflow. Correct trade-offs for a high-volume low-importance write.
- **Compression skips SSE explicitly** ([app.ts:18-23](app.ts)) — un-buffered streaming requirement understood and documented.
- **Per-route `Cache-Control` headers** are explicit and explained inline. Comments reference specific AI insights and explain why each duration was chosen.
- **`prisma.$transaction` used correctly for write-all-or-nothing** in `lib/db.ts` `writeBatches`/`writeGuests`/etc. Recipe ingredient replace also wraps in a transaction (route-level) to prevent zero-ingredient state on partial failure.
- **`Promise.all` used in the right spots** — `dbReadAll`, `aggregateTelemetry`, `dbUpsertBatches`'s pre-flight reads. Not overused (no premature parallelism).
- **`take: 50` on the activity log query** ([routes/inventory.ts:130-133](routes/inventory.ts)) — bounded result set. Prevents the table from being a slow-grow query nightmare.
- **AI-insights cleanup cron** ([server.ts:73-83](server.ts)) deletes telemetry > 90 days. Without this, the table would grow indefinitely. Explicitly handled.

---

## Round 2 — deeper findings (added after end-to-end reads of the seven > 1000 LOC frontend modules + the Tebi scraper)

### P19 — `applySupplierUpdate` POSTs the entire ~2100-row ingredient DB on every Hanos XLSX upload
- **Severity**: Medium
- **Location**: [public/js/ingredient-db.ts:1304](public/js/ingredient-db.ts), [routes/ingredients.ts:71-113](routes/ingredients.ts).
- **What**: The supplier-XLSX import mutates `S.ingredientDb` in place, then sends `await apiPost('/api/ingredients', S.ingredientDb)` — which the backend handles as `prisma.ingredient.deleteMany() + createMany()` of all rows. Even when the supplier file only updates 50 ingredients, ALL 2100 are deleted and re-created. Postgres write amplification + Prisma per-row insert serialization = several seconds of DB lock.
- **Why it matters**: Cross-references A18. The user-facing button says "Update X existing ingredients" but the actual operation rewrites the whole table. Contention with normal stocktake activity for several seconds.
- **Suggested fix**: Add a `PATCH /api/ingredients/bulk-update` endpoint that accepts only the changed rows. Frontend sends `{ updates: [{ id, orderPrice, orderUnit, ... }] }`.
- **Confidence**: High.

### P20 — `updateIngredientSearch` re-renders the entire Orders screen per keystroke
- **Severity**: Medium (covered as U21 in UI/UX audit — listed here for the perf framing)
- **Location**: [public/js/ingredient-db.ts:42-51](public/js/ingredient-db.ts).
- **What**: Every keystroke in the ingredient DB search box calls `renderOrders()` → `renderIngredientDbTab()` → filter/sort 2100-row array → build paginated 50-row HTML → `setOuterHTML` of #screen-orders → `requestAnimationFrame` re-find input + restore cursor. CLAUDE.md explicitly warns against this pattern ("Search/Filter Input Rule — never replace the input's own DOM element").
- **Why it matters**: On mobile the lag is visible (per general patterns; not measured). The split-container fix is well-documented elsewhere in the codebase.
- **Suggested fix**: See U21.
- **Confidence**: High.

### P21 — Tebi scraper uses `page.waitForTimeout(3000)` magic numbers in the login + post-login waits
- **Severity**: Low (reliability under perf framing)
- **Location**: [scripts/tebi-scraper.js:121,494,540](scripts/tebi-scraper.js).
- **What**: Three places hardcode `await page.waitForTimeout(3000)` after login, after navigation to dashboard, and after the secondary dashboard load. Tebi's Vue SPA might be ready in 100ms or take 8s on a slow Railway worker — 3s is a guess that fails both directions.
- **Why it matters**: Either wastes 2-3 seconds per scrape (most cases) or fails because the SPA wasn't actually ready (some cases). Each Tebi sync has ~14 days × 2 accounts × 3 waits = wastes 252s of cron time per nightly run.
- **Suggested fix**: Replace with `page.waitForSelector('[data-known-stable-element]', { timeout: 30000 })` — wait for an actual DOM signal that the SPA has rendered. The dashboard widget UUID containers from `discoverProfitCenters` are good candidates.
- **Confidence**: High.

### P22 — Module-level singleton timeouts cause lost stock-saves on fast successive edits
- **Severity**: Low (covered as A19 in architecture — listed here because the symptom is "user input dropped")
- **Location**: See A19.
- **What**: See A19.
- **Why it matters**: See A19.
- **Suggested fix**: See A19.
- **Confidence**: High.

### P23 — `renderEditor` rebuilds the entire editor body via `innerHTML` on every ingredient change
- **Severity**: Low
- **Location**: [public/js/recipe-editor.ts:580-628](public/js/recipe-editor.ts).
- **What**: `reAddIngredient`, `reRemoveIngredient`, `reMoveIngredient`, `reToggleFlexible` all call `renderEditorBody()`, which rebuilds `#re-body` HTML from scratch. The 6 sections (basics + ingredients + prep + storage + allergens + save-checklist) all re-render even though only the ingredients list changed. With 30+ ingredients, the table re-builds each time. Focus is lost; the user has to click back into the input they were editing.
- **Why it matters**: Recipe editing flows (especially during initial recipe creation) involve adding 10-20 ingredients in sequence. Each add re-renders everything; cursor/focus state is lost.
- **Suggested fix**: Extract `renderIngredientsTable()` and only update `#re-ingredients-list` for ingredient mutations. Reserve full `renderEditorBody` for sweeping changes.
- **Confidence**: High.

### P24 — Tebi scraper sequential per-day fetch with no parallelism
- **Severity**: Low (perf at long-tail)
- **Location**: [scripts/tebi-sync-worker.js:171-184](scripts/tebi-sync-worker.js).
- **What**: For a 14-day backfill, the worker does `for (const date of dates) { await runForAccount(...) }` — 14 sequential Tebi API roundtrips per account. Tebi's API supports date-range queries (the scraper uses `startDate=...&endDate=...`), so there might be a one-shot mode for the whole window. Currently each day = one full chart fetch + one invoice fetch.
- **Why it matters**: 14-day backfill takes minutes (consistent with the 5-min timeout for manual syncs). Reducing this would shorten the user-perceived wait on manual sync.
- **Suggested fix**: Investigate whether Tebi's API supports `startDate=2026-04-19&endDate=2026-05-02` directly. If yes, fetch the whole range in one call per chart type.
- **Confidence**: Medium — depends on Tebi API behavior I haven't verified.

### P25 — `ensureBatchTogglesInitialized` re-iterates `S.batches` on every render
- **Severity**: Low
- **Location**: [public/js/orders.ts:594-603](public/js/orders.ts).
- **What**: Called from every `renderOrders` invocation (combined-order tab, batch-ingredients tab, batch-toggle list). Filters `S.batches` (200 items) for `location && !cooked && hasRecipe` each time. The `batchIngredientTogglesInitialized` flag protects against re-initializing the toggle map, but the filter always runs.
- **Why it matters**: 200 batches × 4 conditions per render = trivially fast. But this is one of many small filter-passes that add up.
- **Suggested fix**: Memoize the eligible-batches list keyed on `S.batches` reference. Invalidate via the existing `setOnBatchesChanged` hook.
- **Confidence**: Medium.
