// ── FIX MY MENU ─────────────────────────────────────────────────────────────
// Single button that scaffolds and rebalances the 14-day menu.
// Slice 2: cleanup + planning window + placeholder generator + button wiring.
// Slice 3 (this file): two-pass service assigner (cooked-finish, then 2-newest).
// See .claude/plans/fix-my-menu.md for the full spec.

import type { Batch, DishType, Location, Meal, KitchenEquipment } from '@shared/types';
import { S } from './state';
import { newId, scheduleSave, toast, toastError, saveKitchenEquipment } from './utils';
import { rebuildPlanner, getToday, dateToIso, dateToStr, dateToDayName, isServicePast, calcRequired, getGuests } from './core';
import { rerenderCurrentView } from './navigate';
import { showModal, closeModal, esc } from './modal';

// ── Constants ───────────────────────────────────────────────────────────────

// Weekly cook rhythm. All cooking happens at West by default.
// Sunday is the big-cook day (lots of volunteers); Mon/Tue live off Sunday's
// surplus so cooks can clean and organise. Wed–Sat are steady 1+1 days.
export const COOK_RHYTHM: Record<string, { soup: number; main: number }> = {
  Sun: { soup: 3, main: 3 },
  Mon: { soup: 0, main: 1 },
  Tue: { soup: 1, main: 1 },
  Wed: { soup: 1, main: 1 },
  Thu: { soup: 1, main: 1 },
  Fri: { soup: 1, main: 1 },
  Sat: { soup: 1, main: 1 },
};

export const SLOTS_PER_TYPE = 2;
export const PLANNING_HORIZON_DAYS = 10;
export const STALE_THRESHOLD_DAYS = 3;
export const TYPES_TO_PLAN: DishType[] = ['Soup', 'Main course'];

// All four service slots per day, in the canonical order Pass 2 will use later
// (Centraal before West so Centraal slots get filled first when the algorithm
// has to choose between them — see spec §3.3 Step 4).
const SERVICE_SLOTS_PER_DAY: { loc: Location; meal: Meal }[] = [
  { loc: 'centraal', meal: 'lunch' },
  { loc: 'centraal', meal: 'dinner' },
  { loc: 'west', meal: 'lunch' },
  { loc: 'west', meal: 'dinner' },
];

// ── Types ───────────────────────────────────────────────────────────────────

export interface PlanSlot {
  loc: Location;
  meal: Meal;
  isPast: boolean;
}

export interface PlanDay {
  date: Date;
  isoDate: string;       // "YYYY-MM-DD"  — for Service.date
  cookDateStr: string;   // "DD/MM/YYYY"  — for Batch.cookDate
  dayName: string;       // 'Mon' | 'Tue' | ...
  slots: PlanSlot[];
}

export interface BatchSnapshot {
  cookEventsByCookDate: Map<string, { Soup: Batch[]; 'Main course': Batch[] }>;
  // Reserved for Slice 3: cooked vs uncooked, catering reservations, etc.
  inWindow: Batch[];
}

// ── Step 1: Build planning window ───────────────────────────────────────────

export function buildPlanningWindow(today: Date, horizonDays = PLANNING_HORIZON_DAYS): PlanDay[] {
  const days: PlanDay[] = [];
  for (let i = 0; i < horizonDays; i++) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
    const isoDate = dateToIso(d);
    const slots: PlanSlot[] = SERVICE_SLOTS_PER_DAY.map(s => ({
      loc: s.loc,
      meal: s.meal,
      isPast: isServicePast({ loc: s.loc, date: isoDate, meal: s.meal }),
    }));
    days.push({
      date: d,
      isoDate,
      cookDateStr: dateToStr(d),
      dayName: dateToDayName(isoDate),
      slots,
    });
  }
  return days;
}

// ── Step 2: Snapshot existing state ─────────────────────────────────────────

export function snapshotBatches(batches: Batch[], window: PlanDay[]): BatchSnapshot {
  const cookEventsByCookDate = new Map<string, { Soup: Batch[]; 'Main course': Batch[] }>();
  for (const day of window) {
    cookEventsByCookDate.set(day.cookDateStr, { Soup: [], 'Main course': [] });
  }

  const inWindow: Batch[] = [];
  for (const b of batches) {
    if (!TYPES_TO_PLAN.includes(b.type)) continue;            // skip Desserts entirely
    if (!b.cookDate) continue;                                // unscheduled, ignore
    const bucket = cookEventsByCookDate.get(b.cookDate);
    if (!bucket) continue;                                    // outside window
    bucket[b.type as 'Soup' | 'Main course'].push(b);
    inWindow.push(b);
  }

  return { cookEventsByCookDate, inWindow };
}

// ── Strip future services (for redistributive re-planning) ─────────────────

/**
 * Remove every service entry whose date+meal is still in the future. Past
 * services (already served by `isServicePast`) are preserved as-is.
 *
 * This makes the algorithm fully redistributive: when fixMyMenu runs, it
 * starts from a "clean slate" of future assignments and rebuilds them from
 * current state (cooked stock, pot sizes, guest counts, catering links). The
 * catering link itself isn't a service entry so it survives untouched.
 *
 * Returns the number of service entries removed.
 */
export function stripFutureServices(batches: Batch[]): number {
  let removed = 0;
  for (const b of batches) {
    if (!b.services || b.services.length === 0) continue;
    const kept = b.services.filter(s => isServicePast(s));
    removed += b.services.length - kept.length;
    b.services = kept;
  }
  return removed;
}

// ── Step 0: Cleanup orphan generated placeholders ───────────────────────────

/**
 * Returns the batches that should be deleted because they were generated by a
 * previous run, never got assigned to a service, and were never linked to a
 * recipe. This makes the algorithm idempotent — pressing the button twice in a
 * row produces the same result, because the second run undoes the placeholders
 * the first run created (and then recreates them from scratch).
 *
 * Cook-created placeholders (`generated !== true`) are NEVER returned here.
 */
export function findOrphanPlaceholders(batches: Batch[]): Batch[] {
  return batches.filter(b =>
    b.generated === true
    && (!b.services || b.services.length === 0)
    && !b.recipeId
    && !b.recipeSheetId
  );
}

// ── Step 3: Generate missing placeholders ───────────────────────────────────

interface PlaceholderInput {
  cookDateStr: string;
  isoDate: string;
  dayName: string;
  type: DishType;
  index: number;     // 1-based among same-day same-type
  total: number;     // total of this type cooked this day per rhythm
}

/**
 * Build a fully-typed Batch placeholder. Defaults to West for cooking, no
 * services attached (Slice 3 fills those). Sets `generated: true` so future
 * cleanup passes know it's safe to remove if unused.
 */
function buildPlaceholder(input: PlaceholderInput): Batch {
  // Lowercase type label so placeholders sort visually after real recipe names
  // (which start with capital letters): "Sat soup 02/05" stands out clearly
  // as a placeholder waiting to be replaced with a real recipe.
  const typeLabel = input.type === 'Main course' ? 'main' : 'soup';
  const indexSuffix = input.total > 1 ? ` ${input.index}` : '';
  // Strip the year — keep just dd/mm so the name stays compact in the planner UI.
  const ddmm = input.cookDateStr.split('/').slice(0, 2).join('/');
  const name = `${input.dayName} ${typeLabel}${indexSuffix} ${ddmm}`;

  return {
    id: newId(),
    name,
    type: input.type,
    stock: 0,
    serving: 280,
    storage: 'Gastro',
    location: 'west',
    inTransit: false,
    allergens: [],
    extraAllergens: [],
    orderFor: false,
    parentId: null,
    cookDate: input.cookDateStr,
    recipeSheetId: null,
    recipeVolume: null,
    recipeIngredients: null,
    note: '',
    services: [],
    createdAt: new Date().toISOString(),
    recipeId: null,
    actualIngredients: null,
    cookNotes: '',
    stockDeducted: false,
    generated: true,
  };
}

/**
 * For each day in the window and each type-to-plan, count how many uncooked
 * batches already exist on that day vs. what the rhythm wants, and emit
 * placeholder Batches to fill the gap.
 *
 * If a day already has more cook events than the rhythm prescribes (e.g. a
 * cook decided to make 2 soups on a Wednesday), we leave the extras alone —
 * never delete or "normalize down".
 */
export function generateMissingPlaceholders(window: PlanDay[], snapshot: BatchSnapshot): Batch[] {
  const newBatches: Batch[] = [];

  for (const day of window) {
    const rhythm = COOK_RHYTHM[day.dayName];
    if (!rhythm) continue;
    const bucket = snapshot.cookEventsByCookDate.get(day.cookDateStr);
    if (!bucket) continue;

    for (const type of TYPES_TO_PLAN) {
      const target = type === 'Soup' ? rhythm.soup : rhythm.main;
      const existing = bucket[type as 'Soup' | 'Main course'].length;
      const gap = target - existing;
      if (gap <= 0) continue;

      for (let i = 0; i < gap; i++) {
        newBatches.push(buildPlaceholder({
          cookDateStr: day.cookDateStr,
          isoDate: day.isoDate,
          dayName: day.dayName,
          type,
          index: existing + i + 1,
          total: target,
        }));
      }
    }
  }

  return newBatches;
}

