# Strategy: Genetic Algorithm (`ga`)

## Algorithm summary

Population-based search where each chromosome encodes the full future-slot
assignment as a `Map<slotKey, [batchId|null, batchId|null]>`. Initialization
warm-starts one chromosome from the baseline 5-pass output, fills 24 more by
heavily mutating that warm start (per-position 25% reroll), and seeds the
remaining 25 with random eligible-batch picks. Each generation runs tournament
selection (size 3), uniform per-position crossover, low-rate mutation
(`p=0.05`), a repair pass that drops in-slot family duplicates, and elitism
preserves the top 5 chromosomes. The loop stops at 200 generations or after 30
generations of no improvement, whichever comes first. Determinism is enforced
by an FNV-1a fixture-name hash seeding a 32-bit LCG.

## Pros

- **Eliminates all missed-matches across the suite** (7 → 0 vs baseline) and
  reduces leftover surplus on the worst sliding fixture from 54.7L to 4.3L —
  the GA explores assignments the greedy passes never consider, like leaving
  a position empty deliberately when no batch fits well.
- **No regressions** — every fixture matches or beats baseline. Elitism and
  warm-start guarantee the search never falls below the baseline solution.
- **Tunable trade-offs**: weights in `score.ts` directly drive fitness, so
  adjusting product priorities (e.g. surplus over fill rate) requires no
  algorithmic changes — just reweight and rerun.

## Cons

- **3-4x slower than baseline** (mean 2,163ms vs 574ms). Still well within the
  10s budget but adds latency to a user-facing button click. Could be
  parallelized but would need worker threads.
- **Diminishing returns on already-good fixtures** — 7 of 10 fixtures match
  baseline exactly. The GA mostly helps when the baseline gets stuck in a
  local minimum (e.g. fixture 01 with 7 missed matches).
- **Pure soft-constraint optimization** — assumes the warm-start passes
  generated valid placeholders. Without baseline as input, an "empty" or
  pathological fixture could hit the random-init path and produce sub-optimal
  starts. Mitigated by warm-start, but a true cold-start GA would need its own
  placeholder generator.

## Score breakdown vs baseline

| Fixture | Baseline | GA | Δ |
|---|---:|---:|---:|
| 01-sliding-mon | 33544 | **56411** | **+22867** |
| 02-sliding-wed | 49898 | **54230** | **+4332** |
| 03-sliding-thu | 58551 | 58551 | 0 |
| 04-sliding-sat | -2328 | -2328 | 0 |
| 05-sliding-tue-next | -20502 | -20502 | 0 |
| 06-edge-empty-week | 44681 | 44681 | 0 |
| 07-edge-surplus-stuck | 30681 | 30681 | 0 |
| 08-edge-stockout-pressure | 62044 | 62044 | 0 |
| 09-edge-frozen-rescue | 59495 | 59495 | 0 |
| 10-edge-catering-heavy | 44681 | 44681 | 0 |
| **Mean** | **36075** | **38794** | **+2719** |

Wins on 2 fixtures, ties on 8. Missed matches dropped from 0.7 → 0.0 mean.
Surplus liters dropped from 73.0L → 66.5L mean.

## Production readiness

**Verdict: prod-ready as a fall-back / "advanced" option, not a blanket
replacement.** No new dependencies (pure JS, no `npm install`). Implementation
fits inside the existing solver contract — drop-in compatible with current
Fix-My-Menu wiring. Latency profile (~2s/run) is acceptable for a button-click
UX but feels slower than the current sub-second baseline. Recommended rollout:
keep baseline as the default fast path, expose GA behind a "Try harder"
button or run it in the background and silently swap in the better answer if
fitness improved by >5%. No backend endpoint changes needed.
