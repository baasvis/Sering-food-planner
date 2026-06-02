/**
 * Catering demand retirement (2026-06 fix). A catering that already went out —
 * its date strictly before today — must stop contributing to a dish's required
 * litres, exactly like a past *service* retires via isServicePast. Before the
 * fix, `cateringDemand` (core.ts) had no date guard, so a delivered catering
 * kept forcing extra cooking until a human deleted it (Daan's feedback, the
 * "Het Actiefonds Lunch 2" case).
 *
 * Demand is read through calcRequiredLive (which sums service demand +
 * cateringDemand); a batch with no services isolates the catering term.
 */
import type { Batch, Catering, DishType, Location, Meal } from '../shared/types';
import { S } from '../public/js/state';
import { calcRequiredLive } from '../public/js/core';

// Pin "today" to Tue 2026-06-02 (Amsterdam). getToday() reads local time, so the
// jest run uses TZ=Europe/Amsterdam (see how the suite is invoked); 08:00Z = 10:00 local.
beforeAll(() => { jest.useFakeTimers(); jest.setSystemTime(new Date('2026-06-02T08:00:00Z')); });
afterAll(() => { jest.useRealTimers(); });

function batch(): Batch {
  return {
    id: 'dish-1', name: 'Jeera Aloo', type: 'Main course' as DishType, serving: 280,
    cookDate: '01/06/2026', inventory: [{ loc: 'west' as Location, storage: 'Gastro', qty: 50, cookDate: '01/06/2026' }],
    shipments: [], allergens: [], extraAllergens: [], orderFor: false, note: '', services: [],
    createdAt: '2026-06-01T00:00:00.000Z', recipeId: null, actualIngredients: null,
    cookNotes: '', stockDeducted: false, generated: false,
  };
}
function catering(date: string | null): Catering {
  return {
    id: 'c-1', name: 'Test catering', date, guestCount: 50, deliveryMode: 'pickup',
    dishes: [{ dishId: 'dish-1', name: 'Jeera Aloo', type: 'Main course' as DishType }],
    logisticsNotes: '',
  } as Catering;
}

const NO_GUESTS = (_l: Location, _d: string, _m: Meal) => 0;
beforeEach(() => { S.caterings = []; S.batches = []; });

// 50 guests / 1 peer × 280ml = 14.0 L.
test('a catering dated BEFORE today contributes 0 (retired like a past service)', () => {
  S.caterings = [catering('01/06/2026')];          // yesterday
  expect(calcRequiredLive(batch(), NO_GUESTS)).toBe(0);
});

test('a catering dated TODAY still counts (until confirmed delivered)', () => {
  S.caterings = [catering('02/06/2026')];
  expect(calcRequiredLive(batch(), NO_GUESTS)).toBeCloseTo(14.0);
});

test('a FUTURE catering still counts', () => {
  S.caterings = [catering('03/06/2026')];
  expect(calcRequiredLive(batch(), NO_GUESTS)).toBeCloseTo(14.0);
});

test('an UNDATED catering keeps counting (no date to compare)', () => {
  S.caterings = [catering(null)];
  expect(calcRequiredLive(batch(), NO_GUESTS)).toBeCloseTo(14.0);
});

test('only the past catering is dropped when several reference the same dish', () => {
  S.caterings = [catering('30/05/2026'), catering('03/06/2026')]; // one past, one future
  expect(calcRequiredLive(batch(), NO_GUESTS)).toBeCloseTo(14.0); // past dropped, future kept
});
