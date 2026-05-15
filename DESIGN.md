# Sering Suite — Design Document & Roadmap

*Last updated: 2026-05-15*
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

### Food Planner (live in production)
- **Repo**: https://github.com/baasvis/Sering-food-planner
- **Stack**: Node.js/Express + TypeScript, frontend TypeScript ES modules bundled by Vite, PostgreSQL via Prisma
- **Hosting**: Railway (auto-deploy from GitHub)
- **Auth**: Google Sign-In with allowed email list

The food planner is in daily production use at Sering West and Sering
Centraal. The paragraphs below describe the system as it stands today, by
area — deliberately a description, not a changelog. When something changes,
update the relevant paragraph; the dated history of how it was built lives
in git.

- **Access & location** — Google Sign-In against an allowed-email list, with
  a dev-mode bypass when `GOOGLE_CLIENT_ID` is unset. After login the user
  picks a kitchen (West / Centraal), which scopes the location-aware screens.

- **Dashboard** — the kitchen-floor command center. A Lunch/Dinner toggle
  (auto-set by time of day) filters everything below it: today's menu with
  per-dish detail and allergens, the guest count with an arrival-time flow
  chart, current stock, and the chef to-do lists.

- **Week Plan** — a per-location calendar of day × meal slots organised by
  dish type, plus a batch pool. Batches are assigned to slots by drag-drop
  or select-then-assign and run through the cook workflow. Sub-tabs cover
  each location, cross-location Transport, Caterings, and an Overview. "Fix
  My Menu" auto-fills gaps with generated placeholder batches.

- **Batches & inventory** — a batch is a physical container of food
  (PLANNED → COOKED → SERVING → DONE). Its stock uses the unified-batch
  model: an `inventory` array of per-(location, storage) entries plus a
  `shipments` array of in-flight transfers between locations. Transport,
  cooking and serving all read this model.

- **Guests** — editable per-location guest-count tables with day navigation.
  Counts auto-populate from the Tebi POS sync; a Tebi/Lightspeed CSV upload
  is the manual fallback. A prediction engine fills upcoming weeks from
  historical counts.

- **Recipes** — the Recipe v2 system: recipes built from DB-linked
  ingredients, a multi-step editor, autocomplete over the ingredient
  database, flexible ingredient slots, auto-calculated allergens, live cost
  and nutrition per serving, photo upload, manual versioning, a printable
  scaled A4 view, and post-cook recording. A director-only AI recipe
  assistant (Claude chat) helps draft and edit recipes. Recipe v1 is retired.

- **Orders** — a combined order that merges the standard weekly inventory
  with per-batch ingredient demand, grouped by storage area and shown in
  supplier order units. Integrates with Hanos (product lookup + add-to-cart)
  and includes a guided stocktake flow.

- **Ingredient database** — ~2,100 ingredients with supplier codes, prices
  and price history, units, storage locations, and per-location stock /
  target stock. Supplier price lists import from XLSX.

- **Finance** — daily, per-location and per-product revenue pulled from the
  Tebi POS, with weekly/monthly views and service-period breakdowns. The
  Tebi integration is fragile and is documented in full in `TEBI.md`.

- **Cross-cutting** — live multi-user sync over Server-Sent Events;
  database-backed sessions; an undo window for destructive actions; an
  activity log; in-app feedback with an admin view; an AI monitoring system
  (telemetry feeding a daily Claude insights report); a guided tutorial;
  light/dark mode; a mobile-responsive layout; and a maintenance mode for
  deploy windows.

The whole codebase is TypeScript; `CLAUDE.md` carries the conventions, the
file-by-file map, the API surface and the typing rules.

**File structure:**

`CLAUDE.md` ("Project Structure") holds the authoritative, current file-by-file
map — it is kept in sync as features land. Top-level shape:

- `server.ts` / `app.ts` — Express entry point and app wiring
- `routes/` — one router per module (data, batches, recipes, ingredients, guests,
  inventory, finance, hanos, telemetry, admin, recipe-ai, coverage, …)
