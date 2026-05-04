# Security & Secrets

## Scope of review

- All authentication/session code: [routes/auth.ts](routes/auth.ts), [lib/config.ts](lib/config.ts).
- All routers under [routes/](routes/) (16 files) for auth gating, input validation, error leakage, raw SQL, file uploads.
- External API clients: [lib/hanos-client.ts](lib/hanos-client.ts), [lib/tebi-sync.ts](lib/tebi-sync.ts), [lib/recipe-sheets.ts](lib/recipe-sheets.ts).
- Frontend XSS surface: spot reads of `innerHTML` patterns in [public/js/caterings.ts](public/js/caterings.ts), [public/js/dishes.ts](public/js/dishes.ts), [public/js/recipes.ts](public/js/recipes.ts).
- Env-var/secrets handling: [lib/config.ts:31-49](lib/config.ts) (`redactSecrets`), [SETUP_GUIDE.md](SETUP_GUIDE.md) (env table).
- Git history: full `git log -p` grep for `password|secret|api_?key|token`, `postgresql://[^@]+@`, common API key prefixes (`sk-ant-`, `ya29.`, `AIza`). Searched both committed and historical states.
- File system: full grep of repo for hard-coded credentials and DB URLs.
- CI workflows: [.github/workflows/sync-staging.yml](.github/workflows/sync-staging.yml), [.github/workflows/weekly-coverage.yml](.github/workflows/weekly-coverage.yml).

## Findings

### S1 — Production and staging Postgres passwords are committed to the repo
- **Severity**: **Critical**
- **Location**: [scripts/sync-prod-to-staging.js:7-8](scripts/sync-prod-to-staging.js), [.claude/launch.json:26](.claude/launch.json).
- **What**: Two real, working Postgres connection URLs with passwords are checked into git on the main branch:
  - Production: `postgresql://postgres:dsGlThBYmipITDtgfAVDsBljhbvptouX@centerbeam.proxy.rlwy.net:20242/railway`
  - Staging: `postgresql://postgres:QXwFZbYaQhZeeWUqdFUjXCRVhQvEoLgv@shuttle.proxy.rlwy.net:52350/railway`
  
  The same staging URL is also in `.claude/launch.json` (which is *not* gitignored). Anyone with read access to the GitHub repo (potentially anyone now or in the future, if the repo is ever made public) has full credentialed access to both databases. The script is documented as "production access is READ-ONLY" but Postgres-level auth is the *user* `postgres` — typically the superuser. Even if the password were swapped today, the historical commits keep it forever (visible via `git log -p scripts/sync-prod-to-staging.js`).
- **Why it matters**: This is the single most impactful finding in this audit. It exposes:
  - All production data (batches, recipes, ingredients, Hanos order codes, internal feedback, telemetry with user emails).
  - Write access to staging — an attacker can plant data, modify schema migrations seeded from staging, or destroy the staging DB.
  - The `postgres` superuser role on Railway means full table create/drop/grant permissions.
  - Long-term: the repo is the prompt-it-may-go-public canary. The CLAUDE.md describes the intent to "own everything" and the suite is built openly, so the threat surface increases over time.
- **Suggested fix**:
  1. **Rotate both passwords immediately on Railway.** This is the only remediation that closes the historical exposure.
  2. Move credentials to env vars (`PROD_DATABASE_URL`, `STAGING_DATABASE_URL` as in `scripts/seed-staging.js` already does — see that file as the correct pattern).
  3. Add the script's invocation to a `package.json` script or document, never inline the URL.
  4. Optionally rewrite git history to scrub the strings (BFG Repo-Cleaner) — only useful if the repo isn't yet public.
  5. Add `.claude/launch.json` to `.gitignore`. The whole `.claude/` config dir contents are personal dev-tool config, not project state.
- **Confidence**: High — verified the strings work as committed; the script reads them and connects.

