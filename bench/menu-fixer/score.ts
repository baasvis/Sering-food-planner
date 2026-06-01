// Unified-batch-model scorer for the Fix-My-Menu bench.
//
// Re-implements the SAME objective + weights as the original score.ts
// (bench #47), but against the current unified-batch model (inventory[]/
// shipments, no parentId/families) and reusing the engine's own demand math
// so scores match what the planner actually computes.
//
// Two failure modes dominate the weights (per the cook, 2026-05-07):
//   - leftover surplus (cooked food wasted after the window)
//   - missed match (slot empty when eligible food had spare capacity)  ← the
//     "Monday starvation" class.
import type { Batch, DishType, Location, Meal } from '../../shared/types';
import { getServeableTotalStock, getTotalStock, calcRequired, getEffectiveGuests, isServicePast } from '../../public/js/core';
import { buildPlanningWindow, isServableBy, SLOTS_PER_TYPE, TYPES_TO_PLAN, type PlanDay } from '../../public/js/menu-fixer';

const W_SLOT_FILLED = 1000;
const W_MISSED_MATCH = -500;
const W_LEFTOVER_LITER = -300;
const W_OVER_CAP = -100;
const W_STALE_LITER = -50;
const W_OLDEST_FIRST = 10;
const W_VARIETY = 2;

const MAX_GUEST_FRACTION_PER_BATCH = 0.6;
const STALE_THRESHOLD_DAYS = 3;

function cookIsoOf(b: Batch): string | null {
  const cd = b.cookDate;
  if (!cd) return null;
  const m = cd.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}
function daysBetween(aIso: string, bIso: string): number {
  return Math.round((new Date(bIso + 'T12:00:00').getTime() - new Date(aIso + 'T12:00:00').getTime()) / 86400000);
}
function isOnlyFrozen(b: Batch): boolean {
  const inv = b.inventory || [];
  if (inv.length === 0) return false;
  return inv.every(e => e.storage === 'Frozen');
}
function primaryLoc(b: Batch): Location {
  return ((b.inventory || [])[0]?.loc as Location) || 'west';
}
function batchesInSlot(all: Batch[], type: DishType, loc: Location, date: string, meal: Meal): Batch[] {
  return all.filter(b => b.type === type && (b.services || []).some(s => s.loc === loc && s.date === date && s.meal === meal));
}

export interface ScoreReport {
  total: number;
  slotsFilled: number; slotsTotal: number;
  missedMatches: number; leftoverSurplusL: number;
  overCapSlots: number; staleL: number; oldestFirstHits: number; varietySlots: number;
  hardFails: string[];
}

export function scoreSolution(today: string, all: Batch[]): ScoreReport {
  const window: PlanDay[] = buildPlanningWindow(new Date(today + 'T08:00:00'));
  const r: ScoreReport = { total: 0, slotsFilled: 0, slotsTotal: 0, missedMatches: 0, leftoverSurplusL: 0, overCapSlots: 0, staleL: 0, oldestFirstHits: 0, varietySlots: 0, hardFails: [] };

  // Hard fail: a pure-frozen batch assigned to a future in-window slot.
  for (const b of all) {
    if (!isOnlyFrozen(b)) continue;
    for (const s of b.services || []) {
      if (!isServicePast(s) && window.some(d => d.isoDate === s.date)) {
        r.hardFails.push(`frozen ${b.name} @ ${s.loc}/${s.date}/${s.meal}`);
      }
    }
  }

  for (const day of window) {
    for (const slot of day.slots) {
      if (slot.isPast) continue;
      const guests = getEffectiveGuests(slot.loc, day.isoDate, slot.meal);
      if (guests < 1) continue;
      for (const type of TYPES_TO_PLAN) {
        r.slotsTotal++;
        const here = batchesInSlot(all, type, slot.loc, day.isoDate, slot.meal);
        const filled = here.length;
        if (filled >= SLOTS_PER_TYPE) {
          r.slotsFilled++;
          if (new Set(here.map(b => b.name)).size >= 2) r.varietySlots++;
        } else {
          // missed match: an eligible same-type batch could have filled this.
          const eligible = all.some(b => {
            if (b.type !== type || isOnlyFrozen(b)) return false;
            const ci = cookIsoOf(b);
            if (!ci) return false;
            if (!isServableBy(b.cookDate, day.isoDate, slot.meal, slot.loc, primaryLoc(b))) return false;
            if (here.includes(b)) return false;
            const serveable = getServeableTotalStock(b);
            if (getTotalStock(b) <= 0) return ci <= day.isoDate ? false : true; // uncooked placeholder, future cook
            if (daysBetween(ci, day.isoDate) >= 5) return false; // stale-hard
            return serveable - calcRequired(b) > 1;
          });
          if (eligible) r.missedMatches++;
        }
        // over-cap: one batch covers >60% of slot demand.
        if (here.length > 0) {
          const totalL = guests * (here[0].serving || 280) / 1000;
          for (const b of here) {
            const share = (guests / Math.max(here.length, 1)) * (b.serving || 280) / 1000;
            if (share > totalL * MAX_GUEST_FRACTION_PER_BATCH) { r.overCapSlots++; break; }
          }
        }
        // oldest-first: no older unassigned cooked batch with surplus exists for a filled-with-cooked slot.
        const assignedCooked = here.filter(b => getServeableTotalStock(b) > 0);
        if (assignedCooked.length > 0) {
          const oldest = assignedCooked.map(cookIsoOf).filter((d): d is string => !!d).sort()[0];
          const olderUnassigned = all.some(b => {
            if (b.type !== type || getServeableTotalStock(b) <= 0 || isOnlyFrozen(b) || here.includes(b)) return false;
            const ci = cookIsoOf(b);
            return !!ci && !!oldest && ci < oldest && getServeableTotalStock(b) - calcRequired(b) > 1;
          });
          if (!olderUnassigned) r.oldestFirstHits++;
        }
      }
    }
  }

  // leftover surplus + stale (serveable stock left after demand).
  for (const b of all) {
    if (!TYPES_TO_PLAN.includes(b.type)) continue;
    const serveable = getServeableTotalStock(b);
    if (serveable <= 0) continue;
    const ci = cookIsoOf(b);
    if (!ci) continue;
    const surplus = serveable - calcRequired(b);
    if (surplus > 1) {
      r.leftoverSurplusL += surplus;
      if (daysBetween(ci, today) >= STALE_THRESHOLD_DAYS) r.staleL += surplus;
    }
  }

  r.total = Math.round(
    r.slotsFilled * W_SLOT_FILLED
    + r.missedMatches * W_MISSED_MATCH
    + r.leftoverSurplusL * W_LEFTOVER_LITER
    + r.overCapSlots * W_OVER_CAP
    + r.staleL * W_STALE_LITER
    + r.oldestFirstHits * W_OLDEST_FIRST
    + r.varietySlots * W_VARIETY,
  );
  return r;
}
