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
- [PR #29](https://github.com/baasvis/Sering-food-planner/pull/29) **S7** — helmet middleware (HSTS, frame-options, nosniff, referrer-policy). CSP deferred.
- [PR pending] **T19** — bulk supplier-XLSX import now triggers recipe cost recalc. Discovered the deeper FK-wipe bug (T19a) while implementing — filed as a follow-up since the safe rewrite needs more design.

## Discovered
- **T19a (high-severity data corruption)** — bulk POST `/api/ingredients` does `deleteMany + createMany` and `recipe_ingredients.ingredient_id` is `ON DELETE SET NULL`. Every supplier-XLSX import wipes recipe→ingredient links. Staging is 100% NULL (618/618), prod is 3.4% (21/625). Needs a separate PR with raw `INSERT … ON CONFLICT DO UPDATE`. Documented in `99-followups.md`.

## In progress
- (picking next finding)
