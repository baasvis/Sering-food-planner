// ─────────────────────────────────────────────────────────────────────────────
// SUPPLY DEMAND — pure functions for forward supply demand and price-per-guest.
// One source of truth used by the prep checklist, the dashboard Supplies card,
// and the Supplies screen. No DB access, no req/res.
// ─────────────────────────────────────────────────────────────────────────────

import type { Supply, GuestsData, Catering } from './types';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

// Per-location demand in the supply's own unit. `west`/`centraal` are always
// present; event-location slugs appear as extra keys when the `guests` input
// carries them. Consumers read `demand[loc] ?? 0`.
export interface SupplyDemand {
  west: number;
  centraal: number;
  [loc: string]: number;
}

/** Convert ISO 'YYYY-MM-DD' to a Date in local time (no UTC drift). */
export function isoToDate(iso: string): Date {
  const parts = iso.split('-').map(Number);
  return new Date(parts[0], parts[1] - 1, parts[2]);
}

/** Convert a Date to local ISO 'YYYY-MM-DD'. */
export function dateToIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Day-of-week abbreviation ('Sun'..'Sat') matching keys in GuestsData. */
export function dayName(d: Date): string {
  return DAY_NAMES[d.getDay()];
}

/**
 * Caterings store the date as 'DD/MM/YYYY' (per validateCatering). Convert to
 * ISO 'YYYY-MM-DD' so we can compare against horizon dates. Returns null for
 * invalid input.
 */
export function cateringDateToIso(dmy: string | null | undefined): string | null {
  if (!dmy || !/^\d{2}\/\d{2}\/\d{4}$/.test(dmy)) return null;
  const [d, m, y] = dmy.split('/');
  return `${y}-${m}-${d}`;
}

/**
 * Compute forward demand (in the supply's own unit) for a single STANDARD
 * supply. Sums:
 *   - guest count ÷ guestsPerUnit across the supply's prepHorizonDays
 *     starting from `today`
 *   - catering toppings on dates in that horizon (matched by supplyId)
 *
 * Returns 0 for one-offs and archived supplies (a one-off's "demand" is just
 * its remaining stock — it drip-feeds at a fixed rate, not a guest ratio).
 *
 * For prepMode = 'centralized', both location demands collapse into `west`
 * (only West preps; transport carries it to Centraal). For prepMode =
 * 'per-location', each kitchen's demand stays in its own bucket.
 *
 * Catering toppings always count toward `west` because Catering doesn't carry
 * an explicit prep location today; West is the dispatch kitchen.
 */
export function computeSupplyDemand(
  supply: Supply,
  guests: GuestsData,
  caterings: Catering[],
  today: string,
  effectiveGuests?: (loc: string, iso: string, meal: 'lunch' | 'dinner') => number,
): SupplyDemand {
  // Location buckets come from the `guests` input itself (west/centraal plus
  // any event-location keys), keeping this module pure and registry-free.
  const result: SupplyDemand = { west: 0, centraal: 0 };
  for (const k of Object.keys(guests || {})) {
    if (!(k in result)) result[k] = 0;
  }
  if (supply.archived) return result;
  if (supply.kind !== 'standard') return result;
  if (!supply.prepHorizonDays || supply.prepHorizonDays <= 0) return result;
  if (!supply.guestsPerUnit || supply.guestsPerUnit <= 0) return result;

  const todayDate = isoToDate(today);

  for (let i = 0; i < supply.prepHorizonDays; i++) {
    const d = new Date(todayDate);
    d.setDate(todayDate.getDate() + i);
    const iso = dateToIso(d);
    const dn = dayName(d);

    for (const loc of Object.keys(result)) {
      let lunch: number;
      let dinner: number;
      if (effectiveGuests) {
        // Closed-service aware (audit CORR-3): a closed slot rolls its eaters
        // onto an open one, and those eaters still need toppings/bread — so
        // mirror the batch demand engine (core.getEffectiveGuests: closed -> 0,
        // open -> raw + rolled-in). Demand is conserved, not dropped.
        lunch = effectiveGuests(loc, iso, 'lunch');
        dinner = effectiveGuests(loc, iso, 'dinner');
      } else {
        // Default (3-arg callers / tests): raw registered guests, unchanged.
        const g = guests[loc]?.[dn];
        if (!g) continue;
        lunch = g.lunch || 0;
        dinner = g.dinner || 0;
      }
      result[loc] += (lunch + dinner) / supply.guestsPerUnit;
    }

    for (const c of caterings) {
      if (!c.date || !c.toppings) continue;
      const cIso = cateringDateToIso(c.date);
      if (cIso !== iso) continue;
      for (const t of c.toppings) {
        if (t.supplyId === supply.id && t.amount > 0) {
          result.west += t.amount;
        }
      }
    }
  }

  if (supply.prepMode === 'centralized') {
    // All non-west buckets fold into West — it is the production/dispatch
    // kitchen for centralized prep (identical to the old west+=centraal for
    // two-key input; event locations collapse the same way).
    for (const k of Object.keys(result)) {
      if (k === 'west') continue;
      result.west += result[k];
      result[k] = 0;
    }
  }

  return result;
}

/**
 * Price per guest for a STANDARD supply = costPerUnit ÷ guestsPerUnit.
 * e.g. a €2.50 loaf serving 6.5 guests → €0.385/guest. Returns null when the
 * cost or ratio is missing, or for one-offs (no per-guest ratio).
 */
export function supplyPricePerGuest(supply: Supply): number | null {
  if (supply.kind !== 'standard') return null;
  if (supply.costPerUnit == null || supply.costPerUnit < 0) return null;
  if (!supply.guestsPerUnit || supply.guestsPerUnit <= 0) return null;
  return supply.costPerUnit / supply.guestsPerUnit;
}
