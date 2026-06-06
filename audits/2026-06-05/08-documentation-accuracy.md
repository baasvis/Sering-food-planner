# Documentation Accuracy

## Scope of review

This pass checked CLAUDE.md, SETUP_GUIDE.md, DESIGN.md, and the `specs/competencies/` docs against the shipped code — module/endpoint inventories, env-var documentation, test-file counts, and roadmap/build-status accuracy for the Competencies, Supplies, and Today/ritual modules. Findings are sorted by adjusted severity.

## Findings

### DOC-1 — CLAUDE.md Project Structure tree omits five entire new frontend/backend modules

- **Severity**: Medium
- **Location**: CLAUDE.md:36-127 (routes/, lib/, public/js/ trees)
- **What**: The CLAUDE.md file-by-file map lists neither routes/competencies.ts, routes/supplies.ts, lib/notion-sync.ts, lib/notion-markdown.ts, nor public/js/competencies.ts, supplies.ts, ritual.ts, today-panel.ts, chunk-guide.ts, all of which exist on disk.
- **Why it matters**: CLAUDE.md is declared the authoritative file map (DESIGN.md:149 defers to it); an AI or contributor reading it will not discover the Competencies, Supplies, and Today/ritual modules and may duplicate or break them.
- **Suggested fix**: Add routes/competencies.ts + routes/supplies.ts to the routes block, lib/notion-sync.ts + lib/notion-markdown.ts to the lib block, and competencies.ts/supplies.ts/ritual.ts/today-panel.ts/chunk-guide.ts to the public/js block, each with a one-line purpose.
- **Confidence**: High.
- **Verified**:

  All 9 claimed files confirmed to exist on disk:
  - routes/competencies.ts, routes/supplies.ts
  - lib/notion-sync.ts, lib/notion-markdown.ts
  - public/js/competencies.ts, public/js/supplies.ts, public/js/ritual.ts, public/js/today-panel.ts, public/js/chunk-guide.ts

  CLAUDE.md lines 36-65 (routes/ block) list only: auth.ts, data.ts, batches.ts, recipes.ts, ingredients.ts, ingredients-import.ts, guests.ts, inventory.ts, feedback.ts, events.ts, health.ts, hanos.ts, finance.ts, telemetry.ts, admin.ts, recipe-ai.ts, coverage.ts, access.ts — no mention of competencies.ts or supplies.ts.

  CLAUDE.md has no lib/ block in the project tree at all (lib files appear scattered in narrative prose but the structured tree skips the lib/ directory entirely), so notion-sync.ts and notion-markdown.ts are absent.

  CLAUDE.md lines 98-127 (public/js/ block) list 26 frontend modules — none of competencies.ts, supplies.ts, ritual.ts, today-panel.ts, or chunk-guide.ts appear.
- **Reviewer notes**: The claim is accurate in every particular. Nine real modules spanning three feature domains (Competencies/Training, Supplies, Today/ritual panel) are missing from the CLAUDE.md structural tree that the file itself describes as authoritative. Severity Medium is appropriate: this is purely a documentation gap with no runtime impact, but it is a meaningful discoverability hole for AI agents and new contributors who rely on CLAUDE.md as the file map.

### DOC-3 — DESIGN.md 'What's Built' and data-model table omit the Competencies, Supplies, and Today/ritual modules

