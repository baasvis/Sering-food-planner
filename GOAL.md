# GOAL — Build the Drinks Module

*This file is the objective for an autonomous Claude Code `/goal` run on the Sering Food Planner repo. It is deliberately self-sufficient: if something is ambiguous, do **not** ask — decide using the decision policy in §6 and log it.*

---

## 0. Read first, in this order

1. `DESIGN.md` — the system bible. The Drinks System is the named "Next" module (Section 4); this goal supersedes its v1 sketch with a fuller spec.
2. `CLAUDE.md` — conventions, file map, API surface, TypeScript rules. Follow all of it.
3. `DRINKS_DOMAIN.md` (provided alongside this file) — the complete drinks domain spec: data model, formulas, workflows, enums, defaults.
4. `seeds/drinks-catalogue.json`, `seeds/drinks-recipes.json`, `seeds/drinks-suppliers.json`, `seeds/drinks-assortments.json` — real seed data extracted from De Sering's current sheets.
5. `TEBI.md` — context only. **Do not modify anything Tebi-related in this run.**

## 1. Objective

Add a production-quality **Drinks module** to the Sering Food Planner: catalogue + recipes + costing/pricing + supplier-cycle stocktakes + full-lifecycle ordering + production logging + write-offs + service cards + assortments with a menu designer — per location (west / centraal / testtafel-as-assortment), seeded with the provided real data, built to the repo's existing patterns (Ingredient DB, Recipe v2, Orders/stocktake, unified-batch).

This is **Phase 1**: no Tebi sales reconciliation / loss reporting yet — but every model decision in `DRINKS_DOMAIN.md` (premix two-stage stock, fractional serving formats, reason-coded write-offs, `tebiProductNames`) exists so Phase 2 becomes a reporting feature. Do not break those hooks.

## 2. Hard guardrails

- Work on branch **`drinks-module`**. Never commit to `main`, never push to a remote production branch, never deploy.
- `DATABASE_URL` must point at a **staging/scratch Postgres**. If it looks like a production host (see `test/setup-env.ts` guard), STOP and fail loudly rather than proceed.
- Do not modify: the Tebi scraper/sync (`scripts/tebi-*`, `lib/tebi-sync.ts`), the food planner's existing flows (batches, week plan, food orders), auth — except the minimal, additive touch-points listed in `DRINKS_DOMAIN.md` §9 (nav registration, manager tier, shared Ingredient reads).
- Schema changes only via `npx prisma migrate dev` migrations, camelCase fields with `@map("snake_case")`, schema committed with the migration (CLAUDE.md "Don't" rules).
- All write endpoints: `withWriteLock()`, `asyncHandler()`, `dbAppendLog(...)`, `safeErrMsg` to clients.
- New screens registered in `NAV_SCREENS` (state.ts), renderer registry pattern, per-screen CSS file, tutorial steps added (`public/js/tutorial.ts`) — the tutorial rule in DESIGN.md is mandatory.
- Update `DESIGN.md` Section 3 with a "Drinks" paragraph describing the system as built (description, not changelog), per the DESIGN.md maintenance rule.

## 3. Milestones — commit after each, in this order

Each milestone = one or more commits prefixed `drinks(mN):`. A milestone is done when its checks pass locally (`npm run typecheck`, `npm test`, and from M4 on, the relevant e2e spec).

