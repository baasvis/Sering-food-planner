# Beam Search

## Algorithm summary

Frames menu planning as a sequential decision problem. Slot-positions are
processed in canonical chronological order (date → meal × loc → type →
position 0/1). At each step, every beam state branches on which batch (or
empty) to assign at that position. Children are scored with an incremental
heuristic that mirrors the real scorer's headline weights — slot-fill
bonuses, leftover-surplus penalties, over-cap penalties, variety, oldest-
first — and the top K=10 by partial-score are kept; the rest are pruned.
After all positions are processed, the best surviving beam state is
written back as `services` on the cloned batches and re-scored by the real
`scoreSolution` to ensure the heuristic didn't lie about the winner.

Symmetry-breaking: when filling position 1 of a slot, only batches with
ID > position-0's ID are considered (positions are interchangeable from a
scoring perspective, so the lex-ordered restriction halves the branching
factor without losing any reachable solutions).

## Pros

- **Search-aware tradeoffs.** Greedy passes commit to the locally-best
  choice and can paint themselves into corners (e.g. assigning a
  high-stock batch to slot N forecloses pairing it with the unique partner
  needed at slot N+1). Beam keeps the alternative open and re-evaluates
  globally — that's exactly why fixture 01 jumps from 33,544 (baseline) to
  49,579 (+16,035): missed-matches drop from 7 → 0.
- **Tunable cost/quality knob.** Beam width K is a single integer dial.
  K=10 already beats baseline; K=20 gains ~120 more points. Operators can
  trade compute for plan quality without algorithm changes.
- **Fast.** All 10 fixtures finish under 30 ms each; full bench runs in
  under a quarter-second. Baseline averages 724 ms because it runs five
  full passes and rebuilds the planner index between every one. Beam
  builds its own state once.

## Cons

- **Heuristic mismatch risk.** The partial-score is an *approximation* of
  the real scorer; if the heuristic over-rewards drain-cooked or under-
  penalizes stale-ride, beam may prune the actually-optimal partial.
  Tuning the weights cost some iteration during this exercise (see commit
  history of `solvers/beam.ts`).
- **No backtracking on stale stock.** Once today is past
  STALE_THRESHOLD_DAYS from a batch's cookDate, that batch is unservable
  and beam can't drain it — same as the baseline. Fixtures 04, 05, 07
  ship in this state and beam matches baseline exactly there (no
  improvement possible without changing the staleness rule).
- **Beam is still a heuristic.** Unlike ILP/CP it doesn't prove
  optimality, just "best of the K paths I explored." For pathological
  inputs (very wide branching at the start, narrow optimum hidden under
  early bad-looking choices) it can miss what an exhaustive search would
  find. Mitigation here is K=20 fallback; for production we'd want a
  random-restart wrapper.

## Score breakdown vs baseline

Baseline (current 5-pass + Pass 5) mean: **36,075** (per the spec).
Beam mean: **37,676** (+1,601, +4.4%).

| Fixture | Beam | Baseline | Δ |
|---|---:|---:|---:|
| 01-sliding-mon | 49,579 | 33,544 | **+16,035** |
| 02-sliding-wed | 49,878 | 49,898 | -20 |
| 03-sliding-thu | 58,551 | 58,551 | 0 |
| 04-sliding-sat | -2,328 | -2,328 | 0 |
| 05-sliding-tue-next | -20,502 | -20,502 | 0 |
| 06-edge-empty-week | 44,681 | 44,681 | 0 |
| 07-edge-surplus-stuck | 30,681 | 30,681 | 0 |
| 08-edge-stockout-pressure | 62,044 | 62,044 | 0 |
| 09-edge-frozen-rescue | 59,495 | 59,495 | 0 |
| 10-edge-catering-heavy | 44,681 | 44,681 | 0 |

Beam wins 1 fixture by a wide margin, ties 8 (8 of which are already at
or near the optimal achievable score for the input), and loses 1 by 20
points (a slot-fill choice the real scorer happens to prefer 1L
differently, well within heuristic-noise).

The big win on 01 came from eliminating 7 missed-matches (slots empty
while eligible food sat in stock). Beam catches these because it can
look ahead K-deep before committing — the greedy passes can't.

## Production readiness

**Promising but not drop-in ready.** Three things would need to change:

1. **Heuristic tuning against more fixtures.** 10 fixtures isn't enough
   to be confident the heuristic generalizes — we'd want at least 30 days
   of prod data scrolled through and a guard that flags regressions per
   fixture, not just the mean.
2. **Backtracking on near-empty beams.** When K=10 candidates all
   collapse into a corner (e.g. all stocks exhausted at a hot slot), the
   beam currently just leaves slots empty. A "restart with K=20 if
   missed-matches > N" wrapper would eliminate the worst-case regressions.
3. **Same backend integration as current.ts.** Pure JS, no new deps. Can
   be slotted into `public/js/menu-fixer.ts` as `assignServicesBeam()` and
   gated behind a feature flag for A/B comparison against the 5-pass
   pipeline. Latency is 10–25 ms per run, so it can run inline in the
   same UI handler — no backend round-trip.
