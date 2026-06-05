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

## 🔧 To fix — grouped into tested PRs (risk-ordered)
- **PR-A — backend hardening** ✅ DONE: SEC-2 / ARCH-7 / TEST-5 (competencies id+location+date validation), SEC-3 (admin/analyze → requireDirector), SEC-4 (ritual-completions validation), ARCH-6 (notion safeErrMsg), ARCH-8 (global error handler redaction). +4 validation tests; full suite 32/595 green.
- **PR-B — reliability + contained correctness**: TEST-1 (orderFor silent loss), ARCH-3 + ARCH-4 (per-login timer leak / dual ticks), ARCH-5 (supplies refetch), ARCH-9 (supplies load shapes), CORR-4 (dead deletedBatches list), CORR-8 (replace copies stale cookDate), ARCH-10 (nit).
- **PR-C — read-path performance**: PERF-5 (recipe versions payload), PERF-8 (loadIngredients over-fetch), ARCH-1 + PERF-3 (competencies ledger refetch/cap), ARCH-2 (recipe-AI exemplar cache).
- **PR-D — write-path perf / concurrency** (⚠ prod-critical): PERF-7 (recalc N+1 + fire-and-forget outside lock), PERF-4 (notion sync holds write lock), PERF-6 (caterings/transport per-row upsert), PERF-9 (nit).
- **PR-E — correctness / demand** (⚠ prod-critical): CORR-3 (supply demand ignores closed services), CORR-5 (inventory consolidation duplicate rows), CORR-6 (calcRequiredAtLocLive omits catering), CORR-7 (piece-as-grams — investigate first).
- **PR-F — UI/UX** (preview-verified on staging): UIUX-1 (focus clobber), UIUX-2 (dashboard flash), UIUX-3 (grid keyboard), UIUX-4 (supplies mobile), UIUX-5 (alert/confirm → toast/pushUndo), UIUX-6 (search re-render), UIUX-7 (assertive toast), UIUX-8 (nit label), SEC-6 (enumeration UX).
- **PR-G — tests + CI**: TEST-2 (e2e nav), TEST-3 + TEST-6 (fmm-bench), TEST-4 (xlsx), TEST-7 (e2e new screens), DEP-3 (CI `npm audit` gate), DEP-7 (.nvmrc), DEP-4 (xlsx integrity note), DEP-8 (Chromium double-download), SEC-5 (nit parseCookie regex).

Each PR: implement → typecheck → targeted tests → full suite (pre-commit hook) → adversarial review on prod-critical diffs → commit. Nothing pushed.