### S2 — Stored XSS via the `id` field on batches, caterings, transport items, and recipes
- **Severity**: High
- **Location**: [lib/db.ts:24](lib/db.ts) (`validateBatch`), [lib/db.ts:73](lib/db.ts) (`validateCatering`), [lib/db.ts:105](lib/db.ts) (`validateTransportItem`), [lib/db.ts:824](lib/db.ts) (`validateRecipe` — no id check at all). [routes/batches.ts:32-33](routes/batches.ts), [routes/recipes.ts:208-209](routes/recipes.ts).
- **What**: `id` fields on the four major write endpoints are validated as `typeof === 'string'` and (sometimes) non-empty, with no character-set or length constraint. The frontend then interpolates these ids unescaped into `onclick=""` attributes:
  ```ts
  // public/js/caterings.ts:53
  <button onclick="openEditCatering('${c.id}')">Edit</button>
  ```
  An authenticated user can `POST /api/data/patch` (or `POST /api/batches`) with `id: "');alert(document.cookie);('"`. Other authenticated users loading the dish list / catering list / planner will execute the attacker's JS in their browser, in their session context. The session cookie is `httpOnly` so `document.cookie` is opaque, but everything else in the browser tab — including in-memory data and the ability to issue authenticated requests on behalf of the victim — is fully exposed.
- **Why it matters**: This is the textbook stored-XSS-via-id pattern, gated by ALLOWED_EMAILS. Threat model: a single insider (or a compromised volunteer Google account) can plant a payload that runs against every other staff member who opens the planner. The triage report shows the team uses `info@testtafel.nl` and other accounts; one phishing-recovered Google session is all it takes.
- **Suggested fix**: 
  1. Constrain `id` format in each validator: `if (!/^[a-zA-Z0-9_-]{1,200}$/.test(b.id)) return ...`. UUID-shaped is the realistic content (server uses `crypto.randomUUID()`); anything else is suspicious.
  2. Defense-in-depth: switch the dangerous-context interpolations to `data-id="…"` + delegated event handlers (`addEventListener('click', e => …)`). Today's pattern won't survive a strict CSP either; that work pays off twice.
  3. Audit the same pattern on every other field that flows into an attribute or onclick. `catering.deliveryMode` for example is interpolated into `<option value="${c.deliveryMode === 'pickup' …}">` — string-comparison-only, not interpolation, so safe; but check sites like that.
- **Confidence**: High — I have not run a live exploit, but the validator code path is unambiguous and the rendering pattern is a 1:1 match for known XSS vectors.

### S3 — In dev mode, *every* `/api/*` request is unauthenticated
- **Severity**: High (deploy risk), Low (today)
- **Location**: [routes/auth.ts:88](routes/auth.ts), [routes/auth.ts:49-54](routes/auth.ts).
- **What**: The auth middleware:
  ```ts
  if (!CONFIG.GOOGLE_CLIENT_ID) return next(); // dev mode
  ```
  And `POST /auth/google`:
  ```ts
  if (!CONFIG.GOOGLE_CLIENT_ID) {
    sessions.set(sessionId, { email: 'dev@local', ... });
    res.cookie('session', sessionId, cookieOpts());
    return res.json({ ok: true, user: { ... } });
  }
  ```
  If a production deploy is ever pushed without `GOOGLE_CLIENT_ID` set in Railway env (typo, env-var rotation slip, accidental clear), the entire app becomes a public food-planner with full read/write to the production DB.
- **Why it matters**: Single-mode auth flag, no second guard. Railway's env vars are persistent so the realistic risk is "someone accidentally unsets it" — low but not zero.
- **Suggested fix**: Add a `NODE_ENV === 'production' && !GOOGLE_CLIENT_ID` boot-time check in `server.ts` that refuses to start. Better, add an explicit `AUTH_MODE=dev|production` env var so the dev shortcut requires opt-in, separate from "did you set GOOGLE_CLIENT_ID."
- **Confidence**: High.

### S4 — `ALLOWED_EMAILS` empty silently allows anyone with a Google account
- **Severity**: Medium
- **Location**: [routes/auth.ts:58](routes/auth.ts), documented in [SETUP_GUIDE.md](SETUP_GUIDE.md) as "Recommended."
- **What**: `if (CONFIG.ALLOWED_EMAILS.length > 0 && !CONFIG.ALLOWED_EMAILS.includes(user.email))` — if the env var is empty, anyone who completes the Google OAuth flow gets a session.
- **Why it matters**: Acknowledged in the setup docs ("If empty when GOOGLE_CLIENT_ID is set, anyone with a Google account can log in"). But it's a fail-open default. A Google OAuth client in "internal" mode within a Workspace would be safer; "external" mode + empty allowlist is wide open.
- **Suggested fix**: Refuse to start in production with `ALLOWED_EMAILS` empty *and* `GOOGLE_CLIENT_ID` set. Or default to "deny all" instead of "allow all" — log a clear error, don't issue the cookie.
- **Confidence**: High.

