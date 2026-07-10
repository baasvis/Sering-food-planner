/**
 * Live alarm board (public/js/alarm-board.ts) — the "issues" counter on the
 * West planner header.
 *
 * collectLiveAlarms() reuses the collectWarnings check functions from
 * menu-fixer.ts (stockout / stale / over-pot-cap / catering-no-dishes) and
 * adds its own emergency-dish check, all over a 7-day horizon. These tests
 * pin down:
 *   - which batches count as "emergency dishes" (generated + Emergency
 *     cookNotes + an upcoming service inside the horizon),
 *   - that filling in a recipe (generated flips false) clears the alarm,
 *   - the reused checks fire through the live path (cached calcRequired),
 *   - over-pot-cap is restricted to upcoming cooks on the live board,
 *   - catering horizon windowing.
 *
 * Browser-global stubs come from test/setup-dom-stubs.ts (jest setupFiles).
 */

import type { Batch, Catering, DishType, Service } from '../shared/types';
import { S } from '../public/js/state';
import { rebuildPlanner } from '../public/js/core';
import { collectLiveAlarms, emergencyDishAlarms } from '../public/js/alarm-board';

// Pin "today" to Monday 4 May 2026 (same anchor as core-demand.test.ts).
// The 7-day live horizon then ends Sunday 10 May.
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
    cookDate: '06/05/2026',
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

function alarmsOf(category: string) {
  rebuildPlanner();
  return collectLiveAlarms().filter(a => a.category === category);
}

beforeEach(() => {
  _id = 0;
  // Explicit guest counts so expected liters are self-contained.
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
  S.batches = [];
  S.caterings = [];
  S.planner = {};
  // Generous equipment so nothing over-pot-caps unless a test wants it to.
  S.kitchenEquipment = { pots: [200], gasBurners: 6, inductionBurners: 6, bigBurnerThreshold: 80 };
});

describe('baseline', () => {
  test('a healthy plan produces zero alarms', () => {
    S.batches = [
      mk('Soup', [{ loc: 'west', date: '2026-05-06', meal: 'lunch' }], {
        cookDate: '03/05/2026',
        inventory: [{ loc: 'west', storage: 'Gastro', qty: 40, cookDate: '03/05/2026' }],
      }),
    ];
    rebuildPlanner();
    expect(collectLiveAlarms()).toEqual([]);
  });
});

