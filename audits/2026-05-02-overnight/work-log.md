# Work Log — 2026-05-02 overnight audit

Branch: `claude/musing-robinson-acfca7` (worktree at `.claude/worktrees/musing-robinson-acfca7`).

Format: `[STATUS] <ID> — <one-line summary>`

## Resolved
- [PR #21](https://github.com/baasvis/Sering-food-planner/pull/21) **T18** — silent stock-deduct in batch recipe save.
- [PR #22](https://github.com/baasvis/Sering-food-planner/pull/22) **S2** — stored XSS via id field.
- [PR #23](https://github.com/baasvis/Sering-food-planner/pull/23) **S3+S4+S5** — boot-time `AUTH_MODE` guard, S5 already-resolved.
- [PR #24](https://github.com/baasvis/Sering-food-planner/pull/24) **A10/T7** — dbReadAll error swallowing.
- [PR #25](https://github.com/baasvis/Sering-food-planner/pull/25) **U1+U3+U4** — ARIA quick wins.
- [PR pending] **T4** — fire-and-forget stock save. Both `ingredient-db.ts` + `orders.ts` now route through `apiPost` and pipe failures to `toastError`.

## In progress
- (picking next finding)
