# Follow-ups & Open Questions

This is the catch-all for things I noticed but didn't fully chase, things that
need a runtime check I didn't perform, and questions for Daan.

## Things I didn't have time to verify

### Runtime / live-server checks
- **U1-U3, U6 (a11y)** — I did not run axe-core or NVDA against a live build. The findings are based on reading markup; an actual screen-reader pass would surface more (and might confirm/refute my severity calls).
- **P15 (mobile font sizes)** — claims of "8px is unreadable" are based on Apple HIG / Google Material guidance; not validated against actual phones. A 5-minute pass on iPhone SE / mid-range Android would confirm.
- **P17 (SSE keep-alive vs Railway proxy idle)** — I asserted 30s might be too aggressive; verifying needs a `curl -N /api/events` from outside Railway and waiting to see if the connection drops.
- **U4 (viewport blocking pinch-zoom)** — confirmed in the markup, but I didn't test that pinch is actually blocked on iOS Safari or Android Chrome with current browser policies.

### Dependency / lockfile
- **D1 (lockfile gitignored)** — I generated a temporary lockfile to run `npm audit`, then deleted it. I did not test whether re-running CI with a committed lockfile and `npm ci` would surface install errors. Likely fine but worth verifying in a one-off PR.
- **D2 (xlsx CVEs)** — npm reports `fixAvailable: false` because SheetJS moved to CDN. I didn't verify the migration cost (whether `exceljs` API maps cleanly to current `XLSX.read(file.buffer, { type: 'buffer' }).Sheets['prices']` usage in [routes/ingredients-import.ts:97-104](routes/ingredients-import.ts)).
- **D6 (Playwright postinstall)** — I didn't measure the actual install time savings of skipping Chromium download for non-CI/non-prod paths.

### Secrets / git history
- **S1 (committed DB creds)** — I confirmed the strings exist in current files and at least one historical commit. I did NOT do a full historical sweep of every branch and tag. If the repo has feature branches with their own copies, those need cleanup too. A `git log --all --full-history -p` grep for the password substrings should catch them.
- **S1 password rotation** — depends on whether you can take a brief read-only window on prod to rotate. Not a blocker for the rotation itself, just timing.

### Frontend depth
- I did NOT read end-to-end the seven > 1000 LOC frontend modules (`orders.ts`, `recipe-editor.ts`, `menu-fixer.ts`, `ingredient-db.ts`, `planner.ts`, `dishes.ts`, `dashboard.ts`). The audit reads excerpts and reasons from patterns. Specific bug-class findings inside those files (esp. `menu-fixer.ts`'s pot-allocation algorithm and `recipe-editor.ts`'s scaling math) are out of scope.
- **`menu-fixer.ts`** has its own test file (778 LOC) so the algorithmic core is covered. The UI rendering / interaction layer is not.
- **Shared `core.ts:getGuests`** ([public/js/core.ts:110-147](public/js/core.ts)) — the week-key fallback logic looks subtle; I noted but didn't audit. Worth a deeper look during any planner-related refactor.

### Backend depth
- **`hanos-client.ts`** — I read the OAuth flow but didn't audit the formatProduct nutrition/allergens parsing (lots of `feat.code as string` casts that could silently misread upstream changes).
- **`tebi-scraper.js`** (24310 bytes) — I did not read the Playwright scraper itself. It's the most fragile piece in the system (depends on Tebi's HTML structure). Worth its own audit pass.
- **`scripts/import-storage-locations.js`, `scripts/migrate-ingredients.js`, `prisma/archive/*`** — unread. Comment in CLAUDE.md says "read the file headers before running"; I did not.

### Tests
- **Coverage % numbers** — I cited "8 of 12 trackEvent features covered" but did not run actual test coverage tools (Istanbul / c8). Real line/branch coverage would tell a fuller story.
- **The weekly-coverage Claude Code agent** — I read its config but did not audit its prompt at [.claude/agents/weekly-test-coverage.md](.claude/agents/weekly-test-coverage.md). If the agent quality is degrading, that's a separate concern.

## Things I noticed but didn't write up

### Likely real, low priority
- **`public/js/orders.ts:1539`** uses the same fire-and-forget stock-save pattern as `ingredient-db.ts:167` (covered as T4). Two sites of the same bug.
- **`public/js/ingredient-db.ts:613,1416`** uses native `confirm()` — covered globally as U5; flagging here because they're the two I noticed.
- **`public/js/init.ts:100-104`** has an interesting wheel-blur handler with `(passive: true)` *and* a typed `(e: any)`. The `any` could be `WheelEvent`.
- **`shared/types.ts:188`** — `RecipeFull.type: DishType | string` — the union with `string` defeats the literal-type-narrowing benefit of `DishType`. Probably intentional (legacy data) but worth noting.
- **Prisma schema [prisma/schema.prisma:148-149](prisma/schema.prisma)** — `GuestHistoryMeta.value: String` is an `@id String @id` text key. PG text columns have no length limit; with the `flowDistribution` storing JSON, that field can grow unboundedly.

