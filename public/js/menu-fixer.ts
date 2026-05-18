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

import type { Batch, DishType, Location, Meal, KitchenEquipment } from '@shared/types';
import { S } from './state';
import { newId, scheduleSave, toast, toastError, saveKitchenEquipment } from './utils';
import {
  rebuildPlanner, getToday, dateToIso, dateToStr, dateToDayName,
  isServicePast, isServiceDatePast, calcRequired, calcRequiredLive, getGuests, getTotalStock, getStockAt,
  getServeableStockAt, getServeableTotalStock,
  consolidateInventory,
} from './core';
import { rerenderCurrentView } from './navigate';
import { showModal, closeModal, esc } from './modal';
import { markFixMyMenuRun } from './transport-card';

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
 * services (already served by `isServicePast`) are preserved as-is. Makes
 * the algorithm fully redistributive: starts from a clean slate of future
 * assignments and rebuilds from current state.
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

// ── Cleanup orphan + spent batches ──────────────────────────────────────────

/**
 * Batches generated by a previous run, never assigned to a service, never
 * linked to a recipe. Pressing the button twice in a row is idempotent
 * because the second run undoes the placeholders the first run created.
 *
 * Cook-created placeholders (`generated !== true`) are NEVER returned.
 */
export function findOrphanPlaceholders(batches: Batch[]): Batch[] {
  return batches.filter(b =>
    b.generated === true
    && (!b.services || b.services.length === 0)
    && !b.recipeId
  );
}

/**
 * Spent batches: total stock = 0, no pending shipments, and every service
 * dated strictly before today (isServiceDatePast — a date-only check, so a
 * batch still scheduled for today is never auto-retired, even right after
 * inventory has been marked done). Auto-retire keeps the planner clear of
 * dead past records; the pending-shipment guard protects food that's been
 * packed but is still in transit.
 */
