# Sering Suite — Design Document & Roadmap

*Last updated: 2026-03-24*
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
- **Stack**: Node.js/Express, vanilla JS (split into 12 module files), Google Sheets as DB
- **Hosting**: Railway (auto-deploy from GitHub)
- **Auth**: Google Sign-In with allowed email list

**Completed features:**
- Dashboard with today's menu, guests, guest flow chart, stock alerts, week overview
- Guest flow chart on dashboard: canvas line chart showing estimated guest arrivals per 5-minute interval. Gaussian distribution applied to expected guest count. Lunch/Dinner toggle (amber/purple), "Now" time indicator during service, peak label. Dark mode + HiDPI aware.
- Guest count tables per location (West + Centraal) with live totals, day-by-day navigation (today ±14 days), editable for current and future weeks
- Guest prediction from historical POS data: upload Tebi or Lightspeed CSV exports, auto-detect format, predict guest counts using winsorized weighted averages with trend detection
  - Supports 3 CSV formats: Tebi ProductOrdersReport, Tebi ProductReportByProfitCenter, Lightspeed receipt-items
  - Location detection: Tebi uses device ID mapping or Profit Center column; Lightspeed = always Centraal
  - Staff meals split by time (before 17:00 = lunch, after = dinner), included in totals with separate "X staff" indicator
  - Multiple sources for same day are averaged (not summed) to prevent double-counting during POS transition
  - "Apply predictions" button fills guest inputs; staff can manually adjust for events/reservations
- Unified Week Plan tab with sub-tabs: Sering West, Sering Centraal, To Transport, Caterings, Overview
- Location sub-tabs: calendar grid organised by batch type (Soups/Mains/Desserts), each with day×meal slots. Day-by-day navigation (today ±14 days), same as Guests tab
- Per-type batch pools directly below each type's calendar (soups under soups grid, mains under mains grid). Collapsed by default behind a toggle button (type name + count); click to expand. 3-column tile grid on desktop, 2 on tablet, 1 on mobile. Grouped by "To cook" / "Cooked" / "Frozen". Compact batch tiles show cook date label (DD/M) — green for cooked, blue for planned, grey for unset — clickable to edit via date picker. Click-to-expand detail panel (expanded tiles span full width).
- "Show all batches" collapsible section at the bottom of the calendar showing every batch at the location regardless of type.
- Drag-and-drop assignment: drag a batch tile onto any calendar slot to assign it. Visual feedback with slot highlighting on dragover.
- Select-then-assign flow (alternative): click "Assign" on a batch tile → grid slots highlight as drop targets → click a slot to assign the batch there. The + button and add modal remain for creating new batches from recipes or placeholders.
- Replace batch: uncooked batches with services show a "Replace" button. Opens a modal to pick a replacement (existing same-type batch or recipe). All services transfer from old to new batch; old batch is deleted.
- Cook date column: red highlight when unset, bold when planned. Stock locked until marked as cooked, auto-fills to required amount on cook.
- Requirement breakdown tooltip on +/- column (hover to see per-service and per-catering demand)
- Caterings module: name, date, guest count, delivery mode, auto-calculated dish requirements (guest count × serving size ÷ same-type peers), logistics notes
- Transport view: "Mark selected as arrived" (changes logistics to destination), custom transport items list (free-text, disappear on delivery)
- Dish management with inline editing, cook date tracking, stock levels, +/- status pills, sortable columns
- Recipe index (library) with single + bulk import from Google Sheets, ratings, conditional cost colouring
- Order overview with 3-tab layout: Combined Order (default), Standard Inventory, Dish Ingredients
  - Standard Inventory: cooks build a weekly base order (persistent, server-side JSON), searchable from ingredient DB, shows order codes per item
  - Dish Ingredients: per-dish ingredient aggregation from recipe sheets, in-stock input, to-order calculation
  - Combined Order: merges both lists, sums overlapping ingredients, grouped by storage category per location
  - Hanos add-to-cart integration: "Send to Hanos" bulk button per storage group + per-row cart buttons. Confirmation modal lists items before sending. Uses Hanos OCC v2 API (OAuth login, cart management). Per-location credentials: HANOS_USER_WEST/HANOS_PASS_WEST and HANOS_USER_CENTRAAL/HANOS_PASS_CENTRAAL. Buttons only show for locations with configured credentials.
