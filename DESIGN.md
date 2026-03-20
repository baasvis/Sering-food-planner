# Sering Suite — Design Document & Roadmap

*Last updated: 2026-03-20*
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
- Dashboard with today's menu, guests, stock alerts, week overview
- Guest count tables per location (West + Centraal) with live totals and dates
- Weekly planner grid (days × meals × dish types: Soups/Mains/Desserts) with copy-to-other-location
- Dish management with inline editing, cook date tracking, stock levels, +/- status pills, sortable columns
- Recipe index (library) with single + bulk import from Google Sheets, ratings, conditional cost colouring
- Order overview with ingredient aggregation, supplier grouping (Hanos first), order codes, in-stock input, to-order calculation
- Ingredient database integration (separate Google Sheet with supplier codes, units, prices)
- Feedback system (floating purple button, structured form with 4 types, stores to Google Sheets)
- Mobile responsive layout (card-based dishes on phone, bottom-sheet modals, compact nav)
- Logistics colour coding with legend, filter bars, section grouping (To cook / Cooked / Frozen)

**File structure:**
```
public/
  index.html           (~480 lines — HTML + CSS skeleton)
  js/
    state.js           — Constants, app state
    auth.js            — Google Sign-In, sessions
    utils.js           — API, save system, toast, ingredient DB loading
    core.js            — Planner rebuild, calculations, badges, served/archive
    dashboard.js       — Dashboard screen
    guests.js          — Guest counts screen
    planner.js         — Weekly planner screen
    dishes.js          — Dishes screen (~750 lines, largest module)
    recipes.js         — Recipe index screen
    orders.js          — Order overview screen
    feedback.js        — Feedback button and form
    init.js            — Modal, HTML escape, app init
server.js              — Express server (~670 lines)
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
| Feedback | timestamp, user, type, screen, text, userAgent | feedback |
| Ingredient DB | name, unit, source, costPer100, orderType, orderCode, orderAmount, allergens, storageLocation | separate sheet |

**Recipe Sheet Template** (individual Google Sheets per recipe):
- C1: dish name, B3: serving size (ml), D3: allergens, F3: serving temp, H3: structure
- K2: dish type, K4: recipe volume (liters), O3: seasonality, O4: cost per serving
- J6:N40: ingredients (name, measurement, raw amount, amount after cooking, cost)
- K6:K40: measurement types (kilo's, Grams, Liters, ML — amounts stay in original units)
- X6:X40: supplier/source per ingredient

**Key formulas:**
- Required stock (L) = Σ services: (guests ÷ peer_dishes_same_type) × (serving_ml ÷ 1000)
- Ingredients per guest = ingredient_amount ÷ (recipeVolume_L × 1000 ÷ serving_ml)
- Amounts stay in recipe's original units; conversion to grams only for order-unit calculations

---

## 4. Module Roadmap

### Phase 1: Complete the Food Planner ✅ (mostly done)
- [x] Core meal planning, guest counts, dish management
- [x] Recipe index with bulk import
- [x] Order overview with ingredient DB
- [x] Mobile responsive
- [x] Code split into modules
- [x] Feedback system
- [ ] Import all existing recipes from old spreadsheet
- [ ] Standard inventory items (always-in-stock list separate from per-dish ingredients)
- [ ] TestTafel menu planning variant (7-course format, cost/labour per course, portion sizing, collective planning)

### Phase 2: Inventory & Drinks
**Goal**: Complete picture of everything in the kitchens and bars.

**Non-food inventory**
- Cleaning supplies, equipment, disposables
- Par levels (minimum stock), reorder triggers
- Per-location tracking
- Simple check-in/check-out for shared equipment between locations

**Drinks system** (unified across all locations)
- Each drink: name, type (wine/beer/spirit/cocktail/non-alcoholic/homemade), supplier, cost, selling price, margin
- Wine specifics: tasting notes, region, producer, natural/organic certification, pairing suggestions
- Cocktails & homemade drinks: recipe with ingredients, prep time, cost calculation
- Automatic pricing suggestions based on cost + target margin
- Stock tracking per location's bar
- Supplier ordering (same pattern as food ingredient ordering)
- **Key use case**: TestTafel's head waiter can freely experiment with homemade drinks, seeing immediately what it costs and what it should be priced at

**Technical**: Still on Google Sheets DB. New JS modules (drinks.js, inventory.js). New server routes. Same app, new tabs.

### Phase 3: Finance & Reporting ← DATABASE MIGRATION POINT
**Goal**: Daily/weekly financial insight. Replace the current Google Sheets finance tracking.

**⚠️ Before starting this phase: migrate from Google Sheets to PostgreSQL.**
Financial data needs real transactions, proper queries, aggregations, and audit trails.

- Revenue tracking per location, per service type (lunch/dinner/bar/events/catering)
- Cost tracking: food costs, drink costs, labour costs, fixed costs
- Cost per guest (food + labour), per location, per service
- Budget vs actual per week/month
- Supplier spend analysis (trends, who costs most, where to negotiate)
- Simple P&L per location + consolidated organisation-wide
- Cash flow overview
- Waste tracking (what got thrown away, why, cost impact)
- Weekly auto-generated operations report
- **Integration**: pulls from food planner (ingredient costs, guest counts), drinks (bar revenue/costs), and later scheduling (labour hours)

**Technical**: PostgreSQL on Railway. Migration of existing data. Keep Google Sheets for recipe imports + ingredient DB. New finance.js module. Possibly first use of charts (Chart.js).

### Phase 4: Staff Scheduling & Management
**Goal**: Replace paid scheduling software for ~25-35 paid staff across 3 locations.

*Volunteer scheduling stays on schedule.desering.org — this is for paid staff only.*

- Staff profiles: name, email, phone, locations, skills/certifications, contract (hours/week)
- Weekly schedule grid (familiar pattern from the meal planner)
- Shift templates (recurring patterns, e.g. "TestTafel service Wed-Sat")
- Availability submission (staff mark when they're free/unavailable)
- Open shifts (unfilled slots staff can claim)
- Shift swap requests (staff-initiated, manager-approved)
- Time tracking: clock in/out via web app (tablet at each location)
- Hour approval workflow (manager reviews → approves)
- Leave balance tracking (vacation, sick days)
- Labour cost calculation (hours × rate → feeds into finance module)
- Skills matrix (who's trained on: cooking, FOH, bar, cargo bike, events, specific equipment)
- GDPR: privacy notice, data deletion capability, minimal data collection

**Technical**: PostgreSQL (already migrated in Phase 3). New scheduling.js, staff.js modules. Progressive Web App consideration for push notifications about schedule changes.

### Phase 5: Project & Task Management
**Goal**: Lightweight system for organising work beyond daily operations. Replaces Notion.

**Task management** (daily operations)
- Daily task checklists per location/role (opening, closing, cleaning, prep)
- Recurring tasks (weekly deep clean, monthly equipment check, quarterly reviews)
- One-click depth: summary at a glance, detailed instructions one tap deeper
- Task completion tracking (who, when)
- Kitchen-friendly: big buttons, works with wet hands, minimal reading
- Teaching built in: tasks double as training materials for new people

**Project management** (lightweight, transparency-focused)
- Anyone can create a project (visible to all by default, can be made private)
- Guided project creation: structured conversation to define goal → steps → resources → timeline
- Designed around the "office guide" workflow: 5-60 min talk → structured project in the system
- Not perfect, but "60% of perfect" — enough to be legible and move forward
- Note-taking built into each project
- Resource/budget allocation visible

**Technical**: PostgreSQL. May benefit from React at this point if the UI complexity warrants it. AI assistance could help with the guided project creation flow.

### Phase 6: Advanced Features (future, not planned in detail)
- Guest-facing allergen lookup / digital menu board
- Catering management module (quotes, logistics, billing)
- Equipment maintenance scheduling
- Volunteer onboarding with training modules
- Donation tracking and donor management
- Accounting software integration (Exact, Twinfield)
- Event management (bookings, capacity, equipment, bar projections)
- AI features: recipe suggestions from seasonal ingredients, automated weekly reports, demand forecasting

---

## 5. Technical Architecture Evolution

### Current (Phase 1-2): Simple Monolith
```
Browser ←→ Express Server ←→ Google Sheets
```
- Single Node.js app on Railway
- Google Sheets as database
- Vanilla JS frontend, 12 module files
- Good for: up to ~4-5 modules, <30 users

### Phase 3: Database Migration ← KEY TRANSITION
```
Browser ←→ Express Server ←→ PostgreSQL (primary data)
                            ←→ Google Sheets (recipe imports, ingredient DB)
