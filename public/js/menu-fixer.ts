// ── FIX MY MENU ─────────────────────────────────────────────────────────────
// Single button that scaffolds and rebalances the 14-day menu.
//
// Algorithm: forced-assignment pre-pass + single scored greedy loop +
// fallback ladder (multi-batch teams → emergency placeholder → abandoned
// warning).
//
// Unified-batch model (Checkpoint 4): each Batch carries inventory[] and
// shipments[] — no parent/split families. Stock per location reads as
// getStockAt(b, loc); total stock as getTotalStock(b). Cross-batch
// same-recipe peers are intentional (audit S7) and counted as distinct
// menu options for peer-share math.

import type { Batch, DishType, Location, Meal, KitchenEquipment, CookRhythmDay, Catering, Service } from '@shared/types';
import { addDays } from '@shared/dates';
import { S, DEFAULT_COOK_RHYTHM, isEventLoc } from './state';
import { newId, scheduleSave, toast, toastError, saveKitchenEquipment, saveCookRhythm, markRitualStep } from './utils';
import {
  rebuildPlanner, getToday, dateToIso, dateToStr, dateToDayName, getAmsterdamNow,
  isServicePast, isServiceDatePast, calcRequired, calcRequiredLive, calcRequiredAtLocLive, getEffectiveGuests, isServiceClosed, cateringActive, getTotalStock, getStockAt,
  getServeableStockAt, getServeableTotalStock, getServeablePendingTo, westReachesCentraal, westReaches,
  getPendingFromShipments,
  consolidateInventory,
} from './core';
import { rerenderCurrentView } from './navigate';
import { showModal, closeModal, esc } from './modal';
import { markFixMyMenuRun } from './transport-card';
import { captureMenuSnapshot, recordFixMyMenuSnapshots } from './fmm-snapshot';
import { fixMyMenuRitualSteps } from './ritual';

// ── Constants ───────────────────────────────────────────────────────────────

// Weekly cook rhythm — the editable "rules" Fix My Menu plans against.
// All cooking happens at West by default. Sunday is the big-cook day (lots of
// volunteers); Mon/Tue live off Sunday's surplus so cooks can clean and
// organise. Wed–Sat are steady 1+1 days.
//
// The default lives in state.ts (DEFAULT_COOK_RHYTHM) so the loader/editor can
// read it without a circular import; COOK_RHYTHM re-exports it as the baseline.
// All reads go through getActiveRhythm(), which layers the user's saved config
// (S.cookRhythm) on top of the default, day by day.
export const COOK_RHYTHM: Record<string, CookRhythmDay> = DEFAULT_COOK_RHYTHM;

// Reference-keyed memo: S.cookRhythm only changes on load/save, never mid-run,
// so caching by reference keeps the hot scoring loop allocation-free while
// still picking up a changed config (or a test mutating S.cookRhythm).
let _activeRhythmCache: Record<string, CookRhythmDay> | null = null;
let _activeRhythmKey: unknown = Symbol('uninit');
export function getActiveRhythm(): Record<string, CookRhythmDay> {
  if (_activeRhythmKey === S.cookRhythm && _activeRhythmCache) return _activeRhythmCache;
  const merged: Record<string, CookRhythmDay> = {};
  for (const day of Object.keys(DEFAULT_COOK_RHYTHM)) {
    merged[day] = { ...DEFAULT_COOK_RHYTHM[day] };
  }
  const saved = S.cookRhythm?.days;
  if (saved) {
    for (const day of Object.keys(saved)) {
      const d = saved[day];
      if (!d) continue;
      const soup = Number(d.soup);
      const main = Number(d.main);
      if (!Number.isFinite(soup) || !Number.isFinite(main)) continue;
      const chefs = Number.isFinite(Number(d.chefs)) ? Number(d.chefs) : (soup + main);
      merged[day] = { soup, main, chefs };
    }
  }
  _activeRhythmCache = merged;
  _activeRhythmKey = S.cookRhythm;
  return merged;
}

export const SLOTS_PER_TYPE = 2;
export const PLANNING_HORIZON_DAYS = 7;
export const TYPES_TO_PLAN: DishType[] = ['Soup', 'Main course'];

// All four service slots per day, in canonical order (Centraal first so
// Centraal slots get filled first when the algorithm has to choose).
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
 * services (already served by `isServicePast`) are preserved as-is, and so
 * are PINNED assignments (📌 on the planner chip) — a cook's explicit "leave
 * this here". Makes the algorithm redistributive for everything else: a
 * clean slate of future assignments, rebuilt from current state. Pinned
 * services still count as slot coverage downstream (countTypeInSlot reads
 * live services), so the greedy passes plan around them. This is the only
 * place Fix My Menu removes INDIVIDUAL service assignments (the passes after
 * it only add); the other removal path is whole-batch retirement, where
 * findSpentBatches can't hit a batch with a future service and
 * findStalePlaceholders explicitly spares pinned ones — so together a pinned
 * assignment survives the whole run. Note stripping a placeholder's future
 * services is exactly what makes an active-catering placeholder look like an
 * orphan on the next line; the retirement passes guard against that via
 * cateringReferencedBatchIds.
 */
export function stripFutureServices(batches: Batch[]): number {
  let removed = 0;
  for (const b of batches) {
    if (!b.services || b.services.length === 0) continue;
    // Event-location services are treated like pins: Fix My Menu never plans
    // event locations (SLOT list is west/centraal only), so it must never
    // remove a festival assignment either — those are planned by hand.
    const kept = b.services.filter(s => isServicePast(s) || s.pinned === true || isEventLoc(s.loc));
    removed += b.services.length - kept.length;
    b.services = kept;
  }
  return removed;
}

// ── Cleanup orphan + spent batches ──────────────────────────────────────────

/**
 * Batch ids that an ACTIVE catering still points at. A catering-referenced
 * batch is in use — the event is getting that dish — so the auto-retire
 * cleanups below must spare it, even when it's an empty generated placeholder
 * with no service assignment (picking a dish for a catering records a
 * `catering.dishes` ref, NOT a Batch service). Gated on `cateringActive` so a
 * DELIVERED (past) catering's dead placeholder can still be cleaned up, matching
 * how catering demand itself is retired (core.ts `cateringActive`). Without this
 * guard, pressing Fix My Menu retired every placeholder a cook had pinned to an
 * upcoming catering — stripFutureServices empties the placeholder's services,
 * so findOrphanPlaceholders then saw a serviceless, recipeless generated batch
 * and dropped it, and dropRetiredDishesFromCaterings silently removed it from
 * the event (reported 2026-07-15).
 */
export function cateringReferencedBatchIds(caterings: Catering[]): Set<string> {
  const ids = new Set<string>();
  for (const c of caterings || []) {
    if (!cateringActive(c)) continue;
    for (const d of (c.dishes || [])) ids.add(d.dishId);
  }
  return ids;
}

/**
 * Batches generated by a previous run, never assigned to a service, never
 * linked to a recipe. Pressing the button twice in a row is idempotent
 * because the second run undoes the placeholders the first run created.
 *
 * Cook-created placeholders (`generated !== true`) are NEVER returned, and
 * neither is any batch in `protectedIds` (an active catering's dish — see
 * cateringReferencedBatchIds): a catering pick isn't a service, so without the
 * guard a placeholder held only by a catering looks exactly like an orphan.
 */
export function findOrphanPlaceholders(batches: Batch[], protectedIds: Set<string> = new Set()): Batch[] {
  return batches.filter(b =>
    b.generated === true
    && (!b.services || b.services.length === 0)
    && !b.recipeId
    && !protectedIds.has(b.id)
  );
}

/**
 * Spent batches: total stock = 0, no pending shipments, and every service
 * dated strictly before today (isServiceDatePast — a date-only check, so a
 * batch still scheduled for today is never auto-retired, even right after
 * inventory has been marked done). Auto-retire keeps the planner clear of
 * dead past records; the pending-shipment guard protects food that's been
 * packed but is still in transit. A batch in `protectedIds` (an active
 * catering's dish) is spared — a future catering can still need a batch whose
 * stock has hit zero.
 */
export function findSpentBatches(batches: Batch[], protectedIds: Set<string> = new Set()): Batch[] {
  return batches.filter(b =>
    TYPES_TO_PLAN.includes(b.type)
    && !protectedIds.has(b.id)
    && getTotalStock(b) === 0
    && (b.shipments || []).every(s => s.arrived)
    && b.services && b.services.length > 0
    && b.services.every(s => isServiceDatePast(s))
  );
}

/**
 * Stale generated placeholders: a Fix-My-Menu placeholder whose cook day is
 * already in the past but that never produced any stock — a dead cook plan.
 * Like findSpentBatches but keyed on a past cookDate rather than past
 * services, so it also catches placeholders that were never assigned a
 * service (or that got a recipe but no service) — those slip through both
 * findOrphanPlaceholders (a recipe disqualifies them) and findSpentBatches
 * (no services disqualifies them). Only `generated` placeholders are
 * returned; cook-created batches are never auto-removed. The pending-shipment
 * guard protects food that's been packed but is still in transit, and a batch
 * in `protectedIds` (an active catering's dish) is spared so a placeholder a
 * cook pinned to an upcoming catering survives a slipped cook day.
 */
export function findStalePlaceholders(batches: Batch[], todayIso: string, protectedIds: Set<string> = new Set()): Batch[] {
  return batches.filter(b => {
    if (b.generated !== true) return false;
    if (!TYPES_TO_PLAN.includes(b.type)) return false;
    if (protectedIds.has(b.id)) return false;
    if (getTotalStock(b) > 0) return false;
    if (!(b.shipments || []).every(s => s.arrived)) return false;
    // A cook's 📌 outranks the cleanup: a pinned upcoming assignment means
    // "leave this here" even when the cook day slipped. Without this guard
    // the retire path would silently delete the pinned chip — the one hole
    // in the pin contract (review finding). The batch stays visible in the
    // To-cook pool so the missed cook is still apparent.
    // Event-location services get the same protection (exact analogue of the
    // pin/catering bugs): a placeholder held only by an upcoming festival
    // service must survive a slipped cook day.
    if ((b.services || []).some(s => (s.pinned === true || isEventLoc(s.loc)) && !isServicePast(s))) return false;
    const cookIso = cookDateToIso(b.cookDate);
    if (!cookIso) return false;
    return cookIso < todayIso;
  });
}

/**
 * Drop catering dish references that point at a now-retired batch. Mutates
 * each catering's `dishes` in place (same as the delete branch of
 * `cleanCateringRefs` in dishes.ts) and returns the (catering, dish) pairs
 * that were removed so the caller can warn about them. Without this, a
 * catering left holding a retired placeholder's id silently stops counting
 * toward any real dish's required quantity — the demand vanishes onto a
 * dead id that no live batch matches.
 */
export function dropRetiredDishesFromCaterings(
  caterings: Catering[],
  retiredIds: Set<string>,
): { cateringId: string; cateringName: string; dishName: string }[] {
  const dropped: { cateringId: string; cateringName: string; dishName: string }[] = [];
  for (const c of caterings) {
    if (!c.dishes || c.dishes.length === 0) continue;
    for (const d of c.dishes) {
      if (retiredIds.has(d.dishId)) {
        dropped.push({ cateringId: c.id, cateringName: c.name, dishName: d.name });
      }
    }
    c.dishes = c.dishes.filter(d => !retiredIds.has(d.dishId));
  }
  return dropped;
}

// ── Placeholder generation ──────────────────────────────────────────────────

interface PlaceholderInput {
  cookDateStr: string;
  isoDate: string;
  dayName: string;
  type: DishType;
  index: number;     // 1-based among same-day same-type
  total: number;     // total of this type cooked this day per rhythm
}

