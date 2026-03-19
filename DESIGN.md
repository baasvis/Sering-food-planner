# De Sering — Platform Design Document

Last updated: 2026-03-19

## What is this

De Sering is a community kitchen in Amsterdam operating across multiple locations (currently Sering West and Sering Centraal). This app manages their food operations — meal planning, ingredient ordering, stock management, and recipe library. It's used daily by kitchen coordinators and volunteers.

This document is the single source of truth for any AI assistant (Claude) working on this codebase. Read this first before making changes.

---

## Current Architecture

### Stack
- **Frontend**: Single-page app in `public/index.html` (~2800 lines). All JS inline in one `<script>` block. No framework — vanilla JS with template literals for rendering.
- **Server**: `server.js` (~640 lines). Node.js + Express. Handles auth, API routes, Google Sheets read/write.
- **Database**: Google Sheets as primary data store. Tabs: `dishes`, `services`, `guests`, `log`, `recipe_index`.
- **Ingredient DB**: Separate Google Sheet (`INGREDIENT_DB_SHEET_ID`). Contains all ingredients with order codes, suppliers, prices, storage locations.
- **Recipe Sheets**: Individual Google Sheets per recipe (linked via `recipeSheetId`). Each follows a standard template with ingredients, amounts, allergens, serving info.
- **Hosting**: Railway (auto-deploys from GitHub on push to main).
- **Auth**: Google Sign-In with allowed email list (`ALLOWED_EMAILS` env var).
- **Repo**: https://github.com/baasvis/Sering-food-planner

### Environment Variables (Railway)
- `DB_SHEET_ID` — Main database Google Sheet ID
- `INGREDIENT_DB_SHEET_ID` — Ingredient database Google Sheet ID
- `GOOGLE_CREDENTIALS` — Service account JSON credentials
- `GOOGLE_CLIENT_ID` — Google OAuth client ID for Sign-In
- `ALLOWED_EMAILS` — Comma-separated list of authorized emails

### Data Model

**Dish** (stored in `dishes` tab):
```
id, name, type (Soup|Main course|Dessert), stock (liters), serving (ml),
storage (Gastro|Frozen|Vac-packed), logistics (Sering West|Transport to Sering Centraal|Transport to Sering West|Sering Centraal),
allergens[], extraAllergens[], orderFor (bool), cookMode, cookDay, cookDate, cookConfirmed,
recipeSheetId, recipeVolume, recipeIngredients[], parentId, createdAt
```

**Service** (stored in `services` tab):
```
id, dish_id, location (west|centraal), day (0-6), meal (lunch|dinner)
```

**Guests** (stored in `guests` tab):
```
location, day, lunch (count), dinner (count)
```

**Recipe Index** (stored in `recipe_index` tab):
```
id, name, type, recipeSheetId, allergens[], costPerServing, structure,
seasonality, servingTemp, servingSize, recipeVolume, recipeIngredients[],
createdAt, avgSkill, avgSpeed, avgBanger, timesServed
```

**Ingredient DB** (separate sheet, read-only from app):
```
name, unit (Grams|ML), source (supplier), costPer100, orderType,
orderCode (Hanos product number or URL), actualUnit, orderAmount,
notes, orderPrice, unitRecalc, allergens, storageLocation
```

### Recipe Sheet Template (per dish)
Key cells read by `/api/recipe`:
- `C1` — Dish name
- `B3` — Serving size (ml)
- `D3` — Allergens (comma-separated)
- `F3` — Serving temperature
- `H3` — Structure (Open/Closed)
- `K2` — Type of dish
- `K4` — Recipe volume (liters)
- `O3` — Seasonality
- `O4` — Cost per serving
- `J6:N40` — Ingredients (name, measurement, amount, amount after cooking, cost)
- `K6:K40` — Measurement types per ingredient
- `X6:X40` — Supplier/source per ingredient

### Key Formulas
- **Required stock (liters)** = sum across services: (guests ÷ peer_dishes_of_same_type) × (serving_ml ÷ 1000)
- **Ingredients per guest** = ingredient_amount_after_cooking ÷ (recipeVolume_liters × 1000 ÷ serving_ml)
- **Total ingredients needed** = ingredients_per_guest × total_guests_for_dish
- Amounts stay in original units (kilos, grams, liters, ml). Conversion to grams only for order-unit calculation.

---

## Current Features (v1 — completed)

### 1. Dashboard
- Today's menu per location with dish chips
- Guest count summary (lunch/dinner totals)
- Stock alerts (dishes below required stock)
- Week-at-a-glance (dish count per day)
- Quick navigation to all sections

### 2. Guest Counts
- Table per location: days as columns, lunch/dinner as rows
- Shows dates for current week, today highlighted in blue
- Daily totals row, weekly total in header
- Assigned dishes shown below each input
- Totals recalculate live with focus preservation

### 3. Weekly Planner
- Location tabs (West / Centraal)
- Grid: days as columns with dates, split by Lunch/Dinner
- Each meal has sub-rows for Soups, Mains, Desserts
- Color-coded chips (green=soup, blue=main, purple=dessert)
- Copy slot to other location button (→ Centraal / → West)
- Add dish modal pre-filters by type, with search

