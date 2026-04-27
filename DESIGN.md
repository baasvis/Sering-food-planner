# Sering Suite — Design Document & Roadmap

*Last updated: 2026-04-13*
*This is the master reference for any AI assistant working on this codebase. Read this before making changes.*

---

## 1. Organisation Overview

**De Sering** is a community-driven vegan food organisation in Amsterdam, operating three distinct food operations under one umbrella:

### Sering West (HQ)
- **Location**: Rhôneweg 6, 1043 AH Amsterdam (near Sloterdijk)
- **What**: Community kitchen, café, event space within theatre broedplaats De Sloot
- **Scale**: ~750 dinners/week, ~500 lunches/week
- **Hours**: Lunch Mon-Fri 12:00-14:00, Dinner Mon-Sat 18:00-21:00, Café Mon-Fri 9:30-23:00
- **Role**: Headquarters. Largest kitchen capacity. Produces food for Sering Centraal (economies of scale). Most volunteer shifts here. Office, meetings, social events.
- **Also does**: Catering (50+ person events, protest catering), hosts events (techno parties, lectures, art clubs)
- **Website**: https://desering.org/

### TestTafel (Fine Dining)
- **Location**: Mediamatic, Dijksgracht 6, 1019 BS Amsterdam (10 min from Centraal Station)
- **What**: Experimental vegan fine dining restaurant, 7-course tasting menu
- **Scale**: ~160-200 covers/week across Wed-Sat evenings
- **Menu**: Changes weekly, created collectively by the chef team (no head chef). Natural wines, homemade non-alcoholic drinks.
- **Team**: Own cooks, FOH staff, and general manager
- **Pricing**: Donation-based, minimum €58.50 for groups
- **Website**: https://testtafel.nl/

### Sering Centraal (Newest)
- **Location**: Same building as TestTafel at Mediamatic
- **What**: Sering-style lunch + expanding to dinner on non-TestTafel evenings
- **Scale**: ~350 lunches/week (growing). Dinner on Tuesdays started recently (150→200→215 in first three weeks)
- **Logistics**: Almost all food cooked at Sering West, biked over by cargo bike
- **Plans**: Adding dinner on more evenings. Large terrace with drinks potential.
- **Website**: None yet