- **Severity**: Medium
- **Location**: DESIGN.md:84-192 (Section 3)
- **What**: DESIGN.md Section 3 describes every built area in prose and lists DB models through AiInsight, but never mentions the Competencies/Training module, the Supplies/Toppings module, or the Today/ritual panel, and its data-model table omits the Person, Chunk, TeachingEvent, Supply, RitualCompletion, CookRhythm, and ClosedServices models that exist in prisma/schema.prisma.
- **Why it matters**: DESIGN.md is declared 'the bible … read this before making changes' (DESIGN.md:4, 322); three shipped, navigable modules and seven DB tables are invisible to anyone using it to understand the current system.
- **Suggested fix**: Add Section-3 paragraphs for Competencies (+Notion sync), Supplies (Toppings & bread), and the Today/ritual panel, and add the seven missing models to the data-model table.
- **Confidence**: High.
- **Verified**:

  DESIGN.md lines 84–142 list every "What's Built" bullet (Access, Dashboard, Week Plan, Batches, Guests, Recipes, Orders, Ingredient database, Finance, Cross-cutting) with no mention of Competencies/Training, Supplies/Toppings, or Today/ritual panel.

  Data-model table (lines 168–192) ends at AiInsight. The following seven models that exist in prisma/schema.prisma are absent from the table:
  - RitualCompletion (schema line 232)
  - CookRhythm (schema line 260)
  - ClosedServices (schema line 267)
  - Supply (schema line 351)
  - Person (schema line 450)
  - Chunk (schema line 463)
  - TeachingEvent (schema line 483)

  The only training reference in DESIGN.md is an incidental parenthetical in the Access bullet: "Approving also seeds that person into the Training (competencies) roster" (line 91), and a personId note in the AccessRequest table row (line 189). Neither constitutes a module description.

  DESIGN.md line 4 states "This is the master reference for any AI assistant working on this codebase. Read this before making changes." — confirming the impact of the omission.
- **Reviewer notes**: The severity Medium is well-calibrated. All three missing modules (Competencies, Supplies, Today/ritual) are navigable screens with DB-backed models that have shipped. CLAUDE.md does list files and routes, so the omission in DESIGN.md is partly mitigated for readers who consult both documents, but DESIGN.md is explicitly positioned as the primary reference and should be self-contained for the "What's Built" section and data-model table.

### DOC-5 — Three env vars (STAFF_LEAD_EMAILS, NOTION_TOKEN, NOTION_CHUNKS_DATA_SOURCE_ID) and COMPETENCY_SYNC_CRON are undocumented

