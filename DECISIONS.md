# DECISIONS — autonomous drinks-module run

Running log of every choice made under GOAL.md §6's decision policy where the
answer wasn't dictated by DRINKS_DOMAIN.md / DESIGN.md / CLAUDE.md (priority 1–2)
and I had to fall back to the closest existing pattern (3) or judgement (4).
Format: `[Mxx] What was ambiguous → what I chose → why.`

## Setup / safety

- **[prep] `DATABASE_URL` pointed at the production host (centerbeam…).** Per the
  GOAL safety gate I stopped and asked; the user chose "staging for both", so the
  worktree `.env` points both `DATABASE_URL` and `DATABASE_URL_TEST` at the
  staging DB (shuttle…:52350). The build, migrations and tests all run against
  staging — never production.
- **[prep] Migration mechanism.** GOAL §2 says "via `prisma migrate dev`", but
  running `migrate dev` against the *shared* staging DB risks a destructive reset
  prompt (drift) and an unwanted auto-seed, and my saved repo note warns against
  it. Chose: edit schema → generate the migration SQL with `prisma migrate diff`
  (Prisma-authored, additive-only, no shadow DB) → apply forward-only with
  `prisma migrate deploy`. Same end state as `migrate dev` (a real Prisma
  migration folder + applied + recorded), but safe on a shared DB. This matches
  the repo's hand-authored-migration + deploy pattern (reference: prisma-migration
  safety note).

## M1 — schema + types

- **[m1] Stock storage shape.** DRINKS_DOMAIN §3 wants one pool per location but
  counts stored per storage area, with per-area history. Chose a dedicated
  `DrinkStock` table keyed (drinkId, location, area) — pool = Σ qty over areas —
  rather than a JSON blob on the Drink row. Cleaner querying + naturally keeps the
  per-area split the domain asks for. Pool totals are denormalized onto the Drink
  read shape (`stockByLocation`).
- **[m1] Ingredient references are loose (no Prisma relation).** Recipe ingredient
  rows, order lines and write-offs store a plain `ingredientId` string with no FK
  to the `ingredients` table. Reason: declaring a Prisma relation would force a
  back-relation field on the Ingredient model and couple drinks to ingredient
  lifecycle — the GOAL touch-points only permit *read-only* use of the Ingredient
  DB. Names/costs are resolved in code (the costing pass loads ingredients
  anyway). The Drink→Drink building-block ref IS a real self-relation (contained
  entirely within new drinks tables).
- **[m1] One `DrinkConfig` singleton** (id="default", JSON blob) for module config
  (labour rate, price rounding, BTW rule, markup targets, demand-nudge threshold,
  default shelf life) — mirrors the existing StorageConfig / KitchenEquipment /
  CookRhythm / ClosedServices singletons.
- **[m1] Serving formats unify pricing.** Both catalogue and recipe drinks carry a
  `formats[]` array with per-location prices, so markup/suggested-price logic
  reads one shape. Recipe-specific data (ingredient rows, batch, prep time, etc.)
  lives in dedicated columns.
- **[m1] Drinks as ONE nav screen with sub-tabs** (planned for M2): Catalogue /
  Recipes / Stocktake / Orders / Production / Bar / Menus — mirroring how
  `planner` and `orders` use internal tabs — rather than 6 top-level nav entries.
  Keeps the nav uncluttered and fits the tutorial-key = screen-id rule. `drinks`
  is deliberately NOT added to the role `GATEABLE_SCREENS` list (extending the
  role system is out of scope per GOAL §7); manager-gating is the separate
  `MANAGER_EMAILS` tier.

## M2 — catalogue + CRUD + seed

- **[m2] Catalogue-mode drink CRUD is manager-gated wholesale.** GOAL §5 gates
  "prices, supplier data, markup, publishing", not all CRUD. But a catalogue
  (bought) drink is *defined* by those manager-owned fields, so gating the whole
  create/update/delete for `mode:'catalogue'` is the pragmatic reading. M3 keeps
  recipe-mode drafting open to all with field-level price gating. Enforced inline
  (`assertManager`) not via `requireManager` middleware, so M3 can relax recipe
  writes on the same endpoints.
- **[m2] Seeded catalogue status.** The seed marks the live bar catalogue as
  `published` (so M7 service cards show it), except `sellable:false` items
  (consumables/glassware) which seed as `draft`.
- **[m2] `num()` preserves null.** A normalizer coerced an unset price/par
  (`null`) to `0` via `Number(null)===0` (a free drink). Fixed to keep null;
  found via preview verification, pinned by test/drinks-helpers.test.ts.
- **[m2] Domain enums (§6) are frontend constants** (`drinks-constants.ts`).
  In-app *editable* enum lists are a future enhancement; Phase-1 uses constants
  + free text where sensible.
- **[m2] e2e specs land in their milestones.** Per GOAL ("from M4 on"), the
  catalogue-CRUD e2e is written in M4 with the stocktake spec, not in M2. M2's
  gate is typecheck + jest.
- **[m2] Suppliers tab is read-only in M2**; full supplier CRUD UI lands with
  Ordering (M5). Endpoints already support it.
- **[m2] `isManager` on AppUser** (director ∪ MANAGER_EMAILS), stamped with
  `isDirector`. `dev@local` is in `MANAGER_EMAILS` (worktree `.env`) so the
  dev/e2e user can drive manager-gated catalogue CRUD.

