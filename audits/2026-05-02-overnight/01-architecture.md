# Architecture & Code Quality

## Scope of review

Files inspected (full or partial reads):
- Backend entry: [server.ts](server.ts), [app.ts](app.ts).
- Routers: every file in [routes/](routes/) (16 files; full read of `auth`, `data`, `batches`, `recipes`, `events`, `telemetry`, `coverage`, `feedback`, `guests`, `inventory`, `admin`, `health`, `hanos`, `finance`, `ingredients`, `ingredients-import`).
- Library code: [lib/db.ts](lib/db.ts), [lib/config.ts](lib/config.ts), [lib/hanos-client.ts](lib/hanos-client.ts), [lib/ai-analyzer.ts](lib/ai-analyzer.ts).
- Shared layer: [shared/types.ts](shared/types.ts).
- Frontend entry/routing: [public/index.html](public/index.html), [public/js/main.ts](public/js/main.ts), [public/js/init.ts](public/js/init.ts), [public/js/navigate.ts](public/js/navigate.ts), [public/js/modal.ts](public/js/modal.ts), [public/js/state.ts](public/js/state.ts), [public/js/utils.ts](public/js/utils.ts), [public/js/auth.ts](public/js/auth.ts), [public/js/telemetry.ts](public/js/telemetry.ts), [public/js/dashboard.ts](public/js/dashboard.ts) (excerpt), [public/js/dishes.ts](public/js/dishes.ts) (excerpt).
- Build / config: [package.json](package.json), [tsconfig.json](tsconfig.json), [tsconfig.server.json](tsconfig.server.json), [vite.config.ts](vite.config.ts), [.gitignore](.gitignore), [railway.toml](railway.toml), [railpack.json](railpack.json).
- Reports: [reports/triage-2026-04-26.md](reports/triage-2026-04-26.md), [reports/issues/](reports/issues/).

Skipped (or only spot-read): the bigger frontend modules (`orders.ts` 1971 LOC, `planner.ts` 1192 LOC, `dishes.ts` 1159 LOC, `recipe-editor.ts` 1464 LOC, `ingredient-db.ts` 1519 LOC, `menu-fixer.ts` 1425 LOC, `dashboard.ts` 1083 LOC) — too large for full audit reads in one pass; covered as samples and discussed at the patterns level.

## Findings

### A1 — Frontend TypeScript runs with `strict: false` and `noImplicitAny: false`
- **Severity**: High
- **Location**: [tsconfig.json](tsconfig.json:6-7)
- **What**: The frontend tsconfig disables both strict mode and the implicit-any check; backend `tsconfig.server.json` has `strict: true`. CLAUDE.md acknowledges the gap and says it is being closed "per the audit plan," but `npm run typecheck` only typechecks the backend (`tsc -p tsconfig.server.json --noEmit`), so no CI gate enforces frontend types at all.
- **Why it matters**: Bugs that would be caught by a typechecker (wrong field access, undefined `find()` results, missing `recipeIngredients` shape) instead reach runtime. The 2026-04-20 P0 lost-recipe bug ([reports/triage-2026-04-26.md](reports/triage-2026-04-26.md)) is exactly the class of issue strict mode would surface — `body.id` was `undefined`, no compile-time signal. Vite ships untranspiled `*.ts` modules to esbuild, which is even more permissive.
- **Suggested fix**: Add a `tsconfig.client.json` invoked by `npm run typecheck` so PR CI fails on frontend type errors. Then incrementally enable `strict` per-file by adding `// @ts-strict` markers; the frontend has only ~126 `: any` annotations in 25 files (grep: `grep -rn ": any" --include="*.ts" public/js`), most concentrated in `caterings.ts`, `feedback-admin.ts`, `predictions.ts`, `tutorial.ts`. `state.ts` already exports a strict `AppState` interface.
- **Confidence**: High.

### A2 — `window.[key: string]: any` is implied across the entire frontend
- **Severity**: Medium
- **Location**: [public/js/main.ts](public/js/main.ts:36-103)
- **What**: `main.ts` does one giant `Object.assign(window, { … 200+ functions … })` so `onclick=""` handlers in HTML strings can find them. CLAUDE.md says the `Window` index signature `[key: string]: any` is "kept only for the `onclick` handler pattern" — but no other escape valve exists for fixing this. Every screen module's `innerHTML = '… onclick="renderFoo(${id})" …'` makes the architecture harder to refactor (no rename safety, no static call graph) and makes XSS easier to introduce.
- **Why it matters**: The "split the 2800-line index.html into 12 modules" refactor mostly succeeded for *file* boundaries but kept the *coupling* shape: every onclick is a global. Renaming a function silently breaks production until someone clicks the corresponding button. Dead-code analysis can't catch unused exports because every export is on `window`.
- **Suggested fix**: Migrate progressively to `addEventListener` + delegated handlers on a stable container, or to a tiny `data-action="renderFoo"` convention with a single delegated dispatcher in `init.ts`. Either pattern lets tree-shaking work and survives renames.
- **Confidence**: High.