1. **M1 — Schema.** Prisma models + migration per `DRINKS_DOMAIN.md` §2: `Drink` (mode, category, subtype, serving formats, per-location stock/par/prices, `tebiProductNames`, deposit, draft/published, info fields), `DrinkIngredientRow` (→ Ingredient **or** Drink), `DrinkSupplier`, `DrinkOrder` + lines (lifecycle), `DrinkProductionLog`, `DrinkWriteOff`, `Assortment`, `DrinkMenu`. Shared types in `shared/types.ts`.
2. **M2 — Catalogue.** Drinks screen (mode/category filters, search per the Search/Filter Input Rule), info-only CRUD with the optimized catalogue form (wine fields incl. winery/region/soil/profile), serving formats, per-location pars + prices, seed loader (idempotent, only-when-empty like `prisma/seed.js`) for catalogue + suppliers.
3. **M3 — Recipes & costing.** Recipe-backed CRUD with the recipe form: ingredient rows referencing Ingredients or other Drinks (building blocks, ≥2 levels deep), per-serve + batch size + bottle yield, prep steps, recursive cost rollup, labour amortisation, BTW auto-set, markup targets per category, suggested price (cost × target, rounded to €0.10), draft → published with traffic-light guardrails. Seed recipes load.
4. **M4 — Stocktake.** Supplier-cycle counting flow: pick supplier (order-day aware, "due today" surfaced) or storage area → count in supplier units per area (stored per-area, summed per location) → bulk save. E2e spec.
5. **M5 — Ordering.** Per-location per-supplier order generation (par − stock, minimums, deposits shown, demand nudge when upcoming guest counts are high), lifecycle: draft → ordered (who/when) → expected delivery → received with line-level quantities + substitutions, receiving updates stock. E2e spec.
6. **M6 — Production & corrections.** To-make list (par vs stock for homemade), production logging (consume ingredients ↓, create premix bottles ↑, maker, made-on, shelf-life with throw-out flow), reason-coded write-offs (breakage/spillage/expired/staff/comp/other), optional batch transfer between locations (reuse shipments pattern).
7. **M7 — Service cards.** Bartender mode: published drinks of the active assortment as fast read-only cards (build, glass, serve ml, garnish), mobile-first.
8. **M8 — Assortments & menu designer.** Per-location assortments (testtafel = assortment on centraal stock); menu builder: pick drinks, group/order by category, layout presets (columns, sections, type scale), live prices per location, print-ready via print CSS.
9. **M9 — Hardening.** Full test pass (`npm run test:all`), tutorial steps for every new screen, `DESIGN.md` update, `MANAGER_EMAILS` gating verified, seed idempotency re-run, `DECISIONS.md` finalised.

## 4. Acceptance criteria

Functional: every milestone's feature works end-to-end in the browser against seeded data. Quantitative checks the grader will run:

- `npm run typecheck` — zero errors.
- `npm test` — green, including new unit tests for: recursive cost rollup (incl. a building block used by another building block), markup/rounding, BTW auto-set, par − stock order math, receiving-updates-stock, write-off stock effect, premix two-stage flow.
- `npm run test:e2e` — green, including new specs: drinks catalogue CRUD, stocktake save, order lifecycle.
- Seed loader runs twice without duplicates.
- `git log --oneline` shows the `drinks(mN):` trajectory.

## 5. Permissions

All authed users: counts, production logs, write-offs, recipe drafts/edits. **Manager-gated** (prices, markup targets, supplier data, publishing menus): emails in new env `MANAGER_EMAILS` (plus directors always). Mirror the `DIRECTOR_EMAILS` mechanism in `lib/config.ts` / `routes/auth.ts`; gate UI affordances and endpoints both.

## 6. Decision policy (instead of asking)

Priority order when something is unclear: **(1)** `DRINKS_DOMAIN.md`, **(2)** `DESIGN.md` + `CLAUDE.md` conventions, **(3)** the closest existing pattern in the codebase (Recipe v2 > Orders > Ingredient DB), **(4)** your best judgement. Whenever you reach (3) or (4), append a one-line entry to `DECISIONS.md` (created at repo root): what was ambiguous, what you chose, why. Never block on a question; never invent new external dependencies (no new npm packages unless unavoidable — log it if so).

## 7. Out of scope — do not build

Tebi sales sync changes or loss/variance reporting (Phase 2); event-specific pricing; empties/statiegeld counting (deposit *amounts* on items only); cleaning/first-aid/FOH supplies (future Non-food module); the food planner's existing screens beyond the listed touch-points; user role system beyond the `MANAGER_EMAILS` tier.

## 8. Done

Branch `drinks-module` pushed with milestone commits, all §4 checks green, `DECISIONS.md` honest, `DESIGN.md` updated. Stop there — a human reviews the PR.