function buildPlaceholder(input: PlaceholderInput): Batch {
  // Lowercase type label so placeholders sort visually after real recipe names.
  const typeLabel = input.type === 'Main course' ? 'main' : 'soup';
  const indexSuffix = input.total > 1 ? ` ${input.index}` : '';
  // Strip the year — keep just dd/mm so the name stays compact in the planner UI.
  const ddmm = input.cookDateStr.split('/').slice(0, 2).join('/');
  const name = `${input.dayName} ${typeLabel}${indexSuffix} ${ddmm}`;

  return {
    id: newId(),
    name,
    type: input.type,
    serving: 280,
    inventory: [],
    shipments: [],
    allergens: [],
    extraAllergens: [],
    orderFor: false,
    cookDate: input.cookDateStr,
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
 * placeholder Batches to fill the gap. Overshoots stay (never normalize down).
 */
export function generateMissingPlaceholders(window: PlanDay[], snapshot: BatchSnapshot): Batch[] {
  const newBatches: Batch[] = [];
  const activeRhythm = getActiveRhythm();

  for (const day of window) {
    const rhythm = activeRhythm[day.dayName];
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
 * batches and return a per-batch liters cap. Demand-DESC ordering so the
 * biggest pot goes to the batch needing the most food.
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

  const byDay = new Map<string, Batch[]>();
  for (const b of batchesInWindow) {
    if (!b.cookDate) continue;
    if (!TYPES_TO_PLAN.includes(b.type)) continue;
    if (!byDay.has(b.cookDate)) byDay.set(b.cookDate, []);
    byDay.get(b.cookDate)!.push(b);
  }

  for (const [, dayBatches] of byDay) {
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

// ── Slot eligibility helpers ────────────────────────────────────────────────

export function cookDateToIso(ddmmyyyy: string | null | undefined): string | null {
  if (!ddmmyyyy) return null;
  const parts = ddmmyyyy.split('/');
  if (parts.length !== 3) return null;
  const [dd, mm, yyyy] = parts;
  if (!dd || !mm || !yyyy) return null;
  return `${yyyy}-${mm}-${dd}`;
}

// Pure (two ISO date strings → integer day diff) — memoized module-wide. Fix
// My Menu's scored loop re-derives the same handful of date pairs tens of
// thousands of times; the key space is tiny (window dates × cook dates).
const _diffDaysCache = new Map<string, number>();
function diffDaysIso(aIso: string, bIso: string): number {
  const k = aIso + '|' + bIso;
  const hit = _diffDaysCache.get(k);
  if (hit !== undefined) return hit;
  const a = new Date(aIso + 'T12:00:00').getTime();
  const b = new Date(bIso + 'T12:00:00').getTime();
  const v = Math.round((b - a) / 86400000);
  _diffDaysCache.set(k, v);
  return v;
}

/**
 * Cook-loc heuristic for the unified model: where this batch was
 * originally cooked (and where its ingredient deduction is anchored). Per
 * the plan's Primary location decision: `inventory[0].loc`, set at first
 * confirmCooked and sticky thereafter. Falls back to 'west' for empty-
 * inventory placeholders (default cook location).
 */
function primaryLoc(b: Batch): Location {
  return (b.inventory && b.inventory.length > 0 ? b.inventory[0].loc : 'west');
}

/** Distinct event-location slugs this batch touches — via a service, settled
 *  stock, or an in-flight shipment heading there. Empty for the overwhelming
 *  majority of batches, which is what keeps the event-aware capacity paths
 *  below on their exact pre-event fast path (bench bit-identical). */
function eventLocsTouching(b: Batch): string[] {
  const set = new Set<string>();
  for (const s of (b.services || [])) if (isEventLoc(s.loc)) set.add(s.loc);
  for (const e of (b.inventory || [])) if (e.qty > 0 && isEventLoc(e.loc)) set.add(e.loc);
  for (const sh of (b.shipments || [])) if (!sh.arrived && isEventLoc(sh.toLoc)) set.add(sh.toLoc);
  return [...set];
}

/** Demand (liters) of the services EXCLUDED by `keep`, derived through the
 *  injected calcReq (total minus demand-with-them-removed) so it tracks
 *  calcReq's peer-share model — and any unit-test stub — exactly. Mirrors the
 *  service-filter trick the capacity gate already uses for West/Centraal.
 *  Restores b.services before returning. */
function demandOfExcluded(
  b: Batch,
  all: Service[],
  calcReq: (b: Batch) => number,
  totalDemand: number,
  keep: (s: Service) => boolean,
): number {
  b.services = all.filter(keep);
  try {
    return Math.round((totalDemand - calcReq(b)) * 10) / 10;
  } finally {
    b.services = all;
  }
}

/**
 * Whether this batch has only Frozen inventory entries. Pure-frozen
 * batches are excluded from the auto-rotation; cooks can force-assign
 * them via the use-frozen warning action.
 */
function isOnlyFrozen(b: Batch): boolean {
  const inv = b.inventory || [];
  if (inv.length === 0) return false;  // placeholder, not frozen
  return inv.every(e => e.storage === 'Frozen');
}

/**
 * A batch with cookDate = X is servable starting at dinner of X (lunch of
 * X is too early — cooking happens during the day). Any later day is fine.
 *
 * Location rules use the batch's cook location (primary loc):
 *   - West-cooked batch + Centraal slot → next-morning delivery, EXCEPT a
 *     Sunday cook can reach Centraal's SAME-DAY dinner: Sunday's cook starts
 *     very early and there's no Centraal lunch, so the van leaves later and
 *     makes the evening shift. (This 'Sun' check is a real calendar-day
 *     logistics fact — distinct from the configurable big-cook day — so it is
 *     intentionally hardcoded.)
 *   - Centraal-cooked batch + West slot → NEVER. No reverse delivery.
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
  // Event locations (FMM never generates event slots, but planner drag
  // validation may ask): food cooked AT an event never leaves it except by
  // manual shipping, and an event slot is reachable only from West (next
  // morning — no Sunday exception, that's Centraal's van) or cooked on-site.
  if (isEventLoc(batchLocation)) {
    if (slotLoc !== batchLocation) return false;
    // same-location: fall through to the standard same-day-dinner rule below
  } else if (isEventLoc(slotLoc)) {
    if (batchLocation !== 'west') return false;
    return westReaches(slotLoc, cookIso, slotIsoDate, slotMeal);
  }
  if (slotLoc === 'west' && batchLocation === 'centraal') return false;
  if (slotLoc === 'centraal' && batchLocation === 'west') {
    // West→Centraal timing — next morning+, with the Sunday same-day dinner
    // exception. Shared with the planner's coverage engine (single source of
    // truth) so Fix My Menu and the on-screen coverage can never disagree.
    return westReachesCentraal(cookIso, slotIsoDate, slotMeal);
  }
  if (slotIsoDate > cookIso) return true;
  return slotMeal === 'dinner';
}

/**
 * How many DISTINCT batches of `type` currently have a service entry at the
 * given slot. In the unified-batch model each batch is its own "menu
 * option" — cross-batch same-recipe peers are intentional (audit S7) and
 * count as separate options for peer-share math. Counts the LIVE state of
 * `batches.services` so it picks up assignments added earlier in the same
 * pass.
 */
export function countTypeInSlot(batches: Batch[], type: DishType, loc: Location, isoDate: string, meal: Meal): number {
  let count = 0;
  for (const b of batches) {
    if (b.type !== type) continue;
    if (!b.services || b.services.length === 0) continue;
    if (!b.services.some(s => s.loc === loc && s.date === isoDate && s.meal === meal)) continue;
    count++;
  }
  return count;
}

/**
 * True if `batch` is already at the given slot. Per-batch only — no
 * family-aware peering in the unified model. Cross-batch duplicates of
 * the same recipe ARE allowed at the same slot (counts as 2 peers).
 *
 * `allBatches` parameter kept for backward compat with callers that still
 * pass it; it's no longer read.
 */
export function alreadyInSlot(batch: Batch, loc: Location, isoDate: string, meal: Meal, _allBatches?: Batch[]): boolean {
  return (batch.services || []).some(s => s.loc === loc && s.date === isoDate && s.meal === meal);
}

// ── Scored algorithm constants ─────────────────────────────────────────────

// There is deliberately NO hard age cutoff for cooked stock (Daan's rule,
// 2026-07-10 — replaced the old 5-day FRESH_LIMIT_DAYS wall): old food is
// planned FIRST (FIFO, tier 3) and stays in the rotation until a chef pulls
// it — freeze it, write it off, or remove the service by hand. The
// stale-with-stock warning (staleStockWarnings) is the chef's cue to decide.

/** Floor for forced-assignment lock-in. A unique-candidate slot is pre-locked
 *  only if it fills a real coverage tier (any in-window slot does). Set to the
 *  coverage band so the threshold tracks the tiered score, not a raw number. */
const FORCED_ASSIGN_MIN_SCORE = 1_000_000_000; // = T_COVERAGE (see SCORE below)

/** Fallback ladder team threshold: "some coverage" beats "none." */
const FALLBACK_TEAM_MIN_COVERAGE = 0.6;

/** Portion estimate (ml) per guest per dish, used only to size the week's total
 *  cook demand for the workload-overload capacity model (computeWeeklyCapacities).
 *  Each guest at a service eats roughly one soup + one main portion of this size. */
const DEFAULT_SERVING_ML = 280;
const WORKLOAD_OVERLOAD_TRIGGER_FACTOR = 1.2;
const WORKLOAD_PENALTY_PER_LITER = 30;

// ── Lexicographic tier scoring ──────────────────────────────────────────────
//
// A candidate's score is composed of four tiers, combined so a higher tier
// STRICTLY dominates every lower one regardless of their values:
//
//   score = coverage·BAND³ + primary·BAND² + secondary·BAND + tiebreak
//
// Every tier value is kept in [0, BAND) so it can never overflow the tier
// above. This is the structural fix for the 2026-06 fragility: previously all
// ~12 factors were additive weights of similar magnitude, so a dish preference
// (READY_STOCK_PRIORITY 2000) could overpower slot-coverage urgency
// (EMPTY_SLOT 1000) and strand today's slots. With tiers, coverage can never
// be overridden by preference, nor preference by a tiebreaker.
//
//   tier 1 coverage  — fill empty slots before half-filled ones
//   tier 2 primary   — ready stock before a new cook, SOONEST slot first
//                      (reserve today); for new cooks, cook-timing fitness
//   tier 3 secondary — Centraal coverage priority + FIFO (oldest cooked first)
//   tier 4 tiebreak  — drain local/Centraal stock, pot fill, allergen variety,
//                      workload-overload deterrent
//
// To bias toward draining stock over reserving today ("waste-lean" mode from
// the bench), move READY_SOON_PER_DAY out of `primary` into `tiebreak`.
const SCORE_BAND = 1000;
const T_COVERAGE = SCORE_BAND ** 3; // 1e9
const T_PRIMARY = SCORE_BAND ** 2;  // 1e6
const T_SECONDARY = SCORE_BAND;     // 1e3

const SCORE = {
  // tier 1 — coverage
  COVER_EMPTY: 2,
  COVER_HALF: 1,
  // tier 2 — primary (each ≤ 999)
  READY_BASE: 500,            // any ready-stock candidate outranks any new cook
  READY_SOON_PER_DAY: 40,     // ready: soonest slot first (reserve today)
  COOK_DINNER_SAMEDAY: 400,   // new cook: ideal — cook & serve same evening
  COOK_DINNER_PRIOR: 200,
  COOK_LUNCH_PRIOR: 300,      // new cook at lunch: prior-day cook is best
  COOK_LUNCH_SAMEDAY: 80,     // same-day lunch is too early (no cooling cycle)
  COOK_STALE_PER_DAY: 25,     // graduated freshness penalty for multi-day reach
  COOK_STALE_DAY4: 120,       // extra push past 4 days
  // tier 3 — secondary (each ≤ 999)
  CENTRAAL_PRIORITY: 200,     // harder to improvise an emergency cook at Centraal
  READY_FIFO_PER_DAY: 40,     // oldest cooked stock first
  // tier 4 — tiebreak (centered on a positive base so penalties can't go < 0)
  TIE_BASE: 500,
  CENTRAAL_STOCK_AT_CENTRAAL: 100,
  SAME_LOCATION: 50,
  POT_FILL_BONUS_MAX: 30,
  ALLERGEN_DIVERSITY: 25,
  WORKLOAD_PENALTY_MAX: 400,  // bounded so it stays a tiebreaker, never flips a tier
};

/**
 * Per-day cook capacity (liters) for the workload-overload escape, derived
 * dynamically from the week's guest demand split across the chefs working each
 * day:
 *
 *     capacity[day] = totalWeeklyDemand × ( chefs[day] / totalChefsThatWeek )
 *
 * So a day with more chefs gets a bigger slice of the week's cooking, and a
 * busier week (more guests → more demand) raises every day's slice. This
 * replaces the old fixed "(soup+main) × 90 L" cap — chef counts are now relative
 * weights, not absolute liters. Note the trigger is therefore RELATIVE, not an
 * absolute liter ceiling: a day is "overloaded" when its share of the week's
 * cooking outruns its share of the chefs (roughly guest-magnitude-invariant,
 * since both the day's load and totalDemand scale with guest counts).
 *
 * totalWeeklyDemand = liters needed to serve every future guest across the
 * window for the auto-planned types (≈ one soup + one main portion per guest).
 * Returns an empty map (→ escape disabled) when there are no chefs or no demand.
 */
export function computeWeeklyCapacities(
  window: PlanDay[],
  getGuestsFn: (loc: Location, isoDate: string, meal: Meal) => number,
  rhythm: Record<string, CookRhythmDay> = getActiveRhythm(),
): Map<string, number> {
  let totalDemand = 0;
  for (const day of window) {
    for (const slot of day.slots) {
      if (slot.isPast) continue;
      const g = getGuestsFn(slot.loc, day.isoDate, slot.meal);
      if (g <= 0) continue;
      totalDemand += TYPES_TO_PLAN.length * g * DEFAULT_SERVING_ML / 1000;
    }
  }
  let totalChefs = 0;
  for (const day of window) totalChefs += rhythm[day.dayName]?.chefs ?? 0;
  const caps = new Map<string, number>();
  if (totalChefs <= 0 || totalDemand <= 0) return caps;
  const perChef = totalDemand / totalChefs;
  for (const day of window) {
    caps.set(day.dayName, (rhythm[day.dayName]?.chefs ?? 0) * perChef);
  }
  return caps;
}

interface CandidatePlace {
  batch: Batch;
  slot: PlanSlot;
  day: PlanDay;
  type: DishType;
}

interface AbandonedSlot {
  loc: Location;
  date: string;
  meal: Meal;
  type: DishType;
  reason: string;
}

/**
 * Hard constraints for the scored algorithm. Returns true if the candidate
 * is legal in the current state (services already on batches count via
 * `alreadyInSlot` and `countTypeInSlot`).
 *
 * Unified-batch model:
 *   - Pure-frozen batches (every inventory entry is Frozen) are excluded.
 *   - Cooked stock has NO age cutoff — old food is planned first (FIFO,
 *     scoreCandidate tier 3) and chefs pull it out of rotation by hand.
 *   - Capacity check: getTotalStock(b) >= calcReqLive(b) for cooked
 *     batches. Empty-inventory placeholders pass on capacity (the cook
 *     decides at confirm-cooked time) — but only if their cook day is today
 *     or later. A placeholder for a cook day that has already passed is a
 *     dead plan and must not be recycled into a future slot.
 */
function scoredHardConstraintsOk(
  c: CandidatePlace,
  allBatches: Batch[],
  calcReq: (b: Batch) => number,
  getGuestsFn: (loc: Location, isoDate: string, meal: Meal) => number,
  todayIso: string,
): boolean {
  const { batch, slot, day, type } = c;
  if (batch.type !== type) return false;
  if (!batch.cookDate) return false;
  if (isOnlyFrozen(batch)) return false;
  if (slot.isPast) return false;
  if (getGuestsFn(slot.loc, day.isoDate, slot.meal) <= 0) return false;
  if (!isServableBy(batch.cookDate, day.isoDate, slot.meal, slot.loc, primaryLoc(batch))) return false;
  if (alreadyInSlot(batch, slot.loc, day.isoDate, slot.meal)) return false;
  if (countTypeInSlot(allBatches, type, slot.loc, day.isoDate, slot.meal) >= SLOTS_PER_TYPE) return false;
  const cookIso = cookDateToIso(batch.cookDate);
  if (!cookIso) return false;
  const totalStock = getTotalStock(batch);
  const serveableStock = getServeableTotalStock(batch);
  // Empty placeholder: capacity is whatever the cook decides at confirm time,
  // but only eligible if its cook day hasn't already passed (no retroactive
  // cooking — a stale empty placeholder must not be slotted into the future).
  if (totalStock <= 0) return cookIso >= todayIso;
  // Capacity + reachability (NO reverse van — Daan's rule, 2026-06). West stock
  // is delivered West→Centraal the morning after cooking, but Centraal stock NEVER
  // comes back to West, and the morning van that's already gone can't reach
  // TODAY's Centraal. Tentatively add the service, then require ALL THREE:
  //   (1) total demand ≤ total serveable stock,
  //   (2) the batch's WEST-located demand ≤ its WEST-located serveable stock, AND
  //   (3) its "locked" Centraal demand (same-day Centraal that no future morning
  //       van can reach — i.e. everything except tomorrow+ and the Sunday dinner
  //       shift) ≤ its Centraal-ON-SITE serveable stock (settled + already in
  //       transit). West stock is unreachable for those slots.
  // For the one-directional van these three are exactly the transportation
  // feasibility condition (Dw ≤ W, Dlocked ≤ C, total ≤ W+C). (3) uses the SAME
  // reachability rule (westReachesCentraal) as the planner's coverage engine, so
  // the WHICH-slots-are-locked question agrees; the two still differ on Frozen
  // (this gate counts serveable/non-Frozen stock, the display's positionedAt counts
  // all storage to match getTotalStock/diffStr — a pre-existing, intentional split).
  // Each location/timing portion is derived from the SAME calcReq (total minus
  // demand-with-those-services-removed), so it tracks calcReq's peer-share model —
  // and any unit-test stub — exactly. (Frozen stays frozen until assigned — Daan
  // smoke 2026-05-12.) try/finally so a throw can't strand the speculative service.
  batch.services.push({ loc: slot.loc, date: day.isoDate, meal: slot.meal });
  const withNew = batch.services;
  let fits = false;
  try {
    const totalDemand = calcReq(batch);
    const evLocs = eventLocsTouching(batch);
    if (evLocs.length === 0) {
      // Fast path — the exact pre-event-locations checks (bench-guarded).
      if (totalDemand <= serveableStock) {
        batch.services = withNew.filter(s => s.loc !== 'west');
        const nonWestDemand = calcReq(batch);
        batch.services = withNew;
        const westDemand = Math.round((totalDemand - nonWestDemand) * 10) / 10;
        fits = westDemand <= getServeableStockAt(batch, 'west');
        if (fits) {
          batch.services = withNew.filter(s => !(s.loc === 'centraal' && !westReachesCentraal(todayIso, s.date, s.meal)));
          const reachableDemand = calcReq(batch);
          batch.services = withNew;
          const lockedCentraalDemand = Math.round((totalDemand - reachableDemand) * 10) / 10;
          const centraalOnSite = getServeableStockAt(batch, 'centraal') + getServeablePendingTo(batch, 'centraal');
          fits = lockedCentraalDemand <= centraalOnSite + 1e-9;
        }
      }
    } else {
      // Event path — hub-and-spoke generalization for the rare batch that
      // touches an event location. Event stock can only serve ITS OWN
      // location's services (no van off an event site; leftovers return by
      // manual shipping), and an event slot's same-day demand can only use
      // on-site stock (westReaches: next morning, no Sunday exception).
      //   (0) per event loc E: locked (same-day) demand at E ≤ E's on-site
      //       serveable stock (settled + in transit to E);
      //   (1) total demand MINUS what event on-site stock covers ≤ the
      //       west/centraal-reachable serveable stock (event-parked stock
      //       must never masquerade as coverage for west/centraal slots);
      //   (2) West demand PLUS the event residuals ≤ West serveable stock —
      //       an event's demand beyond its on-site stock can ONLY be fed from
      //       West (Centraal never ships to an event), so pooling Centraal
      //       stock against it would admit assignments that starve a
      //       hand-planned festival service;
      //   (3) locked Centraal demand ≤ Centraal on-site (as the fast path).
      let ok = true;
      let coveredByEvents = 0;
      let eventResidual = 0; // event demand only West can still feed
      for (const ev of evLocs) {
        const dEv = demandOfExcluded(batch, withNew, calcReq, totalDemand, s => s.loc !== ev);
        const onSite = getServeableStockAt(batch, ev) + getServeablePendingTo(batch, ev);
        const lockedEv = demandOfExcluded(batch, withNew, calcReq, totalDemand,
          s => !(s.loc === ev && !westReaches(ev, todayIso, s.date, s.meal)));
        if (lockedEv > onSite + 1e-9) { ok = false; break; }
        coveredByEvents += Math.min(dEv, onSite);
        eventResidual += Math.max(0, dEv - onSite);
      }
      if (ok) {
        const reachable = getServeableStockAt(batch, 'west') + getServeablePendingTo(batch, 'west')
          + getServeableStockAt(batch, 'centraal') + getServeablePendingTo(batch, 'centraal');
        ok = totalDemand - coveredByEvents <= reachable + 1e-9;
      }
      if (ok) {
        const westDemand = demandOfExcluded(batch, withNew, calcReq, totalDemand, s => s.loc !== 'west');
        ok = westDemand + eventResidual <= getServeableStockAt(batch, 'west') + 1e-9;
      }
      if (ok) {
        const lockedCentraalDemand = demandOfExcluded(batch, withNew, calcReq, totalDemand,
          s => !(s.loc === 'centraal' && !westReachesCentraal(todayIso, s.date, s.meal)));
        const centraalOnSite = getServeableStockAt(batch, 'centraal') + getServeablePendingTo(batch, 'centraal');
        ok = lockedCentraalDemand <= centraalOnSite + 1e-9;
      }
      fits = ok;
    }
  } finally {
    batch.services = withNew;
    batch.services.pop();
  }
  return fits;
}

/**
 * Score a candidate (batch, slot, day, type) against the live state.
 * Higher is better; <=0 means do not commit. Slot-coverage urgency
 * dominates so the algorithm fills empty slots before refining
 * already-half-filled ones.
 */
function scoreCandidate(
  c: CandidatePlace,
  allBatches: Batch[],
  calcReq: (b: Batch) => number,
  potCaps: Map<string, number>,
  getGuestsFn: (loc: Location, isoDate: string, meal: Meal) => number,
  dayCapacities: Map<string, number>,
  todayIso: string,
): number {
  const { batch, slot, day, type } = c;
  const filled = countTypeInSlot(allBatches, type, slot.loc, day.isoDate, slot.meal);

  // ── tier 1: coverage urgency (empty before half-filled) ──
  const coverage = filled === 0 ? SCORE.COVER_EMPTY : SCORE.COVER_HALF;

  // serveableStock = non-frozen, cooked & ready now. totalStock includes
  // frozen / in-transit — used to detect an (uncooked) placeholder.
  const totalStock = getTotalStock(batch);
  const serveableStock = getServeableTotalStock(batch);
  const cookIso = cookDateToIso(batch.cookDate)!;
  const days = diffDaysIso(cookIso, day.isoDate);

  // ── tier 2: primary — use ready stock before a new cook (soonest slot
  // first, to reserve today); for a new cook, score the cook-timing fitness.
  // Ready's floor (READY_BASE) sits above any new-cook value, so ready stock
  // always outranks a fresh cook for the same slot. ──
  let primary: number;
  if (serveableStock > 0) {
    const slotDaysOut = Math.max(0, diffDaysIso(todayIso, day.isoDate));
    const soon = Math.max(0, PLANNING_HORIZON_DAYS - slotDaysOut);
    primary = SCORE.READY_BASE + SCORE.READY_SOON_PER_DAY * soon;
  } else {
    let t: number;
    if (slot.meal === 'dinner') t = days === 0 ? SCORE.COOK_DINNER_SAMEDAY : SCORE.COOK_DINNER_PRIOR;
    else t = days === 0 ? SCORE.COOK_LUNCH_SAMEDAY : SCORE.COOK_LUNCH_PRIOR;
    if (days > 0) t -= SCORE.COOK_STALE_PER_DAY * days;
    if (days >= 4) t -= SCORE.COOK_STALE_DAY4;
    primary = Math.max(0, Math.min(SCORE.READY_BASE - 1, t));
  }

  // ── tier 3: secondary — Centraal coverage priority + FIFO (oldest first) ──
  // FIFO cap 14 days (was 7): with no hard age cutoff, genuinely old stock now
  // competes here, so keep discriminating past a week. 200 + 40·14 = 760 < 999
  // keeps the tier inside its band.
  let secondary = slot.loc === 'centraal' ? SCORE.CENTRAAL_PRIORITY : 0;
  if (serveableStock > 0) {
    const ageDays = Math.max(0, Math.min(14, diffDaysIso(cookIso, todayIso)));
    secondary += SCORE.READY_FIFO_PER_DAY * ageDays;
  }

  // ── tier 4: tiebreak — drain local/Centraal stock, fill pots, vary
  // allergens; a workload-overloaded cook day is deterred (bounded). ──
  let tie = SCORE.TIE_BASE;
  if (slot.loc === 'centraal' && getServeableStockAt(batch, 'centraal') > 0) tie += SCORE.CENTRAAL_STOCK_AT_CENTRAAL;
  if (getServeableStockAt(batch, slot.loc) > 0) tie += SCORE.SAME_LOCATION;
  const cap = potCaps.get(batch.id);
  if (cap != null && cap > 0) {
    const slotGuests = getGuestsFn(slot.loc, day.isoDate, slot.meal);
    const projected = calcReq(batch) + (slotGuests / SLOTS_PER_TYPE) * (batch.serving || 280) / 1000;
    if (projected <= cap) tie += SCORE.POT_FILL_BONUS_MAX * Math.min(1, projected / cap);
  }
  if (filled > 0 && batch.allergens && batch.allergens.length > 0) {
    const peerAllergens = new Set<string>();
    for (const b of allBatches) {
      if (b.id === batch.id || b.type !== type) continue;
      if (!(b.services || []).some(s => s.loc === slot.loc && s.date === day.isoDate && s.meal === slot.meal)) continue;
      for (const a of b.allergens || []) peerAllergens.add(a);
    }
    if (peerAllergens.size > 0) {
      const mine = new Set(batch.allergens);
      const overlap = [...peerAllergens].filter(a => mine.has(a)).length;
      if (overlap < peerAllergens.size) tie += SCORE.ALLERGEN_DIVERSITY;
    }
  }
  // Workload-overload deterrent (fresh cooks only; cooked stock doesn't load a
  // cook day). Bounded so it stays a tiebreaker — it can defer a busy day's
  // cook against an equally-urgent alternative, never override coverage/timing.
  if (totalStock <= 0 && batch.cookDate) {
    const phCookIso = cookDateToIso(batch.cookDate);
    const cookDayName = phCookIso ? dateToDayName(phCookIso) : '';
    const threshold = dayCapacities.get(cookDayName) ?? 0;
    if (threshold > 0) {
      const slotGuests = getGuestsFn(slot.loc, day.isoDate, slot.meal);
      let load = (slotGuests / SLOTS_PER_TYPE) * (batch.serving || 280) / 1000;
      for (const b of allBatches) {
        if (b.cookDate !== batch.cookDate || !TYPES_TO_PLAN.includes(b.type)) continue;
        load += calcReq(b);
      }
      const trigger = threshold * WORKLOAD_OVERLOAD_TRIGGER_FACTOR;
      if (load > trigger) tie -= Math.min(SCORE.WORKLOAD_PENALTY_MAX, WORKLOAD_PENALTY_PER_LITER * (load - trigger));
    }
  }
  tie = Math.max(0, Math.min(SCORE_BAND - 1, tie));

  return coverage * T_COVERAGE + primary * T_PRIMARY + secondary * T_SECONDARY + tie;
}

/**
 * Forced-assignment pre-pass. For each (slot, type) gap, find candidates
 * passing hard constraints. If exactly ONE candidate exists AND its score
 * clears FORCED_ASSIGN_MIN_SCORE, commit it. Repeat until no new
 * singletons emerge.
 *
 * Purpose: prevent the classic greedy failure where a versatile batch is
 * spent on a high-scoring slot, leaving a different slot with no options.
 */
export function forcedAssignmentPrePass(
  allBatches: Batch[],
  window: PlanDay[],
  calcReq: (b: Batch) => number,
  getGuestsFn: (loc: Location, isoDate: string, meal: Meal) => number,
  potCaps: Map<string, number>,
): { committed: number } {
  const todayIso = window[0]?.isoDate ?? '';
  const dayCapacities = computeWeeklyCapacities(window, getGuestsFn);
  let committed = 0;
  let changed = true;
  let safetyMax = 200;
  while (changed && safetyMax-- > 0) {
    changed = false;
    for (const day of window) {
      for (const slot of day.slots) {
        if (slot.isPast) continue;
        if (getGuestsFn(slot.loc, day.isoDate, slot.meal) <= 0) continue;
        for (const type of TYPES_TO_PLAN) {
          const filled = countTypeInSlot(allBatches, type, slot.loc, day.isoDate, slot.meal);
          if (filled >= SLOTS_PER_TYPE) continue;
          const eligible: CandidatePlace[] = [];
          for (const batch of allBatches) {
            const c: CandidatePlace = { batch, slot, day, type };
            if (scoredHardConstraintsOk(c, allBatches, calcReq, getGuestsFn, todayIso)) {
              eligible.push(c);
              if (eligible.length > 1) break;
            }
          }
          if (eligible.length !== 1) continue;
          const c = eligible[0];
          const score = scoreCandidate(c, allBatches, calcReq, potCaps, getGuestsFn, dayCapacities, todayIso);
          if (score < FORCED_ASSIGN_MIN_SCORE) continue;
          c.batch.services.push({ loc: c.slot.loc, date: c.day.isoDate, meal: c.slot.meal });
          committed++;
          changed = true;
        }
      }
    }
  }
  return { committed };
}

/**
 * Volume-aware team pre-pass — covers high-demand slots that NO single batch can
 * fill, using a cooked TEAM, BEFORE the greedy spends that stock on smaller slots.
 *
 * The failure it fixes (2026-06, real A2 snapshot): the greedy commits one batch per
 * iteration and the capacity hard-constraint charges the FIRST dish entering an empty
 * slot for the slot's WHOLE guest volume (peerCount=1). On the A2 data a 222-guest Tue
 * Centraal dinner needed ~62 L of soup, but every cooked soup was only 40–45 L — so NO
 * single batch could seed it. The greedy drained those soups onto smaller slots and the
 * fallback ladder emergency-cooked the dinner, even though Lithuanian (45 L) + Watermelon
 * (40 L) could have covered it together. This pass reserves that pair up front → 2 real
 * soups, 0 emergencies on that slot.
 *
 * CRITICAL ordering: this MUST run before forcedAssignmentPrePass and the greedy, while
 * every slot is still empty. With an empty slot, `scoredHardConstraintsOk` evaluates each
 * candidate at peerCount=1 — i.e. it charges the FULL guest volume — so "does any single
 * batch pass?" reads exactly as "can any single batch cover the whole slot alone?". When
 * none can, the slot genuinely needs a team, and findCombinationTeam (the same coverage
 * logic the fallback uses) assembles one and reserves that stock here. (An earlier version
 * ran AFTER the forced pass, where a once-seeded slot's peer-discount made the check lie
 * and the pass became a no-op — the bug this ordering fixes.) Targeted: if a single batch
 * CAN cover the slot, it's left to the scored loop (better scoring + variety).
 *
 * KNOWN LIMITATION — placeholder-solos. An empty fresh-cook placeholder passes
 * `scoredHardConstraintsOk`'s capacity check unconditionally (see the placeholder branch
 * there). So if a high-demand slot has a *reachable* fresh-cook placeholder, `canSolo` is
 * true and this pass SKIPS it — even when two team-able cooked batches are sitting spare;
 * the greedy then can't seed the slot with one undersized cooked batch (full-volume gate)
 * and plants the placeholder, cooking fresh while existing stock goes unused. So this pass
 * only bites slots with NO reachable placeholder — e.g. a Centraal dinner that a next-
 * morning-delivery placeholder can't reach same-day, which is exactly why the A2 222-dinner
 * benefits. Closing the placeholder-solos case needs the deferred global allocator, not
 * this pass. This is also why team-fill is a no-op on every fmm-bench fixture: each bench
 * slot carries servable empty placeholders, so `canSolo` is always true there — NOT because
 * a cooked soup happens to solo. (The regression guard stays green precisely because of
 * this no-op; a dedicated pipeline test below guards the ordering instead.)
 */
export function teamFillBigSlots(
  allBatches: Batch[],
  window: PlanDay[],
  calcReq: (b: Batch) => number,
  getGuestsFn: (loc: Location, isoDate: string, meal: Meal) => number,
): { committed: number; teamsFormed: number } {
  const todayIso = window[0]?.isoDate ?? '';
  let committed = 0;
  let teamsFormed = 0;
  for (const day of window) {
    for (const slot of day.slots) {
      if (slot.isPast) continue;
      const guests = getGuestsFn(slot.loc, day.isoDate, slot.meal);
      if (guests <= 0) continue;
      for (const type of TYPES_TO_PLAN) {
        const filled = countTypeInSlot(allBatches, type, slot.loc, day.isoDate, slot.meal);
        if (filled >= SLOTS_PER_TYPE) continue;
        // Empty-slot peerCount=1 ⇒ this reads as "some single batch can solo-cover".
        // NB: a servable empty placeholder passes scoredHardConstraintsOk unconditionally,
        // so a reachable fresh-cook also counts as a "solo" here and suppresses the team
        // (the placeholder-solos limitation documented above). We only team-fill slots that
        // neither a cooked batch nor a reachable placeholder can cover alone.
        const canSolo = allBatches.some(b =>
          scoredHardConstraintsOk({ batch: b, slot, day, type }, allBatches, calcReq, getGuestsFn, todayIso));
        if (canSolo) continue;
        const team = findCombinationTeam(
          allBatches, type, slot.loc, day.isoDate, slot.meal, guests, filled, calcReq, getGuestsFn, todayIso);
        if (team.length === 0) continue;
        for (const b of team) b.services.push({ loc: slot.loc, date: day.isoDate, meal: slot.meal });
        committed += team.length;
        teamsFormed++;
      }
    }
  }
  return { committed, teamsFormed };
}

/**
 * Single scored greedy loop. Each iteration scores every (batch, slot, type)
 * candidate, picks the highest-scoring one, commits it. Stops when no
 * candidate has positive score.
 */
export function scoredGreedyAssignment(
  allBatches: Batch[],
  window: PlanDay[],
  calcReq: (b: Batch) => number,
  getGuestsFn: (loc: Location, isoDate: string, meal: Meal) => number,
  potCaps: Map<string, number>,
): { committed: number } {
  const todayIso = window[0]?.isoDate ?? '';
  const dayCapacities = computeWeeklyCapacities(window, getGuestsFn);
  let committed = 0;
  let safetyMax = 500;
  while (safetyMax-- > 0) {
    let bestScore = 0;
    let best: CandidatePlace | null = null;
    let bestId = '';
    let bestLoad = 0;
    for (const day of window) {
      for (const slot of day.slots) {
        if (slot.isPast) continue;
        if (getGuestsFn(slot.loc, day.isoDate, slot.meal) <= 0) continue;
        for (const type of TYPES_TO_PLAN) {
          const filled = countTypeInSlot(allBatches, type, slot.loc, day.isoDate, slot.meal);
          if (filled >= SLOTS_PER_TYPE) continue;
          for (const batch of allBatches) {
            const c: CandidatePlace = { batch, slot, day, type };
            if (!scoredHardConstraintsOk(c, allBatches, calcReq, getGuestsFn, todayIso)) continue;
            const score = scoreCandidate(c, allBatches, calcReq, potCaps, getGuestsFn, dayCapacities, todayIso);
            if (score <= 0) continue;
            // Load-balancing tie-break: when scores tie (the classic case is
            // identical sibling placeholders from one cook day — e.g. Sunday's
            // 3 soups), prefer the batch carrying the FEWEST services so far.
            // This round-robins service slots across siblings (the original
            // plan's §3.3 intent) instead of piling every slot onto the same
            // two batches and starving the rest — which left surplus siblings
            // with zero services and stretched one batch across the whole week.
            // id only breaks a remaining tie, for determinism.
            const load = batch.services.length;
            if (best === null
              || score > bestScore
              || (score === bestScore && load < bestLoad)
              || (score === bestScore && load === bestLoad && batch.id.localeCompare(bestId) < 0)) {
              best = c;
              bestScore = score;
              bestId = batch.id;
              bestLoad = load;
            }
          }
        }
      }
    }
    if (!best) break;
    best.batch.services.push({ loc: best.slot.loc, date: best.day.isoDate, meal: best.slot.meal });
    committed++;
  }
  return { committed };
}

/**
 * Fallback ladder: for slots still under-filled after the scored loop:
 *   1. Multi-batch teams (60% coverage threshold).
 *   2. Emergency placeholder labelled as such — cook at slot loc.
 *   3. Mark as abandoned (cook needs to intervene manually).
 */
export function runFallbackLadder(
  allBatches: Batch[],
  window: PlanDay[],
  calcReq: (b: Batch) => number,
  getGuestsFn: (loc: Location, isoDate: string, meal: Meal) => number,
): { teamsFormed: number; emergenciesCreated: number; abandoned: AbandonedSlot[]; emergencyBatches: Batch[] } {
  const todayIso = window[0]?.isoDate ?? '';
  let teamsFormed = 0;
  let emergenciesCreated = 0;
  const abandoned: AbandonedSlot[] = [];
  const emergencyBatches: Batch[] = [];
  for (const day of window) {
    for (const slot of day.slots) {
      if (slot.isPast) continue;
      const guests = getGuestsFn(slot.loc, day.isoDate, slot.meal);
      if (guests <= 0) continue;
      for (const type of TYPES_TO_PLAN) {
        let filled = countTypeInSlot(allBatches, type, slot.loc, day.isoDate, slot.meal);
        let safety = 8;
        while (filled < SLOTS_PER_TYPE && safety-- > 0) {
          const startFilled = filled;
          const team = findCombinationTeam(
            allBatches, type, slot.loc, day.isoDate, slot.meal, guests, filled, calcReq, getGuestsFn, todayIso,
          );
          if (team.length > 0) {
            for (const b of team) b.services.push({ loc: slot.loc, date: day.isoDate, meal: slot.meal });
            teamsFormed++;
            filled = countTypeInSlot(allBatches, type, slot.loc, day.isoDate, slot.meal);
            continue;
          }
          const emergency = createEmergencyPlaceholder(type, slot.loc, day);
          if (isServableBy(emergency.cookDate, day.isoDate, slot.meal, slot.loc, primaryLoc(emergency))) {
            emergency.services.push({ loc: slot.loc, date: day.isoDate, meal: slot.meal });
            allBatches.push(emergency);
            emergencyBatches.push(emergency);
            emergenciesCreated++;
            filled = countTypeInSlot(allBatches, type, slot.loc, day.isoDate, slot.meal);
            continue;
          }
          if (filled === startFilled) {
            abandoned.push({
              loc: slot.loc, date: day.isoDate, meal: slot.meal, type,
              reason: 'no batch could cover this slot, even with team coverage or emergency placeholder',
            });
            break;
          }
        }
      }
    }
  }
  return { teamsFormed, emergenciesCreated, abandoned, emergencyBatches };
}

/**
 * Multi-batch team for combination fill. Each member carries ≤60% of the
 * slot's guests; total team coverage must be ≥ FALLBACK_TEAM_MIN_COVERAGE
 * of the slot's guests. Per-batch capacity check (no family pool — each
 * batch is its own ceiling).
 */
function findCombinationTeam(
  allBatches: Batch[],
  type: DishType,
  loc: Location,
  isoDate: string,
  meal: Meal,
  guests: number,
  existingPeers: number,
  calcReq: (b: Batch) => number,
  getGuestsFn: (loc: Location, isoDate: string, meal: Meal) => number,
  todayIso: string,
): Batch[] {
  const eligible = allBatches.filter(b => {
    if (b.type !== type) return false;
    if (!b.cookDate) return false;
    if (isOnlyFrozen(b)) return false;
    if (alreadyInSlot(b, loc, isoDate, meal)) return false;
    if (!isServableBy(b.cookDate, isoDate, meal, loc, primaryLoc(b))) return false;
    // Reachability — no reverse van: a cooked batch can serve a WEST slot only
    // from serveable West stock (Centraal stock never returns to West). Mirrors
    // the gate in scoredHardConstraintsOk so the fallback can't build a West
    // team out of Centraal-located stock.
    if (loc === 'west' && getTotalStock(b) > 0 && getServeableStockAt(b, 'west') <= 0) return false;
    // Mirror for a "locked" same-day Centraal slot the morning van can't reach:
    // a COOKED batch must have Centraal-on-site stock (settled + incoming) to
    // join — West stock won't arrive in time. Fresh cooks (no stock yet) are
    // gated by isServableBy above, so they pass through here.
    if (loc === 'centraal' && !westReachesCentraal(todayIso, isoDate, meal)
        && getTotalStock(b) > 0
        && getServeableStockAt(b, 'centraal') + getServeablePendingTo(b, 'centraal') <= 0) return false;
    const cookIso = cookDateToIso(b.cookDate);
    if (!cookIso) return false;
    // Cooked stock has no age cutoff (old food serves first; chefs pull it).
    if (getTotalStock(b) <= 0 && cookIso < todayIso) {
      return false;  // empty placeholder for a cook day that has already passed
    }
    return true;
  });
  if (eligible.length === 0) return [];

  // Sort: same-loc-serveable-stock first (frozen-only doesn't count), then
  // oldest cookDate (use up older food), then biggest total stock
  // (more capacity), then id for determinism.
  eligible.sort((a, b) => {
    const aSame = getServeableStockAt(a, loc) > 0 ? 1 : 0;
    const bSame = getServeableStockAt(b, loc) > 0 ? 1 : 0;
    if (aSame !== bSame) return bSame - aSame;
    const aIso = cookDateToIso(a.cookDate)!;
    const bIso = cookDateToIso(b.cookDate)!;
    if (aIso !== bIso) return aIso < bIso ? -1 : 1;
    const aStock = getTotalStock(a);
    const bStock = getTotalStock(b);
    if (aStock !== bStock) return bStock - aStock;
    return a.id.localeCompare(b.id);
  });

  const minK = Math.max(1, SLOTS_PER_TYPE - existingPeers);
  const maxK = Math.max(minK, 4 - existingPeers);

  for (let k = minK; k <= maxK; k++) {
    const totalPeers = existingPeers + k;
    const guestsPerPeer = guests / totalPeers;
    const maxGuestsPerBatch = guests * 0.6;
    if (guestsPerPeer > maxGuestsPerBatch) continue;
    const team: Batch[] = [];
    let coverageGuests = existingPeers * guestsPerPeer;
    for (const cand of eligible) {
      if (team.length >= k) break;
      const shareLitersAtThisSlot = guestsPerPeer * (cand.serving || 280) / 1000;
      // Location-aware capacity (no reverse van): a WEST slot's share must fit the
      // member's WEST-located stock and West-bound demand. A Centraal slot the van
      // can still reach (tomorrow+/Sunday dinner) fits the whole serveable batch
      // (West can ship in); but a LOCKED same-day Centraal slot can ONLY be served
      // from Centraal-on-site stock — mirrors scoredHardConstraintsOk(3) so a split
      // batch's West stock isn't fictitiously credited to a slot it can't reach.
      if (loc === 'west') {
        const westStock = getServeableStockAt(cand, 'west');
        if (westStock <= 0) continue;
        if (calcRequiredAtLocLive(cand, 'west', getGuestsFn) + shareLitersAtThisSlot > westStock) continue;
      } else if (!westReachesCentraal(todayIso, isoDate, meal)) {
        // Locked same-day Centraal slot: only Centraal-on-site stock can serve it.
        // Charge the member's CENTRAAL-located demand (its West demand is served by
        // West stock) — symmetric with the West branch above and constraint (3). A
        // fresh Centraal cook (0 stock) is exempt: its capacity is set at cook time.
        const centraalOnSite = getServeableStockAt(cand, 'centraal') + getServeablePendingTo(cand, 'centraal');
        if (getTotalStock(cand) > 0
            && calcRequiredAtLocLive(cand, 'centraal', getGuestsFn) + shareLitersAtThisSlot > centraalOnSite) continue;
      } else {
        // Reachable Centraal slot: West can ship in, so the west/centraal
        // pool counts — but liters parked at (or bound for) an EVENT
        // location never do, and demand owed to an event is only offset by
        // that event's own on-site stock (mirrors the gate's event path).
        // hasAnyStock (not the reachable figure) keeps the fresh-cook
        // exemption: an all-at-event batch must be capacity-checked, not
        // waved through as an uncooked placeholder.
        const hasAnyStock = getTotalStock(cand) > 0;
        const evLocs = eventLocsTouching(cand);
        let batchStock = getTotalStock(cand);
        let projectedDemand = calcReq(cand) + shareLitersAtThisSlot;
        if (evLocs.length > 0) {
          batchStock = getServeableStockAt(cand, 'west') + getServeablePendingTo(cand, 'west')
            + getServeableStockAt(cand, 'centraal') + getServeablePendingTo(cand, 'centraal');
          const all = cand.services || [];
          const total = calcReq(cand);
          for (const ev of evLocs) {
            const dEv = demandOfExcluded(cand, all, calcReq, total, s => s.loc !== ev);
            const onSite = getServeableStockAt(cand, ev) + getServeablePendingTo(cand, ev);
            projectedDemand -= Math.min(dEv, onSite);
          }
        }
        if (hasAnyStock && projectedDemand > batchStock) continue;
      }
      team.push(cand);
      coverageGuests += guestsPerPeer;
    }
    if (team.length < k) continue;
    const coverageFraction = coverageGuests / guests;
    if (coverageFraction < FALLBACK_TEAM_MIN_COVERAGE) continue;
    return team;
  }
  return [];
}

function createEmergencyPlaceholder(type: DishType, loc: Location, day: PlanDay): Batch {
  const typeLabel = type === 'Main course' ? 'main' : 'soup';
  const ddmm = day.cookDateStr.split('/').slice(0, 2).join('/');
  const locLabel = loc === 'centraal' ? 'C' : 'W';
  // Emergency placeholders have a 0-qty inventory entry at `loc` so the
  // primaryLoc() heuristic returns `loc` for the isServableBy gate (we
  // need a Centraal-cooked emergency to legally serve Centraal lunch on
  // its cookDate; without the 0-qty marker, primaryLoc would default to
  // 'west' and the next-morning rule would block same-day Centraal).
  // consolidateInventory collapses the 0-qty entry once real stock
  // arrives.
  return {
    id: newId(),
    name: `${day.dayName} emergency ${typeLabel} ${locLabel} ${ddmm}`,
    type,
    serving: 280,
    inventory: [{ loc, storage: 'Gastro', qty: 0, cookDate: day.cookDateStr }],
    shipments: [],
    allergens: [],
    extraAllergens: [],
    orderFor: false,
    cookDate: day.cookDateStr,
    note: '',
    services: [],
    createdAt: new Date().toISOString(),
    recipeId: null,
    actualIngredients: null,
    cookNotes: 'Emergency cook (auto-created by Fix My Menu)',
    stockDeducted: false,
    generated: true,
  };
}

/**
 * Toggle the spinner + disabled state on every Fix-My-Menu button. The
 * actual work runs synchronously and blocks the main thread, so callers
 * must `setTimeout(work, 0)` after switching loading on so the browser
 * gets a paint cycle to show the spinner before the freeze.
 */
function setFixMyMenuLoading(loading: boolean): void {
  if (typeof document === 'undefined') return;
  const btns = document.querySelectorAll<HTMLButtonElement>('.btn-fix-menu');
  for (const b of btns) {
    if (loading) {
      if (!b.dataset.origHtml) b.dataset.origHtml = b.innerHTML;
      b.innerHTML = '<span class="btn-spinner"></span>Working…';
      b.disabled = true;
    } else {
      if (b.dataset.origHtml) {
        b.innerHTML = b.dataset.origHtml;
        delete b.dataset.origHtml;
      }
      b.disabled = false;
    }
  }
}

/** Structured result of one Fix-My-Menu run. Returned by the pure
 *  `runFixMyMenuCore()` so callers (the UI wrapper `_fixMyMenuBody` and the
 *  regression bench) can build their own side-effects/reports from one
 *  canonical run instead of re-implementing the pipeline. */
export interface FixMyMenuResult {
  /** Orphan placeholders cleaned this run. */
  cleaned: number;
  /** Spent + stale batches auto-retired this run. */
  retired: number;
  /** Placeholders generated to fill empty cook days (excludes emergencies). */
  newPlaceholders: Batch[];
  /** Emergency placeholders the fallback ladder created. */
  emergencyBatches: Batch[];
  /** Total batches committed to slots across team-fill + forced + greedy. */
  assigned: number;
  /** Multi-batch teams formed (team-fill big-slots + fallback ladder). */
  teamsFormed: number;
  /** Emergency placeholders created by the fallback ladder. */
  emergenciesCreated: number;
  /** Slots the fallback ladder could not cover at all. */
  abandoned: AbandonedSlot[];
  /** Assembled, ordered warnings (under-filled, stockout, catering drops, …). */
  warnings: Warning[];
}

/** Fix-My-Menu pure core — runs the full algorithm against the global S and
 *  returns a structured result, with NO UI/persistence side-effects (no
 *  spinner, save, rerender, ritual marking, or results modal). This is the
 *  single source of truth for the pipeline: both the UI wrapper
 *  (`_fixMyMenuBody`) and the regression bench (test/fmm-bench.test.ts via
 *  bench/menu-fixer/run-pipeline.ts) call it, so the bench cannot drift from
 *  production.
 *
 *  Runs: strip future services → clean orphan placeholders → auto-retire spent
 *  batches → generate missing placeholders → team-fill big slots →
 *  forced-assignment pre-pass → scored greedy loop → fallback ladder (teams →
 *  emergency placeholder → abandoned) → pot allocation → warnings. */
export function runFixMyMenuCore(): FixMyMenuResult {
  stripFutureServices(S.batches);

  // A batch an ACTIVE catering points at is in use — the event is getting that
  // dish — so it must survive every auto-retire cleanup below, even as an empty
  // placeholder (a catering pick is a `catering.dishes` ref, not a Batch
  // service). Computed once up front; stable for the whole run.
  const cateringProtected = cateringReferencedBatchIds(S.caterings || []);

  // Caterings that lost a placeholder dish to orphan cleanup — collected here
  // and surfaced as warnings after collectWarnings() so the drop isn't silent.
  let droppedFromCaterings: { cateringId: string; cateringName: string; dishName: string }[] = [];

  const orphans = findOrphanPlaceholders(S.batches, cateringProtected);
  if (orphans.length > 0) {
    const orphanIds = new Set(orphans.map(b => b.id));
    S.batches = S.batches.filter(b => !orphanIds.has(b.id));
    // A retired placeholder may still be pinned to a (now-delivered) catering —
    // drop those dangling refs so the catering's demand doesn't vanish onto a
    // dead id. Active caterings are already spared above, so this only touches
    // past events.
    droppedFromCaterings = dropRetiredDishesFromCaterings(S.caterings || [], orphanIds);
  }

  // Retire "spent" batches (total stock=0, no pending shipments, all services
  // in the past) and "stale" generated placeholders (a Fix-My-Menu placeholder
  // for a cook day that has already passed with nothing cooked). Self-healing —
  // even if SSE resurrects them, the next run wipes them. Catering refs to
  // retired batches are also cleaned so we don't leave dangling pointers.
  const todayIso = dateToIso(getToday());
  const retireIds = new Set([
    ...findSpentBatches(S.batches, cateringProtected),
    ...findStalePlaceholders(S.batches, todayIso, cateringProtected),
  ].map(b => b.id));
  if (retireIds.size > 0) {
    S.batches = S.batches.filter(b => !retireIds.has(b.id));
    for (const c of (S.caterings || [])) {
      if (c.dishes && c.dishes.length > 0) {
        c.dishes = c.dishes.filter(d => !retireIds.has(d.dishId));
      }
    }
  }

  const planWindow = buildPlanningWindow(getToday());
  const snapshot = snapshotBatches(S.batches, planWindow);
  const newPlaceholders = generateMissingPlaceholders(planWindow, snapshot);
  for (const b of newPlaceholders) S.batches.push(b);
  rebuildPlanner();

  // Per-run getEffectiveGuests memo: the scored algorithm queries the same ~56
  // (loc,date,meal) slots tens of thousands of times — once per candidate,
  // even though the value is batch-independent — and getEffectiveGuests does ~6 Date
  // constructions per call. Collapsing that to one compute per slot is the
  // bulk of the speed-up. The cache lives only for this synchronous run, so a
  // guest edit elsewhere can't make it stale.
  const _guestCache = new Map<string, number>();
  const memoGuests = (loc: Location, date: string, meal: Meal): number => {
    const k = `${loc}|${date}|${meal}`;
    let v = _guestCache.get(k);
    if (v === undefined) { v = getEffectiveGuests(loc, date, meal); _guestCache.set(k, v); }
    return v;
  };

  // calcRequiredLive derives one batch's peer-share demand directly from live
  // S.batches state — identical to rebuildPlanner()+calcRequired(b) but without
  // the global O(batches × services) rebuild. The scored algorithm calls this
  // once per candidate inside tight nested loops; a per-candidate rebuildPlanner
  // froze the browser for seconds. It reads b.services live, so the speculative
  // `services.push(...) / pop()` capacity check in scoredHardConstraintsOk stays
  // correct. The phase-boundary rebuildPlanner() calls below keep the global
  // _batchAllocations cache fresh for allocatePotCaps / collectWarnings / render.
  const calcReqLive = (b: Batch): number => calcRequiredLive(b, memoGuests);

  // Team-fill the big slots NO single batch can cover (e.g. a 240-guest Centraal
  // dinner) FIRST — while every slot is still empty — so a cooked team is reserved
  // for them before the forced/greedy passes drain that stock onto smaller slots.
  const phaseTeam = teamFillBigSlots(S.batches, planWindow, calcReqLive, memoGuests);
  rebuildPlanner();

  let potCaps = allocatePotCaps(
    S.batches.filter(b => b.cookDate && TYPES_TO_PLAN.includes(b.type)),
    S.kitchenEquipment, calcRequired,
  );

  const phaseB0 = forcedAssignmentPrePass(S.batches, planWindow, calcReqLive, memoGuests, potCaps);
  rebuildPlanner();
  potCaps = allocatePotCaps(
    S.batches.filter(b => b.cookDate && TYPES_TO_PLAN.includes(b.type)),
    S.kitchenEquipment, calcRequired,
  );

  const phaseB = scoredGreedyAssignment(S.batches, planWindow, calcReqLive, memoGuests, potCaps);
  rebuildPlanner();

  const phaseC = runFallbackLadder(S.batches, planWindow, calcReqLive, memoGuests);
  rebuildPlanner();

  // Final pot allocation for warning generation.
  const finalPotCaps = allocatePotCaps(
    S.batches.filter(b => b.cookDate && TYPES_TO_PLAN.includes(b.type)),
    S.kitchenEquipment, calcRequired,
  );

  const warnings = collectWarnings(
    S.batches, planWindow, S.caterings || [], calcRequired,
    finalPotCaps, S.kitchenEquipment, memoGuests,
  );

  for (const a of phaseC.abandoned) {
    const typeLabel = a.type === 'Main course' ? 'main' : 'soup';
    const locLabel = a.loc === 'centraal' ? 'Centraal' : 'West';
    const dayName = dateToDayName(a.date);
    warnings.unshift({
      category: 'under-filled-slot',
      message: `${dayName} ${a.meal} at ${locLabel} couldn't be covered for ${typeLabel} — every fallback step failed (${a.reason}). Manual intervention needed.`,
      anchor: { kind: 'slot', loc: a.loc, date: a.date, meal: a.meal },
    });
  }
  for (const eb of phaseC.emergencyBatches) {
    warnings.push({
      category: 'under-filled-slot',
      message: `Created emergency placeholder "${eb.name}" — slot couldn't be covered by existing stock or teams. Fill in a recipe ASAP.`,
      anchor: { kind: 'batch', batchId: eb.id },
    });
  }
  for (const dropped of droppedFromCaterings) {
    warnings.push({
      category: 'catering-dish-retired',
      message: `Catering "${dropped.cateringName}" lost placeholder "${dropped.dishName}" — Fix My Menu retired the unused placeholder. Pick a real dish for that catering.`,
      anchor: { kind: 'catering', cateringId: dropped.cateringId },
    });
  }

  return {
    cleaned: orphans.length,
    retired: retireIds.size,
    newPlaceholders,
    emergencyBatches: phaseC.emergencyBatches,
    assigned: phaseTeam.committed + phaseB0.committed + phaseB.committed,
    teamsFormed: phaseTeam.teamsFormed + phaseC.teamsFormed,
    emergenciesCreated: phaseC.emergenciesCreated,
    abandoned: phaseC.abandoned,
    warnings,
  };
}

/** Fix-My-Menu body — split out so the public `fixMyMenu` entry can show a
 *  spinner before the synchronous algorithm blocks the main thread. Runs the
 *  pure `runFixMyMenuCore()` pipeline, then applies the UI/persistence
 *  side-effects (ritual marking, save, rerender, results modal). */
function _fixMyMenuBody(): void {
  // Snapshot the plan BEFORE the algorithm touches it, then AFTER, plus one
  // more ~30 min later (scheduled in recordFixMyMenuSnapshots) so the before
  // state, the algorithm's effect, and the by-hand follow-up can be compared.
  const beforeSnap = captureMenuSnapshot();
  const result = runFixMyMenuCore();
  recordFixMyMenuSnapshots(beforeSnap, captureMenuSnapshot());

  markFixMyMenuRun();
  // Record the run in the shared ritual store too (lunch vs dinner by the
  // clock), so every device's "Today" panel sees it — markFixMyMenuRun only
  // writes this browser's localStorage. Always West steps (FMM is West-only).
  // An evening run also catches up a still-pending lunch run, so a missed
  // fmm-lunch doesn't stay overdue once you've run FMM in the evening.
  fixMyMenuRitualSteps(getAmsterdamNow()).forEach(step => markRitualStep('west', step));
  rerenderCurrentView();
  scheduleSave();

  showResultsModal({
    cleaned: result.cleaned,
    created: result.newPlaceholders.length + result.emergenciesCreated,
    assigned: result.assigned,
    retired: result.retired,
    placeholderNames: [...result.newPlaceholders.map(p => p.name), ...result.emergencyBatches.map(p => p.name)],
    teamsFormed: result.teamsFormed,
    warnings: result.warnings,
  });
}

// ── Entry point ─────────────────────────────────────────────────────────────

/**
 * Fix-My-Menu entry point. Runs the hybrid algorithm: forced-assignment
 * pre-pass (naked-single rule) → single scored greedy loop → fallback
 * ladder → demand-based pot allocation → warnings.
 *
 * Body runs synchronously and blocks the main thread for a couple of
 * seconds on real-sized data, so we set the spinner state then defer the
 * actual work via setTimeout(0) to give the browser one paint cycle
 * before the freeze.
 */
export function fixMyMenu(): void {
  const ok = window.confirm(
    "Fix my menu will fill empty cook days with placeholder batches and clean up unused placeholders from previous runs.\n\n" +
    "Existing batches won't be removed or renamed.\n\n" +
    "Continue?"
  );
  if (!ok) return;
  setFixMyMenuLoading(true);
  setTimeout(() => { try { _fixMyMenuBody(); } finally { setFixMyMenuLoading(false); } }, 0);
}

// ── Validation ──────────────────────────────────────────────────────────────

export type WarningCategory =
  | 'emergency-dish'
  | 'under-filled-slot'
  | 'cooked-stockout'
  | 'stale-with-stock'
  | 'over-pot-cap'
  | 'burner-overload'
  | 'catering-no-dishes'
  | 'catering-dish-retired'
  | 'undeliverable-centraal'
  | 'centraal-batch-at-west';

export interface Warning {
  category: WarningCategory;
  message: string;
  anchor?: { kind: 'slot'; loc: Location; date: string; meal: Meal }
         | { kind: 'batch'; batchId: string }
         | { kind: 'catering'; cateringId: string };
  actions?: WarningAction[];
}

export type WarningAction =
  | { kind: 'use-frozen'; batchId: string; batchName: string }
  | { kind: 'add-emergency-cook'; type: DishType; loc: Location; date: string; meal: Meal }
  | { kind: 'assign-anyway'; batchId: string }
  | { kind: 'move-to-freezer'; batchId: string };

/** Age (days since cook) at which the stale-with-stock warning fires. 4+ days
 *  (Daan, 2026-07-10; was 3) — the day AFTER the 3-day Gastro shelf life ends,
 *  matching the dish tile's "Stale" status (isStaleEntry: daysOld > limit). */
const STALE_THRESHOLD_DAYS = 4;

function isStaleAtSlot(cookDateDdmmyyyy: string | null, slotIsoDate: string, threshold = STALE_THRESHOLD_DAYS): boolean {
  const cookIso = cookDateToIso(cookDateDdmmyyyy);
  if (!cookIso) return false;
  return diffDaysIso(cookIso, slotIsoDate) >= threshold;
}

/** Cooked batches whose total stock can't cover their projected demand.
 *  Shared between collectWarnings (post-FMM modal) and the live alarm board. */
export function stockoutWarnings(allBatches: Batch[], calcReq: (b: Batch) => number): Warning[] {
  const warnings: Warning[] = [];
  for (const b of allBatches) {
    if (!TYPES_TO_PLAN.includes(b.type)) continue;
    if (isOnlyFrozen(b)) continue;
    const stock = getTotalStock(b);
    if (stock <= 0) continue;
    const demand = calcReq(b);
    // Event-aware residuals (identity when the batch touches no event
    // location): stock parked at an event site can only serve that site's
    // services, so subtract each event bucket and the demand it covers —
    // otherwise festival-parked liters would silently mask a West/Centraal
    // shortfall (or festival demand would false-alarm against West stock).
    let effDemand = demand;
    let effStock = stock;
    const evLocs = eventLocsTouching(b);
    if (evLocs.length > 0) {
      const all = b.services || [];
      for (const ev of evLocs) {
        const dEv = demandOfExcluded(b, all, calcReq, demand, s => s.loc !== ev);
        const onSite = getStockAt(b, ev) + getPendingFromShipments(b, ev);
        effDemand -= Math.min(dEv, onSite);
        effStock -= onSite;
      }
    }
    if (effDemand > effStock) {
      const short = (effDemand - effStock).toFixed(1);
      warnings.push({
        category: 'cooked-stockout',
        message: `${b.name} will run out — about ${short}L short across the services it covers. The last service might run dry.`,
        anchor: { kind: 'batch', batchId: b.id },
      });
    }
  }
  return warnings;
}

/** Non-frozen batches cooked ≥4 days ago with stock left — the chef's cue to
 *  taste-check and decide. Fix My Menu keeps old food IN the rotation (oldest
 *  first, no age cutoff), so pulling it — freeze, write off, or unassign — is
 *  a deliberate chef action, prompted here.
 *  Shared between collectWarnings (post-FMM modal) and the live alarm board. */
export function staleStockWarnings(allBatches: Batch[], todayIso: string): Warning[] {
  const warnings: Warning[] = [];
  for (const b of allBatches) {
    if (!TYPES_TO_PLAN.includes(b.type)) continue;
    const stock = getTotalStock(b);
    if (stock <= 0) continue;
    if (isOnlyFrozen(b)) continue;
    if (!isStaleAtSlot(b.cookDate, todayIso)) continue;
    warnings.push({
      category: 'stale-with-stock',
      message: `${b.name} is getting old — cooked ${b.cookDate}, ${stock}L still left. It stays in the rotation (oldest first) until you pull it: taste-check, then keep serving, freeze, or write it off.`,
      anchor: { kind: 'batch', batchId: b.id },
      actions: [
        { kind: 'assign-anyway', batchId: b.id },
        { kind: 'move-to-freezer', batchId: b.id },
      ],
    });
  }
  return warnings;
}

/** Batches whose projected demand exceeds the biggest pot in the kitchen.
 *  Shared between collectWarnings (post-FMM modal) and the live alarm board. */
export function overPotCapWarnings(
  allBatches: Batch[],
  calcReq: (b: Batch) => number,
  equipment: KitchenEquipment | null,
): Warning[] {
  const warnings: Warning[] = [];
  const biggestPotInKitchen = equipment && equipment.pots.length > 0
    ? Math.max(...equipment.pots) : Infinity;
  for (const b of allBatches) {
    if (!TYPES_TO_PLAN.includes(b.type)) continue;
    if (isOnlyFrozen(b)) continue;
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
  return warnings;
}

/** Dated caterings inside [todayIso, horizonEndIso] with no dishes picked.
 *  Shared between collectWarnings (post-FMM modal) and the live alarm board. */
export function cateringNoDishesWarnings(
  caterings: { id: string; date: string | null; dishes: { dishId: string }[] }[],
  todayIso: string,
  horizonEndIso: string,
): Warning[] {
  const warnings: Warning[] = [];
  for (const c of caterings) {
    if (!c.date) continue;
    const cIso = cookDateToIso(c.date);
    if (!cIso) continue;
    if (cIso < todayIso || cIso > horizonEndIso) continue;
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
          // Frozen rescue candidates: batches whose entire inventory is Frozen.
          // Exclude ones already assigned to this slot — a pinned service can
          // survive on a frozen batch (pre-pin this was unreachable), and
          // offering "Use frozen X" for X's own slot would double-push the
          // service entry (review finding).
          const frozen = allBatches.filter(b =>
            b.type === type && isOnlyFrozen(b) && getTotalStock(b) > 0
            && !alreadyInSlot(b, slot.loc, day.isoDate, slot.meal)
          );
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

  // 2. Cooked stockout (per-batch in the unified model). One warning per
  // batch where total stock < total demand. Frozen-only batches are
  // excluded because they're not on the auto-rotation.
  warnings.push(...stockoutWarnings(allBatches, calcReq));

  // 3. Stale batch with leftover stock.
  warnings.push(...staleStockWarnings(allBatches, dateToIso(getToday())));

  // 4. Over-pot-cap: batch projected demand exceeds the biggest pot in the
  // kitchen. Only warn when food won't fit in ANY single pot.
  warnings.push(...overPotCapWarnings(allBatches, calcReq, equipment));

  // 5. Burner overload per cook day: too many >threshold pots needed for
  // available gas burners. In the unified model each batch is one pot on
  // one burner (cross-batch peers count separately by design — audit S7).
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
      const bigBatchIds = new Set<string>();
      for (const b of dayBatches) {
        const cap = potCaps.get(b.id);
        if (cap != null && cap > threshold) bigBatchIds.add(b.id);
      }
      const bigPotCount = bigBatchIds.size;
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

  // 6. Undeliverable Centraal: West-cooked batch (primaryLoc === 'west')
  // with a Centraal service on the same day as cookDate. Food is delivered
  // to Centraal the morning AFTER cooking, so same-day Centraal can't
  // physically arrive — EXCEPT a Sunday cook reaches Centraal's same-day
  // dinner (early cook + no Centraal lunch → later van), mirroring isServableBy.
  // Catches manual pre-existing assignments. Past services excluded — history.
  for (const b of allBatches) {
    if (!TYPES_TO_PLAN.includes(b.type)) continue;
    if (!b.cookDate || primaryLoc(b) !== 'west') continue;
    const cookIso = cookDateToIso(b.cookDate);
    if (!cookIso) continue;
    // Reuse the single source of truth: with s.date === cookIso this is exactly
    // "the van can't reach this same-day Centraal slot" (incl. the Sunday-dinner
    // exception), so it stays in lockstep with the placement gate + coverage.
    const violating = (b.services || []).filter(s =>
      s.loc === 'centraal' && s.date === cookIso && !isServicePast(s)
      && !isServiceClosed(s.loc, s.date, s.meal)
      && !westReachesCentraal(cookIso, s.date, s.meal));
    if (violating.length > 0) {
      const meals = violating.map(s => s.meal).join(' + ');
      warnings.push({
        category: 'undeliverable-centraal',
        message: `${b.name} is set to serve at Centraal ${meals} on the same day it's cooked. Centraal gets food delivered the morning AFTER cooking — it won't arrive in time. Move it to a later day or cook it earlier.`,
        anchor: { kind: 'batch', batchId: b.id },
      });
    }
  }

  // 6b. Centraal-cooked batch with a West service. Symmetric to (6): no
  // reverse delivery van Centraal→West. Past services excluded.
  for (const b of allBatches) {
    if (!TYPES_TO_PLAN.includes(b.type)) continue;
    if (primaryLoc(b) !== 'centraal') continue;
    const violating = (b.services || []).filter(s => s.loc === 'west' && !isServicePast(s) && !isServiceClosed(s.loc, s.date, s.meal));
    if (violating.length > 0) {
      warnings.push({
        category: 'centraal-batch-at-west',
        message: `${b.name} is at Centraal but is set to serve at West (${violating.length} service${violating.length === 1 ? '' : 's'}). There's no transport from Centraal back to West — either move the batch, or move the service.`,
        anchor: { kind: 'batch', batchId: b.id },
      });
    }
  }

  // 7. Caterings in window with no dishes assigned. addDays, not epoch math:
  // +6×86400000 lands on day+5 across the October DST fall-back.
  const todayIso = dateToIso(getToday());
  const horizonEnd = dateToIso(addDays(getToday(), PLANNING_HORIZON_DAYS - 1));
  warnings.push(...cateringNoDishesWarnings(caterings, todayIso, horizonEnd));

  return warnings;
}

// ── Results modal + warning action handlers ────────────────────────────────

interface ResultsReport {
  cleaned: number;
  created: number;
  assigned: number;
  /** Batches auto-retired this run (spent + past). Was `consolidated` in
   *  the legacy parent/split model — the unified-batch model has no
   *  family consolidation, so we surface the retire count instead. */
  retired: number;
  placeholderNames: string[];
  teamsFormed?: number;
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

const CATEGORY_ORDER: WarningCategory[] = [
  'emergency-dish',          // a service is counting on a dish nobody has picked yet
  'undeliverable-centraal',  // wrong assignment, needs immediate fix
  'centraal-batch-at-west',  // wrong assignment (no reverse delivery)
  'cooked-stockout',         // real food shortage, will run out
  'under-filled-slot',       // need to plan more food
  'over-pot-cap',            // pot doesn't fit, must split
  'burner-overload',         // can cook in shifts (less urgent)
  'stale-with-stock',        // decision needed (use or freeze)
  'catering-no-dishes',      // admin
  'catering-dish-retired',   // admin — placeholder cleaned up, catering needs a real dish
];

function categoryHeader(c: WarningCategory): { title: string; hint: string } {
  switch (c) {
    case 'emergency-dish':         return { title: '🚨 Emergency dishes', hint: 'Auto-created stand-ins with no recipe — decide what will actually be cooked.' };
    case 'undeliverable-centraal': return { title: '🚚 Won\'t arrive in time', hint: 'Centraal gets food delivered the morning after it\'s cooked.' };
    case 'centraal-batch-at-west': return { title: '↩️ No transport back to West', hint: 'Once food is at Centraal, it stays there — there\'s no return van.' };
    case 'cooked-stockout':        return { title: '🥣 Will run out of food', hint: 'Already cooked but not enough for the planned services.' };
    case 'under-filled-slot':      return { title: '📋 Slots need more food', hint: 'Each service usually has 2 soups + 2 mains.' };
    case 'over-pot-cap':           return { title: '🍲 Won\'t fit in one pot', hint: 'Cook it in two pots so it fits.' };
    case 'burner-overload':        return { title: '🔥 Not enough gas burners', hint: 'You\'ll need to cook in shifts that day.' };
    case 'stale-with-stock':       return { title: '⏰ Old food still around', hint: 'Either use it today or freeze it before it spoils.' };
    case 'catering-no-dishes':     return { title: '📝 Caterings without dishes', hint: 'Pick what they\'re getting from the menu.' };
    case 'catering-dish-retired':  return { title: '🍲 Catering lost a placeholder', hint: 'A placeholder this catering used was cleaned up — pick a real dish.' };
  }
}

/** Grouped, category-ordered warning list HTML. Row indices refer to
 *  positions in the `warnings` array passed here, which must be the same
 *  array stored on `_lastReport` (fixMenuGoto/fixMenuAction look rows up
 *  by that index). */
function warningsListHtml(warnings: Warning[]): string {
  if (warnings.length === 0) {
    return `<div class="fix-menu-clean">No issues — menu looks good 🎉</div>`;
  }
  const indexed = warnings.map((w, i) => ({ w, i }));
  indexed.sort((a, b) => CATEGORY_ORDER.indexOf(a.w.category) - CATEGORY_ORDER.indexOf(b.w.category));

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

  return `<div class="fix-menu-warnings-hdr">⚠️ ${warnings.length} thing${warnings.length === 1 ? '' : 's'} to look at</div>
       <div class="fix-menu-warnings-list">${sections.join('')}</div>`;
}

function showResultsModal(report: ResultsReport): void {
  _lastReport = report;
  const { cleaned, created, assigned, retired, placeholderNames, teamsFormed, warnings } = report;
  const summary: string[] = [];
  if (retired > 0) summary.push(`<div>🗑 Retired ${retired} old batch${retired === 1 ? '' : 'es'} (food used up, or a placeholder for a cook day that already passed)</div>`);
  if (created > 0) summary.push(`<div>✅ <strong>Created ${created}</strong> placeholder${created === 1 ? '' : 's'}: ${esc(placeholderNames.slice(0, 8).join(', '))}${placeholderNames.length > 8 ? ', …' : ''}</div>`);
  if (cleaned > 0) summary.push(`<div>🧹 Cleaned ${cleaned} unused placeholder${cleaned === 1 ? '' : 's'} from previous runs</div>`);
  if (assigned > 0) summary.push(`<div>📅 Assigned ${assigned} service slot${assigned === 1 ? '' : 's'}</div>`);
  if (teamsFormed && teamsFormed > 0) summary.push(`<div>🤝 Combined ${teamsFormed} multi-batch team${teamsFormed === 1 ? '' : 's'} for high-demand slots</div>`);
  if (summary.length === 0) summary.push(`<div>Menu already covers the cook rhythm — nothing to do.</div>`);

  const html = `
    <div class="modal-content fix-menu-results" onclick="event.stopPropagation()">
      <h2>Fix My Menu — done</h2>
      <div class="fix-menu-summary">${summary.join('')}</div>
      ${warningsListHtml(warnings)}
      <div class="fix-menu-actions"><button class="btn btn-primary" onclick="closeModal()">Got it</button></div>
    </div>
  `;
  showModal(html);
}

/** Standalone issues modal — the same grouped warning list, go-to and quick
 *  actions as the Fix-My-Menu results modal, minus the run summary. Used by
 *  the live alarm board on the West planner (alarm-board.ts). Stores the
 *  warnings on `_lastReport` so fixMenuGoto/fixMenuAction work unchanged. */
export function showIssuesModal(warnings: Warning[], title: string): void {
  _lastReport = { cleaned: 0, created: 0, assigned: 0, retired: 0, placeholderNames: [], warnings };
  const html = `
    <div class="modal-content fix-menu-results" onclick="event.stopPropagation()">
      <h2>${esc(title)}</h2>
      ${warningsListHtml(warnings)}
      <div class="fix-menu-actions"><button class="btn btn-primary" onclick="closeModal()">Got it</button></div>
    </div>
  `;
  showModal(html);
}

/**
 * Navigate to a warning's anchor. Closes the modal and scrolls/flashes the
 * relevant DOM element. Element selectors mirror what the planner renders.
 */
export function fixMenuGoto(idx: number): void {
  if (!_lastReport) return;
  const w = _lastReport.warnings[idx];
  if (!w?.anchor) return;
  closeModal();
  const win = window as unknown as { setPlannerSubTab?: (tab: string) => void };
  const setTab = (tab: string) => { if (typeof win.setPlannerSubTab === 'function') win.setPlannerSubTab(tab); };
  if (w.anchor.kind === 'slot') {
    setTab(w.anchor.loc);
  } else if (w.anchor.kind === 'batch') {
    const anchor = w.anchor;
    const b = S.batches.find(x => x.id === anchor.batchId);
    // Switch to the planner tab where this batch's stock primarily sits.
    // For multi-loc batches, pick the loc with more stock; stockless ties
    // (e.g. an empty emergency placeholder) follow the cook location.
    let tab: 'centraal' | 'west' = 'west';
    if (b) {
      const cQty = getStockAt(b, 'centraal');
      const wQty = getStockAt(b, 'west');
      if (cQty > wQty) tab = 'centraal';
      else if (cQty === wQty && primaryLoc(b) === 'centraal') tab = 'centraal';
      // The tile lives in the type's batch pool, which is collapsed by
      // default — without expanding it the querySelector below finds nothing
      // and the goto silently does nothing (feedback on the alarm board).
      if (!S.openBatchPools) S.openBatchPools = new Set();
      S.openBatchPools.add(b.type);
    }
    setTab(tab);
  } else if (w.anchor.kind === 'catering') {
    setTab('caterings');
  }
  setTimeout(() => {
    let target: Element | null = null;
    if (w.anchor!.kind === 'slot') {
      target = document.querySelector(`.slot[data-loc="${w.anchor.loc}"][data-date="${w.anchor.date}"][data-meal="${w.anchor.meal}"]`);
    } else if (w.anchor!.kind === 'batch') {
      target = document.querySelector(`.batch-tile[data-id="${w.anchor.batchId}"]`);
    } else if (w.anchor!.kind === 'catering') {
      const editBtn = document.querySelector(`button[onclick="openEditCatering('${w.anchor.cateringId}')"]`);
      target = editBtn?.closest('div, li, tr') || editBtn;
    }
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      spotlightWhenSettled(target, w.message);
    }
  }, 250);
}

/** Draw the goto spotlight once the smooth scroll has settled: poll the
 *  target's rect until two consecutive reads match. Smooth-scroll duration
 *  scales with distance, so a fixed delay drew the fixed-position cutout
 *  mid-flight over the wrong rows on long planners (review finding). Caps
 *  at ~3s in case a browser never stops reporting motion. */
function spotlightWhenSettled(target: Element, message: string, lastTop: number | null = null, tries = 36): void {
  const top = target.getBoundingClientRect().top;
  if ((lastTop !== null && Math.abs(top - lastTop) < 1) || tries <= 0) {
    showGotoSpotlight(target, message);
    return;
  }
  setTimeout(() => spotlightWhenSettled(target, message, top, tries - 1), 80);
}

/** Grey out the page and cut a spotlight hole around the goto target — the
 *  old yellow outline flash was too easy to miss. Same box-shadow cutout
 *  trick as the tutorial overlay (tutorial.ts), with the warning text as a
 *  caption so the context survives the modal closing. Click anywhere,
 *  scroll, or wait a few seconds to dismiss. */
function showGotoSpotlight(target: Element, message: string): void {
  document.getElementById('goto-overlay')?.remove();
  const pad = 8;
  const rect = target.getBoundingClientRect();

  const overlay = document.createElement('div');
  overlay.id = 'goto-overlay';
  overlay.className = 'goto-overlay';

  // Caption below the spotlight; falls back to above near the bottom edge.
  const capW = Math.min(340, window.innerWidth - 32);
  const capEstH = 84;
  let capTop = rect.bottom + pad + 12;
  if (capTop + capEstH > window.innerHeight - 12) capTop = Math.max(12, rect.top - pad - capEstH - 12);
  let capLeft = rect.left + rect.width / 2 - capW / 2;
  capLeft = Math.max(16, Math.min(window.innerWidth - capW - 16, capLeft));

  overlay.innerHTML = `
    <div class="goto-spotlight" style="left:${rect.left - pad}px;top:${rect.top - pad}px;width:${rect.width + pad * 2}px;height:${rect.height + pad * 2}px;"></div>
    <div class="goto-caption" style="left:${capLeft}px;top:${capTop}px;max-width:${capW}px;">${esc(message)}<div class="goto-caption-hint">Click anywhere to dismiss</div></div>
  `;
  const dismiss = () => {
    overlay.remove();
    window.removeEventListener('scroll', dismiss, true);
  };
  overlay.addEventListener('click', dismiss);
  document.body.appendChild(overlay);
  // A scroll would leave the fixed-position cutout hovering over the wrong
  // rows — dismiss instead. Capture phase (scroll doesn't bubble, and the
  // horizontal .week-scroll containers scroll too); attached after a short
  // grace so a trailing smooth-scroll event can't kill the overlay at birth.
  window.setTimeout(() => window.addEventListener('scroll', dismiss, true), 250);
  window.setTimeout(dismiss, 6000);
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
      // Unified-batch model: there's no batch-level storage. Flip every
      // non-zero inventory entry to Frozen and reset its cookDate to
      // today — freezing resets the freshness origin per the plan's
      // shelf-life rule. consolidateInventory then merges any entries
      // that became identical (loc, Frozen, today).
      const todayStr = dateToStr(getToday());
      for (const entry of (b.inventory || [])) {
        if ((entry.qty || 0) > 0) {
          entry.storage = 'Frozen';
          entry.cookDate = todayStr;
        }
      }
      consolidateInventory(b);
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
      // Belt to the candidate filter's braces: never double-push a service
      // this batch already holds (e.g. via a pinned assignment).
      if (alreadyInSlot(b, w.anchor.loc, w.anchor.date, w.anchor.meal)) {
        removeWarningRow(idx);
        toast(`${b.name} is already assigned to that service`);
        return;
      }
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
      // Reuse an existing emergency batch for same type+day if there is
      // one, rather than creating a fresh batch per click.
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
      // Prepopulate inventory with a 0-qty entry at the slot's loc so
      // primaryLoc() returns the right cook location for the
      // undeliverable-Centraal warning logic. consolidateInventory
      // merges the zero entry away once real stock arrives.
      const newBatch: Batch = {
        id: newId(),
        name: `${dayName} ${typeLabel} (Emergency)`,
        type: a.type,
        serving: 280,
        inventory: [{ loc: a.loc, storage: 'Gastro', qty: 0, cookDate: todayStr }],
        shipments: [],
        allergens: [], extraAllergens: [], orderFor: false,
        cookDate: todayStr,
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
  const sortedPots = [..._keqDraft.pots].sort((a, b) => b - a);
  const target = sortedPots[idx];
  if (target == null) return;
  const removeAt = _keqDraft.pots.indexOf(target);
  if (removeAt >= 0) _keqDraft.pots.splice(removeAt, 1);
  refreshEquipmentModal();
}

export function keqUpdateBurners(field: 'gas' | 'induction', value: string): void {
  const n = Math.max(0, Math.min(100, Number(value) || 0));
  if (field === 'gas') _keqDraft.gasBurners = n;
  else _keqDraft.inductionBurners = n;
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

// ── Cook rhythm editor (editable Fix My Menu rules) ─────────────────────────

const RHYTHM_DAY_ORDER = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const RHYTHM_DAY_LABELS: Record<string, string> = {
  Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday',
  Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday',
};

/** Working draft used by the modal — a copy so Cancel discards cleanly. */
let _crDraft: Record<string, CookRhythmDay> = {};

function crCloneActive(): Record<string, CookRhythmDay> {
  const src = getActiveRhythm();
  const out: Record<string, CookRhythmDay> = {};
  for (const day of RHYTHM_DAY_ORDER) {
    const d = src[day] || { soup: 0, main: 0, chefs: 0 };
    out[day] = { soup: d.soup, main: d.main, chefs: d.chefs };
  }
  return out;
}

function renderCookRhythmRows(): string {
  return RHYTHM_DAY_ORDER.map(day => {
    const d = _crDraft[day];
    const closed = d.soup === 0 && d.main === 0;
    const dis = closed ? 'disabled' : '';
    return `<div class="cr-row${closed ? ' cr-row-closed' : ''}">
      <span class="cr-day">${RHYTHM_DAY_LABELS[day]}</span>
      <input class="cr-num" type="number" min="0" max="50" value="${d.soup}" ${dis}
        oninput="crUpdateField('${day}','soup',this.value)" aria-label="${RHYTHM_DAY_LABELS[day]} soups" />
      <input class="cr-num" type="number" min="0" max="50" value="${d.main}" ${dis}
        oninput="crUpdateField('${day}','main',this.value)" aria-label="${RHYTHM_DAY_LABELS[day]} mains" />
      <input class="cr-num" type="number" min="0" max="50" value="${d.chefs}" ${dis}
        oninput="crUpdateField('${day}','chefs',this.value)" aria-label="${RHYTHM_DAY_LABELS[day]} chefs" />
      <label class="cr-closed"><input type="checkbox" ${closed ? 'checked' : ''}
        onchange="crToggleClosed('${day}',this.checked)" /> Closed</label>
    </div>`;
  }).join('');
}

function renderCookRhythmSummary(): string {
  let soups = 0, mains = 0, totalChefs = 0;
  let busiest = '', busiestChefs = -1;
  const closedDays: string[] = [];
  for (const day of RHYTHM_DAY_ORDER) {
    const d = _crDraft[day];
    soups += d.soup; mains += d.main;
    if (d.soup === 0 && d.main === 0) {
      closedDays.push(RHYTHM_DAY_LABELS[day]);
    } else {
      totalChefs += d.chefs;
      if (d.chefs > busiestChefs) { busiestChefs = d.chefs; busiest = RHYTHM_DAY_LABELS[day]; }
    }
  }
  // Capacity is now relative: each day's tolerated cook volume = its chefs ÷ the
  // week's total chef-days × the week's guest demand (computed at plan time).
  const shareNote = totalChefs > 0
    ? `Each day's cook capacity = its chefs ÷ <strong>${totalChefs}</strong> chef-days this week × the week's guest demand.${busiest && busiestChefs > 0 ? ` ${esc(busiest)} gets the biggest share (${busiestChefs}/${totalChefs}).` : ''}`
    : 'Set at least one chef to enable capacity planning.';
  return `<div class="cr-summary">
    <div><strong>${soups}</strong> soup${soups === 1 ? '' : 's'} + <strong>${mains}</strong> main${mains === 1 ? '' : 's'} cooked per week</div>
    <div>${shareNote}</div>
    ${closedDays.length ? `<div class="cr-closed-note">No cooking: ${esc(closedDays.join(', '))}</div>` : ''}
  </div>`;
}

function refreshCookRhythmModal(): void {
  const rows = document.getElementById('cr-rows');
  const summary = document.getElementById('cr-summary');
  if (rows) rows.innerHTML = renderCookRhythmRows();
  if (summary) summary.innerHTML = renderCookRhythmSummary();
}

export function openCookRhythmModal(): void {
  _crDraft = crCloneActive();
  const html = `
    <div class="modal-content cr-modal" onclick="event.stopPropagation()">
      <h2>Cook rhythm</h2>
      <p class="cr-help">These are the rules Fix My Menu plans against. Set how many soups and
        mains to cook each weekday, and how many chefs are in. More chefs lets Fix My Menu plan a
        bigger cook that day before it warns about overloading the kitchen. Tick <em>Closed</em> for
        a no-cook day.</p>
      <div class="cr-rows-hdr">
        <span class="cr-day">Day</span><span>Soups</span><span>Mains</span><span>Chefs</span><span></span>
      </div>
      <div id="cr-rows">${renderCookRhythmRows()}</div>
      <div id="cr-summary">${renderCookRhythmSummary()}</div>
      <div class="cr-actions">
        <button class="btn" onclick="crResetDefaults()">Reset to defaults</button>
        <span class="cr-actions-spacer"></span>
        <button class="btn" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="crSave()">Save</button>
      </div>
    </div>
  `;
  showModal(html);
}

export function crUpdateField(day: string, field: 'soup' | 'main' | 'chefs', value: string): void {
  const d = _crDraft[day];
  if (!d) return;
  const n = Math.max(0, Math.min(50, Math.round(Number(value) || 0)));
  d[field] = n;
  // Only refresh the summary — re-rendering the rows here would drop focus from
  // the number input the cook is typing into. The Closed toggle re-renders rows.
  const summary = document.getElementById('cr-summary');
  if (summary) summary.innerHTML = renderCookRhythmSummary();
}

export function crToggleClosed(day: string, closed: boolean): void {
  const d = _crDraft[day];
  if (!d) return;
  if (closed) {
    d.soup = 0; d.main = 0; d.chefs = 0;
  } else {
    // Re-open with the day's default (or 1+1+2) so the row is editable again.
    const def = DEFAULT_COOK_RHYTHM[day];
    if (def && (def.soup > 0 || def.main > 0)) {
      d.soup = def.soup; d.main = def.main; d.chefs = def.chefs;
    } else {
      d.soup = 1; d.main = 1; d.chefs = 2;
    }
  }
  refreshCookRhythmModal();
}

export function crResetDefaults(): void {
  const out: Record<string, CookRhythmDay> = {};
  for (const day of RHYTHM_DAY_ORDER) {
    const d = DEFAULT_COOK_RHYTHM[day];
    out[day] = { soup: d.soup, main: d.main, chefs: d.chefs };
  }
  _crDraft = out;
  refreshCookRhythmModal();
}

export async function crSave(): Promise<void> {
  const days: Record<string, CookRhythmDay> = {};
  for (const day of RHYTHM_DAY_ORDER) {
    const d = _crDraft[day];
    days[day] = { soup: d.soup, main: d.main, chefs: d.chefs };
  }
  S.cookRhythm = { days };
  await saveCookRhythm();
  closeModal();
  toast('Cook rhythm saved');
}
