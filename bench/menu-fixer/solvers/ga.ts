/**
 * Genetic Algorithm solver for Fix-My-Menu.
 *
 * Population-based search over future-service assignments. The chromosome is a
 * map from each (future-eligible) batch id to its sorted list of future
 * (loc, date, meal) service tuples. Past services are preserved verbatim.
 *
 * Initialization uses the baseline 5-pass output as a warm-start (1 chromosome)
 * plus 49 random valid perturbations. Each generation: tournament selection,
 * uniform crossover (per batch), low-rate mutation, elitism (top 5). Best
 * fitness is returned.
 *
 * Determinism: a fixture-name-hashed seed feeds a tiny LCG so reruns produce
 * the same plan.
 */

import type { SolverFn, SolverResult } from '../types';
import type { Batch, Location, Meal, DishType, Service } from '../../../shared/types';

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

// ── Tiny LCG seeded by fixture name ───────────────────────────────────────

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
    // 32-bit LCG (Numerical Recipes)
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

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

function dateToCookStr(d: Date): string {
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

function dateToDayName(iso: string): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return days[isoToDate(iso).getDay()];
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

function isServableBy(cookDateDdmmyyyy: string | null, slotIso: string, slotMeal: Meal, slotLoc: Location, batchLoc: Location): boolean {
  const cookIso = cookDateToIso(cookDateDdmmyyyy);
  if (!cookIso) return false;
  if (slotIso < cookIso) return false;
  if (slotLoc === 'west' && batchLoc === 'centraal') return false;
  if (slotLoc === 'centraal' && batchLoc === 'west') return slotIso > cookIso;
  if (slotIso > cookIso) return true;
  return slotMeal === 'dinner';
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

// ── Placeholder generation (mirrors menu-fixer.ts logic) ───────────────────

function generatePlaceholders(batches: Batch[], todayIso: string, rng: () => number): Batch[] {
  const window = buildWindow(todayIso);
  const newBatches: Batch[] = [];
  for (const iso of window) {
    const dayName = dateToDayName(iso);
    const rhythm = COOK_RHYTHM[dayName];
    if (!rhythm) continue;
    const date = isoToDate(iso);
    const cookStr = dateToCookStr(date);
    const ddmm = cookStr.split('/').slice(0, 2).join('/');
    for (const type of TYPES_TO_PLAN) {
      const target = type === 'Soup' ? rhythm.soup : rhythm.main;
      const existing = batches.filter(b => b.type === type && b.cookDate === cookStr).length;
      const gap = target - existing;
      if (gap <= 0) continue;
      for (let i = 0; i < gap; i++) {
        const typeLabel = type === 'Main course' ? 'main' : 'soup';
        const total = target;
        const indexSuffix = total > 1 ? ` ${existing + i + 1}` : '';
        const name = `${dayName} ${typeLabel}${indexSuffix} ${ddmm}`;
        const id = `bench-ga-${Math.floor(rng() * 1e12).toString(36)}-${i}-${type[0]}-${iso}`;
        newBatches.push({
          id,
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
          cookDate: cookStr,
          recipeSheetId: null,
          recipeVolume: null,
          recipeIngredients: null,
          note: '',
          services: [],
          createdAt: new Date(0).toISOString(),
          recipeId: null,
          actualIngredients: null,
          cookNotes: '',
          stockDeducted: false,
          generated: true,
        } as Batch);
      }
    }
  }
  return newBatches;
}

// ── Strip future + cleanup ─────────────────────────────────────────────────

function stripFuture(batches: Batch[], todayIso: string): void {
  for (const b of batches) {
    if (!b.services) { b.services = []; continue; }
    b.services = b.services.filter(s => s.date < todayIso);
  }
}

function removeOrphanPlaceholders(batches: Batch[]): Batch[] {
  return batches.filter(b => !(
    b.generated === true
    && (!b.services || b.services.length === 0)
    && !b.recipeId
    && !b.recipeSheetId
  ));
}

// ── Eligibility ────────────────────────────────────────────────────────────

interface SlotKey { loc: Location; date: string; meal: Meal; type: DishType }

function isEligibleAtSlot(b: Batch, slot: SlotKey, todayIso: string): boolean {
  if (b.type !== slot.type) return false;
  if (b.storage === 'Frozen') return false;
  if (slot.date < todayIso) return false;
  if (!isServableBy(b.cookDate, slot.date, slot.meal, slot.loc, b.location || 'west')) return false;
  // If cooked, must not be stale at slot
  if (b.stock > 0) {
    const cookIso = cookDateToIso(b.cookDate);
    if (!cookIso) return false;
    if (daysBetween(cookIso, slot.date) >= STALE_THRESHOLD_DAYS) return false;
  }
  return true;
}

// ── Chromosome representation ──────────────────────────────────────────────
// A chromosome is a Map<slotKeyString, batchId[]> — for each future slot we
// store up to SLOTS_PER_TYPE batch ids (or null entries for empty positions).
// Per-batch service entries are derived from this map at decode time.

type Chromosome = Map<string, (string | null)[]>;

function slotKey(slot: SlotKey): string {
  return `${slot.type}|${slot.loc}|${slot.date}|${slot.meal}`;
}

interface PlannerCtx {
  futureSlots: SlotKey[];
  todayIso: string;
  guestsLookup: Record<string, Record<Location, Record<Meal, number>>>;
  /** All batches keyed by id (for fast lookup during decode/score) */
  byId: Map<string, Batch>;
  /** Eligible batch ids per slot key (precomputed for speed) */
  eligibleBySlot: Map<string, string[]>;
  /** Family root id per batch id */
  familyRoot: Map<string, string>;
  /** All batches array (the actual mutable array we score against) */
  allBatches: Batch[];
}

// ── Encode warm-start from existing batch.services ─────────────────────────

function encodeChromosomeFromBatches(ctx: PlannerCtx): Chromosome {
  const chr: Chromosome = new Map();
  // Initialize with empties for every future slot
  for (const s of ctx.futureSlots) {
    chr.set(slotKey(s), [null, null]);
  }
  // For each batch, look at its future services and place into chromosome
  for (const b of ctx.allBatches) {
    if (!TYPES_TO_PLAN.includes(b.type)) continue;
    for (const svc of (b.services || [])) {
      if (svc.date < ctx.todayIso) continue;
      const k = slotKey({ type: b.type, loc: svc.loc as Location, date: svc.date, meal: svc.meal as Meal });
      const arr = chr.get(k);
      if (!arr) continue;
      // Avoid putting same family twice in same slot (hard-fail)
      const root = ctx.familyRoot.get(b.id) || b.id;
      let alreadyHas = false;
      for (const id of arr) {
        if (id && (ctx.familyRoot.get(id) || id) === root) { alreadyHas = true; break; }
      }
      if (alreadyHas) continue;
      // Place in first empty position
      for (let i = 0; i < arr.length; i++) {
        if (arr[i] === null) { arr[i] = b.id; break; }
      }
    }
  }
  return chr;
}

// ── Decode chromosome back into batch.services ─────────────────────────────

function decodeChromosomeToBatches(chr: Chromosome, ctx: PlannerCtx): void {
  // First, strip all future services from every batch
  for (const b of ctx.allBatches) {
    if (!b.services) { b.services = []; continue; }
    b.services = b.services.filter(s => s.date < ctx.todayIso);
  }
  // Now, for each chromosome entry, write services back
  for (const [k, arr] of chr) {
    const [type, loc, date, meal] = k.split('|') as [DishType, Location, string, Meal];
    for (const id of arr) {
      if (!id) continue;
      const b = ctx.byId.get(id);
      if (!b) continue;
      if (!b.services) b.services = [];
      // Skip if already there
      const exists = b.services.some(s => s.loc === loc && s.date === date && s.meal === meal);
      if (!exists) b.services.push({ loc, date, meal } as Service);
    }
  }
}

// ── Random initialization ──────────────────────────────────────────────────

function randomInit(ctx: PlannerCtx, rng: () => number): Chromosome {
  const chr: Chromosome = new Map();
  for (const slot of ctx.futureSlots) {
    const k = slotKey(slot);
    const eligible = ctx.eligibleBySlot.get(k) || [];
    // Pick up to 2 distinct families
    const used: string[] = [null!, null!];
    if (eligible.length > 0) {
      const usedFamilies = new Set<string>();
      for (let i = 0; i < SLOTS_PER_TYPE; i++) {
        // Filter eligibles whose family isn't taken
        const remaining = eligible.filter(id => {
          const root = ctx.familyRoot.get(id) || id;
          return !usedFamilies.has(root);
        });
        if (remaining.length === 0) { used[i] = null; continue; }
        // Random pick: nullable = 30% empty, 70% pick one
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

// ── Mutation ───────────────────────────────────────────────────────────────

function mutate(chr: Chromosome, ctx: PlannerCtx, rng: () => number): void {
  for (const [k, arr] of chr) {
    for (let i = 0; i < arr.length; i++) {
      if (rng() < MUTATION_RATE) {
        const eligible = ctx.eligibleBySlot.get(k) || [];
        if (eligible.length === 0) { arr[i] = null; continue; }
        // Set the OTHER position's family as taboo
        const otherIdx = i === 0 ? 1 : 0;
        const otherId = arr[otherIdx];
        const tabooRoot = otherId ? (ctx.familyRoot.get(otherId) || otherId) : null;
        const remaining = eligible.filter(id => (ctx.familyRoot.get(id) || id) !== tabooRoot);
        if (remaining.length === 0) { arr[i] = null; continue; }
        // 20% null, 80% random pick
        if (rng() < 0.2) { arr[i] = null; }
        else { arr[i] = remaining[Math.floor(rng() * remaining.length)]; }
      }
    }
  }
}

// ── Crossover ──────────────────────────────────────────────────────────────

function crossover(a: Chromosome, b: Chromosome, ctx: PlannerCtx, rng: () => number): Chromosome {
  const child: Chromosome = new Map();
  for (const [k, arrA] of a) {
    const arrB = b.get(k) || [null, null];
    const childArr: (string | null)[] = [null, null];
    // Uniform per-position
    for (let i = 0; i < SLOTS_PER_TYPE; i++) {
      childArr[i] = rng() < 0.5 ? arrA[i] : arrB[i];
    }
    child.set(k, childArr);
  }
  // Repair: dedupe by family within each slot
  repair(child, ctx);
  return child;
}

function repair(chr: Chromosome, ctx: PlannerCtx): void {
  for (const [k, arr] of chr) {
    const seenFamilies = new Set<string>();
    for (let i = 0; i < arr.length; i++) {
      const id = arr[i];
      if (!id) continue;
      // Validate batch is still eligible (defensive — should always be)
      const eligible = ctx.eligibleBySlot.get(k);
      if (!eligible || !eligible.includes(id)) { arr[i] = null; continue; }
      const root = ctx.familyRoot.get(id) || id;
      if (seenFamilies.has(root)) { arr[i] = null; continue; }
      seenFamilies.add(root);
    }
  }
}

// ── Tournament selection ───────────────────────────────────────────────────

function tournament(pop: Chromosome[], fitness: number[], rng: () => number): Chromosome {
  let bestIdx = Math.floor(rng() * pop.length);
  let bestFit = fitness[bestIdx];
  for (let i = 1; i < TOURNAMENT_SIZE; i++) {
    const idx = Math.floor(rng() * pop.length);
    if (fitness[idx] > bestFit) { bestFit = fitness[idx]; bestIdx = idx; }
  }
  return pop[bestIdx];
}

function cloneChromosome(chr: Chromosome): Chromosome {
  const copy: Chromosome = new Map();
  for (const [k, arr] of chr) copy.set(k, arr.slice());
  return copy;
}

// ── Fast scoring (inline reproduction of score.ts; pure & no DOM) ──────────

interface ScoreCtx extends PlannerCtx {
  caterings: any[];
  window: string[];
}

function getGuests(ctx: ScoreCtx, loc: Location, date: string, meal: Meal): number {
  const day = ctx.guestsLookup[date];
  if (!day) return 0;
  const locData = day[loc];
  if (!locData) return 0;
  return locData[meal] ?? 0;
}

function batchShareAtSlot(b: Batch, loc: Location, date: string, meal: Meal, ctx: ScoreCtx): number {
  const g = getGuests(ctx, loc, date, meal);
  if (g <= 0) return 0;
  const liters = g * (b.serving || 280) / 1000;
  const families = new Set<string>();
  for (const other of ctx.allBatches) {
    if (other.type !== b.type) continue;
    if (!(other.services || []).some(s => s.loc === loc && s.date === date && s.meal === meal)) continue;
    families.add(ctx.familyRoot.get(other.id) || other.id);
  }
  const peerCount = Math.max(1, families.size);
  return liters / peerCount;
}

function calcReq(b: Batch, ctx: ScoreCtx): number {
  let total = 0;
  for (const s of b.services || []) {
    total += batchShareAtSlot(b, s.loc as Location, s.date, s.meal as Meal, ctx);
  }
  for (const c of ctx.caterings) {
    const cd = (c.dishes || []).find((d: any) => d.dishId === b.id);
    if (cd) {
      const peers = (c.dishes || []).filter((d: any) => d.type === b.type).length;
      total += ((c.guestCount || 0) / Math.max(peers, 1)) * ((b.serving || 280) / 1000);
    }
  }
  return Math.round(total * 100) / 100;
}

function fitnessScore(ctx: ScoreCtx): number {
  const W_SLOT = 1000, W_MISS = -500, W_LEFT = -300, W_OVER = -100, W_STALE = -50, W_FAM = -20, W_OLD = 10, W_VAR = 2;
  // Over-commit penalty (matches bench/menu-fixer/score.ts and
  // public/js/menu-fixer-ga.ts). Stops the GA from filling slots by
  // pushing batches into a deficit (prod feedback 2026-05-07: -40L
  // overcommits were happening; threshold is "leave empty + warning").
  const W_OVERCOMMIT = -200;
  let total = 0;
  let slotsFilled = 0, missed = 0, leftover = 0, overCap = 0, staleL = 0, famV = 0, oldF = 0, variety = 0;
  let overcommitDeficitL = 0;

  // Hard fails first
  // 1. In-slot family duplicate (only future)
  for (const b of ctx.allBatches) {
    if (!TYPES_TO_PLAN.includes(b.type)) continue;
    for (const s of (b.services || [])) {
      if (s.date < ctx.todayIso) continue;
      // Count family in this slot for this type
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
  // 2. Frozen auto-assigned
  for (const b of ctx.allBatches) {
    if (b.storage !== 'Frozen') continue;
    for (const s of (b.services || [])) {
      if (s.date >= ctx.todayIso && ctx.window.includes(s.date)) return HARD_FAIL_FITNESS;
    }
  }

  // Slot fill, missed, variety
  for (const date of ctx.window) {
    if (date < ctx.todayIso) continue;
    for (const slot of SERVICE_SLOTS) {
      const guests = getGuests(ctx, slot.loc, date, slot.meal);
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
        }
        if (filled < SLOTS_PER_TYPE) {
          // Missed match: any eligible same-type batch with surplus capacity
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
    else if (surplus < -1) overcommitDeficitL += -surplus;
  }

  // Over-cap (60% of slot)
  const MAX_FRACTION = 0.6;
  for (const date of ctx.window) {
    if (date < ctx.todayIso) continue;
    for (const slot of SERVICE_SLOTS) {
      const guests = getGuests(ctx, slot.loc, date, slot.meal);
      if (guests < 1) continue;
      for (const type of TYPES_TO_PLAN) {
        const here = ctx.allBatches.filter(b =>
          b.type === type
          && (b.services || []).some(s => s.loc === slot.loc && s.date === date && s.meal === slot.meal)
        );
        if (here.length === 0) continue;
        const totalLiters = guests * (here[0].serving || 280) / 1000;
        const cap = totalLiters * MAX_FRACTION;
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
    const allCooked = members.every(m => m.stock > 0);
    if (!allCooked) continue;
    const stock = members.reduce((s, m) => s + (m.stock || 0), 0);
    const demand = members.reduce((s, m) => s + calcReq(m, ctx), 0);
    if (demand > stock + 1) famV++;
  }

  // Oldest first bonus
  for (const date of ctx.window) {
    if (date < ctx.todayIso) continue;
    for (const slot of SERVICE_SLOTS) {
      for (const type of TYPES_TO_PLAN) {
        const assignedCooked = ctx.allBatches.filter(b =>
          b.type === type
          && b.stock > 0
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

  total = slotsFilled * W_SLOT + missed * W_MISS + leftover * W_LEFT + overCap * W_OVER
    + staleL * W_STALE + famV * W_FAM + oldF * W_OLD + variety * W_VAR
    + overcommitDeficitL * W_OVERCOMMIT;
  return Math.round(total);
}

// ── Run baseline 5-pass for warm-start ─────────────────────────────────────

function runBaseline(fixture: any, batches: Batch[]): Batch[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sandbox = require('../sandbox');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { rebuildPlanner, consolidateFamilies, calcRequired, getGuests: getGuestsCore } = require('../../../public/js/core');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const menuFixer = require('../../../public/js/menu-fixer');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { S } = require('../../../public/js/state');

  sandbox.mockToday(fixture.today);
  S.batches = batches;
  S.caterings = JSON.parse(JSON.stringify(fixture.caterings));
  S.guests = JSON.parse(JSON.stringify(fixture.guestsBase));
  S.guestsNextWeeks = JSON.parse(JSON.stringify(fixture.guestsNextWeeks));
  S.predictions = JSON.parse(JSON.stringify(fixture.guestsPredictions));
  S.kitchenEquipment = JSON.parse(JSON.stringify(fixture.kitchenEquipment));
  S.storageConfig = JSON.parse(JSON.stringify(fixture.storageConfig));
  S.deletedBatches = [];
  S.transportItems = [];
  S.recipes = [];
  S.ingredientDb = [];
  S.planner = {};
  rebuildPlanner();

  try {
    const consolidation = consolidateFamilies(S.batches);
    if (consolidation.removed.length > 0) S.batches = consolidation.kept;
    menuFixer.stripFutureServices(S.batches);
    const orphans = menuFixer.findOrphanPlaceholders(S.batches);
    if (orphans.length > 0) {
      const ids = new Set(orphans.map((b: Batch) => b.id));
      S.batches = S.batches.filter((b: Batch) => !ids.has(b.id));
    }
    const planWindow = menuFixer.buildPlanningWindow(new Date(fixture.today + 'T08:00:00'));
    const snapshot = menuFixer.snapshotBatches(S.batches, planWindow);
    const newPlaceholders = menuFixer.generateMissingPlaceholders(planWindow, snapshot);
    for (const b of newPlaceholders) S.batches.push(b);
    rebuildPlanner();
    const calcReqLive = (b: Batch): number => { rebuildPlanner(); return calcRequired(b); };
    const biggestPot = S.kitchenEquipment && S.kitchenEquipment.pots.length > 0
      ? Math.max(...S.kitchenEquipment.pots) : undefined;
    menuFixer.assignServicesPass1(S.batches, planWindow, calcReqLive, getGuestsCore);
    rebuildPlanner();
    menuFixer.assignServicesPass2(S.batches, planWindow, calcReqLive, getGuestsCore, biggestPot);
    rebuildPlanner();
    menuFixer.assignServicesPass3(S.batches, planWindow, calcReqLive, getGuestsCore, biggestPot);
    rebuildPlanner();
    menuFixer.assignServicesPass4(S.batches, planWindow, calcReqLive, getGuestsCore);
    rebuildPlanner();
    menuFixer.assignServicesPass5(S.batches, planWindow, calcReqLive, getGuestsCore);
    rebuildPlanner();
    return S.batches;
  } finally {
    sandbox.uninstallFixture();
  }
}

// ── Main solver entry ──────────────────────────────────────────────────────

export const ga: SolverFn = (input): SolverResult => {
  const RealDate = Date;
  const start = RealDate.now();
  const { fixture } = input;

  // Setup deterministic RNG
  const rng = makeRng(hashString(fixture.name));

  // Step 1: warm-start via baseline (which generates placeholders & assigns services)
  // We pass our cloned batches; baseline mutates them in place.
  const warmBatches: Batch[] = JSON.parse(JSON.stringify(input.batches));
  let allBatches: Batch[];
  try {
    allBatches = runBaseline(fixture, warmBatches);
  } catch (e: unknown) {
    // Fallback: just generate placeholders ourselves and start from empty future
    const fresh = JSON.parse(JSON.stringify(input.batches)) as Batch[];
    stripFuture(fresh, fixture.today);
    const cleaned = removeOrphanPlaceholders(fresh);
    const placeholders = generatePlaceholders(cleaned, fixture.today, rng);
    allBatches = [...cleaned, ...placeholders];
  }

  // Step 2: build planner context once (read-only structures)
  const todayIso = fixture.today;
  const window = buildWindow(todayIso);

  // Build family roots (parent or self)
  const familyRoot = new Map<string, string>();
  for (const b of allBatches) {
    familyRoot.set(b.id, b.parentId || b.id);
  }

  // Compute future slots (only those with guests >= 1)
  const futureSlots: SlotKey[] = [];
  const guestsLookup = fixture.guestsLookup;
  for (const date of window) {
    if (date < todayIso) continue;
    for (const slot of SERVICE_SLOTS) {
      const day = guestsLookup[date];
      const locData = day && day[slot.loc];
      const guests = locData ? (locData[slot.meal] ?? 0) : 0;
      if (guests < 1) continue;
      for (const type of TYPES_TO_PLAN) {
        futureSlots.push({ loc: slot.loc, meal: slot.meal, date, type });
      }
    }
  }

  // Index batches by id
  const byId = new Map<string, Batch>();
  for (const b of allBatches) byId.set(b.id, b);

  // Precompute eligible batch ids per slot
  const eligibleBySlot = new Map<string, string[]>();
  for (const slot of futureSlots) {
    const k = slotKey(slot);
    const ids: string[] = [];
    for (const b of allBatches) {
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
    allBatches,
  };
  const scoreCtx: ScoreCtx = {
    ...ctx,
    caterings: fixture.caterings,
    window,
  };

  // Helper: score a chromosome by writing to allBatches.services and running fitness
  const scoreChromosome = (chr: Chromosome): number => {
    decodeChromosomeToBatches(chr, ctx);
    return fitnessScore(scoreCtx);
  };

  // Step 3: build initial population
  const population: Chromosome[] = [];
  population.push(encodeChromosomeFromBatches(ctx)); // warm start
  for (let i = 1; i < POP_SIZE; i++) {
    // Half are random, half are warm-start with mutations
    if (i < POP_SIZE / 2) {
      const c = cloneChromosome(population[0]);
      // Heavy mutation pass (5x normal rate)
      for (const [k, arr] of c) {
        for (let j = 0; j < arr.length; j++) {
          if (rng() < 0.25) {
            const eligible = ctx.eligibleBySlot.get(k) || [];
            if (eligible.length === 0) { arr[j] = null; continue; }
            const otherIdx = j === 0 ? 1 : 0;
            const otherId = arr[otherIdx];
            const tabooRoot = otherId ? (ctx.familyRoot.get(otherId) || otherId) : null;
            const remaining = eligible.filter(id => (ctx.familyRoot.get(id) || id) !== tabooRoot);
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

  // Score initial population
  let fitness = population.map(c => scoreChromosome(c));

  // Track best
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

  // Step 4: GA loop
  for (let gen = 0; gen < MAX_GENERATIONS; gen++) {
    generations++;
    // Time check
    if (RealDate.now() - start > TIME_BUDGET_MS) break;

    // Sort population by fitness desc and pick elites
    const sortedIdx = population.map((_, i) => i).sort((a, b) => fitness[b] - fitness[a]);
    const elites: Chromosome[] = [];
    for (let i = 0; i < ELITE_COUNT; i++) {
      elites.push(cloneChromosome(population[sortedIdx[i]]));
    }

    // Build new population
    const newPop: Chromosome[] = [...elites];
    while (newPop.length < POP_SIZE) {
      const parentA = tournament(population, fitness, rng);
      const parentB = tournament(population, fitness, rng);
      const child = crossover(parentA, parentB, ctx, rng);
      mutate(child, ctx, rng);
      repair(child, ctx);
      newPop.push(child);
    }

    // Score new population
    population.length = 0;
    for (const c of newPop) population.push(c);
    fitness = population.map(c => scoreChromosome(c));

    // Update best
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

  // Step 5: write best chromosome to allBatches
  if (bestChr) decodeChromosomeToBatches(bestChr, ctx);

  return {
    batches: allBatches,
    durationMs: RealDate.now() - start,
    stats: {
      generations,
      finalFitness: bestFitness,
      populationSize: POP_SIZE,
      futureSlots: futureSlots.length,
    },
  };
};