// ── Pot allocation ──────────────────────────────────────────────────────────

/**
 * For each cook day, allocate the kitchen's available pots to that day's
 * batches and return a per-batch liters cap.
 *
 * Demand-based allocation (called AFTER assignment passes complete):
 *   - Group batches by cookDate.
 *   - Within a day, sort batches by current demand DESCENDING.
 *   - Allocate pots from biggest to smallest in that order.
 *   - The biggest cooking pot goes to the batch that needs the most food —
 *     never wasted on a low-demand batch just because it sorts first by id.
 *   - If a day has more batches than pots, the overflow gets capped at the
 *     smallest pot size (warning territory — flagged in validation).
 *
 * Returns a Map keyed by batch id. Batches not in the map (e.g. Desserts,
 * batches outside the planning window) have no cap.
 */
export function allocatePotCaps(
  batchesInWindow: Batch[],
  equipment: KitchenEquipment | null,
  calcReq: (b: Batch) => number,
): Map<string, number> {
  const caps = new Map<string, number>();
  if (!equipment || equipment.pots.length === 0) return caps;
  const sortedPotsDesc = [...equipment.pots].sort((a, b) => b - a);
  const smallestPot = sortedPotsDesc[sortedPotsDesc.length - 1];

  // Group by cookDate
  const byDay = new Map<string, Batch[]>();
  for (const b of batchesInWindow) {
    if (!b.cookDate) continue;
    if (!TYPES_TO_PLAN.includes(b.type)) continue;
    if (!byDay.has(b.cookDate)) byDay.set(b.cookDate, []);
    byDay.get(b.cookDate)!.push(b);
  }

  for (const [, dayBatches] of byDay) {
    // Sort by demand desc; ties broken by id for determinism
    const sorted = [...dayBatches].sort((a, b) => {
      const da = calcReq(a);
      const db = calcReq(b);
      if (da !== db) return db - da;
      return a.id.localeCompare(b.id);
    });
    for (let k = 0; k < sorted.length; k++) {
      const cap = sortedPotsDesc[k] ?? smallestPot;
      caps.set(sorted[k].id, cap);
    }
  }
  return caps;
}

// ── Step 4 helpers: slot eligibility ────────────────────────────────────────

/**
 * Convert a cookDate "DD/MM/YYYY" to ISO "YYYY-MM-DD" for lexical comparison.
 * Returns null if the input is empty or malformed.
 */
