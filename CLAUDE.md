# CLAUDE.md — Sering Food Planner

## Stack
- **Backend**: Node.js/Express server in TypeScript, compiled to CommonJS for production
- **Frontend**: TypeScript ES modules bundled by Vite (dev: HMR on :5173, prod: static bundle)
- **Database**: PostgreSQL via Prisma ORM, Google Sign-In for auth
- **Google Sheets API**: used for external recipe sheet reading only (lib/recipe-sheets.ts)
- **Hosting**: Railway (auto-deploy from main branch, Postgres plugin). Single dyno today —
  several pieces of state (SSE clients, write locks, Hanos client pool, Tebi sync
  supervisor, telemetry buffer) assume single-replica and would need rework before scaling out.
  Sessions are no longer in this list — they moved to the Postgres `sessions` table.
- **Node**: `>=20.19.0` (`engines.node` in package.json). `npm install` triggers a `postinstall`
  that runs `prisma generate` and downloads Chromium (~300 MB) for the Tebi Playwright scraper.

## Project Structure
```
server.ts              — Express entry point (starts listening, schedules cron jobs)
app.ts                 — Express app, mounts routers, global error handler, gzip + static serving
shared/
  types.ts             — Shared interfaces (Batch, Service, Ingredient, Drink, etc.) used by both backend & frontend
  drink-cost.ts        — Drinks cost engine (pure, dual-use): recursive building-block rollup, labour amortisation, BTW, markup targets, suggested price
  drink-order.ts       — Drinks ordering helpers (pure): suggested qty (par−stock), deposits, received-stock deltas, demand nudge
  drink-production.ts  — Drinks production helpers (pure): produced units (bottles/litres), consumed building blocks, expiry
types/
  express.d.ts         — Express Request augmentation (req.user)
  globals.d.ts         — DOM type augmentations
  multer.d.ts          — Multer module declaration
lib/
  config.ts            — Env vars, AppError, asyncHandler, errMsg, redactSecrets, safeErrMsg, cookieOpts
  db.ts                — Prisma client, row transformers, dbReadAll, validators, dbUpsertBatches, recipe cost/nutrition calc
  recipe-sheets.ts     — Google Sheets client (legacy recipe import only)
  hanos-parser.ts      — Hanos quantity parser (hoeveelheid → grams)
  hanos-client.ts      — Hanos OCC v2 OAuth client class (login pool, cart, product lookup)
  tebi-sync.ts         — Spawn helper for the Tebi Playwright scraper, telemetry hydration, status
  ai-analyzer.ts       — Data quality checks, telemetry aggregation, Claude API insights
  recipe-ai.ts         — Claude tool-use loop for the director-only AI recipe assistant (chatStream, exemplar loading)
  recipe-ai-prompt.md  — System prompt for the AI recipe assistant (loaded by lib/recipe-ai.ts)
  feedback-ai.ts       — Claude tool-use loop for the staff-facing feedback-intake assistant (feedbackChatStream, single propose_report tool, recent-telemetry context loader, pure normalizeReport/summarizeActivity helpers)
  feedback-ai-prompt.md — System prompt for the feedback-intake assistant (loaded by lib/feedback-ai.ts)
  telemetry-coverage.ts — Discovers trackEvent() features in public/js, mines telemetry sessions for user journeys, surfaces uncovered features for the weekly e2e coverage agent
  notion-sync.ts       — One-way sync of the competency chunk library from Notion → Postgres (notionConfigured, syncChunksFromNotion); upsert-only, never deletes
  notion-markdown.ts   — Pure converter: Notion chunk page block tree → canonical `## `-delimited teaching-guide markdown (unit-testable, no I/O)
  drinks.ts            — Drinks normalizers (toDrink, locations/formats/info), stock-pool aggregation, config merge, validation, buildDrinkData, recalcAllDrinkCosts
  drinks-import.ts     — AI menu/price-list import: sends an uploaded PDF to Claude (native document block) → structured product+price list