### A3 — Frontend modules are very large and several are still growing
- **Severity**: Medium
- **Location**: [public/js/orders.ts](public/js/orders.ts) (1971), [public/js/recipe-editor.ts](public/js/recipe-editor.ts) (1464), [public/js/menu-fixer.ts](public/js/menu-fixer.ts) (1425), [public/js/ingredient-db.ts](public/js/ingredient-db.ts) (1519), [public/js/planner.ts](public/js/planner.ts) (1192), [public/js/dishes.ts](public/js/dishes.ts) (1159), [public/js/dashboard.ts](public/js/dashboard.ts) (1083).
- **What**: Seven modules exceed 1000 LOC. `orders.ts` mixes order-overview rendering, standard-inventory tab, ingredient table rendering, Hanos add-to-cart bulk flow, **and** the stocktake area UI. `dishes.ts` mixes the batch-list table, batch-tile rendering, inline edit handlers, split flow, new-dish modal, edit-dish modal, and cook-mode handling. `dashboard.ts` was the original screen router and still re-exports `showScreen` even though `navigate.ts` now owns it (see CLAUDE.md note "slated to move into `navigate.ts`").
- **Why it matters**: The CLAUDE.md "split-container" rule for inputs is direct evidence that re-rendering at module scope is fragile — the rule wouldn't need to exist if responsibilities were narrower. The 2025-04-26 triage report names planner/orders/recipe surfaces as the highest-feedback areas; large-module velocity will keep eroding test coverage gains.
- **Suggested fix**: One slice at a time. `orders.ts` is the natural first cut — split into `orders-overview.ts`, `orders-stocktake.ts`, `orders-hanos.ts`. Move `showScreen` out of `dashboard.ts` and into `navigate.ts` as already noted in CLAUDE.md. Each split should be its own PR so regressions are bisectable.
- **Confidence**: Medium — this is opinion-flavored. The current code works, and refactor-for-its-own-sake is exactly what the user has flagged as "don't introduce abstractions beyond what the task requires." But it's worth flagging because the trend is up.

### A4 — `lib/db.ts` is the single biggest backend file and conflates four roles
- **Severity**: Medium
- **Location**: [lib/db.ts](lib/db.ts) (881 LOC).
- **What**: It contains: (a) the Prisma client export, (b) all entity validators, (c) row transformers (Prisma ↔ shared types), (d) high-level dbReadAll/Write helpers, (e) write-lock primitive, (f) recipe cost/nutrition/allergen *business logic*. The cost calculation (`calcRecipeCost`) and the nutrition aggregation (`hydrateRecipeForDetail` + `calcRecipeNutrition`) are essentially business rules — they pick a `FLEX_PRICE_PER_100G = 0.15` constant, round, treat empty volume as null. They live in a file named "PostgreSQL data layer."
- **Why it matters**: When recipe costing changes (e.g. flexible-ingredient default price), grepping the DB layer is not the obvious place to look. Conversely, anyone reading `lib/db.ts` for the validation scheme has to scroll past 600 lines of math.
- **Suggested fix**: Carve out `lib/recipe-pricing.ts` (cost + nutrition + allergens) and `lib/validators.ts`. Leave `lib/db.ts` as Prisma + transformers + write-lock. Each can be unit-tested without a DB once extracted; today the recipe-pricing logic is essentially un-tested at the unit level (see Tests audit).
- **Confidence**: High.

### A5 — Two parallel "recipe" systems still ship to clients
- **Severity**: Medium
- **Location**: [prisma/schema.prisma:56-77](prisma/schema.prisma) (`RecipeIndex` model), [routes/recipes.ts:15-93](routes/recipes.ts) (`/recipe-index` GET/POST/DELETE), [shared/types.ts:119-137](shared/types.ts) (`RecipeEntry` interface), [lib/db.ts:288](lib/db.ts) (returns empty `recipeIndex: []`).
- **What**: The `recipe_index` table, its CRUD routes, and the `RecipeEntry` shared interface still exist and are still typed, but `dbReadAll()` hard-codes `recipeIndex: []` ([lib/db.ts:288](lib/db.ts:288)) "kept until Recipe v1 sunset" (CLAUDE.md). The backend POST `/recipe-index` route is reachable and writable — and `withWriteLock`-protected — even though no consumer reads from it; the frontend `S.recipeIndex` is set from `data.recipeIndex` ([public/js/utils.ts:221](public/js/utils.ts:221)), which means it's always `[]`.
- **Why it matters**: Confusion vector. New code that consults `S.recipeIndex` looks valid but always sees an empty list. The DELETE endpoint can mutate the legacy table — silently — without any frontend trigger; not actually exploitable because writes are auth-gated, but a UI build that accidentally re-enables it would fail strangely. Bigger picture: keeping a dead schema branch indefinitely makes every subsequent migration scarier ("does this affect recipe_index?").
- **Suggested fix**: Either (a) sunset by deleting the `RecipeIndex` model + the `/recipe-index` routes + the shared type in one PR, or (b) add a clear comment in `lib/db.ts` explaining that `S.recipeIndex` will always be `[]` so the downstream callers can stop iterating it. Option (a) is cleaner — the routes have been dead for over a month.
- **Confidence**: High.

