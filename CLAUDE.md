# CLAUDE.md — Sering Food Planner

## Stack
- **Backend**: Node.js/Express server in TypeScript, compiled to CommonJS for production
- **Frontend**: TypeScript ES modules bundled by Vite (dev: HMR on :5173, prod: static bundle)
- **Database**: PostgreSQL via Prisma ORM, Google Sign-In for auth
- **Google Sheets API**: used for external recipe sheet reading only (lib/recipe-sheets.ts)
- **Hosting**: Railway (auto-deploy from main branch, Postgres plugin)

## Project Structure
```
server.ts              — Express entry point (starts listening)
app.ts                 — Express app, mounts routers, global error handler
shared/
  types.ts             — Shared interfaces (Batch, Service, Ingredient, etc.) used by both backend & frontend
types/
  express.d.ts         — Express Request augmentation (req.user)
  globals.d.ts         — DOM type augmentations
  multer.d.ts          — Multer module declaration
lib/
  config.ts            — Configuration, env vars
  db.ts                — Prisma client, row transformers, dbReadAll/dbWriteAll, validators
  recipe-sheets.ts     — Google Sheets client (external recipe reading only)
  hanos-parser.ts      — Hanos quantity parser (hoeveelheid → grams)
  ai-analyzer.ts       — Data quality checks, telemetry aggregation, Claude API insights
routes/
  auth.ts              — Login, logout, session, requireAuth middleware
  data.ts              — GET/POST /api/data + POST /api/data/patch (main planner state)
  batches.ts           — Batch CRUD: GET/POST/PATCH/DELETE /api/batches
  recipes.ts           — Recipe index CRUD + single recipe fetch + Recipe v2 CRUD + photo + print + versioning + cost recalc
  ingredients.ts       — Ingredient CRUD + stock management
  ingredients-import.ts — Hanos XLSX upload + CSV migration
  guests.ts            — Guest history + next-weeks predictions
  inventory.ts         — Standard inventory (per-location) + storage config + prep checklist + activity log
  feedback.ts          — User feedback
  events.ts            — SSE live sync: client registry, broadcast to other users on save
  health.ts            — Health check endpoint
  hanos.ts             — Hanos OCC v2 API client (OAuth, cart, product lookup)
  finance.ts           — Finance revenue endpoints
  telemetry.ts         — Telemetry event ingestion (no auth, buffered writes)
  admin.ts             — AI insights & telemetry admin endpoints
public/
  index.html           — Shell HTML + login screen (single module entry point)
  css/
    base.css           — Variables, resets, layout, shared components, modals
    dashboard.css      — Dashboard cards, prep checklist, team todos
    guests.css         — Guest count tables, predictions, upload zone
    planner.css        — Week grid, dish list, slots, inventory, cook workflow
    orders.css         — Order tabs, ingredient tables, ingredient DB styles
    recipes.css        — Recipe index table
    recipe-editor.css  — Recipe v2 editor styles
    finance.css        — Finance dashboard styles
    feedback.css       — Feedback FAB and form
    tutorial.css       — Tutorial overlay and tooltips
    mobile.css         — All mobile/responsive overrides, bottom nav
  js/
    main.ts            — Entry point: imports all modules, assigns onclick functions to window
    state.ts           — Constants, NAV_SCREENS, storage config helpers, global state object S
    auth.ts            — Google Sign-In, sessions
    utils.ts           — API helpers (apiGet/apiPost), save system, toast, prep checklist, SSE
    core.ts            — rebuildPlanner, calcRequired, diffStr, badges, isServicePast
    dashboard.ts       — showScreen(), Dashboard screen
    predictions.ts     — Guest prediction from POS CSV data
    guests.ts          — Guest count tables
    planner.ts         — Week plan grid + transport + inventory modal
    dishes.ts          — Dish list + cook workflow + CRUD
    caterings.ts       — Catering events
    recipes.ts         — Recipe index/library (legacy + v2 unified list)
    recipe-editor.ts   — Recipe v2 editor (multi-step modal), detail view with scaling, batch recipe editor with scaling, post-cook recording
    orders.ts          — Order overview (combined, standard inventory, dish ingredients tabs)
    ingredient-db.ts   — Ingredient database editor + supplier import
    finance.ts         — Finance screen (revenue dashboard, sync, week nav)
    feedback.ts        — Feedback form
    feedback-admin.ts  — Feedback admin screen
    telemetry.ts       — Frontend telemetry collection (errors, screen views, feature usage)
    tutorial.ts        — Guided tutorial system
    init.ts            — Modal system, esc helper, buildNav(), beforeunload guard, initApp
test/
  api.test.ts          — API integration tests (Jest + @swc/jest)
tsconfig.json          — Frontend TypeScript config (ESNext modules, DOM libs)
tsconfig.server.json   — Backend TypeScript config (CommonJS output to dist/server/)
vite.config.ts         — Vite config (root: public/, proxy /api to :3000, @shared alias)
```

