# Overnight Audit Summary — 2026-05-02

This is the executive summary of a six-domain audit run on the
Sering-food-planner repo (`main` branch, commit `0262824`). Each domain has
its own file in this folder; this document is the elevator-pitch view plus
the priority list for what to fix.

The audit was run in **two rounds**: an initial sweep across all six domains,
and a deeper Round 2 that read the seven > 1000 LOC frontend modules,
the Tebi Playwright scraper, the archive scripts, and the full git history
end-to-end. Round 2 surfaced one new **High** finding (T18 — broken
stock-deduction) and elevated A5 to **High** (S.recipeIndex empty-state
breaks three user-visible surfaces).

## What was audited

| Domain | File | Round 1 findings | Round 2 added |
|---|---|---|---|
| Architecture & code quality | [01-architecture.md](01-architecture.md) | 16 | 8 (A17–A24) |
| UI/UX & accessibility | [02-ui-ux-accessibility.md](02-ui-ux-accessibility.md) | 17 | 7 (U18–U24) |
| Security & secrets | [03-security.md](03-security.md) | 15 | 7 (S16–S22) |
| Performance & DB/Prisma | [04-performance-db.md](04-performance-db.md) | 18 | 7 (P19–P25) |
| Tests & reliability | [05-tests-reliability.md](05-tests-reliability.md) | 17 | 6 (T18–T23) |
| Dependencies & build health | [06-dependencies-build.md](06-dependencies-build.md) | 14 | 2 (D15–D16) |
| Follow-ups & open questions | [99-followups.md](99-followups.md) | — | updated |

**Total: 134 findings** (97 Round 1 + 37 Round 2). Of the new findings, 1
High, 5 Medium, 21 Low/Nit; the rest are cross-references.

Severity distribution overall:
- Critical: 2 (S1 committed DB passwords, D1 lockfile gitignored)
- High: 6 (S2 stored XSS, S3 dev-mode bypass risk, D2 xlsx CVEs, T1 dead test, U1 zero ARIA, **A17/T18 newly elevated/added in Round 2**)
- Medium: ~35
- Low/Nit: ~91

Still healthy — this is not a dumpster fire.

## Top 12 issues, ordered by what to do first

These are the things I'd rotate the password on / open a PR for / put on the
calendar this week. The first two are urgent; the rest can be planned. **Items
11–12 were added in Round 2.**

### 1. **Rotate the production and staging Postgres passwords today** ([S1](03-security.md))
Both DB URLs with passwords are committed to the main branch
([scripts/sync-prod-to-staging.js:7-8](scripts/sync-prod-to-staging.js),
[.claude/launch.json:26](.claude/launch.json)). Anyone with read access to the
repo — current or future, if it ever goes public — can connect to prod and
staging as the `postgres` superuser. The git history retains both even after
the strings are removed from current files.

**Action**: rotate on Railway, switch the script to read from env vars, add
`.claude/launch.json` to `.gitignore`, optionally rewrite git history.

### 2. **Commit a `package-lock.json` and switch CI to `npm ci`** ([D1](06-dependencies-build.md))
The lockfile is gitignored. Production deploys, CI runs, and local installs
all resolve transitive dependencies fresh against the npm registry. Two
deploys from the same git SHA can produce different artifacts. `npm audit`
can't run without one. CI workflows have inline comments documenting the
workaround — that's institutional friction worth removing.

**Action**: `npm install --package-lock-only --ignore-scripts`, commit, drop
from `.gitignore`, update both workflow files to use `npm ci` + `cache: 'npm'`.

### 3. **Constrain `id` format on every entity validator to close stored XSS** ([S2](03-security.md))
`validateBatch`, `validateCatering`, `validateTransportItem`, and
`validateRecipe` all accept any non-empty string as `id`. The frontend
interpolates that id into `onclick=""` attributes unescaped (e.g.
[public/js/caterings.ts:53](public/js/caterings.ts)). An authenticated user
can plant a payload-id (`'); alert(…); ('`) that runs in every other staff
member's browser when they open the planner. `httpOnly` cookies prevent
session-cookie exfil but the rest of the same-origin attack surface is fully
exposed.

**Action**: add `if (!/^[a-zA-Z0-9_-]{1,200}$/.test(b.id))` to each validator.
Defense in depth: refactor onclick to delegated handlers (also enables CSP
later).

