# Tests & Reliability

## Scope of review

- Test files: [test/api.test.ts](test/api.test.ts) (1057 LOC, 25 describes, ~108 `it()` cases), [test/menu-fixer.test.ts](test/menu-fixer.test.ts) (778 LOC), [test/redact-secrets.test.ts](test/redact-secrets.test.ts), [test/location-state.test.ts](test/location-state.test.ts), [test/stock-location.test.ts](test/stock-location.test.ts).
- Test setup: [test/setup-env.ts](test/setup-env.ts), [test/setup-dom-stubs.ts](test/setup-dom-stubs.ts).
- E2E suite: every file in [e2e/](e2e/) (12 spec files, 12 `test()` cases), [e2e/helpers.ts](e2e/helpers.ts), [e2e/coverage-manifest.json](e2e/coverage-manifest.json), [playwright.config.ts](playwright.config.ts).
- CI workflows: [.github/workflows/pr-tests.yml](.github/workflows/pr-tests.yml), [.github/workflows/weekly-coverage.yml](.github/workflows/weekly-coverage.yml).
- Reliability sources: error logging in routes, telemetry frontend [public/js/telemetry.ts](public/js/telemetry.ts), backend [routes/telemetry.ts](routes/telemetry.ts), [lib/ai-analyzer.ts](lib/ai-analyzer.ts).
- Swallowed-promise grep: `.catch(() => {}` and `.catch(e => console.error(...))` patterns.

## Findings

### T1 — `test/stock-location.test.ts` re-implements the function under test in the test file
- **Severity**: High
- **Location**: [test/stock-location.test.ts:11-20](test/stock-location.test.ts).
- **What**: The test imports nothing. It defines local `getDbStockForLoc` and `hasDbStockEntryForLoc` directly in the test file with a comment: "Mirrors what is in public/js/orders.ts — update both together if logic changes." Then it tests the *test-file copy*. The real implementation in `public/js/orders.ts` is never exercised by these 15 `it()` cases.
- **Why it matters**: This test cannot detect regressions. A developer who refactors `getDbStockForLoc` in `orders.ts` and forgets to update the mirror — exactly the case the comment warns about — sees green CI and ships the regression. The test passes regardless of what the production code does. Worst kind of test: it provides confidence without actually testing.
- **Suggested fix**: Two options:
  1. Extract `getDbStockForLoc` and `hasDbStockEntryForLoc` to `shared/stock-helpers.ts` (or `public/js/stock-helpers.ts` if frontend-only) and import them in both `orders.ts` and the test.
  2. If the inline-style is being preserved, at minimum add a snapshot-style assertion that the test-file source matches the production source. `expect(fs.readFileSync('public/js/orders.ts').includes(getDbStockForLocSource))`. Brittle but at least falsifiable.
- **Confidence**: High — the test file shows the pattern explicitly.

### T2 — `npm run typecheck` only typechecks the backend; no frontend type CI gate
- **Severity**: Medium
- **Location**: [package.json:20](package.json), [tsconfig.json](tsconfig.json), [.github/workflows/pr-tests.yml:39-40](.github/workflows/pr-tests.yml).
- **What**: `typecheck` script: `npx tsc -p tsconfig.server.json --noEmit`. The frontend tsconfig has `strict: false` and `noImplicitAny: false` — but more importantly, it's never run in CI. PR tests only typecheck the backend.
- **Why it matters**: The 2026-04-20 lost-recipe production incident ([reports/triage-2026-04-26.md](reports/triage-2026-04-26.md), B1) was a frontend type bug — `body.id` was `undefined` because the frontend payload structure didn't match the backend's expectation. A typechecker pointed at the recipe editor would have caught it.
- **Suggested fix**: Add a second tsc invocation: `tsc -p tsconfig.json --noEmit` (or add a separate `tsconfig.client.json`). Wire it into the `typecheck` script so the existing CI step covers both. Even with `strict: false`, this catches name-typos and signature mismatches.
- **Confidence**: High.