## Build & Dev

```bash
npm run dev            # Vite on :5173 (frontend HMR) + tsx on :3000 (backend)
npm run build          # Vite build + tsc backend → dist/
npm run preview        # Build + serve on :3000 (single port, for Claude preview)
npm start              # node dist/server/server.js (production)
npm test               # Jest with @swc/jest (74 API tests). Requires DATABASE_URL_TEST
                       # pointing at a scratch DB — test/setup-env.ts refuses to run
                       # against production. See "Testing" section below.
npm run typecheck      # tsc --noEmit on backend
```

Requires `DATABASE_URL` env var pointing to PostgreSQL.
Without `GOOGLE_CLIENT_ID` set, runs in dev mode (no real auth).
Optional: `ANTHROPIC_API_KEY` for AI analysis, `AI_ANALYSIS_CRON` (default `0 7 * * *`), `AI_ANALYSIS_MODEL` (default `claude-sonnet-4-6`).
Finance sync (Tebi): `TEBI_EMAIL` + `TEBI_PASSWORD` for Ledger 1 (Sering West, default ledger `723192`). For the second account/ledger (TestTafel + Centraal, `724466`), set `TEBI_LEDGER_ID_2=724466` and `TEBI_EMAIL_2` + `TEBI_PASSWORD_2`. Backward compatibility: if `TEBI_LEDGER_ID_2` is set but the `_2` credentials are not, the primary `TEBI_EMAIL/PASSWORD` are reused (only valid when one Tebi account spans both ledgers, no longer the case as of 2026-04-26). Profit centers auto-discovered by label; set `TEBI_FORCE_LOCATION=west` to bypass discovery if needed.

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
- `rerenderCurrentView()` refreshes the active screen
- `scheduleSave()` debounces auto-save to PostgreSQL
- Date format: ISO "YYYY-MM-DD" for service dates, "DD-MM-YYYY" for cook dates in UI
- Location keys: "west", "centraal" (in data), "Sering West"/"Sering Centraal" (display)
- Server writes use `withWriteLock()` to serialize concurrent writes
- Prisma schema in `prisma/schema.prisma` — run `npx prisma migrate dev` after changes
- Navigation screens defined in `NAV_SCREENS` array (state.ts) — add new screens there, not in HTML
- CSS split into per-screen files in `public/css/` — add new screen styles to the matching file
- Shared types in `shared/types.ts` — used by both backend and frontend via `@shared` alias (Vite) or relative import (backend)

## TypeScript Patterns
- **Never use `any`** — use proper types, `unknown` for catch blocks, or specific interfaces
- **Catch blocks**: always `catch (e: unknown)` — use `errMsg(e)` from `lib/config.ts` on the backend, or `e instanceof Error ? e.message : 'Unknown error'` on the frontend
- **Domain constants**: use string literal union types from `shared/types.ts` (`Location`, `Meal`, `DishType`, `StorageType`) — not plain `string`
- **Prisma ↔ TypeScript boundary**: when writing JSON fields to Prisma, cast with `as unknown as Prisma.InputJsonValue`; when reading, cast back with `as unknown as Batch` or map fields explicitly with `as Batch['type']`
- **Global state**: `S` is typed as `AppState` (defined in state.ts) — add new fields to the `AppState` interface, not with ad-hoc properties
- **DOM access**: no catch-all `any` on HTMLElement — use proper casts like `(el as HTMLInputElement).value`
- **Window functions**: the `Window` index signature `[key: string]: any` is kept only for the `onclick` handler pattern in `main.ts` — don't rely on it for new code
- **Single Prisma client**: always import `prisma` from `lib/db.ts` — never create separate `new PrismaClient()` instances

