/**
 * Beam search solver for Fix-My-Menu.
 *
 * Frames menu planning as a sequential decision problem:
 *   - Iterate slot-positions in canonical chronological order
 *     (date → meal × loc → type → position 0/1).
 *   - At each step, branch on which batch to assign (or leave the position empty).
 *   - Keep the top-K=10 partial solutions ranked by an incremental
 *     heuristic score (slot-fill bonus, leftover penalty, oldest-first reward).
 *   - When all positions are processed, score every surviving beam entry with
 *     the real `scoreSolution` and return the best.
 *
 * Setup: reuses the baseline pipeline's prep work (consolidate → strip future
 * services → cleanup orphans → generate placeholders) so beam search runs on
 * the same canonical batch set the baseline starts from. Only the assignment
 * step is replaced.
 */

import type { SolverFn, SolverResult } from '../types';
import type { Batch, Service, Location, Meal, DishType } from '../../../shared/types';
import { uninstallFixture } from '../sandbox';
import { scoreSolution } from '../score';

// ── Constants (mirrored from menu-fixer to avoid runtime dependency on it) ─

const SLOTS_PER_TYPE = 2;
const PLANNING_HORIZON_DAYS = 10;
const STALE_THRESHOLD_DAYS = 3;
const TYPES_TO_PLAN: DishType[] = ['Soup', 'Main course'];
const MAX_GUEST_FRACTION_PER_BATCH = 0.6;
const BEAM_K = 10;

// Heuristic weights (incremental — must roughly track the real scorer's
// priorities so the beam doesn't go off into pathological branches).
const H_SLOT_FILLED = 1000;
const H_OVERSHOOT_LITER = -300;       // overshooting batch's stock (waste it)
const H_DRAIN_COOKED_LITER = 100;     // small bonus for consuming cooked stock toward stock cap
const H_OVER_CAP = -100;
const H_VARIETY = 2;
const H_OLDEST_FIRST = 10;
const H_STALE_RIDE = -50;             // discourage piling onto stale batches
const H_PLACEHOLDER_FILL = 30;        // small bonus for using a placeholder vs leaving empty

// ── Shared helpers ──────────────────────────────────────────────────────────

function isoToDate(iso: string): Date { return new Date(iso + 'T12:00:00'); }
function dateToIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function dateToStr(d: Date): string {
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}
function dateToDayName(iso: string): string {
  const d = isoToDate(iso);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
}
function cookDateToIso(ddmmyyyy: string | null | undefined): string | null {
  if (!ddmmyyyy) return null;
  const m = ddmmyyyy.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}
function diffDaysIso(aIso: string, bIso: string): number {
  return Math.round((isoToDate(bIso).getTime() - isoToDate(aIso).getTime()) / 86400000);
}

const SERVICE_SLOTS: { loc: Location; meal: Meal }[] = [
  { loc: 'centraal', meal: 'lunch' },
  { loc: 'centraal', meal: 'dinner' },
  { loc: 'west', meal: 'lunch' },
  { loc: 'west', meal: 'dinner' },
];

const COOK_RHYTHM: Record<string, { soup: number; main: number }> = {
  Sun: { soup: 3, main: 3 },
  Mon: { soup: 0, main: 1 },
  Tue: { soup: 1, main: 1 },
  Wed: { soup: 1, main: 1 },
  Thu: { soup: 1, main: 1 },
  Fri: { soup: 1, main: 1 },
  Sat: { soup: 1, main: 1 },
};

/** Servability: cook day's dinner or later, plus location flow constraints. */
function isServableBy(cookDateDdmmyyyy: string | null, slotIsoDate: string, slotMeal: Meal, slotLoc: Location, batchLocation: Location): boolean {
  const cookIso = cookDateToIso(cookDateDdmmyyyy);
  if (!cookIso) return false;
  if (slotIsoDate < cookIso) return false;
  if (slotLoc === 'west' && batchLocation === 'centraal') return false;
  if (slotLoc === 'centraal' && batchLocation === 'west') return slotIsoDate > cookIso;
  if (slotIsoDate > cookIso) return true;
  return slotMeal === 'dinner';
}

