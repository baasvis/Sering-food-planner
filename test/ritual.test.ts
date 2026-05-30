/**
 * Unit tests for the daily-ritual model (public/js/ritual.ts).
 *
 * The model is pure: computeRitual() and the clock/order-day helpers take an
 * explicit context (or a Date) and read no globals, DOM, or localStorage — so
 * these tests construct contexts directly with no setup.
 *
 * Dates are built with the multi-arg Date constructor and read back with local
 * getters (getHours/getDay/…), so the assertions are timezone-independent: the
 * runtime TZ cancels out because we never cross a UTC boundary.
 *
 * Weekday anchors (verified): 2026-05-25 = Monday (order day),
 * 2026-05-26 = Tuesday (order), 2026-05-27 = Wednesday (non-order),
 * 2026-05-28 = Thursday (order), 2026-05-29 = Friday (non-order).
 */

import type { Batch } from '@shared/types';
import {
  currentPhase, isOrderDay, fixMyMenuRitualStep, computeRitual,
  type RitualContext, type RitualView, type RitualStepView,
} from '../public/js/ritual';

function mkBatch(p: Partial<Batch>): Batch {
  return {
    id: p.id ?? 'b1',
    name: p.name ?? 'Test',
    type: p.type ?? 'Soup',
    recipeId: p.recipeId ?? null,
    serving: p.serving ?? 280,
    cookDate: p.cookDate ?? null,
    inventory: p.inventory ?? [],
    shipments: p.shipments ?? [],
    services: p.services ?? [],
    allergens: p.allergens ?? [],
    extraAllergens: p.extraAllergens ?? [],
    note: p.note ?? '',
    cookNotes: p.cookNotes ?? '',
    actualIngredients: p.actualIngredients ?? null,
    orderFor: p.orderFor ?? false,
    generated: p.generated,
    stockDeducted: p.stockDeducted ?? false,
    createdAt: p.createdAt ?? '2026-05-25T00:00:00.000Z',
  };
}

function mkCtx(p: Partial<RitualContext>): RitualContext {
  return {
    loc: p.loc ?? 'west',
    now: p.now ?? new Date(2026, 4, 25, 13, 50),
    todayIso: p.todayIso ?? '2026-05-25',
    batches: p.batches ?? [],
    inventoryCompletions: p.inventoryCompletions ?? {
      west: { lunch: null, dinner: null },
      centraal: { lunch: null, dinner: null },
    },
    ritualDone: p.ritualDone ?? (() => false),
    packPending: p.packPending ?? false,
  };
}

const stepOf = (v: RitualView, key: string): RitualStepView => {
  const s = v.steps.find(x => x.key === key);
  if (!s) throw new Error(`step ${key} not present`);
  return s;
};

// Local "today" / "yesterday" inventory-completion timestamps relative to the
// default now (2026-05-25).
const TODAY_TS = new Date(2026, 4, 25, 13, 0).toISOString();
const YESTERDAY_TS = new Date(2026, 4, 24, 13, 0).toISOString();

describe('ritual clock + order days', () => {
  it('currentPhase maps minutes-of-day to phases at the right boundaries', () => {
    expect(currentPhase(new Date(2026, 4, 25, 13, 44))).toBe('morning');
    expect(currentPhase(new Date(2026, 4, 25, 13, 45))).toBe('lunch-close');
    expect(currentPhase(new Date(2026, 4, 25, 16, 59))).toBe('lunch-close');
    expect(currentPhase(new Date(2026, 4, 25, 17, 0))).toBe('afternoon');
    expect(currentPhase(new Date(2026, 4, 25, 20, 44))).toBe('afternoon');
    expect(currentPhase(new Date(2026, 4, 25, 20, 45))).toBe('dinner-close');
    expect(currentPhase(new Date(2026, 4, 25, 23, 30))).toBe('dinner-close');
  });

  it('isOrderDay is true on Mon/Tue/Thu only', () => {
    expect(isOrderDay(new Date(2026, 4, 25))).toBe(true);  // Mon
    expect(isOrderDay(new Date(2026, 4, 26))).toBe(true);  // Tue
    expect(isOrderDay(new Date(2026, 4, 27))).toBe(false); // Wed
    expect(isOrderDay(new Date(2026, 4, 28))).toBe(true);  // Thu
    expect(isOrderDay(new Date(2026, 4, 29))).toBe(false); // Fri
    expect(isOrderDay(new Date(2026, 4, 30))).toBe(false); // Sat
    expect(isOrderDay(new Date(2026, 4, 31))).toBe(false); // Sun
  });

  it('fixMyMenuRitualStep splits lunch vs dinner at 17:00', () => {
    expect(fixMyMenuRitualStep(new Date(2026, 4, 25, 13, 50))).toBe('fmm-lunch');
    expect(fixMyMenuRitualStep(new Date(2026, 4, 25, 16, 59))).toBe('fmm-lunch');
    expect(fixMyMenuRitualStep(new Date(2026, 4, 25, 17, 0))).toBe('fmm-dinner');
    expect(fixMyMenuRitualStep(new Date(2026, 4, 25, 20, 45))).toBe('fmm-dinner');
  });
});

