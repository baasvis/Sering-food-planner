# Plan: Fix My Menu

**Date**: 2026-05-01
**Status**: Ready for build
**Supersedes**: `2026-05-01-fix-my-menu.md` (in Downloads)
**Target**: Frontend algorithm in `public/js/`, one Prisma migration for `Batch.generated`

---

## 1. Problem

Building a 10-day menu for 2 locations × 2 services/day × (2 soups + 2 mains) per service is tedious manual work. Cooks either spend excessive time planning, or under-plan and cause Centraal stockouts and waste.

A single button should:

1. Generate placeholder Batches for the cook events that should exist this week.
2. Assign every future service slot to the right Batches: 2 soups + 2 mains, drawn first from cooked stock that needs to be finished, then from the freshest planned cooks.
3. Flag what humans need to look at: under-filled slots, projected stockouts, stale food, caterings without dishes.

After running, cooks replace placeholders with real recipes at their own pace using the existing Replace flow.

---

## 2. Existing Code (use as-is — do not refactor)

### Helpers — confirmed to exist where stated

| Helper | Location | Purpose |
|---|---|---|
| `addPlaceholderDish()` | [planner.ts:695](../../public/js/planner.ts:695) | Reference for placeholder shape — but has a bug, see §6 |
| `replaceWithRecipe()` | [planner.ts:890](../../public/js/planner.ts:890) | Cook's manual replace flow — unchanged by this feature |
| `copyDayToOther()` | [planner.ts:451](../../public/js/planner.ts:451) | Adds service entries for the other location |
| `calcRequired(batch)` | [core.ts:146](../../public/js/core.ts:146) | Liters needed across services + caterings (already handles catering demand) |
| `calcRequiredForLoc(b, loc)` | [dishes.ts:806](../../public/js/dishes.ts:806) | Per-location liters |
| `getGuests(loc, date, meal)` | [core.ts:107](../../public/js/core.ts:107) | Resolves guest count, falls back nextWeeks → predictions → base |
| `isServicePast(s)` | [core.ts:11](../../public/js/core.ts:11) | True if service slot is in the past |
| `isBatchCooked(b)` | [core.ts:43](../../public/js/core.ts:43) | True if `stock > 0` |
| `isDishStale(b)` | [dishes.ts:611](../../public/js/dishes.ts:611) | True if cooked 3+ days ago and not frozen |
| `sortByCookDate(arr)` | [core.ts:94](../../public/js/core.ts:94) | Ascending cookDate |
| `cleanCateringRefs(oldId, newId)` | [dishes.ts:431](../../public/js/dishes.ts:431) | Updates catering pointers when a Batch is replaced |
| `newId()` / `scheduleSave()` / `toast()` | utils.ts | Standard utilities |
| `rebuildPlanner()` / `rerenderCurrentView()` | core.ts / navigate.ts | Refresh the world |

### Data model

- `Batch` ([shared/types.ts:54](../../shared/types.ts:54)) — physical container of food. Lifecycle PLANNED → COOKED → SERVING → DONE.
- `Service` = `{loc: Location, date: "YYYY-MM-DD", meal: Meal}` — embedded as JSON array in each Batch.
- A single Batch serves both locations via multiple service entries. The transport split (`inTransit`, `parentId`) happens later operationally — not part of menu planning.
- `S.planner` — derived index keyed `"${loc}-${date}-${meal}"` → `Batch[]`. Rebuilt by `rebuildPlanner()`.
- `Catering` / `CateringDish` ([shared/types.ts:27](../../shared/types.ts:27)) — `dishes[].dishId` references Batch by id. `calcRequired` already includes catering demand at lines 156–163 of core.ts.

### Existing button row

[planner.ts:105](../../public/js/planner.ts:105) `renderLocationPlan()` has a `btn-row` with "+ New batch" and the inventory button. The new button slots in here, but only on the **West tab** — Fix My Menu plans both locations + caterings globally and is operated from West.

---

## 3. Algorithm

### 3.1 Constants (top of `menu-fixer.ts`)

```typescript
const COOK_RHYTHM: Record<string, { soup: number; main: number }> = {
  Sun: { soup: 3, main: 3 },  // big cook day — many volunteers
  Mon: { soup: 0, main: 1 },  // light day, lives off Sunday
  Tue: { soup: 1, main: 1 },  // back to a regular day
  Wed: { soup: 1, main: 1 },
  Thu: { soup: 1, main: 1 },
  Fri: { soup: 1, main: 1 },
  Sat: { soup: 1, main: 1 },
};

const SLOTS_PER_TYPE = 2;
const PLANNING_HORIZON_DAYS = 10;
const STALE_THRESHOLD_DAYS = 3;
const TYPES_TO_PLAN: DishType[] = ['Soup', 'Main course'];
```

