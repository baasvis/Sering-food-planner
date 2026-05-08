/**
 * ILP solver — model the assignment as a 0/1 integer program.
 *
 * Decision vars: x[batchId, slotId] ∈ {0,1}
 *   "does batch b serve future slot s?"
 *
 * Objective (max): mirrors the scorer's main weights
 *   + W_SLOT_FILLED * (slot is filled by ≥ SLOTS_PER_TYPE distinct families)
 *   - W_LEFTOVER_LITER * (cooked-stock leftover liters after window)
 *   + small bonus for variety + oldest-first
 *
 * The exact scoring function isn't linear (peer-share counting, missed-match
 * conditional). We linearize the highest-weight terms only and let the LP
 * solver's optimum approximate the rest.
 *
 * Constraints:
 *   - At most SLOTS_PER_TYPE distinct families per (type, slot) — enforced via
 *     a "family at slot" indicator variable y[family, slot] ≥ x[b,slot] for
 *     each b in family, with sum y ≤ SLOTS_PER_TYPE per slot. We also forbid
 *     the same family appearing twice in one slot by capping y at 1.
 *   - Each cooked batch's total share over all slots ≤ stock (using a fair-share
 *     approximation: share = guests * serving / 1000 / SLOTS_PER_TYPE).
 *   - Frozen / past-cook-date / cook-day-lunch / past-slot pairs are excluded
 *     by NOT generating a variable for them.
 *
 * Time-box: the model is bounded (10-day window × ≤4 slots × small batch set),
 * the LP itself stays under 1s in practice. We cap the variable count at 5000
 * just in case.
 */

import type { SolverFn, SolverResult } from '../types';
import type { Batch, Service, Location, Meal } from '../../../shared/types';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const lpSolverPkg = require('javascript-lp-solver');
// The package's CJS export is the solver instance directly.
const lpSolver = lpSolverPkg.default || lpSolverPkg;

const PLANNING_HORIZON_DAYS = 10;
const SLOTS_PER_TYPE = 2;
const STALE_THRESHOLD_DAYS = 3;
const TYPES_TO_PLAN = ['Soup', 'Main course'] as const;
type PlannedType = typeof TYPES_TO_PLAN[number];

const SERVICE_SLOTS: { loc: Location; meal: Meal }[] = [
  { loc: 'centraal', meal: 'lunch' },
  { loc: 'centraal', meal: 'dinner' },
  { loc: 'west', meal: 'lunch' },
  { loc: 'west', meal: 'dinner' },
];

// COOK_RHYTHM duplicated locally so we don't need to load the frontend module
// (sandbox.ts side-effects we don't need for ILP).
const COOK_RHYTHM: Record<string, { soup: number; main: number }> = {
  Sun: { soup: 3, main: 3 },
  Mon: { soup: 0, main: 1 },
  Tue: { soup: 1, main: 1 },
  Wed: { soup: 1, main: 1 },
  Thu: { soup: 1, main: 1 },
  Fri: { soup: 1, main: 1 },
  Sat: { soup: 1, main: 1 },
};

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ── Helpers ────────────────────────────────────────────────────────────────

function isoToDate(iso: string): Date {
  return new Date(iso + 'T12:00:00');
}
function dateToIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function dateToDDMMYYYY(d: Date): string {
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}
function ddmmyyyyToIso(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}
function daysBetween(aIso: string, bIso: string): number {
  return Math.round((isoToDate(bIso).getTime() - isoToDate(aIso).getTime()) / 86400000);
}

interface PlanDay { date: Date; iso: string; ddmmyyyy: string; dayName: string; }

function buildPlanWindow(todayIso: string): PlanDay[] {
  const days: PlanDay[] = [];
  const start = isoToDate(todayIso);
  for (let i = 0; i < PLANNING_HORIZON_DAYS; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    days.push({ date: d, iso: dateToIso(d), ddmmyyyy: dateToDDMMYYYY(d), dayName: DAY_NAMES[d.getDay()] });
  }
  return days;
}

function getGuests(fixture: { guestsLookup: Record<string, { west: { lunch: number; dinner: number }; centraal: { lunch: number; dinner: number } }> }, loc: Location, date: string, meal: Meal): number {
  const day = fixture.guestsLookup[date];
  if (!day) return 0;
  return day[loc]?.[meal] ?? 0;
}