function cookDateToIso(ddmmyyyy: string | null | undefined): string | null {
  if (!ddmmyyyy) return null;
  const parts = ddmmyyyy.split('/');
  if (parts.length !== 3) return null;
  const [dd, mm, yyyy] = parts;
  if (!dd || !mm || !yyyy) return null;
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Number of days between two ISO dates (b - a). Negative if b is before a.
 */
function diffDaysIso(aIso: string, bIso: string): number {
  const a = new Date(aIso + 'T12:00:00').getTime();
  const b = new Date(bIso + 'T12:00:00').getTime();
  return Math.round((b - a) / 86400000);
}

/**
 * A batch with cookDate = X is servable starting at dinner of X (lunch of X is
 * too early — cooking happens during the day). Any later day is fine.
 *
 * Location rules (`batchLocation` = where the food physically IS, not where it
 * was cooked):
 *   - West-located batch + Centraal slot → next-morning delivery only
 *     (West cooks, food rides the morning van to Centraal). Same-day Centraal
 *     dinner is too early.
 *   - Centraal-located batch + West slot → NEVER. There's no reverse delivery,
 *     so once food is at Centraal it stays there. Without this rule the
 *     algorithm cheerfully assigns Centraal stock (often a "(split)" batch
 *     deliberately sent to Centraal) to West services, which is a logistics
 *     impossibility AND starves Centraal of its own dedicated stock.
 *   - Same-location: standard same-day-dinner rule.
 */
export function isServableBy(
  cookDateDdmmyyyy: string | null,
  slotIsoDate: string,
  slotMeal: Meal,
  slotLoc: Location = 'west',
  batchLocation: Location = 'west',
): boolean {
  const cookIso = cookDateToIso(cookDateDdmmyyyy);
  if (!cookIso) return false;
  if (slotIsoDate < cookIso) return false;
  // Centraal-located food cannot flow back to West — no reverse delivery.
  if (slotLoc === 'west' && batchLocation === 'centraal') return false;
  // West-cooked food at Centraal: must wait for next-morning delivery.
  if (slotLoc === 'centraal' && batchLocation === 'west') {
    return slotIsoDate > cookIso;
  }
  // Same-location: standard rule (same-day dinner OK, any later day OK).
  if (slotIsoDate > cookIso) return true;
  return slotMeal === 'dinner';
}

/**
 * Stale = service date is `threshold` or more days after cook date.
 * Same logic as core's isDishStale, but parameterised so we can ask
 * "would this batch be stale by THIS slot's date?" without time-of-day fuzz.
 */
export function isStaleAtSlot(cookDateDdmmyyyy: string | null, slotIsoDate: string, threshold = STALE_THRESHOLD_DAYS): boolean {
  const cookIso = cookDateToIso(cookDateDdmmyyyy);
  if (!cookIso) return false;
  return diffDaysIso(cookIso, slotIsoDate) >= threshold;
}

/**
 * How many batches of `type` currently have a service entry matching the
 * given (loc, isoDate, meal) slot. Counts the LIVE state of `batches.services`
 * so it picks up assignments added earlier in the same pass.
 */
export function countTypeInSlot(batches: Batch[], type: DishType, loc: Location, isoDate: string, meal: Meal): number {
  let n = 0;
  for (const b of batches) {
    if (b.type !== type) continue;
    if (!b.services || b.services.length === 0) continue;
    for (const s of b.services) {
      if (s.loc === loc && s.date === isoDate && s.meal === meal) { n++; break; }
    }
  }
  return n;
}

/** True if the batch already has a service entry exactly matching this slot. */
export function alreadyInSlot(batch: Batch, loc: Location, isoDate: string, meal: Meal): boolean {
  return (batch.services || []).some(s => s.loc === loc && s.date === isoDate && s.meal === meal);
}

/** Lexically-comparable cookDate value for sorting (oldest first when ascending). */
function cookDateSortKey(b: Batch): string {
  return cookDateToIso(b.cookDate) || '9999-99-99';
}

// ── Step 4 — Pass 1: finish cooked stock first ─────────────────────────────

/**
 * For each cooked batch (oldest cookDate first), extend its services forward
 * through the planning window until either:
 *   - calcRequired(batch) catches up to stock (no surplus left), OR
 *   - the next slot would be on a stale day (>= STALE_THRESHOLD_DAYS after cook), OR
 *   - no more slots are eligible.
 *
 * Mutates batch.services in place. Returns counters for reporting.
 *
 * Catering reservations are respected automatically because calcRequired()
 * already includes catering demand — a batch with a big catering hold will
 * hit its capacity ceiling earlier and stop being extended.
 */
export function assignServicesPass1(
  allBatches: Batch[],
  window: PlanDay[],
  calcReq: (b: Batch) => number,
  getGuestsFn?: (loc: Location, isoDate: string, meal: Meal) => number,
): { servicesAdded: number; batchesTouched: number } {
  const cookedSorted = allBatches
    .filter(b => TYPES_TO_PLAN.includes(b.type))
    .filter(b => b.stock > 0)
    .filter(b => b.cookDate)
    .filter(b => b.storage !== 'Frozen')
    .sort((a, b) => {
      // Primary: oldest cookDate first (use up older food before newer)
      const ck = cookDateSortKey(a).localeCompare(cookDateSortKey(b));
      if (ck !== 0) return ck;
      // Secondary: Centraal-located batches before West. They have a smaller
      // pool of eligible slots (Centraal-only — see isServableBy), so they
      // need first pick before West batches consume Centraal slots.
      if (a.location !== b.location) return a.location === 'centraal' ? -1 : 1;
      // Tertiary: id for determinism so reruns produce the same plan.
      return a.id.localeCompare(b.id);
    });

  let added = 0;
  const touched = new Set<string>();

  for (const batch of cookedSorted) {
    // Ceiling = real-stock limit. Pot caps are no longer enforced during
    // assignment — they're computed AFTER all passes complete (demand-based
    // allocation). Over-pot batches surface as warnings.
    const ceiling = batch.stock;
    let surplus = ceiling - calcReq(batch);
    if (surplus <= 0) continue;

    walk: for (const day of window) {
      // Once the batch would be stale at this day's earliest slot, stop entirely.
      if (isStaleAtSlot(batch.cookDate, day.isoDate)) break walk;

      for (const slot of day.slots) {
        if (slot.isPast) continue;
        // Skip slots with no expected guests — no point assigning food where nobody eats.
        if (getGuestsFn && getGuestsFn(slot.loc, day.isoDate, slot.meal) <= 0) continue;
        if (!isServableBy(batch.cookDate, day.isoDate, slot.meal, slot.loc, batch.location)) continue;
        if (alreadyInSlot(batch, slot.loc, day.isoDate, slot.meal)) continue;
        if (countTypeInSlot(allBatches, batch.type, slot.loc, day.isoDate, slot.meal) >= SLOTS_PER_TYPE) continue;

        // Tentatively assign, then check capacity. If overcommitted, undo.
        batch.services.push({ loc: slot.loc, date: day.isoDate, meal: slot.meal });
        const overshot = calcReq(batch) > ceiling;
        if (overshot) {
          batch.services.pop();
          // No more room in this batch — move to the next batch.
          break walk;
        }

        added++;
        touched.add(batch.id);
        surplus = ceiling - calcReq(batch);
        if (surplus <= 0) break walk;
      }
    }
  }

  return { servicesAdded: added, batchesTouched: touched.size };
}

// ── Step 4 — Pass 2: 2-newest rule ─────────────────────────────────────────

/**
 * Iterates every (day, slot, type) triple in chronological order. For each
 * still-empty position (slot has < SLOTS_PER_TYPE batches of this type),
 * picks the most recent eligible cook event and assigns it.
 *
 * Sort order:
 *   1. Newest cookDate first (the "2-newest" rule).
 *   2. Tie-break: cooked-and-aging > uncooked at the same cookDate (this is
 *      the "5d" stale-food preference baked into ordering — older real food
 *      gets used before fresh-from-the-pot uncooked plans).
 *
 * Round-robin: when the top sort bucket has multiple batches with the same
 * (cookDate, cooked-status), an index per (cookDate, type, status) advances
 * each pick so e.g. Sunday's three soups distribute evenly across Sun→Tue
 * services rather than always picking the same one.
 *
 * Eligibility:
 *   - cookDate is set and servable by this slot (cook day's dinner or later).
 *   - Not already in this slot.
 *   - Not stale yet (cooked) or always eligible (uncooked).
 *   - Not frozen (`storage !== 'Frozen'`).
 *   - Cooked: tentatively-assign capacity check via calcReq(b) <= stock.
 */
export function assignServicesPass2(
  allBatches: Batch[],
  window: PlanDay[],
  calcReq: (b: Batch) => number,
  getGuestsFn?: (loc: Location, isoDate: string, meal: Meal) => number,
  /** Soft concentration cap. When set, Pass 2 piles services onto the most-
   *  loaded sibling batch up to this size, so smaller siblings stay tiny
   *  (and trigger the too-small-batch warning). Without this hint, falls
   *  back to even (least-loaded) spread. */
  biggestPotLiters?: number,
): { servicesAdded: number } {
  let added = 0;

  for (const day of window) {
    for (const slot of day.slots) {
      if (slot.isPast) continue;
      // Skip 0-guest slots — see Pass 1 comment.
      if (getGuestsFn && getGuestsFn(slot.loc, day.isoDate, slot.meal) <= 0) continue;

      for (const type of TYPES_TO_PLAN) {
        const filled = countTypeInSlot(allBatches, type, slot.loc, day.isoDate, slot.meal);
        const remaining = SLOTS_PER_TYPE - filled;
        if (remaining <= 0) continue;

        for (let i = 0; i < remaining; i++) {
          const placed = tryFillOnePosition(
            allBatches, type, slot.loc, day.isoDate, slot.meal, calcReq, biggestPotLiters,
          );
          if (placed) added++;
          else break;  // no candidate fit — leave the rest of this slot's positions empty
        }
      }
    }
  }

  return { servicesAdded: added };
}

/**
 * Find the best candidate for a single (slot, type) position and assign it.
 * Returns true if a batch was placed. Tries successive candidates if the top
 * pick fails the stock check for cooked batches.
 */
function tryFillOnePosition(
  allBatches: Batch[],
  type: DishType,
  loc: Location,
  isoDate: string,
  meal: Meal,
  calcReq: (b: Batch) => number,
  biggestPotLiters?: number,
): boolean {
  // Build candidate list (excluded: wrong type, already-in-slot, frozen, stale-cooked, unservable).
  let candidates = allBatches.filter(b => {
    if (b.type !== type) return false;
    if (!b.cookDate) return false;
    if (b.storage === 'Frozen') return false;
    if (alreadyInSlot(b, loc, isoDate, meal)) return false;
    if (!isServableBy(b.cookDate, isoDate, meal, loc, b.location)) return false;
    if (b.stock > 0 && isStaleAtSlot(b.cookDate, isoDate)) return false;
    return true;
  });

  while (candidates.length > 0) {
    // Sort: newest cookDate first (variety); tiebreak: cooked > uncooked.
    candidates.sort((a, b) => {
      const aIso = cookDateToIso(a.cookDate)!;
      const bIso = cookDateToIso(b.cookDate)!;
      if (aIso !== bIso) return aIso > bIso ? -1 : 1;
      const aCooked = a.stock > 0 ? 1 : 0;
      const bCooked = b.stock > 0 ? 1 : 0;
      return bCooked - aCooked;
    });

    const top = candidates[0];
    const topIso = cookDateToIso(top.cookDate)!;
    const topCooked = top.stock > 0 ? 'cooked' : 'uncooked';

    // Within same (cookDate, cooked-status) bucket, choose between two sort
    // strategies:
    //   - COOKED bucket: most-loaded first, up to the big-pot cap (concentrate
    //     real stock onto one batch before requiring another cook).
    //   - UNCOOKED bucket: least-loaded first (even spread). All placeholders
    //     for the same day-and-type are physically interchangeable — the cook
    //     chooses batch sizes after the fact. Concentrating one placeholder
    //     to 140L while leaving its siblings empty produces the wrong cook
    //     plan (one giant cook + zero-volume "ghost" entries).
    const sameBucket = candidates
      .filter(c => cookDateToIso(c.cookDate) === topIso && (c.stock > 0 ? 'cooked' : 'uncooked') === topCooked);
    let chosen: Batch;
    if (topCooked === 'cooked' && biggestPotLiters != null) {
      const underBig = sameBucket.filter(c => calcReq(c) < biggestPotLiters);
      if (underBig.length > 0) {
        underBig.sort((a, b) => {
          if (a.services.length !== b.services.length) return b.services.length - a.services.length;
          return a.id.localeCompare(b.id);
        });
        chosen = underBig[0];
      } else {
        // All at/over big-pot — spread overflow
        sameBucket.sort((a, b) => a.services.length - b.services.length);
        chosen = sameBucket[0];
      }
    } else {
      // Uncooked bucket OR no equipment hint — even spread (least-loaded).
      sameBucket.sort((a, b) => {
        if (a.services.length !== b.services.length) return a.services.length - b.services.length;
        return a.id.localeCompare(b.id);
      });
      chosen = sameBucket[0];
    }

    // Tentatively assign and check capacity. Only stock matters here — pot
    // sizing is decided post-assignment based on actual demand.
    //
    // Two-tier capacity check:
    //   1. If real-peer demand fits → accept.
    //   2. Else, retry assuming the slot will eventually reach SLOTS_PER_TYPE
    //      peers (optimistic peer-split). Without (2), a slot that needs 2
    //      batches together to be feasible (Tomato W + Miso W at Tue dinner
    //      C, 240 guests — neither fits solo, both fit at 33.6L each) stays
    //      empty forever, because position 1's tentative add sees solo
    //      demand and overshoots. If the expected peer never arrives, the
    //      cooked-stockout warning surfaces the under-supply.
    chosen.services.push({ loc, date: isoDate, meal });
    const fits = chosen.stock <= 0
      || calcReq(chosen) <= chosen.stock
      || calcReqOptimistic(chosen, allBatches) <= chosen.stock;
    if (!fits) {
      chosen.services.pop();
      // Cooked batch hit its stock limit — drop it and try the next candidate.
      candidates = candidates.filter(c => c !== chosen);
      continue;
    }

    return true;
  }

  return false;
}

/**
 * Optimistic capacity check used by Pass 2 and Pass 3. Sums the batch's
 * demand across its services, but splits each slot's guest load by
 * max(realPeers, SLOTS_PER_TYPE) instead of just realPeers. This lets a
 * tight-stock batch fit a slot that ONLY works as a paired placement —
 * the algorithm trusts that another candidate will join as the peer.
 *
 * Catering hold uses the actual catering-side peer split (no optimism
 * there — a catering's dish list is what it is).
 */
function calcReqOptimistic(b: Batch, allBatches: Batch[]): number {
  let total = 0;
  for (const svc of b.services || []) {
    if (isServicePast(svc)) continue;
    const realPeers = allBatches.filter(other =>
      other.type === b.type
      && (other.services || []).some(s => s.loc === svc.loc && s.date === svc.date && s.meal === svc.meal),
    ).length;
    const peers = Math.max(realPeers, SLOTS_PER_TYPE);
    const g = getGuests(svc.loc, svc.date, svc.meal);
    total += (g / peers) * ((b.serving || 280) / 1000);
  }
  for (const c of (S.caterings || [])) {
    const cd = (c.dishes || []).find(cd => cd.dishId === b.id);
    if (cd) {
      const peers = (c.dishes || []).filter(d => d.type === b.type).length;
      total += ((c.guestCount || 0) / Math.max(peers, 1)) * ((b.serving || 280) / 1000);
    }
  }
  return Math.round(total * 10) / 10;
}

// ── Step 4 — Pass 3: fill remaining empty positions, IGNORE pot caps ──────

/**
 * After Pass 2 has done its variety-respecting + pot-cap-respecting work,
 * any still-empty slot positions get filled here. This pass relaxes the pot
 * cap constraint — better to over-fill a pot (warning territory) than to
 * leave a service slot empty when food exists to fill it.
 *
 * Still respects:
 *   - stock for cooked batches (you can't conjure food out of thin air)
 *   - frozen batches stay out of auto rotation
 *   - stale batches (cooked) stay out — cook can force-assign via the modal
 *   - servability (cook day's lunch is too early)
 *   - in-slot duplicates (same batch can't fill both positions of one slot)
 *
 * Picks least-loaded eligible batch — variety has already been applied in
 * Pass 2's rounds, so this pass just balances the leftover load.
 *
 * Over-cap batches will be flagged by collectWarnings as `over-pot-cap`
 * with an [Add extra batch] action — the cook can split reactively.
 */
export function assignServicesPass3(
  allBatches: Batch[],
  window: PlanDay[],
  calcReq: (b: Batch) => number,
  getGuestsFn?: (loc: Location, isoDate: string, meal: Meal) => number,
  biggestPotLiters?: number,
): { servicesAdded: number } {
  let added = 0;

  for (const day of window) {
    for (const slot of day.slots) {
      if (slot.isPast) continue;
      // Skip 0-guest slots — see Pass 1 comment.
      if (getGuestsFn && getGuestsFn(slot.loc, day.isoDate, slot.meal) <= 0) continue;

      for (const type of TYPES_TO_PLAN) {
        const filled = countTypeInSlot(allBatches, type, slot.loc, day.isoDate, slot.meal);
        const remaining = SLOTS_PER_TYPE - filled;
        if (remaining <= 0) continue;

        for (let i = 0; i < remaining; i++) {
          let candidates = allBatches.filter(b => {
            if (b.type !== type) return false;
            if (!b.cookDate) return false;
            if (b.storage === 'Frozen') return false;
            if (alreadyInSlot(b, slot.loc, day.isoDate, slot.meal)) return false;
            if (!isServableBy(b.cookDate, day.isoDate, slot.meal, slot.loc, b.location)) return false;
            if (b.stock > 0 && isStaleAtSlot(b.cookDate, day.isoDate)) return false;
            // Cooked: tentative-add and undo to verify we don't exceed STOCK
            // (real food limit; pot cap is intentionally ignored here).
            // Two-tier capacity check (matches Pass 2): real-peer demand,
            // OR optimistic-peer demand assuming the slot reaches
            // SLOTS_PER_TYPE peers. See the calcReqOptimistic comment.
            if (b.stock > 0) {
              b.services.push({ loc: slot.loc, date: day.isoDate, meal: slot.meal });
              const fits = calcReq(b) <= b.stock
                || calcReqOptimistic(b, allBatches) <= b.stock;
              b.services.pop();
              if (!fits) return false;
            }
            return true;
          });
          if (candidates.length === 0) break;

          // Pass 3 sort: newest cookDate first. Within same cookDate:
          //   - cooked batch with headroom under bigPot → most-loaded
          //     (concentrate real stock onto one batch).
          //   - everything else (uncooked placeholders, or cooked batches over
          //     bigPot) → least-loaded (even spread). Same reasoning as Pass 2:
          //     identical placeholders should distribute evenly so the cook
          //     ends up with same-sized batches, not one giant + one empty.
          const bigPot2 = biggestPotLiters ?? Infinity;
          candidates.sort((a, b) => {
            const aIso = cookDateToIso(a.cookDate)!;
            const bIso = cookDateToIso(b.cookDate)!;
            if (aIso !== bIso) return aIso > bIso ? -1 : 1;
            const aConcentrate = a.stock > 0 && calcReq(a) < bigPot2;
            const bConcentrate = b.stock > 0 && calcReq(b) < bigPot2;
            if (aConcentrate !== bConcentrate) return aConcentrate ? -1 : 1;
            return aConcentrate ? (b.services.length - a.services.length) : (a.services.length - b.services.length);
          });
          const chosen: Batch = candidates[0];
          chosen.services.push({ loc: slot.loc, date: day.isoDate, meal: slot.meal });
          added++;
        }
      }
    }
  }

  return { servicesAdded: added };
}

// ── Step 4 — Pass 4: finish-off pass (allow up to 3 peers per slot) ────────

/**
 * After Pass 1/2/3 have done their best within the SLOTS_PER_TYPE = 2 cap,
 * cooked batches that still have unused stock get a "finish-off" pass.
 * This pass relaxes the per-slot cap from 2 to 3, letting a leftover batch
 * piggyback as a 3rd option on a slot that already has its 2 main choices.
 *
 * Use case: kitchen cooked 65L of Miso & ginger soup on Sunday but the
 * menu only used 30L of it across Mon–Tue. Without this pass the leftover
 * 35L sits in the walk-in and either freezes or spoils. With it, Miso
 * shows up as an "extra" option at a slot that's already covered.
 *
 * Still respects:
 *   - stock cap (real food limit, not pot cap)
 *   - frozen / stale exclusions
 *   - servability and 0-guest skip
 *   - in-slot duplicates
 *   - 3-deep cap (don't stack 4+ different soups on one service)
 */
const FINISH_OFF_CAP = SLOTS_PER_TYPE + 1;  // 3 = 2 main options + 1 extra

export function assignServicesPass4(
  allBatches: Batch[],
  window: PlanDay[],
  calcReq: (b: Batch) => number,
  getGuestsFn?: (loc: Location, isoDate: string, meal: Meal) => number,
): { servicesAdded: number; batchesTouched: number } {
  const cookedSorted = allBatches
    .filter(b => TYPES_TO_PLAN.includes(b.type))
    .filter(b => b.stock > 0)
    .filter(b => b.cookDate)
    .filter(b => b.storage !== 'Frozen')
    // Oldest cookDate first — finish off the older food before the newer.
    .sort((a, b) => cookDateSortKey(a).localeCompare(cookDateSortKey(b)));

  let added = 0;
  const touched = new Set<string>();

  for (const batch of cookedSorted) {
    const ceiling = batch.stock;
    let surplus = ceiling - calcReq(batch);
    if (surplus <= 0) continue;

    walk: for (const day of window) {
      if (isStaleAtSlot(batch.cookDate, day.isoDate)) break walk;

      for (const slot of day.slots) {
        if (slot.isPast) continue;
        if (getGuestsFn && getGuestsFn(slot.loc, day.isoDate, slot.meal) <= 0) continue;
        if (!isServableBy(batch.cookDate, day.isoDate, slot.meal, slot.loc, batch.location)) continue;
        if (alreadyInSlot(batch, slot.loc, day.isoDate, slot.meal)) continue;
        // Higher cap than the other passes — only fire when the slot is
        // already covered by the main 2 options AND there's room for an extra.
        const filled = countTypeInSlot(allBatches, batch.type, slot.loc, day.isoDate, slot.meal);
        if (filled < SLOTS_PER_TYPE) continue;        // not yet "finished" — Pass 2/3 should fill
        if (filled >= FINISH_OFF_CAP) continue;       // already at 3-deep, no more room

        batch.services.push({ loc: slot.loc, date: day.isoDate, meal: slot.meal });
        const overshot = calcReq(batch) > ceiling;
        if (overshot) {
          batch.services.pop();
          break walk;
        }

        added++;
        touched.add(batch.id);
        surplus = ceiling - calcReq(batch);
        if (surplus <= 0) break walk;
      }
    }
  }

  return { servicesAdded: added, batchesTouched: touched.size };
}

// ── Entry point ─────────────────────────────────────────────────────────────

/**
 * Slice 2 entry point: cleanup → window → snapshot → placeholders → save.
 * Service assignment (Pass 1, Pass 2) and the validation/rescue UI come in
 * later slices.
 */
export function fixMyMenu(): void {
  const ok = window.confirm(
    "Fix my menu will fill empty cook days with placeholder batches and clean up unused placeholders from previous runs.\n\n" +
    "Existing batches won't be removed or renamed.\n\n" +
    "Continue?"
  );
  if (!ok) return;

  // Step −1: strip every future service entry. Past services (already served)
  // stay; everything else gets re-decided by the assignment passes below.
  // This makes the algorithm REDISTRIBUTIVE rather than purely additive —
  // existing pinned assignments are reshuffled if the algorithm finds a
  // better arrangement.
  stripFutureServices(S.batches);

  // Step 0: cleanup orphan placeholders from previous runs (now that future
  // services are stripped, generated empty placeholders are easier to spot).
  const orphans = findOrphanPlaceholders(S.batches);
  if (orphans.length > 0) {
    const orphanIds = new Set(orphans.map(b => b.id));
    S.batches = S.batches.filter(b => !orphanIds.has(b.id));
    if (!S.deletedBatches) S.deletedBatches = [];
    for (const id of orphanIds) S.deletedBatches.push(id);
  }

  // Step 1: build the 14-day planning window
  const planWindow = buildPlanningWindow(getToday());

  // Step 2: snapshot existing batches keyed by cookDate
  const snapshot = snapshotBatches(S.batches, planWindow);

  // Step 3: generate placeholders for missing cook events
  const newPlaceholders = generateMissingPlaceholders(planWindow, snapshot);
  for (const b of newPlaceholders) {
    S.batches.push(b);
  }

  // Rebuild the planner index BEFORE running the assigner — calcRequired uses
  // S.planner to count peer batches per slot.
  rebuildPlanner();

  // The pass functions tentatively-add a service then immediately call calcReq
  // to check capacity. Without this wrapper, calcReq reads a stale S.planner
  // that doesn't include the just-pushed service, so the "peer count" for the
  // new slot is missing one entry. With two batches at a slot, peers come back
  // as 1 instead of 2 — demand is computed at solo rates, the add overshoots
  // stock, and the slot ends up empty even though it would fit fine when peers
  // actually split the demand. Rebuilding before every calcReq is cheap (~150
  // ops × ~300 calls per fixMyMenu run) and keeps the contract of calcReq
  // unchanged elsewhere.
  const calcReqLive = (b: Batch): number => {
    rebuildPlanner();
    return calcRequired(b);
  };

  // Step 4 — Pass 1: extend cooked batches forward through the window.
  // All passes skip 0-guest slots — no point planning food where nobody eats.
  // Pot capacity is NOT enforced during assignment — pots get allocated by
  // demand AFTER all passes complete (see allocatePotCaps below).
  const pass1 = assignServicesPass1(S.batches, planWindow, calcReqLive, getGuests);
  rebuildPlanner();

  // Step 4 — Pass 2: fill remaining empty positions with the 2-newest rule.
  // Pass the small-pot-threshold + biggest-pot size as soft concentration
  // hints: spread evenly while batches are still small (<80L), then pile
  // demand into one batch up to 140L so the rest stay induction-eligible.
  const biggestPot = S.kitchenEquipment && S.kitchenEquipment.pots.length > 0
    ? Math.max(...S.kitchenEquipment.pots)
    : undefined;
  const pass2 = assignServicesPass2(S.batches, planWindow, calcReqLive, getGuests, biggestPot);
  rebuildPlanner();

  // Step 4 — Pass 3: fill anything still empty. Uses the same Sun-bias and
  // most-loaded-under-bigPot logic as Pass 2 so it doesn't undo concentration.
  const pass3 = assignServicesPass3(S.batches, planWindow, calcReqLive, getGuests, biggestPot);
  rebuildPlanner();

  // Step 4.4 — Pass 4 (finish-off): cooked batches with leftover stock get
  // added as a 3rd peer to slots that are already 2/2. Drains the surplus
  // that would otherwise sit in the walk-in until it freezes or spoils.
  const pass4 = assignServicesPass4(S.batches, planWindow, calcReqLive, getGuests);
  rebuildPlanner();

  // Step 4.5 — Allocate kitchen pots to batches by ACTUAL demand.
  // Biggest pot goes to the batch that needs the most food. This way the
  // 140L pot is never wasted on a low-demand batch just because it sorts
  // first by id. Over-pot batches are flagged by collectWarnings.
  const inWindowBatches = S.batches.filter(b => b.cookDate && TYPES_TO_PLAN.includes(b.type));
  const potCaps = allocatePotCaps(inWindowBatches, S.kitchenEquipment, calcRequired);

  // Step 5: collect warnings (after rebuild so calcRequired sees current peers)
  const warnings = collectWarnings(
    S.batches,
    planWindow,
    S.caterings || [],
    calcRequired,
    potCaps,
    S.kitchenEquipment,
    getGuests,
  );

  rerenderCurrentView();
  scheduleSave();

  showResultsModal({
    cleaned: orphans.length,
    created: newPlaceholders.length,
    assigned: pass1.servicesAdded + pass2.servicesAdded + pass3.servicesAdded + pass4.servicesAdded,
    placeholderNames: newPlaceholders.map(p => p.name),
    warnings,
  });
}

// ── Step 5: validation ─────────────────────────────────────────────────────

export type WarningCategory =
  | 'under-filled-slot'
  | 'cooked-stockout'
  | 'stale-with-stock'
  | 'over-pot-cap'
  | 'burner-overload'
  | 'catering-no-dishes'
  | 'undeliverable-centraal'
  | 'centraal-batch-at-west';

export interface Warning {
  category: WarningCategory;
  message: string;
  // Anchor for "Go to" navigation: a slot, a batch, or a catering
  anchor?: { kind: 'slot'; loc: Location; date: string; meal: Meal }
         | { kind: 'batch'; batchId: string }
         | { kind: 'catering'; cateringId: string };
  // Optional rescue actions
  actions?: WarningAction[];
}

export type WarningAction =
  | { kind: 'use-frozen'; batchId: string; batchName: string }
  | { kind: 'add-emergency-cook'; type: DishType; loc: Location; date: string; meal: Meal }
  | { kind: 'assign-anyway'; batchId: string }
  | { kind: 'move-to-freezer'; batchId: string };

export function collectWarnings(
  allBatches: Batch[],
  window: PlanDay[],
  caterings: { id: string; date: string | null; dishes: { dishId: string }[] }[],
  calcReq: (b: Batch) => number,
  potCaps: Map<string, number>,
  equipment: KitchenEquipment | null,
  getGuestsFn: (loc: Location, date: string, meal: Meal) => number,
): Warning[] {
  const warnings: Warning[] = [];

  // 1. Under-filled slot warnings (only when guests > 0).
  for (const day of window) {
    for (const slot of day.slots) {
      if (slot.isPast) continue;
      const guests = getGuestsFn(slot.loc, day.isoDate, slot.meal);
      if (guests <= 0) continue;
      for (const type of TYPES_TO_PLAN) {
        const filled = countTypeInSlot(allBatches, type, slot.loc, day.isoDate, slot.meal);
        if (filled < SLOTS_PER_TYPE) {
          const missing = SLOTS_PER_TYPE - filled;
          // Find frozen batches of this type as rescue candidates
          const frozen = allBatches.filter(b => b.type === type && b.storage === 'Frozen' && (b.stock || 0) > 0);
          const actions: WarningAction[] = [];
          for (const f of frozen) {
            actions.push({ kind: 'use-frozen', batchId: f.id, batchName: f.name });
          }
          // Today's dinner under-filled? offer emergency cook
          const todayIso = dateToIso(getToday());
          if (day.isoDate === todayIso && slot.meal === 'dinner') {
            actions.push({ kind: 'add-emergency-cook', type, loc: slot.loc, date: day.isoDate, meal: slot.meal });
          }
          const typeLabel = type === 'Main course' ? 'main' : 'soup';
          const locLabel = slot.loc === 'centraal' ? 'Centraal' : 'West';
          warnings.push({
            category: 'under-filled-slot',
            message: missing === 2
              ? `${day.dayName} ${slot.meal} at ${locLabel} has no ${typeLabel} planned. Pick something to serve.`
              : `${day.dayName} ${slot.meal} at ${locLabel} only has 1 ${typeLabel} — guests usually choose between 2.`,
            anchor: { kind: 'slot', loc: slot.loc, date: day.isoDate, meal: slot.meal },
            actions: actions.length > 0 ? actions : undefined,
          });
        }
      }
    }
  }

  // 2. Cooked stockout: a cooked batch's projected demand exceeds its stock.
  for (const b of allBatches) {
    if (!TYPES_TO_PLAN.includes(b.type)) continue;
    if (b.stock <= 0) continue;
    if (b.storage === 'Frozen') continue;
    const demand = calcReq(b);
    if (demand > b.stock) {
      const short = (demand - b.stock).toFixed(1);
      warnings.push({
        category: 'cooked-stockout',
        message: `${b.name} will run out — about ${short}L short across the services it covers. The last service might run dry.`,
        anchor: { kind: 'batch', batchId: b.id },
      });
    }
  }

  // 3. Stale batch with leftover stock.
  for (const b of allBatches) {
    if (!TYPES_TO_PLAN.includes(b.type)) continue;
    if (b.stock <= 0) continue;
    if (b.storage === 'Frozen') continue;
    if (!isStaleAtSlot(b.cookDate, dateToIso(getToday()))) continue;
    warnings.push({
      category: 'stale-with-stock',
      message: `${b.name} is getting old — cooked ${b.cookDate}, ${b.stock}L still left. Either feature it on today's menu, or freeze it before it spoils.`,
      anchor: { kind: 'batch', batchId: b.id },
      actions: [
        { kind: 'assign-anyway', batchId: b.id },
        { kind: 'move-to-freezer', batchId: b.id },
      ],
    });
  }

  // 4. Over-pot-cap: batch projected demand exceeds the biggest pot in the
  // kitchen. We only warn when food won't fit in ANY single pot — within-
  // kitchen reallocation (this batch got a 100L instead of a 140L) is the
  // cook's call and not surfaced here. Showed once in the modal; the batch
  // tile in the planner displays a "TOO BIG" indicator separately.
  const biggestPotInKitchen = equipment && equipment.pots.length > 0
    ? Math.max(...equipment.pots) : Infinity;
  for (const b of allBatches) {
    if (!TYPES_TO_PLAN.includes(b.type)) continue;
    if (b.storage === 'Frozen') continue;
    if (!b.cookDate) continue;
    const demand = calcReq(b);
    if (demand > biggestPotInKitchen) {
      warnings.push({
        category: 'over-pot-cap',
        message: `${b.name} needs ${demand.toFixed(1)}L but your biggest pot is only ${biggestPotInKitchen}L. Cook it in two pots, or scale back what it covers.`,
        anchor: { kind: 'batch', batchId: b.id },
      });
    }
  }

  // 5. Burner overload per cook day: too many >threshold pots needed for
  // available gas burners (which can run pots > threshold). Info-only for v1.
  if (equipment && equipment.gasBurners >= 0) {
    const threshold = equipment.bigBurnerThreshold || 80;
    const byDay = new Map<string, Batch[]>();
    for (const b of allBatches) {
      if (!b.cookDate) continue;
      if (!TYPES_TO_PLAN.includes(b.type)) continue;
      if (!byDay.has(b.cookDate)) byDay.set(b.cookDate, []);
      byDay.get(b.cookDate)!.push(b);
    }
    for (const [day, dayBatches] of byDay) {
      let bigPotCount = 0;
      for (const b of dayBatches) {
        const cap = potCaps.get(b.id);
        if (cap != null && cap > threshold) bigPotCount++;
      }
      if (bigPotCount > equipment.gasBurners) {
        const cookIso = cookDateToIso(day) || '';
        const dayLabel = cookIso ? dateToDayName(cookIso) : day;
        const overflow = bigPotCount - equipment.gasBurners;
        warnings.push({
          category: 'burner-overload',
          message: `${dayLabel} ${day}: ${bigPotCount} dishes need a gas burner but you only have ${equipment.gasBurners}. ${overflow} dish${overflow === 1 ? '' : 'es'} will have to wait — cook the slow ones first, then swap burners.`,
        });
      }
    }
  }

  // 6. Undeliverable Centraal services: West-cooked batch with a Centraal
  // service on the same day as cookDate. Food is delivered to Centraal in the
  // morning, so anything cooked today can't reach Centraal until tomorrow.
  // Catches manual pre-existing assignments that violate the rule.
  for (const b of allBatches) {
    if (!TYPES_TO_PLAN.includes(b.type)) continue;
    if (!b.cookDate || b.location !== 'west') continue;
    const cookIso = cookDateToIso(b.cookDate);
    if (!cookIso) continue;
    const violating = (b.services || []).filter(s => s.loc === 'centraal' && s.date === cookIso);
    if (violating.length > 0) {
      const meals = violating.map(s => s.meal).join(' + ');
      warnings.push({
        category: 'undeliverable-centraal',
        message: `${b.name} is set to serve at Centraal ${meals} on the same day it's cooked. Centraal gets food delivered the morning AFTER cooking — it won't arrive in time. Move it to a later day or cook it earlier.`,
        anchor: { kind: 'batch', batchId: b.id },
      });
    }
  }

  // 6b. Centraal-located batch with a West service. Symmetric to (6) — there's
  // no van going Centraal→West, so a Centraal batch can't physically reach a
  // West slot. Catches manual assignments that violate the no-reverse-flow
  // rule. (Pass 1/2/3 honour the rule via isServableBy and never create these.)
  for (const b of allBatches) {
    if (!TYPES_TO_PLAN.includes(b.type)) continue;
    if (b.location !== 'centraal') continue;
    const violating = (b.services || []).filter(s => s.loc === 'west');
    if (violating.length > 0) {
      warnings.push({
        category: 'centraal-batch-at-west',
        message: `${b.name} is at Centraal but is set to serve at West (${violating.length} service${violating.length === 1 ? '' : 's'}). There's no transport from Centraal back to West — either move the batch, or move the service.`,
        anchor: { kind: 'batch', batchId: b.id },
      });
    }
  }

  // 7. Caterings in window with no dishes assigned.
  const todayIso = dateToIso(getToday());
  const horizonEnd = dateToIso(new Date(getToday().getTime() + (PLANNING_HORIZON_DAYS - 1) * 86400000));
  for (const c of caterings) {
    if (!c.date) continue;
    // Catering date format: DD/MM/YYYY → convert to ISO
    const cIso = cookDateToIso(c.date);
    if (!cIso) continue;
    if (cIso < todayIso || cIso > horizonEnd) continue;
    if (!c.dishes || c.dishes.length === 0) {
      const dayLabel = dateToDayName(cIso);
      warnings.push({
        category: 'catering-no-dishes',
        message: `Catering on ${dayLabel} ${c.date} doesn't have any dishes picked yet. What are they getting?`,
        anchor: { kind: 'catering', cateringId: c.id },
      });
    }
  }

  return warnings;
}

// ── Results modal + warning action handlers ────────────────────────────────

interface ResultsReport {
  cleaned: number;
  created: number;
  assigned: number;
  placeholderNames: string[];
  warnings: Warning[];
}

let _lastReport: ResultsReport | null = null;

function actionLabel(a: WarningAction): string {
  switch (a.kind) {
    case 'use-frozen': return `Use frozen ${a.batchName}`;
    case 'add-emergency-cook': return 'Add emergency dish';
    case 'assign-anyway': return 'Assign anyway';
    case 'move-to-freezer': return 'Move to freezer';
  }
}

function encodeAction(a: WarningAction): string {
  return encodeURIComponent(JSON.stringify(a));
}

function renderWarningRow(w: Warning, idx: number): string {
  const goto = w.anchor ? `<button class="btn btn-sm fix-menu-goto" onclick="fixMenuGoto(${idx})">Go to</button>` : '';
  const actions = (w.actions || []).map(a =>
    `<button class="btn btn-sm fix-menu-action" onclick="fixMenuAction(${idx}, '${encodeAction(a)}')">${esc(actionLabel(a))}</button>`
  ).join('');
  return `<div class="fix-menu-warning-row" data-idx="${idx}">
    <div class="fix-menu-warning-msg">${esc(w.message)}</div>
    <div class="fix-menu-warning-actions">${goto}${actions}</div>
  </div>`;
}

// Category presentation order — most urgent (food won't reach guests) at top,
// least urgent (admin tasks) at bottom. Each category has a short header and
// a one-line explanation a line cook can act on.
const CATEGORY_ORDER: WarningCategory[] = [
  'undeliverable-centraal',  // wrong assignment, needs immediate fix
  'centraal-batch-at-west',  // wrong assignment (no reverse delivery)
  'cooked-stockout',         // real food shortage, will run out
  'under-filled-slot',       // need to plan more food
  'over-pot-cap',            // pot doesn't fit, must split
  'burner-overload',         // can cook in shifts (less urgent)
  'stale-with-stock',        // decision needed (use or freeze)
  'catering-no-dishes',      // admin
];

function categoryHeader(c: WarningCategory): { title: string; hint: string } {
  switch (c) {
    case 'undeliverable-centraal': return { title: '🚚 Won\'t arrive in time', hint: 'Centraal gets food delivered the morning after it\'s cooked.' };
    case 'centraal-batch-at-west': return { title: '↩️ No transport back to West', hint: 'Once food is at Centraal, it stays there — there\'s no return van.' };
    case 'cooked-stockout':        return { title: '🥣 Will run out of food', hint: 'Already cooked but not enough for the planned services.' };
    case 'under-filled-slot':      return { title: '📋 Slots need more food', hint: 'Each service usually has 2 soups + 2 mains.' };
    case 'over-pot-cap':           return { title: '🍲 Won\'t fit in one pot', hint: 'Cook it in two pots so it fits.' };
    case 'burner-overload':        return { title: '🔥 Not enough gas burners', hint: 'You\'ll need to cook in shifts that day.' };
    case 'stale-with-stock':       return { title: '⏰ Old food still around', hint: 'Either use it today or freeze it before it spoils.' };
    case 'catering-no-dishes':     return { title: '📝 Caterings without dishes', hint: 'Pick what they\'re getting from the menu.' };
  }
}

function showResultsModal(report: ResultsReport): void {
  _lastReport = report;
  const { cleaned, created, assigned, placeholderNames, warnings } = report;
  const summary: string[] = [];
  if (created > 0) summary.push(`<div>✅ <strong>Created ${created}</strong> placeholder${created === 1 ? '' : 's'}: ${esc(placeholderNames.slice(0, 8).join(', '))}${placeholderNames.length > 8 ? ', …' : ''}</div>`);
  if (cleaned > 0) summary.push(`<div>🧹 Cleaned ${cleaned} unused placeholder${cleaned === 1 ? '' : 's'} from previous runs</div>`);
  if (assigned > 0) summary.push(`<div>📅 Assigned ${assigned} service slot${assigned === 1 ? '' : 's'}</div>`);
  if (summary.length === 0) summary.push(`<div>Menu already covers the cook rhythm — nothing to do.</div>`);

  // Sort warnings by category order, preserving original index for action handlers.
  const indexed = warnings.map((w, i) => ({ w, i }));
  indexed.sort((a, b) => CATEGORY_ORDER.indexOf(a.w.category) - CATEGORY_ORDER.indexOf(b.w.category));

  // Group by category, render each with a section header
  const sections: string[] = [];
  let lastCat: WarningCategory | null = null;
  let currentRows: string[] = [];
  for (const { w, i } of indexed) {
    if (w.category !== lastCat) {
      if (currentRows.length > 0) sections.push(currentRows.join(''));
      const { title, hint } = categoryHeader(w.category);
      currentRows = [`<div class="fix-menu-section-hdr"><div class="fix-menu-section-title">${esc(title)}</div><div class="fix-menu-section-hint">${esc(hint)}</div></div>`];
      lastCat = w.category;
    }
    currentRows.push(renderWarningRow(w, i));
  }
  if (currentRows.length > 0) sections.push(currentRows.join(''));

  const warningsHtml = warnings.length === 0
    ? `<div class="fix-menu-clean">No issues — menu looks good 🎉</div>`
    : `<div class="fix-menu-warnings-hdr">⚠️ ${warnings.length} thing${warnings.length === 1 ? '' : 's'} to look at</div>
       <div class="fix-menu-warnings-list">${sections.join('')}</div>`;

  const html = `
    <div class="modal-content fix-menu-results" onclick="event.stopPropagation()">
      <h2>Fix My Menu — done</h2>
      <div class="fix-menu-summary">${summary.join('')}</div>
      ${warningsHtml}
      <div class="fix-menu-actions"><button class="btn btn-primary" onclick="closeModal()">Got it</button></div>
    </div>
  `;
  showModal(html);
}

/**
 * Navigate to a warning's anchor point. Closes the modal and scrolls/flashes
 * the relevant DOM element. The element selectors here mirror what the planner
 * renders (slots use `data-loc`/`data-date`/`data-meal`; batches use the tile
 * id; caterings use the catering row id).
 */
export function fixMenuGoto(idx: number): void {
  if (!_lastReport) return;
  const w = _lastReport.warnings[idx];
  if (!w?.anchor) return;
  closeModal();
  // Switch to the right planner sub-tab so the target element is in the DOM.
  const win = window as unknown as { setPlannerSubTab?: (tab: string) => void };
  const setTab = (tab: string) => { if (typeof win.setPlannerSubTab === 'function') win.setPlannerSubTab(tab); };
  if (w.anchor.kind === 'slot') {
    setTab(w.anchor.loc);
  } else if (w.anchor.kind === 'batch') {
    const anchor = w.anchor;  // narrow for closure
    const b = S.batches.find(x => x.id === anchor.batchId);
    setTab(b?.location === 'centraal' ? 'centraal' : 'west');
  } else if (w.anchor.kind === 'catering') {
    setTab('caterings');
  }
  // Wait for re-render before searching for the target element.
  setTimeout(() => {
    let target: Element | null = null;
    if (w.anchor!.kind === 'slot') {
      target = document.querySelector(`.slot[data-loc="${w.anchor.loc}"][data-date="${w.anchor.date}"][data-meal="${w.anchor.meal}"]`);
    } else if (w.anchor!.kind === 'batch') {
      target = document.querySelector(`.batch-tile[data-id="${w.anchor.batchId}"]`);
    } else if (w.anchor!.kind === 'catering') {
      // Caterings list rows have an Edit button referencing the id — find via that
      const editBtn = document.querySelector(`button[onclick="openEditCatering('${w.anchor.cateringId}')"]`);
      target = editBtn?.closest('div, li, tr') || editBtn;
    }
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target.classList.add('slot-highlight');
      setTimeout(() => target.classList.remove('slot-highlight'), 2000);
    }
  }, 250);
}