- **Severity**: Medium
- **Location**: SETUP_GUIDE.md:28-51 (env table); CLAUDE.md:187-194
- **What**: lib/config.ts reads STAFF_LEAD_EMAILS, NOTION_TOKEN, NOTION_CHUNKS_DATA_SOURCE_ID and server.ts reads COMPETENCY_SYNC_CRON, but none appear in the SETUP_GUIDE env table or CLAUDE.md's optional-env list.
- **Why it matters**: A new contributor or operator cannot enable Competencies admin actions or the Notion chunk sync because the gating env vars are invisible; the sync silently no-ops (notionConfigured()===false) with no documented cause.
- **Suggested fix**: Add STAFF_LEAD_EMAILS, NOTION_TOKEN, NOTION_CHUNKS_DATA_SOURCE_ID, and COMPETENCY_SYNC_CRON (default 0 5 * * *) to the SETUP_GUIDE env table and CLAUDE.md optional-env paragraph.
- **Confidence**: High.
- **Verified**:

  lib/config.ts lines 21-22 and 36-37:
    STAFF_LEAD_EMAILS: ((process.env.STAFF_LEAD_EMAILS ?? '')
      .split(',').map(e => e.trim().toLowerCase()).filter(Boolean)),
    NOTION_TOKEN: process.env.NOTION_TOKEN || '',
    NOTION_CHUNKS_DATA_SOURCE_ID: process.env.NOTION_CHUNKS_DATA_SOURCE_ID || '',

  server.ts lines 150-152:
    if (CONFIG.NOTION_TOKEN && CONFIG.NOTION_CHUNKS_DATA_SOURCE_ID) {
      import('node-cron').then(cron => {
        const schedule = process.env.COMPETENCY_SYNC_CRON || '0 5 * * *';

  SETUP_GUIDE.md lines 28-51 (full env table): zero matches for STAFF_LEAD_EMAILS, NOTION_TOKEN, NOTION_CHUNKS_DATA_SOURCE_ID, or COMPETENCY_SYNC_CRON.
  CLAUDE.md lines 187-194 (optional-env paragraph): zero matches for any of the four variables.
- **Reviewer notes**: All four env vars exist in current code exactly as claimed: STAFF_LEAD_EMAILS gates Competencies admin actions (lib/config.ts + routes/auth.ts isStaffLeadEmail), NOTION_TOKEN and NOTION_CHUNKS_DATA_SOURCE_ID are both required for notionConfigured() (lib/notion-sync.ts line 24), and COMPETENCY_SYNC_CRON controls the daily Notion chunk sync schedule (server.ts line 152, default "0 5 * * *"). None of the four appear anywhere in SETUP_GUIDE.md or CLAUDE.md. The silent no-op behavior is confirmed: lib/notion-sync.ts line 124 returns an error string "Notion is not configured — set NOTION_TOKEN and NOTION_CHUNKS_DATA_SOURCE_ID." only when the endpoint is called, but there is no startup warning and no documentation to prompt an operator to set these. Severity Medium is appropriate — the Competencies feature becomes silently non-functional without documentation, but it does not cause data loss or a security breach.

### DOC-2 — CLAUDE.md and SETUP_GUIDE.md state 13 test files; there are 30

- **Severity**: Low
- **Location**: CLAUDE.md:169; SETUP_GUIDE.md:136
- **What**: Both docs say the test suite is '13 files in test/' but `ls test/*.test.ts` returns 30 test files.
- **Why it matters**: A contributor estimating test coverage or scanning for the right test file is told less than half the suite exists; the CLAUDE.md test/ enumeration (lines 128-141) is also missing ~17 newer files (access-request, competencies-api, supplies, ritual, closed-services, catering-demand, core-demand, etc.).
- **Suggested fix**: Update both numbers to 30 and refresh the CLAUDE.md test/ list to include the new test files, or replace the explicit list with a pointer to the directory.
- **Confidence**: High.
- **Verified**:

  CLAUDE.md line 169: `npm test  # Jest with @swc/jest. Unit + API tests (13 files in test/).`

  The enumerated list at lines 128-141 lists exactly 13 .test.ts files (api, batch-recipe-stock-deduct, inventory-helpers, shipment-flow, migration, maintenance, menu-fixer, transport-card, recipe-ai-apply-tool, location-state, stock-location, redact-secrets, xlsx-api-smoke).

  `ls /c/Users/Daan/Sering-food-planner/.claude/worktrees/serene-almeida-60b9b7/test/*.test.ts | wc -l` returns 30.

  Files in the directory but absent from CLAUDE.md include: access-request.test.ts, batch-construction.test.ts, catering-demand.test.ts, chunk-guide.test.ts, closed-services.test.ts, competencies-api.test.ts, cook-confirm.test.ts, core-demand.test.ts, fmm-bench.test.ts, guests-carryforward.test.ts, inventory-disappear-investigation.test.ts, inventory-modal-stale-index.test.ts, notion-markdown.test.ts, planner-pool.test.ts, ritual.test.ts, supplies.test.ts, supply-demand.test.ts (17 unlisted files).
- **Reviewer notes**: The finding is accurate. Both the count ("13 files") and the enumerated list in CLAUDE.md are stale. Severity Low is appropriate — this is a documentation inaccuracy with no runtime impact. A contributor reading the docs would underestimate the test suite size and miss 17 test files when scanning for coverage. The fix is to update the count to 30 and either enumerate all files or replace the explicit list with a pointer to the test/ directory.

### DOC-4 — DESIGN.md roadmap marks 'Toppings/sides/bread' as not-yet-built though the Supplies module ships it

- **Severity**: Low
- **Location**: DESIGN.md:217
- **What**: DESIGN.md lists '[ ] Toppings/sides/bread' as an open roadmap item, but a full Supplies module is built (routes/supplies.ts, public/js/supplies.ts, Supply model, a 'Toppings & bread' nav screen in state.ts:105, and a dashboard supplies card).
- **Why it matters**: The roadmap signals unbuilt work that is actually done, so planning/prioritization decisions made from DESIGN.md will be wrong.
- **Suggested fix**: Check the box and move the Toppings/sides/bread line into Section 3 as a built-module description, or mark it [x] with a one-line summary.
- **Confidence**: High.
- **Verified**:

  DESIGN.md:217: `- [ ] **Toppings/sides/bread**: currently only soups, mains, desserts. Need to handle the standard accompaniments (bread, aioli, toppings, dips) that go with every service.`

  The module is fully built: routes/supplies.ts and public/js/supplies.ts both exist, shared/types.ts defines the Supply interface and SupplyKind/SupplyPrepMode types (lines 326-357), AppState includes a `supplies: Supply[]` field, and state.ts:105 registers a nav screen `{ id: 'supplies', topLabel: 'Toppings & bread', bottomLabel: 'Toppings', ... }`. The roadmap checkbox is still unchecked in DESIGN.md.
- **Reviewer notes**: The finding is accurate. DESIGN.md was not updated when the Supplies/Toppings module was built. The unchecked item at line 217 falsely signals unbuilt work. Severity Low is calibrated correctly — it's purely a documentation staleness issue with no runtime or logic impact.

### DOC-6 — specs/competencies/README.md declares the module pre-implementation, but it is fully built

- **Severity**: Low
- **Location**: specs/competencies/README.md:40-41
- **What**: The README says 'Module status: Pre-implementation. Design complete, awaiting first build.' while routes/competencies.ts, public/js/competencies.ts, the Person/Chunk/TeachingEvent models, Notion sync, and competencies-api/chunk-guide tests are all present.
- **Why it matters**: Anyone consulting the spec folder to learn module status is told the opposite of reality, risking redundant re-implementation.
- **Suggested fix**: Update the README Status block to 'Implemented (v1 + Notion sync)' and point to routes/competencies.ts / public/js/competencies.ts as the implementation.
- **Confidence**: High.
- **Verified**:

  specs/competencies/README.md line 41: "**Module status:** Pre-implementation. Design complete, awaiting first build."

  But routes/competencies.ts begins with a full implementation header ("COMPETENCIES — peer-teaching tracker. Three entities: chunks, people, teaching events..."), public/js/competencies.ts exists, and prisma/schema.prisma has models Person (line 450), Chunk (line 463), and TeachingEvent (line 483) all fully defined.
- **Reviewer notes**: The finding is accurate and unfixed. The README snapshot date of 2026-05-15 predates the implementation, but was never updated after the build landed. The severity calibration (Low) is appropriate — it is a stale doc in a specs folder, not a runtime defect, but it could mislead anyone consulting that folder to gauge what still needs building.

### DOC-7 — CLAUDE.md inventory.ts description omits the cook-rhythm and ritual-completions endpoints

- **Severity**: Low
- **Location**: CLAUDE.md:53
- **What**: CLAUDE.md describes routes/inventory.ts as 'Standard inventory + storage config + kitchen equipment + prep checklist + activity log', but the same router also serves GET/POST /api/cook-rhythm and GET/POST /api/ritual-completions (routes/inventory.ts:114,119,274,283).
- **Why it matters**: The Today/ritual panel's backend endpoints are undiscoverable from the route map, and the 'Key Data Flow' section lists zero competencies/supplies/cook-rhythm/ritual endpoints, so the entire ritual API surface is undocumented.
- **Suggested fix**: Append cook-rhythm and ritual-completions to the inventory.ts line and add their endpoints (plus /api/competencies/* and /api/supplies/*) to the 'Key Data Flow' list.
- **Confidence**: High.
- **Verified**:

  CLAUDE.md line 53: "inventory.ts — Standard inventory (per-location) + storage config + kitchen equipment + prep checklist + activity log"

  routes/inventory.ts line 114: router.get('/cook-rhythm', ...) and line 119: router.post('/cook-rhythm', ...)
  routes/inventory.ts line 274: router.get('/ritual-completions', ...) and line 283: router.post('/ritual-completions', ...)
- **Reviewer notes**: The finding is literally true. Both GET/POST /api/cook-rhythm (lines 114, 119) and GET/POST /api/ritual-completions (lines 274, 283) exist in routes/inventory.ts, and neither appears in the CLAUDE.md description of that router. The severity is appropriate as Low — this is a documentation gap with no runtime impact, but it means the ritual/Today panel backend endpoints are not discoverable from the route map.

### DOC-8 — SETUP_GUIDE.md says `npm run typecheck` runs the backend only; it runs backend + frontend

- **Severity**: Low
- **Location**: SETUP_GUIDE.md:156
- **What**: SETUP_GUIDE.md states typecheck 'Runs tsc --noEmit on the backend', but package.json:21 defines typecheck as `typecheck:server && typecheck:client` (both tsconfig.server.json and tsconfig.json).
- **Why it matters**: A contributor may believe frontend type errors are unchecked locally and skip running it, or be surprised when frontend tsc failures block the command; CLAUDE.md:182-184 documents it correctly, so the two docs contradict each other.
- **Suggested fix**: Change the SETUP_GUIDE line to note it typechecks both backend and frontend (matching CLAUDE.md).
- **Confidence**: High.
- **Verified**:

  SETUP_GUIDE.md:156: "Runs `tsc --noEmit` on the backend."

  package.json:21: "typecheck": "npm run typecheck:server && npm run typecheck:client",
  package.json:22: "typecheck:server": "npx tsc -p tsconfig.server.json --noEmit",
  package.json:23: "typecheck:client": "npx tsc -p tsconfig.json --noEmit",
- **Reviewer notes**: The claim is literally true in the current code. SETUP_GUIDE.md line 156 says typecheck only runs the backend, but package.json defines it as both typecheck:server AND typecheck:client. CLAUDE.md (lines 182-184) documents it correctly as running both. The severity of Low is appropriate — it is a documentation inaccuracy that could mislead a contributor, but it has no runtime impact.

### DOC-9 — DIRECTOR_EMAILS / STAFF_LEAD_EMAILS role split is described as director-only in docs

- **Severity**: Low
- **Location**: CLAUDE.md:271 (access paragraph); CLAUDE.md:190 / SETUP_GUIDE.md:36 (DIRECTOR_EMAILS)
- **What**: The docs describe only a director role gated by DIRECTOR_EMAILS, but auth.ts also exposes isStaffLeadEmail() backed by STAFF_LEAD_EMAILS, which gates Competencies admin actions (chunk sync, event deletion, person management) independently of director status.
- **Why it matters**: The access-control model documented (single director gate) is incomplete; an operator setting up permissions will not know a separate staff-lead allowlist governs the Competencies module, so staff-lead features stay locked or are mis-assigned.
- **Suggested fix**: Document the staff-lead role and STAFF_LEAD_EMAILS alongside the director role in CLAUDE.md and SETUP_GUIDE, noting it gates the Competencies admin actions.
- **Confidence**: High.
- **Verified**:

  routes/auth.ts (exported from lib/config.ts via routes/auth.ts):
    Line 59-63: `export function isStaffLeadEmail(...): boolean { return CONFIG.STAFF_LEAD_EMAILS.includes(email.toLowerCase()); }`

  lib/config.ts line 21: `STAFF_LEAD_EMAILS: ((process.env.STAFF_LEAD_EMAILS ?? '') ...`

  routes/competencies.ts lines 60, 91, 115 each contain:
    `if (!isStaffLeadEmail(req.user?.email)) { ... 403 ... }`

  CLAUDE.md only references DIRECTOR_EMAILS at lines 190 and 270 — no mention of STAFF_LEAD_EMAILS or the Competencies admin gate.

  SETUP_GUIDE.md line 36: `| \`DIRECTOR_EMAILS\` | Optional | Comma-separated emails that get director-only features... |` — no STAFF_LEAD_EMAILS row exists in that table.
- **Reviewer notes**: The finding is accurate. A separate STAFF_LEAD_EMAILS env var and isStaffLeadEmail() function exist in the codebase and gate Competencies admin write endpoints (chunk sync, event corrections, person management). Neither CLAUDE.md nor SETUP_GUIDE.md document this env var or access-control role. An operator configuring a new deployment would not know to set STAFF_LEAD_EMAILS, leaving Competencies admin actions locked for everyone or assigned to the wrong role. Severity Low is appropriate: it is a documentation gap, not a security vulnerability — the gate defaults to empty string (no one has staff-lead by default), so the risk is locked features, not unauthorized access.

### DOC-11 — DESIGN.md is stale-dated (2026-05-15) relative to the modules shipped since

- **Severity**: Low
- **Location**: DESIGN.md:3 (Last updated: 2026-05-15)
- **What**: DESIGN.md's own self-update rule (DESIGN.md:325 'keep DESIGN.md current … when a module's capabilities change meaningfully') is unmet: it predates the Competencies, Supplies, and Today/ritual modules that are live in the code.
- **Why it matters**: The document that every work session is told to read first (DESIGN.md:4) materially understates the current system, compounding DOC-3/DOC-4 by giving a false 'as of 2026-05-15 this is everything' impression.
- **Suggested fix**: Refresh DESIGN.md (and its date) in the same change that lands DOC-3/DOC-4 so Section 3 reflects the shipped modules.
- **Confidence**: Medium.
- **Verified**:

  DESIGN.md line 3: `*Last updated: 2026-05-15*`

  Section 3 has no description of Competencies, Supplies, or Today/ritual modules. The only mentions are: a parenthetical "(competencies)" in the Access paragraph (line 91), and tutorial screen names in a maintenance rule (line 383). No standalone module paragraphs exist for these three areas.

  The data model table (lines 168-192) lists 21 entities but is missing: Supply (prisma/schema.prisma line 351), RitualCompletion (line 232), CookRhythm (line 260), and all Competencies models (Person, Chunk, TeachingRecord, etc. — added after line 445).

  Git dates confirm all three modules shipped after the stated DESIGN.md date:
  - competencies.ts first commit: 2026-05-16 ("Competencies: schema, API, and the teaching grid")
  - supplies.ts first commit: 2026-05-16 ("Add Toppings & bread (Supplies) feature")
  - ritual.ts / today-panel.ts first commits: 2026-05-30 ("Daily-ritual guidance: foundation + model")

  The self-update rule at DESIGN.md:325 reads: "when a module's capabilities change meaningfully, update that module's paragraph in Section 3". This rule was not followed for any of these three modules.
- **Reviewer notes**: Severity Low is correctly calibrated — this is pure documentation staleness with no runtime impact. The finding is not trivial to dismiss: DESIGN.md is explicitly designated as the document "every new session starts by reading" (line 4 / Section 6), so its omission of three live production modules (with their own routes, DB tables, and frontend screens) does meaningfully understate the current system.

### DOC-10 — specs/competencies/README.md links a chunk file that does not exist

- **Severity**: Nit
- **Location**: specs/competencies/README.md:16
- **What**: The README reading-order lists '2026-05-15-chunk-dishpit-running.md', but that file is absent from specs/competencies/ (only chunk-hospitality.md and chunk-hospitality-sering.md exist).
- **Why it matters**: A reader following the documented reading order hits a dead link, eroding trust in the spec folder as a source of truth.
- **Suggested fix**: Remove the dead reference or add the missing chunk file; reconcile the README's chunk-draft list with the files actually present.
- **Confidence**: High.
- **Verified**:

  README.md line 16: `- \`2026-05-15-chunk-dishpit-running.md\` — practical chunk (taught at a workstation)`

  Directory listing of specs/competencies/ shows no such file. Present files are:
  - 2026-05-15-chunk-hospitality-sering.md
  - 2026-05-15-chunk-hospitality.md
  - 2026-05-15-competencies-handover.md
  - 2026-05-15-competencies-implementation-plan.md
  - 2026-05-15-competencies-module-v1.md
  - 2026-05-15-sering-dictionary-v0.md
  - 2026-05-16-competencies-notion-sync.md
  - README.md
- **Reviewer notes**: The claim is accurate. The README at specs/competencies/README.md line 16 lists `2026-05-15-chunk-dishpit-running.md` as part of the reading order, but that file is absent from the directory. Only the two hospitality chunk files exist. Severity Nit is correct — this is a documentation inconsistency with no runtime or logic impact.