### A6 — `addBackendEvent` mutates a singleton buffer with no per-tenant scope
- **Severity**: Low
- **Location**: [routes/telemetry.ts:24-59](routes/telemetry.ts), [app.ts:56-70](app.ts).
- **What**: A single in-process `buffer: BufferedEvent[]` collects every API call's response time. `MAX_BUFFER = 10_000`. After overflow, new events are dropped silently (`if (buffer.length >= MAX_BUFFER) return`). Cron flush runs every 60s. CLAUDE.md acknowledges single-replica assumption.
- **Why it matters**: With 352 calls/day to `/api/data` alone, the buffer is far below capacity in normal operation, so this isn't actually broken. But on a deploy with the flush timer not yet started (server.ts:53 starts it after `app.listen` callback), early requests buffer with no flush. SIGTERM does call `flushBuffer()`. Worth knowing if the app ever moves to multi-replica — telemetry from instance A would never see instance B's events, and aggregations in `/api/admin/telemetry/summary` would silently undercount.
- **Suggested fix**: No action today. Document in CLAUDE.md "single-replica" list that the telemetry buffer is one of those pieces. If multi-replica is ever planned, move to a fire-and-forget DB write or a Redis-backed buffer.
- **Confidence**: High.

### A7 — `events.ts` SSE registry leaks rows on bad-state writes
- **Severity**: Low
- **Location**: [routes/events.ts:46-58](routes/events.ts).
- **What**: `broadcast()` catches `client.res.write` exceptions and `clients.delete(id)` on failure. But the `keepAlive` setInterval set up on the connection only clears in `req.on('close', …)` ([routes/events.ts:38-42](routes/events.ts:38-42)), which fires on TCP close, not on a write that triggers the catch block. If a client connection becomes write-failing but the underlying socket stays half-open, broadcast `delete`s the entry yet the keep-alive interval keeps firing every 30s and the next write throws again, but there's no second cleanup hook (the entry is gone). Net result: an orphaned `setInterval`. After an error, broadcast no longer touches that client's setInterval; it only stops when the socket eventually closes.
- **Why it matters**: Slow leak under flaky-client conditions; harmless on Railway because TCP timeouts will eventually close the socket. Worth fixing if you scale beyond a single dyno.
- **Suggested fix**: Track `keepAlive` next to the client entry in the map and `clearInterval(client.keepAlive)` inside the broadcast catch.
- **Confidence**: Medium — this is a code-reading inference, not a reproduced leak. If you've never seen orphaned timers in `node --inspect`, this is theoretical.

### A8 — Two write-lock pattern is in-process and not Postgres-side
- **Severity**: Low
- **Location**: [lib/db.ts:326-333](lib/db.ts).
- **What**: `withWriteLock` is a trivial Promise chain — fine for one Node process, useless for two. CLAUDE.md mentions this in the single-replica list.
- **Why it matters**: Today: nothing. If Railway autoscales the dyno (single dyno today per CLAUDE.md, but Postgres plugin supports it), two replicas could both run `dbUpsertBatches` concurrently and the lock won't serialise them — relying on Prisma's per-statement atomicity, which is enough for single-row updates but won't prevent the read-modify-write race the lock was added to fix (see [routes/ingredients.ts:141-153](routes/ingredients.ts) stock JSON merge).
- **Suggested fix**: When/if multi-replica becomes real, swap for a Postgres advisory lock (`SELECT pg_advisory_xact_lock(<bigint>)` inside a transaction). For now, leave it; document the constraint.
- **Confidence**: High.

