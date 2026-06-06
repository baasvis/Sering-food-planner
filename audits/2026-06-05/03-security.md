# Security & Secrets

## Scope of review

This pass re-checked the committed-credentials exposure from the 2026-05-02 review and audited the new write routers (Competencies kiosk, ritual-completions, Notion sync) for auth gating, input validation, error leakage, and enumeration. The recipe-AI tool-use loop was reviewed for prompt-injection escalation. Findings are sorted by adjusted severity.

## Findings

### SEC-1 — Production AND staging Postgres superuser passwords still committed to the repo (prior S1/S13 unresolved, re-committed since the audit)

**STATUS: FIXED 2026-06-05 (PARTIAL) — credentials removed from tracked files (`scripts/sync-prod-to-staging.js` now reads `PROD_DATABASE_URL`/`STAGING_DATABASE_URL` from env; `.claude/launch.json` untracked via `git rm --cached` + added to `.gitignore`, with `.claude/launch.json.example` committed). REMAINING (owner: Daan): rotate BOTH Postgres passwords on Railway, and scrub the git history.**

- **Severity**: Critical
- **Location**: scripts/sync-prod-to-staging.js:7-8, .claude/launch.json:11,30
- **What**: Two working Railway Postgres connection strings with the `postgres` superuser password are present in tracked files on the current branch, and were last re-committed on 2026-05-12 (after the 2026-05-02 audit).
- **Why it matters**: Anyone with repo read access has full credentialed superuser access to production (all batches/recipes/ingredients/feedback/telemetry-with-emails) and write access to staging; the historical commits keep the secret forever even after a rotation, so the only real remediation is rotating both passwords on Railway.
- **Suggested fix**: Rotate BOTH Postgres passwords on Railway now; replace the hardcoded URLs in scripts/sync-prod-to-staging.js and .claude/launch.json with process.env reads (PROD_DATABASE_URL/STAGING_DATABASE_URL, as scripts/seed-staging.js already does); add `.claude/launch.json` to .gitignore; optionally scrub history with BFG.
- **Confidence**: High.
- **Verified**:

  scripts/sync-prod-to-staging.js lines 7-8:
    const PROD_URL = 'postgresql://postgres:«REDACTED-PROD-PW»@centerbeam.proxy.rlwy.net:20242/railway';
    const STAGING_URL = 'postgresql://postgres:«REDACTED-STAGING-PW»@shuttle.proxy.rlwy.net:52350/railway';

  .claude/launch.json lines 11 and 30 (both "dev" and "preview" configs):
    "DATABASE_URL": "postgresql://postgres:«REDACTED-STAGING-PW»@shuttle.proxy.rlwy.net:52350/railway"

  Both files are confirmed tracked by git (git ls-files output shows both). sync-prod-to-staging.js was last committed 2026-05-11 and launch.json 2026-05-12 — both after the prior audit date of 2026-05-02. Neither file is listed in .gitignore. The production superuser password appears only in sync-prod-to-staging.js; the staging superuser password appears in both files.
- **Reviewer notes**: The finding is accurate. The production Postgres superuser password is hardcoded in scripts/sync-prod-to-staging.js (committed 2026-05-11). The staging superuser password is in both scripts/sync-prod-to-staging.js and .claude/launch.json (last updated 2026-05-12). Both files are git-tracked and not gitignored. The claim that they were re-committed after the prior audit is verified. The severity is correctly Critical: the production connection string gives full superuser access to all production data. Note that launch.json only contains the staging password (not the prod URL), but the claim about both passwords being in tracked files is correct. Proposed fix is sound: rotate both passwords on Railway immediately, replace hardcoded URLs with process.env reads, add .claude/launch.json to .gitignore.

### SEC-2 — competencies.ts is the only new write router that skips id-charset validation (checkId) on client-supplied primary keys and accepts an unvalidated `location`

