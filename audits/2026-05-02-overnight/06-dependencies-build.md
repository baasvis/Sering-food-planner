# Dependencies & Build Health

## Scope of review

- [package.json](package.json) — declared deps, scripts, engines.
- [.gitignore](.gitignore) — confirmed `package-lock.json` is gitignored.
- [tsconfig.json](tsconfig.json), [tsconfig.server.json](tsconfig.server.json) — TS config.
- [vite.config.ts](vite.config.ts), [playwright.config.ts](playwright.config.ts), [railway.toml](railway.toml), [railpack.json](railpack.json).
- CI workflows: [.github/workflows/pr-tests.yml](.github/workflows/pr-tests.yml), [.github/workflows/weekly-coverage.yml](.github/workflows/weekly-coverage.yml), [.github/workflows/sync-staging.yml](.github/workflows/sync-staging.yml).
- Live `npm audit` and `npm outdated` output (generated a temporary `package-lock.json` for the audit, then removed it).

## Findings

### D1 — `package-lock.json` is gitignored — no reproducible installs anywhere
- **Severity**: **Critical**
- **Location**: [.gitignore:2](.gitignore), confirmed in [.github/workflows/pr-tests.yml:35](.github/workflows/pr-tests.yml) ("No `cache: 'npm'` — package-lock.json is gitignored in this repo") and [.github/workflows/weekly-coverage.yml:42](.github/workflows/weekly-coverage.yml) ("`npm install` (not `npm ci`) for the same reason").
- **What**: The lockfile that pins exact transitive dependency versions is excluded from git. Every `npm install` resolves all `^x.y.z` and `~x.y.z` ranges fresh against the registry. CI uses `npm install`, not `npm ci`. Production deploys (Railway) run `npm install` via the postinstall pipeline.
- **Why it matters**: 
  - **Production drift**: If a transitive dep ships a breaking patch overnight, the *next* deploy's `npm install` picks it up. Two consecutive Railway deploys can produce different artifact contents from the same git SHA.
  - **CI ≠ production ≠ local-dev**: PR tests pass with one resolved tree, prod gets another. The test-pass signal is weaker than it looks.
  - **Security patch slowness**: When a CVE is fixed in a transitive dep, you can't pin the team to "we are on safe version X" — you can only verify it after `npm install`. Triage is harder.
  - **`npm audit` requires generating a lockfile every time** to even produce a report. The autonomy agent can't `npm ci` either.
  - The commit messages show this was a deliberate choice (`b998f52: ci: drop npm cache + use npm install — repo has no committed lock file`). Whatever motivated removing it likely doesn't outweigh the trade-off; worth revisiting.
- **Suggested fix**: 
  1. Generate `package-lock.json` once: `npm install --package-lock-only --ignore-scripts`. Commit it.
  2. Remove `package-lock.json` from `.gitignore`.
  3. CI workflows: switch `npm install` → `npm ci`. Re-enable `cache: 'npm'` in setup-node steps.
  4. Document the rule in CLAUDE.md: "Run `npm install` locally and commit the lockfile changes when deps change."
- **Confidence**: High — verified with `npm install --package-lock-only` that a lockfile generates cleanly; the file is just not tracked.

### D2 — `xlsx` 0.18.5 has known high-severity CVEs with no fix path
- **Severity**: **High**
- **Location**: [package.json:38](package.json) — `"xlsx": "^0.18.5"`.
- **What**: `npm audit` reports two High advisories on this version:
  - GHSA-4r6h-8v6p-xvw6 (Prototype Pollution, CWE-1321, CVSS 7.8) — fixed in `<0.19.3`.
  - GHSA-5pgg-2g8v-p4x9 (ReDoS, CWE-1333, CVSS 7.5) — fixed in `<0.20.2`.
  - `npm audit` reports `fixAvailable: false` because the project is pinned via `^0.18.5` semver, but the actual SheetJS author moved to a paid model and 0.20.x lives at `cdn.sheetjs.com` rather than npm. This is why npm doesn't auto-suggest a fix.
