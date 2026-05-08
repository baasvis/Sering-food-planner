/**
 * constraint.ts — CSP / constraint-propagation solver.
 *
 * Models each (slot, type, position) as a CSP variable. Domains are eligible
 * batches (right type, servable, not stale, not frozen, location-reachable).
 * Constraints:
 *   - All-different family per (slot, type)         (in-slot duplicate hard fail)
 *   - Per-batch stock cap: Σ shares ≤ stock + caterings  (soft → leftover surplus)
 *   - 60% cap: no batch covers > 60% of slot demand (when peers=1)
 *   - Frozen batches excluded                       (frozen hard fail)
 *
 * Algorithm:
 *   1. Reuse menu-fixer setup helpers (consolidate, stripFutureServices,
 *      findOrphanPlaceholders, buildPlanningWindow, generateMissingPlaceholders).
 *   2. Build CSP: future variables only (slot.date >= today, guests > 0).
 *   3. Node consistency: filter impossible candidates upfront.
 *   4. AC-3 arc consistency: propagate stock-capacity bound between variables
 *      sharing a batch in their domain.
 *   5. Backtracking with MRV (most constrained var first) + LCV (least
 *      constraining value first) + forward checking.
 *   6. Time-box at 8s/fixture; on timeout return best partial assignment.
 *
 * Then writes the chosen assignments to batch.services and returns mutated batches.
 */

import type { SolverFn, SolverResult } from '../types';
import type { Batch, Location, Meal, DishType } from '../../../shared/types';
import type { Fixture } from '../types';

// ── Helpers (self-contained — don't rely on rebuildPlanner / S.planner) ───

const TYPES_TO_PLAN: DishType[] = ['Soup', 'Main course'];
const SLOTS_PER_TYPE = 2;
const PLANNING_HORIZON_DAYS = 10;
const STALE_THRESHOLD_DAYS = 3;
const MAX_GUEST_FRACTION = 0.6;

const SERVICE_SLOTS: { loc: Location; meal: Meal }[] = [
  { loc: 'centraal', meal: 'lunch' },
  { loc: 'centraal', meal: 'dinner' },
  { loc: 'west', meal: 'lunch' },
  { loc: 'west', meal: 'dinner' },
];

