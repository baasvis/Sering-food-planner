# Competencies Module — Implementation Plan

**Date:** 2026-05-15
**Status:** Approved, in implementation
**Stack:** Sering Suite — Express + TypeScript, Prisma + PostgreSQL, Vite-bundled vanilla-TS frontend

## Context

De Sering is encoding its training model into the Sering Suite. The **Competencies module** tracks peer-teaching events between staff so training becomes legible and transmissible — the keystone of summer 2026's organizational work, built so the system survives leadership turnover.

The **primary job is to enable peer teaching**. Tracking competence, capturing tacit knowledge, and surfacing progression are downstream consequences, not goals. Every decision below flows from the design principles in the authoritative handover (`2026-05-15-competencies-handover.md`): **simplicity over completeness, trust over enforcement, speed of logging over richness of data** — under a **kiosk access model** (shared iPads, no per-person login, identity picked per action, public ledger).

This plan adapts the handover to the real Suite stack — the handover's "Next.js" tech note is stale; it's Express + Vite. The design was validated against the live codebase.

## Decisions locked with Daan

1. **Launch empty** — no backfill of existing staff's prior competence.
2. **Dictionary stays a markdown doc** in `/specs/competencies/`, *not* built into the app at v1 — no `Phrase` table, no dictionary UI.
3. **Admin gated by a `STAFF_LEAD_EMAILS` email allowlist** (reuses the existing `DIRECTOR_EMAILS` pattern).
4. **Dish-pit chunk:** Daan will provide it; building proceeds in parallel, only content-seeding waits.
5. **The grid is the home screen.** The module opens on the people×chunks matrix; tapping a cell logs a teaching directly. The grid is both the at-a-glance picture and the logging surface.

## Handover open questions — resolved

- **#2 (required-for shape):** free-text `String[]`. Display-only labels, never enforced.
- **#3 (gap view filters by shift roster):** **No** — the Suite holds no staff roster/shift data anywhere. The grid filters by station only.
- **#1 (backfill) / #4 (dictionary):** resolved by the locked decisions above.

## What it looks like

The module is one screen in the Suite (beside Dashboard, Orders, …). It opens on **the grid**:

```
  station: [ All v ]            Dish pit   Hospitality   Prep list   Closing
  Tom                            4 May        --          2 May        --
  Sanne                          today       8 Apr         --          --
  Noah                            --         12 May       3 May       1 May
  Maartje                         --           --           --         --
  ---------------------------------------------------------------------------
  Recently logged
   Sanne -> Tom · Running the dish pit · today
   Noah -> Sanne · Hospitality at Sering · 12 May
```

People down the side, chunks across the top. A cell shows **when that person was last taught that chunk** — blank means never — shaded by recency (green = recent, fading to grey, empty = never), so it scans like a status grid from across the kitchen and reads as a real date up close. Filter to one station to keep it narrow. The public ledger of recent teachings sits beneath the grid.

**Tapping a cell logs a teaching** — a small modal, learner + chunk already filled in by the cell: pick the teacher, date defaults to today, optional note, "Log it". ~3 taps. On save: a toast confirms, the cell turns green/today, the recent-list prepends. Tapping an already-taught cell logs a repeat (it shows the prior teaching for context first) — repeated teaching is normal and meaningful.