export function fixMenuAction(idx: number, encoded: string): void {
  if (!_lastReport) return;
  const w = _lastReport.warnings[idx];
  if (!w) return;
  let action: WarningAction;
  try {
    action = JSON.parse(decodeURIComponent(encoded)) as WarningAction;
  } catch (_e: unknown) {
    toastError('Could not decode action');
    return;
  }
  applyWarningAction(w, action, idx);
}

function applyWarningAction(w: Warning, a: WarningAction, idx: number): void {
  switch (a.kind) {
    case 'move-to-freezer': {
      const b = S.batches.find(x => x.id === a.batchId);
      if (!b) return;
      b.storage = 'Frozen';
      removeWarningRow(idx);
      rebuildPlanner();
      rerenderCurrentView();
      scheduleSave();
      toast(`Moved ${b.name} to freezer`);
      return;
    }
    case 'use-frozen': {
      const b = S.batches.find(x => x.id === a.batchId);
      if (!b || w.anchor?.kind !== 'slot') return;
      b.services.push({ loc: w.anchor.loc, date: w.anchor.date, meal: w.anchor.meal });
      removeWarningRow(idx);
      rebuildPlanner();
      rerenderCurrentView();
      scheduleSave();
      toast(`Assigned ${b.name} (frozen) to ${w.anchor.date} ${w.anchor.meal}`);
      return;
    }
    case 'assign-anyway': {
      const b = S.batches.find(x => x.id === a.batchId);
      if (!b || w.anchor?.kind !== 'batch') return;
      // Find next under-filled slot of this batch's type and assign
      let placed = false;
      for (const day of buildPlanningWindow(getToday())) {
        if (placed) break;
        for (const slot of day.slots) {
          if (slot.isPast) continue;
          if (countTypeInSlot(S.batches, b.type, slot.loc, day.isoDate, slot.meal) >= SLOTS_PER_TYPE) continue;
          if (alreadyInSlot(b, slot.loc, day.isoDate, slot.meal)) continue;
          b.services.push({ loc: slot.loc, date: day.isoDate, meal: slot.meal });
          placed = true;
          toast(`Assigned ${b.name} to ${day.dayName} ${slot.meal} ${slot.loc}`);
          break;
        }
      }
      if (placed) {
        removeWarningRow(idx);
        rebuildPlanner();
        rerenderCurrentView();
        scheduleSave();
      } else {
        toastError('No under-filled slot available for this batch');
      }
      return;
    }
    case 'add-emergency-cook': {
      const dayName = dateToDayName(a.date);
      const typeLabel = a.type === 'Main course' ? 'Main' : 'Soup';
      const todayStr = dateToStr(getToday());
      // Reuse an existing emergency batch for same type+day if there is one,
      // rather than creating a fresh batch per click. Otherwise multiple
      // warning clicks pile up duplicate placeholders that each cover one
      // service — wasteful, and inflates the burner-overload count.
      const existing = S.batches.find(b =>
        b.type === a.type
        && b.cookDate === todayStr
        && b.cookNotes === 'Emergency morning cook'
        && !alreadyInSlot(b, a.loc, a.date, a.meal)
      );
      if (existing) {
        existing.services.push({ loc: a.loc, date: a.date, meal: a.meal });
        removeWarningRow(idx);
        rebuildPlanner();
        rerenderCurrentView();
        scheduleSave();
        toast(`Added ${dayName} ${a.meal} ${a.loc} to existing emergency ${typeLabel.toLowerCase()}`);
        return;
      }
      const newBatch: Batch = {
        id: newId(),
        name: `${dayName} ${typeLabel} (Emergency)`,
        type: a.type,
        stock: 0, serving: 280, storage: 'Gastro',
        location: 'west', inTransit: false,
        allergens: [], extraAllergens: [], orderFor: false, parentId: null,
        cookDate: todayStr,
        recipeSheetId: null, recipeVolume: null, recipeIngredients: null,
        note: '',
        services: [{ loc: a.loc, date: a.date, meal: a.meal }],
        createdAt: new Date().toISOString(),
        recipeId: null, actualIngredients: null,
        cookNotes: 'Emergency morning cook', stockDeducted: false,
        generated: true,
      };
      S.batches.push(newBatch);
      removeWarningRow(idx);
      rebuildPlanner();
      rerenderCurrentView();
      scheduleSave();
      toast(`Added emergency ${typeLabel.toLowerCase()} for ${dayName} ${a.meal} ${a.loc}`);
      return;
    }
  }
}