## M3 — recipes + costing

- **[m3] Cost engine lives in `shared/drink-cost.ts`** (dual-use, mirroring
  `shared/recipe-cost.ts`) so the backend recalc and the frontend live preview
  run the *same* code. Unit-tested directly (test/drink-cost.test.ts).
- **[m3] Recipe CRUD is open to all users; money fields are manager-gated.**
  Anyone can draft/edit/publish a recipe drink (the head-waiter use case from
  DESIGN.md); price + costPrice are preserved from the existing row for
  non-managers (`gateMoneyFields`) so they can't set/wipe prices.
- **[m3] Labour yield derivation.** When a recipe omits `prebatchYieldServings`,
  labour amortises over `batch.volumeMl ÷ serveVolumeMl` (else 1) — without this
  a 4 L iced-tea batch booked 20 min of labour *per glass* (€6/serve). Pinned by
  a unit test.
- **[m3] Building-block `costPerServe` stores €/L** (cost per litre) since blocks
  aren't served; served recipes store €/serve.
- **[m3] Seed cost computation is a compact JS port of `shared/drink-cost.ts`**
  (seed.js is plain JS, can't import the TS engine). The app recomputes on every
  save via the TS engine (the source of truth), so any drift self-heals.
- **[m3] Reverse-engineered markup targets are best-effort.** Per-category median
  of `priceExBTW ÷ cost`, sampling only drinks with a real ingredient cost and
  capping markups at 12× (a higher value means missing `costPrice`, not a real
  margin). Many catalogue spirits lack `costPrice`, so targets (e.g. cocktail
  ~6.6×) are rough starting points — spec-sanctioned ("fall back to default") and
  manager-editable. Suggested prices flag genuinely low-margin drinks (e.g.
  Mezcal Margarita at €9.50 shows red vs the category target).

## M4 — stocktake

- **[m4] Drink storage areas are a constant** (`DRINK_STORAGE_AREAS` in
  drinks-constants.ts), per location, NOT added to the food storage-config —
  adding kegs/wine-lowboy to the food storage picker would pollute it. §9's
  "reuse storage-config" touch-point is optional; revisit if staff want to edit
  drink areas in-app.
- **[m4] Stocktake consumes the seed bootstrap row.** Counts are stored per
  (drink, location, area); on the first real count of a drink+location the seed
  `"Uncounted (pre-stocktake)"` row is deleted so the pool isn't double-counted.
  Pool = Σ area rows.
- **[m4] Stocktake save is open to all** (counts are an all-user action, §5);
  `POST /api/drinks/stock/bulk` takes `{location, area, items:[{drinkId,qty}]}`.
- **[m4] playwright.config sets `MANAGER_EMAILS: 'dev@local'`** on the e2e
  webServer (mirroring the existing `STAFF_LEAD_EMAILS`) so the dev/e2e user can
  drive manager-gated catalogue CRUD + stocktake.
- **[m4] Catalogue-CRUD e2e written here** (deferred from M2 per the GOAL "e2e
  from M4 on" rule), alongside the stocktake spec. 3 specs green.

## M5 — ordering

- **[m5] Ordering is manager-gated** (supplier/ordering is manager territory,
  §5). Order math (`buildOrderSuggestions` / `suggestedOrderQty`) is a pure
  shared helper (shared/drink-order.ts), unit-tested.
- **[m5] Suggested order = par − stock, rounded up to whole order units**,
  positives only, per supplier × location.
- **[m5] Receiving adds to a "Delivery intake" pseudo-area** (not a real shelf),
  which the next stocktake reconciles away (alongside the seed bootstrap).
  Substitutions route the received qty to the substitute drink
  (`receivedStockDeltas`).
- **[m5] `expectedDelivery` carries the supplier's delivery-window text**
  (best-effort), not a strict ISO date — avoids a date-picker for Phase 1.
- **[m5] Demand nudge is client-side** (`demandNudge`): upcoming-week guests
  (S.guestsNextWeeks) vs the current-week baseline (S.guests); banner only, no
  auto-change to par/quantities.
- **[m5] Order e2e receives qty 0** so the lifecycle (draft→ordered→received) is
  exercised without permanently mutating staging stock.

## M6 — production & corrections

- **[m6] Production increments the made drink** in a "Made (fresh)" pseudo-area
  (reconciled by the next stocktake, like receiving's "Delivery intake") and
  decrements consumed building blocks (drinks-internal). **Shared Ingredient-DB
  stock is NOT auto-deducted** — it conflicts with the read-only Ingredient
  touch-point; consumption is recorded on the production log/recipe instead. A
  future toggle could enable real ingredient deduction.
- **[m6] Write-offs decrement the drink pool** largest-area-first (clamped ≥ 0)
  and record a reason. Ingredient write-offs are recorded but don't touch the
  Ingredient DB (same read-only reasoning).
- **[m6] Throw-out** of an expired production log creates an `expired` write-off,
  decrements the made stock, and marks the log `discarded`.
- **[m6] Production + write-offs are open to all users** (§5: counts, production,
  write-offs are all-user actions).
- **[m6] No e2e** — M6 isn't in the GOAL §4 e2e list; covered by the
  production/write-off unit tests (test/drink-production.test.ts) + typecheck.
