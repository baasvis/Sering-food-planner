# Simulated Annealing (`sa`)

## Algorithm summary

Warm-starts from the existing 5-pass greedy baseline (consolidate → strip future → cleanup orphans → generate placeholders → Pass 1-5), then runs a simulated-annealing local search over the assignment of (batch, slot) services. Each step picks one of four neighbour moves (swap, move, add, remove) at random; improving moves are always accepted, worsening moves are accepted with probability `exp(-Δ/T)`. The temperature starts at T0 = 5000 and decays geometrically by 0.997 per step until either MAX_STEPS = 5000 or a 4.5s wall-clock budget runs out. Validity (no in-slot family duplicates, no frozen in future, family-stock budget honoured, servable cookDate, in-window date) is checked before each move and invalid moves are rejected without consuming step budget. The best-ever-seen state is tracked separately and returned at the end.

## Pros

- Deterministic warm start guarantees we never *under-perform* the baseline on any fixture — SA only ever improves or matches.
- Drains leftover surplus more aggressively than baseline: on `01-sliding-mon` the surplus drops from 54.7L to 21.9L, lifting that fixture's score by +2,609.
- Pure JS, no new dependencies, no backend service — drops in as a one-file replacement.

## Cons

- ~6× slower than baseline (mean 4,101 ms vs. 702 ms). Most of that is `scoreSolution` calls (the delta calculation walks every batch on every step).
- The neighbour-move set can't *increase* total slot fill from the baseline ceiling — for fixtures where baseline already hits 100% fill (8 of 10 fixtures), SA only nudges surplus and stale-food penalties.
- Stochastic: a different RNG seed produces a different score within ±2% on most fixtures, so per-run reproducibility relies on the hard-coded seed (`0xc0ffee`).

## Score breakdown vs baseline

| Fixture                     | Baseline | SA     | Δ      |
|-----------------------------|---------:|-------:|-------:|
| 01-sliding-mon              | 33,544   | 40,371 | +6,827 |
| 02-sliding-wed              | 49,898   | 49,898 | 0      |
| 03-sliding-thu              | 58,551   | 58,551 | 0      |
| 04-sliding-sat              | -2,328   | -2,328 | 0      |
| 05-sliding-tue-next         | -20,502  | -20,502| 0      |
| 06-edge-empty-week          | 44,681   | 44,681 | 0      |
| 07-edge-surplus-stuck       | 30,681   | 30,681 | 0      |
| 08-edge-stockout-pressure   | 62,044   | 62,044 | 0      |
| 09-edge-frozen-rescue       | 59,495   | 59,495 | 0      |
| 10-edge-catering-heavy      | 44,681   | 44,681 | 0      |
| **Mean**                    | **36,075** | **36,757** | **+682** |

Wins over baseline: 1 (`01-sliding-mon`). Ties: 9. Losses: 0.

(Nondeterministic across runs by ±2% — the warm-start replays the existing
menu-fixer pipeline which calls `new Date()` for placeholder `createdAt`.
Within one process, the SA loop itself is fully seeded.)

## Production readiness

Not ready as-is. Three reasons:

1. **Latency**: 4 s/fixture is fine for an on-demand "Fix My Menu" button, but each call replays the baseline pipeline first then runs SA on top — total user-visible latency would roughly triple. Before shipping we'd need a faster delta-scorer (current implementation re-runs `scoreSolution` end-to-end on every step) and a tighter step budget.
2. **Marginal improvement**: a +0.7% mean lift on the bench isn't worth the runtime cost. SA only really pays off on `01-sliding-mon` (+7.8%); on the other 9 fixtures it just reproduces the baseline. The baseline is already at the local optimum that single-service moves can reach for 9/10 fixtures.
3. **Bench-only setup**: the warm-start uses `require('../sandbox')` and mutates the frontend `S` global to invoke the existing menu-fixer pipeline. Shipping this in prod means either factoring out a callable solver entry point from `public/js/menu-fixer.ts` or duplicating its logic — either is a real refactor, not a drop-in.

If we keep iterating on SA, the highest-ROI next step is to extend the move set with **batch-level edits** (re-scope a batch's stock onto a different cook day, split a batch into two smaller siblings) so the search can change the structural decisions that the per-service moves can't touch — that's where the remaining penalties on fixtures 04 and 05 live (~200L surplus per fixture).
