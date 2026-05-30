/**
 * Closed-services + demand roll-back.
 *
 * A service can be marked closed (no seating); the guest/staff demand registered
 * to it rolls onto the previous OPEN service at the same location, so that open
 * service's dishes cook for it. These tests lock:
 *   - isServiceClosed: recurring weekday rules + per-date overrides (open re-opens)
 *   - previousOpenService: same-day earlier meal, then cross-day backward, else null
 *   - getEffectiveGuests / rolledInto: closed → 0; open → own + rolled (incl. the
 *     predicted fallback for an un-entered closed slot, decision #5); no double-count
 *   - allocator integration: cached calcRequired === live calcRequiredLive
 *   - empty roll-target → a no-dish warning (decision #7)
 *
 * Browser-global stubs come from test/setup-dom-stubs.ts (jest setupFiles).
 * Pin Monday 4 May 2026 → current week Mon 05-04 .. Sun 05-10 (Wed 06, Thu 07, Fri 08).
 */

import type { Batch, DishType, Service } from '../shared/types';
import { S } from '../public/js/state';
import {
  rebuildPlanner, calcRequired, calcRequiredLive,
  isServiceClosed, previousOpenService, getEffectiveGuests, rolledInto, rolledFromMeal, rollWarning,
} from '../public/js/core';

beforeAll(() => { jest.useFakeTimers(); jest.setSystemTime(new Date('2026-05-04T08:00:00Z')); });
afterAll(() => { jest.useRealTimers(); });

let _id = 0;
function mk(type: DishType, services: Service[], overrides: Partial<Batch> = {}): Batch {
  return {
    id: `b-${++_id}`, name: overrides.name || `batch-${_id}`, type, serving: 280,
    cookDate: '01/05/2026', inventory: [], shipments: [], services,
    allergens: [], extraAllergens: [], note: '', cookNotes: '', actualIngredients: null,
    orderFor: false, stockDeducted: false, createdAt: '2026-05-01T00:00:00.000Z', recipeId: null,
    ...overrides,
  } as Batch;
}

function emptyGuests() {
  const z = () => ({
    Mon: { lunch: 0, dinner: 0 }, Tue: { lunch: 0, dinner: 0 }, Wed: { lunch: 0, dinner: 0 },
    Thu: { lunch: 0, dinner: 0 }, Fri: { lunch: 0, dinner: 0 }, Sat: { lunch: 0, dinner: 0 },
    Sun: { lunch: 0, dinner: 0 },
  });
  return { west: z(), centraal: z() };
}

beforeEach(() => {
  _id = 0;
  S.guests = emptyGuests() as any;
  S.predictions = {} as any;
  S.guestsNextWeeks = {} as any;
  S.batches = [];
  S.caterings = [];
  S.planner = {};
  S.closedServices = null;
});

describe('isServiceClosed', () => {
  test('null config → everything open', () => {
    S.closedServices = null;
    expect(isServiceClosed('centraal', '2026-05-08', 'dinner')).toBe(false);
  });

  test('recurring weekday rule (Fri only, centraal only, dinner only)', () => {
    S.closedServices = { recurring: { centraal: { Fri: ['dinner'] } } } as any;
    expect(isServiceClosed('centraal', '2026-05-08', 'dinner')).toBe(true);  // Fri
    expect(isServiceClosed('centraal', '2026-05-08', 'lunch')).toBe(false);
    expect(isServiceClosed('centraal', '2026-05-07', 'dinner')).toBe(false); // Thu
    expect(isServiceClosed('west', '2026-05-08', 'dinner')).toBe(false);
  });

  test('per-date closed override (checked before recurring)', () => {
    S.closedServices = { recurring: {}, dates: { '2026-05-08': [{ loc: 'centraal', closed: ['lunch'] }] } } as any;
    expect(isServiceClosed('centraal', '2026-05-08', 'lunch')).toBe(true);
    expect(isServiceClosed('centraal', '2026-05-07', 'lunch')).toBe(false);
  });

  test('per-date open override re-opens a recurring closure for that date only', () => {
    S.closedServices = {
      recurring: { centraal: { Fri: ['dinner'] } },
      dates: { '2026-05-08': [{ loc: 'centraal', open: ['dinner'] }] },
    } as any;
    expect(isServiceClosed('centraal', '2026-05-08', 'dinner')).toBe(false); // re-opened this date
    expect(isServiceClosed('centraal', '2026-05-15', 'dinner')).toBe(true);  // next Fri still closed
  });
});

describe('previousOpenService', () => {
  test('closed Fri dinner → Fri lunch (same day, earlier meal)', () => {
    S.closedServices = { recurring: { centraal: { Fri: ['dinner'] } } } as any;
    expect(previousOpenService('centraal', '2026-05-08', 'dinner'))
      .toEqual({ loc: 'centraal', date: '2026-05-08', meal: 'lunch' });
  });

  test('whole Fri closed → walks back across days to Thu dinner', () => {
    S.closedServices = { recurring: { centraal: { Fri: ['lunch', 'dinner'] } } } as any;
    expect(previousOpenService('centraal', '2026-05-08', 'dinner'))
      .toEqual({ loc: 'centraal', date: '2026-05-07', meal: 'dinner' });
  });

  test('all-closed within the window → null', () => {
    S.closedServices = { recurring: { centraal: {
      Mon: ['lunch', 'dinner'], Tue: ['lunch', 'dinner'], Wed: ['lunch', 'dinner'], Thu: ['lunch', 'dinner'],
      Fri: ['lunch', 'dinner'], Sat: ['lunch', 'dinner'], Sun: ['lunch', 'dinner'],
    } } } as any;
    expect(previousOpenService('centraal', '2026-05-08', 'dinner')).toBeNull();
  });
});