describe('emergency-dish', () => {
  test('fallback-ladder emergency placeholder with an upcoming service alarms', () => {
    S.batches = [
      mk('Soup', [{ loc: 'west', date: '2026-05-06', meal: 'lunch' }], {
        name: 'Wed emergency soup W 06/05',
        generated: true,
        cookNotes: 'Emergency cook (auto-created by Fix My Menu)',
        inventory: [{ loc: 'west', storage: 'Gastro', qty: 0, cookDate: '06/05/2026' }],
      }),
    ];
    const alarms = alarmsOf('emergency-dish');
    expect(alarms).toHaveLength(1);
    expect(alarms[0].message).toContain('Wed emergency soup W 06/05');
    expect(alarms[0].message).toContain('Wed lunch at West');
    expect(alarms[0].anchor).toEqual({ kind: 'batch', batchId: S.batches[0].id });
  });

  test('"Emergency morning cook" batches alarm too, and extra services are counted', () => {
    S.batches = [
      mk('Main course', [
        { loc: 'west', date: '2026-05-07', meal: 'dinner' },
        { loc: 'west', date: '2026-05-06', meal: 'lunch' },
      ], {
        name: 'Wednesday Main (Emergency)',
        generated: true,
        cookNotes: 'Emergency morning cook',
      }),
    ];
    const alarms = alarmsOf('emergency-dish');
    expect(alarms).toHaveLength(1);
    // Earliest upcoming service leads the message; the second one is summarized.
    expect(alarms[0].message).toContain('Wed lunch at West');
    expect(alarms[0].message).toContain('+1 more service');
  });

  test('filling in a real recipe (generated flips false) clears the alarm', () => {
    S.batches = [
      mk('Soup', [{ loc: 'west', date: '2026-05-06', meal: 'lunch' }], {
        generated: false, // planner.ts sets this when a recipe is filled in
        cookNotes: 'Emergency morning cook',
      }),
    ];
    expect(alarmsOf('emergency-dish')).toHaveLength(0);
  });

  test('normal rhythm placeholders are routine, not alarms', () => {
    S.batches = [
      mk('Soup', [{ loc: 'west', date: '2026-05-06', meal: 'lunch' }], {
        generated: true,
        cookNotes: '', // rhythm placeholder — not an emergency
      }),
    ];
    expect(alarmsOf('emergency-dish')).toHaveLength(0);
  });

  test('a cooked emergency stand-in keeps alarming until replaced (deliberate — no identity yet)', () => {
    S.batches = [
      mk('Soup', [{ loc: 'west', date: '2026-05-06', meal: 'lunch' }], {
        name: 'Monday Soup (Emergency)',
        generated: true,
        cookNotes: 'Emergency morning cook',
        cookDate: '04/05/2026',
        // Cooked this morning: 30L covers the 28L demand, so no stockout —
        // only the emergency alarm should fire, with the cooked wording.
        inventory: [{ loc: 'west', storage: 'Gastro', qty: 30, cookDate: '04/05/2026' }],
      }),
    ];
    rebuildPlanner();
    const all = collectLiveAlarms();
    expect(all).toHaveLength(1);
    expect(all[0].category).toBe('emergency-dish');
    expect(all[0].message).toContain('still no recipe');
  });

  test('horizon boundary: a service exactly on day 7 alarms, day 8 stays quiet', () => {
    // Today is Mon 4 May → horizon end is Sun 10 May (7 days inclusive).
    const atEnd = mk('Soup', [{ loc: 'west', date: '2026-05-10', meal: 'lunch' }], {
      generated: true, cookNotes: 'Emergency morning cook', cookDate: '10/05/2026',
    });
    S.batches = [atEnd];
    expect(alarmsOf('emergency-dish')).toHaveLength(1);

    const dayAfter = mk('Soup', [{ loc: 'west', date: '2026-05-11', meal: 'lunch' }], {
      generated: true, cookNotes: 'Emergency morning cook', cookDate: '11/05/2026',
    });
    S.batches = [dayAfter];
    expect(alarmsOf('emergency-dish')).toHaveLength(0);
  });

  test('emergencies with only past services or services beyond the 7-day horizon stay quiet', () => {
    const past = mk('Soup', [{ loc: 'west', date: '2026-05-01', meal: 'lunch' }], {
      generated: true, cookNotes: 'Emergency morning cook', cookDate: '01/05/2026',
    });
    const farOut = mk('Soup', [{ loc: 'west', date: '2026-05-12', meal: 'lunch' }], {
      generated: true, cookNotes: 'Emergency morning cook', cookDate: '12/05/2026',
    });
    S.batches = [past, farOut];
    expect(alarmsOf('emergency-dish')).toHaveLength(0);
    // Direct unit check of the windowing helper: horizon end 10 May.
    expect(emergencyDishAlarms([farOut], '2026-05-12')).toHaveLength(1);
  });
});