### T3 — Critical write paths are untested at the integration level
- **Severity**: Medium
- **Location**: [test/api.test.ts](test/api.test.ts) — coverage of `routes/data.ts /patch`, `routes/recipes.ts`, etc. is decent but has gaps.
- **What**: 25 describe blocks in `api.test.ts` cover GET/POST for most endpoints. Gaps I noticed:
  - No test of the SSE broadcast path. `events.ts` `broadcast()` is invoked from `data.ts /patch`, `batches.ts`, `recipes.ts` — but there's no test that asserts a connected client *receives* the event after a write.
  - No test that `/patch` validation rejects a stored-XSS-style id (cf S2 in security audit). Even though that's currently underspecified, a future fix would benefit from a regression test.
  - No test that `dbUpsertBatches` correctly nulls a stale parentId (the P2003 retry path). The comment at `lib/db.ts:430-441` cites a real audit-fix; no test guards against re-introduction.
  - No test of the Hanos `add-to-cart` path because it requires real OAuth credentials. The route is mounted, validation is checked at the input level, but the error-handling path with `safeErrMsg` redaction is uncovered.
  - No test of the photo-upload mimetype check (cf S8 — SVG payload).
- **Why it matters**: Several of these are exactly the audit-cited regressions the team has previously fixed. Without tests, the next refactor can re-introduce them silently.
- **Suggested fix**: Pick the 3-4 most likely to bite: SSE broadcast end-to-end, `/patch` parentId-cleanup, photo upload mimetype rejection, broadcast-on-batch-PATCH. Each is one `it()` block of supertest.
- **Confidence**: High.

### T4 — Silent-failure pattern in ingredient/order stock saves
- **Severity**: Medium
- **Location**: [public/js/ingredient-db.ts:167-173](public/js/ingredient-db.ts), [public/js/orders.ts:1539-1543](public/js/orders.ts).
- **What**: 
  ```ts
  fetch('/api/ingredients/stock', {…}).catch(e => console.error('Stock save failed:', e));
  ```
  No toast, no retry, no save-state indicator update. The frontend optimistically reflects the new stock value in the UI, but the server may never have persisted it. The user sees their input "stick" and assumes it saved — until the next page refresh reverts the change.
- **Why it matters**: This is a silent data-loss pattern. Stocktake is a high-stakes workflow (food ordering depends on accurate counts). A flaky network in the kitchen — known issue per the mobile-first design — can lose count entries without warning.
- **Suggested fix**: Pipe the error through `toastError()` and update the save indicator (`setSaveState('error', 'Stock save failed')`). Better: route through `apiPost` so retries and 401-handling are uniform.
- **Confidence**: High.

### T5 — Recipe-cost recalculation runs fire-and-forget; failures only `console.error`
- **Severity**: Low
- **Location**: [routes/ingredients.ts:217-219](routes/ingredients.ts).
- **What**: After a single ingredient save:
  ```ts
  recalcRecipeCostsForIngredient(req.params.id).catch(e => {
    console.error(`Failed to recalculate recipe costs for ingredient ${req.params.id}:`, e);
  });
  ```
  No telemetry event, no AI-insight signal, no log entry. If the recalc starts failing for a class of ingredients, the only way to detect it is reading Railway container logs.
- **Why it matters**: Cited finance-sync incident took 31 days to detect because the failure had the same shape — silent stderr. The same architectural lesson applies.
- **Suggested fix**: Wrap in `addBackendEvent('error', 'recipe_cost_recalc_failed', { ingredientId, message })`. Same pattern as the well-instrumented Tebi sync.
- **Confidence**: High.