### 3.2 Core insight

A placeholder **is** a cook event. The weekly rhythm defines exactly how many cook events exist per day per type. Each cook event becomes one Batch that spans multiple services. The algorithm creates ONE Batch per cook event and assigns it to MANY services — never one Batch per empty slot.

### 3.3 Steps

#### Step 0 — Cleanup (idempotency)

Delete every Batch where `generated === true && services.length === 0 && !recipeId`. These are stale placeholders the algorithm created on a previous run that nobody used. Cook-created placeholders are never auto-deleted because they don't have `generated: true`.

This is the only place the algorithm deletes. It also makes the button safe to press repeatedly.

#### Step 1 — Build planning window

PLANNING_HORIZON_DAYS days from `getToday()` (currently 10). Each day has 4 service slots: (west, lunch), (west, dinner), (centraal, lunch), (centraal, dinner). Skip slots where `isServicePast()` returns true.

#### Step 2 — Snapshot existing state

Classify Soup + Main course Batches:
- `cookedBatches`: `stock > 0`, sorted by cookDate ascending (oldest first).
- `uncookedBatches`: `stock === 0`, have a cookDate.
- `cookEventsByDay`: `Map<dateKey, { soup: Batch[], main: Batch[] }>` keyed by cookDate.
- `cateringsByBatchId`: `Map<batchId, Catering[]>`.

Don't touch Desserts. Don't touch batches whose only services are outside the window.

#### Step 3 — Generate missing placeholders

For each day in the window, for each type:

```
needed = COOK_RHYTHM[dayName][type]
existing = count of uncooked batches in cookEventsByDay[date][type]
gap = needed - existing
```

If `gap > 0`, create `gap` placeholder Batches. Use the full Batch shape — including the fields that `addPlaceholderDish()` currently forgets:

```typescript
{
  id: newId(),
  // Lowercase typeLabel + dd/mm suffix: "Wed soup 06/05", "Sun soup 1 03/05".
  // Distinguishes placeholders from real recipes (which start with capitals)
  // and keeps multi-week placeholders unambiguous without bloating the name.
  name: `${dayName} ${typeLabel.toLowerCase()}${gap > 1 ? ` ${i+1}` : ''} ${ddmm(cookDateStr)}`,
  type,                          // 'Soup' | 'Main course'
  stock: 0,
  serving: 280,
  storage: 'Gastro',
  location: 'west',              // default; cook can change
  inTransit: false,
  allergens: [],
  extraAllergens: [],
  orderFor: false,
  parentId: null,
  cookDate: dateToStr(new Date(date)),  // DD/MM/YYYY
  recipeSheetId: null,
  recipeVolume: null,
  recipeIngredients: null,
  note: '',
  services: [],                  // assigned in Step 4
  createdAt: new Date().toISOString(),
  recipeId: null,
  actualIngredients: null,
  cookNotes: '',
  stockDeducted: false,
  generated: true,               // NEW FIELD — see §6
}
```

If a day already has more cook events than the rhythm says, leave the extras alone — don't delete.

#### Step 4 — Assign services (two passes)

**Pass 1 — finish cooked stock first.**

For each cooked batch (oldest cookDate first), while the batch has surplus capacity AND is not yet stale:

```
surplus = stock - calcRequired(batch)
while surplus > 0 and batch not stale:
  next_slot = next chronological future service slot of this type that:
    - doesn't already contain this batch
    - has fewer than SLOTS_PER_TYPE batches of this type
  if no slot found: break
  if assigning would push batch into a stale day: break
  add {loc, date, meal} to batch.services
  surplus = stock - calcRequired(batch)
```

When Pass 1 stops with surplus remaining, that's a "consider freezing" warning candidate (Step 5).

**Pass 2 — fill remaining empty positions with the 2-newest rule.**

Pot capacity is NOT enforced during Pass 1/2/3 — kitchen pots are allocated POST-assignment by demand (see Step 4.5). This means the biggest pot always goes to the batch that needs it most, instead of being assigned by id-sort luck.