export function findSpentBatches(batches: Batch[]): Batch[] {
  return batches.filter(b =>
    TYPES_TO_PLAN.includes(b.type)
    && getTotalStock(b) === 0
    && (b.shipments || []).every(s => s.arrived)
    && b.services && b.services.length > 0
    && b.services.every(s => isServiceDatePast(s))
  );
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

function cookDateToIso(ddmmyyyy: string | null | undefined): string | null {
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
 *   - West-cooked batch + Centraal slot → next-morning delivery only.
 *     Same-day Centraal dinner is too early; the morning van runs the
 *     next day.
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
  if (slotLoc === 'west' && batchLocation === 'centraal') return false;
  if (slotLoc === 'centraal' && batchLocation === 'west') {
    return slotIsoDate > cookIso;
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

/** Hard cutoff for cooked stock: a batch is stale when the slot date is
 *  this many days or more after the cook date. Legal ages 0-4 days; 5+ is
 *  excluded. Within the legal range, staleness is a graduated score
 *  penalty (see scoreCandidate). */
const FRESH_LIMIT_DAYS = 5;

/** Floor for forced-assignment lock-in. A unique-candidate slot only gets
 *  pre-locked if its score clears this — bad-only-options compete normally. */
const FORCED_ASSIGN_MIN_SCORE = 200;

/** Fallback ladder team threshold: "some coverage" beats "none." */
const FALLBACK_TEAM_MIN_COVERAGE = 0.6;

/** Per-cook-event production estimate (~90L per dish), threshold for the
 *  workload-overload escape that prefers extending older stock over
 *  piling demand onto an already-busy cook day. */
const PER_DISH_LITERS = 90;
const WORKLOAD_OVERLOAD_TRIGGER_FACTOR = 1.2;
const WORKLOAD_PENALTY_PER_LITER = 30;

/** Score weights. Tuned so empty-slot urgency dominates. */
const SCORE = {
  EMPTY_SLOT: 1000,
  HALF_FILLED_SLOT: 300,
  CENTRAAL_SLOT_PRIORITY: 150,
  COOKED_WITH_STOCK: 80,
  SAME_DAY_DINNER: 200,
  PRIOR_DAY_LUNCH: 200,
  SAME_DAY_LUNCH_PENALTY: -300,
  PRIOR_DAY_DINNER: 30,
  STALE_PENALTY_PER_DAY: -50,
  /** Pushes 4-day extensions from "preferred" to "last resort." Defeated
   *  by the workload-overload escape on overloaded cook days. */
  STALE_DAY_4_SURCHARGE: -600,
  CENTRAAL_STOCK_AT_CENTRAAL: 100,
  SAME_LOCATION: 50,
  POT_FILL_BONUS_MAX: 30,
  ALLERGEN_DIVERSITY: 25,
};

function cookDayThreshold(dayName: string): number {
  const r = COOK_RHYTHM[dayName];
  if (!r) return 0;
  return (r.soup + r.main) * PER_DISH_LITERS;
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
 *   - Staleness uses batch.cookDate + FRESH_LIMIT_DAYS as 5-day hard
 *     cutoff. Within 5 days, scoreCandidate applies a graduated penalty.
 *   - Capacity check: getTotalStock(b) >= calcReqLive(b) for cooked
 *     batches. Empty-inventory placeholders pass automatically — capacity
 *     is whatever the cook decides at confirm-cooked time.
 */
function scoredHardConstraintsOk(
  c: CandidatePlace,
  allBatches: Batch[],
  calcReq: (b: Batch) => number,
  getGuestsFn: (loc: Location, isoDate: string, meal: Meal) => number,
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
  // 5-day hard cutoff for cooked stock.
  if (totalStock > 0 && diffDaysIso(cookIso, day.isoDate) >= FRESH_LIMIT_DAYS) return false;
  if (totalStock <= 0) return true;  // placeholder — capacity is whatever the cook decides
  // Capacity check: tentatively add the service and verify the batch's
  // total demand still fits its SERVEABLE stock (Daan smoke 2026-05-12:
  // frozen qty should stay frozen until explicitly assigned; the auto
  // allocator must not satisfy a service slot by counting frozen
  // coverage). calcReq is calcReqLive which rebuilds the planner
  // (refreshes _batchAllocations peer-share cache) so the speculative
  // service is reflected in the next read. try/finally so a throwing
  // calcReq can't leave the speculative service stuck.
  batch.services.push({ loc: slot.loc, date: day.isoDate, meal: slot.meal });
  let fits: boolean;
  try {
    fits = calcReq(batch) <= serveableStock;
  } finally {
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
): number {
  const { batch, slot, day, type } = c;
  let score = 0;

  const filled = countTypeInSlot(allBatches, type, slot.loc, day.isoDate, slot.meal);
  if (filled === 0) score += SCORE.EMPTY_SLOT;
  else if (filled === 1) score += SCORE.HALF_FILLED_SLOT;

  if (slot.loc === 'centraal') score += SCORE.CENTRAAL_SLOT_PRIORITY;

  // totalStock = anything in inventory or in-flight shipments (including
  // frozen) — used for the "is this a placeholder?" check downstream.
  // serveableStock = non-frozen — used for the "has cooked food ready
  // for service" bonus. A frozen-only batch shouldn't get the
  // COOKED_WITH_STOCK reward; the cook hasn't thawed it yet.
  const totalStock = getTotalStock(batch);
  const serveableStock = getServeableTotalStock(batch);
  if (serveableStock > 0) score += SCORE.COOKED_WITH_STOCK;

  const cookIso = cookDateToIso(batch.cookDate)!;
  const days = diffDaysIso(cookIso, day.isoDate);
  if (slot.meal === 'dinner') {
    if (days === 0) score += SCORE.SAME_DAY_DINNER;
    else score += SCORE.PRIOR_DAY_DINNER;
  } else {
    if (days === 0) score += SCORE.SAME_DAY_LUNCH_PENALTY;
    else score += SCORE.PRIOR_DAY_LUNCH;
  }
  if (days > 0) score += SCORE.STALE_PENALTY_PER_DAY * days;
  if (days >= 4) score += SCORE.STALE_DAY_4_SURCHARGE;

  // Workload-overload escape: applies only to fresh placeholder candidates
  // (committing this slot would make the placeholder's cook day busier).
  // Not applied to already-cooked batches (no impact on cook days), and
  // not applied on Sundays (cooks accept heavy Sundays).
  if (totalStock <= 0 && batch.cookDate) {
    const phCookIso = cookDateToIso(batch.cookDate);
    const cookDayName = phCookIso ? dateToDayName(phCookIso) : '';
    if (cookDayName !== 'Sun') {
      const threshold = cookDayThreshold(cookDayName);
      if (threshold > 0) {
        const slotGuests = getGuestsFn(slot.loc, day.isoDate, slot.meal);
        const myShare = (slotGuests / SLOTS_PER_TYPE) * (batch.serving || 280) / 1000;
        let load = myShare;
        for (const b of allBatches) {
          if (b.cookDate !== batch.cookDate) continue;
          if (!TYPES_TO_PLAN.includes(b.type)) continue;
          load += calcReq(b);
        }
        const trigger = threshold * WORKLOAD_OVERLOAD_TRIGGER_FACTOR;
        if (load > trigger) {
          score -= WORKLOAD_PENALTY_PER_LITER * (load - trigger);
        }
      }
    }
  }

  // Per-loc inventory bonuses (replaces the legacy batch.location read).
  // CENTRAAL_STOCK_AT_CENTRAAL: bonus when the slot is Centraal AND the
  // batch has SERVEABLE Centraal-located stock — drains Centraal-arrived
  // inventory before pulling more across the morning van. Frozen at
  // Centraal doesn't qualify; it has to thaw before it can serve.
  if (slot.loc === 'centraal' && getServeableStockAt(batch, 'centraal') > 0) {
    score += SCORE.CENTRAAL_STOCK_AT_CENTRAAL;
  }
  // SAME_LOCATION: bonus when the batch has serveable stock physically
  // at the slot's location — drains local stock before remote.
  if (getServeableStockAt(batch, slot.loc) > 0) {
    score += SCORE.SAME_LOCATION;
  }

  const cap = potCaps.get(batch.id);
  if (cap != null && cap > 0) {
    const slotGuests = getGuestsFn(slot.loc, day.isoDate, slot.meal);
    const projected = calcReq(batch)
      + (slotGuests / SLOTS_PER_TYPE) * (batch.serving || 280) / 1000;
    if (projected <= cap) {
      const fill = Math.min(1, projected / cap);
      score += SCORE.POT_FILL_BONUS_MAX * fill;
    }
  }

  // Allergen diversity: bonus when this batch's allergens differ from the
  // slot's existing peer (only kicks in for the 2nd position).
  if (filled > 0 && batch.allergens && batch.allergens.length > 0) {
    const peerAllergens = new Set<string>();
    for (const b of allBatches) {
      if (b.id === batch.id) continue;
      if (b.type !== type) continue;
      if (!(b.services || []).some(s => s.loc === slot.loc && s.date === day.isoDate && s.meal === slot.meal)) continue;
      for (const a of b.allergens || []) peerAllergens.add(a);
    }
    if (peerAllergens.size > 0) {
      const myAllergens = new Set(batch.allergens);
      const overlap = [...peerAllergens].filter(a => myAllergens.has(a)).length;
      if (overlap < peerAllergens.size) score += SCORE.ALLERGEN_DIVERSITY;
    }
  }

  return score;
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
            if (scoredHardConstraintsOk(c, allBatches, calcReq, getGuestsFn)) {
              eligible.push(c);
              if (eligible.length > 1) break;
            }
          }
          if (eligible.length !== 1) continue;
          const c = eligible[0];
          const score = scoreCandidate(c, allBatches, calcReq, potCaps, getGuestsFn);
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
  let committed = 0;
  let safetyMax = 500;
  while (safetyMax-- > 0) {
    let bestScore = 0;
    let best: CandidatePlace | null = null;
    let bestId = '';
    for (const day of window) {
      for (const slot of day.slots) {
        if (slot.isPast) continue;
        if (getGuestsFn(slot.loc, day.isoDate, slot.meal) <= 0) continue;
        for (const type of TYPES_TO_PLAN) {
          const filled = countTypeInSlot(allBatches, type, slot.loc, day.isoDate, slot.meal);
          if (filled >= SLOTS_PER_TYPE) continue;
          for (const batch of allBatches) {
            const c: CandidatePlace = { batch, slot, day, type };
            if (!scoredHardConstraintsOk(c, allBatches, calcReq, getGuestsFn)) continue;
            const score = scoreCandidate(c, allBatches, calcReq, potCaps, getGuestsFn);
            if (score <= 0) continue;
            if (best === null
              || score > bestScore
              || (score === bestScore && batch.id.localeCompare(bestId) < 0)) {
              best = c;
              bestScore = score;
              bestId = batch.id;
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
            allBatches, type, slot.loc, day.isoDate, slot.meal, guests, filled, calcReq,
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
): Batch[] {
  const eligible = allBatches.filter(b => {
    if (b.type !== type) return false;
    if (!b.cookDate) return false;
    if (isOnlyFrozen(b)) return false;
    if (alreadyInSlot(b, loc, isoDate, meal)) return false;
    if (!isServableBy(b.cookDate, isoDate, meal, loc, primaryLoc(b))) return false;
    if (getTotalStock(b) > 0) {
      const cookIso = cookDateToIso(b.cookDate);
      if (!cookIso) return false;
      if (diffDaysIso(cookIso, isoDate) >= FRESH_LIMIT_DAYS) return false;
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
      const batchStock = getTotalStock(cand);
      const existingDemand = calcReq(cand);
      const projectedDemand = existingDemand + shareLitersAtThisSlot;
      if (batchStock > 0 && projectedDemand > batchStock) continue;
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

/** Fix-My-Menu body — split out so the public `fixMyMenu` entry can
 *  show a spinner before the synchronous algorithm blocks the main
 *  thread. Runs: strip future services → clean orphan placeholders →
 *  auto-retire spent batches → generate missing placeholders →
 *  forced-assignment pre-pass → scored greedy loop → fallback ladder
 *  (teams → emergency placeholder → abandoned warning) → pot allocation
 *  → warnings. */
function _fixMyMenuBody(): void {
  stripFutureServices(S.batches);

  const orphans = findOrphanPlaceholders(S.batches);
  if (orphans.length > 0) {
    const orphanIds = new Set(orphans.map(b => b.id));
    S.batches = S.batches.filter(b => !orphanIds.has(b.id));
    if (!S.deletedBatches) S.deletedBatches = [];
    for (const id of orphanIds) S.deletedBatches.push(id);
  }

  // Retire "spent" batches: total stock=0, no pending shipments, all
  // services in past. Self-healing — even if SSE resurrects them, the
  // next run wipes them. Catering refs to spent batches are also cleaned
  // so we don't leave dangling pointers.
  const spent = findSpentBatches(S.batches);
  if (spent.length > 0) {
    const spentIds = new Set(spent.map(b => b.id));
    S.batches = S.batches.filter(b => !spentIds.has(b.id));
    if (!S.deletedBatches) S.deletedBatches = [];
    for (const id of spentIds) S.deletedBatches.push(id);
    for (const c of (S.caterings || [])) {
      if (c.dishes && c.dishes.length > 0) {
        c.dishes = c.dishes.filter(d => !spentIds.has(d.dishId));
      }
    }
  }

  const planWindow = buildPlanningWindow(getToday());
  const snapshot = snapshotBatches(S.batches, planWindow);
  const newPlaceholders = generateMissingPlaceholders(planWindow, snapshot);
  for (const b of newPlaceholders) S.batches.push(b);
  rebuildPlanner();

  // Per-run getGuests memo: the scored algorithm queries the same ~56
  // (loc,date,meal) slots tens of thousands of times — once per candidate,
  // even though the value is batch-independent — and getGuests does ~6 Date
  // constructions per call. Collapsing that to one compute per slot is the
  // bulk of the speed-up. The cache lives only for this synchronous run, so a
  // guest edit elsewhere can't make it stale.
  const _guestCache = new Map<string, number>();
  const memoGuests = (loc: Location, date: string, meal: Meal): number => {
    const k = `${loc}|${date}|${meal}`;
    let v = _guestCache.get(k);
    if (v === undefined) { v = getGuests(loc, date, meal); _guestCache.set(k, v); }
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

  markFixMyMenuRun();
  rerenderCurrentView();
  scheduleSave();

  showResultsModal({
    cleaned: orphans.length,
    created: newPlaceholders.length + phaseC.emergenciesCreated,
    assigned: phaseB0.committed + phaseB.committed,
    retired: spent.length,
    placeholderNames: [...newPlaceholders.map(p => p.name), ...phaseC.emergencyBatches.map(p => p.name)],
    teamsFormed: phaseC.teamsFormed,
    warnings,
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

/** Gastro shelf-life days — used for the stale-with-stock warning. */
const STALE_THRESHOLD_DAYS = 3;

function isStaleAtSlot(cookDateDdmmyyyy: string | null, slotIsoDate: string, threshold = STALE_THRESHOLD_DAYS): boolean {
  const cookIso = cookDateToIso(cookDateDdmmyyyy);
  if (!cookIso) return false;
  return diffDaysIso(cookIso, slotIsoDate) >= threshold;
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
          const frozen = allBatches.filter(b =>
            b.type === type && isOnlyFrozen(b) && getTotalStock(b) > 0
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
  for (const b of allBatches) {
    if (!TYPES_TO_PLAN.includes(b.type)) continue;
    if (isOnlyFrozen(b)) continue;
    const stock = getTotalStock(b);
    if (stock <= 0) continue;
    const demand = calcReq(b);
    if (demand > stock) {
      const short = (demand - stock).toFixed(1);
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
    const stock = getTotalStock(b);
    if (stock <= 0) continue;
    if (isOnlyFrozen(b)) continue;
    if (!isStaleAtSlot(b.cookDate, dateToIso(getToday()))) continue;
    warnings.push({
      category: 'stale-with-stock',
      message: `${b.name} is getting old — cooked ${b.cookDate}, ${stock}L still left. Either feature it on today's menu, or freeze it before it spoils.`,
      anchor: { kind: 'batch', batchId: b.id },
      actions: [
        { kind: 'assign-anyway', batchId: b.id },
        { kind: 'move-to-freezer', batchId: b.id },
      ],
    });
  }

  // 4. Over-pot-cap: batch projected demand exceeds the biggest pot in the
  // kitchen. Only warn when food won't fit in ANY single pot.
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
  // physically arrive. Catches manual pre-existing assignments. Past
  // services excluded — they're history.
  for (const b of allBatches) {
    if (!TYPES_TO_PLAN.includes(b.type)) continue;
    if (!b.cookDate || primaryLoc(b) !== 'west') continue;
    const cookIso = cookDateToIso(b.cookDate);
    if (!cookIso) continue;
    const violating = (b.services || []).filter(s =>
      s.loc === 'centraal' && s.date === cookIso && !isServicePast(s));
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
    const violating = (b.services || []).filter(s => s.loc === 'west' && !isServicePast(s));
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
  const { cleaned, created, assigned, retired, placeholderNames, teamsFormed, warnings } = report;
  const summary: string[] = [];
  if (retired > 0) summary.push(`<div>🗑 Retired ${retired} spent batch${retired === 1 ? '' : 'es'} (food served, all services in the past)</div>`);
  if (created > 0) summary.push(`<div>✅ <strong>Created ${created}</strong> placeholder${created === 1 ? '' : 's'}: ${esc(placeholderNames.slice(0, 8).join(', '))}${placeholderNames.length > 8 ? ', …' : ''}</div>`);
  if (cleaned > 0) summary.push(`<div>🧹 Cleaned ${cleaned} unused placeholder${cleaned === 1 ? '' : 's'} from previous runs</div>`);
  if (assigned > 0) summary.push(`<div>📅 Assigned ${assigned} service slot${assigned === 1 ? '' : 's'}</div>`);
  if (teamsFormed && teamsFormed > 0) summary.push(`<div>🤝 Combined ${teamsFormed} multi-batch team${teamsFormed === 1 ? '' : 's'} for high-demand slots</div>`);
  if (summary.length === 0) summary.push(`<div>Menu already covers the cook rhythm — nothing to do.</div>`);

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
    // For multi-loc batches, pick the loc with more stock; tiebreak to West.
    let tab: 'centraal' | 'west' = 'west';
    if (b) {
      const cQty = getStockAt(b, 'centraal');
      const wQty = getStockAt(b, 'west');
      if (cQty > wQty) tab = 'centraal';
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