function removeWarningRow(idx: number): void {
  const row = document.querySelector(`.fix-menu-warning-row[data-idx="${idx}"]`);
  if (!row) return;
  // Remove the row, then its section header if no rows of that category remain.
  // The section grouping puts each header before a run of warning rows of the
  // same category; once the last warning of a category is removed, the header
  // is dangling and should go too.
  let sectionHdr: Element | null = row.previousElementSibling;
  while (sectionHdr && !sectionHdr.classList.contains('fix-menu-section-hdr')) {
    sectionHdr = sectionHdr.previousElementSibling;
  }
  row.remove();
  if (sectionHdr) {
    let next: Element | null = sectionHdr.nextElementSibling;
    let stillHasWarnings = false;
    while (next && !next.classList.contains('fix-menu-section-hdr')) {
      if (next.classList.contains('fix-menu-warning-row')) { stillHasWarnings = true; break; }
      next = next.nextElementSibling;
    }
    if (!stillHasWarnings) sectionHdr.remove();
  }
  // If the list is now empty of warning rows, replace it with the "all clear" message.
  const list = document.querySelector('.fix-menu-warnings-list');
  if (list && list.querySelectorAll('.fix-menu-warning-row').length === 0) {
    const hdr = document.querySelector('.fix-menu-warnings-hdr');
    if (hdr) hdr.remove();
    list.outerHTML = `<div class="fix-menu-clean">All issues resolved 🎉</div>`;
  }
}