- **Why it matters**: Authenticated-only attack surface: only supplier-XLSX uploaders can trigger. But XLSX upload is part of the daily ingredient-DB workflow. A malicious supplier file (or a compromised supplier email) could pop the server.
- **Suggested fix**: 
  1. Switch to the SheetJS CDN-hosted package: `npm install https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`. Their official path now.
  2. Or, replace `xlsx` with `exceljs` (actively maintained, MIT, npm-distributed). API-port effort is real but bounded — only one route uses it ([routes/ingredients-import.ts](routes/ingredients-import.ts)).
  3. Long-term, consider whether server-side XLSX parsing is needed at all — could the frontend parse with `SheetJS-Lite` and POST normalised JSON?
- **Confidence**: High.

### D3 — `@anthropic-ai/sdk` 0.88.0 is on the GHSA-p7fg-763f-g4gf advisory — RESOLVED
- **Severity**: Medium
- **Location**: [package.json:26](package.json) — `~0.88.0`.
- **What**: GHSA-p7fg-763f-g4gf — "Insecure Default File Permissions in Local Filesystem Memory Tool" (CWE-732). Affects `@anthropic-ai/sdk >=0.79.0 <0.91.1`. Fix in 0.92.0. The advisory is Memory-Tool-specific; this codebase uses the SDK only for `client.messages.create({...})` ([lib/ai-analyzer.ts:301](lib/ai-analyzer.ts)) — no Memory Tool usage. Real exposure: zero.
- **Why it matters**: Even though the affected feature isn't used, it's a marker on every npm audit run. Developers learn to ignore audits when there's persistent noise.
- **Suggested fix**: Bump to `^0.92.0` (semver-major). One-line change. The release notes should be reviewed for `messages.create` API changes, but this kind of bump is routine.
- **Confidence**: High.
- **Resolution (2026-05-03)**: Bumped to `^0.92.0`. Reviewed CHANGELOG 0.88→0.92 — no breaking changes to `messages.create` (the only call site at [lib/ai-analyzer.ts:301](lib/ai-analyzer.ts:301)). 0.89-0.92 added managed-agents/CMA Memory APIs, bedrock fixes, and internal codegen, none of which touch the surface this app uses. `npm audit` no longer lists GHSA-p7fg-763f-g4gf. All 236 tests pass.

### D4 — `googleapis` 128.0.0 is 43 majors behind (latest 171.x)
- **Severity**: Medium
- **Location**: [package.json:33](package.json).
- **What**: 
  - `googleapis` 128 → 171 spans many minor and major version bumps.
  - Pulls in `googleapis-common <=7.2.0` → `gaxios 6.4.0–6.7.1` → `uuid <14.0.0`. The transitive `uuid` carries GHSA-w5hq-g745-h8pq (CWE-787 buffer bounds in v3/v5/v6 when buf is provided).
  - The codebase uses googleapis only for the legacy Google Sheets recipe import ([lib/recipe-sheets.ts](lib/recipe-sheets.ts)) — already documented as legacy in CLAUDE.md.
- **Why it matters**: 
  - 43-major drift makes any future bump hard (more breaking changes to read).
  - The transitive `uuid` CVE is a real-but-mild bug; the codebase doesn't seem to use the impacted v3/v5/v6 buf-overload path.
  - If the Sheets import is genuinely sunset, removing the dep entirely would close this set of issues.
- **Suggested fix**: 
  1. Quick fix: bump `googleapis` to latest (171.x) — `npm audit` says fixAvailable. Probably semver-major; review change log.
  2. Better: confirm with Daan whether legacy Sheets import is still used (CLAUDE.md says "external recipe sheet reading only"); if not, delete `lib/recipe-sheets.ts`, the `/api/recipe` route, and remove `googleapis` + `google-auth-library` (if google-auth is only used here).
- **Confidence**: High for the version drift; Medium for the "is this dep still needed" call.

