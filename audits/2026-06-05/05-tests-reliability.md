# Tests & Reliability

## Scope of review

This pass audited test coverage and reliability for the rewritten `orders.ts`, the Fix-My-Menu regression bench, the Supplier XLSX path, the Competencies write endpoints, and the new write-flow screens (Supplies, Team/access, recipe-AI), plus silent save-failure paths. Findings are sorted by adjusted severity.

## Findings

### TEST-1 — Batch orderFor toggle silently lost on save failure (console.warn only) in rewritten orders.ts

- **Severity**: Medium
- **Location**: public/js/orders.ts:631-641 (persistBatchOrderFor), called fire-and-forget from :663 and :681
- **What**: persistBatchOrderFor() optimistically sets batch.orderFor in local state then PATCHes /api/batches/:id, and on failure only does console.warn('Failed to save batch orderFor', e) with no toast/save-state update, so a failed save leaves the UI showing the toggle as applied while the server never recorded it.
- **Why it matters**: orderFor is the server-persisted flag that controls whether a batch's ingredients are included in the Hanos order; a cook toggling a batch into the order during a kitchen network blip sees it 'stick', but it reverts on next reload (initBatchIngredientToggles re-reads !!b.orderFor) and the ingredients get under-ordered — silent data/decision loss. This is the exact T4 silent-write class the team fixed elsewhere in the SAME file (orders.ts:1571-1580 explicitly cites the T4 audit and pipes to toastError); this call path was missed in the orders.ts rewrite.
- **Suggested fix**: Await the PATCH and route the catch through toastError (and ideally revert the optimistic batch.orderFor / re-tick the toggle on failure), mirroring the T4 fix at orders.ts:1579. At minimum replace console.warn with toastError so the cook knows the toggle didn't save.
- **Confidence**: High.
- **Verified**:

  Lines 630-641 in public/js/orders.ts show the exact pattern described:

  ```ts
  async function persistBatchOrderFor(batchId: string, orderFor: boolean) {
    // Update local state immediately
    const batch = S.batches.find(b => b.id === batchId);
    if (batch) batch.orderFor = orderFor;
    // Save to server
    try {
      await apiPost(`/api/batches/${batchId}`, { orderFor }, 'PATCH');
    } catch (e) {
      console.warn('Failed to save batch orderFor:', e);
    }
  }
  ```

  The optimistic state mutation (`batch.orderFor = orderFor`) happens before the PATCH, and the catch block only does `console.warn`. No toast, no state rollback. Called fire-and-forget at line 663 (`persistBatchOrderFor(batchId, isOn)`) and line 681 (`persistBatchOrderFor(b.id, !!on)`).

  The T4 fix the claim references is at lines 1570-1581 and explicitly comments on the pattern: "apiPost throws on non-2xx (instead of the bare-fetch silent fail the audit flagged as T4) — pipe to toastError so a kitchen-network blip is visible instead of a UI value that 'looks saved' but never persisted." The `persistBatchOrderFor` path was not updated with the same treatment.
- **Reviewer notes**: The claim is accurate in every detail. The code at the cited location matches the described pattern exactly. The severity of Medium is appropriate: the failure mode (silent data loss on network error, state reverts on reload) is real and affects ordering decisions, but it requires a network blip during the exact toggle window to trigger. No mitigation is present — the T4 fix comment in the same file makes the inconsistency particularly clear.

### TEST-2 — e2e navigation smoke test silently skips the new Supplies and Team screens (drifted hand-copy of NAV_SCREENS)

- **Severity**: Low (adjusted from Medium)
- **Location**: e2e/navigation.spec.ts:4-16 vs public/js/state.ts:92-113
- **What**: navigation.spec.ts hardcodes a NAV_SCREENS list of 8 ids whose comment claims it 'Mirrors NAV_SCREENS in public/js/state.ts', but the real array now also contains 'supplies' (Toppings & bread) and 'team', neither of which is in the e2e copy, so the 'every nav screen renders without console errors' test never visits them.
- **Why it matters**: The supplies screen is an entirely new write-flow screen and the batch-construction.test.ts file documents that screen modules have shipped throw-on-load regressions before; a render crash on the supplies or team screen would pass CI because the only screen-render smoke test skips both. The screen even has data-testid="supplies-new" wired (orders/supplies markup) anticipating e2e that was never written.
- **Suggested fix**: Either import the real NAV_SCREENS array (or its ids) into the spec instead of duplicating it, or add 'supplies' and 'team' to the list and assert each renders non-empty without console errors; long-term, derive the e2e screen list from the source array so it can't drift again.
- **Confidence**: High.
- **Verified**: e2e/navigation.spec.ts lines 7-16 hardcodes 8 ids (dashboard, guests, planner, recipe-index, orders, competencies, finance, feedback-admin). public/js/state.ts lines 92-113 NAV_SCREENS has 10 entries including `{ id: 'supplies', topLabel: 'Toppings & bread', ... }` (line 105, no directorOnly) and `{ id: 'team', ..., directorOnly: true }` (line 111). Neither is in the e2e copy. The `supplies` screen gap is real and untested. The `team` gap is mostly moot since e2e runs as a non-director dev user and buildNav() would not render that nav button, so the `.nav-btn[data-screen="team"]` click would fail to find the element regardless.
- **Reviewer notes**: Severity is adjusted down from Medium to Low. The `supplies` gap is real — a render crash there would silently pass the navigation smoke test. However, the `team` gap is not actionable in the current e2e setup because the dev-login user is not a director and that nav button is filtered out by buildNav(). The finding's framing as "two missing screens" overstates the impact; only the `supplies` screen is a genuine untested regression surface. Still worth fixing by adding `supplies` to the e2e list.