describe('reused collectWarnings checks through the live path', () => {
  test('cooked-stockout: cooked batch short on demand alarms; covered batch does not', () => {
    const short = mk('Soup', [{ loc: 'west', date: '2026-05-06', meal: 'lunch' }], {
      name: 'Short soup', cookDate: '03/05/2026',
      inventory: [{ loc: 'west', storage: 'Gastro', qty: 10, cookDate: '03/05/2026' }],
    });
    const covered = mk('Main course', [{ loc: 'west', date: '2026-05-06', meal: 'lunch' }], {
      name: 'Covered main', cookDate: '03/05/2026',
      inventory: [{ loc: 'west', storage: 'Gastro', qty: 40, cookDate: '03/05/2026' }],
    });
    S.batches = [short, covered];
    const alarms = alarmsOf('cooked-stockout');
    // Short soup: 100 guests × 0.28 = 28L demand vs 10L stock.
    expect(alarms).toHaveLength(1);
    expect(alarms[0].message).toContain('Short soup');
  });

  test('stale-with-stock: 4+ day old unfrozen stock alarms; 3-day, frozen and fresh stock do not', () => {
    // Today is 2026-05-04. 30/04 = 4 days old (alarms); 01/05 = 3 days old
    // (inside the threshold since the 2026-07-10 bump 3 → 4 — no alarm).
    const stale = mk('Soup', [], {
      name: 'Old soup', cookDate: '30/04/2026',
      inventory: [{ loc: 'west', storage: 'Gastro', qty: 6, cookDate: '30/04/2026' }],
    });
    const threeDays = mk('Soup', [], {
      name: 'Three-day soup', cookDate: '01/05/2026',
      inventory: [{ loc: 'west', storage: 'Gastro', qty: 6, cookDate: '01/05/2026' }],
    });
    const frozen = mk('Soup', [], {
      name: 'Frozen soup', cookDate: '30/04/2026',
      inventory: [{ loc: 'west', storage: 'Frozen', qty: 6, cookDate: '30/04/2026' }],
    });
    const fresh = mk('Soup', [], {
      name: 'Fresh soup', cookDate: '03/05/2026',
      inventory: [{ loc: 'west', storage: 'Gastro', qty: 6, cookDate: '03/05/2026' }],
    });
    S.batches = [stale, threeDays, frozen, fresh];
    const alarms = alarmsOf('stale-with-stock');
    expect(alarms).toHaveLength(1);
    expect(alarms[0].message).toContain('Old soup');
    // The stale alarm keeps its quick actions (assign / freeze).
    expect((alarms[0].actions || []).map(a => a.kind).sort()).toEqual(['assign-anyway', 'move-to-freezer']);
  });

  test('over-pot-cap: upcoming cook bigger than the biggest pot alarms; past cooks are left alone', () => {
    S.kitchenEquipment = { pots: [50], gasBurners: 6, inductionBurners: 6, bigBurnerThreshold: 80 };
    // 100×0.28 + 110×0.28 = 58.8L > 50L pot.
    const bigServices: Service[] = [
      { loc: 'west', date: '2026-05-06', meal: 'lunch' },
      { loc: 'west', date: '2026-05-07', meal: 'dinner' },
    ];
    const upcoming = mk('Soup', bigServices, { name: 'Big upcoming', cookDate: '06/05/2026' });
    S.batches = [upcoming];
    let alarms = alarmsOf('over-pot-cap');
    expect(alarms).toHaveLength(1);
    expect(alarms[0].message).toContain('Big upcoming');

    // Same demand but cooked in the past: nothing the cook can re-plan — quiet.
    S.batches = [mk('Soup', bigServices, { name: 'Big already cooked', cookDate: '01/05/2026' })];
    alarms = alarmsOf('over-pot-cap');
    expect(alarms).toHaveLength(0);
  });

  test('catering-no-dishes: dated catering inside the horizon with nothing picked alarms', () => {
    S.caterings = [
      { id: 'c-empty', name: 'Empty', date: '08/05/2026', guestCount: 30, deliveryMode: 'pickup', dishes: [], logisticsNotes: '' },
      { id: 'c-filled', name: 'Filled', date: '08/05/2026', guestCount: 30, deliveryMode: 'pickup', dishes: [{ dishId: 'x', name: 'X', type: 'Soup' }], logisticsNotes: '' },
      { id: 'c-far', name: 'Far out', date: '20/05/2026', guestCount: 30, deliveryMode: 'pickup', dishes: [], logisticsNotes: '' },
      { id: 'c-undated', name: 'Undated', date: null, guestCount: 30, deliveryMode: 'pickup', dishes: [], logisticsNotes: '' },
    ] as Catering[];
    const alarms = alarmsOf('catering-no-dishes');
    expect(alarms).toHaveLength(1);
    expect(alarms[0].anchor).toEqual({ kind: 'catering', cateringId: 'c-empty' });
  });

  test('catering horizon boundary: day 7 alarms, day 8 stays quiet', () => {
    S.caterings = [
      { id: 'c-end', name: 'At end', date: '10/05/2026', guestCount: 30, deliveryMode: 'pickup', dishes: [], logisticsNotes: '' },
      { id: 'c-past-end', name: 'Past end', date: '11/05/2026', guestCount: 30, deliveryMode: 'pickup', dishes: [], logisticsNotes: '' },
    ] as Catering[];
    const alarms = alarmsOf('catering-no-dishes');
    expect(alarms).toHaveLength(1);
    expect(alarms[0].anchor).toEqual({ kind: 'catering', cateringId: 'c-end' });
  });
});
