/**
 * Hidden production-reserve buffer (core.reserveFactor).
 *
 * A director-set % silently pads per-service cooking demand so the kitchen
 * always cooks/orders a backup margin above guest demand. The buffer must:
 *   1. be a no-op at 0% (so all existing demand math is unchanged),
 *   2. scale guest-driven demand by (1 + pct/100),
 *   3. NOT pad catering (a contracted exact order, added as a separate term),
 *   4. keep calcRequiredLive ≡ rebuildPlanner()+calcRequired (FMM parity).
 *
 * Browser-global stubs come from test/setup-dom-stubs.ts (jest setupFiles).
 */

import type { Batch, Catering, CostTargets, DishType, Service } from '../shared/types';
import { S } from '../public/js/state';
import { rebuildPlanner, calcRequired, calcRequiredLive, calcRequiredAtLocLive, reserveFactor } from '../public/js/core';

beforeAll(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-05-04T08:00:00Z')); // Monday
});
afterAll(() => {
  jest.useRealTimers();
});

function targets(reservePercent: number): CostTargets {
  return { soup: 0.5, main: 0.8, topping: 0.5, foodCostPct: 25, revenuePerGuestOverride: null, reservePercent };
}

let _id = 0;
function mk(type: DishType, services: Service[], overrides: Partial<Batch> = {}): Batch {
  return {
    id: `b-${++_id}`, name: overrides.name || `batch-${_id}`, type, serving: 280,
    cookDate: '01/05/2026', inventory: [], shipments: [], services,
    allergens: [], extraAllergens: [], note: '', cookNotes: '', actualIngredients: null,
    orderFor: false, stockDeducted: false, createdAt: '2026-05-01T00:00:00.000Z', recipeId: null,
    ...overrides,
  };
}

let soupAlone: Batch;   // Soup alone at West Wed-lunch (100 guests)
let soupCatering: Batch; // Soup at West Fri-lunch (80 guests) + a catering

beforeEach(() => {
  _id = 0;
  soupAlone = mk('Soup', [{ loc: 'west', date: '2026-05-06', meal: 'lunch' }], { name: 'A' });
  soupCatering = mk('Soup', [{ loc: 'west', date: '2026-05-08', meal: 'lunch' }], { name: 'F' });

  S.guests = {
    west: {
      Mon: { lunch: 0, dinner: 0 }, Tue: { lunch: 0, dinner: 0 },
      Wed: { lunch: 100, dinner: 0 }, Thu: { lunch: 0, dinner: 0 },
      Fri: { lunch: 80, dinner: 0 }, Sat: { lunch: 0, dinner: 0 }, Sun: { lunch: 0, dinner: 0 },
    },
    centraal: {
      Mon: { lunch: 0, dinner: 0 }, Tue: { lunch: 0, dinner: 0 }, Wed: { lunch: 0, dinner: 0 },
      Thu: { lunch: 0, dinner: 0 }, Fri: { lunch: 0, dinner: 0 }, Sat: { lunch: 0, dinner: 0 }, Sun: { lunch: 0, dinner: 0 },
    },
  };
  S.batches = [soupAlone, soupCatering];
  // soupCatering also feeds a catering of 50 split across 2 Soup dishes → 25 guests × 0.28 = 7.0 L.
  S.caterings = [{
    id: 'cat-1', name: 'Office lunch', date: '2026-05-08', guestCount: 50,
    deliveryMode: 'pickup', logisticsNotes: '',
    dishes: [
      { dishId: soupCatering.id, name: 'F', type: 'Soup' },
      { dishId: 'ghost', name: 'Ghost', type: 'Soup' },
    ],
  }] as Catering[];
  S.planner = {};
  S.costTargets = null;
});

describe('reserveFactor', () => {
  test('is 1.0 when no targets / 0% (no-op)', () => {
    S.costTargets = null;
    expect(reserveFactor()).toBe(1);
    S.costTargets = targets(0);
    expect(reserveFactor()).toBe(1);
  });

  test('is 1 + pct/100 when a reserve is set', () => {
    S.costTargets = targets(20);
    expect(reserveFactor()).toBeCloseTo(1.2, 10);
    S.costTargets = targets(10);
    expect(reserveFactor()).toBeCloseTo(1.1, 10);
  });
});

describe('calcRequired with a hidden reserve', () => {
  test('0% leaves guest demand unchanged', () => {
    S.costTargets = targets(0);
    rebuildPlanner();
    // 100 guests × 0.28 = 28.0 L
    expect(calcRequired(soupAlone)).toBe(28.0);
  });

  test('20% pads guest-driven demand by ×1.2', () => {
    S.costTargets = targets(20);
    rebuildPlanner();
    // 28.0 × 1.2 = 33.6 L
    expect(calcRequired(soupAlone)).toBe(33.6);
  });

  test('does NOT pad catering demand (contracted exact order)', () => {
    S.costTargets = targets(20);
    rebuildPlanner();
    // Guest part: 80 × 0.28 = 22.4 → ×1.2 = 26.88 → 26.9 (alloc rounds 0.1).
    // Catering part: 25 × 0.28 = 7.0, UNPADDED. Total = 33.9.
    // If catering were (wrongly) padded too, it'd be 26.9 + 8.4 = 35.3.
    expect(calcRequired(soupCatering)).toBe(33.9);
  });
});

describe('FMM parity holds with the reserve on', () => {
  test('calcRequiredLive ≡ rebuildPlanner() + calcRequired at 20%', () => {
    S.costTargets = targets(20);
    rebuildPlanner();
    for (const b of S.batches) {
      expect(calcRequiredLive(b)).toBe(calcRequired(b));
    }
  });

  test('calcRequiredAtLocLive (FMM West-capacity path) is buffered too', () => {
    // soupAlone serves West Wed-lunch alone (100 guests) → base 28.0 L.
    S.costTargets = targets(0);
    rebuildPlanner();
    expect(calcRequiredAtLocLive(soupAlone, 'west')).toBe(28.0);
    S.costTargets = targets(20);
    rebuildPlanner();
    expect(calcRequiredAtLocLive(soupAlone, 'west')).toBe(33.6); // 28.0 × 1.2
  });
});