// ── Kitchen equipment editor ────────────────────────────────────────────────

const DEFAULT_EQUIPMENT: KitchenEquipment = {
  pots: [],
  gasBurners: 0,
  inductionBurners: 0,
  bigBurnerThreshold: 80,
};

/** Working draft used by the modal — a copy so Cancel discards cleanly. */
let _keqDraft: KitchenEquipment = { ...DEFAULT_EQUIPMENT };

function renderEquipmentList(): string {
  const sortedPots = [..._keqDraft.pots].sort((a, b) => b - a);
  const items = sortedPots.length === 0
    ? `<div class="keq-empty">No pots configured. Add one below.</div>`
    : sortedPots.map((liters, idx) => {
        const tier = liters > _keqDraft.bigBurnerThreshold ? 'gas' : 'induction';
        const tierLabel = tier === 'gas' ? `<span class="keq-tier-gas">Gas burner</span>` : `<span class="keq-tier-induction">Induction</span>`;
        return `<div class="keq-pot-row">
          <span class="keq-pot-size">${liters} L</span>
          ${tierLabel}
          <button class="btn btn-sm btn-danger" onclick="keqRemovePot(${idx})">Remove</button>
        </div>`;
      }).join('');
  return items;
}

function renderEquipmentSummary(): string {
  const totalPots = _keqDraft.pots.length;
  const bigPots = _keqDraft.pots.filter(p => p > _keqDraft.bigBurnerThreshold).length;
  const smallPots = totalPots - bigPots;
  const burnersTotal = _keqDraft.gasBurners + _keqDraft.inductionBurners;
  const issues: string[] = [];
  if (bigPots > _keqDraft.gasBurners) issues.push(`⚠️ ${bigPots} pots over ${_keqDraft.bigBurnerThreshold}L but only ${_keqDraft.gasBurners} gas burner${_keqDraft.gasBurners === 1 ? '' : 's'}`);
  if (totalPots > burnersTotal) issues.push(`⚠️ ${totalPots} pots but only ${burnersTotal} burners — can't cook everything in parallel`);
  return `<div class="keq-summary">
    <div><strong>${totalPots}</strong> pot${totalPots === 1 ? '' : 's'}: ${bigPots} over ${_keqDraft.bigBurnerThreshold}L (need gas), ${smallPots} ≤ ${_keqDraft.bigBurnerThreshold}L</div>
    <div><strong>${burnersTotal}</strong> burner${burnersTotal === 1 ? '' : 's'}: ${_keqDraft.gasBurners} gas, ${_keqDraft.inductionBurners} induction</div>
    ${issues.length > 0 ? `<div class="keq-warnings">${issues.map(i => `<div>${i}</div>`).join('')}</div>` : ''}
  </div>`;
}

