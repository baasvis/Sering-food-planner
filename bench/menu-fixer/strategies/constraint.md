# Constraint Propagation strategy

## Algorithm summary

Models Fix-My-Menu as a CSP. Each future (slot, type, position) is a variable
whose domain is the set of batches that pass node consistency (right type,
servable-by, not stale, not frozen, location-reachable). A `__NULL__` sentinel
is always in every domain so a slot can stay empty rather than reach an
infeasible state. Constraints encoded:

1. **All-different family per slot** — both positions of one (slot, type)
   cannot share `parentId` / `rootId`.
2. **Per-batch stock cap** — sum of slot shares (peer-aware) plus catering
   demand ≤ stock.
3. **Servability + staleness + frozen** — embedded in domain construction.

The search is a greedy LCV seed (sort domain by stock-to-drain × age × same-loc
preference, fill positions in date order), followed by a "surplus drain" pass
that re-injects high-surplus cooked batches into still-NULL slots, then
backtracking with **MRV** (smallest domain first) and **LCV** (least
constraining value first) and forward-check feasibility on every assignment.
A `MAX_NODES` cap (50k) and a 7.5s wall-clock deadline guarantee termination
with the best partial solution found so far.

## Pros

- **Zero hard fails** across all 10 fixtures — the family-different-in-slot
  and frozen-not-assigned constraints are baked into the domain so the search
  cannot construct an invalid assignment.
- **Drives missed-matches to ~0** (mean 0.2 vs baseline 0.7) — the surplus
  drain pass aggressively backfills NULL slots with cooked surplus instead
  of leaving "missed match" gaps the score punishes at -500/each.
- **Pure JS, no dependencies** — no ILP solver, no external optimizer,
  composable with the existing menu-fixer pipeline. Easy to embed.

## Cons

- **Hits the 7.5s deadline on every fixture** — the search rarely closes
  the optimality gap because the branching factor (4 vars × ~12 candidates
  per slot × 60+ slots) is too wide for exhaustive backtracking.
- **62/62 fill on edge fixtures still loses** to surplus-heavy floors —
  fixtures 04 / 05 contain ~200–240 L of stale-at-`today` cooked stock that
  is unrecoverable by any solver (stale food has zero servable slots), so
  scores there are pinned to baseline.
- **Greedy seed dominates final result** — the backtracking phase rarely
  finds something materially better than the LCV seed because `evaluatePartial`
  is non-monotonic in unassigned vars (the surplus penalty depends on peer
  counts which only stabilize at full assignment).

## Score breakdown vs baseline 36,075

| Fixture | Constraint | Baseline | Δ |
|---|---:|---:|---:|
| 01-sliding-mon | 49769 | 33544 | **+16225** |
| 02-sliding-wed | 49976 | 49898 | +78 |
| 03-sliding-thu | 58551 | 58551 | 0 |
| 04-sliding-sat | -2328 | -2328 | 0 |
| 05-sliding-tue-next | -20502 | -20502 | 0 |
| 06-edge-empty-week | 44681 | 44681 | 0 |
| 07-edge-surplus-stuck | 30681 | 30681 | 0 |
| 08-edge-stockout-pressure | 62044 | 62044 | 0 |
| 09-edge-frozen-rescue | 59495 | 59495 | 0 |
| 10-edge-catering-heavy | 44681 | 44681 | 0 |
| **Mean** | **37705** | **36075** | **+1630** |

Wins big on 01 (eliminated 7 missed-matches and dropped surplus from 54.7L
to 4.3L). Ties everywhere else; losing 2 slots on 01 (52/62 vs 54/62) and
2 missed-matches on 02 (vs baseline 0) are residual issues from the LCV
seed leaving NULL where a 60% over-cap would have been the better trade.

## Production readiness

**Not ready** as drop-in replacement of the 5-pass greedy:

- Latency profile is **7.5 s** vs baseline's **0.4 s**. The user clicks "Fix
  My Menu" expecting sub-second response; an 18× slowdown is unacceptable
  without a worker thread + progress UI.
- The +1630 mean score is almost entirely fixture 01's improvement (16k); on
  9/10 fixtures it merely ties baseline. Not a clear win.
- Would need: (a) caller migration to async via web worker, (b) fallback to
  greedy result if backtracking adds nothing within 1s, (c) re-tuning of the
  60% cap heuristic to reduce the 8 over-caps on fixture 01.

A more practical path is to ship just the **surplus drain post-pass** (≈100ms
overhead, fixes the missed-match gap) without the full CSP backtracking.