let placeholderCounter = 0;
function newPlaceholderId(): string {
  placeholderCounter++;
  return `bench-ilp-${Date.now().toString(36)}-${placeholderCounter}`;
}

function buildPlaceholder(day: PlanDay, type: PlannedType, index: number, total: number): Batch {
  const typeLabel = type === 'Main course' ? 'main' : 'soup';
  const indexSuffix = total > 1 ? ` ${index}` : '';
  const ddmm = day.ddmmyyyy.split('/').slice(0, 2).join('/');
  return {
    id: newPlaceholderId(),
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
    cookDate: day.ddmmyyyy,
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

// ── Core solver ────────────────────────────────────────────────────────────

export const ilp: SolverFn = (input): SolverResult => {
  const { fixture, batches } = input;
  const start = Date.now();

  const todayIso = fixture.today;
  const planWindow = buildPlanWindow(todayIso);

  // ── Step 1: strip future services on uncooked batches (redistributive) ──
  // Keep past services as-is. Don't touch cooked batches' future services either —
  // wait, the baseline strips ALL future services. We mirror that.
  for (const b of batches) {
    if (!b.services || b.services.length === 0) continue;
    b.services = b.services.filter(s => s.date < todayIso);
  }

  // ── Step 2: drop orphan generated placeholders (idempotent re-run) ────
  const orphanIds = new Set<string>();
  for (const b of batches) {
    if (b.generated === true && (!b.services || b.services.length === 0) && !b.recipeId && !b.recipeSheetId) {
      orphanIds.add(b.id);
    }
  }
  let workingBatches = batches.filter(b => !orphanIds.has(b.id));

  // ── Step 3: snapshot existing cook events per day, generate placeholders ──
  const cookEventsByDate = new Map<string, { Soup: Batch[]; 'Main course': Batch[] }>();
  for (const day of planWindow) {
    cookEventsByDate.set(day.ddmmyyyy, { Soup: [], 'Main course': [] });
  }
  for (const b of workingBatches) {
    if (!TYPES_TO_PLAN.includes(b.type as PlannedType)) continue;
    if (!b.cookDate) continue;
    const bucket = cookEventsByDate.get(b.cookDate);
    if (!bucket) continue;
    bucket[b.type as PlannedType].push(b);
  }

  const placeholders: Batch[] = [];
  for (const day of planWindow) {
    const rhythm = COOK_RHYTHM[day.dayName];
    if (!rhythm) continue;
    const bucket = cookEventsByDate.get(day.ddmmyyyy)!;
    for (const type of TYPES_TO_PLAN) {
      const target = type === 'Soup' ? rhythm.soup : rhythm.main;
      const existing = bucket[type].length;
      const gap = target - existing;
      for (let i = 0; i < gap; i++) {
        const ph = buildPlaceholder(day, type, existing + i + 1, target);
        placeholders.push(ph);
        bucket[type].push(ph);
      }
    }
  }
  workingBatches = workingBatches.concat(placeholders);

  // ── Step 4: enumerate (batch, slot) candidate pairs ────────────────────
  // A slot is (loc, date, meal) where date >= today and guests >= 1 and the
  // batch is eligible (cookday <= date, not cookday-lunch, not stale, not frozen).
  interface SlotKey { loc: Location; date: string; meal: Meal; type: PlannedType; }
  interface Candidate {
    varName: string;
    batch: Batch;
    slot: SlotKey;
    share: number;          // approx liters this batch serves at this slot (fair-share)
    cookIso: string;
    isCooked: boolean;      // stock > 0
    ageDays: number;        // cookIso → date
  }
  const candidates: Candidate[] = [];

  // Per-slot list (for pairing/family caps later)
  const slotMap = new Map<string, SlotKey>();   // slot key → metadata
  const candsBySlot = new Map<string, Candidate[]>();

  for (const day of planWindow) {
    if (day.iso < todayIso) continue;
    for (const slot of SERVICE_SLOTS) {
      const guests = getGuests(fixture, slot.loc, day.iso, slot.meal);
      if (guests < 1) continue;
      for (const type of TYPES_TO_PLAN) {
        const slotKeyStr = `${type}|${slot.loc}|${day.iso}|${slot.meal}`;
        slotMap.set(slotKeyStr, { type, loc: slot.loc, date: day.iso, meal: slot.meal });
        candsBySlot.set(slotKeyStr, []);
        for (const batch of workingBatches) {
          if (batch.type !== type) continue;
          if (batch.storage === 'Frozen') continue;
          if (!batch.cookDate) continue;
          const cookIso = ddmmyyyyToIso(batch.cookDate);
          if (!cookIso) continue;
          // Servable: cook day's dinner or later
          if (cookIso > day.iso) continue;
          if (cookIso === day.iso && slot.meal === 'lunch') continue;
          // Past cooked: skip if too old to be relevant
          const ageDays = daysBetween(cookIso, day.iso);
          // Cooked stale rule (scorer also ignores stale-cooked for missed-match)
          if (batch.stock > 0 && ageDays >= STALE_THRESHOLD_DAYS) continue;
          // For UNcooked placeholders, a sensible serving window is up to ~3 days
          // post-cook (after that, food would be stale). For cooked stocks already
          // gated by the rule above. Allow ageDays from 0 to STALE_THRESHOLD_DAYS - 1
          // for uncooked and let the LP pick what fits.
          if (batch.stock <= 0 && ageDays > STALE_THRESHOLD_DAYS) continue;
          const share = guests * (batch.serving || 280) / 1000 / SLOTS_PER_TYPE;
          const cand: Candidate = {
            varName: `x_${batch.id}__${slotKeyStr.replace(/[|]/g, '_')}`,
            batch,
            slot: { type, loc: slot.loc, date: day.iso, meal: slot.meal },
            share,
            cookIso,
            isCooked: batch.stock > 0,
            ageDays,
          };
          candidates.push(cand);
          candsBySlot.get(slotKeyStr)!.push(cand);
        }
      }
    }
  }

  // Cap: if model is too big, fall back gracefully
  if (candidates.length === 0 || candidates.length > 5000) {
    return { batches: workingBatches, durationMs: Date.now() - start, stats: { fallback: 'too_large_or_empty', candidates: candidates.length } };
  }

  // ── Step 5: build LP model ─────────────────────────────────────────────

  // Variables: each candidate is a binary 0/1.
  // Per-slot fill score: introduce slot-level "filled" indicator f_slot ∈ {0,1}
  //   2 * f_slot ≤ sum(x[b,slot]) for b in slot's candidates  (over distinct families!)
  //   To avoid family duplicates, collapse candidates by family before summing.
  //   We'll approximate by capping at 1 per family (constraint sum_x_in_family_at_slot ≤ 1).

  const variables: Record<string, Record<string, number>> = {};
  const constraints: Record<string, { min?: number; max?: number; equal?: number }> = {};
  const ints: Record<string, 1> = {};

  // Base: each x var has cost = 0 by default; we'll fold rewards/penalties below.
  for (const c of candidates) {
    variables[c.varName] = { _objective: 0 };
    ints[c.varName] = 1;
  }

  // ── Constraint: stock capacity per cooked batch ───────────────────────
  // sum(x[b,s] * share(s)) ≤ b.stock  for each cooked batch
  // (For uncooked batches, no stock cap — they're a plan; but we limit each
  //  uncooked batch to ≤ 4 slots otherwise it'd grab the whole window.)
  const batchToCands = new Map<string, Candidate[]>();
  for (const c of candidates) {
    if (!batchToCands.has(c.batch.id)) batchToCands.set(c.batch.id, []);
    batchToCands.get(c.batch.id)!.push(c);
  }
  for (const [bid, cs] of batchToCands) {
    const b = cs[0].batch;
    const conName = `cap_${bid}`;
    if (b.stock > 0) {
      // cooked: weighted by share, RHS = stock
      constraints[conName] = { max: b.stock };
      for (const c of cs) {
        variables[c.varName][conName] = c.share;
      }
    } else {
      // uncooked placeholder: cap at 8 slots (with 4 slots/day × 3 days post-cook
      // window, theoretical max is 12 — be permissive so the LP can fill aggressively)
      constraints[conName] = { max: 8 };
      for (const c of cs) {
        variables[c.varName][conName] = 1;
      }
    }
  }

  // ── Constraint: per-slot family cap (≤ SLOTS_PER_TYPE distinct families) ──
  // We treat each batch as its own family in our model (parent-mapping below).
  // Hard fail: same family in same future slot twice. We enforce this by
  // letting all candidates in one slot for a given family count as 1.
  for (const [slotKey, cs] of candsBySlot) {
    if (cs.length === 0) continue;
    // Group by family
    const byFamily = new Map<string, Candidate[]>();
    for (const c of cs) {
      const fam = c.batch.parentId || c.batch.id;
      if (!byFamily.has(fam)) byFamily.set(fam, []);
      byFamily.get(fam)!.push(c);
    }
    // At most 1 per family at this slot
    for (const [fam, famCs] of byFamily) {
      const conName = `famslot_${slotKey}_${fam}`.replace(/[|]/g, '_');
      constraints[conName] = { max: 1 };
      for (const c of famCs) variables[c.varName][conName] = 1;
    }
    // At most SLOTS_PER_TYPE total per slot
    const slotConName = `slotcap_${slotKey}`.replace(/[|]/g, '_');
    constraints[slotConName] = { max: SLOTS_PER_TYPE };
    for (const c of cs) variables[c.varName][slotConName] = 1;
  }

  // ── Objective: linearize the scorer ────────────────────────────────────
  //
  // Scorer's main rewards/penalties:
  //   +1000 per slot filled (≥ SLOTS_PER_TYPE families) — needs an indicator.
  //   -300/L leftover surplus (cooked) — directly a function of ∑ x[b,s]*share.
  //   +2 per slot with 2 distinct families (variety) ≈ same indicator as filled.
  //   +10 per oldest-first slot — too contextual to model exactly; skip.
  //
  // For each slot we add a binary `slotFilled_<slot>` variable rewarded +1002
  // (covers fill + variety). Constraint: 2 * slotFilled ≤ sum(x[b,slot]) with
  // family-deduped sum. We use the slot total ≤ 2 cap variables already, so
  // we add: slotFilled * 2 - sum(x in slot) ≤ 0 i.e. sum(x in slot) - 2*slotFilled ≥ 0.
  //
  // For leftover surplus: each cooked batch has a slack variable
  //   leftover_b ≥ stock - sum(x[b,s] * share)
  //   leftover_b ≥ 0
  // Penalty -300 * leftover_b. We linearize by adding a non-negative continuous
  // var leftover_b and the constraint:
  //   leftover_b + sum(x[b,s] * share) ≥ stock     (i.e. ≥ stock - leftover)
  // and leftover_b is unconstrained above. The solver will set leftover_b to
  // exactly stock - assigned because it's penalized.

  // For each slot, add an indicator slotFilled_<slotKey> (binary) with reward +1002
  for (const [slotKey] of candsBySlot) {
    const cs = candsBySlot.get(slotKey)!;
    if (cs.length === 0) continue;
    const indName = `f_${slotKey}`.replace(/[|]/g, '_');
    variables[indName] = { _objective: 1002 };
    ints[indName] = 1;
    // Constraint: 2 * slotFilled - sum(x in slot, family-deduped) ≤ 0
    // We don't have access to a family-deduped sum directly; instead we use
    // sum-of-x at this slot (raw). Since family caps already keep ≤ 1 per
    // family per slot, raw sum equals deduped sum.
    const conName = `find_${slotKey}`.replace(/[|]/g, '_');
    constraints[conName] = { max: 0 };
    variables[indName][conName] = 2;
    for (const c of cs) variables[c.varName][conName] = -1;
    // Cap indicator at 1
    const capName = `findcap_${slotKey}`.replace(/[|]/g, '_');
    constraints[capName] = { max: 1 };
    variables[indName][capName] = 1;
  }

  // For each cooked batch with stock > 0, add a leftover slack var penalized -300
  for (const [bid, cs] of batchToCands) {
    const b = cs[0].batch;
    if (b.stock <= 0) continue;
    if (b.storage === 'Frozen') continue;
    // Skip batches whose cookDate is well outside the window
    const cookIso = ddmmyyyyToIso(b.cookDate);
    if (!cookIso) continue;
    // Compute baseline catering hold (we don't model it as decision vars, but
    // we subtract it from the stock RHS so the leftover var represents what's
    // left after committed catering)
    // Actually simplest: don't subtract, leave as part of leftover penalty. Catering
    // is fixed and not subject to optimization.
    const slackName = `lo_${bid}`;
    variables[slackName] = { _objective: -300 };
    // Leftover ≥ stock - assigned ⇔ leftover + assigned ≥ stock
    // assigned = sum(x[b,s] * share)
    const conName = `loc_${bid}`;
    constraints[conName] = { min: b.stock };
    variables[slackName][conName] = 1;
    for (const c of cs) variables[c.varName][conName] = c.share;
  }

  // Objective: maximize sum
  const model = {
    optimize: '_objective',
    opType: 'max' as const,
    constraints,
    variables,
    ints,
    options: { timeout: 8000 },
  };

  // Solve
  let solution: Record<string, number | boolean | undefined>;
  try {
    solution = lpSolver.Solve(model) as Record<string, number | boolean | undefined>;
  } catch {
    // Fallback: return placeholders without assignments
    return { batches: workingBatches, durationMs: Date.now() - start, stats: { fallback: 'solver_threw' } };
  }

  // If timeout/infeasible, fall back to a greedy heuristic so we still produce
  // a usable plan rather than returning zero assignments.
  const useGreedyFallback = !solution || solution.feasible === false;
  if (useGreedyFallback) {
    // Simple greedy: for each slot in priority order, pick best 2 candidates
    // by (cooked-with-most-stock-share, then oldest first).
    const sortedSlots = Array.from(candsBySlot.keys()).sort();
    const usedFamiliesPerSlot = new Map<string, Set<string>>();
    const remainingStock = new Map<string, number>();
    for (const [bid, cs] of batchToCands) {
      remainingStock.set(bid, cs[0].batch.stock || 999);
    }
    for (const slotKey of sortedSlots) {
      const cs = (candsBySlot.get(slotKey) || []).slice().sort((a, b) => {
        // Prefer cooked with surplus stock, oldest first
        const aR = remainingStock.get(a.batch.id) || 0;
        const bR = remainingStock.get(b.batch.id) || 0;
        if (a.isCooked !== b.isCooked) return a.isCooked ? -1 : 1;
        if (aR !== bR) return bR - aR;
        return a.cookIso.localeCompare(b.cookIso);
      });
      const used = new Set<string>();
      let placed = 0;
      for (const c of cs) {
        if (placed >= SLOTS_PER_TYPE) break;
        const fam = c.batch.parentId || c.batch.id;
        if (used.has(fam)) continue;
        const stockLeft = remainingStock.get(c.batch.id) || 0;
        if (c.isCooked && stockLeft < c.share - 0.1) continue;
        // Take the slot
        used.add(fam);
        if (c.isCooked) remainingStock.set(c.batch.id, stockLeft - c.share);
        const svc: Service = { loc: c.slot.loc, date: c.slot.date, meal: c.slot.meal };
        const already = (c.batch.services || []).some(s => s.loc === svc.loc && s.date === svc.date && s.meal === svc.meal);
        if (!already) c.batch.services = (c.batch.services || []).concat([svc]);
        placed++;
      }
      usedFamiliesPerSlot.set(slotKey, used);
    }
    return {
      batches: workingBatches,
      durationMs: Date.now() - start,
      stats: { fallback: 'greedy', candidates: candidates.length, placeholders: placeholders.length },
    };
  }

  if (!solution || solution.feasible === false) {
    return { batches: workingBatches, durationMs: Date.now() - start, stats: { fallback: 'infeasible' } };
  }

  // ── Apply solution: walk candidates, where x_b_s == 1 add the service ──
  let servicesAdded = 0;
  for (const c of candidates) {
    const v = solution[c.varName];
    if (typeof v === 'number' && v > 0.5) {
      const svc: Service = { loc: c.slot.loc, date: c.slot.date, meal: c.slot.meal };
      // Avoid duplicate adds (shouldn't happen, but be safe)
      const already = (c.batch.services || []).some(s => s.loc === svc.loc && s.date === svc.date && s.meal === svc.meal);
      if (!already) {
        c.batch.services = (c.batch.services || []).concat([svc]);
        servicesAdded++;
      }
    }
  }

  return {
    batches: workingBatches,
    durationMs: Date.now() - start,
    stats: {
      candidates: candidates.length,
      placeholders: placeholders.length,
      servicesAdded,
      objective: typeof solution.result === 'number' ? Math.round(solution.result) : 0,
    },
  };
};