### 4. **Bump `xlsx` off the High-CVE 0.18.5** ([D2](06-dependencies-build.md))
Two High advisories (Prototype Pollution + ReDoS, CVSS 7.5/7.8). Auth-only
attack surface (only supplier-XLSX uploaders can trigger), but XLSX upload
is daily workflow. SheetJS moved to a CDN model so `npm install` doesn't
auto-suggest a fix.

**Action**: switch to `npm install https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`,
or migrate to `exceljs`. Single-route refactor either way.

### 5. **Stop swallowing DB errors in `dbReadAll`** ([A10](01-architecture.md), [T7](05-tests-reliability.md))
`GET /api/data` returns empty defaults on any DB error — frontend renders
"empty kitchen" indistinguishable from fresh state. The 31-day-silent
finance-sync incident has the same shape. Visible failure beats invisible
data loss.

**Action**: throw the error; let the global error handler return 500. The
frontend's `apiGet` already handles 500 correctly via `showDataError`.

### 6. **Add a session expiry / cleanup for the in-memory `sessions` Map** ([S5](03-security.md))
The `Map<sessionId, AppUser>` never expires. Every login adds a row;
nothing removes it (logout removes the cookie-presented session only).
Memory grows linearly until restart. Combined with the in-memory-only nature
of sessions, this also means deploys log everyone out.

