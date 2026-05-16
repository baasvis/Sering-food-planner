# Batches disappearing after "Do inventory" — investigation findings

- **Date:** 2026-05-16
- **Reported by:** Daan — cooks say batches sometimes disappear after using the
  "Do inventory" button, even ones that weren't finished; the disappeared batch
  still had food in it.
- **Status:** Investigation complete; **fixes applied and verified on
  2026-05-16** — see "Resolution" at the bottom.
- **How it was checked:** reproduced in a test environment against the staging
  database, then re-verified after the fixes. See "Resolution" at the bottom.

---

## Summary — what's going on

A batch can "disappear" in **two genuinely different ways**, and the cooks are
probably hitting more than one:

1. **It is really deleted** (gone from the database). The **"Served" button**
   inside the Do-inventory modal does this — and it does it to the *whole*
   batch, with no undo.
2. **It is only hidden** (still in the database, just not on screen). Counting a
   batch down to **0** makes it drop out of the inventory modal and out of the
   location-filtered Dishes view, even though the batch still exists.

The most likely cause of *"a batch with food disappeared"* is the **"Served"
button** (Finding 1). Three other real bugs were also confirmed; one of them —
"Fix my menu" — was **ruled out** as the cause of a *had-food* disappearance.

There was **no single "bug"** — the Do-inventory flow has several sharp edges.

---

## Findings

### 1. The "Served" button deletes the WHOLE batch — most likely cause

In the Do-inventory modal, every row has a red **"Served"** button. Pressing it
runs `archiveDish` (`public/js/core.ts:535`). It:

- sets the stock at the cook's location to **0** — even if the cook still had,
  say, 5 L left. It never asks "how much is left?".
- then, if no stock remains at *any* location, **deletes the whole batch** —
  removed from the planner and from the database.

Reproduced and confirmed (unit + end-to-end against the staging DB):

