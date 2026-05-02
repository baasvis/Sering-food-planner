# Sering Food Planner — Setup Guide

This is the practical "I have a fresh checkout, how do I run it" guide. For
architecture details see `DESIGN.md`. For Claude Code project conventions see
`CLAUDE.md`.

The app moved off Google Sheets in March 2026; the data layer is now
PostgreSQL via Prisma, the frontend is bundled by Vite, and hosting is
Railway. If you're reading an older guide that references `DB_SHEET_ID` or a
"Google Sheet log tab", that one is obsolete.

---

## 1. Prerequisites

- **Node.js >= 20.19.0** (`engines.node` in `package.json`).
- **PostgreSQL** — local install, a Railway database, or any reachable Postgres.
- **Git**.
- For finance sync (optional): the first `npm install` downloads ~300 MB of
  Chromium for Playwright. Skippable if you don't need Tebi sync — see step 3.

---

## 2. Environment variables

Create `.env` in the repo root. The file is gitignored.

| Variable | Required? | What it is |
|---|---|---|
| `DATABASE_URL` | **Yes** | Postgres URL — `postgresql://user:pass@host:port/db` |
| `DATABASE_URL_TEST` | For tests | Separate Postgres for `npm test`. Test runner refuses to use a known prod host. Staging is fine. |
| `GOOGLE_CLIENT_ID` | Production only | Google OAuth client ID. Without it, the server runs in **dev mode** — anyone can log in via the "Dev mode login" button on the login screen. |
| `ALLOWED_EMAILS` | Recommended | Comma-separated emails permitted to log in. If empty when `GOOGLE_CLIENT_ID` is set, **anyone with a Google account can log in**. |
| `ANTHROPIC_API_KEY` | Optional | Enables the AI insights cron (data-quality checks summarised by Claude). |
| `AI_ANALYSIS_CRON` | Optional | Default `0 7 * * *` (daily 07:00). Standard cron syntax. |
| `AI_ANALYSIS_MODEL` | Optional | Default `claude-sonnet-4-6`. |
| `TEBI_EMAIL` / `TEBI_PASSWORD` | Optional | Credentials for ledger 1 (Sering West, default ledger ID 723192). |
| `TEBI_LEDGER_ID` | Optional | Defaults to 723192 if not set. |
| `TEBI_LEDGER_ID_2` | Optional | Set to 724466 to also scrape the second ledger (TestTafel + Centraal). |
| `TEBI_EMAIL_2` / `TEBI_PASSWORD_2` | Optional | Credentials for ledger 2 if it's a separate Tebi account. If unset but `TEBI_LEDGER_ID_2` is set, the worker falls back to the primary creds (one-account-spans-both-ledgers mode). |
| `TEBI_FORCE_LOCATION` | Optional | `west` or `centraal` to bypass profit-center auto-discovery. |
| `TEBI_HEADLESS` | Optional | `false` to show the Playwright browser when debugging. |
| `FINANCE_SYNC_CRON` | Optional | Default `30 4 * * *` (daily 04:30). |
| `HANOS_USER_WEST` / `HANOS_PASS_WEST` | Optional | Hanos OCC credentials per location. |
| `HANOS_USER_CENTRAAL` / `HANOS_PASS_CENTRAAL` | Optional | Same for Centraal. |
| `HANOS_CLIENT_SECRET` | Optional | Hanos OAuth client secret. |
| `GOOGLE_CREDENTIALS` | Optional | Service account JSON for legacy Google Sheets recipe import (`lib/recipe-sheets.ts`). Not required for normal app use. |

A minimum-viable `.env` for local dev:

```
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/sering_dev
DATABASE_URL_TEST=postgresql://postgres:postgres@localhost:5432/sering_test
```

---

## 3. Install

```bash
npm install
```

This runs `prisma generate` and downloads Chromium for Playwright. If you don't need the Tebi finance sync (you usually don't for local dev), skip Chromium with:

```bash
npm install --ignore-scripts
npx prisma generate
```

You can always run the postinstall later if you need Tebi:

```bash
PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install --with-deps chromium
```

