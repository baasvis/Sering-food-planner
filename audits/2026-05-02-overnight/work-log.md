# Work Log — 2026-05-02 overnight audit

Branch: `claude/musing-robinson-acfca7` (worktree at `.claude/worktrees/musing-robinson-acfca7`).

Format: `[STATUS] <ID> — <one-line summary>`

## Resolved
- [PR #21](https://github.com/baasvis/Sering-food-planner/pull/21) **T18** — silent stock-deduct in batch recipe save.
- [PR #22](https://github.com/baasvis/Sering-food-planner/pull/22) **S2** — stored XSS via id field.
- [PR #23](https://github.com/baasvis/Sering-food-planner/pull/23) **S3+S4+S5** — boot-time `AUTH_MODE` guard (deployed 2026-05-04 with `AUTH_MODE=production` set on Railway).
- [PR #24](https://github.com/baasvis/Sering-food-planner/pull/24) **A10/T7** — dbReadAll error swallowing.
- [PR #25](https://github.com/baasvis/Sering-food-planner/pull/25) **U1+U3+U4** — ARIA quick wins.
- [PR #26](https://github.com/baasvis/Sering-food-planner/pull/26) **T4** — fire-and-forget stock save.
- [PR #27](https://github.com/baasvis/Sering-food-planner/pull/27) **S6** — timing-safe Bearer compare.
- [PR #28](https://github.com/baasvis/Sering-food-planner/pull/28) **S8** — photo upload mimetype whitelist + nosniff + Content-Disposition.
- [PR #29](https://github.com/baasvis/Sering-food-planner/pull/29) **S7** — helmet middleware. CSP deferred.
- [PR #30](https://github.com/baasvis/Sering-food-planner/pull/30) **T19** — bulk supplier-XLSX import triggers recipe cost recalc.
- [PR #31](https://github.com/baasvis/Sering-food-planner/pull/31) **D2** — xlsx 0.18.5 → 0.20.3 (closes 2 High CVEs).
- [PR pending] **T19a** — bulk POST FK-wipe (data corruption). Replaces `deleteMany+createMany` with raw `INSERT … ON CONFLICT DO UPDATE`. Verified against staging — recipe FKs preserved across full 1162-row bulk POST.

## In progress
- (picking next finding)
