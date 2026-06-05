# Architecture & Code Quality

## Scope of review

This pass focused on the modules added since the 2026-05-02 review — the Competencies/Training kiosk (`routes/competencies.ts`, `public/js/competencies.ts`), the Supplies module (`routes/supplies.ts`, `public/js/supplies.ts`), the Notion sync (`lib/notion-sync.ts`), the recipe-AI exemplar loader (`lib/recipe-ai.ts`), and the Today/ritual dashboard tick — plus the cross-cutting timer/concurrency/error-handling patterns those modules inherit. Findings are sorted by adjusted severity.

## Findings

### ARCH-1 — Competencies screen refetches the entire (unbounded) teaching-event ledger on every render, including the 60s background tick

- **Severity**: Medium
- **Location**: public/js/competencies.ts:118-134 (renderCompetencies) + routes/competencies.ts:27-34 (GET /) + public/js/init.ts:217-225 (60s tick)
- **What**: renderCompetencies() — the registered renderer — calls apiGet('/api/competencies') on every invocation, the GET handler runs prisma.teachingEvent.findMany() with no take/limit, and init.ts's 60s setInterval re-renders any active non-dashboard screen, so a user sitting on the Training screen re-downloads all chunks+people+the ever-growing event ledger every 60 seconds.
- **Why it matters**: The teaching-event table only grows (no pruning); each kiosk left open on the Training screen polls the full ledger every minute, so payload size and DB load climb monotonically over the app's life with no ceiling, on a single dyno shared with the live kitchen.
- **Suggested fix**: Cap the events query (e.g. take: 500, most-recent) or paginate; and split the renderer so the 60s tick repaints from module-cached cChunks/cEvents instead of refetching (only refetch on explicit screen-enter or after a local mutation), mirroring the split-container rule.
- **Confidence**: High.
- **Verified**:

  routes/competencies.ts:31 — `prisma.teachingEvent.findMany({ orderBy: { createdAt: 'desc' } })` — no `take` or cursor, full table scan every call.

  public/js/competencies.ts:118-133 — `renderCompetencies()` calls `apiGet('/api/competencies')` unconditionally on every invocation. The `cLoaded` flag (line 121) only controls whether a loading spinner is shown; it does not short-circuit the fetch.

  public/js/init.ts:217-225 — `setInterval(() => { rebuildPlanner(); const active = ...; if (active && active.id !== 'screen-dashboard') { rerenderCurrentView(); ... } }, 60000)` — fires every 60s and calls `rerenderCurrentView()` for any non-dashboard active screen, dispatching to the registered `renderCompetencies` renderer (registered at module import time via `registerRenderer`).
- **Reviewer notes**: All three components of the claim are confirmed in current code: unbounded DB query, unconditional fetch on every render, and the 60s tick that triggers a full re-render for any active non-dashboard screen. The `cLoaded` flag is a cosmetic "show spinner on first load" guard only — it never prevents subsequent fetches. Severity Medium is appropriate: the table grows monotonically but the app is a small kitchen-kiosk context (not high-scale), so degradation is gradual rather than immediately critical.

### ARCH-2 — Recipe-AI exemplar cache is poisoned permanently on a single transient DB failure and never invalidates on edit

- **Severity**: Medium
- **Location**: lib/recipe-ai.ts:85-137 (loadExemplars)
- **What**: loadExemplars() guards with `if (_exemplarCache) return _exemplarCache` but its catch block sets `_exemplarCache = []` (a truthy value), so one transient prisma failure at first call pins the assistant to zero exemplars for the entire process lifetime, and there is no invalidation hook when a director edits one of the three exemplar recipes.
- **Why it matters**: A single DB hiccup during the first AI chat after a deploy silently degrades every subsequent recipe-drafting session (no house-style examples) until the dyno restarts, with no error surfaced; editing an exemplar also has no effect until restart.
- **Suggested fix**: On failure, leave `_exemplarCache` null (return [] without caching) so the next call retries; add an exported invalidateExemplars() called from the recipe PATCH/version routes when an EXEMPLAR_IDS recipe changes.
- **Confidence**: High.
- **Verified**: lib/recipe-ai.ts lines 85-136: `let _exemplarCache: RecipeFull[] | null = null;` with guard `if (_exemplarCache) return _exemplarCache;`. The catch block sets `_exemplarCache = [];` — an empty array is truthy in JS, so the guard short-circuits all future calls. No `invalidateExemplars` export exists anywhere in the codebase, and routes/recipes.ts never clears `_exemplarCache` after PATCH or version operations.
- **Reviewer notes**: Both failure modes are confirmed: (1) a transient Prisma error during the first `loadExemplars()` call permanently pins the cache to an empty array for the process lifetime since `if ([])` is truthy; (2) editing one of the three EXEMPLAR_IDS recipes via PATCH or POST .../version has no effect on the cache. The only mitigation not mentioned in the finding is that a Railway dyno restart (triggered by every deploy) does clear the in-memory cache — so the blast radius is limited to a single deploy window. Severity Medium is appropriate: this is director-only functionality, the assistant still responds (just without house-style exemplars), and there is no user-visible error.