Iterate every service slot in chronological order (Centraal before West within the same date+meal). For each slot, for each type:

```
filled = count of batches of this type already in the slot
remaining = SLOTS_PER_TYPE - filled
if remaining == 0: continue
candidates = all batches of this type where:
  - cookDate exists and is "servable by this slot" (cook day's dinner or later)
  - batch not already in this slot
  - batch is not stale (or is uncooked)
  - batch is not frozen (storage !== 'Freezer')
  - cooked batches: calcRequired(batch) + this_slot_demand <= stock
sort candidates by cookDate descending (newest first)
  TIEBREAKER: among same cookDate, prefer cooked-and-aging
              (older real cookDate → higher priority) — this is the
              "5d" stale-food preference baked into Pass 2 ordering.
for i in 0..remaining:
  pick the next candidate using the same-bucket logic (most-loaded under bigPot, least-loaded over)
  add {loc, date, meal} to chosen.services
```

**Round-robin among same-day batches**: for a given (cookDate, type) bucket with N batches, track an index that advances each time one is picked. The index wraps modulo N. Result: Sunday's 3 soups get distributed roughly evenly across services without any one being orphaned.

**Servable-by rule**: a batch with cookDate = X is servable from dinner of X onwards. Lunch of X is too early.

**Centraal gaps (5b)**: because Pass 2 iterates all 4 service slots per day (both locations), a Centraal slot whose corresponding West slot is already filled will get filled by the same logic in the same pass — no separate "copy from West" step needed. The 2-newest rule will tend to pick the same batches because they're the most recent for both locations. This is "5b for free."

**Pass 3 — fill anything still empty, IGNORING pot caps.**

Filling slots ranks above respecting pot caps. Pass 3 iterates remaining empty positions and assigns the least-loaded eligible batch — even if it would push that batch over the pot it was originally allocated. Still respects the things that genuinely can't change:

