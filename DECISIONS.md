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

## M7 — service cards (bartender mode)

- **[m7] "Active assortment" = published + sellable drinks at the current
  location.** M7 ships before M8 (assortments), so the bar grid is location-based;
  M8 adds curated per-assortment selection. The Bar tab is purely read-only over
  S.drinks (no backend) — a full-screen build card (glass, serve ml, build steps,
  garnish, profile, price), large type, dark-mode friendly via theme vars.
- **[m7] Bar tab placed second** (after Catalogue) for floor-staff prominence;
  the default sub-tab stays Catalogue. Verified in preview (66 tiles, build card).

## M8 — assortments & menu designer

- **[m8] Assortments seeded** (West Bar / Sering Centraal / TestTafel); entries
  resolve drink names → ids by name. TestTafel = an assortment on `centraal`
  location with `serviceContext: 'testtafel'` (shares Mediamatic stock).
- **[m8] Menu print is server-rendered A4 HTML** (`GET /api/drinks/menus/:id/print`,
  mirroring the recipe print route): drinks grouped by category in the
  assortment's order, live per-location prices, layout presets (1–2 columns,
  type scale), auto-print on load. Print-CSS is inline (helmet CSP is off).
- **[m8] Menu sections auto-group by category** from the assortment entry order;
  fully custom drag-ordered sections are a future enhancement (the `sections`
  JSON column already supports them).
- **[m8] Assortment + menu CRUD manager-gated** (curating/publishing is manager
  territory); reads + the print view are open to all.
- **[m8] No e2e** — not in the GOAL §4 e2e list; verified via preview (menu
  create + print route returns grouped A4 HTML).

## M9 — hardening

- **[m9] Tutorial** — one `drinks` tour added to public/js/tutorial.ts that walks
  the sub-tabs via idempotent `before: () => goDrinksTab(tab)` hooks (mirroring
  the orders/planner tours), with the original sub-tab restored on tour end. The
  maintenance-rule comment now lists `drinks` (and `team`).
- **[m9] DESIGN.md** — Section 3 gained a "Drinks" paragraph (description of the
  system as built) and the data-model table gained the 11 drink tables; Section 4
  marks the Drinks System as Phase-1 shipped. Per the DESIGN.md maintenance rule.
- **[m9] MANAGER_EMAILS gating verified**: `isManagerEmail` (director ∪
  MANAGER_EMAILS) + inline `assertManager` gate catalogue CRUD, supplier/config
  writes, ordering, assortment/menu CRUD; the frontend hides those affordances
  unless `S.user.isManager`. Exercised by the catalogue-CRUD e2e (dev@local is a
  manager via the worktree .env + playwright webServer env).
- **[m9] Seed idempotency re-verified** — a second `prisma db seed` skips every
  drinks section (suppliers/catalogue/config/recipes/assortments); counts stable
  (95 drinks, 11 suppliers, 3 assortments).

## Post-rebase — onto main #94 ("Total review (2026-06-05)")

- **Rebased the whole drinks branch onto origin/main `67af839`** (the
  69-finding "Total review" remediation merge) after it landed mid-build, per the
  user's "rebase after every major step / check if main moved" instruction. Nine
  commits (m0–m9) replayed; only two conflicts, both expected and additive:
  - `playwright.config.ts` — kept *both* main's `DIRECTOR_EMAILS: 'dev@local'`
    and my `MANAGER_EMAILS: 'dev@local'`. (Director already implies manager via
    `isManagerEmail`, so MANAGER_EMAILS is belt-and-suspenders / intent-doc.)
  - `DESIGN.md` — kept both main's new feature bullets + data-model rows
    (Supplies / Training / Today panel) and my Drinks bullet + 11 drink rows.
  - Every code file (app.ts, routes/auth.ts, public/js/state.ts, utils.ts,
    init.ts) auto-merged: my additions and main's edits were in disjoint regions.
    Verified: drinks router still mounted, `isManagerEmail`/`requireManager`
    intact and `isManager` merged alongside main's `isDirector` in the user
    resolver, `drinks` still in NAV_SCREENS, drinks migration still last.
  - Typecheck (server+client) clean post-rebase.
