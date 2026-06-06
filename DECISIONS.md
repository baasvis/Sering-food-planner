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