- stock for cooked batches (you can't conjure food)
- frozen batches (cook decides to pull them)
- stale batches (warning-only path)
- in-slot duplicates (one batch can't fill both positions of one slot)
- servability (cook day's lunch is too early)

Over-cap batches surface as `over-pot-cap` warnings with an `[Add extra batch]` action. The cook can split reactively, or accept the over-pot reality.

**Why filling > variety > pot-cap?** Empty slots are worse than oversized pots. An empty Tue lunch means actual humans show up and there's no soup; an over-cap batch just means the cook needs a 100L pot instead of an 80L one (or splits the cook). The user explicitly chose this prioritization: "filling all slots should be more important."

#### Step 5 — Validate, report, and offer rescue actions

The algorithm itself never modifies existing service assignments or pulls frozen stock. Instead, it surfaces a list of warnings, each with optional action buttons. The cook clicks to apply — algorithm proposes, cook approves.

| Warning | Trigger | Action buttons |
|---|---|---|
| Under-filled slot | `< SLOTS_PER_TYPE` of a type AND `getGuests > 0` | `[Go to slot]`. Plus `[Use frozen X here]` for each frozen batch of the right type (freezer pull). Plus `[Add emergency cook]` if today and the slot is tonight's dinner (emergency morning cook). |
| Cooked stockout | `calcRequired(batch) > stock` for a cooked batch | `[Go to batch]` |
| Stale batch with stock | `isDishStale(batch) && stock > 0` | `[Assign anyway]` (adds service entry to next under-filled slot), `[Move to freezer]` (sets `storage = 'Freezer'`) |
| Cooked batch with surplus stuck | Pass 1 stopped with surplus > threshold | `[Move to freezer]` |
| Overloaded batch (5c) | Existing batch covers ≥ N services AND a later same-type cook event covers ≤ M services | `[Redistribute]` — moves later services from overloaded batch to under-used one. Cook clicks; nothing silent. |
| Catering with no dishes | Catering in window where `dishes.length === 0` | `[Go to catering]` |
| Frozen batches available | Informational summary at bottom of warnings list | None — surfaced as inventory only |

Slots with 0 guests do not produce under-filled warnings.

**Action button behaviors:**
- `[Use frozen X here]` — adds `{loc, date, meal}` to the frozen batch's `services`. Storage stays as `'Freezer'`; cook handles thawing themselves.
- `[Add emergency cook]` — creates a new placeholder Batch with `cookDate = today`, `cookNotes = 'Emergency morning cook'`, `generated: true`, and the failing service entry attached. Same shape as Step 3 placeholders.
- `[Redistribute]` — for an overloaded batch X and an under-used same-type batch Y where `cookDate(Y) > cookDate(X)`: identify all services on X whose `(date, meal)` falls on or after Y's first servable slot, move them from X to Y.
- `[Assign anyway]` — adds the next under-filled service slot to the stale batch's services.
- `[Move to freezer]` — sets `storage = 'Freezer'` on the batch.

After any action button is clicked: `rebuildPlanner()` + `rerenderCurrentView()` + `scheduleSave()`, and the warning row updates or disappears.

### 3.4 What the algorithm never does

- Never modifies any Batch field except `services` on existing batches (and the new `generated` flag on Batches it creates).
- Never deletes a Batch that wasn't created by this algorithm.
- Never removes existing service entries.
- Never touches Dessert batches.
- Never modifies catering links in `S.caterings`.
- Never assigns to past slots (`isServicePast` true).
- Never assigns frozen batches automatically (only the cook can, via the warning button).

---

## 4. UI

### 4.1 Button

In [planner.ts:105](../../public/js/planner.ts:105) `renderLocationPlan()`, when `loc === 'west'`, add to the btn-row:

```html
<button class="btn btn-fix-menu" onclick="fixMyMenu()">✨ Fix my menu</button>
```

Register `fixMyMenu` on `window` in [main.ts](../../public/js/main.ts).

### 4.2 Confirmation dialog

> "Fix my menu will fill empty service slots, generate placeholder batches for missing cook events, and flag any issues. Existing batches won't be removed or renamed. Continue?"
>
> [Cancel] [Yes, fix my menu]

### 4.3 Results modal

After running:

```
Fix My Menu — done

✅ Created 5 placeholders:
   Wed Soup, Thu Soup, Thu Main, Fri Soup, Sat Main

✅ Filled 18 service positions across 11 service slots

⚠️ 5 issues to look at
   • Saturday dinner Centraal — only 1 soup (need 2)             [Go to slot]
       [Use frozen Pumpkin Soup here]   [Add emergency cook]
   • "Lentil Stew" cooked Mon 14/4 — 6L stock, getting stale     [Go to batch]
       [Assign anyway]   [Move to freezer]
   • "Wed Soup" covers 8 services, "Thu Soup" covers 0           [Go to batch]
       [Redistribute]
   • "Pea Soup" cooked Tue — needs 14L, only 9L cooked           [Go to batch]
   • TestTafel catering Fri 18/4 has no dishes assigned          [Go to catering]

ℹ️ 2 frozen batches available as rescue:
   "Pumpkin Soup" (4L), "Tomato Soup" (3L)

[Got it]
```

Notes:
- "Created N placeholders" lists names truncated/wrapped if many.
- No nag about placeholders still needing real recipes — that's normal state.
- Each warning row is a flex container with `[Go to X]` on the right. Action buttons sit on a second line if present.
- Action buttons execute their behavior in-place (see Step 5 action button behaviors), then either update the row or remove it.
- "Go to" buttons close the modal and scroll to + briefly highlight the relevant DOM element.
- Frozen rescue inventory is informational; cooks discover it on the under-filled-slot rows where it's directly actionable.

### 4.4 CSS

Add to [public/css/planner.css](../../public/css/planner.css):
- `.btn-fix-menu` — distinctive purple/blue background, sparkle icon.
- `.fix-menu-results` modal styles + `.fix-menu-warning-row` + `.fix-menu-warning-btn`.
- `.slot-highlight` — short-lived (2s) yellow flash on slots/tiles linked from the warnings.

---

## 5. File Structure

New file: `public/js/menu-fixer.ts`

```
menu-fixer.ts
├── Constants (COOK_RHYTHM, etc.)
├── fixMyMenu()                      ← entry point, called from button
├── findOrphanPlaceholders()                 ← Step 0
├── buildPlanningWindow()            ← Step 1
├── snapshotBatches()                ← Step 2
├── generateMissingPlaceholders()    ← Step 3
├── assignServicesPass1()            ← Step 4 cooked-finish
├── assignServicesPass2()            ← Step 4 2-newest
├── validateAndReport()              ← Step 5
├── showResultsModal(report)         ← UI
└── scrollToSlot() / scrollToBatch() ← warning click handlers
```

All helpers exported as named exports for unit testing.

Imports from existing modules — no logic duplicated.

---

## 6. Schema Change (one Prisma migration)

Add `generated: boolean` to the `Batch` model. Defaults to `false`. Algorithm sets `true` only on placeholders it creates.

**Why a flag, not a name pattern:** cooks may rename placeholders. The flag is the only reliable signal of "this Batch was created by Fix My Menu and is safe to clean up." It also future-proofs against a UI that wants to badge generated batches differently.

**Migration steps**:
1. `npx prisma migrate dev --name add_batch_generated`
2. Update [shared/types.ts:54](../../shared/types.ts:54) — add `generated?: boolean` to the `Batch` interface (optional so existing rows deserialize cleanly).
3. Update [lib/db.ts](../../lib/db.ts) row transformer — read/write the field.
4. After migration, verify `prisma/schema.prisma` matches the DB (`npx prisma db pull && npx prisma generate`) per the project rule. Commit the regenerated schema in the same PR.

**Side fix to bundle**: [planner.ts:695](../../public/js/planner.ts:695) `addPlaceholderDish()` is missing several required Batch fields: `note`, `recipeSheetId`, `recipeVolume`, `recipeIngredients`. Add them while we're touching placeholder creation. This is the bug we noticed during planning.

---

## 7. Build Plan (Slices)

Each slice is a separate commit/PR-sized chunk. Test in preview before moving on.

### Slice 1 — Schema + placeholder bug fix
- Prisma migration `add_batch_generated`
- `Batch.generated?: boolean` in `shared/types.ts`
- Row transformer in `lib/db.ts` reads/writes the field
- Fix `addPlaceholderDish()` to set `note`, `recipeSheetId`, `recipeVolume`, `recipeIngredients`
- **Verify**: `npm test` passes, preview shows existing placeholders still work, new placeholders persist `generated: false`
- **Commit**: "Add Batch.generated flag + fix missing fields in addPlaceholderDish"

### Slice 2 — Placeholder generator + cleanup pass
- Create `public/js/menu-fixer.ts` with constants, `buildPlanningWindow`, `snapshotBatches`, `generateMissingPlaceholders`, `findOrphanPlaceholders`
- `fixMyMenu()` calls Steps 0, 1, 2, 3 only — no assignment yet
- Wire up `✨ Fix my menu` button on West tab
- Confirmation dialog
- Simple alert on completion ("Created N placeholders")
- **Verify in preview**:
  - Empty week → press button → 8 soup + 8 main placeholders appear with right cookDates
  - Press button again → no duplicates (cleanup catches the prior run, regenerate from rhythm)
  - Manually replace one placeholder with a recipe → press button → that day's count is satisfied, no extra created
  - Manually create a placeholder with the cook's own name → press button → not deleted (no `generated: true`)
- **Commit**: "Slice 2: Fix My Menu generates placeholders + cleans up orphans"

### Slice 3 — Two-pass service assigner
- `assignServicesPass1()` — finish cooked stock until stale or full
- `assignServicesPass2()` — 2-newest rule with most-loaded-under-bigPot concentration and servable-by rule
- Wire into `fixMyMenu()` after Step 3
- **Unit tests** (Jest, no DB needed — use module imports + mocked S):
  - 2-newest pairs Tue+Wed at Wed dinner, Wed+Thu at Thu dinner
  - Sunday's 3 soups distribute across Sun dinner → Tue dinner without orphaning any
  - Cooked batch with stock > demand gets extended to next slot
  - Cooked batch hitting stale day stops being extended
  - Frozen batches never auto-assigned
  - Past slots untouched
  - Same batch never appears in both slots of one service
- **Verify in preview**: full empty week generates a sensible 10-day plan
- **Commit**: "Slice 3: Fix My Menu assigns services (cooked-first then 2-newest)"

### Slice 4 — Validator + results modal + rescue actions
- `validateAndReport()` collects all warning categories from §3.3 Step 5
- Results modal (replaces alert from Slice 2)
- Navigation buttons:
  - `[Go to slot]` / `[Go to batch]` / `[Go to catering]` close modal + scroll + flash highlight
- Action buttons (each mutates state then `rebuildPlanner` + `rerenderCurrentView` + `scheduleSave`):
  - `[Move to freezer]` — sets `storage = 'Freezer'`
  - `[Assign anyway]` — adds next under-filled slot service to stale batch
  - `[Use frozen X here]` — adds service entry to frozen batch (one button per matching frozen batch)
  - `[Add emergency cook]` — creates today-cookDate placeholder with `cookNotes = 'Emergency morning cook'`
  - `[Redistribute]` — moves later services from overloaded batch to under-used same-type batch
- After any action: warning row updates (re-validates) or disappears
- **Verify in preview**:
  - Saturday dinner Centraal under-filled → warning appears, [Go to slot] works
  - Day with 0 guests → no under-filled warning
  - Stale batch → both buttons work; clicking [Move to freezer] removes the warning
  - Catering with no dishes → warning + link
  - Frozen batch of right type exists → [Use frozen X here] button adds service
  - Today's dinner under-filled with no other options → [Add emergency cook] button creates new placeholder
  - Wed-soup with 8 services + empty Thu-soup → [Redistribute] moves Thu-onwards services
- **Commit**: "Slice 4: Fix My Menu validation, warnings, and rescue actions"

### Slice 5 — Polish
- CSS (`.btn-fix-menu`, results modal, slot highlight)
- Tutorial step in [public/js/tutorial.ts](../../public/js/tutorial.ts) under the `planner` screen
- Edge cases verified:
  - Today is Wednesday mid-day → past Wed lunch services skipped
  - Already-perfect menu → no placeholders created, no warnings, "everything looks good" results modal
  - Saturday/Sunday with 0 lunch guests → no warning noise
- **Commit**: "Slice 5: Fix My Menu polish, tutorial, edge cases"

---

## 8. Testing Strategy

**Unit tests** in `test/menu-fixer.test.ts`:

The frontend functions are pure given an `S`-like input. Per CLAUDE.md, frontend state modules can be unit-tested without a DB by mocking `localStorage` and importing directly. Each helper takes inputs explicitly so they can be tested without touching real `S`. Aim for tests on:

- `findOrphanPlaceholders()` — generated placeholders deleted, cook-created not deleted
- `buildPlanningWindow()` — 10 days × 4 slots, past-slot filtering
- `generateMissingPlaceholders()` — gap calculation, naming pattern
- `assignServicesPass1()` — extension stops at stale, stops at zero surplus, respects catering reservations
- `assignServicesPass2()` — 2-newest, most-loaded-under-bigPot, servable-by, no in-slot duplicates, capacity for cooked
- `validateAndReport()` — each warning category triggers correctly, 0-guest suppression

**Manual preview verification** at each slice as listed above.

**No backend tests needed** — the schema migration is verified by existing API tests passing (the field is opt-in nullable). No new endpoints.

---

## 9. Conventions Recap (from CLAUDE.md)

- No `any` types — use proper types from `shared/types.ts`. Catch blocks: `catch (e: unknown)`.
- Date format: ISO `"YYYY-MM-DD"` for service dates, `"DD/MM/YYYY"` for cookDates.
- Mutation: modify `S.batches` in place → `rebuildPlanner()` → `rerenderCurrentView()` → `scheduleSave()`.
- Window functions: register `fixMyMenu` in `main.ts` for the onclick handler.
- Search/filter inputs: not relevant here (no search input in this feature).
- After Prisma migration: run `npx prisma db pull` + `npx prisma generate`, ensure schema fields use camelCase with `@map("snake_case")`.

---

## 10. Out of Scope (deliberately)

These were in the original spec and are dropped:

- **Step 5a — silent removal of redundant assignments.** If a slot has 3 soups, the algorithm leaves it alone. The cook is assumed to have meant it; if not, manual cleanup is fast.
- **Silent rebalancing of any kind.** All "rebalance" behavior (5b/5c/5d) is either folded into Pass 2's natural ordering or surfaced as a warning row with an action button the cook clicks. The algorithm never silently moves or removes existing service assignments.
- **Auto-pulling frozen batches into rotation.** Frozen batches are surfaced as rescue inventory in warnings; the cook clicks `[Use frozen X here]` to apply.
- **Auto-creating emergency cook batches.** Surfaced as `[Add emergency cook]` button on under-filled today-dinner slots; cook clicks to create.
- **Per-location cook rhythm.** Defaults to "all west, all rhythm" for v1. Centraal cooking remains incidental and manual.
- **Cook rhythm in UI / config.** Hardcoded constant for v1. If teams want to edit it later, lift to a config table.
- **Capacity heuristic for uncooked batches.** `calcRequired` shows the cook how big to scale; no algorithmic cap on services per uncooked batch. The 2-newest rule plus the cook rhythm naturally limit how many services one Batch covers.
