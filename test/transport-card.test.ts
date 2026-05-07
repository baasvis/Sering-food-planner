/**
 * Unit tests for the transport card's pure-logic exports.
 *
 *   - computeTransportPlan: lean / bulk / destination-stock / horizon edges
 *   - nextCentraalSlots: chronology + horizon truncation + past filtering
 *   - dishIdentity: recipeId vs normalized-name fallback
 *   - getReadiness: inventory + cook + fix-my-menu coverage
 *   - wasFixMyMenuRunToday + markFixMyMenuRun: localStorage round-trip
 */

// localStorage stub before importing the module under test (Jest runs in Node).
const _store: Record<string, string> = {};
Object.defineProperty(global, 'localStorage', {
  value: {
    getItem: (k: string) => _store[k] ?? null,
    setItem: (k: string, v: string) => { _store[k] = v; },
    removeItem: (k: string) => { delete _store[k]; },
    clear: () => { Object.keys(_store).forEach(k => delete _store[k]); },
  },
  writable: true,
});

import type { Batch, DishType, Location, StorageType } from '../shared/types';
import {
  computeTransportPlan,
  nextCentraalSlots,
  dishIdentity,
  getReadiness,
  wasFixMyMenuRunToday,
  markFixMyMenuRun,
  countPendingUncookedForCentraal,
} from '../public/js/transport-card';
import { recomputeFamilyAllocations } from '../public/js/core';
import { S } from '../public/js/state';

let _id = 0;
const nextId = () => `b-${++_id}`;

function makeBatch(overrides: Partial<Batch> & { type: DishType }): Batch {
  return {
    id: nextId(),
    name: overrides.name || 'Test',
    type: overrides.type,
    stock: 0,
    serving: 280,
    storage: 'Gastro' as StorageType,
    location: 'west' as Location,
    inTransit: false,
    allergens: [],
    extraAllergens: [],
    orderFor: false,
    parentId: null,
    cookDate: '01/05/2026',
    recipeSheetId: null,
    recipeVolume: null,
    recipeIngredients: null,
    note: '',
    services: [],
    createdAt: '2026-05-01T00:00:00.000Z',
    recipeId: null,
    actualIngredients: null,
    cookNotes: '',
    stockDeducted: false,
    generated: false,
    ...overrides,
  };
}

function rebuildPlannerFromBatches(batches: Batch[]) {
  S.batches = batches;
  S.planner = {};
  for (const b of batches) {
    for (const svc of b.services || []) {
      const k = `${svc.loc}-${svc.date}-${svc.meal}`;
      if (!S.planner[k]) S.planner[k] = [];
      S.planner[k].push(b);
    }
  }
  recomputeFamilyAllocations();
}

// Pin clock to a stable Friday in early May 2026 so the future-dated services
// stay future. isServicePast otherwise filters them out and tests fail at the
// horizon boundary.
beforeAll(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-05-01T08:00:00Z'));
});
afterAll(() => {
  jest.useRealTimers();
});

beforeEach(() => {
  _id = 0;
  S.guests = {
    centraal: { Mon:{lunch:80,dinner:85}, Tue:{lunch:80,dinner:85}, Wed:{lunch:80,dinner:85}, Thu:{lunch:80,dinner:85}, Fri:{lunch:60,dinner:70}, Sat:{lunch:0,dinner:0}, Sun:{lunch:0,dinner:0} },
    west: { Mon:{lunch:100,dinner:110}, Tue:{lunch:100,dinner:110}, Wed:{lunch:100,dinner:110}, Thu:{lunch:100,dinner:110}, Fri:{lunch:80,dinner:90}, Sat:{lunch:0,dinner:0}, Sun:{lunch:0,dinner:0} },
  } as any;
  S.batches = [];
  S.planner = {};
  S.caterings = [];
  S.guestsNextWeeks = {};
  S.inventoryCompletions = { west:{lunch:null,dinner:null}, centraal:{lunch:null,dinner:null} };
  Object.keys(_store).forEach(k => delete _store[k]);
});

// ── dishIdentity ─────────────────────────────────────────────────────────

