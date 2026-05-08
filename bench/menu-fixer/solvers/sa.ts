/**
 * sa.ts — Simulated Annealing solver.
 *
 * Warm-starts from the baseline 5-pass greedy, then performs SA moves:
 *   - swap   : exchange two services (same type) between batches
 *   - move   : relocate one service to a different empty position
 *   - add    : add a new service to an empty position
 *   - remove : drop a service from a batch
 *
 * Acceptance: improving moves always; worsening moves with prob exp(-Δ/T).
 * Cooling: T0 = 5000, geometric decay (0.995/step), ~3500 steps total.
 *
 * Time-boxed at 5s/fixture. Tracks best-ever-seen state and returns that.
 *
 * Validity (rejected moves don't count toward step budget):
 *   - no in-slot duplicate (same family at one future slot)
 *   - no frozen batch in future window
 *   - no past slots touched
 *   - servable (cookDate ≤ slotDate, location flow rules)
 *   - stock check: cooked batches' family demand ≤ family stock
 */

import type { SolverFn, SolverResult, Fixture } from '../types';
import type { Batch, Service, Location, Meal, DishType } from '../../../shared/types';
import { scoreSolution } from '../score';

// ── Constants ────────────────────────────────────────────────────────────────

const TYPES_TO_PLAN: DishType[] = ['Soup', 'Main course'];
const SLOTS_PER_TYPE = 2;
const PLANNING_HORIZON_DAYS = 10;
const STALE_THRESHOLD_DAYS = 3;
const MAX_GUESTS_FRACTION = 0.6;

const T0 = 5000;
const T_COOL = 0.997;
const MAX_STEPS = 5000;
const TIME_BUDGET_MS = 4500;
const RNG_SEED = 0xc0ffee;

const SERVICE_SLOTS: { loc: Location; meal: Meal }[] = [
  { loc: 'centraal', meal: 'lunch' },
  { loc: 'centraal', meal: 'dinner' },
  { loc: 'west', meal: 'lunch' },
  { loc: 'west', meal: 'dinner' },
];

// Cook rhythm — used to generate placeholders for missing cook events.
const COOK_RHYTHM: Record<string, { soup: number; main: number }> = {
  Sun: { soup: 3, main: 3 },
  Mon: { soup: 0, main: 1 },
  Tue: { soup: 1, main: 1 },
  Wed: { soup: 1, main: 1 },
  Thu: { soup: 1, main: 1 },
  Fri: { soup: 1, main: 1 },
  Sat: { soup: 1, main: 1 },
};

// ── Deterministic RNG ────────────────────────────────────────────────────────

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// ── Date helpers ─────────────────────────────────────────────────────────────

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