routes/
  auth.ts              — Login, logout, session, requireAuth + requireDirector middleware,
                         POST /auth/request-access (self-service account request),
                         isEmailAllowed (ALLOWED_EMAILS env ∪ approved access_requests rows)
  data.ts              — GET /api/data (full read) + POST /api/data/patch (targeted merge)
                         POST /api/data returns 410 — superseded by /patch
  batches.ts           — Batch CRUD: GET/POST/PATCH/DELETE /api/batches.
                         Unified-batch stock moves: /:id/ship, /:id/shipments/:sid/arrived,
                         /:id/shipments/:sid/cancel, /:id/transfer
  recipes.ts           — Recipe v2 CRUD + photo + print + versioning + cost recalc.
                         Also hosts GET /api/ingredients/suggest and the legacy
                         GET /api/recipe Google Sheets reader (both mounted under /api).
                         Recipe v1 was sunset in S12 — the /api/recipe-index endpoints
                         and recipe_index table are gone.
  ingredients.ts       — Ingredient CRUD + stock/target-stock + bulk-stock
  ingredients-import.ts — Hanos XLSX upload (POST /api/ingredients/upload-supplier) + CSV migration
  guests.ts            — Guest history + next-weeks predictions
  inventory.ts         — Standard inventory (per-location) + storage config + kitchen equipment + prep checklist + activity log + cook-rhythm + ritual-completions
  feedback.ts          — User feedback POST/PATCH/list (POST accepts the structured assistant fields: title/severity/source/details)
  feedback-ai.ts       — Staff-facing feedback-intake assistant: POST /api/feedback-ai/chat (SSE stream, any signed-in user, NOT director-gated; 503 without ANTHROPIC_API_KEY)
  events.ts            — SSE live sync: client registry, broadcast to other users on save
  health.ts            — Health check endpoint
  hanos.ts             — Hanos status, search, product lookup, add-to-cart, cart view
  finance.ts           — Finance revenue endpoints (delegate to lib/tebi-sync.ts)
  telemetry.ts         — Telemetry event ingestion (no auth, buffered writes, exports flushBuffer)
  admin.ts             — AI insights & telemetry admin endpoints
  recipe-ai.ts         — Director-only AI recipe assistant: POST /api/recipe-ai/chat (SSE stream)
  coverage.ts          — Bearer-token /api/coverage/snapshot (mounted before requireAuth so the weekly remote agent can fetch without a session cookie)
  access.ts            — Director-only account-access review: GET /api/access/requests + /pending-count,
                         POST /api/access/requests/:id/{approve,deny,revoke}
  competencies.ts      — Peer-teaching tracker: chunks, people, teaching-event ledger.
                         GET /api/competencies + POST /events, /people, PATCH /people/:id,
                         DELETE /events/:id, POST /sync-chunks (admin actions staff-lead gated)
  supplies.ts          — Toppings/bread/ferment supplies CRUD: GET/POST/PATCH/DELETE /api/supplies,
                         plus /:id/prep and /:id/stock stock moves (standard ratio + one-off drip-feed)
  drinks.ts            — Drinks module, all under /api/drinks: drink CRUD (+ /:id/photo, /:id/active,
                         /:id/area), /config + /storage-areas (editable areas; renames cascade to stock
                         rows + drink homes), /suppliers, /stock + /stock/bulk (per-area counts; consumes
                         pseudo-areas; returns fresh pools), /orders lifecycle (draft→ordered→received),
                         /production + /write-offs, /assortments, /menus (+ /:id/print A4/A5 HTML),
                         /import/scan + /import/commit (AI PDF import). Money/catalogue writes
                         manager-gated; counts, areas, production, write-offs open to all. See DRINKS_DOMAIN.md
scripts/
  fix-raw-amounts.ts          — One-off recipe ingredient backfill
  import-standard-inventory.js — CSV → DB importer
  import-storage-locations.js  — CSV → DB importer
  seed-staging.js             — Copy prod → staging DB
  snapshot-db.js              — pg_dump-based prod snapshot (used by the unified-batch deploy)
  tebi-scraper.js             — Playwright scraper (called by tebi-sync-worker)
  tebi-sync-worker.js         — Node child process spawned by lib/tebi-sync.ts
  mine-telemetry-journeys.ts  — CLI: scans the telemetry table for user journeys, prints uncovered trackEvent() features
  (tebi-* / backfill-* / probe-* / diagnose-* scripts are catalogued in TEBI.md)
e2e/                          — Playwright end-to-end test suite (run via `npm run test:e2e`)
  smoke.spec.ts               — Login + nav smoke
  navigation.spec.ts          — Each top-level screen
  batch-create.spec.ts, batch-cooked.spec.ts, batch-delete.spec.ts, batch-assign-modal.spec.ts — Batch lifecycle
  guests.spec.ts, orders.spec.ts, recipes.spec.ts — Per-screen flows
  predictions-apply.spec.ts, stocktake-start.spec.ts, feedback-submit.spec.ts — Feature flows
  drinks-catalogue.spec.ts, drinks-stocktake.spec.ts, drinks-order.spec.ts — Drinks flows (add drink, overview auto-save, auto-shortfall order)
  helpers.ts                  — Shared test setup (dev login, location chooser dismiss, deleteDrinksByNamePrefix)
  coverage-manifest.json      — Maps trackEvent() feature names to which spec covers them; consumed by lib/telemetry-coverage.ts
