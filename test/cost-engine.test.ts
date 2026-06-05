/**
 * Unit tests for the West-tab cost-per-guest engine (public/js/cost.ts).
 *
 * Drives the real demand model: set up S.batches/S.guests/S.recipes, call
 * rebuildPlanner() to populate the peer-share allocation cache + roll map, then
 * assert computeCostBreakdown(). Verifies the load-bearing claims from the
 * adversarial review: peer shares average correctly, the conservative estimate
 * fills un-costed dishes, toppings come from Supplies, and zero guests is safe.
 *
 * Browser-global stubs come from test/setup-dom-stubs.ts (jest setupFiles).
 */

import type { Batch, DishType, Location, Meal, RecipeFull, Supply } from '../shared/types';
import { S } from '../public/js/state';
import { rebuildPlanner } from '../public/js/core';
import { computeCostBreakdown, costStatus, computeDishCosts, computeServiceCosts } from '../public/js/cost';

// Pin "today" to Fri 1 May 2026 so the 2026-05-04..08 service dates are future
// (non-past) and fall in a future week (→ getGuests reads the base S.guests).
beforeAll(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-05-01T08:00:00Z'));
});
afterAll(() => {
  jest.useRealTimers();
});

let _id = 0;
function makeBatch(type: DishType, date: string, meal: Meal, opts: Partial<Batch> = {}): Batch {
  return {
    id: `b-${++_id}`,
    name: opts.name || 'Test',
    type,
    serving: 280,
    cookDate: '01/05/2026',
    inventory: [],
    shipments: [],
    allergens: [],
    extraAllergens: [],
    orderFor: false,
    note: '',
    services: [{ loc: 'west' as Location, date, meal }],
    createdAt: '2026-05-01T00:00:00.000Z',
    recipeId: null,
    actualIngredients: null,
    cookNotes: '',
    stockDeducted: false,
    generated: false,
    ...opts,
  };
}

function recipe(id: string, type: DishType, costPerServing: number | null): RecipeFull {
  return {
    id, name: id, type, servingSize: 280, costPerServing, yieldType: 'volume', recipeVolume: 10,
  } as unknown as RecipeFull;
}

function resetState() {
  _id = 0;
  S.batches = [];
  S.recipes = [];
  S.supplies = [];
  S.caterings = [];
  S.planner = {};
  S.closedServices = null;
  // Explicit targets with topping 0 so dish-focused tests aren't shifted by the
  // "assume topping target until priced" fallback. Topping tests set their own.
  S.costTargets = { soup: 0.50, main: 0.80, topping: 0, foodCostPct: 25, revenuePerGuestOverride: null };
  S.revenuePerGuest = null;
  (S as unknown as { predictions: unknown }).predictions = null;
  (S as unknown as { guestsNextWeeks: unknown }).guestsNextWeeks = {};
  const dinner100 = { lunch: 0, dinner: 100 };
  S.guests = {
    west: { Mon: { ...dinner100 }, Tue: { ...dinner100 }, Wed: { ...dinner100 }, Thu: { ...dinner100 }, Fri: { ...dinner100 }, Sat: { lunch: 0, dinner: 0 }, Sun: { lunch: 0, dinner: 0 } },
    centraal: { Mon: { lunch: 0, dinner: 0 }, Tue: { lunch: 0, dinner: 0 }, Wed: { lunch: 0, dinner: 0 }, Thu: { lunch: 0, dinner: 0 }, Fri: { lunch: 0, dinner: 0 }, Sat: { lunch: 0, dinner: 0 }, Sun: { lunch: 0, dinner: 0 } },
  } as unknown as typeof S.guests;
}

beforeEach(() => {
  resetState();
  localStorage.clear();
});

const MON = '2026-05-04'; // Monday, future week relative to pinned today

