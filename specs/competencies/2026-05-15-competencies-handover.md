# Competencies Module — Handover for Implementation

**Date:** 2026-05-15
**For:** Claude Code instance building the Competencies module in the Sering Suite
**From:** Daan, with design work done in conversation with Claude

---

## Read this first

This document is a **context handover, not a pure specification**. The spec is in here, but so is the reasoning behind each decision. When you hit an implementation question that the spec doesn't directly answer, the context sections should help you make a judgment call that lands in alignment with the design intent.

The module is strategically important. It is the keystone of summer 2026 work — not a side project. It encodes Sering's training model into legible, transmissible form, with the goal of producing a system that survives leadership turnover. Build accordingly.

If something in the spec feels wrong as you encounter it, surface it. Don't silently work around it. The design has been thought through but not yet tested against implementation reality; that's what this build is for.

---

## What we're building

### One-line description

A module in the Sering Suite that tracks teaching events between staff at Sering Centraal (and West, later), holds a library of teaching chunks (~30-minute units of training), and surfaces gaps and opportunities for peer teaching.

### Primary job

**Enable peer teaching across staff.** Every design decision flows from this. Other functions (tracking competence, capturing tacit knowledge, surfacing progression) are downstream consequences, not the primary purpose.

### What good looks like

After v1 is live:
- Centraal staff can see, on a shared kitchen iPad, what teaching has happened and where the gaps are
- A teaching event can be logged in under 30 seconds
- Each chunk has a written guide that lets a competent peer teach it without senior backup
- Noah uses the module weekly to surface teaching opportunities and notice gaps
- The system creates pressure (gentle, social) toward peer teaching actually happening

---

## Core data model

The system has three primary entities and one auxiliary one.

### Chunks

The atomic teachable unit. Approximately 30 minutes of teaching. Each chunk:

- **Name** (string) — e.g. "Running the dish pit", "Hospitality at Sering"
- **Station/role** (string or FK) — what station this chunk belongs to
- **Type** — practical (taught at a workstation) or sit-down (taught at a table). Note: at v1 these are stored as the same data type with a `type` field, not as separate entities. Don't create separate tables.
- **Goal description** — what the learner can do after this chunk (the 80% bar)
- **Prerequisites** — list of other chunks that should be taught first (can be empty)
- **Required-for** — list of shift types or roles this chunk is required for (metadata only, not enforced)
- **Teaching guide** — the content body of the chunk (see "Chunk content format" below)
- **When-to-teach guidance** — free text on good/bad moments to teach this
- **Link to deeper SOP** — URL or reference to canonical documentation

### Teaching events

The primary data accumulating in the system. Each event:

- **Chunk** (FK to chunk)
- **Teacher** (FK to person) — selected from staff dropdown
- **Learner** (FK to person) — selected from staff dropdown
- **Date** — defaults to today
- **Optional notes** (free text)
- **Created at** / **Created by** — for the public-ledger audit trail

There is **no separate competence flag** or matrix bit. Whether someone "can do" a station is derived from their chunk history; it is not a stored state. Don't add a `is_competent` column or anything similar. The teaching events are the data; everything else is a view on top.

### People

A reference table of Centraal staff. At v1 this is just a list of names selectable in dropdowns. If the Sering Suite already has a people/staff table, use that.

### Phrase dictionary (auxiliary)

A small, curated list of phrases (currently three) with one paragraph each on what they mean. This is a separate small entity from chunks. Chunks may link to dictionary phrases by reference.

At v1 this is a low-priority surface — read-only display from a markdown file is acceptable. The phrases themselves are constitutional content; the storage mechanism is just plumbing.

---

## Chunk content format

This is the most important thing to get right in the UI.

Each chunk's teaching guide is **learner-facing prose, organized into expandable sections**. Not teacher-facing instructions. The same document is used by a learner reading it cold, and by a teacher using it as a guide for what to cover.

**Form:**
- Sections within a chunk have headlines that aspire to be *compressed essentials* — short, principled, ideally phrase-worthy
- Each section's body expands when clicked/tapped; collapses to just the headline otherwise
- A reader of the collapsed view sees the spine of the chunk (~6 section headlines on one screen)
- A reader of the expanded view sees the full explanation