public/
  index.html           — Shell HTML + login screen (single module entry point)
  css/
    base.css           — Variables, resets, layout, shared components, modals
    dashboard.css      — Dashboard cards, prep checklist, team todos
    guests.css         — Guest count tables, predictions, upload zone
    planner.css        — Week grid, dish list, slots, inventory, cook workflow
    orders.css         — Order tabs, ingredient tables, ingredient DB styles
    recipes.css        — Recipe library table
    recipe-editor.css  — Recipe v2 editor styles
    finance.css        — Finance dashboard styles
    feedback.css       — Feedback FAB and form
    team.css           — Login "request access" affordance, dashboard "waiting for access" banner, Team screen
    drinks.css         — All drinks-screen styles (catalogue table, bar cards, stocktake areas, orders, menus, per-category accents)
    tutorial.css       — Tutorial overlay and tooltips
    mobile.css         — All mobile/responsive overrides, bottom nav
  js/
    main.ts            — Entry point: imports all modules, assigns onclick functions to window, calls bootstrap()
    state.ts           — Constants, NAV_SCREENS, storage config helpers, global state object S
    auth.ts            — Google Sign-In, sessions
    utils.ts           — apiGet/apiPost, save system, toast, prep checklist, SSE, todayIso (local)
    core.ts            — rebuildPlanner, calcRequired, diffStr, badges, isServicePast
    init.ts            — buildNav(), initApp, bootstrap. Re-exports modal helpers from modal.ts.
    modal.ts           — showModal, closeModal, esc, modal escape handler
    navigate.ts        — Renderer registry: registerRenderer, getCurrentScreen, rerenderCurrentView
    undo.ts            — Undo manager: pushUndo (5s deferred-save), executeUndo, flushUndo
    dashboard.ts       — Dashboard screen
    predictions.ts     — Guest prediction from POS CSV data
    guests.ts          — Guest count tables
    planner.ts         — Week plan grid + transport + inventory modal
    transport-card.ts  — Transport card component (shipment send / mark-arrived UI)
    menu-fixer.ts      — "Fix My Menu": auto-fills week-plan gaps with generated placeholder batches
    dishes.ts          — Dish list + cook workflow + CRUD
    caterings.ts       — Catering events
    recipes.ts         — Recipe library: sortable table of v2 recipes
    recipe-editor.ts   — Recipe v2 editor (multi-step modal), detail view with scaling, batch recipe editor with scaling, post-cook recording
    recipe-ai-chat.ts  — Director-only AI recipe assistant chat panel (SSE client for /api/recipe-ai/chat)
    orders.ts          — Order overview (combined, standard inventory, dish ingredients tabs) + Hanos
    stocktake.ts       — Stocktake flow (area picker → count inputs → bulk save)
    ingredient-db.ts   — Ingredient database editor + supplier import
    finance.ts         — Finance screen (revenue dashboard, sync, week nav)
    feedback.ts        — Legacy one-shot "quick note" form (openQuickFeedback) — the escape hatch reached from the chat header
    feedback-ai-chat.ts — Default feedback flow: AI intake chat (SSE client for /api/feedback-ai/chat) + editable "here's what I'll send Daan" proposal card → POST /api/feedback (source='assistant'). The FAB's openFeedback now points here
    feedback-admin.ts  — Feedback admin screen (renders structured assistant cards: title, severity, source badge, was-doing/expected)
    team.ts            — Director-only Team screen: review/approve/deny/revoke account-access requests
    competencies.ts    — Training screen: people × chunks teaching grid, log-event modal, public ledger
    chunk-guide.ts     — Pure helper: split a chunk's teaching-guide markdown into `## ` sections (shared by competencies.ts)
    supplies.ts        — "Toppings & bread" screen: standard/one-off supplies editor, per-guest demand + price
    drinks.ts          — Drinks screen shell: sub-tab bar, Catalogue tab (needed/stock/cost-%/active, location toggle),
                         type-specific drink form, suppliers tab + form, AI PDF import UI
    drinks-constants.ts — Drinks enums: categories/subtypes, glass types, serving temps; drinkAreasFor reads the
                         config-driven storage areas (defaults in shared/types DEFAULT_DRINK_STORAGE_AREAS)
    drinks-category-fields.ts — Single per-category field spec driving BOTH the drink edit form and the bar cards
    drinks-recipe.ts, drinks-stocktake.ts, drinks-order.ts, drinks-production.ts, drinks-service.ts,
    drinks-menu.ts     — Per-tab drinks modules: recipes + live costing, by-area stock overview (inline auto-save),
                         auto-shortfall ordering, production/write-offs, bar reference cards, assortments + menu designer
    ritual.ts          — Pure daily-ritual model: per-location step list with derived done(ctx) predicates + clock/phase logic
    today-panel.ts     — Always-on dashboard "Today" panel: renders ritual.ts as a phase-grouped, deep-linked checklist
    telemetry.ts       — Frontend telemetry collection (errors, screen views, feature usage)
    tutorial.ts        — Guided tutorial system