describe('dishIdentity', () => {
  test('uses recipeId when set', () => {
    const b = makeBatch({ type: 'Soup', name: 'Tomato', recipeId: 'rec-123' });
    expect(dishIdentity(b)).toBe('r:rec-123');
  });

  test('falls back to normalized name when recipeId is null', () => {
    const b = makeBatch({ type: 'Soup', name: 'Tomato Soup' });
    expect(dishIdentity(b)).toBe('n:tomato soup');
  });

  test('strips trailing " (split)" suffix in name fallback', () => {
    const a = makeBatch({ type: 'Soup', name: 'Tomato Soup' });
    const b = makeBatch({ type: 'Soup', name: 'Tomato Soup (split)' });
    expect(dishIdentity(a)).toBe(dishIdentity(b));
  });

  test('case-insensitive name match', () => {
    const a = makeBatch({ type: 'Soup', name: 'Miso & Ginger Soup' });
    const b = makeBatch({ type: 'Soup', name: 'miso & ginger soup' });
    expect(dishIdentity(a)).toBe(dishIdentity(b));
  });
});

// ── nextCentraalSlots ────────────────────────────────────────────────────

describe('nextCentraalSlots', () => {
  test('returns empty for batches with no Centraal services', () => {
    const b = makeBatch({ type: 'Soup', services: [{ loc: 'west', date: '2026-05-04', meal: 'lunch' }] });
    expect(nextCentraalSlots([b], 3)).toEqual([]);
  });

  test('returns slots in chronological order, capped at n', () => {
    const b = makeBatch({
      type: 'Soup',
      services: [
        { loc: 'centraal', date: '2026-05-06', meal: 'lunch' },
        { loc: 'centraal', date: '2026-05-04', meal: 'dinner' },
        { loc: 'centraal', date: '2026-05-04', meal: 'lunch' },
        { loc: 'centraal', date: '2026-05-05', meal: 'lunch' },
      ],
    });
    const slots = nextCentraalSlots([b], 3);
    expect(slots.map(s => `${s.date} ${s.meal}`)).toEqual([
      '2026-05-04 lunch',
      '2026-05-04 dinner',
      '2026-05-05 lunch',
    ]);
  });

  test('deduplicates the same slot across multiple batches', () => {
    const a = makeBatch({ type: 'Soup', services: [{ loc: 'centraal', date: '2026-05-04', meal: 'lunch' }] });
    const b = makeBatch({ type: 'Main course', services: [{ loc: 'centraal', date: '2026-05-04', meal: 'lunch' }] });
    expect(nextCentraalSlots([a, b], 3)).toHaveLength(1);
  });
});

// ── computeTransportPlan: lean ───────────────────────────────────────────

describe('computeTransportPlan — lean', () => {
  test('empty input → empty plan', () => {
    rebuildPlannerFromBatches([]);
    expect(computeTransportPlan('lean', [])).toEqual([]);
  });

  test('West cooked batch with Centraal service shows up in lean plan', () => {
    const b = makeBatch({
      type: 'Soup',
      name: 'Tomato',
      stock: 30,
      location: 'west',
      services: [{ loc: 'centraal', date: '2026-05-04', meal: 'dinner' }],
    });
    rebuildPlannerFromBatches([b]);
    const plan = computeTransportPlan('lean', [b]);
    expect(plan).toHaveLength(1);
    expect(plan[0].batchId).toBe(b.id);
    expect(plan[0].sendQty).toBeGreaterThan(0);
  });

  test('in-transit West batches are excluded', () => {
    const b = makeBatch({
      type: 'Soup',
      stock: 30,
      location: 'west',
      inTransit: true,
      services: [{ loc: 'centraal', date: '2026-05-04', meal: 'dinner' }],
    });
    rebuildPlannerFromBatches([b]);
    expect(computeTransportPlan('lean', [b])).toEqual([]);
  });

  test('uncooked (stock=0) West batches are excluded', () => {
    const b = makeBatch({
      type: 'Soup',
      stock: 0, // uncooked placeholder
      location: 'west',
      services: [{ loc: 'centraal', date: '2026-05-04', meal: 'dinner' }],
    });
    rebuildPlannerFromBatches([b]);
    expect(computeTransportPlan('lean', [b])).toEqual([]);
  });

  test('Centraal-only services beyond the 3-slot horizon are excluded from lean', () => {
    // 4 distinct Centraal slots; the 4th should not appear in any row's
    // service list.
    const b = makeBatch({
      type: 'Soup',
      stock: 100,
      location: 'west',
      services: [
        { loc: 'centraal', date: '2026-05-04', meal: 'lunch' },
        { loc: 'centraal', date: '2026-05-04', meal: 'dinner' },
        { loc: 'centraal', date: '2026-05-05', meal: 'lunch' },
        { loc: 'centraal', date: '2026-05-08', meal: 'dinner' }, // out of horizon
      ],
    });
    rebuildPlannerFromBatches([b]);
    const plan = computeTransportPlan('lean', [b]);
    expect(plan).toHaveLength(1);
    expect(plan[0].services.map(s => s.date)).not.toContain('2026-05-08');
  });

  test('West-only services produce no transport rows', () => {
    const b = makeBatch({
      type: 'Soup',
      stock: 30,
      location: 'west',
      services: [{ loc: 'west', date: '2026-05-04', meal: 'dinner' }],
    });
    rebuildPlannerFromBatches([b]);
    expect(computeTransportPlan('lean', [b])).toEqual([]);
  });
});