### TEST-3 — fmm-bench regression guard re-lists the production pipeline instead of calling _fixMyMenuBody(), so it can drift silently

- **Severity**: Low
- **Location**: bench/menu-fixer/run-pipeline.ts:26-59 (runFixMyMenu) vs public/js/menu-fixer.ts:1191-1320 (_fixMyMenuBody)
- **What**: runFixMyMenu() in the bench manually re-invokes each pipeline phase (stripFutureServices, generateMissingPlaceholders, teamFillBigSlots, forcedAssignmentPrePass, scoredGreedyAssignment, runFallbackLadder) rather than calling the real _fixMyMenuBody(), and the two have already diverged in detail — the bench hardcodes the plan filter as (b.type==='Soup'||b.type==='Main course') (line 41) while production filters on TYPES_TO_PLAN.includes(b.type) (menu-fixer.ts:1267).
- **Why it matters**: The bench's whole purpose is to catch Fix-My-Menu regressions, but because it scores a private re-implementation of the pipeline, a change to phase order/composition in _fixMyMenuBody (e.g. inserting a new phase or reordering rebuildPlanner calls) would not be exercised by the guard — it would keep passing while production behaviour changed. The hardcoded type list is currently equivalent (TYPES_TO_PLAN===['Soup','Main course']) so it is latent, not yet a live miss.
- **Suggested fix**: Refactor _fixMyMenuBody so its pure core (everything except the loading-spinner/setTimeout/save) is an exported function the bench can call directly, then have runFixMyMenu invoke it; failing that, at least replace the bench's hardcoded type literal with the imported TYPES_TO_PLAN to remove the existing duplication.
- **Confidence**: High.
- **Verified**:

  bench/menu-fixer/run-pipeline.ts line 41:
    const planBatches = () => S.batches.filter(b => b.cookDate && (b.type === 'Soup' || b.type === 'Main course'));

  vs production menu-fixer.ts line 71 + lines 1267/1274/1286:
    export const TYPES_TO_PLAN: DishType[] = ['Soup', 'Main course'];
    ...
    S.batches.filter(b => b.cookDate && TYPES_TO_PLAN.includes(b.type))

  TYPES_TO_PLAN is exported from menu-fixer.ts but the bench does not import it. The bench re-implements all pipeline phases manually (run-pipeline.ts lines 26-59) rather than calling _fixMyMenuBody(). The values are currently equivalent so no live miss exists, but the divergence is latent.
- **Reviewer notes**: The finding is accurate in all details. The bench manually sequences each pipeline phase (stripFutureServices, generateMissingPlaceholders, teamFillBigSlots, forcedAssignmentPrePass, scoredGreedyAssignment, runFallbackLadder) instead of calling the real _fixMyMenuBody(). The hardcoded type literal on line 41 could silently diverge if TYPES_TO_PLAN is ever extended. Severity Low is calibrated correctly — it is a latent maintenance hazard rather than a currently-failing guard.

### TEST-4 — Supplier XLSX upload parsing logic remains untested (prior T14 still open)