test/                  — 35 *.test.ts files (run `ls test/*.test.ts`). Grouped below by area; keep new tests here.
  api.test.ts          — API integration tests (Jest + @swc/jest)
  batch-recipe-stock-deduct.test.ts — Batch recipe editor stock-deduction logic
  batch-construction.test.ts — Guard: UI-built Batch literals match the canonical shape
  batch-delete-guard.test.ts — Regression (CORR-1): /api/data/patch delete-guard
  inventory-helpers.test.ts — Unified-batch inventory/shipment helper functions
  inventory-disappear-investigation.test.ts — Regression: batches surviving "Do inventory"
  inventory-modal-stale-index.test.ts — Regression: Do-inventory modal stale-index routing
  cook-confirm.test.ts — Inventory cook-confirm dish-filter unit tests
  shipment-flow.test.ts — Batch ship / arrive / transfer / cancel flow
  migration.test.ts    — Unified-batch data-migration script
  maintenance.test.ts  — MAINTENANCE_MODE write-gate
  menu-fixer.test.ts   — "Fix My Menu" placeholder algorithm
  core-demand.test.ts  — Fix-My-Menu demand-calc equivalence guard
  fmm-bench.test.ts    — Fix-My-Menu scored-engine regression bench
  planner-pool.test.ts — getPoolBatches location-tab visibility unit tests
  catering-demand.test.ts — Catering demand-retirement logic
  closed-services.test.ts — Closed-services demand roll-back
  guests-carryforward.test.ts — Week-specific guest-count carry-forward
  transport-card.test.ts — Transport card component
  recipe-ai-apply-tool.test.ts — Recipe-AI tool-use apply logic
  access-request.test.ts — Account-access request + director approval flow
  competencies-api.test.ts — Competencies API round-trip (people, events, screen-load)
  chunk-guide.test.ts  — Teaching-guide markdown `## `-section splitter
  notion-markdown.test.ts — Notion block tree → teaching-guide markdown converter
  ritual.test.ts       — Daily-ritual model (public/js/ritual.ts) unit tests
  supplies.test.ts     — Supplies API CRUD + stock-move smoke test
  supply-demand.test.ts — Supply per-guest demand / price helpers
  location-state.test.ts — Frontend setGlobalLocation / restoreGlobalLocation unit tests
  stock-location.test.ts — Frontend getDbStockForLoc / hasDbStockEntryForLoc unit tests
  redact-secrets.test.ts — lib/config redactSecrets / safeErrMsg unit tests
  feedback-ai.test.ts  — Feedback-intake assistant pure helpers (normalizeReport enum coercion, summarizeActivity telemetry formatting)
  xlsx-api-smoke.test.ts — Supplier XLSX upload smoke test
  drinks-helpers.test.ts — Drinks normalizers (formats/locations incl. area passthrough), BTW, stock map, config, validation
  drink-cost.test.ts   — Drinks cost engine (recursive rollup, labour, markup, suggested price)
  drink-order.test.ts  — Drinks ordering helpers (suggested qty, deposits, received deltas, nudge)
  drink-production.test.ts — Drinks production helpers (produced units, consumed blocks, write-off delta)
  setup-env.ts         — Test DB guard: refuses prod hosts, swaps in DATABASE_URL_TEST
  setup-dom-stubs.ts   — DOM/localStorage stubs for frontend-logic tests
.github/workflows/
  sync-staging.yml     — Manual: copy prod → staging
  pr-tests.yml         — Typecheck + Jest + Playwright e2e on PRs to main and pushes to main
  weekly-coverage.yml  — Weekly Claude Code agent that runs the e2e suite, fetches /api/coverage/snapshot, files PRs to add tests for uncovered features
.claude/agents/
  weekly-test-coverage.md — Prompt + tool list for the weekly coverage agent (consumed by .github/workflows/weekly-coverage.yml)