describe('computeRitual — West', () => {
  it('hides order-day-only steps on a non-order day', () => {
    const order = computeRitual(mkCtx({ now: new Date(2026, 4, 25, 13, 50) })); // Mon
    const nonOrder = computeRitual(mkCtx({ now: new Date(2026, 4, 27, 13, 50) })); // Wed
    expect(order.isOrderDay).toBe(true);
    expect(order.total).toBe(10);
    expect(nonOrder.isOrderDay).toBe(false);
    expect(nonOrder.total).toBe(7);
    for (const k of ['replace-placeholders', 'stocktake', 'hanos-order']) {
      expect(order.steps.some(s => s.key === k)).toBe(true);
      expect(nonOrder.steps.some(s => s.key === k)).toBe(false);
    }
  });

  it('derives lunch inventory from a same-day completion timestamp', () => {
    const fresh = computeRitual(mkCtx({
      inventoryCompletions: { west: { lunch: TODAY_TS, dinner: null }, centraal: { lunch: null, dinner: null } },
    }));
    expect(stepOf(fresh, 'inv-lunch').done).toBe(true);

    const stale = computeRitual(mkCtx({
      inventoryCompletions: { west: { lunch: YESTERDAY_TS, dinner: null }, centraal: { lunch: null, dinner: null } },
    }));
    expect(stepOf(stale, 'inv-lunch').done).toBe(false);
  });

  it('derives cook-underway from cookDate on today\'s West batches', () => {
    const uncooked = computeRitual(mkCtx({
      batches: [mkBatch({ cookDate: null, services: [{ loc: 'west', date: '2026-05-25', meal: 'lunch' }] })],
    }));
    expect(stepOf(uncooked, 'cook-underway').done).toBe(false);

    const cooked = computeRitual(mkCtx({
      batches: [mkBatch({ cookDate: '25/05/2026', services: [{ loc: 'west', date: '2026-05-25', meal: 'lunch' }] })],
    }));
    expect(stepOf(cooked, 'cook-underway').done).toBe(true);
  });

  it('reads manual-tick steps from ritualDone', () => {
    const v = computeRitual(mkCtx({ ritualDone: (k) => k === 'fmm-lunch' }));
    expect(stepOf(v, 'fmm-lunch').done).toBe(true);
    expect(stepOf(v, 'fmm-dinner').done).toBe(false);
  });

  it('yields step falls back to the dinner inventory being done', () => {
    // ritualDone('yields') is false, but the evening inventory is fresh, so the
    // yields step is satisfied by the backstop.
    const v = computeRitual(mkCtx({
      now: new Date(2026, 4, 25, 20, 50),
      ritualDone: () => false,
      inventoryCompletions: { west: { lunch: null, dinner: TODAY_TS }, centraal: { lunch: null, dinner: null } },
    }));
    expect(stepOf(v, 'yields').done).toBe(true);
  });

  it('flags an undone close-step overdue past its hard deadline', () => {
    const active = computeRitual(mkCtx({ now: new Date(2026, 4, 25, 13, 50) })); // before 14:30
    expect(stepOf(active, 'inv-lunch').status).toBe('active');

    const overdue = computeRitual(mkCtx({ now: new Date(2026, 4, 25, 14, 45) })); // past 14:30
    expect(stepOf(overdue, 'inv-lunch').status).toBe('overdue');

    const upcoming = computeRitual(mkCtx({ now: new Date(2026, 4, 25, 10, 0) }));
    expect(stepOf(upcoming, 'inv-dinner').status).toBe('upcoming');
  });

  it('marks pack-send done when nothing is left to pack', () => {
    expect(stepOf(computeRitual(mkCtx({ packPending: true })), 'pack-send').done).toBe(false);
    expect(stepOf(computeRitual(mkCtx({ packPending: false })), 'pack-send').done).toBe(true);
  });

  it('replace-placeholders is undone while a generated placeholder has an upcoming service', () => {
    const placeholder = mkBatch({
      id: 'p1', generated: true, recipeId: null,
      services: [{ loc: 'west', date: '2026-05-26', meal: 'lunch' }],
    });
    const pending = computeRitual(mkCtx({ now: new Date(2026, 4, 25, 17, 30), batches: [placeholder] }));
    expect(stepOf(pending, 'replace-placeholders').done).toBe(false);

    // Same batch, now backed by a recipe → replaced.
    const replaced = computeRitual(mkCtx({
      now: new Date(2026, 4, 25, 17, 30),
      batches: [mkBatch({ ...placeholder, recipeId: 'r1' })],
    }));
    expect(stepOf(replaced, 'replace-placeholders').done).toBe(true);
  });
});

describe('computeRitual — Centraal', () => {
  it('has 5 steps on a non-order day, 7 on an order day', () => {
    expect(computeRitual(mkCtx({ loc: 'centraal', now: new Date(2026, 4, 27, 12, 0) })).total).toBe(5);
    expect(computeRitual(mkCtx({ loc: 'centraal', now: new Date(2026, 4, 25, 12, 0) })).total).toBe(7);
  });

  it('derives arrivals from pending inbound shipments', () => {
    const noShip = computeRitual(mkCtx({ loc: 'centraal', batches: [mkBatch({})] }));
    expect(stepOf(noShip, 'arrivals').done).toBe(true);

    const inFlight = mkBatch({
      shipments: [{ id: 's1', fromLoc: 'west', toLoc: 'centraal', storage: 'Gastro', qty: 10, sentAt: TODAY_TS, arrived: false, cookDate: '25/05/2026' }],
    });
    const pending = computeRitual(mkCtx({ loc: 'centraal', batches: [inFlight] }));
    expect(stepOf(pending, 'arrivals').done).toBe(false);
  });
});
