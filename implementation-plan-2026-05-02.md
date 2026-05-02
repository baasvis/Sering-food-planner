# Implementation plan — combined audits (2026-05-02)

**Source:** merges findings from [audit-2026-05-01.md](audit-2026-05-01.md) (this worktree) and the parallel zen-lewin audit (referenced in conversation), with priority arbitration in the audit-comparison reply.

**Approach:** small, self-contained slices. Test after each. Commit after each green. Stop and debug if any slice goes red — don't pile on.

---

## Status note (2026-05-02)

**Migration-requiring slices are all blocked** by drift between this worktree's
migration history and staging. The parallel "Fix My Menu" branch (`f8ff6e2`,
`ee3eb04`, `2109bf3`) added `Batch.generated` and applied
`20260501142833_add_batch_generated` to staging without merging to main.
`prisma migrate dev` therefore refuses without resetting staging.

Affected slices: **S4 (schema housekeeping), S10 (pricePer100g drop),
S11 (sessions to Postgres), S12 (sunset Recipe v1)**.

Resume order once the parallel branch lands on main:
1. Rebase this worktree on the merged main.
2. Verify `npx prisma migrate status` is clean against staging.
3. Run S4, S10, S11, S12 as written.

Until then: skip them and continue with S5–S9 and S13–S16, all of which are
code-only changes that don't touch the schema.

## Pre-flight

Before slice 1:
1. Confirm we're working on this worktree (`elastic-volhard-ef95ad`), branch `claude/elastic-volhard-ef95ad`, currently 0 commits ahead of main.
2. `npm install` once to make sure node_modules is fresh.
3. `npm test` once to capture the green baseline (98 tests passing).
4. `npm run typecheck` once for the same.

After every slice:
- `npm run typecheck` (mandatory — fast)
- `npm test` (mandatory if backend touched)
- Preview boot + click-through (mandatory if frontend touched) — `preview_start name: "preview"`, click "Dev mode login", smoke-test the affected screen
- Commit with message like `Slice <n>: <title>` and the audit IDs that closed (e.g. `closes audit §1.1, §1.4`)

If a slice goes red: don't proceed. Either fix in place or revert and re-plan.

---

## Phase 1 — Quick wins (low risk, ~1.5 hr total)

### Slice 1 — Silent bug pass (30 min)

Six small fixes, all independent, all <30 lines each:

| Change | File | Closes |
|---|---|---|
| Convert `futureDays` to weekday names before querying `Guest.day` | `lib/ai-analyzer.ts:77-94` | mine §1.1 — AI guest-day query bug |
| `todayIso()` use local date, not `toISOString().slice(0,10)` | `public/js/utils.ts:567` | mine §1.4 — TZ midnight bug |
| `await flushBuffer()` in SIGTERM handler before `prisma.$disconnect()` | `server.ts:105-109` | mine §4.5 — telemetry flush race |
| Remove `clientSecretLen` from `_diag` response | `routes/hanos.ts:20-28` | Z H6 — secret-length side channel |
| Add `mask(s)` to `errMsg` rendered for HTTP/telemetry; redact `password|secret|token|client_secret` | `lib/config.ts` (extend) + use sites in `routes/hanos.ts`, `lib/tebi-sync.ts` | Z H5 / S2 — credentials in error paths |
| Return 410 Gone (not 200) from legacy `POST /api/data` to discourage callers | `routes/data.ts:13-30` | mine §1.8 — legacy delete-all path still alive |

**Test protocol:** `npm test` (existing tests must stay green). Preview boot. Trigger a console error, confirm it's masked.

**Commit:** `Slice 1: silent-bug pass (AI guest-day, todayIso TZ, SIGTERM flush, Hanos diag, cred masking, legacy POST)`

---

### Slice 2 — Doc refresh (40 min)

Pure documentation, no code changes:

