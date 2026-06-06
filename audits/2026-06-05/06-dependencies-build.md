# Dependencies & Build

## Scope of review

This pass audited dependency hygiene and the build/install pipeline: the missing lockfile, vulnerable pinned versions (DOMPurify, vite, prisma), the CDN-sourced `xlsx`, the absent vulnerability gate, Node-version pinning, and the Chromium download cost. Findings are sorted by adjusted severity.

> **Note (2026-06-05 lockfile regeneration):** Committing a freshly generated `package-lock.json` (DEP-1) resolved the **DEP-5 (vite)** and **DEP-9 (prisma)** High advisories as a side effect — the in-range fixed versions were pulled in when the tree was re-resolved. `npm audit` is now clean of High/Critical; only **4 moderate** advisories remain, all from the `googleapis → uuid` chain (**DEP-6**), which needs a breaking `googleapis` major bump and is deferred.

## Findings

### DEP-1 — package-lock.json still gitignored — no reproducible installs, and it now actively freezes vulnerable versions

**STATUS: FIXED 2026-06-05 — generated `package-lock.json`, removed it from `.gitignore`, switched `.github/workflows/pr-tests.yml` and `weekly-coverage.yml` to `npm ci` + `cache: 'npm'`. `npm ci --dry-run` validated.**

- **Severity**: High (adjusted from Critical)
- **Location**: .gitignore:2 (also .github/workflows/pr-tests.yml:35-37, weekly-coverage.yml:41-46)
- **What**: package-lock.json is listed in .gitignore line 2 and is untracked (git ls-files returns nothing; git check-ignore confirms .gitignore:2), so CI and Railway run `npm install` (not `npm ci`) and resolve all semver ranges fresh on every build.
- **Why it matters**: Two consecutive deploys from the same git SHA can produce different dependency trees; CI's green signal is built against a different tree than prod ships. Concretely it now causes security drift in BOTH directions: the untracked local lockfile freezes dompurify at the vulnerable 3.4.4 and vite at 8.0.4 even though the declared ranges already allow the fixed 3.4.5/8.0.5, while CI/Railway fresh-resolves could silently pick up a breaking transitive patch. This is the prior audit's D1 (Critical) and remains fully open 189 commits later.
- **Suggested fix**: Commit package-lock.json (it already exists locally with correct integrity hashes), remove it from .gitignore, switch CI `npm install`→`npm ci` and re-enable `cache: 'npm'`, and document 'commit lockfile changes when deps change' in CLAUDE.md.
- **Confidence**: High.
- **Verified**:

  .gitignore line 2: `package-lock.json`

  git check-ignore confirms: `.gitignore:2:package-lock.json  package-lock.json`
  git ls-files returns nothing (untracked, not committed).
  The file does not exist in the worktree at all.

  pr-tests.yml line 35: `# No cache: 'npm' — package-lock.json is gitignored in this repo.`
  pr-tests.yml line 37: `- run: npm install`

  weekly-coverage.yml lines 41-46:
  ```
  # No `cache: 'npm'` — package-lock.json is gitignored in this repo,
  # and the action errors out when it can't find a lock file.
  # `npm install` (not `npm ci`) for the same reason — `npm ci` requires
  # a committed lock file. Slower by ~10s but reliable.
  - run: npm install
  ```
- **Reviewer notes**:

  The core finding is fully confirmed: package-lock.json is gitignored at line 2, not tracked, CI uses `npm install` instead of `npm ci`, and the CI workflow files themselves document this as the reason (two separate comments). Every build resolves semver ranges fresh, making builds non-reproducible.

  The specific sub-claim about dompurify@3.4.4 and vite@8.0.4 being "frozen at vulnerable versions" cannot be verified — the lockfile does not exist in this worktree (or on disk). That part of the claim appears to reference a developer-local lockfile on a different machine. The non-reproducibility risk (CI may resolve different versions than production Railway builds) is real. Severity is adjusted from Critical to High because: (1) the "frozen vulnerable version" claim is unverifiable and internally inconsistent with "lockfile doesn't exist"; (2) non-reproducible builds are a genuine reliability/security risk but not an active confirmed exploit. The fix remains correct: commit the lockfile, remove from .gitignore, switch to `npm ci`.