- Ingredient database integration (separate Google Sheet with supplier codes, units, prices)
- Feedback system (floating purple button, structured form with 4 types, stores to Google Sheets)
- Mobile responsive layout (card-based dishes on phone, bottom-sheet modals, fixed bottom navigation bar with icons, compact sticky header)
- Logistics colour coding with legend, filter bars, section grouping (To cook / Cooked / Frozen)

**File structure:**
```
server.js              — Express app entry point, mounts routers (~65 lines)
lib/
  config.js            — Configuration, env vars, file paths
  sheets.js            — Google Sheets client, row converters, validation, write lock
routes/
  auth.js              — Login, logout, session, requireAuth middleware
  data.js              — GET/POST /api/data (main planner state)
  recipes.js           — Recipe index CRUD + single recipe fetch
  ingredients.js       — Ingredient CRUD + Hanos XLSX parser + upload
  guests.js            — Guest history + next-weeks predictions
  inventory.js         — Standard inventory + prep checklist + activity log
  feedback.js          — User feedback
  hanos.js             — Hanos OCC v2 API client (OAuth, cart, add-to-cart) + Express routes
  health.js            — Health check endpoint
public/
  index.html           — HTML shell + login screen (~75 lines)
  style.css            — All CSS styles (~620 lines)
  js/
    state.js           — Constants, app state
    auth.js            — Google Sign-In, sessions
    utils.js           — API, save system, toast, ingredient DB loading
    core.js            — Planner rebuild, calculations, badges, served/archive
    dashboard.js       — Dashboard screen
    predictions.js     — CSV parsing (Tebi + Lightspeed), categorization, prediction engine, shared day-navigation helpers
    guests.js          — Guest counts screen, upload UI, predictions display
    planner.js         — Week plan: sub-tabs, location grids, batch pool, assign mode, transport view, add-dish modal
    dishes.js          — Dish rows, overview, cook workflow, inline editing
    caterings.js       — Caterings CRUD, dish picker, auto-calculated requirements
    recipes.js         — Recipe index screen
    orders.js          — Order overview (3-tab: Combined Order / Standard Inventory / Dish Ingredients)
    ingredient-db.js   — Ingredient database editor + supplier import
    feedback.js        — Feedback button and form
    tutorial.js        — Interactive guided tutorial system
    init.js            — Modal, HTML escape, app init
data/
  standard-inventory.json  — Standard inventory (gitignored, persisted on server)
seeds/
  ingredients.json     — Master ingredient database (~2,100 items, seed for first deploy)
  standard-inventory.json  — Default weekly base order (~140 items)
scripts/
  migrate-ingredients.js   — One-time ingredient migration utility
  import-standard-inventory.js — One-time standard inventory import
.env                   — Local environment variables (gitignored)
CLAUDE.md              — Claude Code project instructions
DESIGN.md              — This document
SETUP_GUIDE.md         — Installation instructions
```

**Data model** (stored in Google Sheets):

| Entity | Key Fields | Sheet Tab |
|--------|-----------|-----------|
| Dish | id, name, type, stock, serving, storage, logistics, allergens, cookDate, cookConfirmed, recipeSheetId, recipeVolume, recipeIngredients | dishes |
| Service | id, dish_id, location, day (0-6), meal (lunch/dinner) | services |
| Guests | location, day, lunch count, dinner count | guests |
| Recipe Index | id, name, type, recipeSheetId, allergens, costPerServing, structure, seasonality, ratings, timesServed | recipe_index |
| Catering | id, name, date, guestCount, deliveryMode, dishes (JSON), logisticsNotes | caterings |
| Transport Item | id, text | transport_items |
| Feedback | timestamp, user, type, screen, text, userAgent | feedback |
| Ingredient DB | name, unit, source, costPer100, orderType, orderCode, orderAmount, allergens, storageLocation | separate sheet |
| Standard Inventory | id, name, amount, unit | data/standard-inventory.json (server-side) |
| Guest History | location, meal, date, count | guest_history (+ guest_history_meta for deviceMap) |
| Guests Next Weeks | monday_key, location, day, meal, count | guests_next_weeks |

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
- v1: Daily revenue input per location per service. One simple graph showing the week.
- v2: Cost tracking, cost per guest, budget vs actual
- v3: Full P&L, supplier analysis, waste tracking, automated reports
- ⚠️ Full finance module (v2+) triggers the PostgreSQL migration

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