(On Windows cmd.exe the inline env var doesn't work — set it separately or use PowerShell / Git Bash.)

---

## 4. Set up the database

```bash
npx prisma migrate deploy
```

This applies every migration in `prisma/migrations/` to the database pointed at by `DATABASE_URL`. The first deploy seeds the ingredient catalogue and the standard-inventory list from `seeds/*.json` automatically (only if those tables are empty).

For a fresh test DB, do the same with `DATABASE_URL_TEST` substituted in.

---

## 5. Run the app

```bash
npm run dev
```

This starts two servers via `concurrently`:
- Vite on **:5173** (frontend, with HMR)
- tsx-watched Express on **:3000** (backend)

Open http://localhost:5173 in a browser. The Vite dev server proxies `/api/*` to the backend.

If you only want one port (matches the Railway production layout, fewer cookie quirks):

```bash
npm run preview
```

This runs `npm run build && node dist/server/server.js`. Single port :3000, no HMR. This is also what Claude Code's `preview_start` mechanism uses.

For production:

```bash
npm run build
npm start
```

`npm start` runs `node dist/server/server.js`. Railway runs the same after a `prisma migrate deploy`.

---

## 6. Tests

```bash
npm test
```

Runs Jest with `@swc/jest` against `DATABASE_URL_TEST`. The setup at `test/setup-env.ts` will refuse to start if you accidentally point it at a production host. Currently ~112 tests across `api.test.ts`, `location-state.test.ts`, `stock-location.test.ts`, `redact-secrets.test.ts`.

```bash
npm run typecheck
```

Runs `tsc --noEmit` on the backend.

---

## 7. Git hooks

`.git/hooks/pre-commit` runs `npm test` before allowing a commit. If you're working in a worktree, the hook auto-sources `.env` from the main repo when `DATABASE_URL` isn't set in the worktree's environment.

---

## 8. Common issues

- **"DATABASE_URL not set"** in tests — make sure `.env` is in the repo root and `DATABASE_URL_TEST` is set. Worktrees don't inherit `.env`; copy it from the main repo or rely on the pre-commit hook's auto-source.
- **Tests refuse to run** — the guard in `test/setup-env.ts` blocks known production hosts. Set `DATABASE_URL_TEST` to a scratch or staging URL.
- **`npm install` postinstall fails on Windows cmd** — `PLAYWRIGHT_BROWSERS_PATH=0` doesn't work as an inline prefix in cmd.exe. Use PowerShell, Git Bash, or `npm install --ignore-scripts && npx prisma generate` and skip the Playwright download until needed.
- **Login fails / always redirects to login** — confirm `GOOGLE_CLIENT_ID` matches the OAuth client used by the frontend. Without it, the dev-mode bypass button should appear.
- **"I keep getting logged off"** — until session persistence ships, every Railway redeploy wipes in-memory sessions. The cookie is still valid for 7 days but the server has forgotten the session. This is tracked as a planned fix; see the audit plan.
- **Tebi sync silently does nothing** — check `GET /api/finance/sync-status` for `lastSyncError`. After a deploy, status auto-hydrates from telemetry, so a stale failure is preserved instead of looking like a fresh empty state.

---

## 9. Where things live

See `CLAUDE.md` "Project Structure" for the full file map. Quick orientation:

- **Backend entry**: `server.ts` → `app.ts` → `routes/*.ts`
- **Frontend entry**: `public/index.html` → `public/js/main.ts` → `bootstrap()` in `init.ts`
- **DB schema**: `prisma/schema.prisma`
- **Shared types**: `shared/types.ts`
- **Migration history**: `prisma/migrations/`
- **One-shot scripts**: `scripts/` (read the file headers before running anything)
- **Archived scripts**: `prisma/archive/` — historical migrations, **do not run against prod** (they call `deleteMany()` on every major table)

---

## 10. Backups

Production data lives on Railway PostgreSQL — Railway provides automated point-in-time backups. There is no Google Sheet, no spreadsheet history, no other authoritative store.

Before any schema migration that drops or renames columns, take a manual `pg_dump` snapshot of the staging DB at minimum. The `prisma/archive/` directory and the audit plan have more notes.