// ── computeTransportPlan: destination subtraction ────────────────────────

describe('computeTransportPlan — destination subtraction', () => {
  test('Centraal stock of the same dish reduces the row sendQty', () => {
    const w = makeBatch({
      type: 'Soup',
      name: 'Tomato',
      stock: 100,
      location: 'west',
      services: [{ loc: 'centraal', date: '2026-05-04', meal: 'dinner' }],
    });
    const c = makeBatch({
      type: 'Soup',
      name: 'Tomato',
      stock: 5,
      location: 'centraal', // already at Centraal
      inTransit: false,
    });
    rebuildPlannerFromBatches([w, c]);
    const plan = computeTransportPlan('lean', [w, c]);
    expect(plan).toHaveLength(1);
    expect(plan[0].destStock).toBeGreaterThan(0);
    // sendQty + destStock should still cover the demand (or hit batch.stock cap)
    expect(plan[0].sendQty + plan[0].destStock).toBeLessThanOrEqual(plan[0].totalDemand + 0.1);
  });

  test('in-transit Centraal stock does NOT count toward subtraction', () => {
    const w = makeBatch({
      type: 'Soup',
      name: 'Tomato',
      stock: 100,
      location: 'west',
      services: [{ loc: 'centraal', date: '2026-05-04', meal: 'dinner' }],
    });
    const inFlight = makeBatch({
      type: 'Soup',
      name: 'Tomato',
      stock: 5,
      location: 'centraal',
      inTransit: true, // not yet arrived
    });
    rebuildPlannerFromBatches([w, inFlight]);
    const plan = computeTransportPlan('lean', [w, inFlight]);
    expect(plan).toHaveLength(1);
    expect(plan[0].destStock).toBe(0);
  });

  test('destination stock equal to demand → row drops out (sendQty = 0)', () => {
    const w = makeBatch({
      type: 'Soup',
      name: 'Tomato',
      stock: 100,
      location: 'west',
      services: [{ loc: 'centraal', date: '2026-05-04', meal: 'dinner' }],
    });
    const c = makeBatch({
      type: 'Soup',
      name: 'Tomato',
      stock: 1000, // way more than needed
      location: 'centraal',
    });
    rebuildPlannerFromBatches([w, c]);
    expect(computeTransportPlan('lean', [w, c])).toEqual([]);
  });

  test('two West splits of the same dish do not double-consume Centraal stock', () => {
    // Two West splits, both ship to Centraal. Centraal already has 5L.
    // Without proper accounting both rows would each subtract 5L.
    const a = makeBatch({
      type: 'Soup',
      name: 'Tomato',
      stock: 50,
      location: 'west',
      services: [{ loc: 'centraal', date: '2026-05-04', meal: 'dinner' }],
    });
    const b = makeBatch({
      type: 'Soup',
      name: 'Tomato',
      stock: 50,
      location: 'west',
      services: [{ loc: 'centraal', date: '2026-05-05', meal: 'dinner' }],
    });
    const c = makeBatch({
      type: 'Soup',
      name: 'Tomato',
      stock: 5,
      location: 'centraal',
    });
    rebuildPlannerFromBatches([a, b, c]);
    const plan = computeTransportPlan('lean', [a, b, c]);
    const totalSubtracted = plan.reduce((s, r) => s + r.destStock, 0);
    expect(totalSubtracted).toBeLessThanOrEqual(5 + 0.1);
  });
});

// ── computeTransportPlan: bulk ───────────────────────────────────────────