### A9 — Renderer registry isn't enforced; some screens still couple via direct imports
- **Severity**: Low
- **Location**: [public/js/dashboard.ts:11-32](public/js/dashboard.ts), [public/js/main.ts:11](public/js/main.ts).
- **What**: `navigate.ts` has the registry. But `dashboard.ts` still imports renderers from other screen modules at the top of the file (e.g. `confirmCooked` from `dishes.ts`, `getIngredientsForArea`/`startStocktake` from `orders.ts`). `main.ts` re-imports `showScreen` from `dashboard.ts` rather than `navigate.ts`. The CLAUDE.md note acknowledges this: "**`showScreen()` lives in `dashboard.ts`** — slated to move into `navigate.ts` so the registry is self-contained."
- **Why it matters**: Renderer registry's whole value prop is breaking the cyclic-import ball. As long as `dashboard.ts` is the de facto orchestrator, the cycle is just hidden one level deeper.
- **Suggested fix**: Move `showScreen` and `getScreenFromHash` out of `dashboard.ts` (they already re-export from `navigate.ts`). Then move dashboard-only inventory stocktake helpers (`dashStocktake*`) out of `orders.ts` re-imports — they already live in `dashboard.ts` so the import is just shape.
- **Confidence**: High.

### A10 — `dbReadAll` swallows DB errors and returns empty defaults
**RESOLVED on 2026-05-03 (branch `claude/a10-dbreadall-acfca7`)**: removed the try/catch that returned `{batches:[], guests:..., recipes:[], caterings:[], transportItems:[]}` on any error. Errors now bubble via asyncHandler → global error handler → 500, and the frontend's `apiGet` triggers the persistent `showDataError` banner. New regression test in `test/api.test.ts` monkeypatches `prisma.batch.findMany` to throw and asserts the route returns 500 instead of the silent 200-with-empties. Cross-referenced as T7 in the tests audit.
- **Severity**: Medium
- **Location**: [lib/db.ts:308-313](lib/db.ts).
- **What**: `dbReadAll` wraps every read in a single try/catch. On *any* failure (DB down, query timeout, Prisma client crash) it logs to stderr and returns an empty `DataResponse`. The frontend then renders an "empty kitchen" — no batches, no recipes — which looks identical to a freshly seeded DB.
- **Why it matters**: Operationally invisible bug class. Daan would see an empty dashboard, assume "did someone delete everything?", and try to recreate state. Telemetry would not record a "load failed" event because the *route* returned 200. The frontend `loadData` does have `showDataError` ([public/js/utils.ts:244](public/js/utils.ts:244)) but that path only triggers when `apiGet` itself rejects — a 200-with-empties never hits it.
- **Suggested fix**: Throw the error and let the global error handler ([app.ts:115-133](app.ts)) format a 500. The frontend already handles 500s via `apiGet` error path. Alternatively, return a `{ ok: false, error }` shape and update the loader to detect it. Don't silently lie.
- **Confidence**: High.

### A11 — `loadIngredients` returns rich Prisma rows cast to a slim shared type with no projection
- **Severity**: Low
- **Location**: [routes/ingredients.ts:15-26](routes/ingredients.ts).
- **What**: `loadIngredients()` does `prisma.ingredient.findMany()` (no `select`) and casts the result to `Ingredient[]`. The `/api/ingredients` mapper then explicitly projects a *slim* subset — but the database has already paid for `priceHistory` JSON column hydration and `stock`, `nutrition`, `targetStock` Json blobs. The slim projection happens in JS after the wire.
- **Why it matters**: `priceHistory` for ~2100 ingredients is the heaviest column in the table (one row per month per ingredient × 2 years). Loading it on every `/api/ingredients` call is wasted work — the slim payload is exactly what the order screen needs. The `/api/ingredients/full` endpoint exists for the case that needs the whole shape.
- **Suggested fix**: In `loadIngredients` (used by the slim endpoint), add `select: { …slim columns… }` and stop pulling `priceHistory` / `nutrition`. Keep the rich shape in `/api/ingredients/full`. Probably saves 100–300ms per `/api/ingredients` call on cold cache; AI insight reportedly flagged this endpoint as transfer-dominated.
- **Confidence**: Medium.

### A12 — Validation present at /patch boundary, missing at single-entity write boundaries
- **Severity**: Medium
- **Location**: [routes/data.ts:50-77](routes/data.ts), [routes/ingredients.ts:71-113](routes/ingredients.ts), [routes/inventory.ts:22-36](routes/inventory.ts), [routes/inventory.ts:109-125](routes/inventory.ts).
- **What**: `/api/data/patch` validates everything carefully (added "audit §6.1" comment cites a specific past gap). Other write endpoints don't. Examples:
  - `POST /api/ingredients` (bulk): accepts an array of any shape, casts to `Ingredient`, writes with `prisma.ingredient.deleteMany() + createMany()`. No length cap, no per-row schema check. A misbehaving authenticated client can wipe the whole ingredient DB by POSTing `[]`.
  - `POST /api/standard-inventory`: per-location `deleteMany + createMany` with no per-row validation. Same wipe risk.
  - `POST /api/prep-checklist`: trusts `loc` and `date` strings as-is, then upserts. Then deletes any `prepChecklist` row where `updatedAt < cutoff` — a reasonable house-keep but unrelated to the user's POST and would leak surprises ("why did my checklist get cleaned up when I saved?").
  - `POST /api/feedback`: accepts arbitrary `text`, no length cap. Long text could hit Postgres `text` column limit only at the DB level.