### D5 — `express` is on 4.x (5.x is current); `prisma` and `@prisma/client` are on 6.x (7.x is current)
- **Severity**: Low (current), Medium (over time)
- **Location**: [package.json:31,27,37](package.json).
- **What**:
  - `express ^4.18.2` (latest 5.2.1) — Express 5 is a real semver-major (async error handling changes, removed `req.param`, etc.). Migration is a project, not a one-liner.
  - `@prisma/client ~6.19.2` and `prisma ~6.19.2` (latest 7.x). Prisma 7 made breaking changes around the JS client output structure (`@prisma/client/index-browser` removal, etc.).
  - `@types/node ~25.5.0` is recent, fine.
  - `typescript ~6.0.2` — current major.
  - `vite ~8.0.3` — current major.
- **Why it matters**: Express 4 is in maintenance, not security. Prisma 6 is still supported. No urgency. But the gap widens monthly; future bumps get more painful.
- **Suggested fix**: Schedule a "Q3 dep refresh" — bump Express to 5 and Prisma to 7 in dedicated PRs with their own test runs.
- **Confidence**: High.

### D6 — `postinstall` downloads ~300 MB of Chromium even when not needed
- **Severity**: Low (dev UX)
- **Location**: [package.json:12](package.json) — `"postinstall": "prisma generate && cross-env PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install --with-deps chromium"`.
- **What**: Every `npm install` (locally, in CI, in Railway production) runs Playwright's Chromium download. CLAUDE.md acknowledges this. Production needs Chromium for the Tebi scraper, so it's not optional. But CI's pr-tests.yml *also* runs `npx playwright install` again ([.github/workflows/pr-tests.yml:46](.github/workflows/pr-tests.yml)) — second download.
- **Why it matters**: 
  - Slow installs (~30-60s extra per install).
  - CI pays twice. weekly-coverage.yml also downloads twice.
  - Local dev contributors who don't need Tebi/Playwright pay the cost.
- **Suggested fix**: 
  1. Move the Playwright install out of `postinstall` and into a dedicated `npm run setup:playwright` script. CI explicitly invokes it; production CMD does too.
  2. Or use Playwright's `playwright/skip-browser-download` env (`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`) and have CI/production set it to 0.
  3. CI `actions/setup-node` cache key plus a Playwright browser cache (`actions/cache@v4` with `~/.cache/ms-playwright`) avoids re-downloading on every PR.
- **Confidence**: High.

### D7 — `engines.node >= 20.19.0` is reasonable; nothing pins minor in CI
- **Severity**: Low
- **Location**: [package.json:58](package.json), [.github/workflows/pr-tests.yml:34](.github/workflows/pr-tests.yml) (CI uses `node-version: '20'`).
- **What**: CI uses `'20'` which resolves to whatever the latest 20.x is at action-run time. Dev contributors see whatever they have locally (only the lower bound is enforced). Production Railway uses what its base image provides. So the Node version is *more* aligned than the npm dep tree, but still not pinned end-to-end.
- **Why it matters**: A Node-20.x release shipping a breaking change (rare but happens) would land in CI or prod silently. The team would notice via test failures or runtime errors.
- **Suggested fix**: Pin CI to a specific Node version via `.nvmrc` (or `node-version-file: '.nvmrc'` in setup-node). Same value goes into the Railway nixpacks/railpack config. One source of truth.
- **Confidence**: Medium.

### D8 — Build script chains tsc and vite serially with no incremental cache
- **Severity**: Low
- **Location**: [package.json:10](package.json) — `"build": "npx vite build --config vite.config.ts && npx tsc -p tsconfig.server.json"`.
- **What**: Vite handles client; tsc handles server. Both cold-start every time. tsc has `incremental` support disabled (no `tsBuildInfoFile`). Probably fine for a small project; worth knowing.
- **Why it matters**: ~5-15s rebuild on changes. Local dev uses `tsx watch` which is fine.
- **Suggested fix**: Add `"incremental": true` and `"tsBuildInfoFile": ".tsbuildinfo"` to `tsconfig.server.json`. Add `.tsbuildinfo` to `.gitignore`.
- **Confidence**: High.