- **Synced `e2e/navigation.spec.ts`** — added `'drinks'` to its hardcoded
  `NAV_SCREENS` mirror (after `orders`). The file's own header comment mandates
  keeping this list in sync when a nav screen is added (audit TEST-2/TEST-7 was
  about exactly this drift); leaving drinks out would have recreated it. This
  makes the navigation smoke test exercise the drinks screen (navigates, renders
  non-empty, no console errors) on top of the dedicated drinks specs.
- **`stocktake-start.spec.ts` flake** — failed once under full-suite load (5s
  default `toBeVisible` timeout racing the staging DB while 20 specs ran), passed
  in isolation (18.2s). Not a regression: the drinks branch touches none of the
  orders/stocktake/inventory code.

## Feedback redesign — 2026-06-06 (Daan's first review of the live module)

Tab-by-tab UI rework after the first walkthrough. Two commits: `drinks(catalogue)`
and `drinks(bar/stocktake/orders/suppliers/photo)`.

- **Catalogue columns** — split "Par/Stock" into **Needed** (the par target,
  renamed: "par" read as jargon) + **Stock**; dropped the Deposit column (kept in
  the form); "ABV" → "Alcohol %"; added a **Cost %** column (cost ÷ ex-BTW price)
  flagged red when it beats the category target. Cost-% target is *derived* from
  the existing per-category markup target (1/markup) — single source of truth, no
  new config (confirmed with Daan).
- **Per-location Active** — surfaced the already-existing `DrinkLocationInfo.active`
  as an inline catalogue tickbox + a focused `PATCH /api/drinks/:id/active`
  (avoids re-validating/round-tripping the whole drink). Per Daan: "Needed" = the
  target level (not the order shortfall — that lives on Orders).
- **Location toggle** — West/Centraal toggle on the Catalogue scoping the
  Needed/Stock/Price/Cost columns and hiding drinks inactive there. Tension with
  the Active tickbox (hiding inactive ⇒ can't re-activate) resolved with a **Show
  inactive** checkbox (off by default → clean view; on → re-activate). Note: the
  seed defaulted every drink active at *both* locations, so staff will deactivate
  the ones not used at Centraal.
- **Type-specific forms** — `buildDrinkFormHtml` now renders only the fields a
  category needs (wine: producer/region/country/grapes/soil/natural-bio/tasting
  notes; beer/spirits: alcohol %; soft: pairing notes; coffee-tea/consumables/
  glassware: minimal). The data model already had every field — this is purely
  presentation. Category change re-renders the section block.
- **Bar tab** — regrouped by category in service order, each type's info shown
  **inline** (wine: origin/grape/tasting; soft: serve-with; cocktail/coffee:
  how-to-serve / how-to-make) instead of a tap-only tile. Cocktails/coffee keep a
  "Build card ↗" for the full-screen view.
- **Final-product photo** — new `DrinkPhoto` table + `drinks.photo_url` (additive
  migration `20260606140000_drink_photos`, applied to staging), `POST/GET/DELETE
  /api/drinks/:id/photo` mirroring recipe photos (2 MB, mime-whitelist, bytes in
  DB). Open to any signed-in user (a bartender snapping the finished drink).
- **Stocktake** — landing is now a **stock-list overview** per location (toggle),
  grouped by category like the ingredient list; a **Start stocktake** button
  enters the by-area count flow, with **storage-area** now the default count mode
  (was supplier) per "the usual way".
- **Orders** — the tab now **auto-lists everything short, grouped per supplier**
  with that supplier's order instructions on top and an editable qty → one-tap
  **Place order** (creates + marks ordered in one go). No "+ new order" click for
  the common case; the manual ad-hoc order is kept as a secondary "order something
  else" (also preserves the existing e2e). Shortfall reuses `buildOrderSuggestions`
  (already active-at-loc aware, short-only).
- **Suppliers** — added the missing **+ Add supplier** + per-card Edit/Delete
  wired to the existing `POST/PATCH/DELETE /api/drinks/suppliers`.
- **e2e** — `drinks-stocktake.spec.ts` updated for the overview→Start→area flow;
  catalogue + order specs unchanged (manual order button retained).