- **Why it matters**: All of these are auth-gated, so the threat model is "authenticated user accidentally or maliciously trashes shared state." The patch route already showed why this matters (audit §6.1). Single-entity routes are where edge cases land later.
- **Suggested fix**: Add a `validateIngredients` helper next to `validateBatches` etc., wire it into the bulk endpoint. Cap feedback text at e.g. 5000 chars. Move the "delete prep checklists older than 3 days" job into the daily cleanup cron in `server.ts` instead of running it inline on every save.
- **Confidence**: High.

### A13 — `safeErrMsg` is well-designed but inconsistently applied
- **Severity**: Low
- **Location**: [lib/config.ts:31-49](lib/config.ts), [routes/hanos.ts:54-87](routes/hanos.ts).
- **What**: `redactSecrets` redacts `Bearer …`, `Basic …`, and `password=` / `secret=` / `token=` / `client_secret=` / `api_key=` patterns. Hanos routes use `safeErrMsg` carefully. But several places that touch upstream errors only use raw `errMsg`:
  - [routes/recipes.ts:271-272](routes/recipes.ts): `console.warn` with raw `errMsg(e)` — fine for stderr only, but the `details` field that goes into `recipe-import` log entry includes raw error too.
  - [routes/ingredients.ts:218](routes/ingredients.ts): `console.error('Failed to recalculate recipe costs', e)` — passes the whole error object, which prints stack+message untouched.
  - [routes/admin.ts:24](routes/admin.ts): `generateInsights()` errors propagate to global handler, which masks them in production — but the AI prompt body itself (not redacted) goes to Anthropic API including telemetry data that may contain user emails (telemetry rows have `userId`).
- **Why it matters**: The redactor exists for a reason; gaps weaken the contract. The Anthropic call in particular is uploading user-identifying telemetry to a third-party LLM — small kitchen, ~57 staff, but worth a privacy review.
- **Suggested fix**: One-pass audit: anywhere `errMsg` flows into a DB write, log entry, telemetry payload, or third-party API call, switch to `safeErrMsg`. For the AI analyzer, redact `userId` before serializing telemetry into the prompt body; the model doesn't need it for usage analysis.
- **Confidence**: High for the code claim. The privacy claim is opinion ("worth a review" not "a violation").

### A14 — `app.ts` mounts every router at module top level — no graceful degradation
- **Severity**: Low
- **Location**: [app.ts:82-111](app.ts).
- **What**: `requireAuth` is mounted as `app.use('/api', requireAuth)` after `coverage`/`telemetry` and before everything else, but the route-level `requireAuth` middleware only checks for `/auth/` and `/health` paths in its own implementation ([routes/auth.ts:86-93](routes/auth.ts:86-93)). The `events` SSE router is *not* gated by the path-level check — `/api/events` will pass through `requireAuth` (returns 401) even though SSE uses an EventSource that browsers can't easily attach a session cookie reset to. In practice cookies are session-bound, so this works, but it does mean an unauthenticated client trying to connect SSE gets 401 instead of a no-op stream.
- **Why it matters**: Probably right today (you want unauth users blocked from SSE). Worth being explicit about.
- **Suggested fix**: Add a comment in `auth.ts` listing which paths bypass `requireAuth` and why. The current `/auth/` and `/health` set is correct; future endpoints might want to opt out (e.g. a public "service status" page) and there's no obvious place to look.
- **Confidence**: Medium.

### A15 — Implicit-any in `init.ts` `buildNav` callback signatures
- **Severity**: Low (Nit)
- **Location**: [public/js/init.ts:58-83](public/js/init.ts).
- **What**: `NAV_SCREENS.map((s: any, i: any) => …)` despite `NavScreen` and array index being trivially typeable. Same in `content.innerHTML`/`bottomNav.innerHTML` map calls.
- **Why it matters**: Cosmetic; will be fixed when frontend `strict` flips.
- **Suggested fix**: When you do strict-flip, this file is one of the easy wins.
- **Confidence**: High.

### A16 — `setInterval` handlers don't `unref` outside telemetry
- **Severity**: Low (Nit)
- **Location**: [public/js/init.ts:154-162](public/js/init.ts), [routes/telemetry.ts:79-85](routes/telemetry.ts), [server.ts:73-101](server.ts).
- **What**: `routes/telemetry.ts` uses `cleanupInterval.unref()` correctly. The cron-driven schedules in `server.ts` and the page-level 60s refresh in `init.ts` don't (`unref()` is moot in the browser anyway). Frontend-side, the 60s `setInterval` in `initApp` will keep trying to `rerenderCurrentView` even after the user logs out and re-enters; the interval is never cleared.
- **Why it matters**: Tiny memory pressure, not user-visible. After logout → login the interval count grows by one per cycle.
- **Suggested fix**: Store the interval id on `S` (e.g. `S._refreshTimer`) and `clearInterval` in `doLogout`.
- **Confidence**: High.