### Organisation Culture
- Most staff are in their first real job. Director (you) came from cooking.
- Egalitarian and decentralised. No head chef at TestTafel — collective menu decisions.
- Still has managers per location and a general director for accountability.
- ~57 staff + volunteers on a peak day
- Hundreds of dedicated volunteers with their own scheduling system (https://schedule.desering.org/)
- Currently paying ~€800/month on software that doesn't fit the unique setup well

---

## 2. The Vision: Sering Suite

Replace the current patchwork of poorly-fitting software with a single, interconnected, home-built suite of tools. The suite should:

1. **Eliminate menial work** — free staff time for presence and creativity
2. **Provide guardrails, not micromanagement** — strong systems that protect business interests (costs, pricing, hours), leaving everything else for creative independent work. Example: the head waiter at TestTafel should be able to experiment freely with homemade drinks, while seeing clearly how much he can spend, how to price them, and how many hours he can invest.
3. **Enable data-driven decisions** — real insight for expansion, investment, and operational choices
4. **Create transparency** — staff see their own location's operations AND the whole picture, understanding how their actions affect the organisation
5. **Scale to 6 locations** — architecture must support growth

### Design Principles
- **Interchangeable systems** — drinks system at TestTafel = same as Sering West
- **Easy to learn, easy to hand over** — volunteers and new staff can pick it up quickly
- **Staff/business tools first** — but keep the organisation's openness in mind
- **Own everything** — own all code, databases, and data. No vendor lock-in.
- **Fault isolation** — if finances breaks, food planner still runs
- **Seamless navigation** — one login, click between modules, no separate websites
- **Built for AI-assisted development** — Claude-first stack choices
- **Stability over cleverness** — boring technology that works

---

## 3. Current State (What's Built)

### Food Planner (v1 — live in production)
- **Repo**: https://github.com/baasvis/Sering-food-planner
- **Stack**: Node.js/Express + TypeScript, frontend TypeScript ES modules bundled by Vite, PostgreSQL via Prisma
- **Hosting**: Railway (auto-deploy from GitHub)
- **Auth**: Google Sign-In with allowed email list

**Completed features:**
- Global location chooser: after login, users pick their kitchen (Sering West / Sering Centraal). Choice persists in localStorage. The app title ("Sering West" / "Sering Centraal") acts as a toggle to switch location. Dashboard, Orders, and Ingredient DB use the global location — no per-screen toggles. Finance keeps its own filter pills (has "all" + "testtafel") but defaults to global location. Planner and Guests retain their own location handling (sub-tabs / side-by-side). Planner defaults to the user's location tab and only shows DO INVENTORY on the user's current location.
- Dashboard redesigned as kitchen-floor command center: centered meal toggle (Lunch/Dinner) at top filters all sections, auto-detects meal based on time (lunch before 15:00, dinner after). Side-by-side service block: menu card (left) with dish chips grouped by type (🥣 Soup / 🍛 Main / 🍨 Dessert), guests card (right) with large guest count + flow chart. Dish chips show inline allergen pills and are clickable with foldout (allergens, starch picker for mains, stock level, cook date, recipe link, per-service breakdown). Two-column desktop layout (Stock + Chef To-Dos), single column on mobile. Stock card groups batches by type with icons, frozen batches in separate "❄️ Frozen" section at bottom; includes "Cooked Food Inventory" button (opens batch inventory modal with frozen section) and "Ingredient Stocktake" button (opens area picker → count inputs → save). Ingredient name resolution: v2 recipes preferred over legacy denormalized data, ingredient names looked up from DB when not denormalized. Chef To-Dos: "What to Cook" filtered to selected meal only, "What to Chop" with improved ingredient filtering (unknown ingredients excluded by default, added pantry keywords for tofu/tempeh/lentils/canned/frozen/spice blends), team todos inline (no floating button). Removed greeting, removed "What to Heat Up" (redundant with menu), removed "Future service" from cook list
- Guest flow chart on dashboard: canvas line chart showing estimated guest arrivals per 5-minute interval. Uses real per-5-min arrival distributions extracted from POS timestamps (Tebi Invoice ID + Lightspeed Creation Date), grouped by location/meal/day-of-week. Falls back to gaussian curve when no historical data exists. Lunch/Dinner toggle (amber/purple), "Now" time indicator with remaining guest count during service, peak label. Dark mode + HiDPI aware. Distributions stored in GuestHistoryMeta as normalized JSON fractions.
- Guest count tables per location (West + Centraal) with live totals, day-by-day navigation (today ±14 days), editable for current and future weeks
- Guest prediction from historical POS data: upload Tebi or Lightspeed CSV exports, auto-detect format, predict guest counts using winsorized weighted averages with trend detection
  - Supports 3 CSV formats: Tebi ProductOrdersReport, Tebi ProductReportByProfitCenter, Lightspeed receipt-items
  - Location detection: Tebi uses device ID mapping or Profit Center column; Lightspeed = always Centraal
  - Staff meals split by time (before 17:00 = lunch, after = dinner), included in totals with separate "X staff" indicator
  - Multiple sources for same day are averaged (not summed) to prevent double-counting during POS transition
  - "Apply predictions" button fills guest inputs; staff can manually adjust for events/reservations
- Unified Week Plan tab with sub-tabs: Sering West, Sering Centraal, To Transport, Caterings, Overview
- Location sub-tabs: calendar grid organised by batch type (Soups/Mains/Desserts), each with day×meal slots. Day-by-day navigation (today ±14 days), same as Guests tab
- Per-type batch pools directly below each type's calendar (soups under soups grid, mains under mains grid). Collapsed by default behind a toggle button (type name + count); click to expand. 3-column tile grid on desktop, 2 on tablet, 1 on mobile. Grouped by "To cook" / "Cooked" / "Frozen".
  - Compact batch tiles show: status badge (TO COOK / COOKED / STALE), cook label (day name for planned e.g. "Tue", date for cooked e.g. "11/4"), stock + diff, location badge. Clickable to expand.
  - Expanded tile: structured single-column layout with bordered sections. Header (name input + recipe link/button + serving size). Two-column desktop layout (single on mobile): left = "Stock & Services" (stock input + diff, service lines grouped by location with per-service liter amounts, always using day names), right = "Properties" (cook date picker/dropdown, type/storage/location badges, allergens, notes). Action bar at bottom (order toggle, replace, delete/served buttons). Reusable via `BatchTileOptions` interface (showAssign, showActions, showRecipe, compact).
- "Show all batches" collapsible section at the bottom of the calendar showing every batch at the location regardless of type.
- Drag-and-drop assignment: drag a batch tile onto any calendar slot to assign it. Visual feedback with slot highlighting on dragover.
- Select-then-assign flow (alternative): click "Assign" on a batch tile → grid slots highlight as drop targets → click a slot to assign the batch there. The + button and add modal remain for creating new batches from recipes or placeholders (placeholders inherit the slot's date as cook date).
- Replace batch: uncooked batches with services show a "Replace" button. Opens a modal to pick a replacement (existing same-type batch or recipe). All services and cook date transfer from old to new batch; catering references updated; old batch is deleted.
- Cook date column: red highlight when unset, bold when planned. Stock locked until marked as cooked, auto-fills to required amount on cook.
- Requirement breakdown tooltip on +/- column (hover to see per-service and per-catering demand)
- Caterings module: name, date, guest count, delivery mode, auto-calculated dish requirements (guest count × serving size ÷ same-type peers), logistics notes
- Transport view: "Mark selected as arrived" (changes logistics to destination), custom transport items list (free-text, disappear on delivery)
- Dish management with inline editing, cook date tracking, stock levels, +/- status pills, sortable columns
- Recipe index (library) with ratings, conditional cost colouring, "Recalculate costs" button (re-derives all recipe costs from current ingredient prices), "Import cooked amounts" button (bulk re-imports cooked column from linked Google Sheets for all v2 recipes)
- Recipe system v2: full recipe editor with DB-linked ingredients, multi-step guided creation (basics → ingredients → prep steps → storage → review), ingredient autocomplete from DB (~2100 items), flexible ingredient slots ("Any vegetables" with category + suggestions), auto-allergen calculation from linked ingredients, live cost per serving, nutrition per serving (EU label format), photo upload (stored in PostgreSQL, resized client-side), manual versioning with snapshot history, printable A4 view (server-rendered HTML with @media print, supports ?scale= and ?liters= query params for scaled printing), post-cook recording (resolve flexible slots, adjust amounts, optional stock deduction, cook notes), auto-recalculate recipe costs when ingredient prices change (also recalculated on detail view open). Google Sheets import preserves both raw and cooked ingredient amounts (raw for cost, cooked for volume). All planner batches now use v2 recipes (legacy recipeIndex kept in DB as backup but no longer served to frontend). Recipe list shows v2 recipes in a sortable table (name, type, structure, cost, season, allergens, ratings, served, actions). Rows link to detail view on click, with Edit/+Menu/Delete actions. Flex ingredients priced at €1.50/kg in cost calculations. Detail view includes adjustable volume/portions scaling (changes ingredient amounts in-place, passes scale to print view). Batch recipe editor: unified fullscreen/modal editor for v2 recipe batches — shows ingredients with editable amounts, adjustable target liters/portions with live rescaling from base recipe amounts, prep steps (read-only), cook notes, stock deduction toggle. Replaces old resolve-flexible and post-cook-recording modals. Accessible from batch tile "Open batch recipe" button in planner.
- Order overview with 4-tab layout: Combined Order (default), Set Standard Inventory, Batch Ingredients, Ingredient Database
  - All tabs display amounts in order units (e.g. "5x Bak 1 kilogram") when ingredient has orderUnitSize, falling back to formatted metric (kg/L) otherwise. Stock inputs use order units with labels.
  - Standard Inventory: cooks build a weekly base order (persistent, per-location PostgreSQL JSON), searchable from ingredient DB, target stock in order units
  - Batch Ingredients: toggle list of batches at current location (with recipe data), on/off per batch, colored per-batch breakdown in ingredient table. "All on/off" buttons. Toggle state persisted to localStorage per location (batchIngredientToggles_west / _centraal); new batches default to their orderFor value.
  - Combined Order: merges standard + batch ingredients, sums overlapping items, grouped by storage category per location, breakdown on click. Uses the same batch toggle state as Batch Ingredients tab. "Include batch ingredients" toggle shows/hides all batch ingredient rows at once.
  - Hanos add-to-cart integration: top-level "Send all to Hanos" button + per-storage-group + per-row cart buttons. Confirmation modal lists items before sending. Uses Hanos OCC v2 API (OAuth login, cart management). Per-location credentials: HANOS_USER_WEST/HANOS_PASS_WEST and HANOS_USER_CENTRAAL/HANOS_PASS_CENTRAAL. Buttons only show for locations with configured credentials.
  - Hanos product lookup: paste an order code or Hanos URL in the ingredient edit modal to auto-fill order code, unit, price, unit size, and supplier name. Uses GET /api/hanos/product/:code (OCC v2 product detail) + GET /api/hanos/search (catalog search).
  - Clicking any ingredient name opens full edit modal (all fields: name, supplier, types, category, unit, order code/unit/price/size, storage locations, allergens, notes, stock, nutrition)
  - Stocktake mode: "Do stocktake" button on Combined Order opens dedicated flow — area picker → per-area page with items grouped by spot → stock inputs with live to-order calculation → "Save & next area" or "Save & stop". Persists via /api/ingredients/stock/bulk. Inputs start empty ("not counted", skipped on save); entering 0 means "counted, nothing on stock" and is saved.
- Ingredient database (PostgreSQL via Prisma) with supplier codes, units, prices, storage locations, stock tracking
- Feedback system (floating purple button, structured form with 4 types, stores to PostgreSQL)
- Feedback admin screen: view all submitted feedback, filter by type, "Copy for Claude" button exports feedback as structured text for pasting into Claude Code chat
- Dashboard allergen editing: add/remove allergens directly on today's menu cards (same inline flow as week plan)
- Mobile responsive layout (card-based dishes on phone, bottom-sheet modals, fixed bottom navigation bar with icons, compact sticky header)
- Dark mode toggle: manual light/dark switch in top bar (moon/sun icon), saved to localStorage. Light mode is the default. CSS uses `:root.dark` class, not `prefers-color-scheme`.
- Logistics colour coding with legend, filter bars, section grouping (To cook / Cooked / Frozen)
- Finance v1: Tebi POS scraper (Playwright browser automation) pulls daily revenue data via Tebi's internal JSON API. Sync worker stores data in PostgreSQL DailyRevenue table. Finance screen shows weekly revenue table (per location per day), monthly summary cards (gross/net revenue, sales, covers), CSS bar chart of daily gross revenue, and week navigation. "Sync from Tebi" button triggers the scraper as a child process. Two Tebi accounts (as of 2026-04-26): TEBI_EMAIL/PASSWORD for Ledger 1 (Sering West, ledger 723192) and TEBI_EMAIL_2/PASSWORD_2 for Ledger 2 (TestTafel + Centraal, set TEBI_LEDGER_ID_2=724466). Each account is logged in separately, runs sequentially, with isolated auth tokens and profit-center state. Backward compat: if TEBI_LEDGER_ID_2 is set without _2 credentials, the primary credentials are reused (single-account fallback). Profit centers auto-discovered from Tebi dashboard API by label ("west", "centraal", "test"). Optional TEBI_FORCE_LOCATION env var bypasses profit center lookup. Tebi added a "Select location" intermediate page between login and the ledger dashboard around 2026-03-26; login() recognises this as a successful-login marker and runForAccount() then navigates straight to the ledger URL to bypass the picker. Failed sync runs emit `error:finance_sync_failed` telemetry events with stderr/stdout tails and survive server restart via `/api/finance/sync-status` hydration (lib/tebi-sync.ts).
- Finance v2 — Product-level revenue breakdown: scraper parses Tebi invoice line items to extract per-product revenue. Classifies each invoice by service period (morning 09–12, lunch 12–14, afternoon 14–18, dinner 18–21, bar 21–06). Data stored in PostgreSQL ProductRevenue table. Finance screen shows horizontal category bar chart, sortable product table (top 50), and filter pills for 5 service periods + 4 locations. API: GET /api/finance/products with optional location, meal, groupBy=category filters. Discovery flag: `--dump-invoices` on scraper to inspect raw Tebi invoice structure.
- Live sync via Server-Sent Events (SSE): when any user saves changes, all other connected users receive the patch instantly and their UI updates automatically. Uses native browser EventSource (auto-reconnects on connection loss). Server broadcasts patches to all clients except the sender (matched by email). No polling, no WebSocket library needed. Concurrent save safety (fixed 2026-04-13): incoming SSE patches update the snapshot only for remote items (not the full state), preserving any unsaved local changes so they aren't silently dropped. Server-side patch endpoint uses targeted upserts/deletes instead of delete-all/create-all, and merges incoming batches field-by-field with existing DB rows to prevent stale-field overwrites.
- AI monitoring system (added 2026-04-13): developer-facing tool for automated app maintenance. Frontend telemetry collects errors, screen views, feature usage, and API performance via `navigator.sendBeacon`. Backend middleware tracks API response times and error rates. Events buffered in-memory, flushed to PostgreSQL every 60s. Daily cron sends telemetry + data quality report to Claude API (Sonnet), which generates structured insights (bugs, UX issues, data quality, performance, suggestions) stored in AiInsight table. Admin API: `POST /api/admin/analyze` (trigger analysis), `GET /api/admin/insights` (list insights with filters), `PATCH /api/admin/insights/:id` (update status), `GET /api/admin/telemetry/summary` (raw aggregation). Telemetry auto-cleanup removes events older than 90 days. Requires `ANTHROPIC_API_KEY` env var; optional `AI_ANALYSIS_CRON` and `AI_ANALYSIS_MODEL`.
- Undo for destructive actions (added 2026-04-14): deleting batches, caterings, and recipes shows a 5-second "Undo" toast instead of a confirm() dialog. The save/API call is deferred until the undo window expires; clicking Undo restores state without touching the server. Frontend-only implementation in `public/js/undo.ts` — depth-1 stack (new delete commits previous), cancels pending save timer to prevent premature persistence, flushes on beforeunload and incoming SSE patches.
- TypeScript strict typing (refactored 2026-03-31, cleaned 2026-04-09): `any` types nearly eliminated across both backend and frontend. Backend has 6 remaining (XLSX parsing in ingredients-import.ts); frontend's 5 largest files (orders, dishes, planner, dashboard, ingredient-db) are `any`-free with proper Ingredient/Batch/Service/Location types. Domain types (`Location`, `Meal`, `DishType`, `StorageType`) enforce valid values at compile time. Global state object `S` typed as `AppState`. All catch blocks use `catch (e: unknown)` with `errMsg()` helper. Prisma JSON boundary uses explicit casts with `AppError` class for typed HTTP errors. Single shared Prisma client instance. Cross-module `(window as any)` pattern eliminated — replaced with direct ES imports via `modal.ts` and `navigate.ts` registry pattern. All async route handlers wrapped in `asyncHandler()` with centralized error handling. 74 API integration tests.

**File structure:**
```
server.ts              — Express entry point (starts listening)
app.ts                 — Express app, mounts routers, global error handler
shared/
  types.ts             — Shared interfaces + string literal union types (Location, Meal, DishType, etc.) used by both backend & frontend
types/
  express.d.ts         — Express Request augmentation (req.user)
  globals.d.ts         — Window index signature for onclick handlers
  multer.d.ts          — Multer module declaration
lib/
  config.ts            — Configuration, env vars, errMsg() helper, asyncHandler()
  db.ts                — Prisma client, row transformers, validators
  recipe-sheets.ts     — Google Sheets client (external recipe reading only)
  hanos-parser.ts      — Hanos quantity parser
  hanos-client.ts      — HanosClient class, OAuth login, cart management, product formatting
  ai-analyzer.ts       — Data quality checks, telemetry aggregation, Claude API insights
routes/
  auth.ts              — Login, logout, session, requireAuth middleware
  data.ts              — GET/POST /api/data + POST /api/data/patch (main planner state)
  batches.ts           — Batch CRUD: GET/POST/PATCH/DELETE /api/batches
  recipes.ts           — Recipe index CRUD + single recipe fetch + Recipe v2 CRUD + photo + print + versioning + cost recalc
  ingredients.ts       — Ingredient CRUD + stock management
  ingredients-import.ts — Hanos XLSX upload + CSV migration
  guests.ts            — Guest history + next-weeks predictions
  inventory.ts         — Standard inventory + storage config + prep checklist + activity log
  feedback.ts          — User feedback
  hanos.ts             — Hanos API routes (imports client from lib/hanos-client.ts)
  events.ts            — SSE live sync: client registry, broadcast patches to other users
  finance.ts           — Finance revenue endpoints (GET revenue, POST sync, GET sync-status)
  telemetry.ts         — Telemetry event ingestion (no auth, buffered writes)
  admin.ts             — AI insights & telemetry admin endpoints
  health.ts            — Health check endpoint
public/
  index.html           — Shell HTML + login screen (single module entry point)
  css/                 — Per-screen CSS files (base, dashboard, guests, planner, orders, recipes, finance, feedback, tutorial, mobile)
  js/
    main.ts            — Entry point: imports all modules, assigns onclick functions to window
    state.ts           — Constants, NAV_SCREENS, storage config helpers, global state object S
    auth.ts            — Google Sign-In, sessions
    utils.ts           — API helpers, save system, toast, prep checklist, SSE live sync client
    core.ts            — Planner rebuild, calculations, badges, served/archive
    dashboard.ts       — showScreen(), Dashboard screen
    predictions.ts     — CSV parsing, prediction engine, day-navigation helpers
    guests.ts          — Guest counts screen, upload UI, predictions display
    planner.ts         — Week plan: sub-tabs, location grids, batch pool, assign mode, transport view
    dishes.ts          — Dish list + cook workflow + CRUD
    caterings.ts       — Caterings CRUD, dish picker, auto-calculated requirements
    recipes.ts         — Recipe index screen (v2 recipes)
    recipe-editor.ts   — Recipe v2 editor (multi-step modal), detail view, post-cook recording
    orders.ts          — Order overview (combined, standard inventory, dish ingredients tabs)
    ingredient-db.ts   — Ingredient database editor + supplier import
    finance.ts         — Finance screen (revenue dashboard, sync, week nav)
    feedback.ts        — Feedback button and form
    feedback-admin.ts  — Feedback admin screen (view, filter, export)
    telemetry.ts       — Frontend telemetry (errors, screen views, feature usage, API perf)
    undo.ts            — Undo manager for destructive actions (5s deferred save)
    tutorial.ts        — Interactive guided tutorial system
    modal.ts           — Standalone modal utilities (showModal, closeModal, esc)
    navigate.ts        — Screen renderer registry, rerenderCurrentView()
    init.ts            — buildNav(), beforeunload guard, initApp
seeds/
  ingredients.json     — Master ingredient database (~2,100 items, seed for first deploy)
  standard-inventory.json  — Default weekly base order (~140 items)
scripts/
  tebi-scraper.js          — Playwright scraper: logs into Tebi POS, captures auth, fetches revenue/sales via internal API
  tebi-sync-worker.js      — Sync worker: runs scraper + upserts results to PostgreSQL DailyRevenue table
test/
  api.test.ts          — API integration tests (Jest + @swc/jest)
tsconfig.json          — Frontend TypeScript config
tsconfig.server.json   — Backend TypeScript config (CommonJS output to dist/server/)
vite.config.ts         — Vite config (root: public/, proxy /api to :3000)
.env                   — Local environment variables (gitignored)
railway.toml           — Railway deploy config (start command: prisma migrate + node dist/server/server.js)
CLAUDE.md              — Claude Code project instructions
DESIGN.md              — This document
SETUP_GUIDE.md         — Installation instructions
```

**Data model** (stored in PostgreSQL via Prisma):

| Entity | Key Fields | Prisma Model / Table |
|--------|-----------|-----------|
| Batch | id, name, type, stock, serving, storage, logistics, allergens, cookDate, cookConfirmed, recipeSheetId, recipeId, recipeVolume, recipeIngredients, actualIngredients (JSON), cookNotes, stockDeducted, services (JSON), location, inTransit, note | Batch |
| Guests | location, day, lunch count, dinner count | AppState (JSON) |
| Recipe Index | id, name, type, recipeSheetId, allergens, costPerServing, structure, seasonality, ratings, timesServed | RecipeIndex |
| Recipe (v2) | id, name, type, structure, seasonality, servingTemp, servingSize, recipeVolume, autoAllergens, extraAllergens, costPerServing, prepSteps (JSON), coolingMethod, storageMethod, photoUrl, isComplete, versions (JSON), createdBy, updatedAt | Recipe |
| Recipe Ingredient Row | id, recipeId, ingredientId, sortOrder, rawAmount, cookedAmount, unit, isFlexible, flexCategory, flexLabel, suggestedNames | RecipeIngredientRow |
| Recipe Photo | id, recipeId, mimeType, data (binary) | RecipePhoto |
| Catering | id, name, date, guestCount, deliveryMode, dishes (JSON), logisticsNotes | AppState (JSON) |
| Transport Item | id, text | AppState (JSON) |
| Feedback | timestamp, user, type, screen, text, userAgent | Feedback |
| Ingredient | name, unit, types, category, orderCode, orderUnit, orderUnitSize, orderPrice, storageLocations, stock, nutrition, priceHistory | Ingredient |
| Standard Inventory | location, items (JSON) | StandardInventory |
| Storage Config | location, config (JSON) | StorageConfig |
| Guest History | location, meal, date, count | GuestHistory (+ GuestHistoryMeta) |
| Guests Next Weeks | mondayKey, location, day, meal, count | GuestsNextWeeks |
| Daily Revenue | date, location, grossRevenue, netRevenue, sales, covers, invoiceCount, syncedAt | DailyRevenue |
| Product Revenue | date, location, meal, productName, productCategory, quantity, grossRevenue, netRevenue, syncedAt | ProductRevenue |
| Telemetry Event | timestamp, source, type, name, data (JSON), userId, sessionId | TelemetryEvent / telemetry_event |
| AI Insight | timestamp, category, severity, title, body, data (JSON), status, resolvedAt | AiInsight / ai_insight |

**Recipe Sheet Template** (individual Google Sheets per recipe):
- C1: dish name, B3: serving size (ml), D3: allergens, F3: serving temp, H3: structure
- K2: dish type, K4: recipe volume (liters), O3: seasonality, O4: cost per serving
- J6:N40: ingredients (name, measurement, raw amount, amount after cooking, cost)
- K6:K40: measurement types (kilo's, Grams, Liters, ML — amounts stay in original units)
- X6:X40: supplier/source per ingredient

**Key formulas:**
- Required stock (L) = Σ services: (guests ÷ peer_dishes_same_type) × (serving_ml ÷ 1000) + Σ caterings: (catering_guests ÷ same_type_peers_in_catering) × (serving_ml ÷ 1000)
- Ingredients per guest = ingredient_amount ÷ (recipeVolume_L × 1000 ÷ serving_ml)
- Amounts stay in recipe's original units; conversion to grams only for order-unit calculations

---

## 4. Module Roadmap

### Approach: Thin Slices, Not Big Phases
Rather than building each module to completion before starting the next, we build the **simplest useful version** of what's needed now, then deepen based on real usage and feedback. The order below reflects current priorities but is deliberately flexible — what comes next depends on what the team actually needs.

### Now: Deepen the Food Planner
The food planner is live and working. Current priorities to expand it:

- [x] **Caterings module**: name, date, guest count, pickup/delivery/on-location, auto-calculated dish requirements, logistics notes. Integrated as sub-tab in Week Plan.
- [ ] **Toppings/sides/bread**: currently only soups, mains, desserts. Need to handle the standard accompaniments (bread, aioli, toppings, dips) that go with every service.
- [ ] **Basic budgeting per service**: simple cost indicator per meal service — how much are we spending on ingredients for this lunch vs how many guests are paying.
- [ ] Import all existing recipes from old spreadsheet
- [x] Standard inventory items (always-in-stock list separate from per-dish ingredients)
- [ ] TestTafel menu planning variant (7-course format, cost/labour per course, portion sizing, collective planning)

### Next: Drinks System
A unified drinks system across all locations.

**Start simple (v1)**:
- A list: name, type (wine/beer/spirit/cocktail/non-alcoholic/homemade), supplier, cost price, selling price, stock per location
- Basic margin calculation (cost vs selling price)

**Deepen later**:
- Wine: tasting notes, region, producer, natural/organic, pairing suggestions
- Cocktails & homemade drinks: recipe with ingredients, prep time, cost calculation
- Automatic pricing suggestions based on cost + target margin
- Supplier ordering (same pattern as food ingredient ordering)
- **Key use case**: TestTafel's head waiter can freely experiment with homemade drinks, seeing immediately what it costs and what it should be priced at

### Then: Build What's Most Needed
The order of everything below is flexible. Build thin slices first, deepen based on feedback and urgency.

**Task management** (could come early — high daily impact)
- v1: Daily checklists per location/role. Open app, see tasks, tick them off. Manager sets up the lists.
- v2: Recurring tasks, completion tracking, one-click-deeper instructions, kitchen-friendly big buttons
- v3: Teaching built in (tasks double as training materials)

**Basic finance tracking** (useful early even in simple form)
- [x] v1: Daily revenue auto-pulled from Tebi POS via Playwright scraper. Finance screen with weekly revenue table, monthly summary, bar chart. Data stored in PostgreSQL DailyRevenue table.
- [x] v2 (partial): Product-level revenue breakdown from Tebi invoice line items, with service period classification (morning/lunch/afternoon/dinner/bar) and per-location filtering. Remaining: cost tracking, cost per guest, budget vs actual.
- v3: Full P&L, supplier analysis, waste tracking, automated reports

**Non-food inventory**
- v1: A list with par levels. "We have 3 rolls of cling film, minimum is 10, need to order."
- v2: Per-location tracking, reorder triggers, check-in/check-out for shared equipment

**Staff scheduling** (replaces €200-300/month software)
- v1: Weekly grid, assign people to shifts, people see their schedule
- v2: Availability, open shifts, swap requests
- v3: Time tracking, hour approval, leave balances, labour cost integration

**Project management** (lightweight, transparency-focused)
- v1: Simple project cards visible to all. Goal, steps, owner.
- v2: Guided creation workflow, notes, resource allocation
- v3: AI-assisted project structuring

### Future Ideas (not planned)
- Guest-facing allergen lookup / digital menu board
- Catering management (quotes, logistics, billing) — beyond the basic catering module
- Equipment maintenance scheduling
- Volunteer onboarding with training modules
- Donation tracking and donor management
- Accounting software integration (Exact, Twinfield)
- Event management (bookings, capacity, equipment, bar projections)
- AI features: recipe suggestions from seasonal ingredients, automated weekly reports, demand forecasting

---

## 5. Technical Architecture Evolution

### Current: TypeScript Monolith with Vite
```
Browser (Vite-bundled TS) ←→ Express Server (TypeScript) ←→ PostgreSQL (Prisma ORM)
                                                          ←→ Google Sheets (recipe imports only)
```
- Single Node.js/TypeScript app on Railway
- PostgreSQL via Prisma ORM (migrated from Google Sheets, March 2026)
- Frontend: TypeScript ES modules bundled by Vite (HMR in dev, static bundle in prod)
- Backend: TypeScript compiled to CommonJS via tsc
- Shared type definitions between frontend and backend (`shared/types.ts`)
- Good for: food planner + drinks + tasks + finance + non-food inventory + more

### When Needed: User Roles ← triggered by scheduling or multi-location growth
```
Same architecture + role-based access control
```
- **Admin** (director): everything
- **Location manager**: full access to their location, read access to others and organisation-wide
- **Staff**: own schedule, own location's operations, read access to organisation-wide data
- **Cook/FOH**: operational tools for their role + transparency views

### When Needed: Frontend Framework ← only if vanilla TS + Vite becomes a genuine bottleneck
```
Browser (React/Next.js) ←→ API Server ←→ PostgreSQL
```
- Switch only if vanilla TS genuinely becomes a bottleneck (15+ complex screens with shared state)
- Next.js — Claude knows it best, huge ecosystem
- Gradual migration: one screen at a time
- Same API server underneath

### Scaling to many Locations
From Phase 3 onward, locations are database-driven (not hardcoded):
- Location table in PostgreSQL with settings, suppliers, operating hours
- All operational data filtered by location_id
- Shared data (recipes, drinks library, ingredient DB) available across locations
- Adding a location = adding a database row, not changing code

---

## 6. Development Approach

### How We Work
- **Natural language first**: Describe features in plain words, Claude writes the code
- **DESIGN.md is the bible**: Every new session starts by reading this document
- **Small, tested increments**: Build one feature, test it live, push, move on
- **Git is the safety net**: Every change committed with clear messages. Easy to revert.
- **Feedback-driven**: Real users give feedback via the in-app button → prioritise based on that
- **Keep DESIGN.md current**: After every major push, update this document with new features, file changes, data model additions, and any architectural decisions made. This is how context transfers between sessions.

### Recommended Workflow Evolution

| Phase | Tool | Status |
|-------|------|--------|
| Initial build | Claude.ai chat | ✅ Done — built the food planner |
| Current onwards | **Claude Code** | ← We are here. Full filesystem, runs server, tests locally. |
| Later (multi-contributor) | Claude Code + pull requests | When volunteer devs join. |

### Setting Up Claude Code
```bash
# One-time setup (~30 minutes)
1. Install Node.js from https://nodejs.org
2. Install git from https://git-scm.com
3. npm install -g @anthropic-ai/claude-code
4. git clone https://github.com/baasvis/Sering-food-planner
5. cd Sering-food-planner && npm install
6. claude    # start working
```

**Daily workflow:**
```
> claude "read DESIGN.md then let's work on the catering module"
> "add a toppings section to the dish planner"
> "there's a bug on the orders page, the stock input doesn't save"
> "push to github"
```

Same natural language as Claude.ai chat, but with full project access.

### Tech Stack
All chosen for: (1) Claude compatibility, (2) stability, (3) readability by non-experts.

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Language | TypeScript (full stack) | Type safety across frontend + backend. Shared interfaces. Catches bugs at compile time. |
| Frontend | TypeScript ES modules + Vite | Vite bundles & provides HMR in dev, static bundle in prod. React/Next.js if complexity demands later. |
| Backend | Node.js + Express + TypeScript | Most common web server. tsx for dev, tsc for prod build. |
| Database | PostgreSQL via Prisma ORM | Real queries, migrations, type-safe client. Google Sheets for recipe imports only. |
| Hosting | Railway | One-click deploy + database. Affordable. EU servers available. |
| Auth | Google Sign-In | Everyone has Google. Zero password management. |
| Version control | GitHub | Industry standard. |
| Testing | Jest + @swc/jest | Fast TypeScript test transpilation. API integration tests. |

### Code Standards
- English for all code, comments, variable names
- UI text in English (team uses English internally)
- File names match purpose: drinks.ts, scheduling.ts, finance.ts
- Each screen/module in its own TS file with explicit imports/exports
- Shared utilities in utils.ts and core.ts, shared types in shared/types.ts
- Server routes grouped by module
- Commit messages explain what AND why
- Lots of inline comments explaining business logic

### Tutorial Maintenance Rule
**Every time a new feature is added or an existing feature is modified, the in-app tutorial steps for that page must be updated to match.**

The tutorials live in `public/js/tutorial.ts`, organised by screen name (`dashboard`, `guests`, `planner`, `recipes`, `orders`). Each step is a plain object with a `selector`, `title`, and `body`. When you add a new section to a page, add a corresponding step. When you rename or restructure something, update the step that references it. The tutorials are the first thing a new cook reads — keeping them accurate is as important as keeping the code working.

---

## 7. Data Ownership & Security

- **All code**: Owned by De Sering, on GitHub
- **All data**: Owned by De Sering, in PostgreSQL on Railway
- **No vendor lock-in**: Standard technologies, exportable data, no proprietary formats
- **Backups**: Railway automated PostgreSQL backups
- **GDPR**: Privacy notice for staff data. Minimal collection. Deletion on request. EU hosting option.
- **Auth**: Google Sign-In + allowed email list. Session-based. No passwords stored.
- **Fault isolation**: Modules load independently. One breaking doesn't crash the others.

---

## 8. Software Replacement Plan

| Current Tool | ~Monthly Cost | Replaced By | Phase |
|-------------|:------------:|-------------|:-----:|
| Menu planning spreadsheets | staff time | Food planner | 1 ✅ |
| Inventory spreadsheets | staff time | Inventory + drinks modules | 2 |
| Finance spreadsheets | staff time | Finance module | 3 |
| Scheduling software | €200-300 | Staff scheduling | 4 |
| Notion (tasks) | €100-150 | Task management | 5 |
| Other tools | €100-200 | Various modules | 2-5 |
| **Total current** | **~€800/mo** | | |
| **Sering Suite hosting** | **~€20-40/mo** | | |

---

## 9. How to Start a New Work Session

Tell Claude:
1. "Read DESIGN.md from the repo at https://github.com/baasvis/Sering-food-planner"
2. Which phase/module you want to work on
3. Any context since last time: bugs found, feedback received, priorities changed

Claude reads this document, understands the full system, and picks up where you left off.