### DEP-2 — DOMPurify (the Notion-markdown XSS sanitizer) is pinned at 3.4.4, which has a known High XSS-bypass advisory fixed in 3.4.5

**STATUS: FIXED 2026-06-05 — dompurify bumped `^3.4.3` → `^3.4.8` in `package.json` and pinned in the lockfile; `npm audit` now reports 0 high/critical.**

- **Severity**: High (adjusted from Medium)
- **Location**: public/js/competencies.ts:318 (sanitizer); installed dompurify 3.4.4; package.json:37 declares ^3.4.3
- **What**: npm audit reports dompurify 3.4.4 carries High advisory GHSA-87xg-pxx2-7hvx (XSS via selectedcontent re-clone, fixed in 3.4.5), and competencies.ts:318 `DOMPurify.sanitize(marked.parse(md))` is the only barrier between externally-editable Notion guide HTML and innerHTML — verified that marked passes raw <script> through unsanitised.
- **Why it matters**: Competency chunk guides sync one-way from a Notion workspace (lib/notion-sync.ts) and render into innerHTML for all staff; the sanitizer sitting one patch behind a published bypass degrades the only stored-XSS defense on that path. The fix (3.4.5) is already inside the declared ^3.4.3 range — it is unapplied only because the gitignored lockfile (DEP-1) freezes 3.4.4.
- **Suggested fix**: Bump dompurify to ^3.4.8 (or run `npm audit fix`), commit the lockfile so the fixed version is pinned for CI/prod, and add an e2e/unit assertion that a `<script>`/`<img onerror>` in chunk markdown is stripped by mdToHtml.
- **Confidence**: High.
- **Verified**: package-lock.json pins dompurify at exactly 3.4.4 ("version": "3.4.4", "range": "=3.4.4"). npm audit confirms GHSA-87xg-pxx2-7hvx (High, CVSS 8.2, CWE-79 — "DOMPurify XSS via selectedcontent re-clone") affecting exactly this version. The sanitizer at competencies.ts:318 is `return DOMPurify.sanitize(marked.parse(md) as string);` — the sole XSS barrier for Notion-sourced teachingGuide markdown that flows directly into el.innerHTML at line 139 via buildChunkHtml → renderTeachingGuide → mdToHtml. Versions 3.4.5 through 3.4.8 are published and within the ^3.4.3 declared range; only the frozen lockfile prevents the fix from being installed.
- **Reviewer notes**: The severity claim of "Medium" in the finding is understated — npm audit rates this High (CVSS 8.2). The exploit path is concrete: an attacker with Notion workspace edit access can inject a payload into a teaching guide chunk, which syncs into the DB via lib/notion-sync.ts and then renders unsanitised to all staff who view that competency chunk. The only barrier is DOMPurify 3.4.4, which is exactly the version carrying the selectedcontent re-clone bypass. Fix: run `npm audit fix` (or explicitly bump to ^3.4.8) and commit the updated lockfile.

### DEP-3 — No automated dependency-vulnerability gate (no Dependabot/Renovate, no `npm audit` in CI) — 15 advisories including a fixable XSS go unsurfaced