## Patterns & themes

- **Drift toward "the file that owns this concept is the file that started owning it"**: `dashboard.ts` is the screen router *and* a screen. `lib/db.ts` is the data layer *and* the recipe pricing engine. `orders.ts` is the order screen *and* the stocktake screen. The 2024-style modular split happened, but business logic kept calcifying into the largest files because that's where the imports were already wired. This is the single most impactful trend; the 7 modules > 1000 LOC are evidence.

- **Defense-in-depth at the patch layer is great; the rest of the perimeter is patchier**. `/api/data/patch` validates 8 distinct inputs, has a comment citing a past audit, and uses `withWriteLock` cleanly. Per-entity routes — added later in the lifecycle — skip 1–3 of those layers (validation, length caps, write-lock scoping). This is normal for a post-rewrite app, but the gap is now wide.

- **Telemetry and AI insights are the most novel architectural piece.** The buffered-write + cron-aggregate + LLM-summarise pipeline is the kind of self-serve observability bigger orgs build; here it's running on a single dyno and feeding daily insights. Worth protecting from regressions (currently no test for the aggregator queries).

- **Comments in this codebase are unusually load-bearing**. Several routes contain inline references to past audits ("§6.1", "AI insight #20", "audit §3.1"). This is genuinely useful as institutional memory, but it means a casual refactor that "just cleans up the comments" would erase the why. Worth keeping that style.

- **Backend types are tight. Frontend types lean on duck-typing**. The `RecipeIngredientFull` denormalization pattern (mutate `.ingredientName` etc. server-side after the Prisma fetch) crosses the type boundary in a way TypeScript can't check; the optional-marked fields (`ingredientName?: string` in [shared/types.ts:167](shared/types.ts:167)) acknowledge the contract is fuzzy.

## What looked good

- **`shared/types.ts` is the right idea** — string-literal unions for `Location`, `Meal`, `DishType`, `StorageType` close off whole categories of typo bugs at the type boundary. The Vite `@shared` alias and the Jest `moduleNameMapper` mirroring it is clean.
- **`asyncHandler` + `AppError` + global error handler** is the right shape for Express-on-modern-Node. The handler in `app.ts` correctly distinguishes 4xx (no log) from 5xx (log + telemetry) and masks internal messages in production. Cleaner than most consultancy code I see.
- **`compression` middleware skips SSE explicitly**, with the comment explaining why. That's exactly the kind of subtle correctness the AI-insight feedback loop was clearly designed to catch.
- **`dbUpsertBatches` parent-FK handling is thoughtful**: it pre-batches the existence check (avoiding 2N round-trips), retries with `parentId=null` on P2003 as a last resort, and logs warnings. This is the kind of code that paid for itself.
- **Renderer registry pattern** ([public/js/navigate.ts](public/js/navigate.ts)) is a real improvement over what the inline-import-everywhere shape would be — the cycle break is visible and tested by the fact that `navigate.ts` has zero screen-module imports.
- **`hydrateRecipeForDetail`** (one query instead of three) is a real win and the comments explain the reasoning. Same for the parent-batch FK batching in `dbUpsertBatches`.
- **The triage report and `reports/issues/` shape** is institutional discipline you usually only see in bigger orgs. Worth keeping.
- **Coverage snapshot with bearer auth** ([routes/coverage.ts](routes/coverage.ts)) is a small, well-bounded surface — a good template for the next "exposed but bounded" admin endpoint.

---

## Round 2 — deeper findings (added after end-to-end reads of the seven > 1000 LOC frontend modules + the Tebi scraper + archive scripts)

