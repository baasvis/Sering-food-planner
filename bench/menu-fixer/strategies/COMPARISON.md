# Fix-My-Menu solver comparison

Six strategies were evaluated against 10 fixtures (5 sliding-today snapshots
from real prod data + 5 hand-built edge cases). The bench harness lives in
[bench/menu-fixer/](../). Each fixture is scored on:

- `+1000` per future slot filled
- `−500` per missed match (slot empty AND eligible batch had spare capacity)
- `−300` per liter of cooked surplus left after the planning window
- `−100` per slot over the 60% cap on largest batch
- `−50` per liter of stale food not assigned
- `−20` per family-budget violation
- `+10` per "oldest cooked first" preserved
- `+2` per slot with 2 different families (variety)

Hard fails (in-slot duplicate, frozen auto-assigned, exception thrown) zero
out the score regardless.

The two failure modes the cook flagged: **leftover surplus** and **missed
matches**. The score weights these heaviest.

## Headline results

| Strategy | Mean Score | Δ vs baseline | Mean Time | Mean Missed | Mean Surplus L | Hard fails |
|---|---:|---:|---:|---:|---:|---:|
| **ga** ★ winner | **38,794** | **+2,719 (+7.5%)** | 1,415ms | **0.0** | **66.5** | 0 |
| constraint | 37,705 | +1,630 (+4.5%) | 7,501ms | 0.2 | 66.8 | 0 |
| beam | 37,676 | +1,601 (+4.4%) | 19ms | 0.0 | 67.9 | 0 |
| ilp | 37,417 | +1,342 (+3.7%) | 809ms | 0.8 | 67.8 | 0 |
| sa | 36,703 | +628 (+1.7%) | 3,137ms | 0.8 | 69.2 | 0 |
| current (baseline) | 36,075 | — | 547ms | 0.7 | 73.0 | 0 |

## Per-fixture breakdown

| Fixture | current | ga | constraint | beam | ilp | sa |
|---|---:|---:|---:|---:|---:|---:|
| 01-sliding-mon | 33,544 | **56,411** | 49,769 | 49,579 | 49,718 | 39,827 |
| 02-sliding-wed | 49,898 | **54,230** | 49,976 | 49,878 | 53,160 | 49,898 |
| 03-sliding-thu | 58,551 | 58,551 | 58,551 | 58,551 | 58,551 | 58,551 |
| 04-sliding-sat | -2,328 | -2,328 | -2,328 | -2,328 | **-8,336** | -2,328 |
| 05-sliding-tue-next | -20,502 | -20,502 | -20,502 | -20,502 | -20,502 | -20,502 |
| 06-edge-empty-week | 44,681 | 44,681 | 44,681 | 44,681 | 44,681 | 44,681 |
| 07-edge-surplus-stuck | 30,681 | 30,681 | 30,681 | 30,681 | 30,681 | 30,681 |
| 08-edge-stockout-pressure | 62,044 | 62,044 | 62,044 | 62,044 | 62,044 | 62,044 |
| 09-edge-frozen-rescue | 59,495 | 59,495 | 59,495 | 59,495 | 59,495 | 59,495 |
| 10-edge-catering-heavy | 44,681 | 44,681 | 44,681 | 44,681 | 44,681 | 44,681 |

(**Bold** = best for that fixture; ILP's negative on fixture 04 is the only
regression any strategy produced.)

## Key insight: 9/10 fixtures are already optimal

The current 5-pass + Pass 5 baseline is already at or near the ceiling on
**eight** of ten fixtures. All meaningful score divergence between strategies
happens on a single fixture (`01-sliding-mon`) — and on `02-sliding-wed` for
the search-based strategies.

What that one fixture stresses: a Monday morning state where the previous
Sunday over-cooked. The greedy passes leave 7 slots empty even though
there's eligible food in stock — a "missed match" that the score function
penalizes hard. The pass functions can't see two slots ahead to recognize
that the same batch can fill multiple positions if assigned thoughtfully.

The other 9 fixtures don't suffer from this — either they're balanced
enough that greedy handles them, OR they're so skewed (~200L stale food
on fixtures 04/05) that no solver can recover. Stale food has zero
servable slots; it's lost regardless of algorithm.

## Per-strategy verdict

### Genetic algorithm (`ga`) — **WINNER**

Population-based search; warm-starts from the 5-pass baseline, then
refines via tournament selection + uniform crossover + mutation +
elitism. Deterministic via seeded LCG. Stops at 200 generations or after
30 generations of no improvement.