### T6 — `dbAppendLog` swallows errors
- **Severity**: Low
- **Location**: [lib/db.ts:491-506](lib/db.ts).
- **What**: 
  ```ts
  try {
    await prisma.log.create({ data: {...} });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    console.error('Log append error:', message);
  }
  ```
  Same shape as T5: stderr only. The log table is the single source of truth for "who changed what" in the activity log, used by the admin UI.
- **Why it matters**: If logging fails (DB constraint, Prisma client crash), no event is generated. Audit trail breaks invisibly.
- **Suggested fix**: At minimum, `addBackendEvent('error', 'log_append_failed', { action, message })`. Better: don't catch — let the global error handler decide. The current "swallow to avoid breaking the user request" pattern is defensible, but the silence is the issue.
- **Confidence**: High.

### T7 — `dbReadAll` returns empty defaults on failure (cross-reference A10)
- **Severity**: Medium
- **Location**: [lib/db.ts:308-313](lib/db.ts).
- **What**: Already covered as A10 in architecture audit. Listed here because reliability-domain readers will look for "DB error visibility": this is the failure mode that looks like silence but is actually catastrophic ("the kitchen sees empty data, assumes someone deleted everything").
- **Why it matters**: See A10.
- **Suggested fix**: See A10.
- **Confidence**: High.

### T8 — Test cleanup uses `Date.now()` prefix, not test-isolation
- **Severity**: Low
- **Location**: [test/api.test.ts:6-21](test/api.test.ts).
- **What**: The pattern `const T = 'test-' + Date.now() + '-'` prefixes test data IDs. afterAll deletes by `startsWith: T`. This works reliably, but two parallel jest invocations (or the rare same-millisecond run) would collide.
- **Why it matters**: pr-tests.yml uses `concurrency: tests-staging-db` to serialise. Locally you can hit it if you `npm test` twice in a second. Mostly fine.
- **Suggested fix**: Bump to `process.pid + Date.now()` or `crypto.randomUUID()` if you ever loosen the concurrency gate.
- **Confidence**: High.

### T9 — `tabindex`-less e2e selectors rely on `data-testid` plus `getByRole` mix
- **Severity**: Low
- **Location**: [e2e/helpers.ts](e2e/helpers.ts) and individual specs.
- **What**: Tests use a mix of `page.getByRole('button', { name: 'Sering West' })` and `page.locator('[data-testid="..."]')`. CLAUDE.md asks for `data-testid` as the stable selector. Some specs (e.g. helpers.ts loginAsDev) use role-based locators.
- **Why it matters**: Not broken. Inconsistent.
- **Suggested fix**: Pick one canonical form. The CLAUDE.md guidance suggests `data-testid` for tests; role-based selectors are nicer for accessibility tests but couple to the visible label (Dutch / English mix worry — see U16).
- **Confidence**: Medium.

### T10 — E2E tests on a shared staging DB rely on best-effort cleanup
- **Severity**: Low
- **Location**: [e2e/helpers.ts:41-69](e2e/helpers.ts).
- **What**: `deleteBatchesByNamePrefix(page, prefix)` deletes batches whose name starts with the prefix. Run inside the page context to inherit auth. Best-effort: if a test crashes before the cleanup line, the row stays.
- **Why it matters**: Slow staging-DB pollution. Visible if you ever inspect the staging data: a graveyard of `e2e-test-*` rows. Doesn't break correctness because subsequent runs use unique prefixes (UUID-based).
- **Suggested fix**: Add a global `globalSetup` / `globalTeardown` in playwright.config that vacuums any rows matching `^e2e-test-` regardless of which suite created them. Or accept the dirt — staging is staging.
- **Confidence**: Medium.

