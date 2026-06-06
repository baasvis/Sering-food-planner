# Total Review Summary — 2026-06-05

A full re-audit of the Sering food planner, run on `main` at HEAD `79b36b0`
(the prior audit was `0262824`, 2026-05-02). Between the two there were **189
commits, +37k/−9.5k lines** — the app nearly doubled. So this was not a re-run
of May 2; it was a **delta-aware re-audit**: verify what the prior audit found,
deep-review everything shipped since (unified-batch, three Fix-My-Menu rewrites,
closed-services demand-rolling, access requests, **and the entirely new
competencies, supplies, recipe-AI, and Today/ritual modules**), and complete the
runtime checks May 2 deferred.

## How it was run

- **8 domains**, each reviewed by a dedicated agent that first read the matching
  2026-05-02 file, then deep-reviewed the new/changed surface. (6 prior domains +
  two new ones: **correctness / domain-logic** and **documentation accuracy**.)
- **Every finding was independently, adversarially verified** by a second agent
  against the live code before it was kept. (78 agents total.)
- **Live runtime verification** on a staging build (a11y, the new screens,
  behavioural checks) — see "Runtime verification" below.
- A **delta-status pass** over all 110 prior Critical/High/Medium + Top-12 findings.
- The verified Critical/High items that were safe to fix were **fixed in this
  session** (see "Fixed in this session").

## Headline numbers

**69 new findings** (after verification):

| Severity | Count |
|---|---|
| 🔴 Critical | 1 |
| 🟠 High | 3 |
| 🟡 Medium | 18 |
| ⚪ Low | 41 |
| · Nit | 6 |

Per domain: architecture 10 · ui/ux 8 · security 7 · perf-db 9 · tests 7 ·
deps 9 · correctness 8 · docs 11.

**Delta vs 2026-05-02** (110 prior findings re-checked): **31 fixed · 22 partial
· 50 open · 6 can't-tell · 1 stale.** Real progress — sessions → Postgres,
`recipe_index` sunset, `prisma/archive` deleted, and `xlsx` were all confirmed
*fixed* — but **72 are still live**, including the two Criticals and the a11y baseline.

> This is still a healthy codebase. The test suite grew from 13 to **31 files /
> 582 tests**, the unified-batch rewrite is well-tested, and the domain logic is
> mostly sound. The findings below are "what to fix next," not "it's on fire."

## Fixed in this session (verified)

All on the worktree branch; **nothing pushed**. Full Jest suite (582 tests) green
after the changes.

| ID | Sev | Fix |
|---|---|---|
| **CORR-1** | High | Added `batchRowHasStock()` guard to `dbDeleteBatchIds` (`lib/db.ts`) so the `/api/data/patch` delete path can't bypass the cannot-delete-with-stock invariant; + `test/batch-delete-guard.test.ts` (7 tests). |
| **DEP-2** | High | `dompurify` `^3.4.3` → `^3.4.8`; `npm audit` now reports **0 high/critical**. |
| **DEP-1** | High | Generated `package-lock.json`, removed it from `.gitignore`, switched both CI workflows to `npm ci` + `cache: 'npm'`; `npm ci --dry-run` validates. |
| **SEC-1** | Critical | **Partial.** Credentials removed from tracked files: `sync-prod-to-staging.js` now reads env vars; `.claude/launch.json` untracked + gitignored, `.example` added. **Remaining (yours): rotate both Postgres passwords on Railway, and scrub git history.** |

Side effect of regenerating the lockfile: the **vite (DEP-5)** and **prisma
(DEP-9)** High advisories also resolved. Only **4 moderate** advisories remain,
all from the `googleapis → uuid` chain (**DEP-6**) — the fix is a breaking
`googleapis` major bump, deferred to its own PR.

## Top issues to act on next

**Yours (ops, can't be done from code):**
1. **Rotate the prod + staging Postgres passwords** and scrub git history (SEC-1).
   The passwords are in the git history regardless of the file cleanup.

**Code (verified, not yet fixed):**
2. **PERF-1** — unified-batch inventory/shipments **lost-update** through
   `/api/data/patch` (two clients editing one batch can clobber each other).
3. **CORR-2** — ingredient stock can be **double-deducted** (`stockDeducted` is
   written but never read as a guard in the batch recipe editor).
4. **ARCH-1 / PERF-3** — the competencies screen **refetches the whole, ever-growing
   teaching-event ledger every 60s** while the screen is open (unbounded query).
5. **PERF-5** — `GET /api/data` ships every recipe's full unbounded `versions`
   JSON on every page load.
6. **UIUX-6** — ingredient-DB search still re-renders the whole Orders screen per
   keystroke (the documented split-container rule is violated in the rewrite).
7. **DOC-1 / DOC-3** — CLAUDE.md and DESIGN.md omit five whole modules (competencies,
   supplies, recipe-AI, today/ritual, team) — the docs no longer describe the app.

The a11y baseline (U1/U2/U3/UIUX-3/UIUX-7) is a cluster best done as one focused PR.

## Runtime verification (live, staging build)

- App boots clean (**no console errors**); all new screens are wired (Training,
  Toppings & bread, Team).
- **Fixed since May 2:** the viewport no longer blocks pinch-zoom (`maximum-scale`
  removed, U4); ARIA is no longer zero (28 attrs + 4 roles, U1 now partial).
- **Confirmed open:** 55/55 buttons lack `type` (U2); toast is `aria-live="polite"`
  so error toasts can be missed (UIUX-7); `#save-text` has no `aria-live`;
  the competencies grid is fully mouse-only — 0 `tabindex`/`role`/`onkeydown`
  on its cells (UIUX-3).

## Domain reports

- [01-architecture.md](01-architecture.md)
- [02-ui-ux-accessibility.md](02-ui-ux-accessibility.md)
- [03-security.md](03-security.md)
- [04-performance-db.md](04-performance-db.md)
- [05-tests-reliability.md](05-tests-reliability.md)
- [06-dependencies-build.md](06-dependencies-build.md)
- [07-correctness-domain-logic.md](07-correctness-domain-logic.md)
- [08-documentation-accuracy.md](08-documentation-accuracy.md)
- [delta-vs-2026-05-02.md](delta-vs-2026-05-02.md)
- [99-followups.md](99-followups.md)

Each finding carries a severity, a `file:line` location, a one-sentence claim,
why it matters, a suggested fix, a confidence level, and the verifier's evidence.
If you fix one, that finding is the spec for the PR. If you decide not to, leave
a note in the file so the next audit can compare.