**Why this matters:** The collapsed view IS the teaching checklist. A teacher uses it to check they covered everything in 30 minutes. A learner uses it to review what they've been taught. The section headlines are doing double duty as both content structure and as candidate phrases for the dictionary.

**Implementation note:** Don't reinvent this. Use simple expandable/collapsible sections — `<details>` HTML elements are fine if the surrounding design doesn't require something fancier. The content is markdown, stored as a single field per chunk.

**Two example chunks are provided** (dish pit and hospitality). Use them to feel the form. The structure they share:
- Prerequisites / required-for at the top
- Numbered sections, each with a short principled headline and a paragraph or three of body
- A "what people get wrong" section at the end
- A "when to teach" section at the end
- A link to deeper documentation
- A "notes for the teacher" section at the very bottom
- A list of phrase candidates harvested from this chunk

Don't over-rigidly enforce this structure in the data model — store the teaching guide as a single markdown field. The structure lives in the writing, not in the schema.

---

## Access model: kiosk, not personal

This is the design constraint that shapes the most UI decisions.

**The reality:** Centraal staff don't have personal authenticated sessions on their own devices in the kitchen. They use shared iPads and computers that are always logged in to the Suite as the device, not as a person. So:

- **Identity is selected per action, not per session.** When someone logs a teaching event, they pick teacher and learner from dropdowns. There's no "current user" context.
- **Anyone present at a device can log anything.** This is intentional. Trust by default.
- **Public ledger.** Every teaching event is visible to everyone. Errors get caught socially, not by access control.
- **No per-person notifications.** No personalized dashboards. The system surfaces information through shared views.

**One exception:** There may be a "staff lead" mode (Noah, Daan, shift leads) that exposes additional admin actions like editing/deleting events, managing the chunk library, etc. This can be a simple shared password or a designated admin device. Don't over-engineer auth.

**What this means for UX:**
- Big touch targets for iPad use
- Dropdowns and pickers over text input
- No "log in" flow as the first action
- Forms should work fast: log a teaching event in under 30 seconds, three taps if possible

---

## The views (what the module renders)

Four primary views at v1, in order of priority:

### 1. Log a teaching event
The most-used surface. Should be the front door of the module.

- One screen, three pickers: teacher, learner, chunk
- Date defaults to today; tap to change
- Optional notes field below
- Big "log this teaching" button
- After logging, confirmation message with the entry summary; offer to log another or return to the main view

### 2. Per-person view
"What chunks has [person] had?"

- Pick a person from a list
- See all teaching events for that person, sorted by date descending
- Grouped by station/role
- Show which chunks they've had multiple times (repeated teaching is normal and meaningful)
- Show which chunks are still missing relative to their role

### 3. Per-chunk view
"Who has had [chunk]?"

- Pick a chunk from a list
- See all teaching events for that chunk, sorted by date descending
- Show which people have NOT had it yet (the gap)
- Display the chunk's teaching guide expandable on the same page

### 4. Gap/suggestion view
"Where are the gaps?"

- A matrix-like view: people on one axis, chunks on the other, cells show last-taught date or "not yet"
- Filter by station/role
- Filter by who's working this week (if shift roster is available; if not, skip the filter)
- This view is inspiration, not workflow. It surfaces possibilities; it does not create planned events.

**Auxiliary view: chunk library / dictionary**
- Browse all chunks (read-only)
- Browse the phrase dictionary (read-only)

**Auxiliary view: admin**
- Add/edit chunks (markdown editor for the teaching guide field)
- Add/edit teaching events (corrections)
- Add/edit people

Don't build a fancy admin UI. Markdown text areas are fine. The content authoring happens in the editor or in a markdown file synced to git; the in-app admin is for corrections.

---

## What is explicitly NOT in v1

These have been considered and deferred. Don't build them unless asked.

- **Per-person authentication.** Kiosk model only. If you find yourself building a login screen, stop and ask.
- **A "competence" bit or status.** Competence is derived from history; don't store it.
- **Hard scheduling enforcement.** The scheduler is separate software. Required-for labels on chunks are metadata for humans to consult; the module does not block anything.
- **Sub-competencies within chunks.** A chunk is the smallest unit. Don't decompose further.
- **Levels or graded competence.** Binary or nothing, and we picked nothing (history instead).
- **Volunteers as learners or teachers.** Centraal staff only. Schema should support adding them later (i.e., the "people" table should not assume "staff") but the UI is staff-only.
- **Other locations (West, TestTafel).** Same architectural note — design so adding locations later is straightforward, but at v1 only Centraal.
- **Notifications.** No push, no email, no in-app alerts.
- **Automated suggestion engine logic.** The gap view shows raw gaps; "smart" suggestions can come later.
- **Teaching event approval workflows.** No "confirm by teacher" step. Trust by default.