**Action**: add a `lastSeenAt` timestamp, periodic cleanup (drop sessions
older than the cookie's `maxAge` of 7 days). Ideal long-term: move sessions
to Postgres so they survive restart.

### 7. **Refuse to start in production without `GOOGLE_CLIENT_ID` set** ([S3](03-security.md))
Today, `if (!CONFIG.GOOGLE_CLIENT_ID) return next();` makes every API
endpoint unauthenticated in dev mode. If a Railway env var rotation slips
or the variable is accidentally cleared, the entire app becomes a public
food planner with full read/write to prod. Single boot-time check fixes it.

**Action**: in `server.ts`, refuse to start if `NODE_ENV === 'production' && !GOOGLE_CLIENT_ID`.
Same pattern for `ALLOWED_EMAILS` empty.

### 8. **Add `aria-live` and `<dialog>` semantics to the toast and modal** ([U1, U3](02-ui-ux-accessibility.md))
The frontend has zero ARIA attributes. Save state changes are silent to
screen readers. Modals don't trap focus or announce themselves. The
`maximum-scale=1.0` viewport meta blocks pinch-zoom.

**Action**: three quick wins — `aria-live="polite"` on `#save-text` and
`#toast`; convert modal to `<dialog>` (or add `role="dialog" aria-modal="true"`);
drop `maximum-scale=1.0`. Each is one line.

### 9. **Replace fire-and-forget stock save with a real error path** ([T4](05-tests-reliability.md))
Both `public/js/orders.ts:1539` and `public/js/ingredient-db.ts:167` use
`fetch(...).catch(e => console.error(...))` — silent failure. Frontend
shows the new value, server may never have persisted. Stocktake is
high-stakes; flaky kitchen network is a known concern.

**Action**: pipe through `apiPost` so the standard error toast and retry
behaviour kick in. Update the save indicator on failure.

### 10. **Schedule a "lockfile + dep refresh" PR** ([D1, D3, D4, D5](06-dependencies-build.md))
Once the lockfile lands (item 2), bump the easy ones in one shot:
`@anthropic-ai/sdk` 0.88 → 0.92 (closes the GHSA), `googleapis` 128 → 171,
review the breaking-change notes for both. Defer Express 4 → 5 and Prisma 6 → 7
to dedicated PRs.

**Action**: one PR per group. Not urgent; the longer the gap, the harder
each bump.

### 11. **Fix the silent stock-deduction in batch recipe save** ([T18](05-tests-reliability.md)) — Round 2 finding
The "Deduct ingredients from stock after saving" checkbox in the batch
recipe editor sends a wrongly-shaped body to `/api/ingredients/stock/bulk`.
Backend returns 400. Frontend `console.warn`s and moves on — no toast, no
visible signal. The feature is silently broken and probably has been for
a while. Cooks who think they've recorded ingredient consumption haven't.

**Action**: change the request body to a flat array (per the route's
`Array.isArray(req.body)` check), and replace the `console.warn` with a
`toastError` so future regressions surface.

### 12. **Fix the three "S.recipeIndex always-empty" UX dead-ends** ([A17, U19](01-architecture.md)) — Round 2 escalation of A5
The Add Dish modal "Recipes" tab and the New Batch modal "Search recipes"
both read from `S.recipeIndex`, which is hard-coded to `[]` since the v1
sunset. Users see "No recipes in index yet" — a misleading message
pointing them at a tab where their recipes ARE present (in `S.recipes`).
Three frontend surfaces, all broken the same way.

**Action**: switch the three render sites to use `S.recipes` (the v2
recipe library). Optionally, sunset the `RecipeIndex` model entirely —
the Replace flow already uses `S.recipes` and works correctly, providing
a copy-paste template.

## What this codebase does well

The audit's tone is "here's what to fix" but the codebase has real strengths
worth naming so future refactors don't accidentally erode them:

- **`asyncHandler` + `AppError` + global error handler** — clean Express-on-modern-Node shape. 4xx/5xx distinction is right; 5xx production message-masking is right.
- **`withWriteLock` for read-modify-write JSON columns** — closes the lost-update class. Used carefully in stock, target-stock, guest-history.
- **`safeErrMsg` / `redactSecrets`** — well-designed, unit-tested, used in the right places (Hanos OAuth body capture, Tebi child-process stderr).
- **Production-DB guard in jest and playwright** — refuses to run if `DATABASE_URL` looks like prod. Identical policy in two runners. Well-documented.
- **Telemetry + AI insights pipeline** — buffered writes, daily Claude analysis, status hydration on restart. The Tebi-sync rewrite ([lib/tebi-sync.ts](lib/tebi-sync.ts)) shows what good observability looks like in this codebase; other paths can copy the pattern.
- **`dbUpsertBatches` parent-FK batching** — pre-fetches in one findMany, P2003 retry as last resort. Comment cites the AI-insight that motivated it. The kind of code that pays for itself.
- **`hydrateRecipeForDetail`** — single ingredient.findMany for denormalize + cost + nutrition, no write-back on read. Comment explains why.
- **Static-asset caching** — Vite-hashed assets `immutable`, index.html revalidates. Right shape for a Vite-built SPA.
- **Renderer registry** ([public/js/navigate.ts](public/js/navigate.ts)) — breaks the cyclic-import ball that the 12-module split would otherwise reintroduce.
- **Push-undo pattern** ([public/js/undo.ts](public/js/undo.ts)) — destructive actions get a 5s deferred-save with a toast. Better UX than `confirm()` and CLAUDE.md mandates it.
- **Triage report + reports/issues/** — institutional discipline that most internal tools never reach. Comments in code that cite past audits ("§6.1", "AI insight #20") are load-bearing — a casual cleanup that scrubs them would erase context.
- **Inline-comment density at the right level** — load-bearing comments explain *why* a non-obvious choice exists (compression skipping SSE, the parentId batching, the cache durations, the dev-mode auth gate). Don't strip these.
- **The weekly-coverage agent** — autonomously detects uncovered `trackEvent` features and files PRs. Genuinely novel for an internal tool.

## Patterns to watch (cross-cutting)

- **The "fire-and-forget + console.error" reliability anti-pattern** repeats across at least 4 sites (`recalcRecipeCostsForIngredient`, `dbAppendLog`, frontend stock saves, AI-analysis cron). The Tebi-sync rewrite shows the corrected shape. Worth a one-day sweep to migrate the rest.
- **`onclick=""` interpolation is both an XSS surface (S2) and a barrier to CSP (S7) and a reason `Window: { [key: string]: any }` exists (A2)**. One refactor closes three findings.
- **Validation strictness drops as you move from `/patch` (excellent) to per-entity routes (gaps) to single-row routes (minimal)**. Audit §6.1 is in `/patch` for a reason; the others got skipped during the lifecycle.
- **Single-replica assumption is everywhere but documented in only one place**. Sessions, write-lock, telemetry buffer, SSE registry, Hanos cache, Tebi state, undo. A multi-replica deploy would silently break in 6+ ways.
- **Frontend types are weaker than backend types**. The 2026-04-20 lost-recipe regression was a frontend type bug; CI doesn't typecheck the frontend. T2 + A1 are the same shape.

## Severity calibration

For reference on how I called severities:

- **Critical**: data loss, secret exposure, production DB at risk. Two findings: S1 (committed DB creds) and D1 (lockfile gitignored — affects every install).
- **High**: exploitable security issue or pattern that would compound badly. Five findings: S2 (XSS via id), S3 (dev-mode bypass risk), D2 (xlsx CVEs), T1 (dead test), U1 (zero ARIA).
- **Medium**: real impact on users, performance, reliability, or correctness — usually fixable in <1 day each.
- **Low**: small impact, edge cases, code-quality nits with downstream effects.
- **Nit**: cosmetic, would improve the codebase but the user wouldn't notice.

I tried to be honest. If anything reads as alarmist (or under-stated), happy
to recalibrate — it's easier to argue specifics than abstract priorities.

## What I would NOT touch

A few things that look fixable but probably should be left alone:

- **The 10-module frontend split with `Object.assign(window, {...})`** — it works,
  rewriting it for its own sake fights the audit principle (CLAUDE.md: "don't
  introduce abstractions beyond what the task requires"). Worth refactoring
  *as* you fix S2/A2/S7, not before.
- **The mutable `S` global state object** — same reasoning. Functional state
  management would be cleaner; replacing it isn't worth the migration cost
  for a one-replica internal tool.
- **`recipe-index` legacy branch** — A5 flagged it for deletion, but Daan
  is the only one who knows if Recipe v1 sunset is real. Don't touch
  without confirming.
- **`menu-fixer.ts`** — has its own test suite, has dedicated documentation
  in commits. Algorithm is the team's product; refactoring it without a
  reason is risk for no gain.

## How to use this audit

The findings are designed to be re-readable later. Each one has:
- **Severity** — for triage
- **Location** with file:line — for `gh pr create` linking
- **What** — one-sentence reproducible claim
- **Why it matters** — concrete consequence (not "this is bad")
- **Suggested fix** — actionable, but no code patches yet (per audit prompt)
- **Confidence** — High/Medium/Low so you know when to verify

If you fix something, the corresponding finding is the spec for the PR. If
you decide not to fix something, leave a comment in the file with the
rationale — future audits can compare against it.

If you spot any finding that's wrong or stale, the file headers list what I
read and what I skipped — that's the lever for redoing a domain.

## Round 2 highlights — what changed since the first summary

A second pass after the first summary added 37 findings across all six
domains. The most consequential changes:

- **One new High** — T18 (broken stock-deduction in batch recipe save). Found
  by reading `recipe-editor.ts:brSave` end-to-end. The wrong request body
  shape means the feature has presumably never worked. Verifiable with a
  30-second devtools check.
- **One escalation** — A5 (legacy RecipeIndex) was Medium "dead code branch."
  Round 2 confirms it's actively breaking three user-visible surfaces
  (Add Dish recipes tab, New Batch recipe search, plus dead orphan functions).
  Re-classified as High under A17/U19.
- **Confirmed git history is mostly clean** — S16 ran a full `git log -p`
  regex sweep for OpenAI/Google/GitHub/AWS API key prefixes across all
  379 commits. Zero matches. Only the two known Postgres passwords (S1)
  surface in history.
- **Added Tebi scraper findings** — A21, P21, P24, S20, T21 cover the
  Playwright scraper specifically. The whole sync pipeline is more
  fragile than the original audit credited; the per-day timeout magic
  numbers and partial-success masking are notable.
- **Module-level singleton timeouts everywhere** — A19 documents a
  recurring pattern in `ingredient-db.ts` and `orders.ts` where one
  shared timeout id across all rows means fast successive edits to
  different ingredients silently lose updates.
- **`updateIngredientSearch` violates the CLAUDE.md split-container rule** —
  P20/U21 — full re-render per keystroke on a 2100-row table.
- **`prisma/archive/` is "dead by accident"** — A22/S21/D16 — the scripts
  reference dropped models so they crash before doing damage. If the
  schema ever re-adds a `Service` or `Dish` model, the scripts wake up
  and wipe most production tables. Worth deleting, not just gitignoring.

If you only act on Round 2 items, do them in this order: T18 (5-minute
fix once verified), A17/U19 (single-PR copy-paste of the Replace flow
into the Add flow), then A22/D16 (one-line PR — delete `prisma/archive/`).

Good night, and good luck.