- `lib/` — backend helpers (Prisma/db, config, Tebi sync, Hanos client, AI analyzer,
  recipe-ai, telemetry coverage)
- `shared/types.ts` — interfaces shared by backend and frontend
- `public/js/` — frontend ES modules, roughly one per screen, bundled by Vite
- `public/css/` — per-screen stylesheets
- `prisma/` — schema, migrations, seed script
- `seeds/` — first-deploy seed data (ingredient catalogue, standard inventory)
- `scripts/` — one-off importers and the Tebi diagnostics/backfills (catalogued in `TEBI.md`)
- `test/` — Jest unit/API tests; `e2e/` — Playwright end-to-end specs
- `.github/workflows/` — CI (PR tests, weekly coverage agent, staging sync)

**Data model** (stored in PostgreSQL via Prisma):

| Entity | Key Fields | Prisma Model / Table |
|--------|-----------|-----------|
| Batch | id, name, type, serving, allergens, extraAllergens, orderFor, cookDate, note, services (JSON), createdAt, recipeId, actualIngredients (JSON), cookNotes, stockDeducted, generated, inventory (JSON), shipments (JSON) | Batch / batches |
| Guests | location, day, lunch, dinner | Guest / guests (one row per (location, day)) |
| Recipe (v2) | id, name, type, structure, seasonality, servingTemp, servingSize, recipeVolume, autoAllergens, extraAllergens, costPerServing, avgSkill, avgSpeed, avgBanger, timesServed, prepSteps (JSON), coolingMethod, storageMethod, photoUrl, isComplete, versions (JSON), createdBy, createdAt, updatedAt, legacySheetId | Recipe / recipes |
| Recipe Ingredient Row | id, recipeId, ingredientId, sortOrder, rawAmount, cookedAmount, unit, isFlexible, flexCategory, flexLabel, suggestedNames | RecipeIngredientRow / recipe_ingredients |
| Recipe Photo | id, recipeId, mimeType, data (binary), createdAt | RecipePhoto / recipe_photos |
| Catering | id, name, date, guestCount, deliveryMode, dishes (JSON), logisticsNotes, createdAt | Catering / caterings |
| Transport Item | id, text | TransportItem / transport_items |
| Feedback | id, timestamp, user, type, screen, text, userAgent, processed | Feedback / feedback |
| Ingredient | id, name, supplierName, supplier, unit, measureMode, types (JSON), category, orderCode, orderUnit, orderUnitSize, orderPrice, pricePer100, priceLevel, priceAlert, priceHistory (JSON), storageLocations (JSON), stock (JSON), targetStock (JSON), nutrition (JSON), allergens, notes, active | Ingredient / ingredients |
| Standard Inventory | id, name, amount, unit, location | StandardInventory / standard_inventory (one row per item) |
| Storage Config | id (always "default"), config (JSON — all locations) | StorageConfig / storage_config |
| Kitchen Equipment | id (always "default"), pots (JSON), gasBurners, inductionBurners, bigBurnerThreshold | KitchenEquipment / kitchen_equipment |
| Prep Checklist | id, loc, date, checked (JSON), updatedAt | PrepChecklist / prep_checklist |
| Guest History | location, meal, date, count | GuestHistory / guest_history |
| Guest History Meta | key, value (JSON-encoded string — holds flowDistribution curves) | GuestHistoryMeta / guest_history_meta |
| Guests Next Weeks | mondayKey, location, day, meal, count | GuestsNextWeeks / guests_next_weeks |
| Daily Revenue | date, location, grossRevenue, netRevenue, sales, covers, invoiceCount, syncedAt | DailyRevenue / daily_revenue |
| Product Revenue | date, location, meal, productName, productCategory, quantity, grossRevenue, netRevenue, syncedAt | ProductRevenue / product_revenue |
| Session | id, email, name, picture, createdAt, expiresAt | Session / sessions |
| Log | id, timestamp, email, name, action, details | Log / log |
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
- **Keep DESIGN.md current**: when a module's capabilities change meaningfully, update that module's paragraph in Section 3 (and the data model table if the schema changed). Describe the current system — don't append a dated changelog entry; git history is the changelog.

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