- **Severity**: Low
- **Location**: routes/competencies.ts:38-55 (POST /events), routes/competencies.ts:73-84 (POST /people)
- **What**: POST /api/competencies/events and POST /api/competencies/people store a client-supplied `id` (and, for people, `location`) with only a truthiness check — no `checkId` charset/length guard and no `['west','centraal']` location allowlist — unlike supplies.ts and ingredients.ts which both call checkId.
- **Why it matters**: This re-opens the prior-audit S2 stored-XSS-via-id class at the data layer for the new competencies entities (the only reason it is not actively exploitable is that competencies.ts/supplies.ts/team.ts render every id through esc() and the data-*+dataset pattern); an invalid `location` is also silently stored and used to filter the grid, a data-integrity bug. It is an inconsistency with the S2 fix applied everywhere else.
- **Suggested fix**: In POST /events and POST /people call `checkId(id,'id')` (and `checkId(chunkId/teacherId/learnerId,...)`), bound `name`/`notes` length, and validate `location` against VALID_LOCATIONS (default 'centraal'), throwing AppError(400) on failure — mirroring routes/supplies.ts.
- **Confidence**: High.
- **Verified**:

  routes/competencies.ts lines 38-55 (POST /events):
    const { id, chunkId, teacherId, learnerId, date, notes } = req.body;
    if (!id || !chunkId || !teacherId || !learnerId || !date) {
      return res.status(400).json({ error: '...' });
    }
    // No checkId() call — id/chunkId/teacherId/learnerId go straight to prisma.teachingEvent.create()

  routes/competencies.ts lines 73-84 (POST /people):
    const { id, name, location } = req.body;
    if (!id || !name || !String(name).trim()) {
      return res.status(400).json({ error: 'id and name are required' });
    }
    // No checkId() call, no VALID_LOCATIONS check — location stored as-is via: location || 'centraal'

  Contrast with routes/supplies.ts which calls validateSupplyInput(input, true) → checkId(input.id, 'id') and validates location against VALID_LOCATIONS = ['west', 'centraal'].

  The file header explicitly documents the design choice: "Trust by default (kiosk model): writes are not defensively validated."
- **Reviewer notes**: The finding is literally true. No checkId() is called for any of the client-supplied IDs in POST /events or POST /people, and the location field in POST /people has no allowlist guard. The severity is correctly assessed as Low: (1) the file header documents this as intentional "kiosk model" design, not an oversight; (2) the only active exploitation path (stored XSS via id) is blocked because all IDs are rendered through esc() in the frontend; (3) the location issue is data-integrity only, with a harmless fallback to 'centraal' for missing values. The inconsistency with supplies.ts is real and worth fixing for defense-in-depth.

### SEC-3 — POST /api/admin/analyze (triggers paid Claude API runs) is gated only by requireAuth, not requireDirector

- **Severity**: Low
- **Location**: routes/admin.ts:2,17-29 (mounted in app.ts:179-180 behind requireAuth only)
- **What**: Any authenticated (allowlisted) staff member — not just a director — can POST /api/admin/analyze, which calls generateInsights() and bills the Anthropic API, and can read /api/admin/insights and /api/admin/telemetry/summary.
- **Why it matters**: A non-director staff account (or a phished one) can repeatedly trigger paid Claude analysis and read aggregated telemetry; the `analysisRunning` mutex caps it to serialized runs so the cost-amplification is bounded, but the admin surface is broader than its intent and inconsistent with the director-gating used by access.ts and recipe-ai.ts.
- **Suggested fix**: Add `router.use(requireDirector)` (or `requireStaffLead`) to routes/admin.ts so the AI-cost and telemetry-admin endpoints match the gating model of the other privileged routers.
- **Confidence**: High.
- **Verified**: routes/admin.ts line 2 comment: "protected by requireAuth" — no requireDirector anywhere in the file. All three handler registrations (POST /analyze, GET /insights, PATCH /insights/:id, GET /telemetry/summary) have no director guard. app.ts line 116 applies requireAuth globally to /api, and lines 179-180 mount adminRouter at /api/admin with no extra middleware. By contrast, routes/access.ts line 22 has `router.use(requireDirector)` and routes/recipe-ai.ts line 19 applies `requireDirector` per-route. The analysisRunning mutex (routes/admin.ts lines 15, 18-28) serializes concurrent runs but does not prevent repeated sequential calls by any authenticated non-director user.
- **Reviewer notes**: Severity Low is well-calibrated. Exploiting this requires a valid allowlisted session (no anonymous or unauthenticated risk). The mutex means cost is bounded to one run at a time (not parallel amplification). The main concern is inconsistency with the director-gating model used by access.ts and recipe-ai.ts, plus marginal extra API cost exposure. Fix: add router.use(requireDirector) to routes/admin.ts.

### SEC-4 — ritual-completions write endpoint does not validate loc/date or completed[] element shape