| Change | File | Closes |
|---|---|---|
| Add missing files to `public/js/` and `lib/` lists | `CLAUDE.md` | mine §5 HIGH 1, 5; Z §6 |
| Fix `init.ts` description (modal system moved to `modal.ts`) | `CLAUDE.md` | mine §5 HIGH 2 |
| Update test count: "98 tests across 3 files" | `CLAUDE.md`, `DESIGN.md` | mine §5 HIGH 3; Z §6 |
| Add `recipes` to documented `/api/data` shape | `CLAUDE.md` | mine §5 HIGH 4 |
| Note that `GET /api/ingredients/suggest` lives in `routes/recipes.ts` | `CLAUDE.md` | mine §5 HIGH 6 |
| Document undocumented patterns (registerRenderer, pushUndo, asyncHandler convention, addBackendEvent, dbAppendLog, compression-skips-SSE, single-replica assumption) | `CLAUDE.md` (new "Conventions" subsection) | mine §5 |
| Fix data-model table: Catering/Guests/Transport are Prisma models, not AppState JSON | `DESIGN.md` | mine §5 + Z §6 |
| Add `recipe-editor.css` to CSS list | `DESIGN.md` | mine §5 |
| Replace SETUP_GUIDE.md with current-stack version (Postgres, Prisma, Vite, Railway) | `SETUP_GUIDE.md` | mine §5 + Z C4 |

**Test protocol:** read review only.

**Commit:** `Slice 2: refresh CLAUDE.md, DESIGN.md, SETUP_GUIDE.md to match current stack`

---

### Slice 3 — CI workflow + dependency safety (30 min)

| Change | File | Closes |
|---|---|---|
| Add `.github/workflows/test.yml` running `npm run typecheck` + `npm test` on push and PR. Use staging `DATABASE_URL_TEST` from secrets. | new file | Z H12 |
| Pin major versions: `typescript@~5.7`, `vite@~6`, `jest@~29`, `@types/node@~22` (or current LTS-aligned). Test build still works. | `package.json` + `package-lock.json` | Z §12 |

**Test protocol:** `npm install && npm run build && npm test` (clean install). Push branch and confirm GitHub Actions workflow runs.

**Commit:** `Slice 3: add test CI workflow + pin major dep versions`

---

## Phase 2 — Schema housekeeping (low risk, ~45 min)

### Slice 4 — Schema + index housekeeping (45 min)  **— DEFERRED 2026-05-02**

**Status:** deferred until the parallel "Fix My Menu" branch (commits `f8ff6e2`,
`ee3eb04`, `2109bf3`) lands on main. That branch added a `Batch.generated`
boolean and applied its migration to staging (`20260501142833_add_batch_generated`)
without merging to main. Running `prisma migrate dev` from this worktree therefore
detects drift and refuses to proceed without resetting staging.

The slice itself is safe and low-risk; it just needs the parallel branch in main
first so my migration can be ordered cleanly after it.

**To resume:** rebase this worktree on the merged main, then re-do the slice
(schema + types + seeds + migration). Same content as below.

One migration covering several additive/safe changes:

| Change | Closes |
|---|---|
| `@@index([parentId])` on `Batch` | Z H4 |
| `@@index([ingredientId])` on `RecipeIngredientRow` | Z H4 |
| `@@index([mondayKey])` on `GuestsNextWeeks` | Z H4 |
| Add `@relation` between `RecipePhoto` and `Recipe` with `onDelete: Cascade` (and the reverse side on `Recipe`) | mine §1.6 |
| Drop dead columns `orderUnitStandard`, `orderAmountGrams` from `Ingredient` | Z verified §3.6 mine + dead-column finding |
| Rename `prisma/archive/import-xlsx.js` and `migrate-from-sheets.js` → `*.archived.js`. Add header comment: "DO NOT RUN. Historical script, would deleteMany on production tables." | Z §9 — verified 13 unguarded deleteMany calls |

**Test protocol:** `npx prisma migrate dev --name slice_4_schema_housekeeping` against staging DB. `npm test`. Preview boot.

**Commit:** `Slice 4: add FK indexes, RecipePhoto relation, drop dead columns, neutralize archive scripts`

---

## Phase 3 — Type + structure consolidation (~3 hr)

### Slice 5 — Frontend strict mode (2-3 hr)

| Change | Closes |
|---|---|
| `tsconfig.json` → `strict: true`, `noImplicitAny: true` | Z C2 |
| Resolve resulting errors. Most fixes: import types from `@shared/types`, type DOM access casts, replace `: any` with proper types. | mine §3.6 (132 `any`s, concentrated in 5 files) |
| Type `apiGet`/`apiPost` return as `Promise<T>` with generic, not `Promise<any>` | Z C2 |

**Risk:** this touches many files but is mechanical. The compiler does the verification. Risk is wasting time on a single-file blocker — worst case, that file gets `// eslint-disable` markers and a follow-up TODO.

**Test protocol:** `npm run build` must succeed. `npm run typecheck` clean. Preview every major screen (Dashboard, Guests, Planner, Recipes, Orders, Finance, Feedback). No console errors.