### T11 — `setup-dom-stubs.ts` suppresses sub-5-minute setInterval timers
- **Severity**: Low
- **Location**: [test/setup-dom-stubs.ts:60-65](test/setup-dom-stubs.ts).
- **What**: 
  ```ts
  g.setInterval = (fn, ms, ...args) => {
    if (ms < 5 * 60_000) return 0;
    return realSetInterval(...);
  };
  ```
  This is intentional (telemetry's 30s flush would keep jest alive past `--forceExit`). But it means *any* code under test that sets a sub-5min interval silently does nothing. A future timer-based feature could be wholly broken in tests without anyone noticing.
- **Why it matters**: Hidden side effect that affects the meaning of the test suite. Acceptable trade-off, just under-documented.
- **Suggested fix**: Add a console.log or counter so the test runner can assert "we suppressed N timers this run" if curious. Not high-priority.
- **Confidence**: Medium.

### T12 — No tests for `runDataQualityChecks` or `aggregateTelemetry`
- **Severity**: Low
- **Location**: [lib/ai-analyzer.ts](lib/ai-analyzer.ts).
- **What**: The data-quality and telemetry-aggregation queries that drive the AI insights are pure SQL → JSON. No unit tests. They depend on telemetry table data shape; a schema migration would silently break the cron.
- **Why it matters**: The whole AI insight system is the team's empirical perf-feedback loop. If it breaks, the loop closes.
- **Suggested fix**: Seed a few telemetry rows in the test DB, run `aggregateTelemetry`, assert the shape and counts. Add a `runDataQualityChecks` test with one stale-batch row.
- **Confidence**: High.

### T13 — `recalcRecipeCostsForIngredient` not covered by integration tests
- **Severity**: Low
- **Location**: [test/api.test.ts](test/api.test.ts) — recipe v2 CRUD covers create/read/update, but the side-effect of saving an ingredient triggering recipe-cost recalc isn't asserted.
- **What**: `POST /api/ingredients/:id` schedules a recalc fire-and-forget. The only signal is the next `GET /api/recipes/:id` returning a different `costPerServing`. No test asserts this end-to-end.
- **Why it matters**: Costs in the UI are based on this; a regression in the recalc path silently lets stale costs ship.
- **Suggested fix**: One test: create ingredient with price A, create recipe linking it, assert cost X; update ingredient to price B, sleep 200ms (or poll), GET recipe, assert cost Y.
- **Confidence**: High.

### T14 — `ingredient-import` and `tebi-sync` have no unit/integration tests
- **Severity**: Medium
- **Location**: [routes/ingredients-import.ts](routes/ingredients-import.ts), [lib/tebi-sync.ts](lib/tebi-sync.ts), [scripts/tebi-scraper.js](scripts/tebi-scraper.js), [scripts/tebi-sync-worker.js](scripts/tebi-sync-worker.js).
- **What**: 
  - `/api/ingredients/upload-supplier` (XLSX parsing) is uncovered — relies on real Hanos export shape and would break silently if the format changed.
  - `/api/ingredients/migrate` (CSV merge) untested — last-known to work in March 2026.
  - Tebi sync glue (`lib/tebi-sync.ts`'s state machine, hydration from telemetry) has 0 tests; the scraper itself is browser-driven so harder to test, but the orchestrator should be unit-testable.
- **Why it matters**: These are the integration boundaries with the most upstream-shape change risk. Hanos may rev their XLSX format; Tebi may change their login flow. Without tests, you find out from a user "the sync stopped working a month ago."
- **Suggested fix**: Snapshot a small sample XLSX in `test/fixtures/` and assert the parsed output shape. For tebi-sync, mock `child_process.spawn` and assert the state transitions / telemetry events emitted.
- **Confidence**: High.

### T15 — `e2e/coverage-manifest.json` is the right idea but not enforced
- **Severity**: Low
- **Location**: [e2e/coverage-manifest.json](e2e/coverage-manifest.json), [lib/telemetry-coverage.ts](lib/telemetry-coverage.ts), [.github/workflows/weekly-coverage.yml](.github/workflows/weekly-coverage.yml).
- **What**: Manifest maps each spec to the trackEvent feature names it exercises. Currently 8 of 12 trackEvent calls are covered (`batch_assign_drag`, `finance_sync`, `hanos_send_bulk`, `order_copy` are not). A weekly Claude Code agent files PRs to close gaps. Good system.
- **Why it matters**: The coverage % is currently ~67% by my count. The weekly agent is the closing mechanism; if it stops working (Anthropic API down, agent prompts decay), the gap widens silently.
- **Suggested fix**: Add a CI assertion: read the manifest, grep the source for `trackEvent\(`, fail if there are uncovered names older than N weeks. That makes the weekly-agent a Tier-1 not Tier-2 mechanism.
- **Confidence**: High.

### T16 — No idempotency test on `POST /api/feedback`, `POST /api/data/patch`
- **Severity**: Low
- **Location**: [routes/feedback.ts](routes/feedback.ts), [routes/data.ts](routes/data.ts).
- **What**: Both endpoints are write-only. The frontend `apiPost` catches network errors and retries (with backoff for 5xx). If a request reaches the server, the server processes it, then the response is lost — the frontend retries — the server processes a second time. For batches that's idempotent (`upsert` by id). For feedback it would create a duplicate row.
- **Why it matters**: Each retry of a duplicate `/api/feedback` POST creates another row. Probably rare in practice; worth testing.
- **Suggested fix**: Add a client-generated dedup id to feedback POSTs (UUID per submit attempt); server skips if already saved. Or live with it — duplicate feedback rows are easy to clean up.
- **Confidence**: Medium.

### T17 — No retry / circuit breaker on the AI analysis cron
- **Severity**: Low
- **Location**: [server.ts:56-69](server.ts), [lib/ai-analyzer.ts](lib/ai-analyzer.ts).
- **What**: The daily cron calls `generateInsights()` once at 07:00. Anthropic API down → tomorrow's cron tries again. If the API key is wrong / quota exhausted → silent stderr only (no telemetry event for "AI analysis failed"). The Tebi-sync architecture has telemetry-on-failure; ai-analysis doesn't.
- **Why it matters**: Same dynamic as the Tebi-sync silent failure — you might lose weeks of AI insights without noticing.
- **Suggested fix**: Wrap the cron call in try/catch + `addBackendEvent('error', 'ai_analysis_failed', {...})` so the next-day Tebi-driven AI insights at least notice the gap.
- **Confidence**: High.

## Patterns & themes

- **The team's testing posture is "integration tests against a shared staging DB"** — this is a defensible, fast-feedback choice for a small team. The downside is that pure-logic units (the test/stock-location.test.ts case) get written as inline copies rather than as proper imports, because importing frontend modules into Node tests is annoying without jsdom.
- **The setup-env / playwright-config production-DB guard is the single most important reliability mechanism in this repo**. It works. It's tested implicitly every time CI runs. Keep it.
- **The "fire-and-forget + console.error" pattern is the recurring reliability gap**. T4, T5, T6, T17 all share this shape. The Tebi-sync rewrite ([lib/tebi-sync.ts](lib/tebi-sync.ts)) shows what the corrected pattern looks like — explicit telemetry on failure, hydration on restart. The other paths haven't been migrated yet.
- **The weekly-coverage agent + telemetry-coverage tooling is genuinely novel**. Auto-discover uncovered features, file PRs for them. If the agent quality holds, this closes a category of test-debt that most teams accept indefinitely.
- **`api.test.ts` at 1057 LOC is showing strain.** Splitting per-route would mirror the routes/ structure and make adding tests cheaper. As-is, every new test means scrolling through 25 describe blocks looking for the right home.

## What looked good

- **Production-DB guard in BOTH jest and playwright** ([test/setup-env.ts](test/setup-env.ts), [playwright.config.ts:11-33](playwright.config.ts)). Identical policy in two runners. Refuses to run if DATABASE_URL is prod-shaped. The single sentence at the top of the file explains why this exists ("the planner is live in production"). This is exactly how to prevent test-suite-eats-production incidents.
- **The 2026-04-20 lost-recipe regression has a dedicated test** ([test/api.test.ts:976-1008](test/api.test.ts:976)) — explicit comment cites the triage report. This is institutional memory in code form.
- **Concurrent-write regression test for ingredient stock** ([test/api.test.ts:539+](test/api.test.ts:539)) — fires two parallel `Promise.all` requests, asserts both apply. Tests the lost-update bug that motivated `withWriteLock`. Hard test to write; worth its weight.
- **`menu-fixer.test.ts` (778 LOC, 17 tests)** — pure-logic tests for the planner algorithm, isolated from `S`. Right pattern.
- **`redact-secrets.test.ts`** — small, complete, covers all the patterns the production code claims to handle. Includes negative cases (`username=alice` not redacted).
- **The setup-env guard fragment list is extensible** ([test/setup-env.ts:19-21](test/setup-env.ts)) — adding a new prod-host fragment is one line.
- **CI workflow uses `concurrency: tests-staging-db`** — single shared DB serialised by GitHub. Right call given the constraint (`fullyParallel: false`, `workers: 1` in playwright.config). Avoids the "tests passed locally, race-failed in CI" trap.
- **The coverage manifest** drives a closed feedback loop (telemetry → uncovered features → AI agent → PR). Most internal tools never get to this.
- **`forceExit: true` + `detectOpenHandles: true`** in jest config — catches lingering timers that would otherwise mask issues like T11.
- **E2E `loginAsDev` waits for `/api/data` + `/api/guest-history` + `/api/guests-next-weeks`** ([e2e/helpers.ts:25-31](e2e/helpers.ts)) — comment cites the specific race the wait is solving. Future test authors won't reintroduce it.

---

## Round 2 — deeper findings (added after end-to-end reads)

### T18 — `brSave` stock-deduction silently fails forever — wrong request body shape
**RESOLVED on 2026-05-03 (branch `claude/musing-robinson-acfca7`)**: `brSave` now uses a new pure helper `computeStockDeductionUpdates` that does the read-modify-write client-side and sends a flat array of absolute new stock values to `/api/ingredients/stock/bulk`. Replaced `console.warn` with `toastError`. New unit tests in `test/batch-recipe-stock-deduct.test.ts` (8 cases) pin the wire shape and the math. Verified against staging via `preview_eval`: old shape returns 400, new shape returns 200. Note for follow-up: the batch is PATCHed with `stockDeducted: true` BEFORE the bulk POST, so a bulk failure leaves the batch flagged but stock un-deducted — pre-existing inconsistency, now visible via the toast instead of silent.
- **Severity**: **High** (broken feature, silent)
- **Location**: [public/js/recipe-editor.ts:1444-1452](public/js/recipe-editor.ts), [routes/ingredients.ts:158-175](routes/ingredients.ts).
- **What**: When the user checks "Deduct ingredients from stock after saving" and saves a batch recipe, the code calls:
  ```ts
  await apiPost('/api/ingredients/stock/bulk', {
    location: batch.location,
    updates: stockUpdates.map(u => ({ ingredientId: u.id, amount: u.amount })),
  });
  ```
  But the backend route expects the body to BE the array, not contain one:
  ```ts
  const updates = req.body;
  if (!Array.isArray(updates)) return res.status(400).json({ error: 'Expected array' });
  ```
  So this call returns 400. The client wraps in try/catch with `console.warn('Failed to deduct stock:', e)` — silent failure. The feature has presumably been broken since whenever the bulk endpoint shape changed.
- **Why it matters**: Stock is the core of the planning logic. A cook who relies on the "deduct from stock" toggle thinks they've recorded the cook's ingredient consumption — they haven't. Next stocktake reveals the discrepancy and they'd assume their counts were wrong.
- **Suggested fix**: Either:
  1. Frontend: change to `await apiPost('/api/ingredients/stock/bulk', stockUpdates.map(u => ({ ingredientId: u.id, location: batch.location, amount: u.amount })))` — flat array.
  2. Backend: accept either shape (`Array.isArray(req.body) ? req.body : req.body.updates`) and apply the location consistently.
  
  Plus: change `console.warn('Failed to deduct stock:', e)` → `toastError('Stock deduction failed: ' + ...)`. Silent failures are the recurring reliability bug class (T4, T5, T6). Same pattern.
- **Confidence**: High — verified the shape mismatch by reading both sides.

### T19 — `recalcRecipeCostsForIngredient` finds 0 dirty recipes silently when ingredient pricing changes
- **Severity**: Medium
- **Location**: [routes/ingredients.ts:217](routes/ingredients.ts), `recalcRecipeCostsForIngredient` in [lib/db.ts:858-881](lib/db.ts).
- **What**: After a single ingredient PATCH, the recalc runs fire-and-forget. It only looks for recipes via `prisma.recipeIngredientRow.findMany({ where: { ingredientId } })`. But ingredient prices are also captured in `priceHistory` JSON arrays on the Ingredient itself, and recipe cost depends on `pricePer100` which is derived from `orderPrice / orderUnitSize`. If `applySupplierUpdate` (P19) updates `orderPrice` for 50 ingredients via the bulk POST `/api/ingredients`, that bulk path doesn't trigger any per-ingredient recalc. Result: recipe costs go stale across the board after every supplier-XLSX import.
- **Why it matters**: Cost-per-serving is a planning input the team uses to think about menu pricing. Stale by hours-to-days after a supplier import.
- **Suggested fix**: After the bulk `POST /api/ingredients`, call `recalcRecipeCostsForIngredient` for every changed ingredient — or better, add a `recalcAllRecipeCosts()` that runs once after a bulk write.
- **Confidence**: Medium — need to verify whether the `applySupplierUpdate` POST path actually hits the per-ingredient recalc or skips it. Reading the backend code, the bulk endpoint does NOT call recalc. So recipe costs definitely go stale after supplier updates.

### T20 — Stock-deduct on supplier-XLSX upload bypasses ingredient validators
- **Severity**: Low
- **Location**: [routes/ingredients.ts:71-113](routes/ingredients.ts) (the bulk POST endpoint).
- **What**: The bulk `POST /api/ingredients` accepts `req.body` as `Ingredient[]`, validates only that it's an array, then casts each row to `Ingredient` and writes via `createMany`. There's no per-row validation (no length cap on name, no charset constraint on id, no allergens-string format check). Same issue as A12.
- **Why it matters**: A subverted supplier file or a hand-crafted POST could plant XSS-shaped ids (cf S2) at scale. The XSS S2 vector applies; with the bulk endpoint, an attacker can plant 2100 poisoned ids in one POST.
- **Suggested fix**: Add a `validateIngredients(ingredients)` helper analogous to `validateBatches` and call it before the createMany.
- **Confidence**: High.

### T21 — Tebi worker exits 0 when one account succeeds and another silently writes 0 rows
- **Severity**: Low
- **Location**: [scripts/tebi-sync-worker.js:264-279](scripts/tebi-sync-worker.js).
- **What**: The worker checks `if (totalRowsWritten === 0)` (across all accounts) and `if (failedAccounts === accounts.length)` to decide non-zero exit. But: account 1 writes 50 rows (success) AND account 2 throws `chromium.launch failed` (caught, logged). The current logic treats this as overall success because `totalRowsWritten > 0` and `failedAccounts < accounts.length`. So a partially-broken sync looks healthy in telemetry.
- **Why it matters**: Repeats the same shape as the original 31-day silent-finance-sync incident — partial success masks failure. Would take careful eyes on the AI insights to notice account-2 was missing.
- **Suggested fix**: Track per-account row counts. If any account wrote 0 rows AND wasn't completely missing-creds, emit `addBackendEvent('error', 'tebi_partial_failure', { account, reason })`. Or just exit non-zero when any account failed.
- **Confidence**: High.

### T22 — `_lastReport` in menu-fixer is a module-level singleton — multiple Fix My Menu runs share it
- **Severity**: Nit
- **Location**: [public/js/menu-fixer.ts:1002](public/js/menu-fixer.ts).
- **What**: `let _lastReport: ResultsReport | null = null;` stores the most recent Fix My Menu result. `fixMenuGoto(idx)` and `fixMenuAction(idx, encoded)` look up `_lastReport.warnings[idx]`. If the modal stays open, then the user runs Fix My Menu again, then clicks an old "Go to" button, they'd land on a warning that doesn't match the now-current `_lastReport.warnings[idx]`. Fine for a single user; latent issue for multi-tab scenarios.
- **Why it matters**: Edge case.
- **Suggested fix**: Pass the warning record into the onclick handler (or use closure capture instead of indexing into module state).
- **Confidence**: Medium.

### T23 — `setupOrderInputUX` re-attaches event listeners on every render; no cleanup
- **Severity**: Nit
- **Location**: [public/js/orders.ts:435-447](public/js/orders.ts).
- **What**: Every `renderOrders()` call iterates all `.order-stock-input, .stocktake-input` and adds wheel + keydown listeners. The previous render's DOM is replaced via `innerHTML`, so the old listeners are GC'd along with the elements — no leak. But on re-attach, if the same element somehow survives (unlikely with full innerHTML replace), it'd accumulate listeners. Worth knowing if the renderOrders ever changes to a partial-update model.
- **Why it matters**: Today: fine. Future-defensive note.
- **Suggested fix**: When you migrate to split-container rendering (P20/U21), use event delegation on a stable parent (`#screen-orders`) instead of per-input attachment.
- **Confidence**: High.

### T24 — Production-mode login flow has zero e2e coverage (added 2026-05-04 after a real outage)
- **Severity**: Medium
- **Location**: All e2e specs in [e2e/](e2e/) use the dev-mode login path via [e2e/helpers.ts](e2e/helpers.ts).
- **What**: The Playwright suite boots `npm run preview` with `GOOGLE_CLIENT_ID` unset, so every spec exercises the dev-mode-login button. The production Google Sign-In flow (popup, postMessage handshake, token verification) is never touched by CI. On 2026-05-04 the helmet-S7 fix landed with `Cross-Origin-Opener-Policy: same-origin` (helmet's default). That header severs `window.opener` for cross-origin popups, so Google's popup couldn't post the credential back. Production was broken. The bug was invisible to all 236 unit tests and to the e2e suite.
- **Why it matters**: Auth is the single most important user-facing flow — every other test passes against a logged-in app. We just shipped a header-only change that broke auth and didn't notice until a user reported it. The pattern (helmet bumps, security middleware tweaks, response-header changes) will recur.
- **Suggested fix**: Two layers, smallest first:
  1. **Header regression test** (already landed in PR for T24). `test/api.test.ts` now asserts the response headers don't accidentally re-enable COOP `same-origin` or COEP. This catches the *root cause* of the 2026-05-04 outage at the unit-test layer.
  2. **Production-mode login screen e2e** (deferred). Add a Playwright project that boots `npm run preview` with `GOOGLE_CLIENT_ID=test-fake-id` and asserts the Google Sign-In button renders + the GSI bundle loads without console errors. Won't click through (real Google would reject the fake client id, no creds available), but does exercise the script-load path that production uses. Not landing in the T24 PR — needs a separate playwright config / project to avoid colliding with the dev-login suite.
- **Confidence**: High that layer 1 catches the specific class of bug. Medium that layer 2 is worth the wiring complexity vs. just trusting layer 1 for header issues.