describe('getEffectiveGuests / rolledInto (roll-back math)', () => {
  test('closed slot → 0; open sibling absorbs its demand', () => {
    S.guests.centraal.Fri = { lunch: 30, dinner: 8 } as any;
    S.closedServices = { recurring: { centraal: { Fri: ['dinner'] } } } as any;
    rebuildPlanner(); // builds the roll-map
    expect(getEffectiveGuests('centraal', '2026-05-08', 'dinner')).toBe(0);
    expect(rolledInto('centraal', '2026-05-08', 'lunch')).toBe(8);
    expect(rolledFromMeal('centraal', '2026-05-08', 'lunch')).toBe('dinner'); // single, unambiguous source
    expect(getEffectiveGuests('centraal', '2026-05-08', 'lunch')).toBe(38);
  });

  test('predicted fallback: a closed slot with 0 entered rolls the prediction (decision #5)', () => {
    S.guests.centraal.Fri = { lunch: 30, dinner: 0 } as any;
    S.predictions = { centraal: { Fri: { lunch: 30, dinner: 12, staff_dinner: 12 } } } as any;
    S.closedServices = { recurring: { centraal: { Fri: ['dinner'] } } } as any;
    rebuildPlanner();
    expect(rolledInto('centraal', '2026-05-08', 'lunch')).toBe(12);
    expect(getEffectiveGuests('centraal', '2026-05-08', 'lunch')).toBe(42);
  });

  test('two closed slots onto one open → summed, no double-count', () => {
    S.guests.centraal.Thu = { lunch: 0, dinner: 50 } as any;
    S.guests.centraal.Fri = { lunch: 20, dinner: 8 } as any;
    S.closedServices = { recurring: { centraal: { Fri: ['lunch', 'dinner'] } } } as any;
    rebuildPlanner();
    // Both closed Fri slots resolve back to Thu dinner.
    expect(rolledInto('centraal', '2026-05-07', 'dinner')).toBe(28); // 20 + 8
    expect(rolledFromMeal('centraal', '2026-05-07', 'dinner')).toBeNull(); // 2 source meals → generic label
    expect(getEffectiveGuests('centraal', '2026-05-07', 'dinner')).toBe(78); // 50 + 28
    expect(getEffectiveGuests('centraal', '2026-05-08', 'lunch')).toBe(0);
    expect(getEffectiveGuests('centraal', '2026-05-08', 'dinner')).toBe(0);
  });
});

describe('allocator integration (cached === live; operator scenario)', () => {
  test('a batch on Fri lunch absorbs the closed Fri dinner demand', () => {
    S.guests.centraal.Fri = { lunch: 30, dinner: 8 } as any;
    const lunchBatch = mk('Soup', [{ loc: 'centraal', date: '2026-05-08', meal: 'lunch' }], { name: 'L' });
    S.batches = [lunchBatch];

    // Baseline (all open): 30 × 0.28 = 8.4.
    S.closedServices = null;
    rebuildPlanner();
    expect(calcRequired(lunchBatch)).toBe(8.4);

    // Close the dinner → 8 rolls onto lunch → 38 × 0.28 = 10.64 → 10.6.
    S.closedServices = { recurring: { centraal: { Fri: ['dinner'] } } } as any;
    rebuildPlanner();
    expect(calcRequired(lunchBatch)).toBe(10.6);
    expect(calcRequiredLive(lunchBatch)).toBe(calcRequired(lunchBatch)); // cached === live invariant
  });

  test('a batch sitting on a closed slot contributes 0 there', () => {
    S.guests.centraal.Fri = { lunch: 30, dinner: 8 } as any;
    const dinnerBatch = mk('Soup', [{ loc: 'centraal', date: '2026-05-08', meal: 'dinner' }], { name: 'D' });
    S.batches = [dinnerBatch];
    S.closedServices = { recurring: { centraal: { Fri: ['dinner'] } } } as any;
    rebuildPlanner();
    expect(calcRequired(dinnerBatch)).toBe(0); // its only service is closed
  });

  test('empty roll-target raises a no-dish warning (decision #7)', () => {
    S.guests.centraal.Fri = { lunch: 0, dinner: 8 } as any; // lunch open but no dish; dinner closed
    S.batches = [];
    S.closedServices = { recurring: { centraal: { Fri: ['dinner'] } } } as any;
    rebuildPlanner();
    const w = rollWarning('centraal', '2026-05-08', 'lunch');
    expect(w).not.toBeNull();
    expect(w!.reason).toBe('no-dish');
    expect(w!.amount).toBe(8);
  });
});

describe('SF-1: a roll-target whose cook window has passed retires cleanly', () => {
  // Friday 2026-05-08, 14:00 Amsterdam (12:00Z, CEST=+2): lunch deadline (13:45)
  // has passed but the dinner deadline (20:15) has not. A closed Fri dinner
  // resolves to the same-day Fri lunch — which is now served — so the demand
  // must retire (no phantom rolled badge on the dimmed past lunch cell).
  beforeAll(() => { jest.setSystemTime(new Date('2026-05-08T12:00:00Z')); });
  afterAll(() => { jest.setSystemTime(new Date('2026-05-04T08:00:00Z')); });

  test('no phantom rolled demand onto an already-served same-day lunch', () => {
    S.guests = emptyGuests() as any;
    S.guests.centraal.Fri = { lunch: 30, dinner: 8 } as any;
    S.batches = [mk('Soup', [{ loc: 'centraal', date: '2026-05-08', meal: 'lunch' }], { name: 'L' })];
    S.closedServices = { recurring: { centraal: { Fri: ['dinner'] } } } as any;
    rebuildPlanner();
    expect(rolledInto('centraal', '2026-05-08', 'lunch')).toBe(0); // target served → demand retires
  });
});