function refreshEquipmentModal() {
  const list = document.getElementById('keq-pot-list');
  const summary = document.getElementById('keq-summary');
  if (list) list.innerHTML = renderEquipmentList();
  if (summary) summary.innerHTML = renderEquipmentSummary();
}

export function openKitchenEquipmentModal(): void {
  const current = S.kitchenEquipment || { ...DEFAULT_EQUIPMENT };
  _keqDraft = {
    pots: [...(current.pots || [])],
    gasBurners: current.gasBurners || 0,
    inductionBurners: current.inductionBurners || 0,
    bigBurnerThreshold: current.bigBurnerThreshold || 80,
  };

  const html = `
    <div class="modal-content keq-modal" onclick="event.stopPropagation()">
      <h2>Kitchen equipment</h2>
      <p class="keq-help">Tells Fix My Menu how to size cook batches. Pots over ${_keqDraft.bigBurnerThreshold}L need a gas burner; smaller pots fit on induction.</p>

      <div class="keq-section">
        <h3>Pots</h3>
        <div id="keq-pot-list">${renderEquipmentList()}</div>
        <div class="keq-add-pot">
          <input id="keq-new-pot" type="number" min="1" max="1000" placeholder="Liters" />
          <button class="btn btn-primary" onclick="keqAddPotFromInput()">+ Add pot</button>
        </div>
      </div>

      <div class="keq-section">
        <h3>Burners</h3>
        <div class="keq-burner-row">
          <label>Gas burners <span class="keq-hint">(handle pots > ${_keqDraft.bigBurnerThreshold}L)</span></label>
          <input id="keq-gas" type="number" min="0" max="100" value="${_keqDraft.gasBurners}" oninput="keqUpdateBurners('gas', this.value)" />
        </div>
        <div class="keq-burner-row">
          <label>Induction burners <span class="keq-hint">(handle pots ≤ ${_keqDraft.bigBurnerThreshold}L)</span></label>
          <input id="keq-induction" type="number" min="0" max="100" value="${_keqDraft.inductionBurners}" oninput="keqUpdateBurners('induction', this.value)" />
        </div>
      </div>

      <div id="keq-summary" class="keq-section">${renderEquipmentSummary()}</div>

      <div class="keq-actions">
        <button class="btn" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="keqSave()">Save</button>
      </div>
    </div>
  `;
  showModal(html);
}