### ARCH-3 — Per-login setInterval in initApp leaks a heavy planner-rebuild timer because logout no longer reloads the page

- **Severity**: Low
- **Location**: public/js/init.ts:217-225 (unguarded setInterval) + public/js/auth.ts:169-178 (doLogout), 262 & 299 (initApp on every login)
- **What**: initApp() registers a 60s setInterval that calls rebuildPlanner()+rerenderCurrentView() with no guard flag and no clearInterval, doLogout() only toggles DOM visibility (no page reload), and showApp()/selectLocation() call initApp() on every login — so each logout→login cycle stacks another timer that does a full planner rebuild every minute.
- **Why it matters**: Repeated logout/login in one tab compounds CPU work (N concurrent full planner rebuilds per minute) and is an escalation of prior nit A16, now with real cost because the timer body is heavy and the page no longer reloads to clear it.
- **Suggested fix**: Guard the interval with a module flag (like dashboard.ts's _freshTickStarted) or store its id on S and clearInterval in doLogout; ideally have doLogout reload or fully tear down app state.
- **Confidence**: High.
- **Verified**: init.ts lines 217-225: `setInterval(() => { rebuildPlanner(); ... rerenderCurrentView(); }, 60000);` — bare call with no guard variable and no returned id stored anywhere. auth.ts lines 169-178: `doLogout()` only calls `disconnectLiveSync()`, POSTs to /api/auth/logout, clears S.user, and toggles DOM — no clearInterval, no page reload. auth.ts line 262 (`showApp`) and 299 (`selectLocation`) both call `initApp()` unconditionally on every login. dashboard.ts line 946-950 shows the existing guard pattern (`let _freshTickStarted = false; if (_freshTickStarted) return; _freshTickStarted = true;`) that init.ts lacks. A grep for `clearInterval` across public/js finds only utils.ts and finance.ts (health-check and finance-poll intervals), not init.ts.
- **Reviewer notes**: The finding is accurate and unmitigated. Each logout→login cycle in the same tab stacks another 60s timer. The severity "Low" is calibrated correctly: the compounding only matters after repeated logout→login cycling in a single tab (not the typical session lifecycle), and the timer body is bounded work. The fix is straightforward: add a module-level guard (like dashboard.ts's _freshTickStarted) or store the interval id and clearInterval in doLogout.

### ARCH-4 — Two independent 60s timers both drive planner rebuilds; the dashboard relies on the second one to flip Today-panel status

- **Severity**: Low
- **Location**: public/js/init.ts:217-225 and public/js/dashboard.ts:946-956 (_startFreshnessTick)
- **What**: There are now two separate 60s setInterval loops — init.ts skips the dashboard and dashboard.ts handles only the dashboard — and the Today panel's overdue/phase transitions depend entirely on the dashboard.ts tick (init.ts:220 explicitly does NOT rerender when screen-dashboard is active).
- **Why it matters**: The split is fragile and duplicative: init.ts still calls rebuildPlanner() every minute even on the dashboard (double work with the dashboard tick), and if the dashboard tick is ever removed the Today panel silently stops auto-flipping overdue/now status — a non-obvious coupling for a safety-relevant panel.
- **Suggested fix**: Consolidate to a single background-refresh timer routed through navigate.ts's setBackgroundRefresh / rerenderCurrentView, so each active screen (dashboard included) gets exactly one repaint per tick.
- **Confidence**: High.
- **Verified**:

  init.ts lines 217-225:
    setInterval(() => {
      rebuildPlanner();
      const active = document.querySelector('.screen.active');
      if (active && active.id !== 'screen-dashboard') {
        rerenderCurrentView();
      }
    }, 60000);

  dashboard.ts lines 946-956:
    let _freshTickStarted = false;
    function _startFreshnessTick() {
      if (_freshTickStarted) return;
      _freshTickStarted = true;
      setInterval(() => {
        if (screen && screen.style.display !== 'none' && screen.offsetParent !== null) {
          renderDashboardContent();
        }
      }, 60_000);
    }

  renderDashboardContent (line 1027) calls rebuildPlanner() directly. So when the dashboard is active: init.ts fires rebuildPlanner() unconditionally, then the dashboard.ts tick also fires renderDashboardContent() → rebuildPlanner() — two redundant calls per minute. The setBackgroundRefresh / refreshDashboardIfMounted mechanism (navigate.ts line 54, dashboard.ts line 1342) is an orthogonal concern (keeps passive dashboard cards live while the user is on another screen) and does not consolidate the two 60s timers.
- **Reviewer notes**: The finding is confirmed exactly as described. Both timers exist independently in the current code. The proposed fix (consolidate to a single timer routed through rerenderCurrentView) is technically valid but the existing setBackgroundRefresh hook already provides part of that infrastructure. The severity Low is correct: the Today-panel's overdue/phase status auto-flips correctly (the dashboard.ts tick fires and calls renderDashboardContent), but if _startFreshnessTick were removed the panel would silently stop auto-flipping. The redundant rebuildPlanner() call is mild wasted CPU, not a correctness problem.

### ARCH-5 — Supplies screen refetches /api/supplies on every render despite SSE already delivering supply deltas

- **Severity**: Low
- **Location**: public/js/supplies.ts:47-76 (renderSupplies awaits loadSupplies on every call) vs public/js/utils.ts:785-792 (applyRemotePatch already merges supplies)
- **What**: renderSupplies() (the registered renderer) calls `await loadSupplies()` every time, so every SSE patch of any kind and the 60s background tick trigger a full GET /api/supplies, even though applyRemotePatch already merges supply CRUD/prep/stock deltas into S.supplies.
- **Why it matters**: Redundant network round-trips on a single-dyno backend, and the refetch can transiently revert an optimistic local edit; it also makes the SSE supply-merge logic effectively dead on the supplies screen.
- **Suggested fix**: Load supplies once on screen-enter (or when stale), repaint from S.supplies on rerender, and only refetch when _includeArchived changes; let the SSE merge keep S.supplies fresh.
- **Confidence**: High.
- **Verified**:

  In public/js/supplies.ts lines 57-60:

    export async function renderSupplies(): Promise<void> {
      const el = document.getElementById('screen-supplies');
      if (!el) return;
      await loadSupplies();   // unconditional GET /api/supplies on every render

  And loadSupplies() at lines 47-55 always issues a network request:

    export async function loadSupplies(): Promise<void> {
      try {
        const list = await apiGet('/api/supplies' + (_includeArchived ? '?includeArchived=1' : '')) as Supply[];
        S.supplies = Array.isArray(list) ? list : [];

  Meanwhile applyRemotePatch in utils.ts lines 786-792 does merge supplies into S.supplies:

    if ((supplies && supplies.length) || (deletedSupplies && deletedSupplies.length)) {
      const supplyMap = new Map((S.supplies || []).map((s: Supply) => [s.id, s]));
      if (deletedSupplies) deletedSupplies.forEach((id: string) => supplyMap.delete(id));
      if (supplies) supplies.forEach((s: Supply) => supplyMap.set(s.id, s));
      S.supplies = [...supplyMap.values()];
      changed = true;
    }

  But then at line 894 it calls rerenderCurrentView() unconditionally, which invokes renderSupplies(), which calls loadSupplies() again — overwriting S.supplies with a fresh fetch and making the SSE merge effectively dead on the supplies screen.
- **Reviewer notes**: The finding is accurate. renderSupplies() calls loadSupplies() on every invocation (line 60), which fires a GET /api/supplies regardless of whether the current screen state is already fresh from an SSE merge. The SSE merge path in applyRemotePatch correctly updates S.supplies in-memory, but when rerenderCurrentView() is called afterward and the supplies screen is active, the renderer immediately fires another network fetch and overwrites the merged state. Severity Low is calibrated correctly — it causes redundant round-trips and makes the SSE supply merge dead code on the active screen, but it does not cause data loss (the refetch reflects server truth) and the supplies screen is not a high-frequency rerender target.

### ARCH-6 — Notion sync returns/logs the raw upstream error (errMsg, not safeErrMsg) to the client and activity log

- **Severity**: Low
- **Location**: lib/notion-sync.ts:132,153,175 (error: errMsg(e)) surfaced via routes/competencies.ts:118-128 (res.json(report)) and dbAppendLog
- **What**: syncChunksFromNotion() populates report.error with raw errMsg(e), and POST /api/competencies/sync-chunks ships that report to the client and writes `failed: ${report.error}` to the activity log, bypassing the safeErrMsg/redactSecrets contract that the rest of the perimeter follows for third-party errors.
- **Why it matters**: If the Notion client ever echoes the request (Authorization: Bearer <NOTION_TOKEN>) in an error body, the token lands in an HTTP response and the persisted activity log — the exact leak class A13/redactSecrets exists to prevent; low likelihood but a real gap in a newly added integration.
- **Suggested fix**: Run report.error through safeErrMsg before returning it and before dbAppendLog (or redact at the notion-sync boundary).
- **Confidence**: Medium.
- **Verified**:

  lib/notion-sync.ts:132: `return { ok: false, synced: [], warned: [], flagged: [], error: errMsg(e) };`
  lib/notion-sync.ts:153: `flagged.push({ name, reason: errMsg(e) });`
  lib/notion-sync.ts:175: `return { ok: false, synced, warned, flagged, error: errMsg(e) };`

  routes/competencies.ts:123: `dbAppendLog(user.email, user.name, 'competency-sync', report.ok ? ... : \`failed: ${report.error}\`);`
  routes/competencies.ts:126: `return res.status(notConfigured ? 503 : 502).json(report);`

  No `safeErrMsg` import or call exists anywhere in lib/notion-sync.ts. The raw errMsg output flows directly to both the HTTP response body and the persisted activity log, bypassing the redactSecrets/safeErrMsg contract used by the rest of the perimeter.
- **Reviewer notes**: The claim is literally true and unmitigated. All three error-capture sites in syncChunksFromNotion() use errMsg(e) and the report object is returned as-is to both the client (res.json(report)) and the activity log (dbAppendLog). The flagged[].reason field (line 153) also reaches the client via report.flagged in the success branch (res.json(report) at line 128), though those are per-page errors rather than auth failures. The primary risk is at lines 132/175 where a Notion API auth error could include the Authorization header value. Severity Low is correct: the endpoint is staff-lead gated (authenticated users only), reducing exposure, but the token-leak class is real and the fix is trivial (wrap report.error with safeErrMsg before the res.json and dbAppendLog calls in routes/competencies.ts).

### ARCH-7 — Competencies kiosk write endpoints accept client-supplied ids with no checkId/length validation

- **Severity**: Low
- **Location**: routes/competencies.ts:38-55 (POST /events) and 73-84 (POST /people)
- **What**: POST /api/competencies/events and POST /api/competencies/people take the client-provided `id` and write it straight to Prisma with only a truthiness check, unlike routes/supplies.ts which runs checkId() on every client id.
- **Why it matters**: An authenticated client can store arbitrary-length / arbitrary-charset primary keys in person and teaching_event rows (no injection risk via Prisma, but unbounded/garbage ids that later break id-based lookups or URL routing); inconsistent with the validation standard established for supplies.
- **Suggested fix**: Apply checkId(id, 'id') in both handlers (the documented kiosk 'trust by default' can still skip the social-correctness checks while validating the id charset/length).
- **Confidence**: High.
- **Verified**:

  routes/competencies.ts line 15: `import { prisma, dbAppendLog, withWriteLock } from '../lib/db';` — checkId is not imported.

  POST /events (lines 38-55):
    const { id, chunkId, teacherId, learnerId, date, notes } = req.body;
    if (!id || !chunkId || !teacherId || !learnerId || !date) { ... }
    const event = await withWriteLock(() => prisma.teachingEvent.create({ data: { id, chunkId, ... } }));

  POST /people (lines 73-84):
    const { id, name, location } = req.body;
    if (!id || !name || !String(name).trim()) { ... }
    const person = await withWriteLock(() => prisma.person.create({ data: { id, name: String(name).trim(), ... } }));

  By contrast, routes/supplies.ts line 91-92 (validateSupplyInput):
    const idErr = checkId(input.id, 'id');
    if (idErr) throw new AppError(400, idErr);

  lib/db.ts line 34: const VALID_ID_PATTERN = /^[a-zA-Z0-9_-]{1,200}$/;
- **Reviewer notes**: The finding is accurate in all respects. The file-level comment in competencies.ts (lines 8-10) explicitly documents the "trust by default" kiosk model and says "writes are not defensively validated," but this comment refers to business-logic validation (no duplicate guard, no teacher != learner check) — not to id charset/length. The id validation gap is real and inconsistent with the pattern established in supplies.ts. Severity Low is correctly calibrated: Prisma parameterizes all queries so there is no injection risk, but an authenticated user can store arbitrary-charset or very long strings as primary keys in person and teaching_event rows.

### ARCH-8 — Global error handler logs raw err.message to telemetry/response instead of redacting secrets

- **Severity**: Low
- **Location**: app.ts:187-204
- **What**: The Express global error handler emits addBackendEvent('error', err.message, { stack }) and returns err.message verbatim for non-production, with no redactSecrets pass, so any upstream error that bubbles up uncaught (Hanos/Tebi/Notion) puts its raw message into the telemetry table and the HTTP body.
- **Why it matters**: It is the catch-all backstop for exactly the errors individual routes forgot to wrap in safeErrMsg; an unredacted credential-bearing upstream message would be persisted to telemetry and (in dev/staging/preview) returned to the client — partial regression of A13.
- **Suggested fix**: Pass err.message (and the stack) through redactSecrets before addBackendEvent and before building the client message.
- **Confidence**: Medium.
- **Verified**:

  In app.ts lines 187-204, the global error handler calls:
    addBackendEvent('error', err.message, { stack: err.stack?.slice(0, 1000), ... })
  and returns:
    const message = status >= 500 && process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message;
    res.status(status).json({ error: message });

  Neither `err.message` nor `err.stack` is passed through `redactSecrets` before being sent to `addBackendEvent` or included in the HTTP response. `safeErrMsg` (which calls `redactSecrets(errMsg(e))`) exists in lib/config.ts line 66-68 and is specifically designed for this purpose, but is not used here.
- **Reviewer notes**: The finding is real and not fixed. The global error handler is the catch-all backstop: any upstream error that individual routes did not wrap in safeErrMsg will bubble here with raw err.message. That message gets (1) persisted to the telemetry table via addBackendEvent, and (2) returned verbatim in the HTTP body when NODE_ENV != 'production' (i.e. dev, staging, preview). The severity calibration of Low is appropriate: exploitation requires an upstream service (Hanos/Tebi) to embed credentials in their error messages AND those errors must escape per-route handling — a realistic but not trivially common path. The fix is simple: replace err.message with safeErrMsg(err) in both the addBackendEvent call and the client message construction, and also redact err.stack before passing it to addBackendEvent.

### ARCH-9 — Supplies state has two divergent load shapes: /api/data includes archived rows, /api/supplies (default) excludes them

- **Severity**: Low
- **Location**: lib/db.ts:439-480 (dbReadAll loads ALL supplies incl. archived) vs public/js/supplies.ts:47-55 (loadSupplies default excludes archived) and public/js/utils.ts:259 (loadData sets S.supplies from /api/data)
- **What**: Bootstrap loadData() seeds S.supplies from /api/data which returns every supply including archived ones, but navigating to the Supplies screen overwrites S.supplies via /api/supplies which by default omits archived rows, so the same S.supplies array silently changes membership depending on which path last ran.
- **Why it matters**: Other consumers reading S.supplies (dashboard supplies card, caterings topping picker, planner inventory) can see archived supplies before the Supplies screen is opened and a different set afterward — inconsistent demand/plating views with no clear single source of truth.
- **Suggested fix**: Make S.supplies a single canonical shape (e.g. always include archived and filter at each render site, or never include archived in /api/data); have loadSupplies fetch the same shape as dbReadAll.
- **Confidence**: Medium.
- **Verified**:

  lib/db.ts:446 — dbReadAll() fetches all supplies with no archived filter: `prisma.supply.findMany({ orderBy: [{ archived: 'asc' }, { name: 'asc' }] })`, so /api/data returns archived rows.

  routes/supplies.ts:154-161 — GET /api/supplies filters by default: `where: includeArchived ? {} : { archived: false }`, so the Supplies screen gets only non-archived.

  public/js/supplies.ts:47-55 — loadSupplies() calls `/api/supplies` (no includeArchived flag), overwriting S.supplies with non-archived rows only.

  public/js/utils.ts:259 — loadData() sets S.supplies from /api/data (includes archived).

  The state divergence is real. However, every identified consumer already defends against archived rows at render time: dashboard.ts:966 filters `!s.archived`, caterings.ts:307 filters `!s.archived`, and planner.ts:1368 has its own filter logic. The inconsistency exists but is largely mitigated by per-site defensive filtering, which is why severity stays Low rather than Medium.
- **Reviewer notes**: The finding is accurate: S.supplies starts with all supplies (including archived) from bootstrap loadData(), then silently shrinks to non-archived when the Supplies screen is first visited. The practical impact is limited because the main consumers (dashboard, caterings picker) already filter !s.archived themselves. The one subtle risk is SSE patch merging in utils.ts:787-790 which merges by supplyId without filtering archived status, but this is a data-sync path not a display path. Severity Low is calibrated correctly.

### ARCH-10 — Module-level singleton write-lock remains the only concurrency guard for the new supplies/competencies JSON read-modify-write paths

- **Severity**: Nit (adjusted from Low)
- **Location**: lib/db.ts:326-333 (withWriteLock) used by routes/supplies.ts:235-304 and routes/access.ts:108-119
- **What**: The new supplies stock/prep endpoints and the access-approval find-or-create rely on the in-process withWriteLock promise chain to serialize their read-modify-write of JSON columns, which is correct for one Node process but provides no protection if the Railway dyno is ever scaled to two replicas.
- **Why it matters**: This extends the documented single-replica assumption (A8) to several brand-new write paths (supply stock JSON merge, person dedup-on-approve) without adding them to the CLAUDE.md single-replica list, so a future scale-out would silently reintroduce lost-update/duplicate-person races in code that looks safe.
- **Suggested fix**: Add the supplies stock JSON merge and the access-approval person-dedup to the documented single-replica state list; when multi-replica becomes real, switch to a Postgres advisory lock / unique constraint on Person.name.
- **Confidence**: Medium.
- **Verified**:

  lib/db.ts:541-548 — module-level singleton lock:
  ```
  let writeLock: Promise<void> | null = null;
  export async function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    while (writeLock) await writeLock;
    ...
  }
  ```
  routes/supplies.ts:243-257 and 281-297 — both stock endpoints use withWriteLock for read-modify-write of the supply.stock JSON column.
  routes/access.ts:108-119 — approve path uses withWriteLock(() => prisma.$transaction(...)) for person find-or-create dedup.
  CLAUDE.md lines 9-10 says "write locks" are single-replica state but does not name supplies or access-approval specifically.
- **Reviewer notes**: The code matches the claim precisely. Both supplies stock endpoints and the access-approval person-dedup do use withWriteLock as their only concurrency guard, and the CLAUDE.md single-replica list does not enumerate these specific paths. However, the finding is a documentation gap rather than a code defect — the existing single-replica assumption is already documented at the app level, and the lock correctly serializes within one process. There is no bug and no data-loss risk under the current single-dyno deployment. The severity "Low" claimed is slightly too high for what is purely a documentation omission; "Nit" is more appropriate. The proposed fix (add these paths to the documented single-replica list) is valid and cheap.