**Commit:** `Slice 5: enable strict mode on frontend tsconfig`

---

### Slice 6 — Centralize cross-cutting helpers (60 min)

| Change | Closes |
|---|---|
| New `shared/units.ts` with `toGrams(amount, unit)`. Replace 3 duplicates: `lib/db.ts:743`, `public/js/recipe-editor.ts:105`, `public/js/orders.ts:105` (`toBaseUnit`). | Z 8.3 |
| New `shared/dates.ts` with `formatIso(d)`, `todayIso()`, `addDays(d, n)`, `weekdayShort(d)`, `mondayKeyOf(d)`. Replace `dateToIso`, `localDateStr`, `fmtDate`, and 4 duplicates of the Date stamp pattern. | mine §3.3, Z 8.1 |
| New `locName(loc)` in `shared/location.ts` (or `state.ts`). Replace 30-42 sites of `loc === 'west' ? 'Sering West' : 'Sering Centraal'`. | mine §3.4, Z 8.2 |
| New `eligibleBatches(loc)` helper in `public/js/core.ts`. Replace 5 exact + 5 near-clone sites in `orders.ts`, `dashboard.ts`. | Z 8.6 |

**Test protocol:** typecheck + npm test + preview all screens that use these (Orders, Dashboard, Planner, Recipes, Finance).

**Commit:** `Slice 6: centralize date/unit/location/eligible-batches helpers`

---

### Slice 7 — Error dialect + asyncHandler conversion (30 min)

| Change | Closes |
|---|---|
| Convert all handlers in `routes/hanos.ts` to `asyncHandler` + `AppError`. Remove manual try/catch. | mine §3.2, Z H5 |
| Convert all handlers in `routes/ingredients-import.ts` to `asyncHandler` + `AppError`. | mine §3.2 |
| Verify global handler (`app.ts:110-128`) handles these cleanly, with production message-suppression. | — |

**Test protocol:** `npm test`. Preview Orders → Hanos status (if HANOS env set, otherwise just confirm the call returns).

**Commit:** `Slice 7: convert hanos and ingredients-import to asyncHandler+AppError`

---

## Phase 4 — Correctness (~3 hr)

### Slice 8 — withWriteLock + upsert pass (90 min)

Wrap ~22 unguarded write endpoints. For each: either (a) wrap in `withWriteLock(async () => {...})`, or (b) replace delete-all/create-all with per-row upserts (preferred where possible).

| Endpoint | Approach | Closes |
|---|---|---|
| `POST /api/ingredients/stock` | wrap | mine §3.1 (lost-update) |
| `POST /api/ingredients/stock/bulk` | wrap | mine §3.1 |
| `POST /api/ingredients/target-stock` | wrap | mine §3.1 |
| `POST /api/ingredients/:id` | wrap | mine §3.1 |
| `POST /api/ingredients` | wrap (still delete-all but locked) | mine §3.1 |
| `DELETE /api/ingredients/:id` | wrap | mine §3.1 |
| `POST /api/standard-inventory` | wrap | mine §3.1 |
| `POST /api/storage-config` | wrap | mine §3.1 |
| `POST /api/prep-checklist` | wrap | mine §3.1 |
| `POST /api/guest-history` | **per-row upsert** instead of delete-all | mine §9.1 |
| `POST /api/guests-next-weeks` | **scope deleteMany by mondayKey set in body** + per-row upsert | mine §1.7 |
| `POST /api/recipes/:id/version` | wrap (lost-update on JSON array) | mine §3.1 |
| `POST /api/recipes/:id/photo`, `DELETE /api/recipes/:id/photo` | wrap | mine §3.1 |
| `POST /api/recipes/recalculate-costs`, `POST /api/recipes/import-cooked-amounts` | wrap | mine §3.1 |
| `PATCH /api/feedback/:id`, `PATCH /api/admin/insights/:id` | wrap | mine §3.1 |
| `POST /api/recipe-index` legacy | leave as-is (Slice 12 will delete it) | — |

**Test protocol:** `npm test` (existing tests must pass). Add new test for two simultaneous writes to `POST /api/ingredients/stock` — both must apply, not lose one. Preview Orders + Ingredient DB to confirm behavior unchanged.

**Commit:** `Slice 8: wrap remaining write endpoints in withWriteLock; convert guest-history and guests-next-weeks to per-row upsert`

---

### Slice 9 — Validation surface (60 min)