- **Severity**: Medium
- **Location**: .github/ (no dependabot.yml, no renovate.json, no audit step in any of pr-tests.yml/weekly-coverage.yml/sync-staging.yml)
- **What**: There is no .github/dependabot.yml, no renovate config, and no `npm audit` step in any workflow, while `npm audit` on the current tree reports 15 advisories (7 high) — several (dompurify→3.4.5, vite→8.0.5, express→4.22.2) fixable within the already-declared semver ranges.
- **Why it matters**: Combined with the gitignored lockfile, nothing in the pipeline ever notices when a dependency ships a security fix or a CVE lands; the dompurify XSS fix has been available and in-range yet remains unapplied. The team has no signal to act on, so 'safe version X' can never be asserted or enforced.
- **Suggested fix**: Add a `.github/dependabot.yml` (npm ecosystem, weekly) once the lockfile is committed, and/or add a non-blocking `npm audit --omit=dev --audit-level=high` step to pr-tests.yml so new high-severity advisories are visible on PRs.
- **Confidence**: High.
- **Verified**:

  1. `.github/` contains only a `workflows/` subdirectory — no `dependabot.yml` and no `renovate.json` anywhere in the tree.

  2. `pr-tests.yml` (lines 30–49) — the full CI test job — has steps for checkout, setup-node, `npm install`, typecheck, Jest, and Playwright, but no `npm audit` step at all.

  3. `weekly-coverage.yml` and `sync-staging.yml` likewise contain no audit step.

  4. `.gitignore` explicitly contains `package-lock.json`, confirmed by grep. `pr-tests.yml` line 35 documents this explicitly: `# No cache: 'npm' — package-lock.json is gitignored in this repo.`

  All three claims in the finding are true in the current code: no dependabot.yml, no renovate config, no npm audit step in any workflow, and the lockfile is gitignored.
- **Reviewer notes**: The finding is accurate. Severity Medium is appropriate rather than High: (a) the practical exploitability of the dompurify XSS advisory depends on where sanitization is applied and what untrusted input reaches it; (b) without a committed lockfile, even adding Dependabot would have limited effect — a lockfile commit would be the prerequisite before automated dependency PRs become reliable. The finding's proposed fix (add dependabot.yml once lockfile is committed + non-blocking npm audit step in pr-tests.yml) is reasonable and correctly scoped.

### DEP-4 — xlsx is installed from a third-party CDN URL with no committed lockfile, so CI/Railway installs verify no integrity hash

- **Severity**: Medium
- **Location**: package.json:48 ("xlsx": "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz")
- **What**: xlsx is a direct URL dependency on cdn.sheetjs.com, and because package-lock.json is gitignored, CI and Railway have no lockfile and therefore install the tarball with no SRI/integrity check (the integrity hash exists only in the untracked local lockfile).
- **Why it matters**: URL dependencies bypass the npm registry's own integrity records, so without a committed lockfile a compromised or swapped CDN tarball installs straight into the production server (which parses attacker-supplied XLSX uploads) with zero verification — a concrete supply-chain hole that registry deps don't have. This is the natural worsening of the prior D2 'CDN move' note now that the pin is a raw URL.
- **Suggested fix**: Commit the lockfile (captures the sha512 integrity already present locally) so the CDN tarball is integrity-verified everywhere; alternatively vendor the tgz into the repo or migrate the single consumer (routes/ingredients-import.ts) to registry-distributed exceljs.
- **Confidence**: High.
- **Verified**:

  package.json line 48: "xlsx": "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"

  .gitignore line 2: package-lock.json  (lockfile explicitly gitignored)

  Local package-lock.json (present on disk but not committed) does contain the integrity hash:
    "node_modules/xlsx": {
      "version": "0.20.3",
      "resolved": "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz",
      "integrity": "sha512-oLDq3jw7AcLqKWH2AhCpVTZl8mf6X2YReP+Neh0SJUzV/BdZYjth94tG5toiMB1PPrYtxOCfaoUCkvtuH+3AJA=="
    }
  Because the lockfile is gitignored, CI (pr-tests.yml / weekly-coverage.yml) and Railway receive no lockfile, so npm re-downloads the tarball from cdn.sheetjs.com without any integrity verification on every install.
- **Reviewer notes**: The claim is literally true. The xlsx package is a URL dependency pointing at a third-party CDN, and package-lock.json is gitignored, meaning the sha512 integrity hash that npm computes locally is never committed. Every CI run and every Railway deploy fetches the tarball with no integrity check. The severity of Medium is appropriate: the attack requires compromising cdn.sheetjs.com or an in-path MITM, which is not trivial, but the consequence is that attacker-supplied code would parse untrusted XLSX uploads on the production server (routes/ingredients-import.ts). There is no mitigation in the codebase. The proposed fix (commit the lockfile, or vendor the tgz, or migrate to an npm-registry package) is correct.

