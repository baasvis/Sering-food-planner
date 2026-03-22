# Plan: Ingredient Database — In-App Management

## Context

The ingredient database currently lives in a separate old Google Sheet (`INGREDIENT_DB_SHEET_ID`). It has ~746 ingredients with English names chosen by the team, linked to Hanos order codes. The data is messy and outdated.

We're rebuilding it:
1. Move ingredient storage to a new `ingredients` tab in the **main** Google Sheet (DB_SHEET_ID)
2. Import supplier data from a **Hanos XLSX export** (1115 products with artikelnummer, prices, units, categories, nutrition)
3. Keep the team's English names from the old DB, match to Hanos products by order code
4. Build an in-app UI to browse, edit, and add ingredients
5. Support future CSV/XLSX uploads to refresh supplier data

## Data Model

New `ingredients` tab in DB_SHEET_ID with these columns:

| Field | Source | Description |
|-------|--------|-------------|
| id | generated | UUID |
| name | team (old DB) | English name chosen by team (e.g. "Spinach (frozen)") |
| supplier_name | Hanos CSV | Dutch name from supplier (e.g. "Spinazie Gehakt Diepvries") |
| category | old DB | Storage category (Vegetables, Fruits, Grains, etc.) |
| unit | old DB | Primary unit: Grams, ML, pieces |
| supplier | old DB / auto | Supplier name (Hanos, Groenhartig, etc.) |
| order_code | Hanos CSV | Artikelnummer (e.g. "34225259") |
| order_unit | Hanos CSV | Package description (e.g. "Pak 1 liter") |
| order_unit_standard | Hanos CSV | Collo info (e.g. "per collo a 8 pak") |
| order_price | Hanos CSV | Current stukprijs |
| order_amount_grams | calculated | Grams/ML per order unit (parsed from order_unit) |
| allergens | old DB | Allergen flags |
| notes | old DB | Team notes |
| storage_location | old DB | Where it's stored |
| active | flag | Whether this ingredient is currently used |

## Implementation Steps

### 1. Server: New `ingredients` tab CRUD

**File: `server.js`**

- Add `INGREDIENT_HEADERS` constant matching the columns above
- `GET /api/ingredients` — rewrite to read from `ingredients` tab in DB_SHEET_ID instead of separate sheet
  - Keep the same response format so existing orders.js code keeps working
  - Map new fields to the existing field names the frontend expects
- `POST /api/ingredients` — new endpoint to save all ingredients (same pattern as dishes writeTab)
- `POST /api/ingredients/:id` — update single ingredient
- `DELETE /api/ingredients/:id` — remove ingredient
- `POST /api/ingredients/import-hanos` — accept parsed Hanos data, match by order code, create/update entries

### 2. Server: Hanos XLSX Upload Endpoint

**File: `server.js`**

- `POST /api/ingredients/upload-supplier` — accepts XLSX file upload (multer)
- Parses the Hanos format: reads `prices` sheet, extracts title, artikelnummer, stukprijs, hoeveelheid, hoeveelheid_standaard, categorie, subcategorie
- Returns parsed products as JSON for the frontend to display and select
- Does NOT auto-import — returns data for user review

### 3. Server: Migration Endpoint (one-time)

**File: `server.js`**

- `POST /api/ingredients/migrate` — reads old ingredient CSV + Hanos XLSX
- For each old ingredient with a Hanos order code: merges team name + notes with Hanos supplier data
- For old ingredients without Hanos codes: imports with team data only
- Writes to new `ingredients` tab
- This is a bootstrap step, can be removed later

### 4. Frontend: Ingredient Database Screen

**File: `public/js/orders.js`** (extend existing file)

Add as 4th tab in Orders: Combined Order | Standard Inventory | Dish Ingredients | **Ingredient Database**

**Main view — searchable/filterable table:**
- Search by name, supplier name, order code
- Filter by category, supplier, active/inactive
- Columns: Name, Supplier name (hover shows full Dutch name), Category, Unit, Order code, Price, Active
- Click row → expand/edit inline or open detail panel

**Add ingredient:**
- Button to add manually (modal with name, unit, category, supplier, order code)
- When typing order code, auto-lookup from uploaded supplier data

**Edit ingredient:**
- Inline editing for key fields (name, category, notes, storage location, active)
- Supplier fields (order code, price, unit) come from CSV upload and can be manually overridden

**Supplier CSV upload (within Ingredients screen):**
- Upload button → accepts Hanos XLSX
- Shows preview of new/updated products
- "Import selected" → matches to existing ingredients by order code, creates new ones for unmatched
- User can link unmatched supplier products to existing ingredients

### 5. Frontend: Wire Up Existing Order System

**File: `public/js/orders.js`**

- `lookupIngredient()` already works by name matching — keep this working
- The `/api/ingredients` response format stays compatible
- No changes needed here initially

### 6. Initial Data Migration (programmatic, one-time)

- Build a migration script/endpoint that:
  - Old DB: name, notes, category, storage_location, unit, source (→ supplier), order code
  - Hanos XLSX: supplier_name (title), order_price (stukprijs), order_unit (hoeveelheid), order_unit_standard
  - Match by order code (374 direct matches found)
  - Non-Hanos items (Groenhartig, Lindenhof, etc.): import with team data only

## Files to Create/Modify

| File | Action |
|------|--------|
| `server.js` | Modify: new ingredient CRUD endpoints, XLSX upload, rewrite `/api/ingredients` |
| `public/js/orders.js` | Modify: add Ingredient Database tab with table, search, edit, upload |
| `public/js/state.js` | Modify: add ingredient-related state if needed |
| `public/index.html` | Modify: add styles for ingredient table |
| `package.json` | Modify: add `xlsx` and `multer` dependencies |

## Verification

1. Start dev server locally
2. Run migration endpoint to populate the ingredients tab
3. Navigate to Ingredients screen — verify table loads with all ~746 ingredients
4. Search/filter — verify responsiveness
5. Edit an ingredient name — verify it saves to Google Sheets
6. Go to Orders tab — verify lookupIngredient still works (combined order, dish ingredients, standard inventory search)
7. Upload the Hanos XLSX — verify it parses and shows preview
8. Import from upload — verify ingredients update with new supplier data