| Situation | What happens today |
|-----------|--------------------|
| Batch stocked at **one** location | "Served" → whole batch **deleted from the DB** |
| Batch also has a **future service** (e.g. tomorrow's lunch) | Still deleted — the future slot silently loses its batch |
| Batch stocked at **two** locations | Kept — only the cook's location is zeroed (correct) |
| Batch has a **shipment in transit** | Kept (correct) |

This is **partly by design** — when the food is genuinely all gone, removing the
batch is correct. But four things make it bite:

1. **No undo.** Every other delete in the app gives a 5-second "Undo" toast
   (`deleteBatch` in `dishes.ts:525`). "Served" gives none — a mistaken or
   accidental tap is permanent.
2. **It discards future services.** The deletion never looks at the batch's
   planned slots. Whether that's right is a judgement call — but right now it
   happens silently.
3. **The confirmation is misleading.** The dialog says *"This will zero out the
   inventory at [location] only. Other locations … stay untouched"*
   (`core.ts` `_showRatingDialog`). It never says the whole batch will be
   removed.
4. **Easy to mis-tap.** The red "Served" button sits right next to the quantity
   box on every row — easy to hit instead of typing a count, especially on a
   phone.

Because the button forces the count to 0 regardless, a cook who presses it with
food still in the pot — to mean "this service is done" — destroys both the food
record and the batch. That matches the report exactly: *a batch with food,
gone, after inventory.*

### 2. Edits (and new batches) made during a save are silently lost

The app auto-saves ~1.5 s after a change. The save records "done" from the
*live* state **after** the server round-trip, not from what was actually sent
(`doSave` / `takeSnapshot` in `public/js/utils.ts:174`). So any change typed
**while a save is in flight** is marked as already-saved and never sent.

Confirmed: an edit made during an in-flight save is lost; **a brand-new batch
created during an in-flight save is never persisted** — it's there until the
page reloads, then gone. Doing inventory fires a burst of saves, so this races
exactly during an inventory round. The save indicator still shows "Saved".

### 3. The inventory modal mis-routes a typed quantity under live-sync

The Do-inventory modal stores each row's position in the batch's stock list. If
another cook ships or edits the same batch while the modal is open (a live-sync
update arrives), those positions go stale — the modal is not refreshed. A
quantity the cook then types lands on the **wrong stock entry**, or is silently
dropped (`updatePowerEntryQty` / `updateLocScopedQty` in `planner.ts`).

This corrupts stock numbers rather than deleting a batch — but it is real and it
happens during inventory.

### 4. "Fix my menu" deletes never-cooked batches — confirmed, but NOT this bug

"Fix my menu" auto-retires batches it thinks are spent (`findSpentBatches` in
`public/js/menu-fixer.ts:164`). It can't tell a *cooked-and-served* batch from a
*never-cooked* one — both have zero stock — so it deletes never-cooked planned
batches once their service time passes.

This is a real bug. **But it only ever deletes batches with zero stock**
(confirmed by test). Since the cooks report the disappeared batches *still had
food*, "Fix my menu" is **not** the cause of the reported disappearances. Worth
fixing, but separately and at lower priority.

---

## Deleted vs. hidden — the key distinction

The investigation set out to answer: when a batch "disappears", is it gone from
the database or just hidden? Verified by checking the database directly:

- **"Served" button → genuinely DELETED** from the database (Finding 1).
- **Counting a batch down to 0 → only HIDDEN.** It drops out of the inventory
  modal (the modal skips zero rows) and out of the location-filtered Dishes
  view (`dishes.ts:84`), but the batch is still in the database. If a cook
  expected to still see it, this looks like a disappearance with nothing
  actually lost.
- **New batch created mid-save → never written** to the database (Finding 2).
- **"Fix my menu" → DELETED**, but only zero-stock batches (Finding 4).

---

## Fix options — for you to choose (nothing changed yet)

**Finding 1 — the "Served" button** (recommended focus):
- **Add a 5-second "Undo"** to "Served", like every other delete. Smallest, highest-value change.
- **Make the confirmation honest** — say "this will remove the batch from the planner" when it will be fully removed.
- **Warn (or refuse) when the batch still has a future service** planned.
- Or, more conservative: **keep the batch at 0 instead of deleting it**, so "Served" never destroys anything — let a separate cleanup retire it later.
- **Separate the red "Served" button from the count box** so it isn't mis-tapped, especially on mobile.

**Finding 2 — lost edits during a save:** record what was actually *sent* to the
server (not the live state) when marking a save complete. No database change,
low risk.

**Finding 3 — live-sync mis-route:** refresh the inventory modal when a live-sync
update arrives, or identify rows by their contents instead of list position.

**Finding 4 — "Fix my menu":** only retire batches that were actually cooked
(needs a small "was cooked" marker on the batch), or only retire batches whose
service dates are genuinely in the past. Lower priority.

## Recommended order, if fixes are approved

1. **Finding 1** — the headline. Start with the "Undo" + honest confirmation; decide on the future-service question.
2. **Finding 2** — the save race. Self-contained, low risk, no schema change.
3. **Finding 3** — the modal mis-route.
4. **Finding 4** — "Fix my menu". Real, but not the reported symptom.

---

## The reproducing tests

All written during this investigation; all green. They are characterization
tests — they assert what the code does **today**, so the test suite stays
green. When a fix is approved, the relevant assertions flip and they become
regression tests.

- `test/inventory-disappear-investigation.test.ts` — 10 tests: the "Served"
  button (Finding 1), the save race (Finding 2), "Fix my menu" (Finding 4).
- `test/inventory-modal-stale-index.test.ts` — 2 tests: the live-sync
  mis-route (Finding 3).
- `e2e/inventory-served-disappear.spec.ts` — 2 end-to-end tests against the
  staging database: "Served" deletes the batch from the DB even with a future
  service; counting to 0 only hides it.

Run them with `npm test` (unit) and `npm run test:e2e` (end-to-end).

---

## Resolution (2026-05-16)

Daan reviewed the findings and approved the fixes; all are now applied and
verified.

- **Finding 1 — the "Served" button:**
  - Added a 5-second **Undo** to "Served" (`archiveDish`), matching every other
    delete in the app.
  - Made the confirmation dialog **honest** — when the batch's last stock is
    being served it now says the whole batch will be removed.
  - **Blocked counting a quantity down to 0** in the inventory modal; the cook
    is told to use the "Served" button instead.
  - By Daan's decision, archiving a batch that still has a *future* service is
    left as-is (silent) — deliberately not changed.
- **Finding 2 — lost edits during a save:** `doSave` now snapshots exactly what
  it sent (before the await), so an edit — or a new batch — made during an
  in-flight save survives and is sent on the next save.
- **Finding 3 — live-sync mis-route:** an open inventory modal is now refreshed
  when a live-sync patch arrives, so its embedded row indices can't go stale.
- **Finding 4 — "Fix my menu":** retirement now uses a date-only "past" check
  (`isServiceDatePast`), so a batch scheduled for today is never auto-retired —
  even right after inventory. Residual: a never-cooked batch whose service
  dates are all genuinely past can still be retired. Fully telling "never
  cooked" from "cooked then served" apart would need a small new field on the
  batch (a DB migration) — deferred; raise it if the residual matters.

**Verification:** `npm run typecheck` clean; full unit suite **364/364**; the
e2e (`e2e/inventory-served-disappear.spec.ts`, 3 tests) passes against a fresh
build on the staging DB. The reproducing unit tests
(`test/inventory-disappear-investigation.test.ts`,
`test/inventory-modal-stale-index.test.ts`) were updated from characterization
tests into regression tests for the fixed behaviour.

**Files changed:** `public/js/core.ts`, `public/js/planner.ts`,
`public/js/utils.ts`, `public/js/menu-fixer.ts`, `public/js/main.ts`.