**Tap a person's name** → their detail: everything they've been taught, newest first, grouped by station, repeats counted, and what they haven't had yet. **Tap a chunk's name** → its detail: the teaching guide as ~6 collapsed section headlines (the spine — a teacher's 30-minute checklist), each tappable to open the full prose, plus who's-had-it / who-hasn't. **Admin** (staff-leads only) edits chunks, fixes mistaken entries, manages the name list.

**Cells are dates, not ticks.** The handover deliberately has no "competent: yes/no" bit — competence is read off the teaching history, not stored. A tick implies permanent done-ness; a recency-shaded date keeps the grid a living picture of an ongoing practice and avoids the grid drifting into an HR scorecard.

## Deviations from the handover

- **Home screen = the grid, not a standalone log form.** The handover names the Log form as the front door; Daan chose the grid (it also honors handover principle 4 — "make the gap visible, don't bury this"). The standalone three-picker form is **dropped** — cell-tap logging pre-fills learner + chunk, so it is faster and gap-aware. Logging in under 30s / ~3 taps is preserved.
- **Per-person "missing"** is computed against the chunk library **by station**, not by role — there is no roles model, and `requiredFor` is free-text on the chunk. A true role-gap would need a roles concept (a later slice if wanted).
- **No live SSE sync** for competencies at v1. The logger sees their own change immediately; other kiosks refresh on next screen-open. Cheap to add later via a reload-trigger field.
- **Dictionary** absent from the app per decision #2.

## Content dependencies (from Daan)

- **Dish-pit chunk** — the only practical-type chunk; needed for the content seed.
- **Centraal staff name list** — to seed `People` so the grid has rows. Fallback: a lightweight "+ add a name" control on the grid (trust-by-default, kiosk-appropriate) so the kitchen self-populates.
- **The originally-attached files were misnamed (contents != filenames).** This folder holds the corrected names; only the Sering-recalibrated hospitality chunk (`2026-05-15-chunk-hospitality-sering.md`) is seeded as a live `Chunk`. The general version is kept as a historical doc.

## Schema — 3 new Prisma models

Append to `prisma/schema.prisma`; convention: `String @id` with app-generated IDs (matches Batch/Recipe — `cuid()` is not used in this schema), `@map` snake_case columns, `@@map` table names.

```prisma
model Person {
  id        String   @id
  name      String
  location  String   @default("centraal")
  active    Boolean  @default(true)
  createdAt DateTime @default(now()) @map("created_at")
  teachingsGiven    TeachingEvent[] @relation("teacher")
  teachingsReceived TeachingEvent[] @relation("learner")
  @@map("people")
}

model Chunk {
  id            String   @id
  name          String
  station       String
  type          String                                // "practical" | "sit-down"
  goal          String   @default("")
  prerequisites String[] @default([])
  requiredFor   String[] @default([]) @map("required_for")
  deeperLink    String?  @map("deeper_link")
  teachingGuide String   @default("") @map("teaching_guide")
  sortOrder     Int      @default(0) @map("sort_order")
  createdAt     DateTime @default(now()) @map("created_at")
  updatedAt     DateTime @updatedAt @map("updated_at")
  teachingEvents TeachingEvent[]
  @@map("chunks")
}

model TeachingEvent {
  id             String   @id
  chunkId        String   @map("chunk_id")
  teacherId      String   @map("teacher_id")
  learnerId      String   @map("learner_id")
  date           String                                // ISO YYYY-MM-DD
  notes          String   @default("")
  createdAt      DateTime @default(now()) @map("created_at")
  createdByEmail String   @map("created_by_email")
  createdByName  String   @map("created_by_name")
  chunk   Chunk  @relation(fields: [chunkId], references: [id])
  teacher Person @relation("teacher", fields: [teacherId], references: [id])
  learner Person @relation("learner", fields: [learnerId], references: [id])
  @@index([chunkId])
  @@index([teacherId])
  @@index([learnerId])
  @@map("teaching_events")
}
```

No competence flag, no levels — competence is *derived from `TeachingEvent` history*. A grid cell = the most recent `TeachingEvent.date` where `learnerId` = that person and `chunkId` = that chunk.

## How it hooks into the Suite

- **Nav:** add a `competencies` entry to `NAV_SCREENS` in `public/js/state.ts`. `buildNav()` auto-creates the `#screen-competencies` container.
- **Frontend module:** new `public/js/competencies.ts` calling `registerRenderer('competencies', renderCompetencies)`; imported in `public/js/main.ts`; window-assign the `onclick` handlers. New `public/css/competencies.css` linked in `public/index.html`.
- **Sub-views:** the grid is the home view; person/chunk details and Admin swap into `#screen-competencies` with a back affordance — same render-dispatch mechanism as the Orders tabs.
- **Backend:** one new `routes/competencies.ts`, mounted under `/api` in `app.ts` so `requireAuth` covers it. Writes use `withWriteLock`, `asyncHandler`, `AppError`, and log via `dbAppendLog` + `addBackendEvent`.
- **Data load:** fetched on screen-open via `apiGet('/api/competencies/...')` — **not** added to the `GET /api/data` hot path.
- **Admin gate:** add `STAFF_LEAD_EMAILS` to `lib/config.ts`; add `isStaffLeadEmail()` next to `isDirectorEmail()` in `routes/auth.ts`. Gate admin write endpoints server-side (403); hide the Admin entry client-side via `S.user`.
- **New dependency:** `marked` for rendering chunk markdown — used from Slice 3 (chunk detail). Chunk content is staff-lead-authored and git-seeded — trusted.
- **Seeding:** extend `prisma/seed.js` — when `chunks`/`people` tables are empty, load `seeds/competency-chunks.json` / `seeds/competency-people.json`. No `TeachingEvent` seed (launch empty).

## Endpoints (`routes/competencies.ts`)

`GET /chunks`, `GET /people`, `GET /events` · `POST /events` (open — trust by default) · `POST|PATCH /chunks`, `POST|PATCH /people`, `DELETE /events/:id` (staff-lead gated). **No defensive validation** on `POST /events` — `withWriteLock` + `asyncHandler` only.

## Build slices — smallest meaningful first

- **Slice 0 — Docs into git.** Create `/specs/competencies/`, write the design docs with correct filenames, write this plan. Commit.
- **Slice 1 — Keystone: the grid.** Schema + migration; seed files + `seed.js` block; `routes/competencies.ts` with `GET chunks/people/events` + `POST events`; the Competencies screen = the grid (recency-shaded cells, optional station filter) + cell-tap log modal + recently-logged list; lightweight "+ add a name" fallback. *Deliverable: open the module, tap a cell, log a teaching in ~3 taps, watch the cell turn green and the recent list update.* Pause for sign-off.
- **Slice 2 — Person detail.** Tap a row → per-person history grouped by station, repeat counts, not-yet-had chunks.
- **Slice 3 — Chunk detail.** Tap a column → chunk header + teaching guide. Add `marked`; split `teachingGuide` on `## ` headings into `<details>` sections. Plus who's-had-it / who-hasn't.
- **Slice 4 — Admin.** `STAFF_LEAD_EMAILS` gate; chunk/event/people editors.

## Verification

- `npm test` (against `DATABASE_URL_TEST`) — `test/competencies-api.test.ts` (POST event → GET grid data → round-trip); from Slice 3, a unit test for the markdown section-splitter.
- `npm run typecheck` — backend strict; new frontend code avoids `any`.
- Preview after each frontend slice.
- `npm run test:e2e` — `e2e/competencies.spec.ts` (open module → tap cell → log → assert cell + recent list update).