### Current: Simple Monolith (good for many more modules)
```
Browser ←→ Express Server ←→ Google Sheets (dishes, guests, recipes, ingredient DB, guest history, next-week guests)
                            ←→ data/ JSON files (standard inventory)
```
- Single Node.js app on Railway
- Google Sheets as database
- Vanilla JS frontend, 12+ module files
- Good for: food planner + drinks + tasks + basic finance + non-food inventory

### When Needed: Database Migration ← triggered by full finance module
```
Browser ←→ Express Server ←→ PostgreSQL (primary data)
                            ←→ Google Sheets (recipe imports, ingredient DB)
```
- Add PostgreSQL on Railway when we need real queries, aggregations, audit trails
- Likely trigger: finance module going beyond simple revenue tracking
- Migrate operational data; keep Google Sheets for recipe/ingredient imports
- Stack unchanged: Node.js + Express + vanilla JS

### When Needed: User Roles ← triggered by scheduling or multi-location growth
```
Same architecture + role-based access control
```
- **Admin** (director): everything
- **Location manager**: full access to their location, read access to others and organisation-wide
- **Staff**: own schedule, own location's operations, read access to organisation-wide data
- **Cook/FOH**: operational tools for their role + transparency views

### When Needed: Frontend Framework ← only if vanilla JS becomes a genuine bottleneck
```
Browser (React/Next.js) ←→ API Server ←→ PostgreSQL + Google Sheets
```
- Switch only if vanilla JS genuinely becomes a bottleneck (15+ complex screens with shared state)
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
| Frontend | Vanilla JS → React/Next.js when needed | No build step now. Claude knows it perfectly. Migrate later if complexity demands. |
| Backend | Node.js + Express | Most common web server. Massive ecosystem. Claude's strongest language. |
| Database | Google Sheets → PostgreSQL | Sheets now (simple, good enough). Postgres when we need real queries (Phase 3). |
| Hosting | Railway | One-click deploy + database. Affordable. EU servers available. |
| Auth | Google Sign-In | Everyone has Google. Zero password management. |
| Version control | GitHub | Industry standard. |
| Language | JavaScript → TypeScript later | One language front + back. TypeScript adds safety when codebase grows. |

### Code Standards
- English for all code, comments, variable names
- UI text in English (team uses English internally)
- File names match purpose: drinks.js, scheduling.js, finance.js
- Each screen/module in its own JS file
- Shared utilities in utils.js and core.js
- Server routes grouped by module
- Commit messages explain what AND why
- Lots of inline comments explaining business logic

### Tutorial Maintenance Rule
**Every time a new feature is added or an existing feature is modified, the in-app tutorial steps for that page must be updated to match.**

The tutorials live in `public/js/tutorial.js`, organised by screen name (`dashboard`, `guests`, `planner`, `recipes`, `orders`). Each step is a plain object with a `selector`, `title`, and `body`. When you add a new section to a page, add a corresponding step. When you rename or restructure something, update the step that references it. The tutorials are the first thing a new cook reads — keeping them accurate is as important as keeping the code working.

---

## 7. Data Ownership & Security

- **All code**: Owned by De Sering, on GitHub
- **All data**: Owned by De Sering, on Google Sheets (now) → PostgreSQL on Railway (Phase 3+)
- **No vendor lock-in**: Standard technologies, exportable data, no proprietary formats
- **Backups**: Railway automated PostgreSQL backups + Google Sheets version history
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