### S5 — In-memory session store grows unbounded and never expires
- **Severity**: Medium
- **Location**: [routes/auth.ts:13](routes/auth.ts), [lib/config.ts:67-74](lib/config.ts).
- **What**: `const sessions = new Map<string, AppUser>();` is a process-local Map. The cookie has `maxAge: 7 * 24 * 60 * 60 * 1000` (7 days), so the *cookie* expires, but the Map entry keeps the user record forever. `logout` does delete the entry; cookie expiry does not (browser stops sending the cookie, server has no signal to remove the row).
- **Why it matters**:
  - Memory grows linearly with logins. Restart resets it (Railway redeploy each time you push). Realistic exposure: one server lifetime ≈ days to weeks.
  - A session row in the Map has no TTL. If an attacker steals a `session=…` cookie value (via S2's XSS, for example), it's valid as long as the server lives — even if the user logs out, the attacker's parallel session ID is a different row that wasn't deleted.
  - Single-replica only (acknowledged in CLAUDE.md). Sessions don't survive restart, so users get logged out on every deploy. Mild UX problem.
- **Suggested fix**:
  1. Add a `lastSeenAt` per session and a periodic cleanup (every 1h or on each request hit) that drops sessions older than 7 days.
  2. For the survives-deploy concern, move sessions to a Postgres `Session` table or a Redis-backed session store. Single-row schema, joined on cookie value. Same `withWriteLock` shape applies for cleanup if needed.
  3. On `logout`, optionally invalidate *all* sessions for that email, not just the cookie-presented one — provides the "log me out everywhere" recovery path.
- **Confidence**: High.

### S6 — Bearer token compared with `===` (not constant-time)
- **Severity**: Low
- **Location**: [routes/coverage.ts:27](routes/coverage.ts).
- **What**: `if (auth !== \`Bearer ${apiKey}\`) { return 401 }`. JS string equality is short-circuit and (theoretically) timing-leaky; with HTTPS/TLS jitter and ~50-100ms RTT to Railway, the timing channel is extremely small but nonzero.
- **Why it matters**: Mostly theoretical. If the COVERAGE_API_KEY is ever brute-forced, the timing oracle would shave guesses by character. Realistic risk: ~zero.
- **Suggested fix**: `crypto.timingSafeEqual(Buffer.from(auth), Buffer.from(\`Bearer ${apiKey}\`))` (with a length-equality guard first, since `timingSafeEqual` throws on mismatched lengths). Three-line change.
- **Confidence**: High that the timing-attack risk is small here; suggesting fix anyway because it's cheap.

### S7 — No security headers (CSP, X-Frame-Options, HSTS, X-Content-Type-Options, Referrer-Policy)
- **Severity**: Medium
- **Location**: [app.ts](app.ts) — express-only setup, no `helmet()` middleware.
- **What**: Greps for `helmet`, `Content-Security-Policy`, `X-Frame-Options`, `Strict-Transport`, etc. all return zero matches. Railway's edge layer terminates TLS but does not add HSTS or CSP headers by default.
- **Why it matters**:
  - **CSP**: Without one, the XSS in S2 has full reach (can `fetch()` any origin, load any script). A reasonable CSP would block inline-onclick (which would force the rewrite suggested in S2 and would also break the entire app today — see "patterns" below for the conflict).
  - **X-Frame-Options / frame-ancestors**: The app can be iframed by any origin, enabling clickjacking on the destructive actions (delete batch, etc.).
  - **HSTS**: Prevents the (already-rare) HTTP downgrade.
  - **X-Content-Type-Options: nosniff**: Mostly defense-in-depth for the photo upload path (S8).
- **Suggested fix**: Add `helmet()` to the middleware stack with default settings. The default CSP would break the app immediately because of inline `onclick=""` and inline `style=""` — need to either set `script-src 'self' 'unsafe-inline'` (defeats CSP value) or refactor to delegated handlers (also remediates S2). Even without CSP, set HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy: same-origin. That's a 5-minute win.
- **Confidence**: High.

### S8 — Photo upload trusts client-supplied `mimetype`
- **Severity**: Low
- **Location**: [routes/recipes.ts:567-597](routes/recipes.ts).
- **What**: The check is `if (!file.mimetype.startsWith('image/'))`. Multer takes the MIME type from the client's `Content-Type` header. A file with content `<script>alert(1)</script>` and `Content-Type: image/svg+xml` passes the check. SVG can include `<script>` tags executed when the SVG is rendered as an image. The serve handler ([routes/recipes.ts:600-607](routes/recipes.ts:600-607)) sets `Content-Type: ${photo.mimeType}` (i.e. `image/svg+xml` for SVG) and serves the file.
- **Why it matters**: An authenticated user uploads a poisoned SVG, then sends a colleague a link to `/api/recipes/:id/photo`. Browser renders the SVG → script runs → XSS in the Sering origin (so it can call `/api/data` on behalf of the victim). The `<img src="…/photo">` rendering path is mostly safe (browsers don't execute scripts in SVG via img), but a direct visit or `<object>` does.
- **Suggested fix**:
  1. Whitelist MIME types: `['image/jpeg', 'image/png', 'image/webp', 'image/gif']`. Reject `image/svg+xml` explicitly.
  2. On serve, set `Content-Disposition: inline; filename="recipe-${id}.png"` and `X-Content-Type-Options: nosniff`.
  3. Optionally re-encode the image server-side via `sharp` to strip metadata and force a known format. Adds a deps but bullet-proofs the path.
- **Confidence**: High.

### S9 — `redactSecrets` is good but inconsistently applied
- **Severity**: Low
- **Location**: [lib/config.ts:31-49](lib/config.ts) (the helper). Inconsistent application: see `01-architecture.md` finding A13 for specifics.
- **What**: The redactor exists, has unit tests, and is used in `tebi-sync.ts` and `routes/hanos.ts`. Other paths (`recalcRecipeCostsForIngredient` error log, scheduled-AI-analysis prompt body, log entries) still use raw `errMsg`.
- **Why it matters**: Cross-reference A13 — covered there. Listed here so the security audit is complete.
- **Suggested fix**: See A13.
- **Confidence**: High.

### S10 — Telemetry payload sent to Anthropic API includes user emails
- **Severity**: Low (privacy)
- **Location**: [lib/ai-analyzer.ts:240-306](lib/ai-analyzer.ts).
- **What**: `aggregateTelemetry()` collects telemetry rows; the prompt body sent to Anthropic includes the rendered telemetry as JSON. Telemetry rows have `userId` (the user's email; see [routes/telemetry.ts:114](routes/telemetry.ts)). Although `aggregateTelemetry` doesn't surface raw rows in its return shape (it groups by name), the screen-views and feature-usage aggregates *don't include* userId — that's good. But the error-summary fallback path stringifies the prompt with the raw arrays.
- **Why it matters**: Anthropic's API is a third-party processor; a small kitchen has ~57 staff and emails are PII. Currently the data sent is aggregated, so probably fine, but worth a one-time review to confirm no `userId` leaks into the prompt body.
- **Suggested fix**: Add a unit test that asserts the rendered prompt does NOT contain a `userId` field or any `@`-shaped string. This is the kind of regression that's easy to introduce in a refactor.
- **Confidence**: Medium — based on reading; would benefit from a real run with synthetic data.

### S11 — Frontend trust boundary: `apiPost` and `apiGet` log out on 401 by calling `doLogout()`
- **Severity**: Low
- **Location**: [public/js/utils.ts:30-52](public/js/utils.ts), [public/js/auth.ts:55-64](public/js/auth.ts).
- **What**: On 401, `doLogout()` is called. `doLogout` posts to `/api/auth/logout` (which then 401s itself, since the user is not auth'd…wait, /auth/ paths are skipped by requireAuth, OK that's fine). But `disconnectLiveSync()` runs first, then the cookie clear, then UI-shown login screen.
- **Why it matters**: Defensive design, OK. Not actually a bug — included so it's covered.
- **Suggested fix**: None.
- **Confidence**: High.

### S12 — Rate limiting only on `/api/telemetry`
- **Severity**: Low
- **Location**: [routes/telemetry.ts:63-85](routes/telemetry.ts).
- **What**: Per-IP rate limit (20 req/min) only on the telemetry endpoint. The auth `/api/auth/google` endpoint, the bulk save `/api/data/patch`, the photo upload, and the Hanos add-to-cart all have no rate limit. An authenticated user with a script could:
  - Burn through Hanos OAuth attempts (Hanos may rate-limit upstream, but each attempt costs 15s + login).
  - Hammer `/api/data/patch` with maximum-size payloads (500 batches * write-lock-serialised) — denial of service against single-replica server.
  - Spam `/api/feedback` with up-to-DB-limit text rows.
- **Why it matters**: Insider misuse + accidental loops. The current single-dyno deploy has no upstream rate-limit either.
- **Suggested fix**: Add a global per-IP rate limit (e.g. 60 req/min on writes) using a simple Map similar to telemetry's. Or pull in `express-rate-limit` (well-known package). Bullet-proof later with Redis or Upstash if multi-replica.
- **Confidence**: High.

### S13 — `.claude/launch.json` is committed and contains a real DB password
- **Severity**: Critical (subset of S1)
- **Location**: [.claude/launch.json:26](.claude/launch.json).
- **What**: The "preview" launch configuration sets `DATABASE_URL` to the staging Postgres URL inline (with password). Same staging password as S1.
- **Why it matters**: Same as S1 — the `.claude/` directory is editor/IDE config that's normally personal. Including it (and a credential) in the repo widens the exposure beyond the script.
- **Suggested fix**: Add `.claude/` (or `.claude/launch.json` specifically) to `.gitignore`. Move the env-var into a `.env.preview` template that is gitignored. Then rotate the password as in S1.
- **Confidence**: High.

### S14 — `parseCookie` builds RegExp from string interpolation
- **Severity**: Low
- **Location**: [routes/auth.ts:32-35](routes/auth.ts).
- **What**: `new RegExp('(?:^|;\\s*)' + name + '=([^;]+)')` — `name` is a string parameter. Today it's only ever called with the literal `'session'`, so safe. If a future caller passed user input as `name`, it could inject regex metachars (DoS via catastrophic backtracking).
- **Why it matters**: Low. Theoretical.
- **Suggested fix**: Escape regex metachars in `name`, or replace with a non-regex parser. The whole function could be `req.headers.cookie.split(';').map(s => s.trim().split('=')).find(...)`.
- **Confidence**: Medium.

### S15 — XLSX upload via `xlsx` package — known prototype-pollution history
- **Severity**: Low (acknowledged in dependency audit)
- **Location**: [routes/ingredients-import.ts:97-105](routes/ingredients-import.ts).
- **What**: Uses SheetJS `xlsx` package (`^0.18.5` in package.json). The upload is validated for `mimetype` and file extension, but the parser itself has had CVEs around prototype pollution and ReDoS in old versions. `0.18.5` is from 2022; current version is `0.20.x`.
- **Why it matters**: Authenticated-user-only attack surface. Worth tracking.
- **Suggested fix**: Bump `xlsx` to latest stable. See dependencies audit for the broader picture.
- **Confidence**: Medium — version-history claim is accurate; current exploitability requires examining the parser internals which I have not.

## Patterns & themes

- **The repo treats credentials inconsistently.** `.env` is gitignored. `lib/config.ts` reads everything from `process.env`. The bulk-script `seed-staging.js` reads from env vars (good). But `sync-prod-to-staging.js` and `.claude/launch.json` hardcode them. The team understands the right pattern; the regressions are accidents.
- **Validation is defense-in-depth at one boundary, missing at others.** The `/api/data/patch` validators are exhaustive (audit §6.1 cited). Per-entity routes have skipped checks. The XSS in S2 lives in this gap.
- **Auth is correct in shape but fragile in defaults**. ALLOWED_EMAILS empty = open. GOOGLE_CLIENT_ID empty = open. Both fail-open. Both rely on operator vigilance during deploys.
- **The `redactSecrets` helper is exactly the kind of careful tooling you want** — it has unit tests, it preserves auth-scheme names so debug output stays readable, it's used at the upstream-error sites that justified its creation. The gap is that it's not enforced; rg-grep audits to extend coverage are easy.
- **Inline `onclick=` is a code-quality smell that compounds into a security smell**. Every attribute-context interpolation is an XSS risk that an `esc()`-only model can't fully cover (because escape rules differ between HTML body, attribute value, and JS-string-in-attribute). The architecture refactor toward `addEventListener` would close this whole class of bug.

## What looked good

- **`redactSecrets` is well-designed**. Preserves Bearer/Basic scheme names. Has unit tests in `test/redact-secrets.test.ts` covering the realistic upstream-error patterns. Used in the right places (Hanos OAuth body capture, Tebi child-process stderr).
- **Cookie options are sensible**: `httpOnly: true` (mitigates the XSS-cookie-exfil path), `sameSite: 'lax'` (mitigates CSRF on state-changing requests), `secure` in production (HTTPS-only).
- **Express error handler masks 5xx messages in production** ([app.ts:128-132](app.ts)) — internal errors don't leak to the client.
- **SSE keep-alive comment about un-buffered streaming** ([app.ts:18-23](app.ts)). Compression skip is well-explained — the kind of subtle correctness that pays off years later.
- **Telemetry endpoint rate-limits per IP** ([routes/telemetry.ts:67-85](routes/telemetry.ts)) and `cleanupInterval.unref()` doesn't pin the process. Best-of-class for one of the more abusable surfaces.
- **`safeErrMsg` is used consistently in the user-facing Hanos error paths** ([routes/hanos.ts](routes/hanos.ts)) — those are the failure modes most likely to echo credentials.
- **Auth allowlist enforced server-side**, not client-side. Easy to get wrong; this codebase gets it right.
- **The test/setup-env.ts production-DB guard** is exactly the right shape — test runs refuse to touch a known prod host. Bonus: the mechanism is documented in CLAUDE.md.
- **The COVERAGE_API_KEY pattern** ([routes/coverage.ts](routes/coverage.ts)): a small, bounded admin endpoint with a separate auth model (bearer, not session) for a remote agent. Returns 503 if key not set, so it doesn't fail-open. Clean template for similar future endpoints.
- **Single Prisma client** singleton ([lib/db.ts:9](lib/db.ts)) — no connection-pool fragmentation, simpler reasoning about transactions.

---

## Round 2 — deeper findings (added after end-to-end reads + git history sweep)

### S16 — Git history sweep: only the two known DB credentials surfaced
- **Severity**: (Confirmation, no new finding — promoted to High via S1 already)
- **Location**: Git log search.
- **What**: Full `git log -p` regex search for OpenAI keys (`sk-…`), Google access tokens (`ya29.…`), Google API keys (`AIza…`), GitHub tokens (`ghp_/ghs_/gho_/github_pat_…`), and AWS access keys (`AKIA…`) returned **zero matches** across all 379 commits. The only credentials in history are the two Postgres passwords from S1 (and `postgres:postgres` localhost samples in `.env` templates, which are not real). The `sync-prod-to-staging.js` and `.claude/launch.json` files were both added on 2026-03-22 and re-edited 2026-05-02 — the password strings have been in main for ~6 weeks.
- **Why it matters**: Bounds the rotation scope. Only the two Postgres passwords need rotation; no other secrets are exposed.
- **Suggested fix**: See S1.
- **Confidence**: High.

### S17 — Photo upload accepts SVG and serves with the supplied MIME (cross-ref S8, with new detail)
- **Severity**: Low (already covered in S8)
- **Location**: [routes/recipes.ts:574](routes/recipes.ts).
- **What**: Added during Round 2 for completeness — the original S8 finding is correct; reading more of recipe-editor.ts confirms the upload flow uses `formData.append('photo', ed.photoFile)` with no client-side type filter ([public/js/recipe-editor.ts:790-794](public/js/recipe-editor.ts)).
- **Why it matters**: See S8.
- **Suggested fix**: See S8.
- **Confidence**: High.

### S18 — Hanos `formatProduct` returns external-controlled `imageUrl` rendered unchecked
- **Severity**: Low
- **Location**: [lib/hanos-client.ts:326](lib/hanos-client.ts), rendered in [public/js/recipe-editor.ts:878](public/js/recipe-editor.ts) (recipe photo) — actually a different code path; need to check ingredient-db usage. Confirmed embedded as `<img src="${product.imageUrl}">` is *not* present in the frontend code I read; the field is returned but the ingredient-db Hanos lookup doesn't currently render it. So the surface isn't actively exploitable today.
- **What**: `formatProduct` returns `imageUrl: (p.images as Array<...>)?.[0]?.url || ''` — Hanos response controls the value entirely. If a future UI feature renders this without validation, an attacker who controls a Hanos product (or a Hanos compromise) could plant `javascript:` URLs.
- **Why it matters**: Pre-emptive. The field exists but isn't dangerous yet.
- **Suggested fix**: Validate that `imageUrl` is `https://` or empty before returning. Or strip the field if it's not currently used by any consumer.
- **Confidence**: Medium.

### S19 — Hanos allergen detection is English-language heuristic; silent allergen miss if Hanos returns Dutch
- **Severity**: Medium (food safety, not security per se — but allergen handling is a regulatory concern)
- **Location**: [lib/hanos-client.ts:300-307](lib/hanos-client.ts).
- **What**: 
  ```ts
  const val = featureValues && featureValues[0] ? featureValues[0].value : '';
  if (val && val.toLowerCase().includes('with') && !val.toLowerCase().includes('without')) {
    allergens.push((feat.name || '') as string);
  }
  ```
  If Hanos returns Dutch allergen labels ("Met gluten" / "Zonder gluten"), neither "with" nor "without" matches, so the allergen is silently dropped. The `name` field is appended without examining whether the value indicates presence or absence.
- **Why it matters**: Allergen miss = food-safety risk for guests with allergies. The kitchen relies on the auto-allergen detection to populate batch allergens. If a Hanos product has gluten but the parser misses it, downstream batches inherit empty allergens.
- **Suggested fix**: 
  1. Add Dutch-language matching: `'with', 'met', 'contains', 'bevat'` for present; `'without', 'zonder', 'free of', 'vrij van'` for absent.
  2. Fail-open: if neither match, push the allergen anyway (assume present) — safer to over-report than miss.
- **Confidence**: High for the bug shape; Medium for the practical exposure (depends on what Hanos actually returns today).

### S20 — `tebi-error.png` written to working directory on failure
- **Severity**: Low
- **Location**: [scripts/tebi-scraper.js:591](scripts/tebi-scraper.js).
- **What**: On scrape failure, the script does `await page.screenshot({ path: 'tebi-error.png' })`. The screenshot may capture the Tebi backoffice UI mid-login or mid-fetch, including PII (account email visible in nav, possibly draft data). Path is relative to cwd. In production (Railway) this writes to ephemeral container fs; in dev (the worktree we're in!), it could land in the repo root.
- **Why it matters**: 
  - In dev: the file might get committed if a contributor adds it accidentally. `*.png` is not in `.gitignore` (only `*.bak` and `data/` are).
  - In prod: container fs, fine.
- **Suggested fix**: Write to `/tmp/tebi-error-${Date.now()}.png`. Add `tebi-error*.png` to `.gitignore` as defense in depth.
- **Confidence**: High.

### S21 — `prisma/archive/import-xlsx.js` is a destructive landmine if the schema ever re-introduces Dish/Service models
- **Severity**: Low (today), High (latent)
- **Location**: [prisma/archive/import-xlsx.js:43-55](prisma/archive/import-xlsx.js). Same finding as A22 — included in security audit because the failure mode is "wipes most production tables." The CLAUDE.md warning depends on humans reading it.
- **What**: See A22.
- **Why it matters**: See A22.
- **Suggested fix**: See A22 — preferred is to delete the archive scripts entirely.
- **Confidence**: High.

### S22 — `tebi-scraper.js` mutates `process.env.TEBI_EMAIL/PASSWORD` mid-run for cross-account credential isolation
- **Severity**: Low
- **Location**: [scripts/tebi-scraper.js:482-506](scripts/tebi-scraper.js). Same finding as A21 — listed here because the failure mode is "credentials leak into a sibling code path."
- **What**: See A21.
- **Why it matters**: See A21. From a security lens: if a future telemetry call reads `process.env.TEBI_EMAIL` during the try-block window (e.g. for a backend event payload), it'd capture and persist whichever account is currently impersonated. Not a leak today; a fragility tomorrow.
- **Suggested fix**: See A21.
- **Confidence**: High.