| Change | Closes |
|---|---|
| Add `validateCatering`, `validateTransportItem` in `lib/db.ts` with shape checks. | Z M11 |
| Tighten `validateRecipe` to also check ingredients array, allergens, prep steps, `servingSize > 0` (currently allows 0 → division-by-zero downstream). | Z M10 |
| Validate `deletedBatches`, `deletedCaterings`, `deletedTransportItems` in `POST /api/data/patch`: must be string arrays, max 500 items. | mine §6.1 |
| Validate `caterings`, `transportItems` arrays in `POST /api/data` and `POST /api/data/patch`. | mine §3.5 |
| Add Multer `fileFilter` for XLSX upload (`routes/ingredients-import.ts:10`) — accept only `application/vnd.openxmlformats-*` and `text/csv`. | Z M9 |
| Tighten `CateringDish.type` from `DishType \| string` to `DishType` only. | Z M17 |

**Test protocol:** `npm test` + add tests for invalid inputs (oversized arrays, wrong types, missing fields). Preview save flow.

**Commit:** `Slice 9: add validators for caterings/transport/recipe ingredients + patch arrays + Multer file filter`

---

### Slice 10 — pricePer100g cleanup (45 min)

| Change | Closes |
|---|---|
| Migration: `UPDATE ingredients SET price_per_100 = price_per_100g WHERE price_per_100 = 0 AND price_per_100g > 0`. | mine §1.2 |
| Migration: `ALTER TABLE ingredients DROP COLUMN price_per_100g`. | mine §1.2, Z verified §3.6 |
| Update all 6 read sites in `lib/db.ts` to use `pricePer100` only (drop the `\|\| pricePer100g` fallback). | mine §1.2 |
| Update `routes/recipes.ts:613` and `select` clauses. | mine §1.2 |
| Drop `pricePer100g?: number` from `shared/types.ts:256`. | mine §1.2 |

**Test protocol:** `npx prisma migrate dev --name slice_10_drop_price_per_100g`. `npm test`. Preview Recipes (cost calc must show non-zero) and Ingredient DB.

**Commit:** `Slice 10: backfill and drop redundant pricePer100g column`

---

## Phase 5 — User-facing fixes (~90 min)

### Slice 11 — Sessions to Postgres (90 min)

Closes the U1 "I keep getting logged off" complaint. This is the single highest-impact user-facing fix.

| Change | Closes |
|---|---|
| Add `Session` model: `id String @id`, `email String`, `name String`, `picture String?`, `createdAt DateTime`, `expiresAt DateTime`. Index on `expiresAt` for cleanup. | Z C1 / mine §2.4 / triage U1 |
| Migration. | — |
| In `routes/auth.ts`: replace `sessions = new Map()` with Prisma-backed reads/writes. `getSessionUser` does `prisma.session.findUnique({where:{id}})` and checks `expiresAt`. | — |
| Add `expiresAt` 7-day TTL aligned with cookie maxAge. | — |
| Add a daily cleanup cron (in `server.ts` alongside the others) to `prisma.session.deleteMany({where:{expiresAt:{lt:now}}})`. | — |
| Logout: `prisma.session.delete`. | — |

**Test protocol:** `npm test` (auth tests must stay green). Manual flow: log in, kill the dev server, restart, reload — must stay logged in. Existing cookie still resolves to a valid Session row.

**Commit:** `Slice 11: persist sessions to Postgres with TTL — closes U1 'logged off too soon'`

---

## Phase 6 — Cleanup & sunset (~3 hr)

### Slice 12 — Sunset Recipe v1 (90 min)

Coordinated removal across frontend + backend + DB.

| Change | Closes |
|---|---|
| Frontend: remove 5 write sites that POST to `/api/recipe-index` (`public/js/core.ts:397`, `public/js/recipes.ts:331, 399, 447, 465`). Re-route ratings to v2 endpoint or drop the rating-from-served path. | mine §1.3 |
| Frontend: remove "legacy" recipe-index UI from `public/js/recipes.ts`. | mine §2.5 |
| Backend: delete legacy routes `GET /api/recipe-index`, `POST /api/recipe-index`, `DELETE /api/recipe-index/:id` from `routes/recipes.ts`. | mine §2.5 |
| Schema: drop `Batch.recipeSheetId`, `Batch.recipeIngredients` columns; drop `RecipeIndex` model. | mine §6.3, Z H3 |
| Migration with backup snapshot first. | — |
| Drop `recipeIndex: RecipeEntry[]` from `DataResponse` (`shared/types.ts:280`). Drop `recipeIndex: []` filler from `lib/db.ts:218-219`. Drop `RecipeEntry` type if fully unused. | mine §2.5 |
| Drop `S.recipeIndex` from `state.ts`. | — |
| Update `toBatchRow` and the inline `dbReadAll` Batch reader to stop round-tripping the dropped fields. | mine §6.3 |

