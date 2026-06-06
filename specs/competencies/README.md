# /specs/competencies/

Design documents for the Competencies module of the Sering Suite.

## Reading order

If you're new to this:

1. **`2026-05-15-competencies-handover.md`** — start here. Context handover for the Claude Code instance implementing the module. Contains the spec, the reasoning, and the design principles. Anyone working on this module should read this first.

2. **`2026-05-15-competencies-module-v1.md`** — the design spec on its own, written during the original design conversation. Subset of the handover; useful as a quick reference.

3. **`2026-05-15-sering-dictionary-v0.md`** — the seed phrase dictionary. Three phrases. Constitutional content.

4. **The chunk drafts** — examples of what the module's content actually looks like:
   - `2026-05-15-chunk-hospitality.md` — sit-down chunk, original general version
   - `2026-05-15-chunk-hospitality-sering.md` — sit-down chunk, recalibrated to Sering's register

## What this folder is for

This folder holds the design and content artifacts for the Competencies module. It is the source of truth for:

- **What the module is supposed to be** (the handover and spec)
- **What "good" content looks like** (the chunk drafts)
- **The constitutional vocabulary** (the dictionary)

The actual implementation code lives elsewhere in the repo. This folder is where the *intent* lives.

## Iteration

These documents are expected to evolve. When updating:

- Date-stamp new versions rather than overwriting (e.g. `2026-06-XX-...`)
- Keep the historical versions in the folder; they're useful for understanding why things changed
- Update this README when the reading order changes

## Status

**Date of this snapshot:** 2026-05-15
**Module status:** Implemented (v1 + Notion sync). The module shipped — the
implementation lives in `routes/competencies.ts`, `public/js/competencies.ts`,
the `Person` / `Chunk` / `TeachingEvent` Prisma models, and the Notion chunk
sync in `lib/notion-sync.ts`. This folder remains the source of truth for the
*intent* (spec, content principles, dictionary); the design docs below predate
the build.