### DEP-5 — vite 8.0.4 carries a High advisory fixed in 8.0.5 (within the declared ~8.0.3 range) but frozen by the lockfile

**STATUS: FIXED 2026-06-05 — resolved as a side effect of regenerating + committing the lockfile (DEP-1); the in-range fixed vite is now pinned and `npm audit` reports no High/Critical.**

- **Severity**: Medium (adjusted from Low)
- **Location**: package.json:90 (vite ~8.0.3); installed 8.0.4
- **What**: npm audit reports vite 8.0.0-8.0.4 as High with fixAvailable:true, and the fixed 8.0.5+ is inside the declared `~8.0.3` (>=8.0.3 <8.1.0) range, so only the gitignored lockfile keeps the build/dev toolchain on the vulnerable 8.0.4.
- **Why it matters**: Vite is a build/dev dependency (lower blast radius than runtime), but the dev server / build pipeline is exactly where a Vite advisory bites contributors and CI; like DEP-2 the fix is a no-op re-resolve blocked only by the frozen lockfile.
- **Suggested fix**: After committing the lockfile, run `npm update vite` (or `npm audit fix`) to move to 8.0.16 within range and pin it.
- **Confidence**: High.
- **Verified**: package.json line 90: `"vite": "~8.0.3"`. Main repo lockfile (`package-lock.json`, gitignored per .gitignore) pins `"node_modules/vite": { "version": "8.0.3" }`. Actually installed: 8.0.3. npm audit confirms three real advisories for vite 8.0.0-8.0.4: GHSA-v2wj-q39q-566r (High, `server.fs.deny` bypass), GHSA-p9ff-h696-f583 (High, arbitrary file read via WebSocket), GHSA-4w7w-66w2-5vf9 (Moderate, path traversal in optimized deps .map). fixAvailable: true. Versions 8.0.5-8.0.16 exist on npm, all within the `~8.0.3` constraint. Minor factual error in finding: claims installed version is 8.0.4, but lockfile and node_modules both show 8.0.3 — still in the vulnerable range.
- **Reviewer notes**: The vulnerability is real and unmitigated. The finding's version number is slightly wrong (8.0.3 installed, not 8.0.4) but this does not affect validity since 8.0.3 is also in the affected range. The fix mechanism is correct: deleting/updating the gitignored lockfile and running npm install or npm update vite would resolve to 8.0.16 within the declared range. Severity adjusted from Low to Medium because two of the three advisories are classified High by npm audit: they allow arbitrary file read via the dev server WebSocket and fs.deny bypass — real impact on any developer running `npm run dev` on a shared or network-accessible machine. Still dev-only (not a production runtime risk), hence not High overall.

### DEP-6 — googleapis is 43 majors behind (128 vs 173) and drags in a moderate-CVE transitive uuid for a legacy-only code path