prisma/
  schema.prisma        — Source of truth for the DB shape
  seed.js              — First-deploy seeding from seeds/*.json (only when tables are empty)
  migrations/          — Forward-only migrations. DEPLOY.md + drop-cols.sql document the
                         unified-batch deploy sequence (a manual psql step deliberately
                         kept outside Prisma's migration loader)
tsconfig.json          — Frontend TypeScript config (ESNext modules, DOM libs)
tsconfig.server.json   — Backend TypeScript config (CommonJS output to dist/server/)
vite.config.ts         — Vite config (root: public/, proxy /api to :3000, @shared alias)
playwright.config.ts   — Playwright e2e config (boots `npm run preview` on :3000 against the test DB)
```

## Build & Dev

```bash
npm run dev            # Vite on :5173 (frontend HMR) + tsx on :3000 (backend)
npm run build          # Vite build + tsc backend → dist/
npm run preview        # Build + serve on :3000 (single port, for Claude preview)
npm start              # node dist/server/server.js (production)
npm test               # Jest with @swc/jest. Unit + API tests (35 files in test/).
                       # Requires DATABASE_URL_TEST pointing at a scratch DB —
                       # test/setup-env.ts refuses to run against production.
                       # See "Testing" section below.
npm run test:e2e       # Playwright end-to-end suite. Runs `npm run preview` on
                       # :3000 first, then drives a headless browser through
                       # the dev-mode-login flow and through each screen.
                       # Specs live in e2e/. Requires DATABASE_URL_TEST.
npm run test:e2e:ui    # Same suite, but in Playwright's UI runner (good for debugging).
npm run test:all       # npm test && npm run test:e2e — full local test pass.
npm run telemetry:mine # CLI: scans the telemetry table for user journeys, prints
                       # uncovered trackEvent() features. Used by the weekly
                       # coverage agent and for ad-hoc local exploration.
npm run typecheck      # tsc --noEmit — backend (tsconfig.server.json) +
                       # frontend (tsconfig.json). typecheck:server and
                       # typecheck:client run a single side.
```

Requires `DATABASE_URL` env var pointing to PostgreSQL.
Without `GOOGLE_CLIENT_ID` set, runs in dev mode (no real auth).
`AUTH_MODE=production` (set on the Railway prod env, not in dev/staging) makes server.ts refuse to boot if `GOOGLE_CLIENT_ID` or `ALLOWED_EMAILS` is empty, and disables the dev-mode bypass in `routes/auth.ts`. Decoupled from `NODE_ENV` so `npm run preview` (which sets `NODE_ENV=production`) keeps using dev login.
Optional: `ANTHROPIC_API_KEY` for AI analysis, `AI_ANALYSIS_CRON` (default `0 7 * * *`), `AI_ANALYSIS_MODEL` (default `claude-sonnet-4-6`). `ANTHROPIC_API_KEY` also powers the director-only AI recipe assistant — `DIRECTOR_EMAILS` (comma-separated; defaults to Daan's email) controls who can use it. The same key powers the staff-facing **feedback-intake assistant** (`POST /api/feedback-ai/chat`, open to any signed-in user; 503 without the key); `FEEDBACK_AI_MODEL` overrides its model (default `claude-opus-4-8` — set e.g. `claude-haiku-4-5` to cut cost on this higher-volume all-staff feature).
Optional (Drinks): `MANAGER_EMAILS` (comma-separated) is the drinks **manager** tier — `isManagerEmail` = directors ∪ `MANAGER_EMAILS` (`routes/auth.ts`). Managers own catalogue CRUD, prices/costs, supplier data, ordering, assortments and menu publishing; stock counts, storage-area assignment, production, write-offs and recipe drafts are open to any signed-in user. The AI PDF import (`/api/drinks/import/*`) also needs `ANTHROPIC_API_KEY` (503 without it).
Optional: `MAINTENANCE_MODE=1` puts the app in read-only mode (writes return 503, reads/SSE keep working) for deploy windows — see `prisma/migrations/DEPLOY.md`.
Optional: `COVERAGE_API_KEY` for the weekly e2e coverage agent — required for `GET /api/coverage/snapshot` (returns 503 if unset). The endpoint is mounted before `requireAuth` so a remote agent can fetch with a `Bearer <key>` header instead of a session cookie.
Optional (Competencies): `STAFF_LEAD_EMAILS` (comma-separated) gates the Competencies admin actions — chunk sync, teaching-event deletion, person rename/(de)activate. This is the staff-lead role, distinct from and independent of `DIRECTOR_EMAILS`; both default to no one having the role until set. The Notion chunk-library sync needs `NOTION_TOKEN` + `NOTION_CHUNKS_DATA_SOURCE_ID` (both required — `notionConfigured()` is false and the sync silently no-ops if either is missing); `COMPETENCY_SYNC_CRON` (default `0 5 * * *`) schedules the daily pull.
Finance sync (Tebi): `TEBI_EMAIL` + `TEBI_PASSWORD` for Ledger 1 (Sering West, default ledger `723192`). For the second account/ledger (TestTafel + Centraal, `724466`), set `TEBI_LEDGER_ID_2=724466` and `TEBI_EMAIL_2` + `TEBI_PASSWORD_2`.
Note on the `_2` env vars: only `scripts/tebi-sync-worker.js` reads them. The app-level `tebiConfigured` check (`lib/tebi-sync.ts`) and `runTebiSync` refusal logic look at the primary `TEBI_EMAIL`/`TEBI_PASSWORD` only. If `TEBI_LEDGER_ID_2` is set but the `_2` credentials are not, the worker silently falls back to primary creds — only valid if one Tebi account spans both ledgers (no longer the case as of 2026-04-26). Profit centers auto-discovered by label; set `TEBI_FORCE_LOCATION=west` to bypass discovery if needed.

**For anything Tebi-related — auth, endpoint catalogue, the post-2026-05-07 product_top + filter pipeline, GuestHistory auto-update, common failure modes, diagnostic scripts — see [`TEBI.md`](TEBI.md).** That doc is the single source of truth for the integration; update it when you fix or extend something.

**For the drinks module — domain model (catalogue vs recipe drinks, building blocks, per-area stock with pseudo-area reconciliation, costing/BTW/markup rules, permission tiers) — see [`DRINKS_DOMAIN.md`](DRINKS_DOMAIN.md)**, with the build/decision log in `DECISIONS.md`.

## Preview (for Claude Code verification)
Use `preview_start` with `name: "preview"` (not `"dev"`). The `dev` script runs two
servers via `concurrently` which breaks the preview tool. The `preview` config builds
the full app and serves everything on one port — no cookie issues, no dual-server
confusion. After the page loads, click the "Dev mode login" button to bypass auth.

## Conventions
- Frontend uses ES module imports/exports, bundled by Vite
- Functions referenced in inline `onclick=""` handlers are assigned to `window` in `main.ts`
- State lives in the global `S` object (typed as `AppState` in state.ts)
- Each screen has a render function: `renderDashboard()`, `renderOrders()`, etc.
- **Renderer registry**: each screen module calls `registerRenderer('dashboard', renderDashboard)` at import time (see `public/js/navigate.ts`). `rerenderCurrentView()` looks up the renderer by string key. Don't import other screens' render fns directly — register and look up.
- **`showScreen()` lives in `navigate.ts`** — the screen switcher. It dispatches through the renderer registry, so it doesn't import each screen's render function directly.
- **Destructive actions use `pushUndo`** (`public/js/undo.ts`), not `confirm()` browser dialog. 5s deferred-save with a "undo" toast. Used by `deleteBatch`, `deleteCatering`, `deleteV2Recipe`, etc.
- **SSE patches must flush pending undo before applying** — `init.ts` registers `setFlushUndo(flushUndo)` so `applyRemotePatch` commits any pending soft-delete before merging an incoming snapshot.
- `scheduleSave()` debounces auto-save to PostgreSQL
- Date format: ISO "YYYY-MM-DD" for service dates, "DD-MM-YYYY" for cook dates in UI. `todayIso()` in `utils.ts` returns local Y-M-D (don't use `toISOString().slice(0,10)` — it's UTC).
- Location keys: "west", "centraal" (in data), "Sering West"/"Sering Centraal" (display)
- Server writes use `withWriteLock()` to serialize concurrent writes
- Backend async route handlers wrapped with `asyncHandler()` (`lib/config.ts`) so unhandled rejections route to the global error handler. Throw `AppError(status, message)` for typed HTTP errors.
- Backend errors that surface to clients should use `safeErrMsg(e)` (redacts password/secret/token/Bearer/Basic patterns). Use raw `errMsg(e)` for console.* logs only.
- Every write endpoint logs the user action with `dbAppendLog(user.email, user.name, action, details)` — surfaces in the activity log via `GET /api/log`.
- `addBackendEvent('error'|'feature_use'|..., name, data)` (`routes/telemetry.ts`) is the side-channel for backend events. Errors that don't reach this function won't surface in AI insights.
- `compression()` middleware in `app.ts` deliberately skips `/api/events`, `/api/recipe-ai/chat`, and `/api/feedback-ai/chat` (all stream SSE and must not be buffered). Don't break this filter.
- Prisma schema in `prisma/schema.prisma` — run `npx prisma migrate dev` after changes
- Navigation screens defined in `NAV_SCREENS` array (state.ts) — add new screens there, not in HTML
- CSS split into per-screen files in `public/css/` — add new screen styles to the matching file
- Shared types in `shared/types.ts` — used by both backend and frontend via `@shared` alias (Vite) or relative import (backend)

## TypeScript Patterns
- **Backend is `strict: true`. Frontend is currently `strict: false` — being flipped per the audit plan.** Until then, the frontend has accumulated `any` usage; new frontend code should still avoid `any`.
- **Never use `any`** in new code — use proper types, `unknown` for catch blocks, or specific interfaces
- **Catch blocks**: always `catch (e: unknown)` — use `errMsg(e)` from `lib/config.ts` on the backend (or `safeErrMsg(e)` for client-facing rendering), or `e instanceof Error ? e.message : 'Unknown error'` on the frontend
- **Domain constants**: use string literal union types from `shared/types.ts` (`Location`, `Meal`, `DishType`, `StorageType`) — not plain `string`
- **Prisma ↔ TypeScript boundary**: when writing JSON fields to Prisma, cast with `as unknown as Prisma.InputJsonValue`; when reading, cast back with `as unknown as Batch` or map fields explicitly with `as Batch['type']`
- **Global state**: `S` is typed as `AppState` (defined in state.ts) — add new fields to the `AppState` interface, not with ad-hoc properties
- **DOM access**: no catch-all `any` on HTMLElement — use proper casts like `(el as HTMLInputElement).value`
- **Window functions**: the `Window` index signature `[key: string]: any` is kept only for the `onclick` handler pattern in `main.ts` — don't rely on it for new code
- **Single Prisma client**: always import `prisma` from `lib/db.ts` in app code — never create separate `new PrismaClient()` instances. One-off `scripts/*.js` are exempt (they need their own client outside the request lifecycle).

## Search/Filter Input Rule
When a search or filter input triggers a re-render, **never replace the input's own DOM element**.
Use the split-container pattern: put results in a separate `<div id="xxx-results">` and only update that.
- Screen-level: render the search input once in the parent, update only `#results-container.innerHTML`
- Modal-level: on first open call `showModal()` with full HTML; on subsequent updates check for an existing element (e.g. `document.getElementById('my-list')`) and only replace the list innerHTML
- See `recipes.ts` (`renderRecipeIndex` + `updateRecipeResults`) and `planner.ts` (`renderAddModal`) for examples

## Key Data Flow
- `GET /api/data` returns `{batches, guests, recipes, caterings, transportItems}` — `recipes` is the v2 recipes array (denormalized with ingredient details). The legacy `recipeIndex` field and `recipe_index` table were removed in S12.
- `POST /api/data` → 410 Gone (was the legacy delete-all path; superseded by `/patch`).
- `POST /api/data/patch` merges `{batches, deletedBatches, guests, caterings, ...}` — uses targeted upserts/deletes (not delete-all/create-all), merges batch fields with existing DB rows
- Batch CRUD: `GET/POST /api/batches`, `GET/PATCH/DELETE /api/batches/:id`. Unified-batch stock moves: `POST /api/batches/:id/ship`, `.../shipments/:sid/arrived`, `.../shipments/:sid/cancel`, `.../transfer`
- Batch = physical container of food. Lifecycle: PLANNED → COOKED → SERVING → DONE
- **Unified-batch model** (shipped May 2026): a batch's physical stock lives in `inventory` (array of `{loc, storage, qty, cookDate}` settled-stock entries) and `shipments` (array of in-flight transfers between locations). This replaced the old per-batch `location`/`storage`/`stock`/`inTransit` columns and the `parentId` split/merge model. `BATCH_SCHEMA_VERSION` in `shared/types.ts` bumps on every breaking Batch shape change; the SSE handler force-reloads stale clients.
- Other key batch fields: `services` (embedded JSON), `cookDate`, `note`, `generated` (true only for Fix-My-Menu placeholders)
- Cannot delete a batch with inventory stock or pending shipments > 0 (real food exists)
- Recipe v2: `GET /api/recipes`, `GET /api/recipes/:id`, `POST /api/recipes`, `PATCH /api/recipes/:id`, `DELETE /api/recipes/:id`. Photo: `POST/DELETE /api/recipes/:id/photo`. Versioning: `POST /api/recipes/:id/version`. Print: `GET /api/recipes/:id/print`. Cost recalc: `POST /api/recipes/recalculate-costs`.
- Recipe ingredient suggestion: `GET /api/ingredients/suggest?category=X&loc=west` — lives in `routes/recipes.ts`, mounted under `/api`. Don't look for it in `routes/ingredients.ts`.
- Ingredient endpoints: `/api/ingredients`, `/api/ingredients/full`, `/api/ingredients/:id`, `/api/ingredients/stock`, `/api/ingredients/stock/bulk`, `/api/ingredients/target-stock`
- Supplier upload: `POST /api/ingredients/upload-supplier` (XLSX).
- Ingredient DB stores JSON fields: `types`, `storageLocations`, `stock`, `nutrition`, `priceHistory`, `targetStock` (Prisma Json type)
- Ingredient constants in state.ts: `INGREDIENT_TYPES`, `INGREDIENT_CATEGORIES`, `PRICE_LEVELS`
- Storage config: `GET/POST /api/storage-config` — per-location areas with colors, order, and spots (persisted as JSON)
- `STORAGE_CATEGORIES` is dynamically rebuilt from `S.storageConfig` via `rebuildStorageCategories(loc)`
- Standard inventory: `GET/POST /api/standard-inventory?location=west|centraal` — per-location weekly base order
- Prep checklist: `GET/POST /api/prep-checklist?loc=west&date=YYYY-MM-DD`
- Kitchen equipment: `GET/POST /api/kitchen-equipment` — pots, gas/induction burners, big-burner threshold (single JSON row)
- Closed services: `GET/POST /api/closed-services` — per-location open/closed service schedule (recurring weekday rules + per-date overrides, single JSON row). A service can be marked closed (no seating) while the guest/staff demand registered to it still gets cooked: its demand rolls onto the previous open service at the same location. Implemented as a once-per-rebuild roll-map in `public/js/core.ts` (`buildRollMap`/`getEffectiveGuests`/`previousOpenService`) that all demand consumers read; edited inline on the Guests screen (per-cell open/closed control), and closed slots render greyed with a red "Closed" label on the week planner.
- Cook rhythm: `GET/POST /api/cook-rhythm` — single JSON row of editable Fix-My-Menu per-weekday rules (`{ days: { Mon: {soup,main,chefs}, ... } }`); the frontend merges it over built-in defaults
- Ritual completions: `GET/POST /api/ritual-completions?loc=west&date=YYYY-MM-DD` — per-(location,date) array of done step-keys for the dashboard "Today" panel; only signal-less steps are stored (the rest are derived). Modelled on prep-checklist; rows pruned after a few days
- Activity log: `GET /api/log` (last 50 actions, oldest first)
- Guest history and next-weeks have their own endpoints with flat↔nested JSON conversion
- Finance: `GET /api/finance/revenue?start=...&end=...&location=...`, `GET /api/finance/products?...`, `POST /api/finance/sync`, `POST /api/finance/sync-cancel`, `GET /api/finance/sync-status`. Status auto-hydrates from telemetry on first call after a restart.
- Admin: `POST /api/admin/analyze`, `GET /api/admin/insights`, `PATCH /api/admin/insights/:id`, `GET /api/admin/telemetry/summary`
- Recipe AI: `POST /api/recipe-ai/chat` — director-only SSE chat for the AI recipe assistant (gated by `DIRECTOR_EMAILS`; requires `ANTHROPIC_API_KEY`, else 503)
- Feedback: `GET/POST/PATCH /api/feedback` (list / create / mark processed). The POST takes either the legacy quick fields (`type`, `text`, `screen`) or the assistant's structured fields (`title`, `severity`, `source='assistant'`, `details` JSON `{doing, expected, transcript}`). Feedback AI: `POST /api/feedback-ai/chat` — SSE intake chat open to any signed-in user; streams `text` deltas + a `proposal` event (the editable report card) via the `propose_report` tool, grounded by a recent-telemetry hint. Requires `ANTHROPIC_API_KEY` (else 503)
- Competencies (Training): `GET /api/competencies` (chunks + people + events + `isStaffLead`), `POST /api/competencies/events`, `POST /api/competencies/people` (both open to any signed-in user — kiosk model), `PATCH /api/competencies/people/:id`, `DELETE /api/competencies/events/:id`, `POST /api/competencies/sync-chunks` (last three staff-lead gated via `STAFF_LEAD_EMAILS`). Chunk content pulls one-way from Notion (`lib/notion-sync.ts`)
- Supplies (Toppings & bread): `GET/POST /api/supplies`, `PATCH/DELETE /api/supplies/:id`, `POST /api/supplies/:id/prep` (add to pool + stamp lastMakeDate), `POST /api/supplies/:id/stock` (set absolute; zeroing a one-off auto-archives it). `kind` is `standard` (per-guest ratio + prep horizon) or `oneoff` (drip-feed per service)
- Access requests: `POST /api/auth/request-access` (unauthenticated — verifies a Google token, then records/looks-up a pending request; one row per email). Director-only review: `GET /api/access/requests`, `GET /api/access/pending-count`, `PATCH /api/access/requests/:id` (edit first/last name), `POST /api/access/requests/:id/{approve,deny,revoke}`. The effective login allowlist is `ALLOWED_EMAILS` (env, the bootstrap backbone) ∪ `access_requests` rows with status `approved` — see `isEmailAllowed()` in routes/auth.ts. Approving grants access with no env edit / redeploy; the prod fail-closed boot guard is unchanged. A denied login auto-records a pending request rather than dead-ending. The request form collects first + last name (a director can edit it via PATCH); approving also creates/links a Training (competencies) `Person` — deduped by name — so approved accounts seed the training roster. Stored in the `access_requests` table (`AccessRequest` model). Surfaced by the director-only **Team** screen + a dashboard "waiting for access" badge.
- Live sync: `GET /api/events` (SSE) — clients receive patches from other users in real-time. `broadcast()` in events.ts sends to all connected clients except the sender (matched by email). Frontend `applyRemotePatch()` merges into state and re-renders. Snapshot updates are targeted (only remote items), so unsaved local changes survive incoming patches.

## Testing
- `npm test` runs against **`DATABASE_URL_TEST`**, not `DATABASE_URL`. The planner is live in production — the test suite's `afterAll` block issues `deleteMany` calls that would mutate real records.
- `test/setup-env.ts` enforces this: if `DATABASE_URL_TEST` is set it overrides `DATABASE_URL`; if `DATABASE_URL` points at a known production host and `DATABASE_URL_TEST` is not set, jest refuses to start.
- Point `DATABASE_URL_TEST` at a scratch local Postgres, or at staging (`shuttle.proxy.rlwy.net:52350`). Tests use `test-<timestamp>-` prefixed IDs so they can share a DB with other data, but the DB must not be production.
- Worktrees don't inherit `.env` from the main repo — copy it when creating one.
- To add a new prod host fragment to the guard, edit `PROD_HOST_FRAGMENTS` in `test/setup-env.ts`.
- Frontend state modules (e.g. `public/js/state.ts`) can be unit-tested without a DB by importing them directly. The jest config has a `moduleNameMapper` for `@shared/types` so the Vite alias resolves in Node. Mock `localStorage` in the test file (`Object.defineProperty(global, 'localStorage', ...)`) since Jest runs in Node without browser globals.

### End-to-end tests (Playwright)
- Specs live in `e2e/`. Run with `npm run test:e2e` (headless) or `npm run test:e2e:ui` (UI runner). Use the `data-testid="..."` attribute on any element a spec needs to find — the existing specs depend on a small set of stable testids and adding a new selector to the markup is preferred over fragile text matching.
- `playwright.config.ts` boots `npm run preview` on :3000 against `DATABASE_URL_TEST` and waits for the dev-mode login button before running tests. `e2e/helpers.ts` handles the dev-login + location-chooser ceremony.
- The e2e suite is *not* part of `npm test`. It runs in `npm run test:e2e`, in CI on every PR (`.github/workflows/pr-tests.yml`), and weekly via `.github/workflows/weekly-coverage.yml`, which:
  1. Runs the suite,
  2. Calls `GET /api/coverage/snapshot` (bearer-auth via `COVERAGE_API_KEY`),
  3. Spawns a Claude Code agent (`/.claude/agents/weekly-test-coverage.md`) to file PRs for any uncovered `trackEvent()` features.
- New `trackEvent('feature_name')` calls in the frontend automatically widen the "uncovered features" surface until covered by a spec — see `lib/telemetry-coverage.ts:discoverKnownFeatures`.

## Don't
- Don't change the Prisma schema without creating a migration (`npx prisma migrate dev`)
- After any migration, always verify `prisma/schema.prisma` matches the DB: run `npx prisma db pull` then `npx prisma generate`, and ensure all fields use camelCase with `@map("snake_case")`. Commit the updated schema in the same PR.
- Don't remove withWriteLock from write endpoints
- Don't run `npm test` against production — use `DATABASE_URL_TEST`
- Don't surface raw `errMsg(e)` to clients in error handlers — use `safeErrMsg(e)` so credentials in upstream error bodies don't leak