### D9 — `@anthropic-ai/sdk`, `compression`, `multer`, `node-cron`, `dotenv`, `xlsx` are all up-to-date or close to it (relative to declared range)
- **Severity**: (Positive context for D2-D5)
- **Location**: `npm outdated` output.
- **What**: Most direct deps' "wanted" matches "latest" — i.e. the declared range is satisfied at HEAD. The outliers are the ones flagged in D2-D5.
- **Why it matters**: This is a healthy signal. The team isn't operating on years-old packages across the board; the version-drift problems are concentrated.
- **Suggested fix**: None.
- **Confidence**: High.

### D10 — `concurrently` and `cross-env` are normalisation overhead that can disappear with modern tooling
- **Severity**: Nit
- **Location**: [package.json:68-69](package.json) — `concurrently ^9.2.1`, `cross-env ~10.1.0`.
- **What**: `cross-env` is needed because Windows shells can't `FOO=bar npm run baz`. `concurrently` runs multiple processes. Both are stable, fine. Modern Node has `node --env-file=.env` and bash on Windows is a `git config` away. The deps are tiny.
- **Why it matters**: Not really. Worth noting that the entire dev experience depends on these working — if either ships a breaking change, dev breaks.
- **Suggested fix**: None today. If Node 22 LTS support gets dropped, revisit.
- **Confidence**: Medium.

### D11 — `@types/multer` is missing despite using `multer`
- **Severity**: Low
- **Location**: [package.json](package.json), [types/multer.d.ts](types/multer.d.ts) — module declaration shim instead of types.
- **What**: The repo carries a stub `types/multer.d.ts` (`declare module 'multer'`) instead of the real `@types/multer`. Reading [types/multer.d.ts](types/multer.d.ts) shows `26 chars` — likely just `declare module 'multer';`. Real `@types/multer` exists and is current. Without it, every `req.file`/`req.files` access requires hand-typed casts, several of which use `(req as any).file` ([routes/ingredients-import.ts:93,165](routes/ingredients-import.ts)).
- **Why it matters**: Forces `as any` in places that wouldn't need it. Catches no type errors that proper types would.
- **Suggested fix**: `npm install --save-dev @types/multer`. Remove the shim. Replace the `(req as any)` casts with `(req as Request & { file?: Express.Multer.File })` or use the proper Multer-augmented Request type.
- **Confidence**: High.

### D12 — `dotenv` loaded at top of multiple entry points with try/catch
- **Severity**: Nit
- **Location**: [server.ts:5](server.ts), [test/setup-env.ts:16](test/setup-env.ts), [playwright.config.ts:9](playwright.config.ts), [routes/api.test.ts:1](test/api.test.ts).
- **What**: Each entry guards `require('dotenv').config()` in try/catch with comment "dotenv optional in production." Production-deployed Node 20+ supports `node --env-file=.env` natively, so dotenv could be dropped entirely.
- **Why it matters**: One less dep to manage. Minor cleanup.
- **Suggested fix**: Either keep dotenv (no urgent reason to drop) or remove it and use the native flag in dev. Production doesn't have a `.env` file (env vars come from Railway), so the production code path doesn't need dotenv.
- **Confidence**: High.

### D13 — Railway start command runs `prisma migrate deploy` on every deploy
- **Severity**: (Positive)
- **Location**: [railway.toml:2](railway.toml).
- **What**: `startCommand = "npx prisma migrate deploy && NODE_ENV=production node dist/server/server.js"`.
- **Why it matters**: Migrations run automatically. Forward-only by Prisma's design. Combined with the migrations directory pattern, this is the right shape.
- **Suggested fix**: None.
- **Confidence**: High.