```
- Add PostgreSQL on Railway
- Migrate operational data (dishes, services, guests, recipe index, feedback, finance)
- Keep Google Sheets for: recipe sheet imports, ingredient DB (cooks edit directly in Sheets)
- Add database migrations (version-controlled schema changes)
- Stack unchanged: Node.js + Express + vanilla JS

### Phase 4: User Roles
```
Same architecture + role-based access control
```
- **Admin** (director): everything
- **Location manager**: full access to their location, read access to others and organisation-wide
- **Staff**: own schedule, own location's operations, read access to organisation-wide data
- **Cook/FOH**: operational tools for their role + transparency views

### Phase 5+: Consider Frontend Framework (only if needed)
```
Browser (React/Next.js) ←→ API Server ←→ PostgreSQL + Google Sheets
```
- Switch only if vanilla JS genuinely becomes a bottleneck (15+ complex screens with shared state)
- Next.js — Claude knows it best, huge ecosystem
- Gradual migration: one screen at a time
- Same API server underneath

### Scaling to 6 Locations
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

### Recommended Workflow Evolution

| Phase | Tool | Why |
|-------|------|-----|
| 1-2 (now) | Claude.ai chat | Works for current scale. Limitation: context window resets each session. |
| 2-3 | Claude Code (transition point) | Full filesystem access, sees all files, runs server, tests changes. Same natural language. Needs: Node.js + git on your computer (~1 hour setup). |
| 4+ | Claude Code + local dev | Multiple contributors possible. Code review. Automated testing. |

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
