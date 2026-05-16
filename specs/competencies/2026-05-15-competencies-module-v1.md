# Competencies Module — v1 Spec

**Date:** 2026-05-15
**Status:** Draft, pre-implementation
**Lives in:** Sering Suite (new module)

---

## Strategic frame

The Competencies module is the keystone of summer 2026's work. It sits at the intersection of:

- Centraal ramp-up and Noah's GM development
- Org legibility (making the training model explicit)
- The manifesto's "material conditions for participation" line — making participation legible and progressive

It is not a side project. Building it forces the thinking that has been deferred: what is De Sering's training model, actually?

## Primary job

**Enable peer teaching across staff.** Everything else in the module exists to make peer teaching easier, more legible, and more reliable.

Not the primary job (but downstream consequences):
- Tracking who can do what
- Capturing tacit knowledge
- Showing staff their progression

These all happen, but they emerge from the peer-teaching loop. If peer teaching works, the rest follows. If peer teaching doesn't work, the rest is a dead matrix.

## Scope at v1

**In scope:**
- Centraal staff only
- BOH, FOH, cross-functional, opening/closing competencies
- Kiosk-mode access on shared iPads/computers already in the kitchen

**Explicitly deferred:**
- Volunteers
- Sering West and TestTafel
- Per-person authenticated access
- Automated/dynamic suggestion engine logic
- Software integration with the scheduler
- Sub-competencies within stations
- Levels or graded competence

## Core model

### Chunks
The atomic teachable unit. Approximately 30 minutes of teaching.

Each chunk has:
- **Name** (e.g. "Opening the dish pit," "Reading the prep list")
- **Station/role** it belongs to (one chunk → one station)
- **Teaching guide** (see below)
- **Required-for labels** (optional) — e.g. "required for any closing shift"
- **Link to deeper SOP** (the canonical doc, recipe, video, etc.)

### Teaching guide (structure of each chunk's guide)
1. **Checklist** — ordered list of what should be taught, in what order
2. **Per-step instructions** — for each item on the checklist, how to teach it (demonstrate first / have them try / common mistake is X)
3. **When-to-teach guidance** — free-text notes on good and bad moments to teach this (e.g. "good on slow Tuesday lunch, bad during Sunday production")
4. **Link out** — to the canonical SOP, recipe, video, or photos

### Teaching events
The primary data the system accumulates. Each event:
- **Chunk** (what was taught)
- **Teacher** (selected from staff dropdown)
- **Learner** (selected from staff dropdown)
- **Date** (defaults to today)
- **Optional notes**

There is **no separate "can do / can't do" bit.** Competence is derived from teaching event history.

### Stations / roles
A station is a bundle of chunks. Stations are useful as a grouping abstraction — they help staff and Noah see "what does prep lead mean? these chunks." But the system does not treat "station completion" as a state. Staff have had chunks; whether they can run a station is a judgment made by the human scheduler.

## Authority and access (kiosk model)

- **Devices:** Shared iPads and computers already in the kitchens.
- **No per-person auth.** Identity is selected per-action from a dropdown (the action says who did it, the device is shared).
- **Anyone can log a teaching event.** Trust by default.
- **Public ledger.** All teaching events visible to all staff. Errors are caught socially.
- **No "matrix flip" authority question** — because there is no matrix bit. Removed by simplification.

## Workflow

### Logging (the primary action)
At a kitchen iPad: tap "log teaching" → pick teacher → pick learner → pick chunk → save. Should take under 30 seconds.

### Browsing surfaces
1. **Per-person view** — "what chunks has Tom had?" Used by Tom, by Noah, by anyone curious.
2. **Per-chunk view** — "who has had the prep-list chunk?" Used when looking for someone who can do a thing, or for spotting underused teachers.
3. **Suggestion/gap view** — "where are the gaps in Centraal's competence?" Used as inspiration, not workflow. Surfaces possibilities, does not create planned events.

### Scheduling (out of scope but adjacent)
The scheduler is separate software. This module exposes data that the human scheduler can consult. Required-chunk labels on chunks help the scheduler know what to look for.

## Content authorship process

The biggest lift is not the code — it's writing the chunks and teaching guides.

**Phase 1 — solo template-finding.** Daan drafts 3–4 stations solo. Goal is not to produce the chunk library, but to discover the right form: granularity, language, what a "chunk" actually looks like when written down. **Deliberate stop after the third or fourth station.** Do not drift into solo-drafting-everything.

**Phase 2 — decide how to involve others.** Decision deferred until the template is settled. Options on the table: paired sessions per station, distributed drafting with structured review, or mixed. Decide with information, not in advance.

Language consistency across chunks is a hard requirement — chunks must be legible as a set.

## What "done" looks like for v1

- Sering Suite has a Competencies module
- Chunk library exists for Centraal's stations (drafted via Phase 1 + 2)
- Teaching events can be logged from any kitchen iPad in under 30 seconds
- Three browsing views work: per-person, per-chunk, suggestion/gap
- Public ledger of teaching events visible to all staff
- No scheduling integration; no authentication

## Risks and open questions

- **Backfill of existing staff.** Current Centraal staff have not had any chunks logged. Either accept the system launches empty (and existing competence is invisible) or do a one-time backfill exercise. Decide before launch.
- **The "did teaching actually happen" question.** Trust by default means occasional false entries. Acceptable risk if the public ledger catches them. Revisit after 3 months.
- **The drift risk in Phase 1.** Daan deliberately stops after 3–4 drafts. Concrete checkpoint, not a vibe.
- **Suggestion engine logic.** "Surfaces possibilities" is vague. v1 implementation can be simple (show gaps in matrix form, sorted by who's on shift this week if shift roster is available). Defer cleverness.