describe('computeCostBreakdown', () => {
  test('a single costed soup → soupPerGuest = its costPerServing', () => {
    S.recipes = [recipe('r1', 'Soup', 0.40)];
    S.batches = [makeBatch('Soup', MON, 'dinner', { recipeId: 'r1' })];
    rebuildPlanner();
    const b = computeCostBreakdown(new Set([MON]));
    expect(b.hasData).toBe(true);
    expect(b.totalGuests).toBe(100);
    expect(b.soupPerGuest).toBeCloseTo(0.40, 5);
    expect(b.mainPerGuest).toBe(0);
    expect(b.coveragePct).toBe(100);
    expect(b.estimated).toBe(false);
    expect(b.totalPerGuest).toBeCloseTo(0.40, 5);
  });

  test('two soup peers in one slot → guest-weighted average over total guests', () => {
    // Both serve the same 100-guest slot; peer-share splits them 50/50.
    S.recipes = [recipe('r1', 'Soup', 0.40), recipe('r2', 'Soup', 0.60)];
    S.batches = [
      makeBatch('Soup', MON, 'dinner', { recipeId: 'r1' }),
      makeBatch('Soup', MON, 'dinner', { recipeId: 'r2' }),
    ];
    rebuildPlanner();
    const b = computeCostBreakdown(new Set([MON]));
    expect(b.totalGuests).toBe(100);            // one slot, not double-counted
    expect(b.soupPerGuest).toBeCloseTo(0.50, 5); // (50·.40 + 50·.60) / 100
  });

  test('un-costed dish → conservative estimate (type costed-median ×1.10), flagged', () => {
    S.recipes = [recipe('r1', 'Soup', 0.40)];        // median of one = 0.40
    S.batches = [makeBatch('Soup', MON, 'dinner')];  // no recipe → estimate
    rebuildPlanner();
    const b = computeCostBreakdown(new Set([MON]));
    expect(b.soupPerGuest).toBeCloseTo(0.44, 5);     // 0.40 × 1.10
    expect(b.coveragePct).toBe(0);
    expect(b.estimated).toBe(true);
  });

  test('estimate base is the MEDIAN — one mispriced recipe cannot poison it', () => {
    // A €100 data-error recipe alongside two sane ones. Median = 0.50, mean ≈ 33.
    S.recipes = [recipe('r1', 'Soup', 0.40), recipe('r2', 'Soup', 0.50), recipe('r3', 'Soup', 100)];
    S.batches = [makeBatch('Soup', MON, 'dinner')];  // un-costed → estimate from median
    rebuildPlanner();
    const b = computeCostBreakdown(new Set([MON]));
    expect(b.soupPerGuest).toBeCloseTo(0.55, 5);     // 0.50 median × 1.10, not 33×1.10
  });

  test('no costed recipe of the type → estimate falls back to target ×1.10', () => {
    // No soup recipe is costed anywhere → base is the €0.50 soup target.
    S.batches = [makeBatch('Soup', MON, 'dinner')];
    rebuildPlanner();
    const b = computeCostBreakdown(new Set([MON]));
    expect(b.soupPerGuest).toBeCloseTo(0.55, 5);     // 0.50 target × 1.10
    expect(b.estimated).toBe(true);
  });

  test('toppings come from Supplies (costPerUnit ÷ guestsPerUnit) and add to total', () => {
    S.recipes = [recipe('r1', 'Soup', 0.40)];
    S.batches = [makeBatch('Soup', MON, 'dinner', { recipeId: 'r1' })];
    S.supplies = [{
      id: 's1', name: 'Bread', kind: 'standard', unit: 'loaf',
      costPerUnit: 5, guestsPerUnit: 10, archived: false,
    } as unknown as Supply];
    rebuildPlanner();
    const b = computeCostBreakdown(new Set([MON]));
    expect(b.toppingPerGuest).toBeCloseTo(0.50, 5);  // 5 / 10
    expect(b.totalPerGuest).toBeCloseTo(0.90, 5);    // 0.40 soup + 0.50 topping
  });

  test('toppings: assume the topping target until priced, then use the real figure', () => {
    S.costTargets = { soup: 0.50, main: 0.80, topping: 0.50, foodCostPct: 25, revenuePerGuestOverride: null };
    S.recipes = [recipe('r1', 'Soup', 0.40)];
    S.batches = [makeBatch('Soup', MON, 'dinner', { recipeId: 'r1' })];
    rebuildPlanner();
    // No supplies priced → topping assumed at the target (€0.50), still counts.
    let b = computeCostBreakdown(new Set([MON]));
    expect(b.toppingAssumed).toBe(true);
    expect(b.toppingPerGuest).toBeCloseTo(0.50, 5);
    expect(b.totalPerGuest).toBeCloseTo(0.90, 5);    // 0.40 soup + 0.50 assumed topping
    // Price a topping → real figure wins, no longer assumed.
    S.supplies = [{ id: 's1', name: 'Bread', kind: 'standard', unit: 'loaf', costPerUnit: 3, guestsPerUnit: 10, archived: false } as unknown as Supply];
    b = computeCostBreakdown(new Set([MON]));
    expect(b.toppingAssumed).toBe(false);
    expect(b.toppingPerGuest).toBeCloseTo(0.30, 5);  // 3 / 10
  });

  test('dish outside the window is excluded', () => {
    S.recipes = [recipe('r1', 'Soup', 0.40)];
    S.batches = [makeBatch('Soup', MON, 'dinner', { recipeId: 'r1' })];
    rebuildPlanner();
    const b = computeCostBreakdown(new Set(['2026-05-06'])); // different day
    expect(b.hasData).toBe(false);
    expect(b.totalGuests).toBe(0);
  });

  test('zero guests in window → no divide-by-zero, hasData false', () => {
    S.guests = {
      west: { Mon: { lunch: 0, dinner: 0 }, Tue: { lunch: 0, dinner: 0 }, Wed: { lunch: 0, dinner: 0 }, Thu: { lunch: 0, dinner: 0 }, Fri: { lunch: 0, dinner: 0 }, Sat: { lunch: 0, dinner: 0 }, Sun: { lunch: 0, dinner: 0 } },
      centraal: { Mon: { lunch: 0, dinner: 0 }, Tue: { lunch: 0, dinner: 0 }, Wed: { lunch: 0, dinner: 0 }, Thu: { lunch: 0, dinner: 0 }, Fri: { lunch: 0, dinner: 0 }, Sat: { lunch: 0, dinner: 0 }, Sun: { lunch: 0, dinner: 0 } },
    } as unknown as typeof S.guests;
    S.recipes = [recipe('r1', 'Soup', 0.40)];
    S.batches = [makeBatch('Soup', MON, 'dinner', { recipeId: 'r1' })];
    rebuildPlanner();
    const b = computeCostBreakdown(new Set([MON]));
    expect(b.hasData).toBe(false);
    expect(Number.isFinite(b.totalPerGuest)).toBe(true);
    expect(b.totalPerGuest).toBe(0);
  });
});