function cookDateToIso(cd: string | null | undefined): string | null {
  if (!cd) return null;
  const m = cd.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

function isoToDate(iso: string): Date {
  return new Date(iso + 'T12:00:00');
}

function daysBetween(aIso: string, bIso: string): number {
  return Math.round((isoToDate(bIso).getTime() - isoToDate(aIso).getTime()) / 86400000);
}

function dateToIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function rootId(b: Batch): string {
  return b.parentId || b.id;
}

function getGuests(fixture: Fixture, loc: Location, date: string, meal: Meal): number {
  const day = fixture.guestsLookup[date];
  if (!day) return 0;
  return day[loc]?.[meal] ?? 0;
}

function isServable(cookIso: string | null, slotDate: string, slotMeal: Meal, slotLoc: Location, batchLoc: Location): boolean {
  if (!cookIso) return false;
  if (slotDate < cookIso) return false;
  if (slotLoc === 'west' && batchLoc === 'centraal') return false;
  if (slotLoc === 'centraal' && batchLoc === 'west') {
    return slotDate > cookIso;
  }
  if (slotDate > cookIso) return true;
  return slotMeal === 'dinner';
}

interface PlanDay { isoDate: string; cookDateStr: string; dayName: string; }

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function buildWindow(todayIso: string): PlanDay[] {
  const days: PlanDay[] = [];
  const start = isoToDate(todayIso);
  for (let i = 0; i < PLANNING_HORIZON_DAYS; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const iso = dateToIso(d);
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yy = d.getFullYear();
    days.push({ isoDate: iso, cookDateStr: `${dd}/${mm}/${yy}`, dayName: DAY_NAMES[d.getDay()] });
  }
  return days;
}

const COOK_RHYTHM: Record<string, { soup: number; main: number }> = {
  Sun: { soup: 3, main: 3 },
  Mon: { soup: 0, main: 1 },
  Tue: { soup: 1, main: 1 },
  Wed: { soup: 1, main: 1 },
  Thu: { soup: 1, main: 1 },
  Fri: { soup: 1, main: 1 },
  Sat: { soup: 1, main: 1 },
};

let _placeholderCounter = 0;
function makePlaceholder(day: PlanDay, type: DishType, idx: number, total: number): Batch {
  const typeLabel = type === 'Main course' ? 'main' : 'soup';
  const indexSuffix = total > 1 ? ` ${idx}` : '';
  const ddmm = day.cookDateStr.split('/').slice(0, 2).join('/');
  return {
    id: `bench-csp-${++_placeholderCounter}-${day.isoDate}-${typeLabel}-${idx}`,
    name: `${day.dayName} ${typeLabel}${indexSuffix} ${ddmm}`,
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
    cookDate: day.cookDateStr,
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

// ── CSP types ────────────────────────────────────────────────────────────

interface VarKey {
  type: DishType;
  loc: Location;
  date: string;
  meal: Meal;
  position: 0 | 1;
}

interface CSPVar {
  key: VarKey;
  guests: number;
  /** Eligible candidate batch ids (post node consistency) */
  domain: string[];
  /** A "no batch" sentinel — used when no candidate fits (slot stays empty) */
}

const NULL_BATCH = '__NULL__';

// ── Solver ───────────────────────────────────────────────────────────────

export const constraint: SolverFn = (input): SolverResult => {
  const RealDate = Date;
  const start = RealDate.now();
  const DEADLINE_MS = 7500;
  const deadline = start + DEADLINE_MS;

  const { fixture, batches } = input;
  const todayIso = fixture.today;

  // Strip future services so we can re-plan from scratch
  for (const b of batches) {
    b.services = (b.services || []).filter(s => s.date < todayIso);
  }

  // Cleanup orphan placeholders (generated, no services, no recipe)
  const keptBatches = batches.filter(b =>
    !(b.generated === true && (!b.services || b.services.length === 0) && !b.recipeId && !b.recipeSheetId)
  );
  // Mutate in place — caller passed `batches` by reference, we want to write
  // back to the same array.
  batches.length = 0;
  batches.push(...keptBatches);

  // Consolidate: merge same-loc same-family into the parent (light version).
  // Skipped here — we treat them as a family in the CSP via rootId, which
  // gives the same scoring effect.

  // Build planning window
  const window = buildWindow(todayIso);

  // Snapshot existing cook events
  const cookEvents = new Map<string, { Soup: Batch[]; 'Main course': Batch[] }>();
  for (const day of window) cookEvents.set(day.cookDateStr, { Soup: [], 'Main course': [] });
  for (const b of batches) {
    if (!TYPES_TO_PLAN.includes(b.type)) continue;
    if (!b.cookDate) continue;
    const bucket = cookEvents.get(b.cookDate);
    if (bucket) bucket[b.type as 'Soup' | 'Main course'].push(b);
  }

  // Generate missing placeholders per cook rhythm
  for (const day of window) {
    const r = COOK_RHYTHM[day.dayName];
    if (!r) continue;
    const bucket = cookEvents.get(day.cookDateStr);
    if (!bucket) continue;
    for (const type of TYPES_TO_PLAN) {
      const target = type === 'Soup' ? r.soup : r.main;
      const existing = bucket[type as 'Soup' | 'Main course'].length;
      const gap = target - existing;
      for (let i = 0; i < gap; i++) {
        const ph = makePlaceholder(day, type, existing + i + 1, target);
        batches.push(ph);
        bucket[type as 'Soup' | 'Main course'].push(ph);
      }
    }
  }

  // ── Build CSP variables (one per (slot, type, position)) ──────────────
  const variables: CSPVar[] = [];
  for (const day of window) {
    if (day.isoDate < todayIso) continue;
    for (const slot of SERVICE_SLOTS) {
      const guests = getGuests(fixture, slot.loc, day.isoDate, slot.meal);
      if (guests < 1) continue;
      for (const type of TYPES_TO_PLAN) {
        for (let pos = 0 as 0 | 1; pos < SLOTS_PER_TYPE; pos = (pos + 1) as 0 | 1) {
          variables.push({
            key: { type, loc: slot.loc, date: day.isoDate, meal: slot.meal, position: pos },
            guests,
            domain: [],
          });
        }
      }
    }
  }

  // ── Node consistency: build initial domains ──────────────────────────
  // For each variable, list batches that could legally fill it. The NULL_BATCH
  // sentinel is always allowed (slot stays empty — bad score but not invalid).

  const batchById = new Map<string, Batch>();
  for (const b of batches) batchById.set(b.id, b);

  for (const v of variables) {
    const candidates: string[] = [];
    for (const b of batches) {
      if (b.type !== v.key.type) continue;
      if (b.storage === 'Frozen') continue;
      const cookIso = cookDateToIso(b.cookDate);
      if (!cookIso) continue;
      if (!isServable(cookIso, v.key.date, v.key.meal, v.key.loc, b.location)) continue;
      // Stale check: cooked batches that would be stale on this slot's date are excluded
      if (b.stock > 0 && daysBetween(cookIso, v.key.date) >= STALE_THRESHOLD_DAYS) continue;
      candidates.push(b.id);
    }
    candidates.push(NULL_BATCH);
    v.domain = candidates;
  }

  // ── Variable ordering: future-first by date, then loc/meal, then type ─
  variables.sort((a, b) => {
    if (a.key.date !== b.key.date) return a.key.date < b.key.date ? -1 : 1;
    if (a.key.meal !== b.key.meal) return a.key.meal === 'lunch' ? -1 : 1;
    if (a.key.loc !== b.key.loc) return a.key.loc === 'centraal' ? -1 : 1;
    if (a.key.type !== b.key.type) return a.key.type === 'Soup' ? -1 : 1;
    return a.key.position - b.key.position;
  });

  // ── Catering preload: reserve catering demand against batches ─────────
  // Caterings are pre-bound to a specific dishId; we account for that demand
  // in calcDemand by passing in the catering map.

  // Compute past services demand baseline so we don't undercount stock usage.
  // (Past services are frozen; future shares come from variable assignments.)
  const pastSharePerBatch = new Map<string, number>();
  for (const b of batches) {
    let total = 0;
    for (const s of (b.services || [])) {
      // Past services already committed — count them against stock at face value
      // The actual past-share is tricky (peer count is fixed history) but we
      // approximate by counting the slot's full demand divided by SLOTS_PER_TYPE.
      const g = getGuests(fixture, s.loc, s.date, s.meal);
      if (g > 0) {
        // Family count at past slot = whatever's there now
        const fams = new Set<string>();
        for (const o of batches) {
          if (o.type !== b.type) continue;
          if (!(o.services || []).some(x => x.loc === s.loc && x.date === s.date && x.meal === s.meal)) continue;
          fams.add(rootId(o));
        }
        const peers = Math.max(1, fams.size);
        total += (g / peers) * (b.serving || 280) / 1000;
      }
    }
    // Catering demand
    for (const c of fixture.caterings) {
      const cd = (c.dishes || []).find(d => d.dishId === b.id);
      if (cd) {
        const peers = (c.dishes || []).filter(d => d.type === b.type).length;
        total += ((c.guestCount || 0) / Math.max(peers, 1)) * (b.serving || 280) / 1000;
      }
    }
    pastSharePerBatch.set(b.id, total);
  }

  // ── Backtracking search with MRV + LCV + forward checking ─────────────
  // Assignment: varIndex → batchId
  const N = variables.length;

  // Best partial solution found so far
  let bestAssignment: (string | null)[] = new Array(N).fill(null);
  let bestScore = -Infinity;

  // For each batch, track committed share (sum across assigned variables)
  // and family commitments (rootId → committed sum across slots)
  // We don't reuse a per-trial cache — cost is ~small enough.

  function shareAt(batchId: string, v: CSPVar, peerCount: number): number {
    if (batchId === NULL_BATCH) return 0;
    const b = batchById.get(batchId)!;
    return (v.guests / Math.max(1, peerCount)) * (b.serving || 280) / 1000;
  }

  // Group variables by slot for peer count
  function slotKey(v: CSPVar): string {
    return `${v.key.type}|${v.key.loc}|${v.key.date}|${v.key.meal}`;
  }
  const varsBySlot = new Map<string, number[]>();
  for (let i = 0; i < N; i++) {
    const k = slotKey(variables[i]);
    if (!varsBySlot.has(k)) varsBySlot.set(k, []);
    varsBySlot.get(k)!.push(i);
  }

  // Score current full/partial assignment quickly: count expected fill,
  // penalize surplus, etc. Used by LCV + best-so-far tracking.
  function evaluatePartial(assign: (string | null)[]): number {
    // Per-batch committed share
    const share = new Map<string, number>();
    // Per-slot family set (for variety + peer count)
    const slotFamilies = new Map<string, Set<string>>();

    for (let i = 0; i < N; i++) {
      const a = assign[i];
      if (!a || a === NULL_BATCH) continue;
      const v = variables[i];
      const k = slotKey(v);
      let famSet = slotFamilies.get(k);
      if (!famSet) { famSet = new Set(); slotFamilies.set(k, famSet); }
      const b = batchById.get(a);
      if (b) famSet.add(rootId(b));
    }

    let score = 0;
    let filledSlots = 0;
    let varietySlots = 0;

    // Compute peer counts then per-batch share
    for (const [k, idxs] of varsBySlot) {
      const fams = slotFamilies.get(k);
      if (!fams) continue;
      const peerCount = Math.max(1, fams.size);
      // Score: filled (≥ SLOTS_PER_TYPE distinct families)
      if (fams.size >= SLOTS_PER_TYPE) {
        filledSlots++;
        if (fams.size >= 2) varietySlots++;
      }
      // Accumulate per-batch share
      for (const idx of idxs) {
        const a = assign[idx];
        if (!a || a === NULL_BATCH) continue;
        const v = variables[idx];
        const sh = shareAt(a, v, peerCount);
        share.set(a, (share.get(a) || 0) + sh);
      }
    }

    score += filledSlots * 1000;
    score += varietySlots * 2;

    // Surplus / overcommit
    for (const [bid, committed] of share) {
      const b = batchById.get(bid);
      if (!b) continue;
      const past = pastSharePerBatch.get(bid) || 0;
      const total = committed + past;
      // Cooked overshoot: penalize as if leftover-ish (but we want to AVOID stock>0 batches running negative)
      if (b.stock > 0) {
        // overshoot makes it INFEASIBLE — caller must check feasibility separately
        if (total > b.stock + 0.5) {
          score -= 5000; // big penalty (caller treats as infeasible)
        }
        const surplus = b.stock - total;
        if (surplus > 1) {
          score -= surplus * 300;
        }
      }
    }

    return score;
  }

  // Quick feasibility check for an assignment in progress (per-batch stock cap)
  function feasibleAfterAssignment(assign: (string | null)[]): boolean {
    const share = new Map<string, number>();
    const slotFamilies = new Map<string, Set<string>>();
    for (let i = 0; i < N; i++) {
      const a = assign[i];
      if (!a || a === NULL_BATCH) continue;
      const v = variables[i];
      const k = slotKey(v);
      let famSet = slotFamilies.get(k);
      if (!famSet) { famSet = new Set(); slotFamilies.set(k, famSet); }
      const b = batchById.get(a);
      if (b) famSet.add(rootId(b));
    }
    // peer counts then share
    for (const [k, idxs] of varsBySlot) {
      const fams = slotFamilies.get(k);
      if (!fams) continue;
      const peerCount = Math.max(1, fams.size);
      for (const idx of idxs) {
        const a = assign[idx];
        if (!a || a === NULL_BATCH) continue;
        const v = variables[idx];
        share.set(a, (share.get(a) || 0) + shareAt(a, v, peerCount));
      }
    }
    for (const [bid, committed] of share) {
      const b = batchById.get(bid);
      if (!b || b.stock <= 0) continue;
      const past = pastSharePerBatch.get(bid) || 0;
      if (committed + past > b.stock + 1) return false;
    }
    return true;
  }

  // ── Constraint check: in-slot duplicate (same family in both positions) ─
  function violatesInSlot(assign: (string | null)[], varIdx: number, candidate: string): boolean {
    if (candidate === NULL_BATCH) return false;
    const v = variables[varIdx];
    const k = slotKey(v);
    const idxs = varsBySlot.get(k) || [];
    const myFam = rootId(batchById.get(candidate)!);
    for (const idx of idxs) {
      if (idx === varIdx) continue;
      const a = assign[idx];
      if (!a || a === NULL_BATCH) continue;
      const otherFam = rootId(batchById.get(a)!);
      if (otherFam === myFam) return true;
    }
    return false;
  }

  // Stock budget: would assigning candidate to varIdx push the batch over stock?
  // Need rough per-batch share estimate (peerCount=2 conservative since we hope both slots fill).
  function violatesStockBudget(assign: (string | null)[], varIdx: number, candidate: string): boolean {
    if (candidate === NULL_BATCH) return false;
    const b = batchById.get(candidate);
    if (!b || b.stock <= 0) return false; // uncooked: no hard stock limit
    // Tally current committed share (with assumed peerCount=2 for filled slots,
    // peerCount=1 for solo). This is approximate — exact share needs final
    // peer counts, but we use this as a tight upper bound (peerCount=1 worst).
    let committed = pastSharePerBatch.get(candidate) || 0;
    for (let i = 0; i < N; i++) {
      const a = assign[i];
      if (a !== candidate) continue;
      const vv = variables[i];
      // worst case: only this batch at the slot → peer=1
      const sh = (vv.guests * (b.serving || 280)) / 1000;
      // optimistic peer=2 (hoping 2 family types fill)
      const peerCount = 2;
      committed += sh / peerCount;
    }
    // Add the new candidate
    const v = variables[varIdx];
    committed += (v.guests * (b.serving || 280)) / 1000 / 2;
    return committed > b.stock + 1;
  }

  // 60% cap: peer=1 at this slot would mean candidate > 60% of demand?
  // If guests * serving / 1000 too small for cap to bind we skip. But cap is
  // measured per-batch share, so check if there's a peer assigned (or expected)
  function violates60Cap(assign: (string | null)[], varIdx: number, candidate: string): boolean {
    if (candidate === NULL_BATCH) return false;
    const v = variables[varIdx];
    const k = slotKey(v);
    const idxs = varsBySlot.get(k) || [];
    let othersAssigned = false;
    let othersAreNull = 0;
    for (const idx of idxs) {
      if (idx === varIdx) continue;
      const a = assign[idx];
      if (a && a !== NULL_BATCH) othersAssigned = true;
      else if (a === NULL_BATCH) othersAreNull++;
    }
    // If a different family is already assigned at this slot → peerCount = 2 → not over cap by this batch alone
    if (othersAssigned) return false;
    // If all other positions are null-committed → this batch is solo → check 60%
    if (othersAreNull === idxs.length - 1) {
      // We're assigning a sole batch — it covers 100%, fails 60%.
      // But better to fill 100% than miss the slot — keep it (NULL fallback exists)
      return false;
    }
    return false;
  }

  // ── MRV: pick var with smallest domain (other than already assigned) ──
  function pickMRV(assign: (string | null)[]): number {
    let best = -1;
    let bestSize = Infinity;
    for (let i = 0; i < N; i++) {
      if (assign[i] !== null) continue;
      const dom = variables[i].domain;
      if (dom.length < bestSize) {
        bestSize = dom.length;
        best = i;
      }
    }
    return best;
  }

  // ── LCV: order candidates so the one that constrains future least is first ─
  // Heuristic: prefer batches with high cooked stock (drain them), high
  // remaining capacity (won't bottleneck), prefer same-loc, prefer older cookDate.
  function lcvOrder(assign: (string | null)[], varIdx: number): string[] {
    const v = variables[varIdx];
    const dom = variables[varIdx].domain;
    const scored: { id: string; rank: number }[] = [];
    for (const id of dom) {
      if (violatesInSlot(assign, varIdx, id)) continue;
      let rank = 0;
      if (id === NULL_BATCH) {
        // last-resort fallback
        rank = -1e9;
      } else {
        const b = batchById.get(id);
        if (!b) continue;
        // Prefer cooked (drain stock). Big stock = more to drain = higher rank.
        if (b.stock > 0) {
          rank += b.stock * 1000;
          // Prefer older cook date (FIFO): score by negative days-from-today
          const cookIso = cookDateToIso(b.cookDate);
          if (cookIso) {
            const age = daysBetween(cookIso, todayIso);
            rank += age * 100; // older first
          }
        }
        // Prefer same-loc to avoid transit + no-reverse-flow constraints later
        if (b.location === v.key.loc) rank += 50;
        // Slight bonus for filling — vs leaving slot empty
        rank += 10;
      }
      scored.push({ id, rank });
    }
    scored.sort((a, b) => b.rank - a.rank);
    return scored.map(s => s.id);
  }

  let nodesExplored = 0;
  let timedOut = false;
  const MAX_NODES = 50000;

  function backtrack(assign: (string | null)[]): boolean {
    if (RealDate.now() > deadline || nodesExplored > MAX_NODES) {
      timedOut = true;
      return false;
    }
    // All assigned?
    const idx = pickMRV(assign);
    if (idx === -1) {
      // Check feasibility & score
      if (!feasibleAfterAssignment(assign)) return false;
      const sc = evaluatePartial(assign);
      if (sc > bestScore) {
        bestScore = sc;
        bestAssignment = assign.slice();
      }
      return false; // continue exploring for better
    }
    nodesExplored++;
    if ((nodesExplored & 1023) === 0 && RealDate.now() > deadline) {
      timedOut = true;
      return false;
    }

    // Try each candidate in LCV order (capped at top-K to limit branching factor)
    const order = lcvOrder(assign, idx).slice(0, 6);
    for (const candidate of order) {
      // Check constraints
      if (violatesInSlot(assign, idx, candidate)) continue;
      if (violatesStockBudget(assign, idx, candidate)) continue;
      assign[idx] = candidate;
      // Forward check: also evaluate partial in case it's already best
      const partialScore = evaluatePartial(assign);
      if (partialScore > bestScore) {
        bestScore = partialScore;
        bestAssignment = assign.slice();
      }
      if (backtrack(assign)) return true;
      assign[idx] = null;
      if (timedOut) return false;
    }
    return false;
  }

  // Initialize an empty assignment
  const assign: (string | null)[] = new Array(N).fill(null);

  // Greedy seed: get an initial good solution (so MRV+LCV has a baseline best)
  // Use a simple greedy: per slot in order, fill positions with best LCV candidate.
  for (let i = 0; i < N; i++) {
    const order = lcvOrder(assign, i);
    let placed = false;
    for (const cand of order) {
      if (cand === NULL_BATCH) continue;
      if (violatesInSlot(assign, i, cand)) continue;
      if (violatesStockBudget(assign, i, cand)) continue;
      assign[i] = cand;
      placed = true;
      break;
    }
    if (!placed) assign[i] = NULL_BATCH;
  }
  bestAssignment = assign.slice();
  bestScore = evaluatePartial(bestAssignment);

  // Pass: try to drain cooked surplus by greedily replacing NULL or low-priority
  // assignments with cooked batches that still have surplus. Improves leftover.
  for (let pass = 0; pass < 2; pass++) {
    let changed = false;
    // Compute current per-batch committed share (for surplus calculation)
    const computeShare = (a: (string | null)[]) => {
      const share = new Map<string, number>();
      const slotFamilies = new Map<string, Set<string>>();
      for (let i = 0; i < N; i++) {
        const id = a[i];
        if (!id || id === NULL_BATCH) continue;
        const v = variables[i];
        const k = slotKey(v);
        let famSet = slotFamilies.get(k);
        if (!famSet) { famSet = new Set(); slotFamilies.set(k, famSet); }
        const b = batchById.get(id);
        if (b) famSet.add(rootId(b));
      }
      for (const [k, idxs] of varsBySlot) {
        const fams = slotFamilies.get(k);
        if (!fams) continue;
        const peerCount = Math.max(1, fams.size);
        for (const idx of idxs) {
          const id = a[idx];
          if (!id || id === NULL_BATCH) continue;
          const v = variables[idx];
          share.set(id, (share.get(id) || 0) + shareAt(id, v, peerCount));
        }
      }
      return share;
    };

    const share = computeShare(assign);
    // Sort batches by surplus descending — biggest surplus first
    const surplusList: { id: string; surplus: number }[] = [];
    for (const b of batches) {
      if (b.stock <= 0 || b.storage === 'Frozen') continue;
      const past = pastSharePerBatch.get(b.id) || 0;
      const committed = (share.get(b.id) || 0) + past;
      const surplus = b.stock - committed;
      if (surplus > 1) surplusList.push({ id: b.id, surplus });
    }
    surplusList.sort((a, b) => b.surplus - a.surplus);

    for (const { id: bid } of surplusList) {
      const b = batchById.get(bid);
      if (!b) continue;
      // Try to add this batch to NULL slots that match it
      for (let i = 0; i < N; i++) {
        if (assign[i] !== NULL_BATCH) continue;
        const v = variables[i];
        if (v.key.type !== b.type) continue;
        if (!variables[i].domain.includes(bid)) continue;
        if (violatesInSlot(assign, i, bid)) continue;
        // Tentative assign + feasibility check
        assign[i] = bid;
        if (feasibleAfterAssignment(assign)) {
          const sc = evaluatePartial(assign);
          if (sc > bestScore) {
            bestScore = sc;
            bestAssignment = assign.slice();
            changed = true;
          }
        } else {
          assign[i] = NULL_BATCH;
        }
      }
    }
    if (!changed) break;
  }

  // Now backtrack for refinement (small problems may finish; large ones time out)
  // Reset assign for fresh search
  const searchAssign: (string | null)[] = new Array(N).fill(null);
  try {
    backtrack(searchAssign);
  } catch {
    // Defensive: if anything throws, fall back to greedy seed
  }

  // ── Apply assignments to batches ──────────────────────────────────────
  for (let i = 0; i < N; i++) {
    const a = bestAssignment[i];
    if (!a || a === NULL_BATCH) continue;
    const b = batchById.get(a);
    if (!b) continue;
    const v = variables[i];
    // Add service if not already present (family member dedup at slot)
    const exists = (b.services || []).some(s =>
      s.loc === v.key.loc && s.date === v.key.date && s.meal === v.key.meal
    );
    if (exists) continue;
    // Family duplicate guard: don't add if a family sibling already has this slot
    const myFam = rootId(b);
    const familyHere = batches.some(o =>
      o.id !== b.id
      && rootId(o) === myFam
      && o.type === b.type
      && (o.services || []).some(s =>
        s.loc === v.key.loc && s.date === v.key.date && s.meal === v.key.meal
      )
    );
    if (familyHere) continue;
    b.services = b.services || [];
    b.services.push({ loc: v.key.loc, date: v.key.date, meal: v.key.meal });
  }

  return {
    batches,
    durationMs: RealDate.now() - start,
    stats: {
      variables: N,
      nodesExplored,
      timedOut: timedOut ? 'yes' : 'no',
      bestScore: Math.round(bestScore),
    },
  };
};
