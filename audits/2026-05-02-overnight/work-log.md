# Work Log — 2026-05-02 overnight audit

Branch: `claude/musing-robinson-acfca7` (worktree at `.claude/worktrees/musing-robinson-acfca7`).

Format: `[STATUS] <ID> — <one-line summary>`

## Resolved
- [PR #21](https://github.com/baasvis/Sering-food-planner/pull/21) **T18** — silent stock-deduct in batch recipe save. Helper extracted + tests + toastError. Verified shape against staging (400→200).
- [PR pending] **S2** — stored XSS via id field on Batch/Catering/TransportItem/Recipe. Added `VALID_ID_PATTERN` regex to all validators + ingredient POST routes. 13 new tests, all 5 vectors verified rejected end-to-end.

## In progress
- (picking next finding)
