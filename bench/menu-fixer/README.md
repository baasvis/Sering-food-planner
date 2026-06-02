# Fix-My-Menu bench

A scoring harness for the menu planner (`public/js/menu-fixer.ts`). It runs the
real assignment pipeline against frozen fixtures and scores the result on the
cook's objective, so a scoring change is measured across scenarios instead of
eyeballed on one week.

History: a six-solver bake-off (greedy, GA, ILP, CSP, beam, simulated
annealing) was built in #47 and reverted in #53. Its conclusion: **solver
choice barely matters (+1.5–7.5%)** — the baseline is at-ceiling on most
fixtures, and the only real differentiator is the **"missed match"** failure
mode (a slot left empty when eligible food had spare capacity). That is exactly
the 2026-06 Monday-starvation bug. So we kept the fast greedy and fixed the
*objective* (slot-soonness for ready stock) and the *scoring structure*
(lexicographic tiers, so coverage urgency can't be overpowered by a dish
preference). This harness is what proved the fix generalises.

## Files

- `score.ts` — the objective + weights (unified-batch model). Two failure modes
  dominate: leftover surplus (`-300/L`) and missed match (`-500` each).
- `run-pipeline.ts` — faithful replay of `_fixMyMenuBody` against the global `S`
  (used by the bench test).
- `fixtures/` — frozen snapshots. `2026-06-01-live.json` is real prod data for
  the week of 1 Jun 2026. Regenerate with `scripts/dump-fmm-data.ts`.

## Running

The bench runs as a normal jest test (so it gates PRs in CI):

```bash
DATABASE_URL_TEST=postgresql://x:x@localhost:5432/unused npx jest test/fmm-bench.test.ts
```

It prints a per-fixture table and asserts: no hard fails, ≥90% slot fill, low
missed-matches (the regression guard), and a mean-score floor.

## Regenerating fixtures

```bash
railway run npx tsx scripts/dump-fmm-data.ts   # writes fmm-<date>.json from prod
```

Then move it into `fixtures/` and add an anchor to `FIXTURES` in
`test/fmm-bench.test.ts`. Anchor `today` at or after the cooked stock's cook
dates — anchoring earlier creates impossible "stock before it was cooked" states.