### D14 — `railpack.json` lists 16 apt packages for Playwright/Chromium
- **Severity**: Low (operational)
- **Location**: [railpack.json](railpack.json).
- **What**: 16 lib packages installed at deploy time so Chromium has its system deps. Each apt install adds time and attack surface (these are runtime packages on the production container).
- **Why it matters**: Playwright is needed only for Tebi sync. The whole production container carries it for one cron job. If Tebi sync moves to a different host (separate worker dyno), the prod container shrinks dramatically.
- **Suggested fix**: 
  1. Long-term: move the Tebi scraper to a Railway "worker" service with its own image. Main app image drops Playwright entirely.
  2. Short-term: list specifically which of the 16 are actually needed (Chromium docs aren't always up to date). Often `libnspr4`, `libnss3`, `libxcomposite1`, etc. are the actual minimum.
- **Confidence**: Medium.

## Patterns & themes

- **The repo treats deps reasonably well** — most are at or near current. The exceptions are concentrated: `xlsx` (frozen by SheetJS's CDN move), `googleapis` (legacy), `@anthropic-ai/sdk` (single minor behind a security advisory).
- **The lockfile-gitignored decision is the single largest reliability issue in this domain**. It cascades: no npm ci, no audit reproducibility, no Renovate / Dependabot path that works cleanly. Fixing this unblocks everything else.
- **CI compensates for missing lockfile by running `npm install` everywhere**. The two CI workflows have nearly-identical comments explaining the workaround. That's institutional friction worth removing.
- **Postinstall heaviness (Playwright Chromium) is felt by every contributor**. Local devs who don't need Tebi sync still pay for it. This kind of friction nudges contributors away from running `npm install` from scratch — they end up running `npm install --ignore-scripts` and then forgetting that `prisma generate` didn't run.
- **`@types/multer` shim and `(req as any).file` casts** are the kind of small symptoms that come from "we'll get to it later." Easy to fix; valuable to fix because the cast hides the actual `multer` typing surface.

## What looked good

- **Stack choices are conservative and current**: TypeScript 6, Node 20+, Vite 8, Express 4 (4.22.x), Prisma 6.19. No "cutting edge" risks, no decade-old artifacts.
- **`engines.node >= 20.19.0`** picks up native fetch, AbortSignal.timeout, etc. — all of which the codebase uses. Not pinned to ancient Node.
- **`@swc/jest` over `ts-jest`** ([package.json:43](package.json)) — much faster test runs, well-maintained.
- **Build is two simple commands** ([package.json:10](package.json)) — Vite handles the client, tsc handles the server. No webpack, no rollup config drift.
- **Railway config is one TOML line + one JSON file**. Compare to the 200-line CI configs that some teams ship. Right-sized.
- **`prisma migrate deploy` baked into the start command** — migrations apply atomically per deploy, no extra ops.
- **CI workflows include explanatory comments** — `pr-tests.yml`'s comment about lockfile is informative even if the underlying decision is questionable.
- **Tests run typecheck → jest → playwright in sequence** — fail-fast, clear stages.
- **Major-version pinning (`~`) on critical deps** (`@swc/jest ~0.2.39`, `cross-env ~10.1.0`, `vite ~8.0.3`) — limits unexpected breaking changes within a minor.

---

## Round 2 — deeper findings

### D15 — `tebi-error.png` and other PNG outputs not gitignored
- **Severity**: Low
- **Location**: [.gitignore](.gitignore), [scripts/tebi-scraper.js:591](scripts/tebi-scraper.js).
- **What**: The Tebi scraper writes `tebi-error.png` to cwd on failure. `.gitignore` doesn't list `*.png`. A contributor running the scraper locally could `git add .` and accidentally commit a screenshot containing Tebi backoffice UI (with email visible in nav).
- **Why it matters**: Low blast radius. Cosmetic + minor PII concern.
- **Suggested fix**: Add `tebi-error*.png` to `.gitignore`. Move the path to `/tmp/...` in the scraper.
- **Confidence**: High.

### D16 — `prisma/archive/` scripts still in repo, with destructive operations referencing dropped models
- **Severity**: Low (cross-ref A22, S21)
- **Location**: [prisma/archive/](prisma/archive/).
- **What**: Two archive scripts (`import-xlsx.js`, `migrate-from-sheets.js`) reference `prisma.dish` and `prisma.service` — models that no longer exist. They throw on first call. Today this means the scripts are inert. If a future schema change reintroduces those models, the scripts would suddenly run and wipe most production tables.
- **Why it matters**: Latent landmine; cleanup-vs-history trade-off.
- **Suggested fix**: Delete the archive scripts. Git keeps the history if anyone needs to look. Or add explicit `--i-really-want-this` arg-check at top. See A22 for full discussion.
- **Confidence**: High.