- Beats baseline on 2 fixtures, ties on 8, loses on 0.
- Eliminates ALL missed matches (0.7 → 0.0 mean).
- Lowest mean surplus of any strategy (66.5L vs 73L baseline).
- 3× slower than baseline (1.4s mean) but well under the 10s budget.
- Zero new dependencies, zero hard fails, fully deterministic.
- Drop-in compatible: refines the existing pass output rather than
  replacing it. Falls back to baseline behavior if the GA loop gets
  stuck. Full strategy doc: [ga.md](ga.md).

### Beam search (`beam`) — runner-up on speed

K=10 beam, sequential decision per slot-position. Fastest of the bunch
at 19ms/fixture (38× faster than baseline) and matches GA's missed-match
elimination. **But**: leaves 2 slots empty on fixture 01 vs GA's 4-slot
gain, and accepts 10 over-cap violations to do it. Score 37,676 vs GA's
38,794 — a real difference, not noise. Worth keeping in mind if latency
becomes the dominant constraint. Full doc: [beam.md](beam.md).

### Constraint propagation (`constraint`)

Same missed-match elimination as GA on fixture 01, but pinned to 7.5s
deadline on every fixture (18× baseline latency). Greedy seed dominates
the final result; the backtracking phase rarely closes the optimality
gap because branching is too wide. Useful insight from this agent: the
"surplus drain post-pass" (~100ms) could be lifted out and bolted onto
the existing 5-pass without the full CSP overhead — could be a future
hybrid. Full doc: [constraint.md](constraint.md).

### Integer linear programming (`ilp`)

Models the problem as binary IP via `javascript-lp-solver`. Globally
optimal within the linearized model, but:

- Hits an 8s timeout on fixture 01 (mostly returns ok elsewhere)
- **Regresses on fixture 04** by -6,008 — only strategy that loses
  ground anywhere in the suite
- Adds an external dependency (~50KB, npm `javascript-lp-solver`)
- Scoring is a fair-share approximation, not the real peer-aware
  formula

Worth revisiting if the team wants formal optimality guarantees, but
the dependency + worst-case latency + fixture-04 regression rule it out
for now. Full doc: [ilp.md](ilp.md).

### Simulated annealing (`sa`)

Warm-starts from baseline, runs 5000 SA steps. Wins on fixture 01 only,
ties on 9. +1.7% mean lift not worth ~3s/fixture latency. The neighbor-
move set (swap/move/add/remove) can't make structural changes (split a
batch, add a new cook day), which is where the remaining penalties live.
Full doc: [sa.md](sa.md).

## Recommendation

Ship **GA** behind a `MENU_FIXER_VERSION` flag, default to current
(baseline). Reasons:

1. **Best score** of all 6 strategies, by a real margin (+1.1k vs runner-up).
2. **Zero regressions** — never under-performs baseline on any fixture.
3. **Eliminates the cook's stated pain points** (missed matches → 0,
   surplus 73L → 66.5L on the hard fixture).
4. **No new dependencies, no architectural changes** — pure JS warm-
   started from the existing 5-pass.
5. **Latency acceptable** — 1.4s mean is fine for a button click; even
   in worst case (4.3s on fixture 01) it's under the 5s "feels broken"
   threshold.

Risks to watch in preview:
- The 1.4s latency may feel different than the current sub-second
  response — might want a "Working…" indicator during longer runs.
- 7 of 10 fixtures don't change vs baseline. The benefit only shows up
  on the kinds of weeks fixture 01 represents (Sunday over-cook
  followed by under-utilized Monday). If your prod weeks rarely match
  that pattern, the win is invisible.
- The 195L/242L stale-food fixtures (04, 05) are unsolvable by any
  algorithm — they need a data fix (someone has to either eat or
  freeze that food). Worth surfacing as a warning even pre-GA.

## Future improvements (not in this PR)

- **Hybrid: 5-pass + constraint's surplus-drain pass** (~100ms cost) —
  the constraint agent's specific suggestion; could close the missed-
  match gap without the GA overhead. Worth comparing if the GA latency
  becomes a problem.
- **Larger fixture set** — 10 fixtures isn't enough to be confident a
  strategy generalizes. The weekly e2e coverage workflow could mine
  more "interesting" weeks from telemetry to widen the bench.
- **Tighter scoring weights** — these are first-cut. If GA wins for
  reasons that don't match your real priorities (e.g. you actually
  prefer empty slots over over-cap, or vice versa), reweight in
  [score.ts](../score.ts) and re-run all 6 strategies — the bench
  picks up the new weights with no other changes.
