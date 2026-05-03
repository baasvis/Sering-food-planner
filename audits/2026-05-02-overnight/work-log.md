# Work Log — 2026-05-02 overnight audit

Branch: `claude/musing-robinson-acfca7` (worktree at `.claude/worktrees/musing-robinson-acfca7`).

Format: `[STATUS] <ID> — <one-line summary>`

## Resolved
- [PR #21](https://github.com/baasvis/Sering-food-planner/pull/21) **T18** — silent stock-deduct in batch recipe save. Helper extracted + tests + toastError.
- [PR #22](https://github.com/baasvis/Sering-food-planner/pull/22) **S2** — stored XSS via id field. Regex on all entity validators + ingredient routes.
- [PR #23](https://github.com/baasvis/Sering-food-planner/pull/23) **S3+S4+S5** — boot-time `AUTH_MODE` guard, S5 marked already-resolved by Slice 11.
- [PR #24](https://github.com/baasvis/Sering-food-planner/pull/24) **A10/T7** — dbReadAll error swallowing. Errors now surface as 500.
- [PR #25](https://github.com/baasvis/Sering-food-planner/pull/25) **U1+U3+U4** — ARIA quick wins. aria-live on toast + save indicator, role="dialog" + focus shift on modal, dropped maximum-scale viewport. Verified live in preview.

## In progress
- (picking next finding)
