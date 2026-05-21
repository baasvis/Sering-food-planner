/**
 * Equivalence guard for the Fix My Menu performance fix.
 *
 * Fix My Menu's scored algorithm used to call `rebuildPlanner(); calcRequired(b)`
 * once per candidate inside tight nested loops — a full planner rebuild per
 * call froze the browser for seconds. It now calls `calcRequiredLive(b)`, which
 * derives one batch's peer-share demand directly from live S.batches state
 * without the global rebuild.
 *
 * These tests lock the invariant the fix depends on: for any batch,
 *   calcRequiredLive(b)  ===  rebuildPlanner(); calcRequired(b)
 * If the two ever drift apart, Fix My Menu would silently produce a different
 * menu than the on-screen planner shows.
 *
 * Browser-global stubs (document, localStorage, etc.) come from
 * test/setup-dom-stubs.ts in the jest setupFiles list.
 */

import type { Batch, Catering, DishType, Service } from '../shared/types';
import { S } from '../public/js/state';
import { rebuildPlanner, calcRequired, calcRequiredLive } from '../public/js/core';

// Pin "today" to Monday 4 May 2026. The fixture's future service dates
// (Wed/Thu/Fri of that same week) then stay in the future and resolve guest
// counts from the current-week S.guests table; the 1 May service reads as past.
beforeAll(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-05-04T08:00:00Z'));
});
afterAll(() => {
  jest.useRealTimers();
});

let _id = 0;
function mk(type: DishType, services: Service[], overrides: Partial<Batch> = {}): Batch {
  return {
    id: `b-${++_id}`,
    name: overrides.name || `batch-${_id}`,
    type,
    serving: 280,
    cookDate: '01/05/2026',
    inventory: [],
    shipments: [],
    services,
    allergens: [],
    extraAllergens: [],
    note: '',
    cookNotes: '',
    actualIngredients: null,
    orderFor: false,
    stockDeducted: false,
    createdAt: '2026-05-01T00:00:00.000Z',
    recipeId: null,
    ...overrides,
  };
}

// Fixture batches — module scope so individual tests can reference them.
let batchA: Batch; // Soup, shares Wed-lunch-west with B (peer-share /2)
let batchB: Batch; // Soup, second peer at Wed-lunch-west
let batchC: Batch; // Main course at Wed-lunch-west — different type, NOT a soup peer
let batchD: Batch; // Soup, alone at Fri-dinner-centraal (peer-share /1)
let batchE: Batch; // Soup, one past + one future service (past must be skipped)
let batchF: Batch; // Soup, also referenced by a catering

beforeEach(() => {
  _id = 0;
  batchA = mk('Soup', [
    { loc: 'west', date: '2026-05-06', meal: 'lunch' },
    { loc: 'west', date: '2026-05-07', meal: 'dinner' },
  ], { name: 'A' });
  batchB = mk('Soup', [
    { loc: 'west', date: '2026-05-06', meal: 'lunch' },
  ], { name: 'B' });
  batchC = mk('Main course', [
    { loc: 'west', date: '2026-05-06', meal: 'lunch' },
  ], { name: 'C' });
  batchD = mk('Soup', [
    { loc: 'centraal', date: '2026-05-08', meal: 'dinner' },
  ], { name: 'D' });
  batchE = mk('Soup', [
    { loc: 'west', date: '2026-05-01', meal: 'lunch' },     // past — must be skipped
    { loc: 'centraal', date: '2026-05-07', meal: 'lunch' },  // future
  ], { name: 'E' });
  batchF = mk('Soup', [
    { loc: 'west', date: '2026-05-08', meal: 'lunch' },
  ], { name: 'F' });

  // Explicit guest counts so the expected liters in the tests below are
  // self-contained — not dependent on the demo defaults in state.ts.
  S.guests = {
    west: {
      Mon: { lunch: 0, dinner: 0 }, Tue: { lunch: 0, dinner: 0 },
      Wed: { lunch: 100, dinner: 0 }, Thu: { lunch: 0, dinner: 110 },
      Fri: { lunch: 80, dinner: 0 }, Sat: { lunch: 0, dinner: 0 },
      Sun: { lunch: 0, dinner: 0 },
    },
    centraal: {
      Mon: { lunch: 0, dinner: 0 }, Tue: { lunch: 0, dinner: 0 },
      Wed: { lunch: 0, dinner: 0 }, Thu: { lunch: 80, dinner: 85 },
      Fri: { lunch: 0, dinner: 70 }, Sat: { lunch: 0, dinner: 0 },
      Sun: { lunch: 0, dinner: 0 },
    },
  };

  S.batches = [batchA, batchB, batchC, batchD, batchE, batchF];
  S.caterings = [{
    id: 'cat-1', name: 'Office lunch', date: '2026-05-08', guestCount: 50,
    deliveryMode: 'pickup', logisticsNotes: '',
    dishes: [
      { dishId: batchF.id, name: 'F', type: 'Soup' },
      { dishId: 'ghost', name: 'Ghost', type: 'Soup' },
    ],
  }] as Catering[];
  S.planner = {};
});

describe('calcRequiredLive ≡ rebuildPlanner() + calcRequired', () => {
  test('matches the cached path for every batch (peer-share, type split, catering, past services)', () => {
    rebuildPlanner();
    for (const b of S.batches) {
      expect(calcRequiredLive(b)).toBe(calcRequired(b));
    }
  });

  test('produces the expected peer-share liters (not silently zero on both sides)', () => {
    rebuildPlanner();
    // A: Wed-lunch-west shared with B → 100 guests / 2 peers × 0.28 = 14.0;
    //    Thu-dinner-west alone → 110 / 1 × 0.28 = 30.8. Total 44.8.
    expect(calcRequiredLive(batchA)).toBe(44.8);
    // D: alone at Fri-dinner-centraal → 70 guests × 0.28 = 19.6.
    expect(calcRequiredLive(batchD)).toBe(19.6);
    // F: Fri-lunch-west alone → 80 × 0.28 = 22.4; + catering 50 / 2 dishes × 0.28 = 7.0.
    expect(calcRequiredLive(batchF)).toBe(29.4);
    // E: the 1 May service is past and skipped; only Thu-lunch-centraal counts
    //    → 80 × 0.28 = 22.4. Confirms past services drop out of both paths.
    expect(calcRequiredLive(batchE)).toBe(22.4);
  });

  test('still matches after a speculative services.push (the scored-algorithm pattern)', () => {
    // Mimics scoredHardConstraintsOk: tentatively add a service, read demand,
    // then pop. calcRequiredLive must reflect the pushed service WITHOUT a
    // rebuild — and equal what the cached path returns after a real rebuild.
    batchD.services.push({ loc: 'centraal', date: '2026-05-07', meal: 'dinner' });
    const live = calcRequiredLive(batchD);
    rebuildPlanner();
    const cached = calcRequired(batchD);
    batchD.services.pop();
    expect(live).toBe(cached);
  });
});