### Probably non-issues but flagging
- **`addBackendEvent`** is sync (no await) — pushes to in-memory buffer. If buffer is full it silently drops. Already noted. Worth confirming the dropped-event count isn't masking signal.
- **The recipe `extraAllergens` array** has a 50-item cap but no per-string length cap inside ([lib/db.ts:832](lib/db.ts)). Cosmetic.
- **The `bigBurnerThreshold` validation** ([routes/inventory.ts:88](routes/inventory.ts)) accepts 1–1000L, but ranges < pot-min would be useless. Soft validation.
- **The scheduled-AI-analysis cron timezone** — `process.env.AI_ANALYSIS_CRON || '0 7 * * *'` — node-cron defaults to system timezone. Railway containers default to UTC. So "07:00" is UTC, which is 08:00–09:00 Amsterdam. Worth checking what Daan expected.

### Documentation gaps I noticed
- **CLAUDE.md** doesn't mention the 60s background interval in `init.ts` that re-renders. Future contributors will be surprised.
- **No `CONTRIBUTING.md`** — small team, OK for now. If contributors expand, the implicit "ask Daan" model breaks.
- **`SETUP_GUIDE.md`** is good but doesn't mention the test DB setup steps that are buried in CLAUDE.md.
- **Storage areas have a `color` field** ([shared/types.ts:38](shared/types.ts)) but no documented constraint on values. UI uses arbitrary hex; could break if someone enters invalid CSS.

## Open questions for Daan

These are the questions where my recommendation depends on a fact only you have:

1. **(S1) Has either DB password been rotated since the script was committed?** If yes, the historical exposure is closed; if no, it's still live. Either way, the git-history scrub is the right next step.
2. **(D2) Is the XLSX upload critical-path or once-a-quarter?** If quarterly, switching to the SheetJS CDN package is fine; if daily, switching to `exceljs` (more disruptive) might be better long-term.
3. **(A5) Is `RecipeIndex` (legacy v1 recipes) safe to drop?** CLAUDE.md says "kept until Recipe v1 sunset" — what's the gate?
4. **(U16) What's the language policy?** English UI, Dutch error messages — is that intentional or mid-migration?
5. **(D14) Could the Tebi scraper move to a separate worker dyno?** If yes, the production container shrinks dramatically (no Chromium, no Playwright).
6. **(P9) Lazy-loading screens** — would breaking the initial bundle change Daan's mobile experience meaningfully? Worth a measurement before committing to the refactor.
7. **(S3, S4) Strict deploy guards** — "refuse to start without `GOOGLE_CLIENT_ID` in production" — would this break any current dev/staging workflow that intentionally runs without auth?
8. **(T4) Does the kitchen team trust the inline stock numbers as-saved or do they verify on next reload?** If they verify, the silent-failure bug rarely hits them; if they trust, it's a real risk.

## Things I declared "good" that you might want to re-examine

A few "what looked good" items I want to flag as possibly-worth-revisiting:
- The `redactSecrets` helper has unit tests and is used in the right places, but its regex set is small. A new credential format (e.g. AWS-style `AKIA…` keys, GitHub tokens `ghp_…`) would slip through. Worth thinking about as new integrations land.
- The test/setup-env production-DB guard checks one host fragment. If you ever add a second prod host (separate write-replica?), it needs updating; the `PROD_HOST_FRAGMENTS` array is the right place but trivial to forget.
- The "single-replica" assumption is documented in CLAUDE.md but spread across many code paths (sessions, write-lock, telemetry buffer, SSE registry, Hanos client cache, Tebi sync supervisor). A single doc-comment in `app.ts` listing all of them would prevent future inadvertent multi-replica deployment.

## Things I would prioritise if I had another night

1. ~~Read the four big frontend modules (`orders.ts`, `recipe-editor.ts`, `menu-fixer.ts`, `ingredient-db.ts`) end-to-end. There's likely 5-10 more findings of UI bug class hiding in there.~~ **Done in Round 2.** Surfaced ~14 new findings, including one **High** (T18 — broken stock-deduction in batch recipe save).
2. ~~Run a real `npm audit` after generating a clean lockfile, then trace each transitive vulnerability to a code path. The current audit is shape-only.~~ **Done in Round 1.** No new info from re-running.
3. Stand up a local dev server and run axe-core + a real screen reader pass against the dashboard / planner / orders. Concrete a11y findings. **Still pending — needs runtime.**
4. Trace the `S.batches` reactivity model across all the call sites of `rebuildPlanner` / `rerenderCurrentView` / `scheduleSave` / `pushUndo`. There's likely a state-management foot-gun in there I'd want to find before recommending lazy-loading (P9). **Partly done — Round 2 confirmed many call sites; the patterns are consistent enough that a single state library swap is plausible. Not done: full reactivity graph.**
5. ~~Audit the Tebi Playwright scraper as a separate unit. It's the most fragile failure mode and least understood.~~ **Done in Round 2.** Findings A21, P21, P24, S20, T21.