- **Severity**: Low
- **Location**: routes/inventory.ts:283-305 (POST /ritual-completions)
- **What**: POST /api/ritual-completions accepts arbitrary `loc` and `date` strings (only a truthiness check) and stores `completed` as any array of arbitrary strings, then upserts on the loc_date composite key and broadcasts it.
- **Why it matters**: An authenticated client can write rows with bogus loc/date keys (e.g. a non-location, or a non-YYYY-MM-DD date that the frontend never prunes by the `date === todayIso()` guard) and store unbounded string arrays, polluting the table and the SSE broadcast; low impact because the values are rendered as ticked checkbox keys and the table is pruned after 3 days, but it is an input-validation gap relative to supplies.ts's strictness.
- **Suggested fix**: Validate `loc` against VALID_LOCATIONS, require `date` to match /^\d{4}-\d{2}-\d{2}$/, and cap `completed` length plus reject non-string/oversized elements before upserting.
- **Confidence**: High.
- **Verified**:

  // routes/inventory.ts lines 283-305
  router.post('/ritual-completions', asyncHandler(async (req: Request, res: Response) => {
    const { loc, date, completed } = req.body;
    if (!loc || !date) return res.status(400).json({ error: 'loc and date required' });
    const completedArr: string[] = Array.isArray(completed) ? completed : [];
    await withWriteLock(async () => {
      await prisma.ritualCompletion.upsert({
        where: { loc_date: { loc, date } },
        create: { loc, date, completed: completedArr },
        update: { completed: completedArr, updatedAt: new Date() },
      });
      ...
    });
    broadcast(user.email, 'patch', {
      user: user.name,
      ritualCompletion: { loc, date, completed: completedArr },
    });
    res.json({ ok: true });
  }));

  // Contrast: /inventory-completions directly below uses strict Set validation:
  const INV_LOCS = new Set(['west', 'centraal']);
  if (!INV_LOCS.has(loc)) throw new AppError(400, 'loc must be "west" or "centraal"');
- **Reviewer notes**: The finding is accurate. The POST /ritual-completions handler at lines 283-305 only applies a truthiness check on loc and date — any non-empty string passes. The completed array accepts any elements with no type, length, or size validation. This is a genuine input-validation gap compared to the /inventory-completions handler immediately below it, which uses Set.has() checks and throws AppError(400) for invalid values. Severity Low is correctly calibrated: only authenticated users can write, the table is pruned after 3 days, and the data only affects rendered checkbox keys plus SSE broadcasts to other sessions.

### SEC-6 — Account/status enumeration via /api/auth/google and /api/auth/request-access response differentiation

- **Severity**: Low
- **Location**: routes/auth.ts:227-241 (/google), routes/auth.ts:279-286 (/request-access)
- **What**: Both endpoints return distinct outcomes ('approved' vs 'pending' vs 'denied'/'revoked') for a given email, revealing whether that email is allowlisted/approved/denied in the planner.
- **Why it matters**: An attacker learns an email's authorization status, but only after presenting a Google ID token they control for that exact email (verifyGoogleToken runs first), so the attacker must already own the account — making this a minor information disclosure rather than a usable enumeration oracle. Per-IP rate limiting (10/min) on /request-access further bounds it.
- **Suggested fix**: Acceptable as-is given the Google-token gate; if tightening is desired, collapse /request-access responses to a single generic 'your request has been recorded' message regardless of prior status.
- **Confidence**: Medium.
- **Verified**: routes/auth.ts line 240: `return res.status(403).json({ error: 'not_allowed', status, message: accessRequestMessage(status) });` — `status` is the raw DB value ('pending'/'denied'/'revoked'). routes/auth.ts line 283: `return res.json({ ok: true, status: 'approved', message: ... });` and line 286: `return res.json({ ok: true, status, message: ... });` — /request-access similarly returns the exact status. The Google token gate at lines 222 and 280 runs before any status disclosure, so an attacker must control the email to probe it. Rate limiting: REQ_ACCESS_LIMIT=10 per 60s per IP (lines 33-34).
- **Reviewer notes**: The finding is real and unmitigated — both endpoints deliberately return distinct status strings so the login screen can display a tailored message. However, the practical impact is correctly assessed as minimal: exploiting this oracle requires the attacker to already possess a valid Google ID token for the target email (i.e., they already own or control that Google account). An attacker who owns the account trivially knows its own authorization status, so no new information is actually leaked to a third party. The proposed fix (collapsing /request-access to a single generic response) would reduce information disclosure but is not urgent. Severity Low is appropriate.

