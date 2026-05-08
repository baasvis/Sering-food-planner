// Scoring function for the Fix-My-Menu bench.
//
// Encodes the priority order from .claude/plans/fix-my-menu.md:
//   fill all slots > variety > pot-cap > waste
//
// Higher score = better. Hard-fails make a solution INVALID regardless of score.
//
// The two failure modes we care most about (per user 2026-05-07):
//   1. Batches with leftover food after window ends ("too much")
//   2. Slots empty even though eligible food existed ("missed match")
// Both penalties are heavy.

import type { Batch, Catering, Location, Meal } from '../../shared/types';
import type { Fixture, GuestsLookup, ScoreReport, ScoreBreakdown, SoftViolation } from './types';

// ── Weights ────────────────────────────────────────────────────────────────
// Tweak these only with care — every solver optimizes against them.

const W_SLOT_FILLED = 1000;
const W_MISSED_MATCH = -500;
const W_LEFTOVER_LITER = -300;
const W_OVER_CAP = -100;
const W_STALE_LITER = -50;
const W_FAMILY_BUDGET = -20;
const W_OLDEST_FIRST = 10;
const W_VARIETY = 2;

// Cap on the largest single batch's share of slot demand (Pass 5 constant).
const MAX_GUEST_FRACTION_PER_BATCH = 0.6;
// Slots with fewer expected guests than this are excluded from scoring (no real demand).
const MIN_GUESTS_TO_SCORE = 1;
// A batch is "stale" when assigned more than this many days after cookDate.
const STALE_THRESHOLD_DAYS = 3;
// Window length used by the planner.
const PLANNING_HORIZON_DAYS = 10;
// Slots per type (2 soups + 2 mains per service slot).
const SLOTS_PER_TYPE = 2;
const TYPES_TO_PLAN = ['Soup', 'Main course'] as const;

// ── Helpers ────────────────────────────────────────────────────────────────

function isoToDate(iso: string): Date {
  return new Date(iso + 'T12:00:00');
}