---

## Round 2 follow-ups (new "I didn't get to" items)

1. **Verify the T18 stock-deduct shape mismatch in production telemetry.** Search backend telemetry for 400 responses to `/api/ingredients/stock/bulk` from `recipe-editor` source. If they exist, the bug has been firing; if not, the user might never have used the deduct toggle.
2. **Test that the A17 `S.recipeIndex` empty-state bug is actually visible.** I read the code; I didn't open the planner Add Dish modal in a live session. Worth a 30-second sanity check before opening the fix PR.
3. **Verify A21/S22 process.env mutation is safe.** Reading the code, the `try { ... } finally { restore }` wrapping ensures the env vars are restored — but if the spawn child crashes hard mid-run, the parent process inherits the temporarily-mutated env. Probably safe in the worker child process; worth verifying `tebi-sync.ts` doesn't read `TEBI_EMAIL` after spawn returns.
4. **Hanos allergen detection (S19) — what does Hanos ACTUALLY return?** The English-only "with"/"without" heuristic is a real bug only if Hanos returns Dutch. I haven't called the Hanos API to verify. A 5-minute test against a known product (e.g. wheat flour, which has gluten) would confirm.
5. **The 60s background interval (P10) reactivity behaviour after a screen change.** I noted multiple intervals after logout-login; the behaviour after `setInterval`-driven render is also worth checking — does it re-render whatever screen is active even if the user just navigated away mid-fetch?

---

## Things I noticed in Round 2 but didn't write up

These are minor or speculative; flagging for future passes:

- **`addRecipeToSlot` and `replaceWithRecipe`** in `planner.ts` are dead code (never called from any working path), but still on `window` for inline-onclick. Could be deleted along with the A5 sunset.
- **`renderCateringDishPicker` in `caterings.ts:146-202`** uses `S.batches.find(x => x.id === d.dishId)` inside a forEach to look up dish details — `S.batches` is up to 200 items so the linear scan is N×M. Cosmetic at this scale; prepare a Map<id, batch> if it ever lags.
- **`hanosLookupProduct` (`ingredient-db.ts:870-928`)** writes Hanos API response fields directly into form inputs. If a malicious Hanos response set `product.name = '<script>...'`, the `setVal` would write that as the input's `.value` (which is safe — input values are not parsed as HTML). But the success status line at 920 does `<span style="color:var(--green);">✓ ${esc(product.name)}</span>` — correctly escaped. OK.
- **`recipe-editor.ts` `_brState` is module-level** — opening two batch recipes in quick succession (e.g. via SSE patch triggering a re-render that reopens the modal) could read the wrong batch. Edge case.
- **Stocktake area-picker calls `getIngredientsForArea(area.name)` once per area** at render — for 7 areas that's 7 calls, each doing `buildCombinedOrderData()` which iterates batches + standard inventory. O(areas × batches × ingredients). Memoize `buildCombinedOrderData()` once per render.
- **`brSave` `actualIngredients` rounding**: amounts are stored as floats; with `roundForUnit` in the editor this is OK, but `toGrams(ai.amount, ai.unit)` for stock deduction (assuming the bug is fixed) loses precision when amounts cross unit boundaries.
- **`_keqDraft` in menu-fixer** — kitchen equipment editor's working copy. Safe by accident: `openKitchenEquipmentModal` always re-initializes from `S.kitchenEquipment` so previous draft state doesn't leak.
- **Tebi `formatProductRevenue`** has a fallback "Invoice Total" path for invoices with no line items. With many invoices having only a total (no items), the fallback path becomes the dominant data shape and the analysis loses product-level granularity. Currently logged as `productCategory: 'Other'`; could be improved.
- **`fetchTebiAPI._authHeader = null` reset between accounts** is good, but `_cookie` is also a fallback. Resetting both correctly. Flagged for awareness only.

---

## Round 2 verification checklist (things to confirm before acting on the fixes)

For the new High finding (T18 broken stock-deduct):
- [ ] Open the recipe editor for a batch with a v2 recipe.
- [ ] Check the "Deduct from stock" box.
- [ ] Save.
- [ ] In browser devtools Network panel, confirm `POST /api/ingredients/stock/bulk` returns 400.
- [ ] Confirm the user-facing UX is silent (no toast).
- [ ] Decide which fix path (frontend or backend) is least risky.

For the elevated A17 (S.recipeIndex empty in three surfaces):
- [ ] Open planner → click "+" on any slot → switch to "Recipes" tab. Confirm it's empty.
- [ ] Open dishes overview → click "+ New batch" → search field. Confirm "No recipes in index yet."
- [ ] Decide between "patch with S.recipes" (quick) and "sunset Recipe v1" (preferred).

