# Remediation Tracker — 2026-06-05 Review

Disposition of every finding. Legend: ✅ fixed (committed) · 🔧 to fix · 🙋 needs Daan's explicit call · ✓ verified no-fix-needed.

Last updated: 2026-06-05 (remediation in progress).

## ✅ Already fixed (committed this session)
| ID | Commit |
|---|---|
| SEC-1 (code-side) | e8f4ae7 (rotation+history still 🙋) |
| DEP-1, DEP-2, DEP-5, DEP-9 | e8f4ae7 |
| CORR-1 | c9842bd |
| PERF-1, CORR-2 | 4b462b5 |
| DOC-1 … DOC-11 | 791c367 |

## 🙋 Needs Daan's explicit call (will NOT touch without go-ahead)
- **SEC-1 (rotation + history scrub)** — rotate prod + staging Postgres passwords on Railway; scrub git history. External + destructive.
- **DEP-6** — `googleapis` 128→173 is a breaking major bump touching Google Sheets recipe import + Google auth. I can prep it on a branch, but bumping the auth lib on live prod needs your timing/testing call. (This is the only source of the last 4 moderate `npm audit` advisories.)
- **PERF-2** — duplicate migration-timestamp prefixes. The affected migrations are already applied on prod; renaming them would corrupt `_prisma_migrations`. Latent ordering fragility only — accept, or adopt a "unique timestamp" rule going forward. Your call.
- _(may grow after investigation — e.g. CORR-7 if piece-unit handling needs a domain decision)_

## ✓ Verified — no fix needed
- **SEC-7** — the AI recipe-assistant tool-use loop is sandboxed to in-memory wire state; the finding itself is a verification, not a defect.
- **ARCH-10** — the module-level write-lock is the documented single-replica concurrency model (CLAUDE.md "single dyno today"); intentional, not a defect.
- **ARCH-4** — addressed by the ARCH-3 guard; the two 60s ticks (dashboard freshness vs non-dashboard refresh) are an intentional split, each now a singleton.
- **PERF-6** — `dbUpsertCaterings`/`dbUpsertTransportItems` do one upsert per row inside the lock; row counts are tiny (a handful per save), so a raw ON-CONFLICT bulk upsert (T19a pattern) isn't justified for the negligible gain.
- **PERF-9** — the ritual-completions prune `deleteMany` runs on a tiny, few-day table; the unindexed scan is negligible (nit).

## 🔧 To fix — grouped into tested PRs (risk-ordered)
- **PR-A — backend hardening** ✅ DONE: SEC-2 / ARCH-7 / TEST-5 (competencies id+location+date validation), SEC-3 (admin/analyze → requireDirector), SEC-4 (ritual-completions validation), ARCH-6 (notion safeErrMsg), ARCH-8 (global error handler redaction). +4 validation tests; full suite 32/595 green.
- **PR-B — reliability + contained correctness** ✅ DONE: TEST-1 (orderFor revert+toast), ARCH-3 (guarded the auto-refresh interval), CORR-4 (removed dead `S.deletedBatches`), CORR-8 (replacement `cookDate: null`). ARCH-5 + ARCH-9 → moved to PR-F (supplies dataflow). ARCH-4 + ARCH-10 → see "no fix needed". Full suite 32/595 green.
- **PR-C — read-path performance** ✅ DONE: PERF-5 (toRecipeFull ships version metadata only; restore uses the dedicated endpoint), PERF-8 (split loadIngredients slim-select vs loadIngredientsFull for /full), ARCH-1 (competencies paints from cache + reloadCompetencies on mutation), ARCH-2 (recipe-AI exemplar TTL cache, no error-caching). PERF-3 → mitigated by ARCH-1 (ledger no longer refetched every 60s; deliberately NOT capped, to preserve competence-derivation correctness). Typecheck + suite green.
- **PR-D — write-path perf / concurrency** ✅ DONE: PERF-7 (batched `recalcCostsForRecipes` kills the N+1; the fire-and-forget recalc is wrapped in `withWriteLock` so its recipe.update writes serialize — both halves of the finding), PERF-4 (Notion chunk upserts no longer hold the global write lock). Adversarially reviewed — cost math proven identical. PERF-6 + PERF-9 → see "no fix needed". Typecheck + suite green.
- **PR-E — correctness / demand** (⚠ prod-critical): CORR-3 (supply demand ignores closed services), CORR-5 (inventory consolidation duplicate rows), CORR-6 (calcRequiredAtLocLive omits catering), CORR-7 (piece-as-grams — investigate first).
- **PR-F — UI/UX** (preview-verified on staging): UIUX-1 (focus clobber), UIUX-2 (dashboard flash), UIUX-3 (grid keyboard), UIUX-4 (supplies mobile), UIUX-5 (alert/confirm → toast/pushUndo), UIUX-6 (search re-render), UIUX-7 (assertive toast), UIUX-8 (nit label), SEC-6 (enumeration UX). Plus ARCH-5 (supplies per-render refetch) + ARCH-9 (supplies archived load-shape) — fixed while in the supplies screen.
- **PR-G — tests + CI**: TEST-2 (e2e nav), TEST-3 + TEST-6 (fmm-bench), TEST-4 (xlsx), TEST-7 (e2e new screens), DEP-3 (CI `npm audit` gate), DEP-7 (.nvmrc), DEP-4 (xlsx integrity note), DEP-8 (Chromium double-download), SEC-5 (nit parseCookie regex).

Each PR: implement → typecheck → targeted tests → full suite (pre-commit hook) → adversarial review on prod-critical diffs → commit. Nothing pushed.