describe('computeTransportPlan — bulk', () => {
  test('bulk consolidates extra services from another West batch of the same dish', () => {
    // Lean horizon is the next 3 Centraal slots. Batch A covers them.
    // Batch B (same dish, different West split) has a Centraal service
    // beyond the 3-slot window but within the bulk horizon (7 days).
    // Bulk mode should fold B's demand into the plan.
    const a = makeBatch({
      type: 'Soup',
      name: 'Tomato',
      stock: 100,
      location: 'west',
      services: [
        { loc: 'centraal', date: '2026-05-04', meal: 'lunch' },
        { loc: 'centraal', date: '2026-05-04', meal: 'dinner' },
        { loc: 'centraal', date: '2026-05-05', meal: 'lunch' },
      ],
    });
    const b = makeBatch({
      type: 'Soup',
      name: 'Tomato',
      stock: 100,
      location: 'west',
      services: [{ loc: 'centraal', date: '2026-05-06', meal: 'dinner' }], // beyond lean
    });

    rebuildPlannerFromBatches([a, b]);
    const lean = computeTransportPlan('lean', [a, b]);
    const bulk = computeTransportPlan('bulk', [a, b]);
    const leanTotal = lean.reduce((s, r) => s + r.sendQty, 0);
    const bulkTotal = bulk.reduce((s, r) => s + r.sendQty, 0);
    expect(bulkTotal).toBeGreaterThan(leanTotal);

    // The bulk row for batch B should have future=true.
    const bRow = bulk.find(r => r.batchId === b.id);
    expect(bRow).toBeDefined();
    expect(bRow!.future).toBe(true);
  });

  test('bulk does NOT pull in batches of dishes that have no lean service', () => {
    // Saturate the lean horizon (3 distinct Centraal slots) with Tomato so
    // the Coconut batch's only Centraal service falls outside that window
    // entirely. Bulk's "consolidate by dish" should then NOT bring Coconut
    // in — it consolidates dishes that already have a lean row, not
    // standalone late-week batches.
    const tomato = makeBatch({
      type: 'Soup',
      name: 'Tomato',
      stock: 100,
      location: 'west',
      services: [
        { loc: 'centraal', date: '2026-05-04', meal: 'lunch' },
        { loc: 'centraal', date: '2026-05-04', meal: 'dinner' },
        { loc: 'centraal', date: '2026-05-05', meal: 'lunch' },
      ],
    });
    const coconut = makeBatch({
      type: 'Soup',
      name: 'Coconut',
      stock: 30,
      location: 'west',
      services: [{ loc: 'centraal', date: '2026-05-06', meal: 'dinner' }], // beyond lean
    });
    rebuildPlannerFromBatches([tomato, coconut]);
    const bulk = computeTransportPlan('bulk', [tomato, coconut]);
    expect(bulk.find(r => r.batchId === coconut.id)).toBeUndefined();
  });

  test('bulk excludes services beyond BULK_HORIZON_DAYS (7)', () => {
    // Saturate the lean horizon (3 distinct slots) with batch A so batch B's
    // services live entirely in bulk territory. B has a service 5 days out
    // (in bulk) and one 30 days out (out of bulk). Bulk should fold in only
    // the close one.
    const a = makeBatch({
      type: 'Soup',
      name: 'Tomato',
      stock: 100,
      location: 'west',
      services: [
        { loc: 'centraal', date: '2026-05-04', meal: 'lunch' },
        { loc: 'centraal', date: '2026-05-04', meal: 'dinner' },
        { loc: 'centraal', date: '2026-05-05', meal: 'lunch' },
      ],
    });
    const b = makeBatch({
      type: 'Soup',
      name: 'Tomato',
      stock: 100,
      location: 'west',
      services: [
        { loc: 'centraal', date: '2026-05-06', meal: 'dinner' }, // ~5 days, in bulk window
        { loc: 'centraal', date: '2026-06-01', meal: 'dinner' }, // 30 days, OUT
      ],
    });
    rebuildPlannerFromBatches([a, b]);
    const bulk = computeTransportPlan('bulk', [a, b]);
    const bRow = bulk.find(r => r.batchId === b.id);
    expect(bRow).toBeDefined();
    expect(bRow!.services.map(s => s.date)).not.toContain('2026-06-01');
  });
});

// ── readiness ────────────────────────────────────────────────────────────