---

## Tech context

The Sering Suite is:
- Next.js, TypeScript, Prisma, PostgreSQL on Railway
- Existing food planner module is in place; this is a new module within the same app

Use the existing patterns from the food planner module wherever possible — same auth approach (such as it is), same component library, same data access conventions. Don't introduce new dependencies unless there's a real reason.

---

## Open questions to surface during implementation

These were discussed in design and intentionally left for implementation to decide:

1. **Backfill of existing staff.** Current Centraal staff have not had any chunks logged. Decision deferred: either accept the system launches empty, or do a one-time backfill exercise where senior staff retroactively log chunks for existing competent people. Surface this question before launch; don't decide it silently.

2. **The exact shape of "required for shift type X" metadata.** It's known to be a label, not a gate. Whether shift types are an enum, a free-text tag, or a reference to another table is open. Pick the simplest that works.

3. **Whether the gap view filters by shift roster.** Depends on whether the food planner's shift data is easily readable from this module. If yes, use it. If no, skip and list all gaps.

4. **The phrase dictionary's storage mechanism.** Could be a markdown file checked into git, could be a table. At v1 the read-only display matters more than the storage. Pick the simpler option.

---

## Design principles to carry forward

When in doubt during implementation, lean toward:

1. **Simplicity over completeness.** Most of this module's failure modes come from over-engineering. If you're tempted to add a field, ask whether it earns its place. The data model is deliberately thin.

2. **Trust over enforcement.** Don't add validations that protect against bad data; the public ledger handles social validation. Adding form validation should require a concrete reason, not a "what if."

3. **Speed of logging over richness of data.** A teaching event in under 30 seconds is a hard target. If a form starts getting long, cut.

4. **Make the gap visible.** The system's most important act is showing where chunks haven't been taught. Don't bury this. Don't dress it up.

5. **Words matter.** This module is partly about installing shared language. Labels in the UI should use the words from the chunks and the dictionary, not generic CRUD vocabulary. "Log a teaching event" rather than "Create a record." "What chunks has X had?" rather than "View user training history."

---

## Reference documents

The following are in the `/specs/competencies/` folder (alongside this handover):

- `2026-05-15-competencies-module-v1.md` — the design spec written during the design conversation
- `2026-05-15-chunk-dishpit-running.md` — first chunk draft (practical, dish pit)
- `2026-05-15-chunk-hospitality.md` — second chunk draft (sit-down, hospitality, original general version)
- `2026-05-15-chunk-hospitality-sering.md` — hospitality chunk recalibrated to Sering's register
- `2026-05-15-sering-dictionary-v0.md` — the seed phrase dictionary, three phrases

These are real content, not just examples. The chunk drafts are the first content the module will hold. Treat them as data to import on first launch, not as documentation.

---

## A note on iteration

This module will need several rounds of refinement after first launch. Build to be re-edited. Specifically:

- Chunk content will be rewritten frequently in the first few months. Make editing easy.
- The phrase dictionary will grow slowly but steadily. Make adding entries trivial.
- The gap view will need tweaks once real usage data exists.

The module is the substrate for an organizational practice that is still being invented. Build it as something that supports practice-discovery, not as something that calcifies a final design.

---

## A note on the people involved

- **Daan** is the founder and director; he holds the design intent and signs off on changes to the constitutional layer (the dictionary, the core data model).
- **Noah** is the operational lead at Centraal; he will be the heaviest user and the primary editor of chunks. The module should support him without requiring Daan as a bottleneck.
- **Centraal staff** are the population of learners and teachers. They use the kiosk surfaces.

When making UX trade-offs: optimize first for Noah's workflows, then for staff use of the kiosk surfaces, then for Daan's admin views. The food planner module's existing patterns are a good guide for the Noah-and-Daan-facing parts.

---

End of handover. Implementation can begin.
