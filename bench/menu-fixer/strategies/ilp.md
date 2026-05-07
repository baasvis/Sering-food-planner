# ILP — Integer Linear Programming

## Algorithm summary

Models Fix-My-Menu as a binary integer program: each `(batch, slot)` candidate
becomes a 0/1 decision variable `x[b,s]`. The objective maximises
`+1002 · slotFilled[s] − 300 · leftoverSurplus[b]`, which mirrors the scorer's
two dominant terms (slot-fill reward and over-cooked penalty). Constraints
enforce stock capacity per cooked batch (`Σ x[b,s]·share(s) ≤ stock`), at most
two distinct families per slot, no family duplicates within a slot, and a
generosity cap of 8 slots per uncooked placeholder. The package
[`javascript-lp-solver`](https://github.com/JWally/jsLPSolver) handles the
branch-and-cut. We pre-generate placeholders identically to the baseline using
`COOK_RHYTHM`, then exclude impossible pairs (frozen storage, cookday-lunch
violation, stale-cooked, beyond 3-day post-cook window) so the model stays
small (~150–300 vars per fixture).

## Pros

- **Globally optimal within the linearised model**: unlike the greedy passes,
  the LP considers every assignment simultaneously and won't paint itself into a
  corner by committing a placeholder to a slot a cooked batch could have served.
- **Trivial to retune**: weights live in a single objective expression, so
  changing the trade-off between fill and surplus is a one-line edit; no need
  to rewrite an iteration order or pass logic.
- **Beats baseline on average score**: 37,389 vs 36,075 — a ~3.6% lift driven
  largely by sharper missed-match handling on fixture 01 (15 → 4) without
  losing fill rate elsewhere.

## Cons

- **Adds an external dependency**: `javascript-lp-solver` (~50KB minified, no
  native bindings). Production would need to vet it for security/maintenance
  and bundle it for the frontend if Fix-My-Menu ever runs client-side.
- **Approximation drift**: the scorer's per-slot share formula is non-linear
  (peer-aware divisor), so the LP optimises against a fair-share approximation.
  Real scores can diverge slightly from what the LP "thinks" it earned.
- **Slow on the worst case**: fixture 01 hit the 8s timeout (still produces a
  feasible solution). 9 of 10 fixtures finish in <15ms; only the densest
  candidate set bumps into branch-and-cut effort. A hard 10s/fixture cap
  remains comfortable but isn't free.

## Score breakdown (vs baseline `current`)

| Fixture | ILP | Baseline | Δ |
|---|---:|---:|---:|
| 01-sliding-mon | 49,430 | 33,544 | +15,886 |
| 02-sliding-wed | 53,160 | 49,898 | +3,262 |
| 03-sliding-thu | 58,551 | 58,551 | 0 |
| 04-sliding-sat | -8,336 | -2,328 | -6,008 |
| 05-sliding-tue-next | -20,502 | -20,502 | 0 |
| 06-edge-empty-week | 44,681 | 44,681 | 0 |
| 07-edge-surplus-stuck | 30,681 | 30,681 | 0 |
| 08-edge-stockout-pressure | 62,044 | 62,044 | 0 |
| 09-edge-frozen-rescue | 59,495 | 59,495 | 0 |
| 10-edge-catering-heavy | 44,681 | 44,681 | 0 |
| **Mean** | **37,389** | **36,075** | **+1,314** |

ILP wins big on fixture 01 (cuts missed-matches from 15 to 4) and matches
baseline on six fixtures. It loses ground on fixture 04 because its 8-slot cap
on uncooked placeholders forces 4 missed-match slots that the baseline's
combination-team Pass 5 fills opportunistically. Surplus liters are essentially
unavoidable on fixtures 04, 05, 07 — those batches are stale before today.

## Production readiness

Not yet. Two blockers:

1. **Dependency**: `javascript-lp-solver` is unfamiliar to the team. Audit
   first (last release date, test coverage, active maintenance), then choose
   between npm-bundled (frontend) or wrapped behind a backend `POST /api/menu/solve`.
2. **Latency outlier**: 8s on fixture 01 is too slow for a synchronous "Fix My
   Menu" button. Mitigation options: lower the per-solver timeout (sacrifices
   optimality), pre-tighten the model with column-generation-style filtering,
   or run it on the backend with a progress indicator.

Recommended next step: ship behind a feature flag and A/B test against the
baseline on real prod menus for a few weeks before swapping. The +1,314 mean
is real but small; the worst-case degradation on fixture 04 is the riskier
finding and deserves more scrutiny before promoting this strategy.
