# Follow-ups & Open Questions — 2026-06-05

## Caveats on the fixes shipped this session

- **DEP-1 (lockfile):** validated with `npm ci --dry-run --ignore-scripts`, not a
  full CI run. The first real `npm ci` in CI is the true gate — if it fails (e.g.
  on the `xlsx` CDN tarball integrity), regenerate the lockfile and recommit.
- **DEP-2 (dompurify):** the lockfile pins 3.4.8, but the **local `node_modules`
  still has 3.4.4** until a real `npm install`/`npm ci` runs (I used
  `--package-lock-only`). Prod/CI will install 3.4.8.
- **SEC-1:** code-side only. **The passwords remain in git history and are LIVE
  until rotated on Railway.** Removing them from the working tree does not undo
  the historical exposure. Note: the worktree `.env`'s `DATABASE_URL` was
  repointed to staging so the preview couldn't touch prod; the **main repo `.env`
  is untouched**. The plaintext credentials remain in git **history** via
  `scripts/sync-prod-to-staging.js`, `.claude/launch.json`, and
  `audits/2026-05-02-overnight/03-security.md`; a BFG / `git filter-repo` pass
  must cover all three. (The new `audits/2026-06-05/03-security.md` was redacted
  before any commit, so it never enters history with the secret.)
- **CORR-1:** the server now *silently skips* stock-bearing deletes (data-safe)
  and logs a `console.warn`. The frontend `deleteBatch` still lets a user click
  delete on a stock-bearing *uncooked* batch; the server preserves it, so on the
  next reload it reappears. Optional follow-up: a frontend guard with a clear
  toast so the UX matches the server invariant.

## Flagged but not deep-verified (need runtime or data I didn't have)

- **UIUX-6** (search re-render): confirmed statically and by the verifier; I did
  not fully reproduce the keystroke re-render live (the Ingredient Database tab
  didn't activate cleanly in the eval harness). High confidence it's real.
- **PERF-1** (lost-update): confirmed by reading the patch/merge path; not
  reproduced with two genuinely concurrent clients.
- **New screens** (competencies / supplies / recipe-AI / today-ritual): reviewed
  statically and booted clean, but not exercised end-to-end with real writes.
- **cost-per-guest**: appears partially present (`shared/supply-demand.ts`,
  `dashboard.ts`) but likely still pre-build — see DOC findings and confirm
  built-vs-spec before relying on it.

## Open questions for Daan (decisions only you can make)

1. **(SEC-1)** Have the prod/staging passwords been rotated since they were first
   committed? If not, they're live to anyone with repo history access. Either way,
   a history scrub (`git filter-repo`/BFG) is the closing step.
2. **(DEP-6)** `googleapis` is 43 majors behind (128 → 173); the only remaining
   advisories ride its transitive `uuid`. OK to do the breaking major bump in a
   dedicated PR?
3. **(CORR-3)** Supply (toppings/bread) forward demand **ignores closed services**
   and over-orders for closed days — intended, or fix?
4. **(CORR-7)** Recipe cost/nutrition treats **piece-measured** ingredient amounts
   as grams (`toGrams` passes pieces through). Is any recipe actually piece-measured,
   or is this latent?
5. **A11y** — worth a dedicated pass (~one focused PR), or is the kitchen-kiosk
   context low-priority for screen-reader/keyboard support?
6. **Docs** — CLAUDE.md and DESIGN.md are now materially behind the code (5 whole
   modules undocumented). Want me to bring them current as a follow-up?

## Suggested sequencing for the remaining work

1. **(you)** Rotate passwords + scrub history (SEC-1).
2. **One PR — data integrity:** PERF-1 lost-update + CORR-2 double-deduct.
3. **One PR — read-path bloat:** ARCH-1/PERF-3 competencies ledger refetch +
   PERF-5 recipe `versions` payload.
4. **One PR — a11y cluster:** U2 button `type`, UIUX-7 assertive error toast,
   `#save-text` aria-live, UIUX-3 grid keyboard access.
5. **One PR — doc refresh:** DOC-1/2/3/4/5/7/8/11.
6. **Dedicated PR:** `googleapis` major bump (DEP-6) — clears the last 4 moderate
   advisories.

## Method notes (for reproducing or trusting this audit)

- 8 domain finders + per-finding adversarial verification + a delta agent = 78
  agents. The verifiers confirmed 69/69 findings — a 100% pass rate, which is
  itself a mild caution (the verification didn't filter anything), so the
  Critical/High items were **additionally re-verified by hand** before fixing.
- Runtime checks ran against a **staging** build (prod credentials never loaded
  into the preview).
- The raw structured findings (claims, verdicts, evidence) came from the
  `sering-total-review` workflow run; this folder is the human-readable rendering.