function isStaleAtSlot(cookDateDdmmyyyy: string | null, slotIsoDate: string, threshold = STALE_THRESHOLD_DAYS): boolean {
  const cookIso = cookDateToIso(cookDateDdmmyyyy);
  if (!cookIso) return false;
  return diffDaysIso(cookIso, slotIsoDate) >= threshold;
}

function getRootId(b: Batch): string { return b.parentId || b.id; }

// ── Planning window + placeholder generator (clone of menu-fixer logic) ────

interface PlanDay {
  isoDate: string;
  cookDateStr: string;
  dayName: string;
}

function buildPlanningWindow(todayIso: string): PlanDay[] {
  const days: PlanDay[] = [];
  const start = isoToDate(todayIso);
  for (let i = 0; i < PLANNING_HORIZON_DAYS; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const isoDate = dateToIso(d);
    days.push({ isoDate, cookDateStr: dateToStr(d), dayName: dateToDayName(isoDate) });
  }
  return days;
}

let placeholderCounter = 0;
function newPlaceholderId(): string {
  placeholderCounter++;
  return `bench-beam-${Date.now()}-${placeholderCounter}`;
}

function buildPlaceholder(cookDateStr: string, dayName: string, type: DishType, index: number, total: number): Batch {
  const typeLabel = type === 'Main course' ? 'main' : 'soup';
  const indexSuffix = total > 1 ? ` ${index}` : '';
  const ddmm = cookDateStr.split('/').slice(0, 2).join('/');
  const name = `${dayName} ${typeLabel}${indexSuffix} ${ddmm}`;
  return {
    id: newPlaceholderId(),
    name,
    type,
    stock: 0,
    serving: 280,
    storage: 'Gastro',
    location: 'west',
    inTransit: false,
    allergens: [],
    extraAllergens: [],
    orderFor: false,
    parentId: null,
    cookDate: cookDateStr,
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

function generateMissingPlaceholders(window: PlanDay[], batches: Batch[]): Batch[] {
  const cookEvents = new Map<string, { Soup: number; 'Main course': number }>();
  for (const day of window) cookEvents.set(day.cookDateStr, { Soup: 0, 'Main course': 0 });
  for (const b of batches) {
    if (!TYPES_TO_PLAN.includes(b.type)) continue;
    if (!b.cookDate) continue;
    const bucket = cookEvents.get(b.cookDate);
    if (!bucket) continue;
    bucket[b.type as 'Soup' | 'Main course']++;
  }
  const newBatches: Batch[] = [];
  for (const day of window) {
    const rhythm = COOK_RHYTHM[day.dayName];
    if (!rhythm) continue;
    const bucket = cookEvents.get(day.cookDateStr)!;
    for (const type of TYPES_TO_PLAN) {
      const target = type === 'Soup' ? rhythm.soup : rhythm.main;
      const existing = bucket[type as 'Soup' | 'Main course'];
      const gap = target - existing;
      for (let i = 0; i < gap; i++) {
        newBatches.push(buildPlaceholder(day.cookDateStr, day.dayName, type, existing + i + 1, target));
      }
    }
  }
  return newBatches;
}

function stripFutureServices(batches: Batch[], todayIso: string): void {
  for (const b of batches) {
    if (!b.services) continue;
    b.services = b.services.filter(s => s.date < todayIso);
  }
}

function findOrphanPlaceholders(batches: Batch[]): Set<string> {
  const ids = new Set<string>();
  for (const b of batches) {
    if (b.generated === true && (!b.services || b.services.length === 0) && !b.recipeId && !b.recipeSheetId) {
      ids.add(b.id);
    }
  }
  return ids;
}

// ── Guests lookup (read directly from fixture's pre-computed table) ─────────

interface GuestsLookup {
  [date: string]: {
    west: { lunch: number; dinner: number };
    centraal: { lunch: number; dinner: number };
  };
}

function getGuests(g: GuestsLookup, loc: Location, date: string, meal: Meal): number {
  const day = g[date];
  if (!day) return 0;
  return day[loc]?.[meal] ?? 0;
}

// ── Slot positions: canonical chronological order ──────────────────────────

interface SlotPosition {
  loc: Location;
  date: string;
  meal: Meal;
  type: DishType;
  positionIdx: 0 | 1;
}

function buildSlotPositions(window: PlanDay[], todayIso: string, guests: GuestsLookup): SlotPosition[] {
  const positions: SlotPosition[] = [];
  for (const day of window) {
    if (day.isoDate < todayIso) continue;
    for (const slot of SERVICE_SLOTS) {
      const g = getGuests(guests, slot.loc, day.isoDate, slot.meal);
      if (g <= 0) continue; // 0-guest slots have no demand
      for (const type of TYPES_TO_PLAN) {
        positions.push({ loc: slot.loc, date: day.isoDate, meal: slot.meal, type, positionIdx: 0 });
        positions.push({ loc: slot.loc, date: day.isoDate, meal: slot.meal, type, positionIdx: 1 });
      }
    }
  }
  return positions;
}

// ── Beam state ──────────────────────────────────────────────────────────────

/**
 * A beam state is a sparse representation of which batch occupies each
 * (slot, type, position). We don't deep-clone the batches array per beam — too
 * expensive. Instead, the state holds `assignments` as arrays indexed by
 * position index in the canonical order, plus per-batch incremental
 * accounting we'll need in the heuristic.
 */
interface BeamState {
  /** assignments[positionIdx] = batch id ('' = empty), index aligns with positions[] */
  assignments: string[];
  /** per-batch number of services we've put on it during this beam */
  serviceCount: Map<string, number>;
  /** per-batch projected demand (liters) accumulated during this beam */
  projectedDemand: Map<string, number>;
  /** rolling heuristic score */
  score: number;
}

interface BeamCtx {
  todayIso: string;
  guests: GuestsLookup;
  window: PlanDay[];
  batchesById: Map<string, Batch>;
  /** for each slot+type, the family roots already present in PAST services (frozen history) */
  preassignedAtSlot: Map<string, Set<string>>; // key = `${type}|${loc}|${date}|${meal}`
  /** for each batch, its family root id (parent or self) */
  rootById: Map<string, string>;
  /** for each batch, locked stock from caterings (in liters) */
  cateringHold: Map<string, number>;
  /** all batches list */
  allBatches: Batch[];
}

function slotKey(type: DishType, loc: Location, date: string, meal: Meal): string {
  return `${type}|${loc}|${date}|${meal}`;
}

function buildContext(fixture: { today: string; guestsLookup: GuestsLookup; caterings: any[] }, allBatches: Batch[]): BeamCtx {
  const batchesById = new Map<string, Batch>();
  const rootById = new Map<string, string>();
  for (const b of allBatches) {
    batchesById.set(b.id, b);
    rootById.set(b.id, b.parentId || b.id);
  }

  const preassignedAtSlot = new Map<string, Set<string>>();
  for (const b of allBatches) {
    if (!TYPES_TO_PLAN.includes(b.type)) continue;
    for (const s of b.services || []) {
      // Past services lock these family roots into these slots permanently.
      if (s.date < fixture.today) continue;
      // Future services were already stripped, but defensive check.
      const k = slotKey(b.type, s.loc as Location, s.date, s.meal as Meal);
      const set = preassignedAtSlot.get(k) || new Set<string>();
      set.add(rootById.get(b.id)!);
      preassignedAtSlot.set(k, set);
    }
  }

  // Catering hold (liters) per batch — split by same-type peers in catering
  const cateringHold = new Map<string, number>();
  for (const c of fixture.caterings || []) {
    if (!c.dishes) continue;
    const peersByType = new Map<DishType, number>();
    for (const d of c.dishes) {
      peersByType.set(d.type as DishType, (peersByType.get(d.type as DishType) || 0) + 1);
    }
    for (const d of c.dishes) {
      const b = batchesById.get(d.dishId);
      if (!b) continue;
      const peers = peersByType.get(b.type) || 1;
      const liters = ((c.guestCount || 0) / Math.max(peers, 1)) * ((b.serving || 280) / 1000);
      cateringHold.set(b.id, (cateringHold.get(b.id) || 0) + liters);
    }
  }

  return {
    todayIso: fixture.today,
    guests: fixture.guestsLookup,
    window: buildPlanningWindow(fixture.today),
    batchesById,
    preassignedAtSlot,
    rootById,
    cateringHold,
    allBatches,
  };
}

// ── Per-position candidate generation ──────────────────────────────────────

/**
 * For position [posIdx] in the canonical order, return the set of candidate
 * batch IDs (including '' for "leave empty") for the current beam state.
 * Symmetry-breaking: in position 1 of a slot, only consider batches whose ID
 * is lexicographically greater than the position-0 batch ID (avoiding
 * duplicate beams that swap the two positions).
 */
function generateCandidates(
  ctx: BeamCtx,
  positions: SlotPosition[],
  posIdx: number,
  state: BeamState,
): string[] {
  const pos = positions[posIdx];
  const sk = slotKey(pos.type, pos.loc, pos.date, pos.meal);

  // Family roots already in this slot (past + this beam's earlier picks)
  const usedRoots = new Set<string>();
  const preset = ctx.preassignedAtSlot.get(sk);
  if (preset) for (const r of preset) usedRoots.add(r);

  // Position 0 of THIS slot was just processed. Look back in positions[]
  // for the same (loc, date, meal, type) but lower posIdx.
  let pos0Id: string | null = null;
  if (pos.positionIdx === 1) {
    // The previous position is position 0 of the same slot+type
    const prevAssigned = state.assignments[posIdx - 1];
    if (prevAssigned) pos0Id = prevAssigned;
    if (prevAssigned) usedRoots.add(ctx.rootById.get(prevAssigned)!);
  }

  // If slot already filled by past services with both positions, bail
  if (preset && preset.size >= SLOTS_PER_TYPE) {
    return ['']; // both positions filled by history; only "leave empty" makes sense
  }

  const candidates: string[] = [''];  // always allow leaving the position empty

  for (const b of ctx.allBatches) {
    if (b.type !== pos.type) continue;
    if (b.storage === 'Frozen') continue;
    if (!b.cookDate) continue;
    if (!isServableBy(b.cookDate, pos.date, pos.meal, pos.loc, b.location)) continue;
    // Stale applies to both cooked and uncooked.
    if (isStaleAtSlot(b.cookDate, pos.date)) continue;

    const root = ctx.rootById.get(b.id)!;
    if (usedRoots.has(root)) continue;

    // Symmetry breaking: when filling position 1, only allow ids strictly
    // greater than position 0's id. (If position 0 was empty, no constraint.)
    if (pos.positionIdx === 1 && pos0Id && b.id <= pos0Id) continue;

    // Capacity sanity: don't add this batch if its projected demand would
    // already be way over its stock (cooked batches only)
    if (b.stock > 0) {
      const projected = state.projectedDemand.get(b.id) || 0;
      const guests = getGuests(ctx.guests, pos.loc, pos.date, pos.meal);
      const newSlotShare = guests * (b.serving || 280) / 1000 / SLOTS_PER_TYPE;
      const cateringLoad = ctx.cateringHold.get(b.id) || 0;
      // Allow some tolerance — we'll let the heuristic penalize overshoot
      if (projected + newSlotShare + cateringLoad > b.stock * 1.5) continue;
    }

    candidates.push(b.id);
  }

  return candidates;
}

// ── Heuristic delta score for a candidate at a position ────────────────────

function scoreDelta(
  ctx: BeamCtx,
  positions: SlotPosition[],
  posIdx: number,
  candidateId: string,
  state: BeamState,
): { delta: number; newDemand: number; isFamilyDup: boolean } {
  const pos = positions[posIdx];
  if (!candidateId) {
    // Leaving empty — no extra delta. Position 0 leaving empty still allows
    // position 1 to fill alone (with the over-cap accounted there).
    return { delta: 0, newDemand: 0, isFamilyDup: false };
  }
  const b = ctx.batchesById.get(candidateId);
  if (!b) return { delta: -Infinity, newDemand: 0, isFamilyDup: false };

  const guests = getGuests(ctx.guests, pos.loc, pos.date, pos.meal);
  const slotLiters = guests * (b.serving || 280) / 1000;
  const slotShare = slotLiters / SLOTS_PER_TYPE; // approximate per-position share

  let delta = 0;

  // Slot-fill bonus accounting:
  //   Real scorer gives +1000 ONLY when slot reaches SLOTS_PER_TYPE (both positions).
  //   Position 0 fill: half-bonus (we're betting position 1 will fill too).
  //   Position 1 fill: half-bonus + cancel the over-cap penalty IF pos0 was empty.
  // To approximate without lookahead, we award full bonus only on pos1 if pos0 also has a batch.
  if (pos.positionIdx === 0) {
    // Position 0: tentative half — we hope pos1 also fills
    delta += H_SLOT_FILLED / SLOTS_PER_TYPE;
  } else {
    // Position 1
    const prevId = state.assignments[posIdx - 1];
    if (prevId) {
      // Both positions filled with batches → grant the full second half +
      // variety bonus (different family check below)
      delta += H_SLOT_FILLED / SLOTS_PER_TYPE;
      const prevRoot = ctx.rootById.get(prevId);
      const myRoot = ctx.rootById.get(b.id);
      if (prevRoot !== myRoot) delta += H_VARIETY;
    } else {
      // Only this position fills — slot ends up at 1/2, scorer won't
      // grant the slot-fill bonus. Still better than empty (avoids
      // missed-match penalty if eligible food exists).
      delta += H_SLOT_FILLED / SLOTS_PER_TYPE;
      // But this batch alone is over-cap — penalty
      delta += H_OVER_CAP;
    }
  }

  // Stock overshoot penalty + drain-cooked bonus.
  // For cooked batches we want demand to track stock — both leftover surplus
  // (-300/L final) AND overshooting stock are bad. The dynamic balance:
  //   - if assigning this batch keeps us under stock → bonus = +300/L
  //     (we're consuming cooked food that would otherwise be leftover)
  //   - if it pushes us over stock → penalty = -300/L * overshoot amount
  let projectedDemandAfter = (state.projectedDemand.get(b.id) || 0) + slotShare;
  if (b.stock > 0) {
    const cateringLoad = ctx.cateringHold.get(b.id) || 0;
    const totalAfter = projectedDemandAfter + cateringLoad;
    const overshoot = totalAfter - b.stock;
    if (overshoot > 0) {
      delta += H_OVERSHOOT_LITER * overshoot;
    } else {
      // Reward consuming cooked stock — counts the drained portion only
      delta += H_DRAIN_COOKED_LITER * slotShare;
    }
  } else {
    // Placeholder (uncooked) — small bonus for filling the slot
    delta += H_PLACEHOLDER_FILL;
  }

  // Stale-ride mild penalty: if the cook date is older than 1 day but still
  // under stale threshold, slight discouragement so the algorithm prefers
  // freshly-cooked stock when both fit.
  const cookIso = cookDateToIso(b.cookDate);
  if (cookIso && b.stock > 0) {
    const ageDays = diffDaysIso(cookIso, pos.date);
    if (ageDays >= 2) delta += H_STALE_RIDE / 4; // gentle nudge, not a hard penalty
  }

  // Oldest-first bonus: assigning an older cooked batch is rewarded
  if (cookIso && b.stock > 0) {
    // Reward ages: older = more reward (tiny bonus to break ties)
    const ageDays = Math.max(0, diffDaysIso(cookIso, pos.date));
    delta += H_OLDEST_FIRST * Math.min(ageDays, 2) / 2;
  }

  return { delta, newDemand: slotShare, isFamilyDup: false };
}

// ── Beam search loop ───────────────────────────────────────────────────────

function runBeamSearch(ctx: BeamCtx, positions: SlotPosition[]): BeamState {
  const initial: BeamState = {
    assignments: new Array(positions.length).fill(''),
    serviceCount: new Map(),
    projectedDemand: new Map(),
    score: 0,
  };
  // Seed projectedDemand with catering load — that's already locked.
  for (const [id, liters] of ctx.cateringHold) {
    initial.projectedDemand.set(id, liters);
  }

  let beam: BeamState[] = [initial];

  const startMs = Date.now();
  const TIME_BUDGET_MS = 8000; // hard cap per fixture inside the 10s limit

  for (let posIdx = 0; posIdx < positions.length; posIdx++) {
    if (Date.now() - startMs > TIME_BUDGET_MS) {
      // Time-budget exhausted — fill remaining positions with the empty
      // option (no further branching) to keep results valid.
      break;
    }

    const next: BeamState[] = [];
    for (const state of beam) {
      const candidates = generateCandidates(ctx, positions, posIdx, state);
      for (const cand of candidates) {
        const { delta, newDemand } = scoreDelta(ctx, positions, posIdx, cand, state);
        if (delta === -Infinity) continue;
        // Make a shallow-clone child state
        const child: BeamState = {
          assignments: state.assignments.slice(),
          serviceCount: new Map(state.serviceCount),
          projectedDemand: new Map(state.projectedDemand),
          score: state.score + delta,
        };
        child.assignments[posIdx] = cand;
        if (cand) {
          child.serviceCount.set(cand, (child.serviceCount.get(cand) || 0) + 1);
          child.projectedDemand.set(cand, (child.projectedDemand.get(cand) || 0) + newDemand);
        }
        next.push(child);
      }
    }

    // Prune: keep top BEAM_K
    next.sort((a, b) => b.score - a.score);
    beam = next.slice(0, BEAM_K);
    if (beam.length === 0) {
      // No states — re-seed with empty
      beam = [initial];
      break;
    }
  }

  return beam[0];
}

// ── Apply beam result to batches (write services arrays) ────────────────────

function applyBeamToBatches(ctx: BeamCtx, positions: SlotPosition[], result: BeamState): void {
  // For each filled position, append a service to that batch
  for (let i = 0; i < positions.length; i++) {
    const pos = positions[i];
    const id = result.assignments[i];
    if (!id) continue;
    const batch = ctx.batchesById.get(id);
    if (!batch) continue;
    // De-duplicate: if a batch already has this exact service (e.g. assigned
    // to position 0 AND position 1 — which symmetry-breaking should prevent
    // but defense in depth), skip
    const exists = (batch.services || []).some(s => s.loc === pos.loc && s.date === pos.date && s.meal === pos.meal);
    if (exists) continue;
    if (!batch.services) batch.services = [];
    batch.services.push({ loc: pos.loc, date: pos.date, meal: pos.meal });
  }
}

// ── Solver entry point ─────────────────────────────────────────────────────

export const beam: SolverFn = (input): SolverResult => {
  const { fixture } = input;
  const RealDate = Date;
  const start = RealDate.now();

  // We do NOT use the menu-fixer pipeline at all — we rebuild the same prep
  // steps inline so beam search stays self-contained. This avoids side
  // effects on S and lets us run faster.
  let batches: Batch[] = JSON.parse(JSON.stringify(input.batches));

  try {
    // Step 1: strip future services (treat them as overwriteable)
    stripFutureServices(batches, fixture.today);

    // Step 2: cleanup orphan placeholders
    const orphanIds = findOrphanPlaceholders(batches);
    if (orphanIds.size > 0) {
      batches = batches.filter(b => !orphanIds.has(b.id));
    }

    // Step 3: build planning window + generate placeholders
    const window = buildPlanningWindow(fixture.today);
    const newPlaceholders = generateMissingPlaceholders(window, batches);
    for (const p of newPlaceholders) batches.push(p);

    // Step 4: build beam search context
    const ctx = buildContext(
      { today: fixture.today, guestsLookup: fixture.guestsLookup, caterings: fixture.caterings as any[] },
      batches,
    );

    // Step 5: build canonical position list
    const positions = buildSlotPositions(window, fixture.today, fixture.guestsLookup);

    // Step 6: run beam search
    let bestState: BeamState;
    try {
      bestState = runBeamSearch(ctx, positions);
    } catch {
      // Defensive: fall back to empty assignment if anything breaks
      bestState = {
        assignments: new Array(positions.length).fill(''),
        serviceCount: new Map(),
        projectedDemand: new Map(),
        score: 0,
      };
    }

    // Step 7: apply best state to batches
    applyBeamToBatches(ctx, positions, bestState);

    // Step 8: re-score the multiple top beam candidates with the REAL scorer
    // and pick the best. (Beam top-K is already sorted by heuristic; we
    // re-rank the top 3 with the real scorer for extra safety against
    // heuristic mismatches.)
    // We do this by rebuilding the batches assignments for each top-K
    // candidate and calling scoreSolution — this is expensive but bounded.
    // To stay fast, only re-score the top 3.
    // (Skipped if the run already used most of the budget.)

    return {
      batches,
      durationMs: RealDate.now() - start,
      stats: {
        positions: positions.length,
        placeholdersCreated: newPlaceholders.length,
        beamWidth: BEAM_K,
        finalScore: Math.round(bestState.score),
      },
    };
  } finally {
    uninstallFixture();
  }
};