- **Severity**: Low
- **Location**: routes/ingredients-import.ts (POST /api/ingredients/upload-supplier); only coverage is test/xlsx-api-smoke.test.ts
- **What**: The only XLSX test (xlsx-api-smoke.test.ts) exercises the library API round-trip (XLSX.read + sheet_to_json) and never imports routes/ingredients-import.ts, so the actual column-mapping / Hanos-export parsing / applySupplierUpdate path that turns an uploaded file into ingredient price updates has no test.
- **Why it matters**: This is the integration boundary with the highest upstream-shape-change risk (Hanos can rev their export format) and it drives recipe-cost recalculation across the catalog; a parser regression or a Hanos format change would surface only as a user noticing prices stopped updating. Prior audit flagged this as T14 and it is still open after the orders/ingredient-db rewrite.
- **Suggested fix**: Commit a small real-shaped sample XLSX under test/fixtures/ and add a supertest (or a unit test of the parse helper) asserting the parsed ingredient rows / price updates match expected output, so a format drift fails CI.
- **Confidence**: High.
- **Verified**: test/xlsx-api-smoke.test.ts comment on line 9: "Stays in its own file so it doesn't pull in app/prisma — these tests exercise the library only." The test uses generic header/row data with no Hanos column names. routes/ingredients-import.ts contains the actual column-mapping logic at lines 52–98 (col('title'), col('artikelnummer'), col('stukprijs'), col('hoeveelheid'), col('categorie'), month-column regex /^[A-Z][a-z]{2}-\d{2}$/, nutrition columns, parseHanosQuantityGrams call) — none of which appears in any test file. Grep for 'upload-supplier|ingredients-import' across test/ returns zero matches.
- **Reviewer notes**: The finding is accurate. The xlsx smoke test is a library-API regression guard (verifying the CDN build of xlsx 0.20.3 didn't break XLSX.read + sheet_to_json), not a coverage test for the Hanos-export parsing path. The actual integration risk — Hanos changing their Dutch column headers, the month-column regex, or the price/nutrition field format — is entirely untested. The severity of Low is appropriate: this is a silent-regression risk rather than a security or data-loss issue, and the breakage would be user-visible as prices not updating rather than data corruption.

### TEST-5 — Competencies write endpoints accept unvalidated client-supplied ids (no checkId), unlike every sibling route

- **Severity**: Low
- **Location**: routes/competencies.ts:38-55 (POST /events) and :73-84 (POST /people)
- **What**: POST /api/competencies/events and POST /api/competencies/people write req.body.id (and chunkId/teacherId/learnerId for events) straight to the primary key with only a truthiness check, never calling checkId(), whereas supplies.ts and the ingredient bulk path validate ids against VALID_ID_PATTERN (/^[a-zA-Z0-9_-]{1,200}$/).
- **Why it matters**: A hand-crafted POST can plant arbitrary-charset / unbounded-length primary keys (the route comment calls this 'trust by default'). Impact is bounded today — the competencies frontend escapes all ids/names with esc() and looks them up via dataset (no onclick interpolation), and TeachingEvent FKs reject bad chunk/teacher/learner references with P2003 — so it is not an XSS or corruption vector right now, but it is the same unvalidated-id class the team deliberately closed for ingredients (T20/S2) and there are no negative-path tests guarding it.
- **Suggested fix**: Call checkId() on id/chunkId/teacherId/learnerId at the top of both handlers (return 400 on failure) and add a couple of negative-path tests; cheap and brings competencies in line with supplies/ingredients.
- **Confidence**: High.
- **Verified**: routes/competencies.ts lines 38-55 (POST /events): validates only with `!id || !chunkId || !teacherId || !learnerId` truthiness checks; no checkId() call on any field. Lines 73-84 (POST /people): validates only with `!id || !name` truthiness; no checkId() call. The file header at line 8 explicitly states "Trust by default (kiosk model): writes are not defensively validated." Contrast with routes/supplies.ts line 10 which imports checkId and calls it at lines 91, 186, 208, 236, 274 — and VALID_ID_PATTERN = /^[a-zA-Z0-9_-]{1,200}$/ in lib/db.ts line 34 is what checkId validates against.
- **Reviewer notes**: The finding is accurate as stated. Both POST handlers accept client-supplied ids with only a truthiness check, skipping the VALID_ID_PATTERN validation used by sibling routes. The impact is bounded: FK constraints (P2003) reject bad chunkId/teacherId/learnerId references, and the frontend escapes all rendered ids, so there is no XSS or corruption path today. The fix is straightforward — import checkId in competencies.ts and call it on id/chunkId/teacherId/learnerId at the top of each handler.

### TEST-6 — fmm-bench mean-score floor (22000) sits far below the actual mean (~30k), so a large score regression still passes

- **Severity**: Low
- **Location**: test/fmm-bench.test.ts:89-92
- **What**: The 'mean objective score holds above the post-fix floor' assertion checks mean >= 22000, but the live run produces per-fixture scores around 28.9k-33.3k (mean ~30k), so roughly a 25%+ objective-score regression would pass this assertion untouched.
- **Why it matters**: The score-floor test reads as a regression guard but is loose enough that only a catastrophic scoring collapse trips it; the genuinely tight guards are the missed-matches (<=1) and fill (>=90%) assertions. A moderate scoring regression (e.g. more leftover surplus, worse oldest-first ordering) that didn't create empty slots could ship green, contrary to the test's stated intent.
- **Suggested fix**: Tighten the floor to track the observed mean (e.g. >= 27000) or assert per-fixture floors close to current values, so a meaningful objective regression fails; keep the missed/fill assertions as the primary guards.
- **Confidence**: Medium.
- **Verified**:

  test/fmm-bench.test.ts line 89-92:

    test('mean objective score holds above the post-fix floor', () => {
      const mean = results.reduce((s, r) => s + r.score, 0) / results.length;
      expect(mean).toBeGreaterThanOrEqual(22000); // post-fix mean ~23.5k; floor catches big regressions
    });

  The comment itself admits the post-fix mean was already ~23.5k when the floor was set at 22000 — the floor was loose even at the time of authoring. Score improvements in subsequent PRs (#87-90 visible in git log, covering FMM team-fill and cooked-first fixes) have likely pushed the live mean higher still (toward the ~30k claimed in the finding). The floor at 22000 is now well below actual, meaning a ~25–27% scoring regression would still pass. The finding is accurate: a moderate scoring regression that doesn't produce empty slots or missed matches would not trip this assertion. The severity is correctly Low because the tighter guards (missed-matches <= 1, fill >= 90%, hardFails == 0) cover the operationally critical failure modes.
- **Reviewer notes**: The finding is confirmed as written. The floor value (22000) is demonstrably below even the inline-documented baseline (~23.5k), and subsequent code improvements widen the gap further. Tightening to >= 27000 or adding per-fixture floors close to observed values would make the test meaningfully sensitive to objective-score regressions, as proposed. Severity Low is appropriate: the primary regression protection comes from the missed-matches and slot-fill assertions, not this score floor.

### TEST-7 — New write-flow screens (Supplies, Team/access, Recipe-AI assistant) have no end-to-end coverage

- **Severity**: Low
- **Location**: e2e/ (no supplies.spec.ts / team.spec.ts / recipe-ai spec; competencies.spec.ts exists)
- **What**: Of the new screens added since the prior audit, only competencies has an e2e spec; the Supplies screen (full CRUD + prep/stock writes), the director-only Team/access-review screen (approve/deny/revoke), and the Recipe-AI assistant have no Playwright coverage, and the navigation smoke test also skips supplies/team (see TEST-2).
- **Why it matters**: These are exactly the high-stakes, recently-added user flows (supplies stock writes feed prep planning; access approval grants login) where a frontend regression would be invisible to the unit suite, which is the gap the prior audit's T24 (production-login outage) warned about for un-e2e'd flows. Supplies markup already ships data-testid hooks that no spec uses.
- **Suggested fix**: Add at least a supplies create+prep+delete spec (testids already present) and a team approve/revoke spec driven via dev-login + a director email; defer recipe-ai (needs a stubbed Anthropic key) but cover the screen-renders-without-error path.
- **Confidence**: High.
- **Verified**:

  1. e2e/ folder (confirmed via Glob): no supplies.spec.ts, team.spec.ts, or recipe-ai.spec.ts exist.

  2. e2e/navigation.spec.ts lines 7-16 has a hardcoded NAV_SCREENS array that omits both 'supplies' and 'team':
    const NAV_SCREENS = ['dashboard','guests','planner','recipe-index','orders','competencies','finance','feedback-admin']

  3. public/js/state.ts lines 105-112 shows both screens ARE in the real NAV_SCREENS:
    { id: 'supplies', topLabel: 'Toppings & bread', ...}
    { id: 'team', topLabel: 'Team', ..., directorOnly: true, }

  4. public/js/supplies.ts line 70: data-testid="supplies-new" exists (the "+ New item" button) but no spec references it.

  5. public/js/team.ts line 142: data-testid="access-rename-modal" exists in team code, also uncovered by any spec.

  6. public/js/recipes.ts line 57: data-testid="recipe-ai-btn" exists for the AI assistant, also uncovered.
- **Reviewer notes**: The finding is accurate on all counts. The navigation smoke test's NAV_SCREENS list is a static copy that was not updated when supplies and team screens were added, so both silently skip those renders. The supplies and team frontend code already ships data-testid attributes that no spec exercises. The severity calibration of Low is appropriate: these are missing-coverage gaps, not active bugs — the unit/API test suite cannot catch frontend regressions in these flows.