### A17 — `S.recipeIndex` empty-state bug breaks three user-visible surfaces (escalation of A5)
- **Severity**: High (was Medium when classified as "dead code branch" — re-reading the consumers shows it's actually breaking active flows)
- **Location**: [public/js/planner.ts:538-549](public/js/planner.ts), [public/js/planner.ts:678-705](public/js/planner.ts), [public/js/planner.ts:921-967](public/js/planner.ts), [public/js/dishes.ts:942-955](public/js/dishes.ts).
- **What**: `S.recipeIndex` is hard-coded to `[]` server-side ([lib/db.ts:288](lib/db.ts)). Three frontend surfaces still read it for *display*:
  1. **Add Dish modal "Recipes" tab** ([public/js/planner.ts:538-539](public/js/planner.ts)): `let allRecipes = [...S.recipeIndex];` — the third tab in the slot-add modal always shows zero.
  2. **New Batch modal "Search recipes"** ([public/js/dishes.ts:942-955](public/js/dishes.ts)): same pattern; users see "No recipes in index yet. Add some in the Recipes tab." even though they have v2 recipes — *misleading* error message that points at a nonexistent tab.
  3. **`addRecipeToSlot` and `replaceWithRecipe`** ([public/js/planner.ts:679,925](public/js/planner.ts)): orphaned functions; called only from the always-empty list (#1), so unreachable in normal use, but kept on `window` so an inline-onclick could trigger them with a forged id.
- **Why it matters**: The kitchen team probably reaches v2 recipes through the placeholder + Replace flow (which correctly uses `S.recipes`). But the natural "+ Add dish" → "Recipes" path leads to dead silence. The "No recipes in index" error in the new-batch modal teaches users that recipes-from-this-button is broken — bug per #429-style user feedback class.
- **Suggested fix**: Two paths (pick one):
  1. Quick: change `S.recipeIndex` → `S.recipes` in the three render sites; map the v2 RecipeFull shape to whatever the legacy `RecipeEntry`-shaped renderer expects (mostly compatible — `name`, `type`, `allergens`, `costPerServing`).
  2. Sunset (preferred, per A5): delete the legacy `RecipeIndex` model, the `/recipe-index` routes, the `S.recipeIndex` field, and the `addRecipeToSlot`/`replaceWithRecipe` functions. Migrate the three render sites to the v2 path.
- **Confidence**: High — verified by reading the consumers; the three sites all pull from `S.recipeIndex` with no v2 fallback.

### A18 — `applySupplierUpdate` does a full bulk-replace of the entire ingredient DB on every Hanos XLSX upload
- **Severity**: Medium
- **Location**: [public/js/ingredient-db.ts:1258-1312](public/js/ingredient-db.ts).
- **What**: The Hanos supplier-XLSX import iterates `S.ingredientDb` mutating fields in place, then does ONE `apiPost('/api/ingredients', S.ingredientDb)` — which the backend handles as a `prisma.ingredient.deleteMany() + createMany()` of all ~2100 ingredients. Any concurrent edit of any ingredient (other staff member, SSE patch in flight, the user's own pending stock save) is lost. This isn't theoretical — supplier upload is monthly, but the team has 57 staff and SSE is on by default.
- **Why it matters**: Supplier upload is a routine action with destructive side-effects on unrelated data. Mirrors A12 (validation gaps in single-entity write boundaries) and the lost-update class fixed elsewhere via `withWriteLock`.
- **Suggested fix**: Add a per-ingredient PATCH path: instead of POSTing the whole array, send only the touched ingredients (those whose `orderCode` appeared in the supplier file) one-by-one or via a new `/api/ingredients/bulk-update` endpoint that does per-row upserts inside a single transaction.
- **Confidence**: High.

### A19 — Module-level singleton timeouts shared across all rows lose updates on fast successive edits
- **Severity**: Low
- **Location**: [public/js/ingredient-db.ts:149-173](public/js/ingredient-db.ts) (`_inlineStockTimeout`), [public/js/orders.ts:295-311](public/js/orders.ts) (`siTargetTimeout`), [public/js/orders.ts:314-330](public/js/orders.ts) (`siStockTimeout`), [public/js/orders.ts:1523-1545](public/js/orders.ts) (`_stockSaveTimeout`).
- **What**: Each module declares ONE timeout id, shared across all ingredient rows. Pattern:
  ```ts
  let _stockSaveTimeout: ReturnType<typeof setTimeout> | null = null;
  // In a row's onchange handler:
  clearTimeout(_stockSaveTimeout);
  _stockSaveTimeout = setTimeout(() => fetch(...), 600);
  ```
  Edit ingredient A's stock, then quickly edit ingredient B's stock — A's timer is cleared, only B's POST fires. A's edit is in `S.ingredientDb` (frontend state) but never reaches the server.
- **Why it matters**: The optimistic UI shows the edit "stuck" until next reload, when it reverts. Same silent-failure shape as T4/U6 in original audit. Likely rare in practice (users edit one stock at a time), but the pattern is wrong: the debounce key should include the ingredient id.
- **Suggested fix**: Switch to a `Map<ingredientId, timeout>` with per-row timeouts. Or use a queue-based debouncer that flushes a batch every N ms.
- **Confidence**: High.

### A20 — Dead duplicate code in `saveInlineStock` and `openStoragePopover`
- **Severity**: Nit
- **Location**: [public/js/ingredient-db.ts:154-163](public/js/ingredient-db.ts), [public/js/ingredient-db.ts:1127](public/js/ingredient-db.ts).
- **What**:
  - `saveInlineStock` does `S.ingredientDb.find(i => i.id === ingId)` twice with the same predicate, mutating the same field both times (lines 154-158 and 159-163). Looks like artifact of a previous refactor that split `S.ingredientDb` into two arrays then collapsed them back.
  - `openStoragePopover` line 1127: `const ing = S.ingredientDb.find(i => i.id === ingredientId) || S.ingredientDb.find(i => i.id === ingredientId);` — identical lookup repeated as `||` fallback.
- **Why it matters**: Cosmetic. Worth a one-line cleanup.
- **Suggested fix**: Remove the duplicates.
- **Confidence**: High.

### A21 — `tebi-scraper.js` mutates `process.env` for credential isolation between accounts
- **Severity**: Low (today), Medium (if anything else reads those vars)
- **Location**: [scripts/tebi-scraper.js:482-506](scripts/tebi-scraper.js).
- **What**: `runForAccount` does:
  ```js
  const origEmail = process.env.TEBI_EMAIL;
  process.env.TEBI_EMAIL = email;
  try { await login(page); ... } finally { process.env.TEBI_EMAIL = origEmail; }
  ```
  This is in a child process spawned by `lib/tebi-sync.ts` so the blast radius is bounded — but the worker also imports `dotenv` and instantiates Prisma. If a future change adds a telemetry call or any code that reads `TEBI_EMAIL` during the try block, it'd see the wrong account's value. Smell, not bug.
- **Why it matters**: Cross-cutting global mutation as a parameter-passing mechanism. Easy to refactor: pass email/password as args to `login(page, email, password)` instead of mutating env.
- **Suggested fix**: Refactor `login()` to accept credentials as parameters. Removes the env-var mutation entirely.
- **Confidence**: High.

### A22 — `prisma/archive/import-xlsx.js` is "dead by accident" and would resurrect if a Dish/Service model is ever re-added
- **Severity**: Low (today), High (latent landmine)
- **Location**: [prisma/archive/import-xlsx.js:43-55](prisma/archive/import-xlsx.js).
- **What**: First operation is `await prisma.service.deleteMany()` followed by `prisma.dish.deleteMany()`. Both models were dropped from the schema during the v2 migration. So today `prisma.service` is `undefined` and the script throws synchronously before any other deleteMany runs. That's safe — *because it crashes*. If a future schema change re-introduces a `Service` or `Dish` model (unlikely but plausible — the v2 architecture might add a `Service` aggregate one day), suddenly the script would run successfully and wipe Ingredient, RecipeIndex, Catering, TransportItem, GuestHistory, GuestHistoryMeta, GuestsNextWeeks, Log, Feedback, StandardInventory.
- **Why it matters**: A future contributor can't easily reason about why this is "safe." The CLAUDE.md warning ("Don't run anything in `prisma/archive/`") is good, but humans accidentally do anyway.
- **Suggested fix**: 
  1. Delete `prisma/archive/import-xlsx.js` and `migrate-from-sheets.js` outright. The Sheets→PG migration is complete; these are dead historical artifacts. Git keeps them in history if anyone needs to look.
  2. If preserving them matters, add `if (!process.argv.includes('--i-really-want-this')) { console.error('Refusing to run archived migration without --i-really-want-this'); process.exit(1); }` at the top.
- **Confidence**: High.

### A23 — Add Dish modal Recipes tab uses `S.recipeIndex` (legacy empty), Replace Batch correctly uses `S.recipes`
- **Severity**: (Cross-reference for A17, A5)
- **Location**: [public/js/planner.ts:538](public/js/planner.ts) vs [public/js/planner.ts:778](public/js/planner.ts).
- **What**: The same file has BOTH the broken (Add Dish reads `S.recipeIndex`) and correct (Replace Batch reads `S.recipes`) patterns. The Replace flow has a comment explaining the rewrite ("legacy recipeIndex is no longer the source of truth"); the Add Dish flow was missed.
- **Why it matters**: Confirms A17. The fix template exists in the same file — it's a copy-paste of the Replace flow's pattern.
- **Suggested fix**: Bring Add Dish in line with Replace Batch.
- **Confidence**: High.

### A24 — `inventoryDone` uses non-padded month string format (`${y}-${m}-${d}` not `${y}-${mm}-${dd}`)
- **Severity**: Nit
- **Location**: [public/js/planner.ts:1042,1178](public/js/planner.ts).
- **What**: `inventoryDone` keys per-location/meal use `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}` — month is 0-indexed and not zero-padded, so May 2 = `"2026-4-2"`. Self-consistent within this module, but doesn't match `todayIso()` (`"2026-05-02"`) used elsewhere. So `inventoryDone.lunch === todayIso()` would always be false. Today nothing reads it that way (only this module's internal compare), so it's fine.
- **Why it matters**: One refactor that crosses files would fail confusingly.
- **Suggested fix**: Use `todayIso()` here for consistency.
- **Confidence**: High.