describe('food cost %', () => {
  test('foodCostPct = total €/guest ÷ revenue/guest; null when no revenue; override wins', () => {
    S.recipes = [recipe('r1', 'Soup', 0.50)];
    S.batches = [makeBatch('Soup', MON, 'dinner', { recipeId: 'r1' })];
    rebuildPlanner();

    // No revenue data → no % shown
    let b = computeCostBreakdown(new Set([MON]));
    expect(b.foodCostPct).toBeNull();

    // Auto revenue per guest → 0.50 / 5.00 = 10%
    S.revenuePerGuest = 5;
    b = computeCostBreakdown(new Set([MON]));
    expect(b.revenuePerGuest).toBe(5);
    expect(b.foodCostPct).toBeCloseTo(10, 5);

    // Manual override beats the auto value → 0.50 / 2.00 = 25%
    S.costTargets = { soup: 0.5, main: 0.8, topping: 0, foodCostPct: 25, revenuePerGuestOverride: 2 };
    b = computeCostBreakdown(new Set([MON]));
    expect(b.revenuePerGuest).toBe(2);
    expect(b.foodCostPct).toBeCloseTo(25, 5);
  });
});

describe('drill-down ranking', () => {
  test('computeDishCosts ranks dishes by €/guest desc; computeServiceCosts sums a service', () => {
    S.recipes = [recipe('cheap', 'Soup', 0.30), recipe('pricey', 'Main course', 1.20)];
    S.batches = [
      makeBatch('Soup', MON, 'dinner', { name: 'Cheap soup', recipeId: 'cheap' }),
      makeBatch('Main course', MON, 'dinner', { name: 'Pricey main', recipeId: 'pricey' }),
    ];
    rebuildPlanner();

    const dishes = computeDishCosts(new Set([MON]));
    expect(dishes.map(d => d.name)).toEqual(['Pricey main', 'Cheap soup']); // 1.20 before 0.30
    expect(dishes[0].costPerGuest).toBeCloseTo(1.20, 5);

    const svcs = computeServiceCosts(new Set([MON]));
    expect(svcs.length).toBe(1);                       // one slot: west MON dinner
    expect(svcs[0].costPerGuest).toBeCloseTo(1.50, 5); // 0.30 soup + 1.20 main
  });
});

describe('costStatus traffic light', () => {
  test('≤ target = ok, ≤ +15% = warn, beyond = over', () => {
    expect(costStatus(0.50, 0.50)).toBe('ok');
    expect(costStatus(0.40, 0.50)).toBe('ok');
    expect(costStatus(0.55, 0.50)).toBe('warn');  // 0.55 ≤ 0.575
    expect(costStatus(0.575, 0.50)).toBe('warn');
    expect(costStatus(0.60, 0.50)).toBe('over');   // > 0.575
  });
});
