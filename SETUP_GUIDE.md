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
| `ALLOWED_EMAILS` | Recommended | Comma-separated emails permitted to log in. Empty in dev/staging means anyone with a Google account can log in (with a console warning). Empty in `AUTH_MODE=production` returns 503 to deny access. |
| `AUTH_MODE` | **Set on production deploys** | `dev` (default) or `production`. When `production`: server.ts refuses to boot if `GOOGLE_CLIENT_ID` or `ALLOWED_EMAILS` is empty, and `routes/auth.ts` disables the dev-mode bypass. Decoupled from `NODE_ENV` so local `npm run preview` (which sets `NODE_ENV=production` to serve `dist/client`) keeps using dev login. **Set `AUTH_MODE=production` in the Railway env** to enable the boot guard there. |
| `ANTHROPIC_API_KEY` | Optional | Enables the AI insights cron (data-quality checks summarised by Claude) and the director-only AI recipe assistant. |
| `DIRECTOR_EMAILS` | Optional | Comma-separated emails that get director-only features (the AI recipe assistant). Defaults to Daan's email if unset; set explicitly in production. |
| `STAFF_LEAD_EMAILS` | Optional | Comma-separated emails that get the **staff-lead** role — gates the Competencies admin actions (chunk sync, teaching-event deletion, person rename/(de)activate). Distinct from `DIRECTOR_EMAILS`; empty by default (no one has it). |
| `AI_ANALYSIS_CRON` | Optional | Default `0 7 * * *` (daily 07:00). Standard cron syntax. |
| `AI_ANALYSIS_MODEL` | Optional | Default `claude-sonnet-4-6`. |
| `NOTION_TOKEN` | Optional | Notion integration token for the Competencies chunk-library sync. Required together with `NOTION_CHUNKS_DATA_SOURCE_ID`; if either is missing the sync silently no-ops. |
| `NOTION_CHUNKS_DATA_SOURCE_ID` | Optional | Notion data source (database) ID holding the competency chunks. Paired with `NOTION_TOKEN`. |
| `COMPETENCY_SYNC_CRON` | Optional | Default `0 5 * * *` (daily 05:00). Schedules the Notion → Postgres chunk pull. Only runs when `NOTION_TOKEN` + `NOTION_CHUNKS_DATA_SOURCE_ID` are set. |
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
| `COVERAGE_API_KEY` | Optional | Bearer token for `GET /api/coverage/snapshot`. The weekly e2e coverage agent (`.github/workflows/weekly-coverage.yml`) uses this; the endpoint returns 503 if unset. |
| `GOOGLE_CREDENTIALS` | Optional | Service account JSON for legacy Google Sheets recipe import (`lib/recipe-sheets.ts`). Not required for normal app use. |
| `MAINTENANCE_MODE` | Optional | Set to `1` to put the app in read-only mode — writes return 503, reads/SSE keep working. Used during deploy windows; see `prisma/migrations/DEPLOY.md`. |

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

### Unit / API tests (Jest)

```bash
npm test
```

Runs Jest with `@swc/jest` against `DATABASE_URL_TEST`. The setup at `test/setup-env.ts` will refuse to start if you accidentally point it at a production host. The suite spans 31 files in `test/` (unit + API tests).

### End-to-end tests (Playwright)

```bash
npm run test:e2e        # headless
npm run test:e2e:ui     # UI runner — better for debugging
npm run test:all        # both Jest and Playwright in one go
```

Specs live in `e2e/`. The config in `playwright.config.ts` boots `npm run preview` on port 3000 against `DATABASE_URL_TEST`, then drives a headless browser through the dev-mode-login + location-chooser flow before running each spec.

The e2e suite runs in CI on every PR to main (`.github/workflows/pr-tests.yml`) and again weekly via `.github/workflows/weekly-coverage.yml`, which then files PRs for any `trackEvent()` features that aren't covered.

### Typecheck

```bash
npm run typecheck
```

Runs `tsc --noEmit` on both the backend (`typecheck:server`, `tsconfig.server.json`) and the frontend (`typecheck:client`, `tsconfig.json`). Run a single side with `npm run typecheck:server` or `npm run typecheck:client`.

---

## 7. Git hooks

`.git/hooks/pre-commit` runs `npm test` before allowing a commit. If you're working in a worktree, the hook auto-sources `.env` from the main repo when `DATABASE_URL` isn't set in the worktree's environment.

---

## 8. Common issues

- **"DATABASE_URL not set"** in tests — make sure `.env` is in the repo root and `DATABASE_URL_TEST` is set. Worktrees don't inherit `.env`; copy it from the main repo or rely on the pre-commit hook's auto-source.
- **Tests refuse to run** — the guard in `test/setup-env.ts` blocks known production hosts. Set `DATABASE_URL_TEST` to a scratch or staging URL.
- **`npm install` postinstall fails on Windows cmd** — `PLAYWRIGHT_BROWSERS_PATH=0` doesn't work as an inline prefix in cmd.exe. Use PowerShell, Git Bash, or `npm install --ignore-scripts && npx prisma generate` and skip the Playwright download until needed.
- **Login fails / always redirects to login** — confirm `GOOGLE_CLIENT_ID` matches the OAuth client used by the frontend. Without it, the dev-mode bypass button should appear.
- **"I keep getting logged off"** — sessions now persist in the Postgres `sessions` table, so a Railway redeploy no longer wipes them. Sessions still expire 7 days after login. If you're logged off sooner than that, check the `sessions` table and the cookie's `maxAge`.
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
- **End-to-end tests**: `e2e/*.spec.ts` (Playwright). `playwright.config.ts` at the repo root.
- **CI workflows**: `.github/workflows/` — `pr-tests.yml` (typecheck + Jest + Playwright e2e on PRs to main and pushes to main), `weekly-coverage.yml` (weekly e2e + coverage agent), `sync-staging.yml` (manual prod→staging copy).

---

## 10. Backups

Production data lives on Railway PostgreSQL — Railway provides automated point-in-time backups. There is no Google Sheet, no spreadsheet history, no other authoritative store.

Before any schema migration that drops or renames columns, take a manual `pg_dump` snapshot of the staging DB at minimum.