## Search/Filter Input Rule
When a search or filter input triggers a re-render, **never replace the input's own DOM element**.
Use the split-container pattern: put results in a separate `<div id="xxx-results">` and only update that.
- Screen-level: render the search input once in the parent, update only `#results-container.innerHTML`
- Modal-level: on first open call `showModal()` with full HTML; on subsequent updates check for an existing element (e.g. `document.getElementById('my-list')`) and only replace the list innerHTML
- See `recipes.ts` (`renderRecipeIndex` + `updateRecipeResults`) and `planner.ts` (`renderAddModal`) for examples

## Key Data Flow
- `GET /api/data` returns `{batches, guests, recipeIndex, caterings, transportItems}`
- `POST /api/data` saves `{batches, guests, caterings, transportItems}`
- `POST /api/data/patch` merges `{batches, deletedBatches, guests, caterings, ...}` — uses targeted upserts/deletes (not delete-all/create-all), merges batch fields with existing DB rows
- Batch CRUD: `GET/POST /api/batches`, `GET/PATCH/DELETE /api/batches/:id`
- Batch = physical container of food. Lifecycle: PLANNED → COOKED → SERVING → DONE
- Key batch fields: `location` ("west"/"centraal"), `inTransit` (bool), `services` (embedded JSON), `cookDate`, `note`
- Cannot delete a batch with stock > 0 (real food exists)
- Ingredient DB has separate endpoints: `/api/ingredients`, `/api/ingredients/full`, `/api/ingredients/:id`
- Ingredient stock endpoints: `/api/ingredients/stock`, `/api/ingredients/stock/bulk`
- Ingredient migration: `POST /api/ingredients/migrate` (accepts oldCsv + hanosCsv, supports `?dryRun=true`)
- Ingredient DB stores JSON fields: `types`, `storageLocations`, `stock`, `nutrition`, `priceHistory` (Prisma Json type)
- Ingredient constants in state.ts: `INGREDIENT_TYPES`, `INGREDIENT_CATEGORIES`, `PRICE_LEVELS`
- Storage config: `GET/POST /api/storage-config` — per-location areas with colors, order, and spots (persisted as JSON)
- `STORAGE_CATEGORIES` is dynamically rebuilt from `S.storageConfig` via `rebuildStorageCategories(loc)`
- Standard inventory: `GET/POST /api/standard-inventory?location=west|centraal` — per-location weekly base order
- Guest history and next-weeks have their own endpoints with flat↔nested JSON conversion
- Live sync: `GET /api/events` (SSE) — clients receive patches from other users in real-time. `broadcast()` in events.ts sends to all connected clients except the sender (matched by email). Frontend `applyRemotePatch()` merges into state and re-renders. Snapshot updates are targeted (only remote items), so unsaved local changes survive incoming patches.

## Testing
- `npm test` runs against **`DATABASE_URL_TEST`**, not `DATABASE_URL`. The planner is live in production — the test suite's `afterAll` block issues `deleteMany` calls that would mutate real records.
- `test/setup-env.ts` enforces this: if `DATABASE_URL_TEST` is set it overrides `DATABASE_URL`; if `DATABASE_URL` points at a known production host and `DATABASE_URL_TEST` is not set, jest refuses to start.
- Point `DATABASE_URL_TEST` at a scratch local Postgres, or at staging (`shuttle.proxy.rlwy.net:52350`). Tests use `test-<timestamp>-` prefixed IDs so they can share a DB with other data, but the DB must not be production.
- To add a new prod host fragment to the guard, edit `PROD_HOST_FRAGMENTS` in `test/setup-env.ts`.
- Frontend state modules (e.g. `public/js/state.ts`) can be unit-tested without a DB by importing them directly. The jest config has a `moduleNameMapper` for `@shared/types` so the Vite alias resolves in Node. Mock `localStorage` in the test file (`Object.defineProperty(global, 'localStorage', ...)`) since Jest runs in Node without browser globals.

## Don't
- Don't change the Prisma schema without creating a migration (`npx prisma migrate dev`)
- After any migration, always verify `prisma/schema.prisma` matches the DB: run `npx prisma db pull` then `npx prisma generate`, and ensure all fields use camelCase with `@map("snake_case")`. Commit the updated schema in the same PR.
- Don't remove withWriteLock from write endpoints
- Don't run `npm test` against production — use `DATABASE_URL_TEST`
