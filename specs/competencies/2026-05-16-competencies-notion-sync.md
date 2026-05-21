# Competencies Module — Notion Sync (Addendum)

**Date:** 2026-05-16
**Status:** Planned — revises the remaining slices of `2026-05-15-competencies-implementation-plan.md`
**Supersedes:** the in-app chunk editor planned for the original Slice 4 (Admin)

## Context

De Sering's team documents in Notion. Authoring chunk teaching guides in an in-app
markdown textarea (the original Slice 4 plan) is poor editing UX for content the
handover says "will be rewritten frequently in the first few months."

So the chunk library moves to Notion: chunks are **written, edited and read in
Notion**, and the app **syncs them in** — one-way, Notion → app — and displays
them in the grid and chunk detail. One-way delivers write/edit/read in Notion with
no conflict-resolution; the app is a faithful read replica of the Notion library.

Teaching events and the people list stay app-side — they are kiosk operational
data, not documentation.

## How the formatting stays tight

The handover's chunk format (sectioned teaching guide, compressed phrase-worthy
headlines) must survive the round-trip. Three mechanisms:

1. **Structured fields are typed Notion properties** — Station, Type, Required-for,
   Prerequisites, Sort-order are database properties (select / multi-select /
   relation / number). Typed fields cannot drift.
2. **One toggle per section** — each teaching-guide section is a Notion *toggle*
   block: toggle title = section headline, toggle contents = body. This matches the
   app's collapsible sections 1:1 — the Notion page looks like what the app renders.
   The sync converts each toggle to a `## ` section in the canonical chunk markdown
   the app already parses (`splitGuideSections`, Slice 3).
3. **The sync validates and flags** — every chunk is checked on import: sections
   present, only known block types. A chunk that does not parse cleanly is
   **flagged and held**, not imported broken. Drift is caught loudly.

A Notion **template** ships the section skeleton so the structure is the starting
point, not something to remember.

**Honest limit:** the sync guarantees *structure*, not *register* — the compressed,
phrase-worthy headlines and consistent voice remain human editorial discipline (as
they would be in any editor).

## Data model

A Notion database — **"Sering Training"** — one page per chunk.

| Notion property | Type | → `Chunk` field |
|---|---|---|
| Name | Title | `name` |
| Station | Select | `station` |
| Location | Multi-select (Sering Centraal / Sering West / TestTafel) | `locations` *(new column)* |
| Type | Select (`practical` / `sit-down`) | `type` |
| Goal | Text | `goal` |
| Required for | Multi-select | `requiredFor` |
| Prerequisites | Relation (→ this database) | `prerequisites` |
| Deeper link | URL | `deeperLink` |
| Sort order | Number | `sortOrder` |
| *page body (toggles)* | — | `teachingGuide` (canonical `## ` markdown) |

`Chunk.id` = the Notion page ID — stable. The one schema change is a new
`locations String[]` column on `Chunk`; an additive migration. The sync upserts
`Chunk` rows by that id.

**Location tag.** Each chunk carries a `Location` multi-select — Sering Centraal /
Sering West / TestTafel — multi-value, since a chunk can apply across locations
(the hospitality chunk already does). In Notion this drives the per-location
filtered views (one per location "area"). The app stores it (`Chunk.locations`)
and shows it on the chunk detail; it does **not** filter the grid by location at
v1 (Centraal-only per the handover) — a grid location filter is a straightforward
follow-on when West / TestTafel come online in the app.

## The sync

- New `lib/notion-sync.ts` — queries the Notion database, maps properties →
  structured fields, converts the toggle body → canonical `## ` markdown,
  validates each chunk, upserts `Chunk` rows.
- A focused Notion-block → markdown converter for the block types chunks use
  (toggle, heading, paragraph, bulleted/numbered list, divider, bold/italic).
  Unknown blocks are flagged.
- **Upsert only — the sync never deletes.** A chunk present in the app but gone
  from Notion is reported, not removed (it may carry teaching history).
- `POST /api/competencies/sync-chunks` — runs the sync, returns a report
  `{ synced, flagged: [{ name, reason }], appOnly }`. Staff-lead gated.
- Triggers: a **"Sync from Notion"** button in the Admin view, plus a **daily
  cron** (the app already schedules cron jobs in `server.ts`).
- The chunk seed (`seeds/competency-chunks.js` + the `seed.js` chunk block) is
  **removed** — chunks now come from Notion. The existing hospitality chunk
  content is bootstrapped into the Notion database as part of setup.

## New dependency, env, setup

- Dependency: `@notionhq/client` (official Notion SDK).
- Env: `NOTION_TOKEN`, `NOTION_CHUNKS_DB_ID` → `lib/config.ts`, with a
  `notionConfigured` check; `POST /sync-chunks` returns a clear 503 when
  unconfigured (mirrors the recipe-AI / Tebi patterns).
- One-time setup (Daan): create a Notion integration → token; the "Sering
  Competency Chunks" database is created with the schema above (Claude can build
  it directly if Notion is connected to the build session); share the database
  with the integration; hand over the token + database ID. The existing
  hospitality chunk is bootstrapped into Notion.

## Revised slices

Slices 0–3 are done. The original Slice 4 (Admin, with an in-app chunk editor) is
replaced by two slices:

- **Slice 4 — Notion sync.** Add `@notionhq/client`; a migration adding the
  `Chunk.locations` column; `lib/notion-sync.ts` + the block→markdown converter +
  the chunk validator; `POST /api/competencies/sync-chunks`;
  the daily cron; remove the chunk seed; bootstrap the existing chunk into Notion.
  *Deliverable: edit a chunk in Notion, hit Sync, watch it update in the grid and
  detail — and see a deliberately-broken chunk reported as flagged, not imported.*
- **Slice 5 — Admin.** `STAFF_LEAD_EMAILS` gate (`lib/config.ts` + `isStaffLeadEmail`
  in `routes/auth.ts`); a staff-lead-only Admin view holding the "Sync from Notion"
  button, people management (edit / deactivate), and teaching-event corrections
  (`DELETE /events/:id`). No in-app chunk editor.

## Verification

- `npm test` — unit-test the Notion-block → markdown converter and the chunk
  structure validator (pure functions, like the Slice 3 section splitter).
- `npm run typecheck`; preview — edit a chunk in Notion, sync, confirm the grid
  and chunk detail update; confirm a structurally-broken chunk is flagged and not
  imported.