- **Severity**: Low
- **Location**: package.json:41 (googleapis ^128.0.0); used only by lib/recipe-sheets.ts
- **What**: Installed googleapis is 128.0.0 (latest 173.x), npm audit flags its transitive uuid (<11.1.1, GHSA-w5hq-g745-h8pq, moderate) with the only fix being a semver-major bump to googleapis@173, and the dependency is used solely by the legacy Google Sheets recipe importer.
- **Why it matters**: 43-major drift makes the eventual bump painful and keeps a (mild) transitive CVE on the tree for a path CLAUDE.md already calls 'legacy recipe import only'; carrying a heavy, stale dep for a sunset feature is pure liability. This is the prior D4, still open.
- **Suggested fix**: Confirm whether the Sheets import is still used; if not, delete lib/recipe-sheets.ts + the /api/recipe route and drop googleapis (and google-auth-library if unused elsewhere); otherwise schedule the googleapis@173 major bump in its own PR.
- **Confidence**: High.
- **Verified**: package.json line 41: "googleapis": "^128.0.0". Lock file resolves to 128.0.0 (exact), confirmed 43+ majors behind 173.x. Transitive chain: googleapis -> gaxios@6.7.1 -> uuid@^9.0.1, resolved as uuid@9.0.1 (line 7933 of package-lock.json) — inside the GHSA-w5hq-g745-h8pq vulnerable range (<11.1.1). lib/recipe-sheets.ts is the only file importing from 'googleapis'. getSheetsClient() is called in two active routes in routes/recipes.ts: GET /api/recipe (line 28) and POST /api/recipes/import-cooked-amounts (line 218), both mounted via app.use('/api', recipesRouter) in app.ts. google-auth-library is used independently by routes/auth.ts (OAuth2Client) so removing googleapis would not drop that dep.
- **Reviewer notes**: The finding is accurate. The dependency is not dead code — two live HTTP endpoints call getSheetsClient(), though both return 503 when GOOGLE_CREDENTIALS is unset, limiting practical exposure. The "solely used by legacy recipe importer" framing in the claim is directionally correct (both call sites are Sheets-import paths) even if slightly imprecise. Severity Low is right: the uuid CVE is moderate severity and the routes have a graceful fallback when credentials are absent. The fix options stated in the finding are valid: either bump googleapis to 173.x (own PR) or, if the Sheets import is truly no longer needed, delete recipe-sheets.ts and the two endpoints in routes/recipes.ts (GET /api/recipe and POST /api/recipes/import-cooked-amounts), then drop googleapis from package.json. google-auth-library must stay regardless, as routes/auth.ts depends on it for Google Sign-In.

### DEP-7 — Node version is not pinned end-to-end (no .nvmrc/.node-version; CI floats on '20'; railpack uses its default)

- **Severity**: Low
- **Location**: package.json:73-75 (engines >=20.19.0); .github/workflows/pr-tests.yml:34 & weekly-coverage.yml:40 (node-version: '20'); no .nvmrc/railpack node pin
- **What**: There is no .nvmrc or .node-version file, both CI workflows specify only the floating major `node-version: '20'`, railpack.json pins no Node version, and package.json only sets a lower bound (>=20.19.0) — so dev/CI/prod Node minors can diverge silently.
- **Why it matters**: A breaking Node 20.x patch (rare but it happens) would land in CI or prod with no single source of truth to roll back to, and contributors run whatever local Node they happen to have. Prior audit D7, still open.
- **Suggested fix**: Add a `.nvmrc` (e.g. `20.19.0`), point both workflows at `node-version-file: '.nvmrc'`, and set the same value in railpack/Railway config.
- **Confidence**: Medium.
- **Verified**: package.json:73-74: "engines": { "node": ">=20.19.0" } — lower bound only, no pin. .github/workflows/pr-tests.yml:34: node-version: '20' (floating major). .github/workflows/weekly-coverage.yml:40: node-version: '20' (floating major). railpack.json contains only aptPackages under "deploy" — no Node version key at all. No .nvmrc or .node-version file found in the project root.
- **Reviewer notes**: All four parts of the claim are literally true in the current code. Dev, CI, and prod can silently diverge on Node 20.x minors. Severity Low is appropriate: within-major Node regressions are rare, the lower-bound engine field prevents grossly old versions locally, and no active breakage is implied. The proposed fix (add .nvmrc pinning a specific 20.x patch, point both workflows at node-version-file: '.nvmrc', add the same value to railpack.json) is reasonable and low-effort.

### DEP-8 — postinstall downloads ~300MB Chromium on every install and CI re-downloads it a second time with no browser cache

