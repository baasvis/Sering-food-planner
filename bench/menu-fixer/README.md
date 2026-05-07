# Fix-My-Menu solver bench

A scoring harness for comparing alternative menu-planning solvers against
the existing 5-pass greedy in [`public/js/menu-fixer.ts`](../../public/js/menu-fixer.ts).

## What it benchmarks

10 fixtures under [`fixtures/`](fixtures/):
- 5 sliding-today snapshots from real prod data (different planning windows
  shift which batches are cooked / surplus / stale).
- 5 hand-crafted edge cases: empty week, surplus stuck, stockout pressure,
  frozen rescue, catering-heavy.

Each fixture is a frozen `Fixture` ([types.ts](types.ts)) — batches +
caterings + guest counts + kitchen + storage + an anchor `today`.
[`snapshot.ts`](snapshot.ts) regenerates them from staging
(`DATABASE_URL_TEST`).

## Scoring

[`score.ts`](score.ts) — weights and breakdown. The two failure modes that
matter most (per user feedback): leftover surplus and missed-match (slot
empty when food was available). They dominate the weight table:

```
+1000 per slot filled
−500  per missed match (slot empty AND eligible batch had ≥1L surplus)
−300  per liter of leftover cooked surplus after window ends
−100  per slot over the 60% cap on largest batch
−50   per liter of stale food not assigned
−20   per family-budget violation
+10   per "oldest cooked stock consumed first" preserved
+2    per slot with 2 different families (variety)
```

Hard-fail constraints (any one → solution INVALID, score = -999999):
- In-slot duplicate (same family in both positions of a future slot)
- Frozen batch auto-assigned to a future slot
- Throws an exception

## Running

```bash
# Build / refresh fixtures from staging (one-off, slow)
DATABASE_URL="$DATABASE_URL_TEST" npx tsx bench/menu-fixer/snapshot.ts

# Run all solvers × all fixtures, print markdown table
npx tsx bench/menu-fixer/runner.ts

# Run only the existing 5-pass baseline
npx tsx bench/menu-fixer/runner.ts --baseline-only

# Run a specific solver
npx tsx bench/menu-fixer/runner.ts current ilp ga
```

Results are written to [`results/all-runs.json`](results/) as raw JSON.

## Strategy contract (for new solvers)

A solver implements `SolverFn` from [types.ts](types.ts):

```typescript
export type SolverFn = (input: SolverInput) => SolverResult;

interface SolverInput {
  fixture: Fixture;        // read-only
  batches: Batch[];        // mutable copy — write services here
}

interface SolverResult {
  batches: Batch[];        // mutated batches with services assigned
  durationMs: number;
  stats?: Record<string, number | string>;
}
```

Place the file under [`solvers/<name>.ts`](solvers/) exporting a const
named `<name>`. Then add the entry to the `SOLVERS` array in
[`runner.ts`](runner.ts) so the runner picks it up:

```typescript
{
  name: 'mystrategy',
  description: 'Brief one-liner',
  load: () => require('./solvers/mystrategy').mystrategy,
}
```

What a solver MUST do:
- Generate placeholder batches for missing cook events (use the
  `COOK_RHYTHM` constant from `public/js/menu-fixer.ts`, or define your own).
- Assign `services` arrays on batches (both placeholders and real ones)
  pointing at `{loc, date, meal}` triples in the 10-day window from
  `fixture.today`.
- Respect: no past-slot assignment, no frozen batch auto-assign, no two
  family-members in the same slot, stock ≥ demand for cooked batches,
  no assignment to dates earlier than the cook day's dinner.

What a solver MAY do:
- Add new placeholder batches (use any IDs — `bench-` prefix recommended).
- Reshuffle existing services on uncooked batches (the existing solver does
  this via `stripFutureServices` then re-assigns).
- Use any algorithmic approach (greedy, ILP, CP, SA, beam search, GA, ...).

What a solver MUST NOT do:
- Touch the filesystem.
- Call any I/O (network, DB).
- Mutate `fixture.*` (only `batches` is mutable).
- Take longer than ~10 seconds per fixture (kill it if it does).

Past services (`s.date < fixture.today`) are frozen history — preserve
them as-is in the output.

## Strategy notes

Each strategy should ship with a markdown brief at
`bench/menu-fixer/strategies/<name>.md` covering:
1. **Algorithm summary** (3-5 sentences).
2. **Pros** (≥3 bullets — what it wins on).
3. **Cons** (≥3 bullets — runtime, dependencies, complexity, failure modes).
4. **Score breakdown** (which fixtures it beats baseline on, which it doesn't).
5. **Production readiness** (what would need to change to ship this — new
   deps, new backend endpoint, latency profile, etc.).

The synthesis report ([strategies/COMPARISON.md](strategies/)) pulls these
together into the PR description.