### SEC-5 — parseCookie builds a RegExp from string interpolation (prior S14 unresolved)

- **Severity**: Nit (adjusted from Low)
- **Location**: routes/auth.ts:168-171
- **What**: `parseCookie` still constructs `new RegExp('(?:^|;\\s*)' + name + '=([^;]+)')` from the `name` parameter; it is only ever called with the literal 'session', so it is safe today but fragile.
- **Why it matters**: If a future caller passes user-controlled input as `name`, regex metacharacters could enable ReDoS or incorrect cookie matching; the issue is latent, not currently exploitable, but the fix is trivial and removes the footgun.
- **Suggested fix**: Replace the regex with a non-regex split parser (`cookieHeader.split(';').map(s=>s.trim().split('=')).find(...)`), or escape regex metacharacters in `name`.
- **Confidence**: Medium.
- **Verified**:

  routes/auth.ts line 168-169:
    function parseCookie(cookieHeader: string, name: string): string | null {
      const match = cookieHeader.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));

  Called only at lines 178 and 294, both with the literal string 'session':
    const sessionId = parseCookie(req.headers.cookie || '', 'session');
- **Reviewer notes**: The claim is literally true: `parseCookie` builds a RegExp via string interpolation of the `name` parameter. However, the function is only ever called with the hardcoded literal `'session'` — there are exactly two call sites (logout handler at line 294 and getSessionUser at line 178) and neither passes user-controlled input. The vulnerability is theoretical/latent only with zero current exploitability. The severity of "Low" is a slight overstatement; "Nit" better reflects that this is a code-quality footgun with no current attack surface, not a real security issue. The proposed fix (split-based parser or escaping metacharacters) is valid and trivially simple.

### SEC-7 — AI recipe assistant tool-use loop is correctly sandboxed to in-memory wire state (no prompt-injection escalation path) — verification, not a defect

- **Severity**: Nit
- **Location**: lib/recipe-ai.ts:354-426 (applyToolCall), routes/recipe-ai.ts:19 (requireDirector gate)
- **What**: The recipe-AI chat is director-gated and its five tools only mutate the AIRecipeState object passed on the wire (set_recipe_basics/ingredients/prep_steps/storage/extra_allergens); no tool reads or writes the DB/filesystem, ingredientIds are re-validated against the catalog, and MAX_TOOL_LOOPS/MAX_TOKENS bound cost.
- **Why it matters**: Even a fully prompt-injected model cannot exfiltrate data or persist anything server-side through the tool surface, because tool effects are confined to the returned state that the director's own editor then chooses to save; this is the right design and no change is needed beyond keeping the requireDirector gate.
- **Suggested fix**: No change required; keep tool effects confined to wire state and the requireDirector gate intact if new tools are added later.
- **Confidence**: High.
- **Verified**:

  routes/recipe-ai.ts line 19: `router.post('/chat', requireDirector, ...)` — director gate confirmed.

  lib/recipe-ai.ts lines 354-426: `applyToolCall` is a pure function returning a new `AIRecipeState`; none of the five tool branches (`set_recipe_basics`, `set_ingredients`, `set_prep_steps`, `set_storage`, `set_extra_allergens`) call `prisma`, write to the filesystem, or perform any I/O.

  lib/recipe-ai.ts lines 376-379: ingredient ID re-validation — `const catalogIds = new Set(catalog.map(c => c.id)); if (ingredientId && !catalogIds.has(ingredientId)) ingredientId = null;`

  lib/recipe-ai.ts lines 458-459: `const MAX_TOOL_LOOPS = 10; const MAX_TOKENS_PER_TURN = 4096;` — both bounds enforced.
- **Reviewer notes**: The finding is a positive verification of correct design, not a defect. All claims check out exactly as stated: the `requireDirector` gate is on the route, all five tool handlers are pure functions confined to `AIRecipeState` with no DB/filesystem side-effects, ingredient IDs are re-validated against the live catalog before being accepted, and both MAX_TOOL_LOOPS and MAX_TOKENS_PER_TURN are in place. The "Nit" severity is appropriate — this is an informational confirmation that the design is sound and no change is needed.