function dateToStr(d: Date): string {
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

function dateToDayName(iso: string): string {
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return names[isoToDate(iso).getDay()];
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

// ── Eligibility helpers ──────────────────────────────────────────────────────

function getRoot(b: Batch): string {
  return b.parentId || b.id;
}

function isServableBy(
  cookDateDdmm: string | null,
  slotIso: string,
  slotMeal: Meal,
  slotLoc: Location,
  batchLoc: Location,
): boolean {
  const cookIso = cookDateToIso(cookDateDdmm);
  if (!cookIso) return false;
  if (slotIso < cookIso) return false;
  if (slotLoc === 'west' && batchLoc === 'centraal') return false;
  if (slotLoc === 'centraal' && batchLoc === 'west') return slotIso > cookIso;
  if (slotIso > cookIso) return true;
  return slotMeal === 'dinner';
}

function isStaleAtSlot(cookDateDdmm: string | null, slotIso: string, threshold = STALE_THRESHOLD_DAYS): boolean {
  const cookIso = cookDateToIso(cookDateDdmm);
  if (!cookIso) return false;
  return daysBetween(cookIso, slotIso) >= threshold;
}

// ── Placeholder generation ───────────────────────────────────────────────────

function buildPlaceholder(
  cookDateStr: string,
  isoDate: string,
  dayName: string,
  type: DishType,
  index: number,
  total: number,
  idCounter: { n: number },
): Batch {
  const typeLabel = type === 'Main course' ? 'main' : 'soup';
  const indexSuffix = total > 1 ? ` ${index}` : '';
  const ddmm = cookDateStr.split('/').slice(0, 2).join('/');
  return {
    id: `bench-sa-${idCounter.n++}`,
    name: `${dayName} ${typeLabel}${indexSuffix} ${ddmm}`,
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
    createdAt: new Date(isoDate + 'T08:00:00').toISOString(),
    recipeId: null,
    actualIngredients: null,
    cookNotes: '',
    stockDeducted: false,
    generated: true,
  };
}

function generatePlaceholders(batches: Batch[], todayIso: string, idCounter: { n: number }): Batch[] {
  const window = buildWindow(todayIso);
  const newBatches: Batch[] = [];
  // Count existing per cookDate per type
  const existingByDate = new Map<string, { Soup: number; 'Main course': number }>();
  for (const b of batches) {
    if (!TYPES_TO_PLAN.includes(b.type)) continue;
    if (!b.cookDate) continue;
    if (!existingByDate.has(b.cookDate)) {
      existingByDate.set(b.cookDate, { Soup: 0, 'Main course': 0 });
    }
    existingByDate.get(b.cookDate)![b.type as 'Soup' | 'Main course']++;
  }
  for (const iso of window) {
    const d = isoToDate(iso);
    const dayName = dateToDayName(iso);
    const cookDateStr = dateToStr(d);
    const rhythm = COOK_RHYTHM[dayName];
    if (!rhythm) continue;
    const existing = existingByDate.get(cookDateStr) || { Soup: 0, 'Main course': 0 };
    for (const type of TYPES_TO_PLAN) {
      const target = type === 'Soup' ? rhythm.soup : rhythm.main;
      const have = existing[type as 'Soup' | 'Main course'];
      const gap = target - have;
      if (gap <= 0) continue;
      for (let i = 0; i < gap; i++) {
        newBatches.push(buildPlaceholder(cookDateStr, iso, dayName, type, have + i + 1, target, idCounter));
      }
    }
  }
  return newBatches;
}

// ── Initial greedy assignment (baseline-like warm start) ─────────────────────

interface SlotKey {
  type: DishType;
  loc: Location;
  date: string;
  meal: Meal;
}

function slotKeyToString(k: SlotKey): string {
  return `${k.type}|${k.loc}|${k.date}|${k.meal}`;
}

function isPastSlot(date: string, todayIso: string, meal: Meal): boolean {
  if (date < todayIso) return true;
  return false;
}

function getGuests(fixture: Fixture, loc: Location, date: string, meal: Meal): number {
  const day = fixture.guestsLookup[date];
  if (!day) return 0;
  return day[loc]?.[meal] ?? 0;
}

/**
 * Quick greedy initial assignment: for each future slot, fill SLOTS_PER_TYPE
 * positions with eligible batches preferring (1) cooked-with-stock, (2) oldest
 * cookDate, (3) same-loc.
 *
 * This matches the spirit of the baseline 5-pass solver but is much faster.
 * The SA loop will improve it from here.
 */
function buildInitialSolution(
  batches: Batch[],
  fixture: Fixture,
): void {
  // Strip future services first.
  const todayIso = fixture.today;
  for (const b of batches) {
    b.services = (b.services || []).filter(s => s.date < todayIso);
  }

  const window = buildWindow(todayIso);

  // Walk slots oldest-first; greedy pick best-fitting batch.
  for (const date of window) {
    if (date < todayIso) continue;
    for (const slot of SERVICE_SLOTS) {
      const guests = getGuests(fixture, slot.loc, date, slot.meal);
      if (guests <= 0) continue;
      for (const type of TYPES_TO_PLAN) {
        let attempts = 0;
        while (attempts++ < SLOTS_PER_TYPE * 2) {
          const filled = countFamiliesAtSlot(batches, type, slot.loc, date, slot.meal);
          if (filled >= SLOTS_PER_TYPE) break;
          // Build candidates
          const candidates = batches.filter(b => isEligibleForSlot(b, type, slot.loc, date, slot.meal, batches, fixture));
          if (candidates.length === 0) break;
          // Pick: oldest cookDate first, cooked > uncooked, same-loc
          candidates.sort((a, b) => {
            const aCk = cookDateToIso(a.cookDate)!;
            const bCk = cookDateToIso(b.cookDate)!;
            if (aCk !== bCk) return aCk.localeCompare(bCk);
            const aCooked = a.stock > 0 ? 1 : 0;
            const bCooked = b.stock > 0 ? 1 : 0;
            if (aCooked !== bCooked) return bCooked - aCooked;
            const aSame = a.location === slot.loc ? 1 : 0;
            const bSame = b.location === slot.loc ? 1 : 0;
            if (aSame !== bSame) return bSame - aSame;
            return (b.stock || 0) - (a.stock || 0);
          });
          const chosen = candidates[0];
          // Tentatively add and check family stock
          chosen.services.push({ loc: slot.loc, date, meal: slot.meal });
          if (!familyStockOk(chosen, batches, fixture)) {
            chosen.services.pop();
            // Drop and retry without this candidate via filter on next loop
            // (mark via a pseudo-filter: temporarily set storage to skip would be ugly; instead break)
            break;
          }
        }
      }
    }
  }
}

// ── Validity helpers ─────────────────────────────────────────────────────────

function countFamiliesAtSlot(batches: Batch[], type: DishType, loc: Location, date: string, meal: Meal): number {
  const fams = new Set<string>();
  for (const b of batches) {
    if (b.type !== type) continue;
    if (!(b.services || []).some(s => s.loc === loc && s.date === date && s.meal === meal)) continue;
    fams.add(getRoot(b));
  }
  return fams.size;
}

function familyAlreadyAtSlot(batch: Batch, batches: Batch[], loc: Location, date: string, meal: Meal): boolean {
  const root = getRoot(batch);
  for (const b of batches) {
    if (getRoot(b) !== root) continue;
    if ((b.services || []).some(s => s.loc === loc && s.date === date && s.meal === meal)) return true;
  }
  return false;
}

function isEligibleForSlot(
  batch: Batch,
  type: DishType,
  loc: Location,
  date: string,
  meal: Meal,
  batches: Batch[],
  fixture: Fixture,
): boolean {
  if (batch.type !== type) return false;
  if (batch.storage === 'Frozen') return false;
  if (!batch.cookDate) return false;
  if (!isServableBy(batch.cookDate, date, meal, loc, batch.location)) return false;
  if (batch.stock > 0 && isStaleAtSlot(batch.cookDate, date)) return false;
  if (familyAlreadyAtSlot(batch, batches, loc, date, meal)) return false;
  if (countFamiliesAtSlot(batches, type, loc, date, meal) >= SLOTS_PER_TYPE) return false;
  if (date < fixture.today) return false;
  if (getGuests(fixture, loc, date, meal) <= 0) return false;
  return true;
}

/**
 * Approximate family-stock validity: total family demand ≤ total family stock.
 * (Used by initial greedy AND validity check on SA moves.)
 *
 * Demand estimate: each future service consumes guests/peers * serving liters.
 */
function familyStockOk(_batch: Batch, batches: Batch[], fixture: Fixture): boolean {
  // Build family list per root, only check the impacted root.
  const root = getRoot(_batch);
  const family = batches.filter(b => getRoot(b) === root);
  // If any uncooked member, family stock is "plan capacity" — accept.
  if (family.some(b => b.stock <= 0)) return true;
  const stock = family.reduce((s, b) => s + (b.stock || 0), 0);
  // Compute total family demand
  let demand = 0;
  for (const b of family) {
    for (const s of b.services || []) {
      const g = getGuests(fixture, s.loc, s.date, s.meal);
      if (g <= 0) continue;
      // peer count at this slot
      let peers = 0;
      for (const other of batches) {
        if (other.type !== b.type) continue;
        if ((other.services || []).some(x => x.loc === s.loc && x.date === s.date && x.meal === s.meal)) peers++;
      }
      const liters = g * (b.serving || 280) / 1000;
      demand += liters / Math.max(peers, 1);
    }
  }
  return demand <= stock + 1; // small tolerance
}

// ── Hard-fail check (must match scorer) ──────────────────────────────────────

function hasHardFail(batches: Batch[], todayIso: string): boolean {
  // 1) In-slot duplicates (future)
  const slotFams = new Map<string, Map<string, number>>();
  for (const b of batches) {
    if (!TYPES_TO_PLAN.includes(b.type)) continue;
    const fam = getRoot(b);
    for (const s of b.services || []) {
      if (s.date < todayIso) continue;
      const key = `${b.type}|${s.loc}|${s.date}|${s.meal}`;
      const inner = slotFams.get(key) || new Map();
      inner.set(fam, (inner.get(fam) || 0) + 1);
      slotFams.set(key, inner);
    }
  }
  for (const [, inner] of slotFams) {
    for (const [, count] of inner) {
      if (count > 1) return true;
    }
  }
  // 2) Frozen in future window
  const window = new Set(buildWindow(todayIso));
  for (const b of batches) {
    if (b.storage !== 'Frozen') continue;
    for (const s of b.services || []) {
      if (s.date >= todayIso && window.has(s.date)) return true;
    }
  }
  return false;
}

// ── Move generators ──────────────────────────────────────────────────────────

interface ServiceRef {
  batchIdx: number; // index into batches[]
  serviceIdx: number; // index into batches[batchIdx].services
}

function listFutureServices(batches: Batch[], todayIso: string): ServiceRef[] {
  const refs: ServiceRef[] = [];
  for (let i = 0; i < batches.length; i++) {
    const b = batches[i];
    if (!TYPES_TO_PLAN.includes(b.type)) continue;
    const services = b.services || [];
    for (let j = 0; j < services.length; j++) {
      if (services[j].date >= todayIso) refs.push({ batchIdx: i, serviceIdx: j });
    }
  }
  return refs;
}

function listEmptyPositions(
  batches: Batch[],
  fixture: Fixture,
): SlotKey[] {
  const empty: SlotKey[] = [];
  const window = buildWindow(fixture.today);
  for (const date of window) {
    if (date < fixture.today) continue;
    for (const slot of SERVICE_SLOTS) {
      if (getGuests(fixture, slot.loc, date, slot.meal) <= 0) continue;
      for (const type of TYPES_TO_PLAN) {
        const filled = countFamiliesAtSlot(batches, type, slot.loc, date, slot.meal);
        if (filled < SLOTS_PER_TYPE) {
          empty.push({ type, loc: slot.loc, date, meal: slot.meal });
        }
      }
    }
  }
  return empty;
}

// ── Move execution (with rollback) ───────────────────────────────────────────

interface MoveOp {
  apply: () => boolean; // returns true if move was successfully applied
  undo: () => void;
}

function tryAdd(batches: Batch[], rng: () => number, fixture: Fixture): MoveOp | null {
  // Bias 60% toward slots that already have surplus-rich batches eligible for them
  // to drain leftover stock.
  const empty = listEmptyPositions(batches, fixture);
  if (empty.length === 0) return null;
  const slot = empty[Math.floor(rng() * empty.length)];
  // Find eligible batches for this slot (sample some)
  const candidates: number[] = [];
  for (let i = 0; i < batches.length; i++) {
    const b = batches[i];
    if (isEligibleForSlot(b, slot.type, slot.loc, slot.date, slot.meal, batches, fixture)) {
      candidates.push(i);
    }
  }
  if (candidates.length === 0) return null;
  // Bias toward cooked batches with more surplus stock (they drain better).
  let idx = candidates[Math.floor(rng() * candidates.length)];
  if (rng() < 0.7 && candidates.length > 1) {
    // Pick the candidate with most "spare" stock relative to current commitments.
    let bestIdx = candidates[0];
    let bestSlack = -Infinity;
    for (const ci of candidates) {
      const b = batches[ci];
      if (b.stock <= 0) continue;
      const family = batches.filter(x => getRoot(x) === getRoot(b));
      const fStock = family.reduce((s, m) => s + (m.stock || 0), 0);
      const fDemand = family.reduce((s, m) => s + (m.services || []).length * 5, 0); // rough
      const slack = fStock - fDemand;
      if (slack > bestSlack) {
        bestSlack = slack;
        bestIdx = ci;
      }
    }
    idx = bestIdx;
  }
  const batch = batches[idx];
  const newSvc: Service = { loc: slot.loc, date: slot.date, meal: slot.meal };
  return {
    apply: () => {
      batch.services.push(newSvc);
      if (!familyStockOk(batch, batches, fixture) || hasHardFail(batches, fixture.today)) {
        batch.services.pop();
        return false;
      }
      return true;
    },
    undo: () => {
      // pop the last service if it matches
      const last = batch.services[batch.services.length - 1];
      if (last && last.loc === newSvc.loc && last.date === newSvc.date && last.meal === newSvc.meal) {
        batch.services.pop();
      }
    },
  };
}

function tryRemove(batches: Batch[], rng: () => number, fixture: Fixture): MoveOp | null {
  const refs = listFutureServices(batches, fixture.today);
  if (refs.length === 0) return null;
  const ref = refs[Math.floor(rng() * refs.length)];
  const batch = batches[ref.batchIdx];
  const removed = batch.services[ref.serviceIdx];
  return {
    apply: () => {
      batch.services.splice(ref.serviceIdx, 1);
      // Removing can't introduce hard-fails; skip check.
      return true;
    },
    undo: () => {
      batch.services.splice(ref.serviceIdx, 0, removed);
    },
  };
}

function tryMove(batches: Batch[], rng: () => number, fixture: Fixture): MoveOp | null {
  const refs = listFutureServices(batches, fixture.today);
  if (refs.length === 0) return null;
  const empty = listEmptyPositions(batches, fixture);
  if (empty.length === 0) return null;
  const ref = refs[Math.floor(rng() * refs.length)];
  const batch = batches[ref.batchIdx];
  const oldSvc = batch.services[ref.serviceIdx];
  // Find empty slots that this batch could legally fit
  const eligibleEmpty = empty.filter(slot => {
    if (slot.type !== batch.type) return false;
    // Tentatively check eligibility ignoring "alreadyAtSlot" (we'll verify after move)
    if (batch.storage === 'Frozen') return false;
    if (!isServableBy(batch.cookDate, slot.date, slot.meal, slot.loc, batch.location)) return false;
    if (batch.stock > 0 && isStaleAtSlot(batch.cookDate, slot.date)) return false;
    return true;
  });
  if (eligibleEmpty.length === 0) return null;
  const slot = eligibleEmpty[Math.floor(rng() * eligibleEmpty.length)];
  const newSvc: Service = { loc: slot.loc, date: slot.date, meal: slot.meal };
  return {
    apply: () => {
      batch.services.splice(ref.serviceIdx, 1);
      batch.services.push(newSvc);
      if (familyAlreadyAtSlot(batch, batches.filter(b => b !== batch), slot.loc, slot.date, slot.meal)
          || !familyStockOk(batch, batches, fixture)
          || hasHardFail(batches, fixture.today)) {
        batch.services.pop();
        batch.services.splice(ref.serviceIdx, 0, oldSvc);
        return false;
      }
      return true;
    },
    undo: () => {
      // pop the new service
      const last = batch.services[batch.services.length - 1];
      if (last && last.loc === newSvc.loc && last.date === newSvc.date && last.meal === newSvc.meal) {
        batch.services.pop();
      }
      batch.services.splice(ref.serviceIdx, 0, oldSvc);
    },
  };
}

function trySwap(batches: Batch[], rng: () => number, fixture: Fixture): MoveOp | null {
  const refs = listFutureServices(batches, fixture.today);
  if (refs.length < 2) return null;
  // Pick two refs of the same type (sample several)
  let r1: ServiceRef | null = null;
  let r2: ServiceRef | null = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    const a = refs[Math.floor(rng() * refs.length)];
    const b = refs[Math.floor(rng() * refs.length)];
    if (a.batchIdx === b.batchIdx) continue;
    if (batches[a.batchIdx].type !== batches[b.batchIdx].type) continue;
    r1 = a;
    r2 = b;
    break;
  }
  if (!r1 || !r2) return null;
  const batchA = batches[r1.batchIdx];
  const batchB = batches[r2.batchIdx];
  const svcA = batchA.services[r1.serviceIdx];
  const svcB = batchB.services[r2.serviceIdx];
  // Don't bother if same slot
  if (svcA.loc === svcB.loc && svcA.date === svcB.date && svcA.meal === svcB.meal) return null;
  return {
    apply: () => {
      // Swap services
      batchA.services[r1!.serviceIdx] = svcB;
      batchB.services[r2!.serviceIdx] = svcA;
      // Validity: each batch must be servable at its new slot AND family/in-slot rules hold
      const aOk = isServableBy(batchA.cookDate, svcB.date, svcB.meal, svcB.loc, batchA.location)
                   && !(batchA.stock > 0 && isStaleAtSlot(batchA.cookDate, svcB.date));
      const bOk = isServableBy(batchB.cookDate, svcA.date, svcA.meal, svcA.loc, batchB.location)
                   && !(batchB.stock > 0 && isStaleAtSlot(batchB.cookDate, svcA.date));
      if (!aOk || !bOk
          || !familyStockOk(batchA, batches, fixture)
          || !familyStockOk(batchB, batches, fixture)
          || hasHardFail(batches, fixture.today)) {
        batchA.services[r1!.serviceIdx] = svcA;
        batchB.services[r2!.serviceIdx] = svcB;
        return false;
      }
      return true;
    },
    undo: () => {
      batchA.services[r1!.serviceIdx] = svcA;
      batchB.services[r2!.serviceIdx] = svcB;
    },
  };
}

// ── Snapshot / restore ───────────────────────────────────────────────────────

function snapshotServices(batches: Batch[]): Service[][] {
  return batches.map(b => (b.services || []).map(s => ({ ...s })));
}

function restoreServices(batches: Batch[], snap: Service[][]): void {
  for (let i = 0; i < batches.length; i++) {
    batches[i].services = (snap[i] || []).map(s => ({ ...s }));
  }
}

// ── Main solver ──────────────────────────────────────────────────────────────

export const sa: SolverFn = (input): SolverResult => {
  const RealDate = Date;
  const start = RealDate.now();
  const { fixture, batches } = input;
  const rng = makeRng(RNG_SEED);

  // Warm start: invoke the baseline 5-pass pipeline directly. We replicate
  // current.ts's setup here so we get an identical starting point and can
  // iterate from there.
  let placeholders: Batch[] = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sandbox = require('../sandbox');
    sandbox.mockToday(fixture.today);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { rebuildPlanner, consolidateFamilies, calcRequired, getGuests: getGuestsCore } = require('../../../public/js/core');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const menuFixer = require('../../../public/js/menu-fixer');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { S } = require('../../../public/js/state');

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

    const consolidation = consolidateFamilies(S.batches);
    if (consolidation.removed.length > 0) S.batches = consolidation.kept;
    menuFixer.stripFutureServices(S.batches);
    const orphans = menuFixer.findOrphanPlaceholders(S.batches);
    if (orphans.length > 0) {
      const ids = new Set<string>(orphans.map((b: Batch) => b.id));
      S.batches = S.batches.filter((b: Batch) => !ids.has(b.id));
    }
    const planWindow = menuFixer.buildPlanningWindow(new Date(fixture.today + 'T08:00:00'));
    const snap = menuFixer.snapshotBatches(S.batches, planWindow);
    placeholders = menuFixer.generateMissingPlaceholders(planWindow, snap);
    for (const p of placeholders) S.batches.push(p);
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

    // Replace `batches` array contents with S.batches (consolidation may have removed some).
    // CRITICAL: take a snapshot of S.batches FIRST in case S.batches === batches
    // (when consolidation.removed.length === 0 they share a reference, so
    // batches.length = 0 would empty S.batches too).
    const finalBatches = [...S.batches];
    batches.length = 0;
    for (const b of finalBatches) batches.push(b);
    sandbox.uninstallFixture();
  } catch (e) {
    // Fallback: simple greedy
    if (process.env.SA_DEBUG) console.error('[sa] warm-start failed:', (e as Error).message);
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../sandbox').uninstallFixture();
    } catch (_e2) { /* ignore */ }
    const idCounter = { n: 0 };
    placeholders = generatePlaceholders(batches, fixture.today, idCounter);
    for (const p of placeholders) batches.push(p);
    buildInitialSolution(batches, fixture);
  }

  // Step 3: SA loop
  let currentScore = scoreSolution(fixture, batches).total;
  let bestScore = currentScore;
  let bestSnapshot = snapshotServices(batches);

  let T = T0;
  let stepsExecuted = 0;
  let stepsAccepted = 0;
  let stepsImproved = 0;
  let stepsInvalid = 0;
  let bestUpdates = 0;

  const moves = [trySwap, tryMove, tryAdd, tryRemove];

  while (stepsExecuted < MAX_STEPS) {
    if (RealDate.now() - start > TIME_BUDGET_MS) break;

    // Pick a move type with weighted probability:
    // swap 25%, move 25%, add 30%, remove 20%
    const r = rng();
    let moveBuilder;
    if (r < 0.25) moveBuilder = trySwap;
    else if (r < 0.50) moveBuilder = tryMove;
    else if (r < 0.80) moveBuilder = tryAdd;
    else moveBuilder = tryRemove;

    const op = moveBuilder(batches, rng, fixture);
    if (!op) {
      stepsInvalid++;
      continue;
    }

    if (!op.apply()) {
      stepsInvalid++;
      continue;
    }

    // Move applied — compute delta
    const newScore = scoreSolution(fixture, batches).total;
    const delta = newScore - currentScore;

    let accept = false;
    if (delta >= 0) {
      accept = true;
    } else {
      const p = Math.exp(delta / T);
      if (rng() < p) accept = true;
    }

    if (accept) {
      currentScore = newScore;
      stepsAccepted++;
      if (delta > 0) stepsImproved++;
      if (newScore > bestScore) {
        bestScore = newScore;
        bestSnapshot = snapshotServices(batches);
        bestUpdates++;
      }
    } else {
      op.undo();
    }

    T *= T_COOL;
    stepsExecuted++;
  }

  // Restore best-ever-seen
  restoreServices(batches, bestSnapshot);

  return {
    batches,
    durationMs: RealDate.now() - start,
    stats: {
      stepsExecuted,
      stepsAccepted,
      stepsImproved,
      stepsInvalid,
      bestUpdates,
      finalT: Math.round(T * 100) / 100,
      bestScore,
      placeholdersCreated: placeholders.length,
    },
  };
};