export function keqAddPotFromInput(): void {
  const inp = document.getElementById('keq-new-pot') as HTMLInputElement | null;
  if (!inp) return;
  const liters = Number(inp.value);
  if (!liters || liters <= 0 || liters > 1000) {
    toastError('Enter a pot size between 1 and 1000 L');
    return;
  }
  _keqDraft.pots.push(liters);
  inp.value = '';
  refreshEquipmentModal();
  inp.focus();
}

export function keqRemovePot(idx: number): void {
  // Remove from the SORTED-descending view's index, not the raw array
  const sortedPots = [..._keqDraft.pots].sort((a, b) => b - a);
  const target = sortedPots[idx];
  if (target == null) return;
  // Remove first occurrence in the unsorted array
  const removeAt = _keqDraft.pots.indexOf(target);
  if (removeAt >= 0) _keqDraft.pots.splice(removeAt, 1);
  refreshEquipmentModal();
}

export function keqUpdateBurners(field: 'gas' | 'induction', value: string): void {
  const n = Math.max(0, Math.min(100, Number(value) || 0));
  if (field === 'gas') _keqDraft.gasBurners = n;
  else _keqDraft.inductionBurners = n;
  // Refresh only the summary to show updated warnings without losing input focus
  const summary = document.getElementById('keq-summary');
  if (summary) summary.innerHTML = renderEquipmentSummary();
}

export async function keqSave(): Promise<void> {
  S.kitchenEquipment = {
    pots: [..._keqDraft.pots],
    gasBurners: _keqDraft.gasBurners,
    inductionBurners: _keqDraft.inductionBurners,
    bigBurnerThreshold: _keqDraft.bigBurnerThreshold,
  };
  await saveKitchenEquipment();
  closeModal();
  toast('Kitchen equipment saved');
}
