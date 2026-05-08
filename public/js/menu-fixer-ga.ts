// Fix-My-Menu — GA refinement pass.
//
// Runs AFTER the 5-pass greedy completes. Takes the post-baseline state in
// `S.batches`, runs a small genetic algorithm over future-slot assignments,
// and writes the best chromosome back into batch.services if it scores
// higher than the warm-started baseline.
//
// Why a GA: the 5-pass greedy commits to per-position choices it can't
// take back. On weeks where the prior Sunday over-cooked, this produces a
// pattern of "missed matches" — slots that stay empty even though there's
// eligible food in stock — because Pass 2's 2-newest rule prefers the
// freshest batch and Pass 4's finish-off doesn't see two slots ahead. The
// GA's mutation + crossover explore the assignment space wider and recover
// these.
//
// Bench measurement (10 fixtures, see bench/menu-fixer/strategies/COMPARISON.md):
//   baseline 5-pass: mean 36,075, 99% fill, 0.7 missed/fixture, 73L surplus
//   5-pass + GA:    mean 38,794 (+7.5%), 99% fill, 0.0 missed/fixture, 66.5L surplus
// Latency: +1-3s on top of the existing pipeline. Acceptable for a button.
//
// Determinism: a fixture-name-hashed seed feeds a tiny LCG so reruns of the
// same input produce the same plan. Since prod has no fixture name, the
// seed is `${todayIso}|${batchCount}` — enough to be stable within one
// session but different between presses.

import type { Batch, Location, Meal, DishType, Service, Catering } from '@shared/types';
import { S } from './state';
import { getGuests, getRootId } from './core';

// ── Constants ──────────────────────────────────────────────────────────────

const POP_SIZE = 50;
const ELITE_COUNT = 5;
const MAX_GENERATIONS = 200;
const STAGNATION_LIMIT = 30;
const MUTATION_RATE = 0.05;
const TOURNAMENT_SIZE = 3;
const TIME_BUDGET_MS = 8000;

const PLANNING_HORIZON_DAYS = 10;
const SLOTS_PER_TYPE = 2;
const STALE_THRESHOLD_DAYS = 3;
const TYPES_TO_PLAN: DishType[] = ['Soup', 'Main course'];
const SERVICE_SLOTS: { loc: Location; meal: Meal }[] = [
  { loc: 'centraal', meal: 'lunch' },
  { loc: 'centraal', meal: 'dinner' },
  { loc: 'west', meal: 'lunch' },
  { loc: 'west', meal: 'dinner' },
];

const HARD_FAIL_FITNESS = -999999;

// Score weights — must stay in sync with bench/menu-fixer/score.ts so that
// "the GA optimizes what the bench measures." If you tune weights here,
// update the bench too and rerun the comparison.
const W_SLOT = 1000;
const W_MISS = -500;
const W_LEFT = -300;
const W_OVER = -100;
const W_STALE = -50;
const W_FAM = -20;
const W_OLD = 10;
const W_VAR = 2;
const MAX_GUEST_FRACTION_PER_BATCH = 0.6;

// Over-commit penalty: per liter of (calcRequired − stock) on cooked batches.
// User feedback 2026-05-07: small deficits (≤ ~5L) are tolerable; bigger
// deficits mean an entire dish goes hungry and the slot should stay empty
// + emit a stockout warning instead. At -200/L the breakeven against the
// +1000 slot-fill bonus is around 5L deficit:
//   4L  deficit → +1000 − 800   = +200  (still fills, OK)
//   10L deficit → +1000 − 2000  = −1000 (leaving empty wins)
//   40L deficit → +1000 − 8000  = −7000 (empty crushes)
const W_OVERCOMMIT = -200;