### 4. Dishes (Menu Planner)
- Sortable by name, cook date, stock, +/- (click headers)
- Default grouping: To cook / Cooked / Frozen
- Logistics color-coded left borders with legend
- Inline editing: name, stock, type, storage, logistics (click to cycle)
- Cook date: day picker or date picker, confirm-cooked flow
- Order toggle per dish
- Served button: archive with Skill/Speed/Banger ratings
- Allergen management (base from recipe + extra manual)
- Stock status pills: green (OK), amber (low), red (short)
- Filter by location, storage, logistics

### 5. Recipes (Dish Index)
- Sortable table: name, type, structure, cost, seasonality, allergens, ratings
- Conditional cost coloring per type (green=cheap, red=expensive)
- Add recipe: paste Google Sheet URL, auto-fetches all metadata
- Bulk import: paste multiple URLs, progress bar
- "+ Menu" button adds dish to planner from recipe
- Fuzzy ingredient name matching for DB lookup
- Ratings aggregated from dish archive (running average)

### 6. Orders (Order Overview)
- Stock shortfall section (dishes needing cooking/restock)
- Combined ingredient list from all dishes flagged "Order"
- Grouped by supplier (Hanos first, then alphabetical)
- Order codes from ingredient DB (product numbers or links)
- In-stock input column for kitchen inventory
- To-order calculation (needed - in stock)
- Order units calculation (amount ÷ package size)
- Refresh recipe data button (re-fetches from Google Sheets)
- Copy all order codes button per supplier

---

## Roadmap

### Phase 2 — Expand food operations
- [ ] Import all existing recipes from old dish index spreadsheet
- [ ] Drinks inventory (stock tracking, ordering)
- [ ] Non-food inventory (cleaning supplies, equipment)
- [ ] Standard inventory items (always-in-stock list separate from dishes)

### Phase 3 — Staff & scheduling
- [ ] Volunteer/staff database (name, email, phone, skills, certifications)
- [ ] Weekly shift schedule (similar grid to meal planner)
- [ ] Availability submission (staff mark when they're free)
- [ ] Shift assignment (managers assign people to shifts)
- [ ] Open shifts (unassigned, staff can claim)
- [ ] Time tracking (clock in/out via web interface)
- [ ] Hour approval workflow
- [ ] Skills/training tracking (who can cook what, equipment certified)
- [ ] Privacy notice and GDPR compliance page

### Phase 4 — Finance & reporting
- [ ] Supplier spend tracking (per order, per week, per month)
- [ ] Cost per guest calculations (ingredients + labour)
- [ ] Budget vs actual reporting
- [ ] Waste tracking
- [ ] Weekly operations report (auto-generated summary)

### Phase 5 — Multi-location & scale
- [ ] Third location support (flexible location management)
- [ ] Location-specific settings (suppliers, storage areas)
- [ ] Role-based access (coordinator vs volunteer vs finance)
- [ ] Database migration: Google Sheets → PostgreSQL
- [ ] Progressive Web App (installable, offline-capable)

### Future ideas (not planned)
- Guest-facing allergen lookup / digital menu board
- Equipment maintenance scheduling
- Volunteer onboarding flow with training modules
- Donation tracking and donor management
- Integration with accounting software

---

## Technical Migration Plan

When the single-file architecture becomes a bottleneck (probably around Phase 3), the migration path is:

1. **Split frontend into modules** — Extract each screen into its own JS file. Keep vanilla JS (no framework needed yet).
2. **Add a real database** — PostgreSQL on Railway. Keep Google Sheets for recipe imports and ingredient DB (where cooks edit directly).
3. **Add user roles** — coordinator, volunteer, finance. Stored in DB.
4. **Consider Claude Code** — Move development to local environment with Claude Code for better multi-file handling and testing.

---

## Constants

```javascript
DAYS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun']
MEALS = ['lunch','dinner']
STORAGE = ['Gastro','Frozen','Vac-packed']
LOGISTICS = ['Sering West','Transport to Sering Centraal','Transport to Sering West','Sering Centraal']
ALLERGENS = ['Gluten','Soy','Nuts','Peanuts','Sesame','Celery','Mustard','Sulphites','Lupin','Onion','Garlic','Paprika']
TYPES = ['Soup','Main course','Dessert']
```

## Git Workflow
- Push directly to `main` branch
- Railway auto-deploys on push
- Commit messages describe what changed and why
- `.gitignore`: node_modules/, package-lock.json, *.bak

## Development Notes
- The `cleanSheetId()` function auto-strips URL parts from sheet IDs in env vars
- Recipe sheet names with apostrophes are handled (JS-safe onclick via ID lookup)
- Ingredient name matching: exact → prefix → base-name (strips parentheticals)
- Supplier names are normalized to title case for grouping
- cookConfirmed persists to Google Sheets (added later — old dishes may need re-confirmation)
- Ingredient amounts stay in recipe's original units (kilos, liters, grams, ml)