- **Severity**: Low
- **Location**: package.json:12 (postinstall) + .github/workflows/pr-tests.yml:45-46 and weekly-coverage.yml:48-49 (second `npx playwright install`)
- **What**: The postinstall script runs `playwright install --with-deps chromium` on every `npm install`, and both CI workflows then run `npx playwright install --with-deps chromium` again with no `actions/cache` for ~/.cache/ms-playwright, so each CI run downloads Chromium twice.
- **Why it matters**: Every contributor and every CI run pays a ~30-60s+ Chromium download (twice in CI), slowing the feedback loop and nudging people toward `npm install --ignore-scripts` (which then skips `prisma generate`). Prior audit D6, still open.
- **Suggested fix**: Move the Playwright install out of postinstall into a dedicated script invoked explicitly by CI/prod, and add `actions/cache@v4` keyed on the Playwright version for `~/.cache/ms-playwright` to eliminate the re-download.
- **Confidence**: High.
- **Verified**:

  package.json line 12: "postinstall": "prisma generate && cross-env PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install --with-deps chromium"

  pr-tests.yml lines 37+45-46:
    - run: npm install        # triggers postinstall → installs to PLAYWRIGHT_BROWSERS_PATH=0 (project-local)
    - name: Install Playwright browsers
      run: npx playwright install --with-deps chromium   # second install, no PLAYWRIGHT_BROWSERS_PATH=0, installs to ~/.cache/ms-playwright

  weekly-coverage.yml lines 46+48-49:
    - run: npm install        # same postinstall
    - name: Install Playwright browsers
      run: npx playwright install --with-deps chromium   # second install again

  Neither workflow contains an actions/cache step for any Playwright browser path.
- **Reviewer notes**: The finding is real and the code matches the claim exactly. One nuance: the postinstall uses PLAYWRIGHT_BROWSERS_PATH=0 (installs to node_modules/.cache/ms-playwright) while the explicit CI step omits that env var (installs to ~/.cache/ms-playwright by default). So each CI run downloads Chromium to two different directories rather than the same directory twice. The net result is still two ~300MB downloads per CI run with no caching, which matches the spirit of the finding. Severity Low is appropriate — it slows CI by ~30-60s per run but does not break anything.

### DEP-9 — Prisma 6.19.2 (in `dependencies`) pulls a High-advisory effect/@prisma/config chain into the production install

**STATUS: FIXED 2026-06-05 — resolved as a side effect of regenerating + committing the lockfile (DEP-1); the effect/@prisma/config chain re-resolved above the advisory range and `npm audit` reports no High/Critical.**

- **Severity**: Low
- **Location**: package.json:47 (prisma ~6.19.2, in dependencies); transitive @prisma/config→effect
- **What**: npm audit flags prisma 6.19.2 → @prisma/config → effect (<3.20.0) as High (GHSA-38f7-945m-qr2g), and `prisma` (the CLI) is declared in `dependencies` (not devDependencies) so it and its vulnerable chain ship in the production install used by `npx prisma migrate deploy`.
- **Why it matters**: Real-world impact is low (the effect AsyncLocalStorage bug needs concurrent RPC load and migrations run serially at deploy), but it inflates the prod dependency surface and is persistent npm-audit noise that trains the team to ignore audits; the fix is a Prisma bump beyond 6.19.x. Adjacent to prior D5.
- **Suggested fix**: Plan a Prisma 6→7 (or latest 6.x that resolves the effect chain) refresh in a dedicated PR with a full test run; keep `prisma` in dependencies only if Railway's deploy step truly needs it, otherwise move to devDependencies and run migrations via a prebuilt step.
- **Confidence**: Medium.
- **Verified**: package.json line 47: `"prisma": "~6.19.2"` is in `dependencies` (not devDependencies). The lockfile confirms installed versions: prisma@6.19.2, @prisma/config@6.19.2, effect@3.18.4. npm audit reports: `effect` severity "high", GHSA-38f7-945m-qr2g, range `<3.20.0`, with effect chain `effect → @prisma/config → prisma`. The `prisma` entry shows: `"severity": "high", "isDirect": true, "via": ["@prisma/config"]`. The claimed severity of Low (not High) is appropriate because the underlying effect vulnerability requires concurrent RPC load — migrations run serially at deploy time, so real-world exploitability is negligible. The audit noise and inflated prod surface concern is real but the impact is low.
- **Reviewer notes**: The finding is accurate in every detail: version, location, advisory ID (GHSA-38f7-945m-qr2g), and the fact that prisma is in dependencies rather than devDependencies. The severity calibration of Low (downgraded from the npm audit High) is appropriate given the exploit requires concurrent RPC load that doesn't apply to the serial migration execution context.