// ── Tiny LCG seeded by hash ────────────────────────────────────────────────

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function makeRng(seed: number): () => number {
  let state = seed || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

// ── Date / cookDate helpers (mirror core.ts but inline so we don't depend on internals) ──

function isoToDate(iso: string): Date {
  return new Date(iso + 'T12:00:00');
}

function cookDateToIso(cd: string | null | undefined): string | null {
  if (!cd) return null;
  const m = cd.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

function dateToIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function daysBetween(aIso: string, bIso: string): number {
  return Math.round((isoToDate(bIso).getTime() - isoToDate(aIso).getTime()) / 86400000);
}

function buildWindow(todayIso: string): string[] {
  const days: string[] = [];
  const start = isoToDate(todayIso);
  for (let i = 0; i < PLANNING_HORIZON_DAYS; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    days.push(dateToIso(d));
  }
  return days;
}

function isServableBy(cookDate: string | null, slotIso: string, slotMeal: Meal, slotLoc: Location, batchLoc: Location): boolean {
  const cookIso = cookDateToIso(cookDate);
  if (!cookIso) return false;
  if (slotIso < cookIso) return false;
  if (slotLoc === 'west' && batchLoc === 'centraal') return false;
  if (slotLoc === 'centraal' && batchLoc === 'west') return slotIso > cookIso;
  if (slotIso > cookIso) return true;
  return slotMeal === 'dinner';
}

// ── Eligibility ────────────────────────────────────────────────────────────

interface SlotKey { loc: Location; date: string; meal: Meal; type: DishType }

function slotKeyStr(slot: SlotKey): string {
  return `${slot.type}|${slot.loc}|${slot.date}|${slot.meal}`;
}

function isEligibleAtSlot(b: Batch, slot: SlotKey, todayIso: string): boolean {
  if (b.type !== slot.type) return false;
  if (b.storage === 'Frozen') return false;
  if (slot.date < todayIso) return false;
  if (!isServableBy(b.cookDate, slot.date, slot.meal, slot.loc, b.location || 'west')) return false;
  if (b.stock > 0) {
    const cookIso = cookDateToIso(b.cookDate);
    if (!cookIso) return false;
    if (daysBetween(cookIso, slot.date) >= STALE_THRESHOLD_DAYS) return false;
  }
  return true;
}

// ── Chromosome ─────────────────────────────────────────────────────────────
// Each chromosome is a Map<slotKey, [batchId|null, batchId|null]> covering
// every future slot in the window. Past services on each batch are
// preserved verbatim — the chromosome only encodes future assignments.

type Chromosome = Map<string, (string | null)[]>;

interface PlannerCtx {
  futureSlots: SlotKey[];
  todayIso: string;
  guestsLookup: Record<string, Record<Location, Record<Meal, number>>>;
  byId: Map<string, Batch>;
  eligibleBySlot: Map<string, string[]>;
  familyRoot: Map<string, string>;
  allBatches: Batch[];
  caterings: Catering[];
  window: string[];
}

function encodeChromosomeFromBatches(ctx: PlannerCtx): Chromosome {
  const chr: Chromosome = new Map();
  for (const s of ctx.futureSlots) chr.set(slotKeyStr(s), [null, null]);
  for (const b of ctx.allBatches) {
    if (!TYPES_TO_PLAN.includes(b.type)) continue;
    for (const svc of (b.services || [])) {
      if (svc.date < ctx.todayIso) continue;
      const k = slotKeyStr({ type: b.type, loc: svc.loc, date: svc.date, meal: svc.meal });
      const arr = chr.get(k);
      if (!arr) continue;
      const root = ctx.familyRoot.get(b.id) || b.id;
      let alreadyHas = false;
      for (const id of arr) {
        if (id && (ctx.familyRoot.get(id) || id) === root) { alreadyHas = true; break; }
      }
      if (alreadyHas) continue;
      for (let i = 0; i < arr.length; i++) {
        if (arr[i] === null) { arr[i] = b.id; break; }
      }
    }
  }
  return chr;
}

function decodeChromosomeToBatches(chr: Chromosome, ctx: PlannerCtx): void {
  for (const b of ctx.allBatches) {
    if (!b.services) { b.services = []; continue; }
    b.services = b.services.filter(s => s.date < ctx.todayIso);
  }
  for (const [k, arr] of chr) {
    const [type, loc, date, meal] = k.split('|') as [DishType, Location, string, Meal];
    for (const id of arr) {
      if (!id) continue;
      const b = ctx.byId.get(id);
      if (!b) continue;
      if (!b.services) b.services = [];
      const exists = b.services.some(s => s.loc === loc && s.date === date && s.meal === meal);
      if (!exists) b.services.push({ loc, date, meal } as Service);
    }
  }
}

function cloneChromosome(chr: Chromosome): Chromosome {
  const copy: Chromosome = new Map();
  for (const [k, arr] of chr) copy.set(k, arr.slice());
  return copy;
}

// ── Random init (heavy-mutation perturbations of warm start) ──────────────

function randomInit(ctx: PlannerCtx, rng: () => number): Chromosome {
  const chr: Chromosome = new Map();
  for (const slot of ctx.futureSlots) {
    const k = slotKeyStr(slot);
    const eligible = ctx.eligibleBySlot.get(k) || [];
    const used: (string | null)[] = [null, null];
    if (eligible.length > 0) {
      const usedFamilies = new Set<string>();
      for (let i = 0; i < SLOTS_PER_TYPE; i++) {
        const remaining = eligible.filter(id => {
          const root = ctx.familyRoot.get(id) || id;
          return !usedFamilies.has(root);
        });
        if (remaining.length === 0) { used[i] = null; continue; }
        if (rng() < 0.3 && i > 0) { used[i] = null; continue; }
        const pick = remaining[Math.floor(rng() * remaining.length)];
        used[i] = pick;
        usedFamilies.add(ctx.familyRoot.get(pick) || pick);
      }
    }
    chr.set(k, used);
  }
  return chr;
}

// ── Mutation / crossover / repair ─────────────────────────────────────────

function mutate(chr: Chromosome, ctx: PlannerCtx, rng: () => number): void {
  for (const [k, arr] of chr) {
    for (let i = 0; i < arr.length; i++) {
      if (rng() < MUTATION_RATE) {
        const eligible = ctx.eligibleBySlot.get(k) || [];
        if (eligible.length === 0) { arr[i] = null; continue; }
        const otherIdx = i === 0 ? 1 : 0;
        const otherId = arr[otherIdx];
        const tabooRoot = otherId ? (ctx.familyRoot.get(otherId) || otherId) : null;
        const remaining = eligible.filter(id => (ctx.familyRoot.get(id) || id) !== tabooRoot);
        if (remaining.length === 0) { arr[i] = null; continue; }
        if (rng() < 0.2) arr[i] = null;
        else arr[i] = remaining[Math.floor(rng() * remaining.length)];
      }
    }
  }
}

function crossover(a: Chromosome, b: Chromosome, ctx: PlannerCtx, rng: () => number): Chromosome {
  const child: Chromosome = new Map();
  for (const [k, arrA] of a) {
    const arrB = b.get(k) || [null, null];
    const childArr: (string | null)[] = [
      rng() < 0.5 ? arrA[0] : arrB[0],
      rng() < 0.5 ? arrA[1] : arrB[1],
    ];
    child.set(k, childArr);
  }
  repair(child, ctx);
  return child;
}

function repair(chr: Chromosome, ctx: PlannerCtx): void {
  for (const [k, arr] of chr) {
    const seen = new Set<string>();
    for (let i = 0; i < arr.length; i++) {
      const id = arr[i];
      if (!id) continue;
      const eligible = ctx.eligibleBySlot.get(k);
      if (!eligible || !eligible.includes(id)) { arr[i] = null; continue; }
      const root = ctx.familyRoot.get(id) || id;
      if (seen.has(root)) { arr[i] = null; continue; }
      seen.add(root);
    }
  }
}

function tournament(pop: Chromosome[], fitness: number[], rng: () => number): Chromosome {
  let bestIdx = Math.floor(rng() * pop.length);
  let bestFit = fitness[bestIdx];
  for (let i = 1; i < TOURNAMENT_SIZE; i++) {
    const idx = Math.floor(rng() * pop.length);
    if (fitness[idx] > bestFit) { bestFit = fitness[idx]; bestIdx = idx; }
  }
  return pop[bestIdx];
}

// ── Fitness scoring ───────────────────────────────────────────────────────
// Inlined for speed — calling rebuildPlanner+calcRequired inside the GA
// loop costs ~10x more than this self-contained scorer.

function getGuestsAt(ctx: PlannerCtx, loc: Location, date: string, meal: Meal): number {
  return ctx.guestsLookup[date]?.[loc]?.[meal] ?? 0;
}

function batchShareAtSlot(b: Batch, loc: Location, date: string, meal: Meal, ctx: PlannerCtx): number {
  const g = getGuestsAt(ctx, loc, date, meal);
  if (g <= 0) return 0;
  const liters = g * (b.serving || 280) / 1000;
  const families = new Set<string>();
  for (const other of ctx.allBatches) {
    if (other.type !== b.type) continue;
    if (!(other.services || []).some(s => s.loc === loc && s.date === date && s.meal === meal)) continue;
    families.add(ctx.familyRoot.get(other.id) || other.id);
  }
  return liters / Math.max(1, families.size);
}

function calcReq(b: Batch, ctx: PlannerCtx): number {
  let total = 0;
  for (const s of b.services || []) {
    total += batchShareAtSlot(b, s.loc, s.date, s.meal, ctx);
  }
  for (const c of ctx.caterings) {
    const cd = (c.dishes || []).find(d => d.dishId === b.id);
    if (cd) {
      const peers = (c.dishes || []).filter(d => d.type === b.type).length;
      total += ((c.guestCount || 0) / Math.max(peers, 1)) * ((b.serving || 280) / 1000);
    }
  }
  return Math.round(total * 100) / 100;
}

function fitnessScore(ctx: PlannerCtx): number {
  // Hard fails first — bail early if any
  for (const b of ctx.allBatches) {
    if (!TYPES_TO_PLAN.includes(b.type)) continue;
    for (const s of (b.services || [])) {
      if (s.date < ctx.todayIso) continue;
      const root = ctx.familyRoot.get(b.id) || b.id;
      let count = 0;
      for (const other of ctx.allBatches) {
        if (other.type !== b.type) continue;
        const otherRoot = ctx.familyRoot.get(other.id) || other.id;
        if (otherRoot !== root) continue;
        if ((other.services || []).some(os => os.date >= ctx.todayIso && os.loc === s.loc && os.date === s.date && os.meal === s.meal)) count++;
      }
      if (count > 1) return HARD_FAIL_FITNESS;
    }
  }
  for (const b of ctx.allBatches) {
    if (b.storage !== 'Frozen') continue;
    for (const s of (b.services || [])) {
      if (s.date >= ctx.todayIso && ctx.window.includes(s.date)) return HARD_FAIL_FITNESS;
    }
  }

  let slotsFilled = 0, missed = 0, leftover = 0, overCap = 0, staleL = 0, famV = 0, oldF = 0, variety = 0;
  let overcommitDeficitL = 0;

  for (const date of ctx.window) {
    if (date < ctx.todayIso) continue;
    for (const slot of SERVICE_SLOTS) {
      const guests = getGuestsAt(ctx, slot.loc, date, slot.meal);
      if (guests < 1) continue;
      for (const type of TYPES_TO_PLAN) {
        const filledFamilies = new Set<string>();
        for (const b of ctx.allBatches) {
          if (b.type !== type) continue;
          if (!(b.services || []).some(s => s.loc === slot.loc && s.date === date && s.meal === slot.meal)) continue;
          filledFamilies.add(ctx.familyRoot.get(b.id) || b.id);
        }
        const filled = filledFamilies.size;
        if (filled >= SLOTS_PER_TYPE) {
          slotsFilled++;
          if (filled >= 2) variety++;
        } else {
          // Missed match: any eligible same-type batch with surplus
          const has = ctx.allBatches.some(b => {
            if (b.type !== type) return false;
            if (b.storage === 'Frozen') return false;
            if (!b.cookDate) return false;
            const cookIso = cookDateToIso(b.cookDate);
            if (!cookIso) return false;
            if (cookIso > date) return false;
            if (cookIso === date && slot.meal === 'lunch') return false;
            if (b.stock > 0 && daysBetween(cookIso, date) >= STALE_THRESHOLD_DAYS) return false;
            const root = ctx.familyRoot.get(b.id) || b.id;
            if (filledFamilies.has(root)) return false;
            if (b.stock === 0) return true;
            const required = calcReq(b, ctx);
            return b.stock - required > 1;
          });
          if (has) missed++;
        }
      }
    }
  }

  // Leftover surplus
  for (const b of ctx.allBatches) {
    if (!TYPES_TO_PLAN.includes(b.type)) continue;
    if (b.stock <= 0) continue;
    if (b.storage === 'Frozen') continue;
    const cookIso = cookDateToIso(b.cookDate);
    if (!cookIso) continue;
    if (cookIso < ctx.todayIso) {
      const ageDays = daysBetween(cookIso, ctx.todayIso);
      if (ageDays > PLANNING_HORIZON_DAYS + STALE_THRESHOLD_DAYS) continue;
    }
    const required = calcReq(b, ctx);
    const surplus = b.stock - required;
    if (surplus > 1) leftover += surplus;
    // Over-commit: required exceeds stock — the batch is being asked to
    // serve more food than it has. Flag the deficit so the GA stops
    // filling slots by pushing batches into the red.
    else if (surplus < -1) overcommitDeficitL += -surplus;
  }

  // Over-cap (60%)
  for (const date of ctx.window) {
    if (date < ctx.todayIso) continue;
    for (const slot of SERVICE_SLOTS) {
      const guests = getGuestsAt(ctx, slot.loc, date, slot.meal);
      if (guests < 1) continue;
      for (const type of TYPES_TO_PLAN) {
        const here = ctx.allBatches.filter(b =>
          b.type === type && (b.services || []).some(s => s.loc === slot.loc && s.date === date && s.meal === slot.meal)
        );
        if (here.length === 0) continue;
        const totalLiters = guests * (here[0].serving || 280) / 1000;
        const cap = totalLiters * MAX_GUEST_FRACTION_PER_BATCH;
        for (const b of here) {
          const share = batchShareAtSlot(b, slot.loc, date, slot.meal, ctx);
          if (share > cap) { overCap++; break; }
        }
      }
    }
  }

  // Stale not assigned
  for (const b of ctx.allBatches) {
    if (!TYPES_TO_PLAN.includes(b.type)) continue;
    if (b.stock <= 0) continue;
    if (b.storage === 'Frozen') continue;
    const cookIso = cookDateToIso(b.cookDate);
    if (!cookIso) continue;
    const ageDays = daysBetween(cookIso, ctx.todayIso);
    if (ageDays < STALE_THRESHOLD_DAYS) continue;
    const required = calcReq(b, ctx);
    const surplus = b.stock - required;
    if (surplus > 1) staleL += surplus;
  }

  // Family budget
  const families = new Map<string, Batch[]>();
  for (const b of ctx.allBatches) {
    if (!TYPES_TO_PLAN.includes(b.type)) continue;
    const root = ctx.familyRoot.get(b.id) || b.id;
    const arr = families.get(root) || [];
    arr.push(b);
    families.set(root, arr);
  }
  for (const [, members] of families) {
    if (members.length < 2) continue;
    if (!members.every(m => m.stock > 0)) continue;
    const stock = members.reduce((s, m) => s + (m.stock || 0), 0);
    const demand = members.reduce((s, m) => s + calcReq(m, ctx), 0);
    if (demand > stock + 1) famV++;
  }

  // Oldest first
  for (const date of ctx.window) {
    if (date < ctx.todayIso) continue;
    for (const slot of SERVICE_SLOTS) {
      for (const type of TYPES_TO_PLAN) {
        const assignedCooked = ctx.allBatches.filter(b =>
          b.type === type && b.stock > 0
          && (b.services || []).some(s => s.loc === slot.loc && s.date === date && s.meal === slot.meal)
        );
        if (assignedCooked.length === 0) continue;
        const oldestAssigned = assignedCooked
          .map(b => cookDateToIso(b.cookDate))
          .filter((d): d is string => d !== null)
          .sort()[0];
        if (!oldestAssigned) continue;
        const olderUnassigned = ctx.allBatches.some(b => {
          if (b.type !== type || b.stock <= 0 || b.storage === 'Frozen') return false;
          const cookIso = cookDateToIso(b.cookDate);
          if (!cookIso || cookIso >= oldestAssigned) return false;
          if (assignedCooked.includes(b)) return false;
          const required = calcReq(b, ctx);
          return b.stock - required > 1;
        });
        if (!olderUnassigned) oldF++;
      }
    }
  }

  return Math.round(
    slotsFilled * W_SLOT + missed * W_MISS + leftover * W_LEFT + overCap * W_OVER
    + staleL * W_STALE + famV * W_FAM + oldF * W_OLD + variety * W_VAR
    + overcommitDeficitL * W_OVERCOMMIT
  );
}

// ── Public entry ───────────────────────────────────────────────────────────

export interface GaResult {
  improved: boolean;
  baseScore: number;
  bestScore: number;
  generations: number;
  durationMs: number;
}

/**
 * Refine the current S.batches future-slot assignments via a genetic algorithm.
 * Mutates S.batches in place. Returns stats. Caller should rebuildPlanner()
 * after this returns.
 *
 * Pre-conditions: 5-pass greedy has already run (so S.batches has placeholders
 * and a feasible warm-start assignment).
 */
export function refineWithGa(today: Date): GaResult {
  const startMs = Date.now();
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const window = buildWindow(todayIso);

  // Build guests lookup using the existing core.ts resolver.
  const guestsLookup: Record<string, Record<Location, Record<Meal, number>>> = {};
  for (const date of window) {
    guestsLookup[date] = {
      west: {
        lunch: getGuests('west', date, 'lunch'),
        dinner: getGuests('west', date, 'dinner'),
      },
      centraal: {
        lunch: getGuests('centraal', date, 'lunch'),
        dinner: getGuests('centraal', date, 'dinner'),
      },
    } as Record<Location, Record<Meal, number>>;
  }

  // Family roots from core.ts (handles parent-of-parent chains correctly).
  const familyRoot = new Map<string, string>();
  for (const b of S.batches) familyRoot.set(b.id, getRootId(b, S.batches));

  const futureSlots: SlotKey[] = [];
  for (const date of window) {
    if (date < todayIso) continue;
    for (const slot of SERVICE_SLOTS) {
      const guests = guestsLookup[date]?.[slot.loc]?.[slot.meal] ?? 0;
      if (guests < 1) continue;
      for (const type of TYPES_TO_PLAN) {
        futureSlots.push({ loc: slot.loc, meal: slot.meal, date, type });
      }
    }
  }

  if (futureSlots.length === 0) {
    return { improved: false, baseScore: 0, bestScore: 0, generations: 0, durationMs: Date.now() - startMs };
  }

  const byId = new Map<string, Batch>();
  for (const b of S.batches) byId.set(b.id, b);

  const eligibleBySlot = new Map<string, string[]>();
  for (const slot of futureSlots) {
    const k = slotKeyStr(slot);
    const ids: string[] = [];
    for (const b of S.batches) {
      if (isEligibleAtSlot(b, slot, todayIso)) ids.push(b.id);
    }
    eligibleBySlot.set(k, ids);
  }

  const ctx: PlannerCtx = {
    futureSlots,
    todayIso,
    guestsLookup,
    byId,
    eligibleBySlot,
    familyRoot,
    allBatches: S.batches,
    caterings: S.caterings || [],
    window,
  };

  // Snapshot the warm-start chromosome and its score BEFORE any GA mutation.
  const warmStart = encodeChromosomeFromBatches(ctx);
  const baseScore = fitnessScore(ctx);

  // Seed: deterministic per call (today + batch count)
  const rng = makeRng(hashString(`${todayIso}|${S.batches.length}`));

  // Build initial population — warm start + heavy-mutation perturbations + random
  const population: Chromosome[] = [warmStart];
  for (let i = 1; i < POP_SIZE; i++) {
    if (i < POP_SIZE / 2) {
      // Heavy-mutation copy of warm start (25% reroll per position)
      const c = cloneChromosome(warmStart);
      for (const [k, arr] of c) {
        for (let j = 0; j < arr.length; j++) {
          if (rng() < 0.25) {
            const eligible = eligibleBySlot.get(k) || [];
            if (eligible.length === 0) { arr[j] = null; continue; }
            const otherIdx = j === 0 ? 1 : 0;
            const otherId = arr[otherIdx];
            const tabooRoot = otherId ? (familyRoot.get(otherId) || otherId) : null;
            const remaining = eligible.filter(id => (familyRoot.get(id) || id) !== tabooRoot);
            if (remaining.length === 0) { arr[j] = null; continue; }
            arr[j] = remaining[Math.floor(rng() * remaining.length)];
          }
        }
      }
      repair(c, ctx);
      population.push(c);
    } else {
      population.push(randomInit(ctx, rng));
    }
  }

  const scoreOne = (chr: Chromosome): number => {
    decodeChromosomeToBatches(chr, ctx);
    return fitnessScore(ctx);
  };

  let fitness = population.map(scoreOne);
  let bestFitness = -Infinity;
  let bestChr: Chromosome | null = null;
  for (let i = 0; i < population.length; i++) {
    if (fitness[i] > bestFitness) {
      bestFitness = fitness[i];
      bestChr = cloneChromosome(population[i]);
    }
  }

  let stagnation = 0;
  let generations = 0;

  for (let gen = 0; gen < MAX_GENERATIONS; gen++) {
    generations++;
    if (Date.now() - startMs > TIME_BUDGET_MS) break;

    const sortedIdx = population.map((_, i) => i).sort((a, b) => fitness[b] - fitness[a]);
    const elites: Chromosome[] = [];
    for (let i = 0; i < ELITE_COUNT; i++) {
      elites.push(cloneChromosome(population[sortedIdx[i]]));
    }

    const newPop: Chromosome[] = [...elites];
    while (newPop.length < POP_SIZE) {
      const parentA = tournament(population, fitness, rng);
      const parentB = tournament(population, fitness, rng);
      const child = crossover(parentA, parentB, ctx, rng);
      mutate(child, ctx, rng);
      repair(child, ctx);
      newPop.push(child);
    }

    population.length = 0;
    for (const c of newPop) population.push(c);
    fitness = population.map(scoreOne);

    let improved = false;
    for (let i = 0; i < population.length; i++) {
      if (fitness[i] > bestFitness) {
        bestFitness = fitness[i];
        bestChr = cloneChromosome(population[i]);
        improved = true;
      }
    }
    if (improved) stagnation = 0;
    else stagnation++;
    if (stagnation >= STAGNATION_LIMIT) break;
  }

  // Always decode the BEST chromosome — never the last population's iteration.
  // Elitism guarantees bestChr.score >= warmStart.score, so we never regress.
  if (bestChr) decodeChromosomeToBatches(bestChr, ctx);
  else decodeChromosomeToBatches(warmStart, ctx);

  return {
    improved: bestFitness > baseScore,
    baseScore,
    bestScore: bestFitness,
    generations,
    durationMs: Date.now() - startMs,
  };
}
