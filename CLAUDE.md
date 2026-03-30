# CLAUDE.md — Sering Food Planner

## Stack
- Node.js/Express server, vanilla JS frontend (no build step, no bundler)
- All frontend JS files loaded as `<script>` tags — functions are global
- PostgreSQL database via Prisma ORM, Google Sign-In for auth
- Google Sheets API used for external recipe sheet reading only (lib/recipe-sheets.js)
- Hosted on Railway (auto-deploy from main branch, Postgres plugin)

## Project Structure
```
server.js              — Express app entry point, mounts routers, global error handler
lib/
  config.js            — Configuration, env vars
  db.js                — Prisma client, row transformers, dbReadAll/dbWriteAll, validators
  recipe-sheets.js     — Google Sheets client (external recipe reading only)
  hanos-parser.js      — Hanos quantity parser (hoeveelheid → grams)
routes/
  auth.js              — Login, logout, session, requireAuth middleware
  data.js              — GET/POST /api/data + POST /api/data/patch (main planner state)
  batches.js           — Batch CRUD: GET/POST/PATCH/DELETE /api/batches
  recipes.js           — Recipe index CRUD + single recipe fetch
  ingredients.js       — Ingredient CRUD + stock management
  ingredients-import.js — Hanos XLSX upload + CSV migration
  guests.js            — Guest history + next-weeks predictions
  inventory.js         — Standard inventory (per-location) + storage config + prep checklist + activity log
  feedback.js          — User feedback
  events.js            — SSE live sync: client registry, broadcast to other users on save
  health.js            — Health check endpoint
public/
  index.html           — Shell HTML + login screen (nav generated from NAV_SCREENS)
  css/
    base.css           — Variables, resets, layout, shared components, modals
    dashboard.css      — Dashboard cards, prep checklist, team todos
    guests.css         — Guest count tables, predictions, upload zone
    planner.css        — Week grid, dish list, slots, inventory, cook workflow
    orders.css         — Order tabs, ingredient tables, ingredient DB styles
    recipes.css        — Recipe index table
    feedback.css       — Feedback FAB and form
    tutorial.css       — Tutorial overlay and tooltips
    mobile.css         — All mobile/responsive overrides, bottom nav
  js/
    state.js           — Constants (DAYS, MEALS, etc.) + NAV_SCREENS + storage config helpers + global state object S
    auth.js            — Google Sign-In, sessions
    utils.js           — API helpers (apiGet/apiPost), save system, toast, prep checklist, SSE live sync client
    core.js            — rebuildPlanner, calcRequired, diffStr, badges, isServicePast
    dashboard.js       — showScreen(), Dashboard screen
    predictions.js     — Guest prediction from POS CSV data
    guests.js          — Guest count tables
    planner.js         — Week plan grid + transport + inventory modal
    dishes.js          — Dish list + cook workflow + CRUD
    caterings.js       — Catering events
    recipes.js         — Recipe index/library
    orders.js          — Order overview (combined, standard inventory, dish ingredients tabs)
    ingredient-db.js   — Ingredient database editor + supplier import
    feedback.js        — Feedback form
    tutorial.js        — Guided tutorial system
    init.js            — Modal system, esc helper, buildNav(), beforeunload guard, initApp (MUST load last)
```

## Script Load Order
Scripts must load in the order listed in index.html. Earlier scripts define globals used by later ones.
Key chain: `state.js` -> `auth.js` -> `utils.js` -> `core.js` -> [feature files] -> `init.js` (last)

## Conventions
- All frontend functions are global (no modules, no import/export)
- State lives in the global `S` object (defined in state.js)
- Each screen has a render function: `renderDashboard()`, `renderOrders()`, etc.
- `rerenderCurrentView()` refreshes the active screen
- `scheduleSave()` debounces auto-save to PostgreSQL
- Date format: ISO "YYYY-MM-DD" for service dates, "DD-MM-YYYY" for cook dates in UI
- Location keys: "west", "centraal" (in data), "Sering West"/"Sering Centraal" (display)
- Server writes use `withWriteLock()` to serialize concurrent writes
- Prisma schema in `prisma/schema.prisma` — run `npx prisma migrate dev` after changes
- Navigation screens defined in `NAV_SCREENS` array (state.js) — add new screens there, not in HTML
- CSS split into per-screen files in `public/css/` — add new screen styles to the matching file

## Search/Filter Input Rule
When a search or filter input triggers a re-render, **never replace the input's own DOM element**.
Use the split-container pattern: put results in a separate `<div id="xxx-results">` and only update that.
- Screen-level: render the search input once in the parent, update only `#results-container.innerHTML`
- Modal-level: on first open call `showModal()` with full HTML; on subsequent updates check for an existing element (e.g. `document.getElementById('my-list')`) and only replace the list innerHTML
- See `recipes.js` (`renderRecipeIndex` + `updateRecipeResults`) and `planner.js` (`renderAddModal`) for examples

## Key Data Flow
- `GET /api/data` returns `{batches, guests, recipeIndex, caterings, transportItems}`
- `POST /api/data` saves `{batches, guests, caterings, transportItems}`
- `POST /api/data/patch` merges `{batches, deletedBatches, guests, caterings, ...}`
- Batch CRUD: `GET/POST /api/batches`, `GET/PATCH/DELETE /api/batches/:id`
- Batch = physical container of food. Lifecycle: PLANNED → COOKED → SERVING → DONE
- Key batch fields: `location` ("west"/"centraal"), `inTransit` (bool), `services` (embedded JSON), `cookDate`, `note`
- Cannot delete a batch with stock > 0 (real food exists)
- Ingredient DB has separate endpoints: `/api/ingredients`, `/api/ingredients/full`, `/api/ingredients/:id`
- Ingredient stock endpoints: `/api/ingredients/stock`, `/api/ingredients/stock/bulk`
- Ingredient migration: `POST /api/ingredients/migrate` (accepts oldCsv + hanosCsv, supports `?dryRun=true`)
- Ingredient DB stores JSON fields: `types`, `storageLocations`, `stock`, `nutrition`, `priceHistory` (Prisma Json type)
- Ingredient constants in state.js: `INGREDIENT_TYPES`, `INGREDIENT_CATEGORIES`, `PRICE_LEVELS`
- Storage config: `GET/POST /api/storage-config` — per-location areas with colors, order, and spots (persisted as JSON)
- `STORAGE_CATEGORIES` is dynamically rebuilt from `S.storageConfig` via `rebuildStorageCategories(loc)`
- Standard inventory: `GET/POST /api/standard-inventory?location=west|centraal` — per-location weekly base order
- Guest history and next-weeks have their own endpoints with flat↔nested JSON conversion
- Live sync: `GET /api/events` (SSE) — clients receive patches from other users in real-time. `broadcast()` in events.js sends to all connected clients except the sender (matched by email). Frontend `applyRemotePatch()` merges into state and re-renders.

## Running
```bash
npm start          # port 3000 by default
```
Requires `DATABASE_URL` env var pointing to PostgreSQL.
Without `GOOGLE_CLIENT_ID` set, runs in dev mode (no real auth).

## Don't
- Don't add a build step or bundler
- Don't use import/export in frontend files
- Don't change the Prisma schema without creating a migration (`npx prisma migrate dev`)
- After any migration, always verify `prisma/schema.prisma` matches the DB: run `npx prisma db pull` then `npx prisma generate`, and ensure all fields use camelCase with `@map("snake_case")`. Commit the updated schema in the same PR.
- Don't break the script load order in index.html
- Don't remove withWriteLock from write endpoints