function cookDateToIso(cd: string | null | undefined): string | null {
  if (!cd) return null;
  // "DD/MM/YYYY" → "YYYY-MM-DD"
  const m = cd.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

function daysBetween(aIso: string, bIso: string): number {
  const a = isoToDate(aIso).getTime();
  const b = isoToDate(bIso).getTime();
  return Math.round((b - a) / 86400000);
}

function buildWindow(todayIso: string): string[] {
  const days: string[] = [];
  const start = isoToDate(todayIso);
  for (let i = 0; i < PLANNING_HORIZON_DAYS; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    days.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  }
  return days;
}

const SERVICE_SLOTS: { loc: Location; meal: Meal }[] = [
  { loc: 'centraal', meal: 'lunch' },
  { loc: 'centraal', meal: 'dinner' },
  { loc: 'west', meal: 'lunch' },
  { loc: 'west', meal: 'dinner' },
];

/** Resolve guest count from the fixture's pre-computed lookup. */
export function getFixtureGuests(g: GuestsLookup, loc: Location, date: string, meal: Meal): number {
  const day = g[date];
  if (!day) return 0;
  const locData = day[loc];
  if (!locData) return 0;
  return locData[meal] ?? 0;
}

/** Get all family members of a batch (parent + all splits). */
function getFamily(batch: Batch, all: Batch[]): Batch[] {
  const rootId = batch.parentId || batch.id;
  return all.filter(b => (b.parentId || b.id) === rootId);
}

/** Per-batch share of demand at one slot, peer-aware. */
function batchShareAtSlot(
  batch: Batch,
  loc: Location,
  date: string,
  meal: Meal,
  allBatches: Batch[],
  guests: GuestsLookup,
): number {
  const g = getFixtureGuests(guests, loc, date, meal);
  if (g <= 0) return 0;
  const liters = g * (batch.serving || 280) / 1000;
  // Count peers (same type, same slot, family-deduplicated)
  const families = new Set<string>();
  for (const b of allBatches) {
    if (b.type !== batch.type) continue;
    if (!(b.services || []).some(s => s.loc === loc && s.date === date && s.meal === meal)) continue;
    families.add(b.parentId || b.id);
  }
  const peerCount = Math.max(1, families.size);
  return liters / peerCount;
}

/** Total liters this batch is on the hook for (services + catering). */
function calcRequired(batch: Batch, allBatches: Batch[], guests: GuestsLookup, caterings: Catering[]): number {
  let total = 0;
  for (const s of batch.services || []) {
    total += batchShareAtSlot(batch, s.loc as Location, s.date, s.meal as Meal, allBatches, guests);
  }
  // Catering hold (matched by dishId, split by same-type peers within the catering)
  for (const c of caterings) {
    const cd = (c.dishes || []).find(d => d.dishId === batch.id);
    if (cd) {
      const peers = (c.dishes || []).filter(d => d.type === batch.type).length;
      total += ((c.guestCount || 0) / Math.max(peers, 1)) * ((batch.serving || 280) / 1000);
    }
  }
  return Math.round(total * 100) / 100;
}

// ── Main scorer ────────────────────────────────────────────────────────────

export function scoreSolution(fixture: Fixture, batchesAfter: Batch[]): ScoreReport {
  const breakdown: ScoreBreakdown = {
    slotsFilledPoints: 0,
    missedMatchPenalty: 0,
    leftoverSurplusPenalty: 0,
    overCapPenalty: 0,
    staleNotAssignedPenalty: 0,
    familyBudgetPenalty: 0,
    oldestFirstBonus: 0,
    varietyBonus: 0,
    slotsFilled: 0,
    slotsTotal: 0,
    missedMatches: 0,
    leftoverSurplusLiters: 0,
    overCapSlots: 0,
    staleNotAssignedLiters: 0,
    familyBudgetViolations: 0,
    oldestFirstHits: 0,
    varietySlots: 0,
  };
  const hardFails: string[] = [];
  const softViolations: SoftViolation[] = [];

  const window = buildWindow(fixture.today);
  const todayIso = fixture.today;

  // ── Hard fails ───────────────────────────────────────────────────────────

  // 1. In-slot duplicate: same family in both positions of one slot.
  // Only flag FUTURE slots — past services are frozen history that the solver
  // cannot edit, and prod data may legitimately have a parent + split sibling
  // at the same past slot (pre-consolidation residue).
  const slotFamilies = new Map<string, Map<string, number>>(); // slotKey -> family -> count
  for (const b of batchesAfter) {
    if (!TYPES_TO_PLAN.includes(b.type as typeof TYPES_TO_PLAN[number])) continue;
    const family = b.parentId || b.id;
    for (const s of b.services || []) {
      if (s.date < todayIso) continue; // past — solver isn't responsible
      const key = `${b.type}|${s.loc}|${s.date}|${s.meal}`;
      const inner = slotFamilies.get(key) || new Map();
      inner.set(family, (inner.get(family) || 0) + 1);
      slotFamilies.set(key, inner);
    }
  }
  for (const [key, fam] of slotFamilies) {
    for (const [familyId, count] of fam) {
      if (count > 1) {
        hardFails.push(`In-slot duplicate: family ${familyId} appears ${count}× at ${key}`);
      }
    }
  }

  // 2. Frozen batch auto-assigned (frozen storage with new services in window)
  for (const b of batchesAfter) {
    if (b.storage !== 'Frozen') continue;
    for (const s of b.services || []) {
      if (s.date >= todayIso && window.includes(s.date)) {
        hardFails.push(`Frozen batch ${b.id} (${b.name}) auto-assigned to ${s.loc} ${s.date} ${s.meal}`);
      }
    }
  }

  // 3. Past-slot assignment: services with date < today (existing past services
  // are ignored — only new ones placed by the solver count, but we can't
  // distinguish from this view alone, so we only flag if the date is before
  // window start.)
  // SKIP: existing test fixtures may have past services; let solvers preserve
  // them. The fixture builder ensures past services aren't planning targets.

  // ── Slot fill + missed match + variety ──────────────────────────────────

  for (const date of window) {
    if (date < todayIso) continue; // skip past
    for (const slot of SERVICE_SLOTS) {
      const guests = getFixtureGuests(fixture.guestsLookup, slot.loc, date, slot.meal);
      if (guests < MIN_GUESTS_TO_SCORE) continue; // 0-guest slots don't count

      for (const type of TYPES_TO_PLAN) {
        breakdown.slotsTotal++;

        const filledFamilies = new Set<string>();
        for (const b of batchesAfter) {
          if (b.type !== type) continue;
          if (!(b.services || []).some(s => s.loc === slot.loc && s.date === date && s.meal === slot.meal)) continue;
          filledFamilies.add(b.parentId || b.id);
        }
        const filled = filledFamilies.size;
        if (filled >= SLOTS_PER_TYPE) {
          breakdown.slotsFilled++;
          // Variety bonus: 2 distinct families
          if (filled >= 2) breakdown.varietySlots++;
        }

        // Missed match: if filled < SLOTS_PER_TYPE AND there's a same-type batch
        // with surplus capacity that COULD have been assigned here.
        if (filled < SLOTS_PER_TYPE) {
          const eligibleHasSurplus = batchesAfter.some(b => {
            if (b.type !== type) return false;
            if (b.storage === 'Frozen') return false;
            if (!b.cookDate) return false;
            const cookIso = cookDateToIso(b.cookDate);
            if (!cookIso) return false;
            // Servable: cook day's dinner or later
            if (cookIso > date) return false;
            if (cookIso === date && slot.meal === 'lunch') return false;
            // Not stale at this slot
            const ageDays = daysBetween(cookIso, date);
            if (b.stock > 0 && ageDays >= STALE_THRESHOLD_DAYS) return false;
            // Already in slot? (family-aware — counted as filled above)
            const family = b.parentId || b.id;
            if (filledFamilies.has(family)) return false;
            // Has surplus stock OR is uncooked (uncooked = capacity is a plan, not yet limited)
            if (b.stock === 0) return true; // uncooked, can absorb
            const required = calcRequired(b, batchesAfter, fixture.guestsLookup, fixture.caterings);
            return b.stock - required > 1; // at least 1L surplus
          });
          if (eligibleHasSurplus) {
            breakdown.missedMatches++;
            softViolations.push({
              category: 'missed-match',
              detail: `${type} slot empty at ${slot.loc} ${date} ${slot.meal}, eligible batch had surplus`,
              slot: { loc: slot.loc, date, meal: slot.meal },
            });
          }
        }
      }
    }
  }

  // ── Leftover surplus ────────────────────────────────────────────────────
  // After window ends, any cooked batch with stock > calcRequired is wasted
  // (or needs freezing). If the cookDate is within the window, count it.

  for (const b of batchesAfter) {
    if (!TYPES_TO_PLAN.includes(b.type as typeof TYPES_TO_PLAN[number])) continue;
    if (b.stock <= 0) continue;
    if (b.storage === 'Frozen') continue;
    const cookIso = cookDateToIso(b.cookDate);
    if (!cookIso) continue;
    if (cookIso < todayIso) {
      // Already cooked in past — only count if still in window
      const ageDays = daysBetween(cookIso, todayIso);
      if (ageDays > PLANNING_HORIZON_DAYS + STALE_THRESHOLD_DAYS) continue;
    }
    const required = calcRequired(b, batchesAfter, fixture.guestsLookup, fixture.caterings);
    const surplus = b.stock - required;
    if (surplus > 1) {
      breakdown.leftoverSurplusLiters += surplus;
      softViolations.push({
        category: 'leftover-surplus',
        detail: `Batch ${b.name} cooked ${b.cookDate} has ${surplus.toFixed(1)}L surplus after window`,
        liters: surplus,
        batchId: b.id,
      });
    }
  }

  // ── Over-cap (60% rule) ────────────────────────────────────────────────

  for (const date of window) {
    if (date < todayIso) continue;
    for (const slot of SERVICE_SLOTS) {
      const guests = getFixtureGuests(fixture.guestsLookup, slot.loc, date, slot.meal);
      if (guests < MIN_GUESTS_TO_SCORE) continue;
      for (const type of TYPES_TO_PLAN) {
        const here = batchesAfter.filter(b =>
          b.type === type
          && (b.services || []).some(s => s.loc === slot.loc && s.date === date && s.meal === slot.meal)
        );
        if (here.length === 0) continue;
        const totalLiters = guests * (here[0].serving || 280) / 1000;
        const cap = totalLiters * MAX_GUEST_FRACTION_PER_BATCH;
        for (const b of here) {
          const share = batchShareAtSlot(b, slot.loc, date, slot.meal, batchesAfter, fixture.guestsLookup);
          if (share > cap) {
            breakdown.overCapSlots++;
            softViolations.push({
              category: 'over-cap',
              detail: `${b.name} takes ${share.toFixed(1)}L (${(share / totalLiters * 100).toFixed(0)}%) of ${slot.loc} ${date} ${slot.meal} — over 60%`,
              batchId: b.id,
              slot: { loc: slot.loc, date, meal: slot.meal },
            });
            break; // one violation per slot/type
          }
        }
      }
    }
  }

  // ── Stale food not assigned ────────────────────────────────────────────

  for (const b of batchesAfter) {
    if (!TYPES_TO_PLAN.includes(b.type as typeof TYPES_TO_PLAN[number])) continue;
    if (b.stock <= 0) continue;
    if (b.storage === 'Frozen') continue;
    const cookIso = cookDateToIso(b.cookDate);
    if (!cookIso) continue;
    const ageDays = daysBetween(cookIso, todayIso);
    if (ageDays < STALE_THRESHOLD_DAYS) continue; // not stale yet
    const required = calcRequired(b, batchesAfter, fixture.guestsLookup, fixture.caterings);
    const surplus = b.stock - required;
    if (surplus > 1) {
      breakdown.staleNotAssignedLiters += surplus;
      softViolations.push({
        category: 'stale-not-assigned',
        detail: `Stale batch ${b.name} (cooked ${b.cookDate}, ${ageDays}d old) has ${surplus.toFixed(1)}L unassigned`,
        liters: surplus,
        batchId: b.id,
      });
    }
  }

  // ── Family budget violations ───────────────────────────────────────────
  // A family overshoots when total demand > total stock across all members.

  const familyMembers = new Map<string, Batch[]>();
  for (const b of batchesAfter) {
    if (!TYPES_TO_PLAN.includes(b.type as typeof TYPES_TO_PLAN[number])) continue;
    const root = b.parentId || b.id;
    const arr = familyMembers.get(root) || [];
    arr.push(b);
    familyMembers.set(root, arr);
  }
  for (const [rootId, members] of familyMembers) {
    if (members.length < 2) continue; // single-batch families can't have a budget mismatch
    const allCooked = members.every(m => m.stock > 0);
    if (!allCooked) continue; // mixed families have plan capacity
    const stock = members.reduce((s, m) => s + (m.stock || 0), 0);
    const demand = members.reduce((s, m) => s + calcRequired(m, batchesAfter, fixture.guestsLookup, fixture.caterings), 0);
    if (demand > stock + 1) {
      breakdown.familyBudgetViolations++;
      softViolations.push({
        category: 'family-budget',
        detail: `Family ${rootId} (${members.length} members) demand ${demand.toFixed(1)}L > stock ${stock.toFixed(1)}L`,
      });
    }
  }

  // ── Oldest-first bonus ─────────────────────────────────────────────────
  // Reward solutions where cooked batches are consumed in cookDate order.
  // Compute by slot: for each filled slot, did the chosen batch have an older
  // cookDate than any unassigned cooked batch of the same type?

  for (const date of window) {
    if (date < todayIso) continue;
    for (const slot of SERVICE_SLOTS) {
      for (const type of TYPES_TO_PLAN) {
        const assignedCooked = batchesAfter.filter(b =>
          b.type === type
          && b.stock > 0
          && (b.services || []).some(s => s.loc === slot.loc && s.date === date && s.meal === slot.meal)
        );
        if (assignedCooked.length === 0) continue;
        // The oldest cookDate among assigned:
        const oldestAssigned = assignedCooked
          .map(b => cookDateToIso(b.cookDate))
          .filter((d): d is string => d !== null)
          .sort()[0];
        if (!oldestAssigned) continue;
        // Is there an unassigned-here cooked batch with surplus AND older cookDate?
        const olderUnassigned = batchesAfter.some(b => {
          if (b.type !== type || b.stock <= 0 || b.storage === 'Frozen') return false;
          const cookIso = cookDateToIso(b.cookDate);
          if (!cookIso || cookIso >= oldestAssigned) return false;
          if (assignedCooked.includes(b)) return false;
          const required = calcRequired(b, batchesAfter, fixture.guestsLookup, fixture.caterings);
          return b.stock - required > 1;
        });
        if (!olderUnassigned) breakdown.oldestFirstHits++;
      }
    }
  }

  // ── Compute totals ─────────────────────────────────────────────────────

  breakdown.slotsFilledPoints = breakdown.slotsFilled * W_SLOT_FILLED;
  breakdown.missedMatchPenalty = breakdown.missedMatches * W_MISSED_MATCH;
  breakdown.leftoverSurplusPenalty = breakdown.leftoverSurplusLiters * W_LEFTOVER_LITER;
  breakdown.overCapPenalty = breakdown.overCapSlots * W_OVER_CAP;
  breakdown.staleNotAssignedPenalty = breakdown.staleNotAssignedLiters * W_STALE_LITER;
  breakdown.familyBudgetPenalty = breakdown.familyBudgetViolations * W_FAMILY_BUDGET;
  breakdown.oldestFirstBonus = breakdown.oldestFirstHits * W_OLDEST_FIRST;
  breakdown.varietyBonus = breakdown.varietySlots * W_VARIETY;

  const total = breakdown.slotsFilledPoints
    + breakdown.missedMatchPenalty
    + breakdown.leftoverSurplusPenalty
    + breakdown.overCapPenalty
    + breakdown.staleNotAssignedPenalty
    + breakdown.familyBudgetPenalty
    + breakdown.oldestFirstBonus
    + breakdown.varietyBonus;

  return {
    total: Math.round(total),
    breakdown,
    hardFails,
    softViolations,
  };
}