describe('getReadiness', () => {
  test('all-false default when nothing has happened today', () => {
    const r = getReadiness([], { west:{lunch:null,dinner:null}, centraal:{lunch:null,dinner:null} });
    expect(r).toEqual({ inventoryDone: false, cookDone: true, fixMyMenuRun: false, allReady: false });
  });

  test('inventoryDone=true when West lunch was finished today', () => {
    const inv = { west: { lunch: '2026-05-01T08:00:00Z', dinner: null }, centraal: { lunch: null, dinner: null } };
    const r = getReadiness([], inv);
    expect(r.inventoryDone).toBe(true);
  });

  test('inventoryDone=false when the only completion was yesterday', () => {
    const inv = { west: { lunch: '2026-04-30T20:00:00Z', dinner: null }, centraal: { lunch: null, dinner: null } };
    const r = getReadiness([], inv);
    expect(r.inventoryDone).toBe(false);
  });

  test('cookDone=false when a today-service West batch has no cookDate', () => {
    const b = makeBatch({
      type: 'Soup',
      cookDate: null,
      location: 'west',
      services: [{ loc: 'west', date: '2026-05-01', meal: 'dinner' }], // today
    });
    const r = getReadiness([b], { west:{lunch:null,dinner:null}, centraal:{lunch:null,dinner:null} });
    expect(r.cookDone).toBe(false);
  });

  test('cookDone=true when every today-service West batch has a cookDate', () => {
    const b = makeBatch({
      type: 'Soup',
      cookDate: '01/05/2026',
      location: 'west',
      services: [{ loc: 'west', date: '2026-05-01', meal: 'dinner' }],
    });
    const r = getReadiness([b], { west:{lunch:null,dinner:null}, centraal:{lunch:null,dinner:null} });
    expect(r.cookDone).toBe(true);
  });

  test('allReady true iff all three signals true', () => {
    markFixMyMenuRun(); // sets localStorage now
    const inv = { west: { lunch: '2026-05-01T08:00:00Z', dinner: null }, centraal: { lunch: null, dinner: null } };
    const r = getReadiness([], inv);
    expect(r.allReady).toBe(true);
  });
});

// ── Fix-my-menu run flag ─────────────────────────────────────────────────

describe('wasFixMyMenuRunToday / markFixMyMenuRun', () => {
  test('returns false when nothing stored', () => {
    expect(wasFixMyMenuRunToday()).toBe(false);
  });

  test('returns true after markFixMyMenuRun', () => {
    markFixMyMenuRun();
    expect(wasFixMyMenuRunToday()).toBe(true);
  });

  test('returns false when stored timestamp is from yesterday', () => {
    _store['sering-fix-my-menu-last-run'] = '2026-04-30T18:00:00Z';
    expect(wasFixMyMenuRunToday()).toBe(false);
  });

  test('returns false on garbage stored value', () => {
    _store['sering-fix-my-menu-last-run'] = 'not a date';
    expect(wasFixMyMenuRunToday()).toBe(false);
  });
});

// ── Pending-uncooked counter ─────────────────────────────────────────────

describe('countPendingUncookedForCentraal', () => {
  // Use future dates so isServicePast doesn't filter them out — the function
  // mirrors computeTransportPlan's horizon detection.
  const future = '2099-01-15';

  test('returns 0 when no batches exist', () => {
    expect(countPendingUncookedForCentraal([])).toBe(0);
  });

  test('returns 0 when only cooked batches are scheduled', () => {
    const b = makeBatch({
      type: 'Soup', stock: 5, cookDate: '01/05/2026',
      services: [{ loc: 'centraal', date: future, meal: 'lunch', qty: 8 } as any],
    });
    expect(countPendingUncookedForCentraal([b])).toBe(0);
  });

  test('returns 1 for a West batch scheduled for Centraal that is uncooked (stock=0)', () => {
    const b = makeBatch({
      type: 'Soup', stock: 0, cookDate: null as any,
      services: [{ loc: 'centraal', date: future, meal: 'lunch', qty: 8 } as any],
    });
    expect(countPendingUncookedForCentraal([b])).toBe(1);
  });

  test('excludes in-transit West batches', () => {
    const b = makeBatch({
      type: 'Soup', stock: 0, cookDate: null as any, inTransit: true,
      services: [{ loc: 'centraal', date: future, meal: 'lunch', qty: 8 } as any],
    });
    expect(countPendingUncookedForCentraal([b])).toBe(0);
  });

  test('excludes Centraal-located batches', () => {
    const b = makeBatch({
      type: 'Soup', stock: 0, cookDate: null as any, location: 'centraal' as Location,
      services: [{ loc: 'centraal', date: future, meal: 'lunch', qty: 8 } as any],
    });
    expect(countPendingUncookedForCentraal([b])).toBe(0);
  });

  test('counts multiple uncooked batches with Centraal services in the horizon', () => {
    const a = makeBatch({
      type: 'Soup', stock: 0, cookDate: null as any,
      services: [{ loc: 'centraal', date: future, meal: 'lunch', qty: 8 } as any],
    });
    const b = makeBatch({
      type: 'Main course', stock: 0, cookDate: null as any,
      services: [{ loc: 'centraal', date: future, meal: 'dinner', qty: 6 } as any],
    });
    expect(countPendingUncookedForCentraal([a, b])).toBe(2);
  });
});