**Test protocol:** **Take a Postgres snapshot first** (Railway lets you point-in-time restore, but a manual `pg_dump` of the staging DB is cheap insurance). `npx prisma migrate dev --name slice_12_sunset_recipe_v1`. `npm test`. Preview the rate-a-dish flow (after a batch is "served"), Recipes screen, Planner add-batch flow.

**Commit:** `Slice 12: sunset Recipe v1 — drop RecipeIndex table, legacy routes, dead Batch columns, frontend writes`

---

### Slice 13 — Unify ingredient DB state (90 min)

| Change | Closes |
|---|---|
| Replace `S.ingredientDb` (in `state.ts`) and `ingredientDbFull` (in `ingredient-db.ts:11`) with a single `S.ingredients: Map<string, Ingredient>` (or array; pick one). | mine §3.7 |
| Update all 6 write paths in `ingredient-db.ts` to write through one place. | mine §3.7 |
| Update reads across `orders.ts`, `recipes.ts`, `recipe-editor.ts`, etc. | — |
| Remove `ingredientDbLoaded`, `ingredientDbError` flags or merge into one. | — |

**Test protocol:** `npm test`. Preview: edit ingredient → orders cost reflects immediately, no stale prices. Standard inventory item updates flow through. Stocktake works.

**Commit:** `Slice 13: unify S.ingredientDb and ingredientDbFull into single source of truth`

---

### Slice 14 — Unify stocktake implementations (45 min)

| Change | Closes |
|---|---|
| Decide: keep the dashboard modal version or the orders full-screen version. (Likely modal — fits the dashboard "today's tasks" model.) | Z H8 |
| Move shared logic to `public/js/stocktake.ts`. | — |
| Delete the duplicate state vars in the loser. | — |

**Test protocol:** preview both entry points (orders tab + dashboard chip).

**Commit:** `Slice 14: unify stocktake into single implementation`

---

## Phase 7 — Bigger refactors (optional, ~3-4 hr)

### Slice 15 — Move `showScreen()` to `navigate.ts` (15 min)

Finishes the half-done router migration.

| Change | Closes |
|---|---|
| Move `showScreen()` from `dashboard.ts:25-47` to `navigate.ts`. Imports stay the same since renderers self-register. | mine §2.2 |
| Remove now-unused renderer imports from `dashboard.ts`. | — |

**Test protocol:** preview every screen — they must all render via the registry.

**Commit:** `Slice 15: move showScreen() to navigate.ts (finishes router migration)`

---

### Slice 16 — File splits (3 hr — optional, biggest)

Split the 6 oversized frontend files and 2 backend files per audit §10. Do `orders.ts` first (largest, biggest payoff). Each file split is its own commit.

**Hold off on this slice** unless we have time + appetite. Slices 1-15 deliver the most value-per-hour.

---

## Effort summary

| Phase | Slices | Effort |
|---|---|---|
| 1 — Quick wins | 1, 2, 3 | ~1.5 hr |
| 2 — Schema housekeeping | 4 | ~45 min |
| 3 — Type + structure | 5, 6, 7 | ~3 hr |
| 4 — Correctness | 8, 9, 10 | ~3 hr |
| 5 — User-facing | 11 | ~90 min |
| 6 — Cleanup & sunset | 12, 13, 14 | ~3 hr |
| 7 — Refactor | 15, 16 | ~3-4 hr (16 optional) |
| **Total (1-15)** | | **~13 hr** |

The user-visible wins all land by end of Phase 5 (Slice 11 closes "logged off"; Slice 1 stops AI-insight noise; Slice 10 fixes cost drift).

---

## Stopping points

Natural pause points if we don't go all the way through:

- **After Phase 1**: docs are honest, CI is in place, silent bugs fixed. Already a big upgrade.
- **After Phase 4**: codebase is correct (types, locks, validation). User experience unchanged but foundation tightened.
- **After Phase 5**: "logged off too soon" complaint resolved. This is the most-felt user win.
- **After Phase 6**: dead code gone, two-source-of-truth bugs removed. Mid-term simplification done.
- **After Phase 7**: maintenance shape ready for the next year of features.
