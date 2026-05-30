/**
 * Unit tests for the unified-batch Fix My Menu (Checkpoint 5.4 rewrite).
 *
 * Old test file structured around `assignServicesPass1..5` + `collectWarnings`
 * + `isStaleAtSlot` — all deleted in Checkpoint 4 when menu-fixer was rewritten
 * around the new `forcedAssignmentPrePass` + `scoredGreedyAssignment` +
 * `runFallbackLadder` algorithm. This is a fresh suite for the kept exports.
 *
 * Unified-batch model (post-C5):
 *   - `stock` / `location` / `storage` / `inTransit` / `parentId` are GONE.
 *     A batch's per-loc stock lives in `inventory[]`. Cook location is
 *     derived from `inventory[0].loc` (primaryLoc heuristic in menu-fixer.ts).
 *   - Cross-batch same-recipe duplicates stay separate (audit S7) — the
 *     algorithm reads per-batch totals via `getTotalStock`, not family rolls.
 *
 * Test coverage:
 *   - isServableBy: cook-day rules + Centraal next-morning + no reverse delivery
 *   - stripFutureServices, findOrphanPlaceholders, findSpentBatches
 *   - generateMissingPlaceholders: rhythm fill, partial coverage, over-rhythm
 *   - countTypeInSlot, alreadyInSlot
 *   - allocatePotCaps: empty equipment, demand-based assignment, overflow
 *   - scoredGreedyAssignment: hard-constraint exclusions, slot urgency, lunch/dinner cookDate scoring
 *   - forcedAssignmentPrePass: singleton commit, no-candidate skip
 *   - runFallbackLadder: emergency placeholder creation, team formation
 *   - idempotency: double-press produces the same final state
 *   - Constants: COOK_RHYTHM weekly totals, SLOTS_PER_TYPE, PLANNING_HORIZON_DAYS
 */

// Browser-global stubs (document, localStorage, etc.) come from
// test/setup-dom-stubs.ts in the jest setupFiles list — that runs before
// module imports here.

import type { Batch, Catering, CateringDish, DishType, InventoryEntry, Location, Meal, Service, StorageType, KitchenEquipment, CookRhythmConfig } from '../shared/types';
import {
  allocatePotCaps,
  buildPlanningWindow,
  isServableBy,
  countTypeInSlot,
  alreadyInSlot,
  findOrphanPlaceholders,
  findSpentBatches,
  findStalePlaceholders,
  dropRetiredDishesFromCaterings,
  generateMissingPlaceholders,
  snapshotBatches,
  stripFutureServices,
  forcedAssignmentPrePass,
  scoredGreedyAssignment,
  runFallbackLadder,
  getActiveRhythm,
  computeWeeklyCapacities,
  collectWarnings,
  COOK_RHYTHM,
  SLOTS_PER_TYPE,
  PLANNING_HORIZON_DAYS,
  TYPES_TO_PLAN,
  type PlanDay,
} from '../public/js/menu-fixer';
import { S } from '../public/js/state';
import { getEffectiveGuests, buildRollMap } from '../public/js/core';

// Pin the system clock to a stable Friday 1 May 2026 so the hardcoded service
// dates (2026-05-04..10) stay in the future relative to "now". Several
// algorithm helpers call `isServicePast` internally; without this, a slot that
// fell into the past would silently pass eligibility checks.
beforeAll(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-05-01T08:00:00Z'));
});
afterAll(() => {
  jest.useRealTimers();
});

// ── Helpers ─────────────────────────────────────────────────────────────────

let _idCounter = 0;
function nextId() { return `b-${++_idCounter}`; }

function inv(qty: number, loc: Location = 'west', storage: StorageType = 'Gastro', cookDate = '01/05/2026'): InventoryEntry {
  return { loc, storage, qty, cookDate };
}

function makeBatch(overrides: Partial<Batch> & { type: DishType; cookDate: string }): Batch {
  return {
    id: nextId(),
    name: overrides.name || 'Test',
    type: overrides.type,
    serving: 280,
    cookDate: overrides.cookDate,
    inventory: [],
    shipments: [],
    allergens: [],
    extraAllergens: [],
    orderFor: false,
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

/**
 * Build a window manually (without going through buildPlanningWindow which
 * uses the real "today" clock). All slots are non-past — what we want for
 * testing future-slot assignment in isolation.
 */
function makeWindow(days: { iso: string; dayName: string; cookDate: string }[]): PlanDay[] {
  return days.map(d => ({
    date: new Date(d.iso + 'T12:00:00'),
    isoDate: d.iso,
    cookDateStr: d.cookDate,
    dayName: d.dayName,
    slots: [
      { loc: 'centraal' as Location, meal: 'lunch' as Meal, isPast: false },
      { loc: 'centraal' as Location, meal: 'dinner' as Meal, isPast: false },
      { loc: 'west' as Location,     meal: 'lunch' as Meal, isPast: false },
      { loc: 'west' as Location,     meal: 'dinner' as Meal, isPast: false },
    ],
  }));
}

/**
 * A simple calcRequired stub: 1L per service, peers don't reduce demand.
 * Catering hold can be added via the `holds` map.
 */
function fixedCalcRequired(perService = 1, holds: Map<string, number> = new Map()) {
  return (b: Batch) => {
    const fromServices = (b.services || []).length * perService;
    const fromCatering = holds.get(b.id) || 0;
    return Math.round((fromServices + fromCatering) * 10) / 10;
  };
}

beforeEach(() => {
  _idCounter = 0;
  localStorage.clear();
});

// ─── Eligibility helper: isServableBy ──────────────────────────────────────

describe('isServableBy', () => {
  test('cookDate=Wed → not servable Wed lunch, servable Wed dinner West', () => {
    expect(isServableBy('06/05/2026', '2026-05-06', 'lunch', 'west', 'west')).toBe(false);
    expect(isServableBy('06/05/2026', '2026-05-06', 'dinner', 'west', 'west')).toBe(true);
  });
  test('cookDate=Wed → servable any later day at West', () => {
    expect(isServableBy('06/05/2026', '2026-05-07', 'lunch', 'west', 'west')).toBe(true);
    expect(isServableBy('06/05/2026', '2026-05-07', 'dinner', 'west', 'west')).toBe(true);
  });
  test('cookDate=Wed → not servable Tue', () => {
    expect(isServableBy('06/05/2026', '2026-05-05', 'lunch', 'west', 'west')).toBe(false);
    expect(isServableBy('06/05/2026', '2026-05-05', 'dinner', 'west', 'west')).toBe(false);
  });
  test('null cookDate → never servable', () => {
    expect(isServableBy(null, '2026-05-06', 'dinner', 'west', 'west')).toBe(false);
  });
  test('Centraal next-morning rule: West-cooked → not servable at Centraal on cook day', () => {
    expect(isServableBy('05/05/2026', '2026-05-05', 'dinner', 'centraal', 'west')).toBe(false);
    expect(isServableBy('05/05/2026', '2026-05-06', 'lunch', 'centraal', 'west')).toBe(true);
    expect(isServableBy('05/05/2026', '2026-05-06', 'dinner', 'centraal', 'west')).toBe(true);
  });
  test('Sunday exception: West cook reaches Centraal SAME-DAY dinner (early cook, late van), not lunch', () => {
    // 03/05/2026 is a Sunday. Sunday's cook starts very early and there is no
    // Centraal lunch, so the delivery van leaves later and reaches Centraal's
    // dinner shift the same day — unlike any other weekday.
    expect(isServableBy('03/05/2026', '2026-05-03', 'dinner', 'centraal', 'west')).toBe(true);
    expect(isServableBy('03/05/2026', '2026-05-03', 'lunch', 'centraal', 'west')).toBe(false);
    // Regression guard: a non-Sunday cook still cannot reach Centraal same-day.
    expect(isServableBy('05/05/2026', '2026-05-05', 'dinner', 'centraal', 'west')).toBe(false);
    // Sunday cook → Centraal next day stays fine.
    expect(isServableBy('03/05/2026', '2026-05-04', 'lunch', 'centraal', 'west')).toBe(true);
  });
  test('Centraal-cooked batch (rare): standard same-day-dinner rule still applies', () => {
    expect(isServableBy('05/05/2026', '2026-05-05', 'dinner', 'centraal', 'centraal')).toBe(true);
    expect(isServableBy('05/05/2026', '2026-05-05', 'lunch', 'centraal', 'centraal')).toBe(false);
  });
  test('No reverse delivery: Centraal-located batch is NEVER servable at a West slot', () => {
    // A batch whose inventory[0].loc is 'centraal' stays at Centraal — there's
    // no van going back the other way. Without this rule the algorithm would
    // assign Centraal stock to West slots, which is logistically impossible AND
    // starves Centraal of its own dedicated stock.
    expect(isServableBy('05/05/2026', '2026-05-05', 'dinner', 'west', 'centraal')).toBe(false);
    expect(isServableBy('05/05/2026', '2026-05-06', 'lunch', 'west', 'centraal')).toBe(false);
    expect(isServableBy('05/05/2026', '2026-05-07', 'dinner', 'west', 'centraal')).toBe(false);
  });
});

// ─── stripFutureServices ────────────────────────────────────────────────────

describe('stripFutureServices', () => {
  test('removes future services, keeps past ones', () => {
    const b = makeBatch({
      type: 'Soup', cookDate: '01/05/2026',
      services: [
        { loc: 'west', date: '2026-04-28', meal: 'lunch' },  // past
        { loc: 'west', date: '2026-04-30', meal: 'dinner' }, // past
        { loc: 'west', date: '2026-05-04', meal: 'lunch' },  // future
        { loc: 'centraal', date: '2026-05-08', meal: 'dinner' }, // future
      ],
    });
    const removed = stripFutureServices([b]);
    expect(removed).toBe(2);
    expect(b.services).toHaveLength(2);
    expect(b.services.every(s => s.date < '2026-05-01')).toBe(true);
  });
});

// ─── findOrphanPlaceholders ────────────────────────────────────────────────

describe('findOrphanPlaceholders', () => {
  test('finds generated empty placeholders, leaves cook-created and assigned alone', () => {
    const orphan = makeBatch({
      type: 'Soup', cookDate: '04/05/2026', name: 'Soup orphan',
      generated: true,
    });
    const cookCreated = makeBatch({
      type: 'Soup', cookDate: '04/05/2026', name: 'Soup cook',
      generated: false,
    });
    const placeholderWithService = makeBatch({
      type: 'Soup', cookDate: '04/05/2026', name: 'Placeholder assigned',
      generated: true,
      services: [{ loc: 'west', date: '2026-05-04', meal: 'dinner' }],
    });
    const placeholderWithRecipe = makeBatch({
      type: 'Soup', cookDate: '04/05/2026', name: 'Placeholder w/ recipe',
      generated: true, recipeId: 'r-1',
    });
    const found = findOrphanPlaceholders([orphan, cookCreated, placeholderWithService, placeholderWithRecipe]);
    expect(found.map(b => b.id)).toEqual([orphan.id]);
  });
});

// ─── findSpentBatches (NEW) ────────────────────────────────────────────────

describe('findSpentBatches (auto-retire — PR #58 rule)', () => {
  test('retires a Soup with empty inventory + all-arrived shipments + only-past services', () => {
    const spent = makeBatch({
      type: 'Soup', cookDate: '01/05/2026',
      inventory: [],
      shipments: [{
        id: 'sh-1', fromLoc: 'west', toLoc: 'centraal', storage: 'Gastro',
        qty: 20, sentAt: '2026-04-30T08:00:00Z', arrived: true,
        arrivedAt: '2026-04-30T13:00:00Z', cookDate: '01/05/2026',
      }],
      services: [
        { loc: 'west', date: '2026-04-29', meal: 'dinner' },
        { loc: 'centraal', date: '2026-04-30', meal: 'lunch' },
      ],
    });
    expect(findSpentBatches([spent]).map(b => b.id)).toEqual([spent.id]);
  });

  test('does NOT retire a batch with any future service', () => {
    const future = makeBatch({
      type: 'Soup', cookDate: '01/05/2026',
      inventory: [],
      services: [
        { loc: 'west', date: '2026-04-29', meal: 'dinner' }, // past
        { loc: 'west', date: '2026-05-04', meal: 'dinner' }, // future
      ],
    });
    expect(findSpentBatches([future])).toHaveLength(0);
  });

  test('does NOT retire a batch with leftover inventory qty', () => {
    const leftover = makeBatch({
      type: 'Soup', cookDate: '01/05/2026',
      inventory: [inv(2, 'west', 'Gastro', '01/05/2026')],
      services: [{ loc: 'west', date: '2026-04-29', meal: 'dinner' }],
    });
    expect(findSpentBatches([leftover])).toHaveLength(0);
  });

  test('does NOT retire a batch with a pending shipment (food still on a truck)', () => {
    const inFlight = makeBatch({
      type: 'Soup', cookDate: '01/05/2026',
      inventory: [],
      shipments: [{
        id: 'sh-1', fromLoc: 'west', toLoc: 'centraal', storage: 'Gastro',
        qty: 5, sentAt: '2026-04-30T08:00:00Z', arrived: false,
        cookDate: '01/05/2026',
      }],
      services: [{ loc: 'west', date: '2026-04-29', meal: 'dinner' }],
    });
    expect(findSpentBatches([inFlight])).toHaveLength(0);
  });

  test('does NOT retire a Dessert (only Soup + Main course types are auto-managed)', () => {
    const dessert = makeBatch({
      type: 'Dessert', cookDate: '01/05/2026',
      inventory: [],
      services: [{ loc: 'west', date: '2026-04-29', meal: 'dinner' }],
    });
    expect(findSpentBatches([dessert])).toHaveLength(0);
  });
});

// ─── findStalePlaceholders ─────────────────────────────────────────────────

describe('findStalePlaceholders (auto-retire dead placeholders)', () => {
  const TODAY = '2026-05-05';

  test('retires a generated placeholder for a cook day that has already passed', () => {
    const stale = makeBatch({
      type: 'Main course', cookDate: '02/05/2026', name: 'Sat main',
      generated: true, inventory: [],
    });
    expect(findStalePlaceholders([stale], TODAY).map(b => b.id)).toEqual([stale.id]);
  });

  test('retires a stale generated placeholder even when it has a recipe but no service', () => {
    // The case that slips through findOrphanPlaceholders (a recipe disqualifies
    // it) AND findSpentBatches (no services disqualifies it).
    const stale = makeBatch({
      type: 'Soup', cookDate: '02/05/2026', name: 'Stale w/ recipe',
      generated: true, recipeId: 'r-1', inventory: [],
    });
    expect(findStalePlaceholders([stale], TODAY).map(b => b.id)).toEqual([stale.id]);
  });

  test('does NOT retire a placeholder whose cook day is today or in the future', () => {
    const today = makeBatch({
      type: 'Soup', cookDate: '05/05/2026', name: 'Today', generated: true, inventory: [],
    });
    const future = makeBatch({
      type: 'Soup', cookDate: '07/05/2026', name: 'Future', generated: true, inventory: [],
    });
    expect(findStalePlaceholders([today, future], TODAY)).toHaveLength(0);
  });

  test('does NOT retire a past placeholder that has leftover stock (real food)', () => {
    const cooked = makeBatch({
      type: 'Soup', cookDate: '02/05/2026', name: 'Cooked', generated: true,
      inventory: [inv(40, 'west', 'Gastro', '02/05/2026')],
    });
    expect(findStalePlaceholders([cooked], TODAY)).toHaveLength(0);
  });

  test('does NOT retire a past placeholder with a pending shipment (food in transit)', () => {
    const inFlight = makeBatch({
      type: 'Soup', cookDate: '02/05/2026', name: 'In flight', generated: true,
      inventory: [],
      shipments: [{
        id: 'sh-1', fromLoc: 'west', toLoc: 'centraal', storage: 'Gastro',
        qty: 5, sentAt: '2026-05-02T08:00:00Z', arrived: false, cookDate: '02/05/2026',
      }],
    });
    expect(findStalePlaceholders([inFlight], TODAY)).toHaveLength(0);
  });

  test('does NOT retire a cook-created (non-generated) batch', () => {
    const cookCreated = makeBatch({
      type: 'Soup', cookDate: '02/05/2026', name: 'Cook batch',
      generated: false, inventory: [],
    });
    expect(findStalePlaceholders([cookCreated], TODAY)).toHaveLength(0);
  });

  test('does NOT retire a Dessert (only Soup + Main course are auto-managed)', () => {
    const dessert = makeBatch({
      type: 'Dessert', cookDate: '02/05/2026', name: 'Dessert',
      generated: true, inventory: [],
    });
    expect(findStalePlaceholders([dessert], TODAY)).toHaveLength(0);
  });
});

// ─── dropRetiredDishesFromCaterings ────────────────────────────────────────

describe('dropRetiredDishesFromCaterings', () => {
  function catering(id: string, name: string, dishes: CateringDish[]): Catering {
    return { id, name, date: null, guestCount: 50, deliveryMode: 'pickup', dishes, logisticsNotes: '' };
  }
  function dish(dishId: string, name: string, type: DishType = 'Soup'): CateringDish {
    return { dishId, name, type };
  }

  test('removes retired dish refs and reports which caterings lost what', () => {
    const c = catering('c-1', 'Protest march', [
      dish('orphan-1', 'Mon soup 04/05'),
      dish('real-1', 'Tomato soup'),
    ]);
    const dropped = dropRetiredDishesFromCaterings([c], new Set(['orphan-1']));
    expect(c.dishes.map(d => d.dishId)).toEqual(['real-1']);
    expect(dropped).toEqual([
      { cateringId: 'c-1', cateringName: 'Protest march', dishName: 'Mon soup 04/05' },
    ]);
  });

  test('leaves caterings untouched when none reference a retired batch', () => {
    const c = catering('c-1', 'Event', [dish('real-1', 'Tomato soup')]);
    const dropped = dropRetiredDishesFromCaterings([c], new Set(['orphan-1']));
    expect(c.dishes.map(d => d.dishId)).toEqual(['real-1']);
    expect(dropped).toEqual([]);
  });

  test('handles multiple caterings and multiple retired dishes', () => {
    const c1 = catering('c-1', 'A', [dish('orphan-1', 'P1'), dish('orphan-2', 'P2')]);
    const c2 = catering('c-2', 'B', [dish('orphan-1', 'P1'), dish('real-1', 'R')]);
    const dropped = dropRetiredDishesFromCaterings([c1, c2], new Set(['orphan-1', 'orphan-2']));
    expect(c1.dishes).toEqual([]);
    expect(c2.dishes.map(d => d.dishId)).toEqual(['real-1']);
    expect(dropped).toHaveLength(3);
    expect(dropped.filter(d => d.cateringId === 'c-1')).toHaveLength(2);
  });
});

// ─── generateMissingPlaceholders ────────────────────────────────────────────

describe('generateMissingPlaceholders', () => {
  test('empty week → exactly the rhythm count', () => {
    const window = makeWindow([
      { iso: '2026-05-03', dayName: 'Sun', cookDate: '03/05/2026' }, // 3+3
      { iso: '2026-05-04', dayName: 'Mon', cookDate: '04/05/2026' }, // 0+1
      { iso: '2026-05-05', dayName: 'Tue', cookDate: '05/05/2026' }, // 1+1
    ]);
    const snap = snapshotBatches([], window);
    const placeholders = generateMissingPlaceholders(window, snap);
    // Sun (3+3) + Mon (0+1) + Tue (1+1) = 9 placeholders.
    expect(placeholders).toHaveLength(9);
    // Every placeholder has empty inventory + generated flag set.
    for (const p of placeholders) {
      expect(p.inventory).toEqual([]);
      expect(p.shipments).toEqual([]);
      expect(p.generated).toBe(true);
    }
  });

  test('partial coverage → only fills the gap', () => {
    const window = makeWindow([
      { iso: '2026-05-05', dayName: 'Tue', cookDate: '05/05/2026' }, // 1+1
    ]);
    // Tue already has 1 cooked Soup; only the Main is missing.
    const existing = makeBatch({ type: 'Soup', cookDate: '05/05/2026', inventory: [inv(50, 'west')] });
    const snap = snapshotBatches([existing], window);
    const placeholders = generateMissingPlaceholders(window, snap);
    expect(placeholders).toHaveLength(1);
    expect(placeholders[0].type).toBe('Main course');
  });

  test('over-rhythm day → does not add or delete extras', () => {
    const window = makeWindow([
      { iso: '2026-05-05', dayName: 'Tue', cookDate: '05/05/2026' }, // 1+1
    ]);
    // Tue has 3 cooked Soups already (over rhythm).
    const a = makeBatch({ type: 'Soup', cookDate: '05/05/2026', inventory: [inv(10, 'west')] });
    const b = makeBatch({ type: 'Soup', cookDate: '05/05/2026', inventory: [inv(10, 'west')] });
    const c = makeBatch({ type: 'Soup', cookDate: '05/05/2026', inventory: [inv(10, 'west')] });
    const snap = snapshotBatches([a, b, c], window);
    const placeholders = generateMissingPlaceholders(window, snap);
    // Only the Main is added; the Soup over-rhythm is left as-is.
    expect(placeholders).toHaveLength(1);
    expect(placeholders[0].type).toBe('Main course');
  });
});

// ─── countTypeInSlot / alreadyInSlot ────────────────────────────────────────

describe('countTypeInSlot / alreadyInSlot', () => {
  test('counts only matching type+slot combinations', () => {
    const a = makeBatch({
      type: 'Soup', cookDate: '04/05/2026', name: 'A',
      services: [{ loc: 'west', date: '2026-05-05', meal: 'lunch' }],
    });
    const b = makeBatch({
      type: 'Soup', cookDate: '04/05/2026', name: 'B',
      services: [{ loc: 'west', date: '2026-05-05', meal: 'lunch' }],
    });
    const c = makeBatch({
      type: 'Main course', cookDate: '04/05/2026', name: 'C',
      services: [{ loc: 'west', date: '2026-05-05', meal: 'lunch' }],
    });
    expect(countTypeInSlot([a, b, c], 'Soup', 'west', '2026-05-05', 'lunch')).toBe(2);
    expect(countTypeInSlot([a, b, c], 'Main course', 'west', '2026-05-05', 'lunch')).toBe(1);
  });

  test('cross-batch same-recipe duplicates count as separate menu options (audit S7)', () => {
    // Unified-batch model: two unrelated cook events of the same recipe stay
    // as separate batches and count as separate menu options. Old family-
    // pool semantics are gone.
    const a = makeBatch({
      type: 'Soup', cookDate: '04/05/2026', name: 'Tomato', recipeId: 'r-tomato',
      services: [{ loc: 'west', date: '2026-05-05', meal: 'lunch' }],
    });
    const b = makeBatch({
      type: 'Soup', cookDate: '05/05/2026', name: 'Tomato', recipeId: 'r-tomato',
      services: [{ loc: 'west', date: '2026-05-05', meal: 'lunch' }],
    });
    expect(countTypeInSlot([a, b], 'Soup', 'west', '2026-05-05', 'lunch')).toBe(2);
  });

  test('alreadyInSlot returns true iff that batch has a service at the slot', () => {
    const a = makeBatch({
      type: 'Soup', cookDate: '04/05/2026',
      services: [{ loc: 'west', date: '2026-05-05', meal: 'lunch' }],
    });
    expect(alreadyInSlot(a, 'west', '2026-05-05', 'lunch')).toBe(true);
    expect(alreadyInSlot(a, 'west', '2026-05-05', 'dinner')).toBe(false);
    expect(alreadyInSlot(a, 'centraal', '2026-05-05', 'lunch')).toBe(false);
  });
});

// ─── allocatePotCaps ────────────────────────────────────────────────────────

describe('allocatePotCaps', () => {
  const NO_GUESTS = (_loc: Location, _iso: string, _meal: Meal) => 0;
  const TEN_GUESTS = (_loc: Location, _iso: string, _meal: Meal) => 10;

  test('returns empty map when no equipment configured', () => {
    const eq: KitchenEquipment | null = null;
    expect(allocatePotCaps([], eq, fixedCalcRequired())).toEqual(new Map());
  });

  test('overflow batches get the smallest pot size', () => {
    const eq: KitchenEquipment = { pots: [140, 100, 60], gasBurners: 1, inductionBurners: 2, bigBurnerThreshold: 80 };
    // 4 batches; 3 pots — the 4th sorts to the smallest (60).
    const batches = [
      makeBatch({ type: 'Soup', cookDate: '04/05/2026', name: 'A',
        services: [{ loc: 'west', date: '2026-05-04', meal: 'dinner' }, { loc: 'west', date: '2026-05-05', meal: 'dinner' }, { loc: 'west', date: '2026-05-06', meal: 'dinner' }, { loc: 'west', date: '2026-05-07', meal: 'dinner' }] }),
      makeBatch({ type: 'Soup', cookDate: '04/05/2026', name: 'B',
        services: [{ loc: 'west', date: '2026-05-04', meal: 'lunch' }, { loc: 'west', date: '2026-05-05', meal: 'lunch' }, { loc: 'west', date: '2026-05-06', meal: 'lunch' }] }),
      makeBatch({ type: 'Soup', cookDate: '04/05/2026', name: 'C',
        services: [{ loc: 'centraal', date: '2026-05-05', meal: 'dinner' }, { loc: 'centraal', date: '2026-05-06', meal: 'dinner' }] }),
      makeBatch({ type: 'Soup', cookDate: '04/05/2026', name: 'D',
        services: [{ loc: 'west', date: '2026-05-08', meal: 'lunch' }] }),
    ];
    const caps = allocatePotCaps(batches, eq, fixedCalcRequired(1));
    // The lowest-demand batch (D, 1 service) lands on the smallest pot.
    expect(caps.get(batches[3].id)).toBe(60);
  });
});

// ─── Algorithm: scoredGreedyAssignment ─────────────────────────────────────

const TEN_GUESTS = (_loc: Location, _iso: string, _meal: Meal) => 10;
const NO_GUESTS = (_loc: Location, _iso: string, _meal: Meal) => 0;
const NO_POT_CAPS = new Map<string, number>();

describe('scoredGreedyAssignment', () => {
  test('frozen-only batches are never auto-assigned', () => {
    const window = makeWindow([
      { iso: '2026-05-04', dayName: 'Mon', cookDate: '04/05/2026' },
      { iso: '2026-05-05', dayName: 'Tue', cookDate: '05/05/2026' },
    ]);
    const frozen = makeBatch({
      type: 'Soup', cookDate: '03/05/2026', name: 'Frozen',
      inventory: [inv(100, 'west', 'Frozen')],
    });
    const fresh = makeBatch({
      type: 'Soup', cookDate: '03/05/2026', name: 'Fresh',
      inventory: [inv(100, 'west', 'Gastro')],
    });
    scoredGreedyAssignment([frozen, fresh], window, fixedCalcRequired(1), TEN_GUESTS, NO_POT_CAPS);
    expect(frozen.services.length).toBe(0);
    expect(fresh.services.length).toBeGreaterThan(0);
  });

  test('Centraal-located batch (inventory[0].loc=centraal) is never assigned to a West slot', () => {
    const window = makeWindow([
      { iso: '2026-05-04', dayName: 'Mon', cookDate: '04/05/2026' },
      { iso: '2026-05-05', dayName: 'Tue', cookDate: '05/05/2026' },
    ]);
    const c = makeBatch({
      type: 'Soup', cookDate: '03/05/2026', name: 'C',
      inventory: [inv(100, 'centraal', 'Gastro')],
    });
    scoredGreedyAssignment([c], window, fixedCalcRequired(1), TEN_GUESTS, NO_POT_CAPS);
    for (const svc of c.services) {
      expect(svc.loc).toBe('centraal');
    }
  });

  test('past-stale batch (>5d cookDate) is excluded from assignment', () => {
    const window = makeWindow([
      { iso: '2026-05-10', dayName: 'Sun', cookDate: '10/05/2026' },
    ]);
    const old = makeBatch({
      type: 'Soup', cookDate: '01/05/2026', name: 'Stale',
      inventory: [inv(100, 'west')],
    });
    scoredGreedyAssignment([old], window, fixedCalcRequired(1), TEN_GUESTS, NO_POT_CAPS);
    expect(old.services.length).toBe(0);
  });

  test('0-stock placeholder with a past cookDate is not recycled into a future slot', () => {
    const window = makeWindow([
      { iso: '2026-05-05', dayName: 'Tue', cookDate: '05/05/2026' },
    ]);
    // Leftover placeholder from a previous run: its cook day (Sun 03/05) has
    // already passed and nothing was cooked. Only 2 days before the window —
    // well inside the 5-day freshness cutoff, so the staleness rule alone
    // would NOT catch it. An empty placeholder for a dead cook day must not
    // be recycled into a future slot.
    const stalePlaceholder = makeBatch({
      type: 'Soup', cookDate: '03/05/2026', name: 'Stale placeholder',
      generated: true, inventory: [],
    });
    // A legitimate placeholder for the window day itself.
    const freshPlaceholder = makeBatch({
      type: 'Soup', cookDate: '05/05/2026', name: 'Fresh placeholder',
      generated: true, inventory: [],
    });
    scoredGreedyAssignment(
      [stalePlaceholder, freshPlaceholder], window,
      fixedCalcRequired(1), TEN_GUESTS, NO_POT_CAPS,
    );
    expect(stalePlaceholder.services.length).toBe(0);
    expect(freshPlaceholder.services.length).toBeGreaterThan(0);
  });

  test('0-guest slot is skipped', () => {
    const window = makeWindow([
      { iso: '2026-05-05', dayName: 'Tue', cookDate: '05/05/2026' },
    ]);
    const b = makeBatch({
      type: 'Soup', cookDate: '04/05/2026', name: 'Soup',
      inventory: [inv(100, 'west')],
    });
    scoredGreedyAssignment([b], window, fixedCalcRequired(1), NO_GUESTS, NO_POT_CAPS);
    expect(b.services.length).toBe(0);
  });

  test('higher-urgency slot (empty) wins over half-filled slot when batch is scarce', () => {
    const window = makeWindow([
      { iso: '2026-05-05', dayName: 'Tue', cookDate: '05/05/2026' },
    ]);
    const b = makeBatch({
      type: 'Soup', cookDate: '04/05/2026', name: 'Scarce',
      inventory: [inv(100, 'west')],
    });
    // Pre-populate: West dinner already has one peer assigned.
    const peer = makeBatch({
      type: 'Soup', cookDate: '04/05/2026', name: 'Peer',
      inventory: [inv(100, 'west')],
    });
    peer.services.push({ loc: 'west', date: '2026-05-05', meal: 'dinner' });
    scoredGreedyAssignment([b, peer], window, fixedCalcRequired(1), TEN_GUESTS, NO_POT_CAPS);
    // Empty slots should attract `b` first (higher urgency than half-filled
    // West dinner). At least one of b's services should NOT be on West dinner.
    const onEmptySlots = b.services.filter(s =>
      !(s.loc === 'west' && s.meal === 'dinner')).length;
    expect(onEmptySlots).toBeGreaterThan(0);
  });

  test('lunch slot prefers older stock (prior-day cook over same-day)', () => {
    const window = makeWindow([
      { iso: '2026-05-05', dayName: 'Tue', cookDate: '05/05/2026' },
    ]);
    const monCook = makeBatch({
      type: 'Soup', cookDate: '04/05/2026', name: 'Mon',
      inventory: [inv(100, 'west')],
    });
    // Tuesday cook can serve Tue dinner (same-day OK) but not Tue lunch (too early).
    const tueCook = makeBatch({
      type: 'Soup', cookDate: '05/05/2026', name: 'Tue placeholder',
      inventory: [],
    });
    scoredGreedyAssignment([monCook, tueCook], window, fixedCalcRequired(1), TEN_GUESTS, NO_POT_CAPS);
    const monAtLunch = monCook.services.some(s => s.meal === 'lunch');
    expect(monAtLunch).toBe(true);
  });

  test('dinner slot prefers same-day cook (no cooling)', () => {
    const window = makeWindow([
      { iso: '2026-05-05', dayName: 'Tue', cookDate: '05/05/2026' },
    ]);
    const monCook = makeBatch({
      type: 'Soup', cookDate: '04/05/2026', name: 'Mon',
      inventory: [inv(100, 'west')],
    });
    const tueCook = makeBatch({
      type: 'Soup', cookDate: '05/05/2026', name: 'Tue',
      inventory: [inv(100, 'west')],
    });
    scoredGreedyAssignment([monCook, tueCook], window, fixedCalcRequired(1), TEN_GUESTS, NO_POT_CAPS);
    const tueAtDinner = tueCook.services.some(s => s.meal === 'dinner' && s.date === '2026-05-05');
    expect(tueAtDinner).toBe(true);
  });

  test('balances service load across identical sibling placeholders (no starvation)', () => {
    // Regression: a big-cook day (e.g. Sunday) produces several identical
    // placeholders of one type. The greedy loop must round-robin them across
    // the week's slots — not pile every slot onto the same two and starve the
    // rest. The starved siblings used to end with zero services (then get
    // deleted as orphans), while the two winners stretched across the whole
    // horizon. Fixed by the load-balancing tie-break in scoredGreedyAssignment.
    const window = makeWindow([
      { iso: '2026-05-03', dayName: 'Sun', cookDate: '03/05/2026' },
      { iso: '2026-05-04', dayName: 'Mon', cookDate: '04/05/2026' },
      { iso: '2026-05-05', dayName: 'Tue', cookDate: '05/05/2026' },
      { iso: '2026-05-06', dayName: 'Wed', cookDate: '06/05/2026' },
    ]);
    // Sunday is a 0-guest cook day; the placeholders are servable Mon onward.
    const guests = (_loc: Location, iso: string, _meal: Meal) => (iso >= '2026-05-04' ? 10 : 0);
    const siblings = [1, 2, 3].map(n => makeBatch({
      type: 'Soup', cookDate: '03/05/2026', name: `Sun soup ${n}`, generated: true,
    }));
    scoredGreedyAssignment(siblings, window, fixedCalcRequired(1), guests, NO_POT_CAPS);
    const loads = siblings.map(b => b.services.length);
    expect(Math.min(...loads)).toBeGreaterThan(0);              // none starved
    expect(Math.max(...loads) - Math.min(...loads)).toBeLessThanOrEqual(2); // balanced
  });
});

// ─── Algorithm: forcedAssignmentPrePass ────────────────────────────────────

describe('forcedAssignmentPrePass', () => {
  test('singleton candidate gets locked when it is the only legal option', () => {
    const window = makeWindow([
      { iso: '2026-05-05', dayName: 'Tue', cookDate: '05/05/2026' },
    ]);
    // Only one batch; its inventory is at Centraal so it can ONLY satisfy
    // Centraal slots — nothing else competes for those.
    const onlyOne = makeBatch({
      type: 'Soup', cookDate: '04/05/2026', name: 'OnlyC',
      inventory: [inv(100, 'centraal')],
    });
    const result = forcedAssignmentPrePass([onlyOne], window, fixedCalcRequired(1), TEN_GUESTS, NO_POT_CAPS);
    expect(result.committed).toBeGreaterThan(0);
    expect(onlyOne.services.length).toBeGreaterThan(0);
    for (const svc of onlyOne.services) {
      expect(svc.loc).toBe('centraal');
    }
  });

  test('does not commit when no candidate passes hard constraints', () => {
    const window = makeWindow([
      { iso: '2026-05-05', dayName: 'Tue', cookDate: '05/05/2026' },
    ]);
    const frozenOnly = makeBatch({
      type: 'Soup', cookDate: '04/05/2026', name: 'F',
      inventory: [inv(100, 'west', 'Frozen')],
    });
    const result = forcedAssignmentPrePass([frozenOnly], window, fixedCalcRequired(1), TEN_GUESTS, NO_POT_CAPS);
    expect(result.committed).toBe(0);
    expect(frozenOnly.services.length).toBe(0);
  });
});

// ─── Algorithm: runFallbackLadder ─────────────────────────────────────────

describe('runFallbackLadder', () => {
  test('creates emergency placeholder for slots with no candidates', () => {
    const window = makeWindow([
      { iso: '2026-05-05', dayName: 'Tue', cookDate: '05/05/2026' },
    ]);
    const result = runFallbackLadder([], window, fixedCalcRequired(1), TEN_GUESTS);
    expect(result.emergenciesCreated).toBeGreaterThan(0);
    for (const b of result.emergencyBatches) {
      expect(b.cookNotes).toMatch(/Emergency/i);
      expect(b.generated).toBe(true);
      expect(b.recipeId).toBeNull();
      // New shape: shipments[] starts empty. Inventory may carry a qty=0
      // placeholder entry pinning the cookLoc so primaryLoc() works on the
      // first scoring pass — the cook overwrites this on confirm.
      expect(b.shipments).toEqual([]);
      for (const e of b.inventory) {
        expect(e.qty).toBe(0);
      }
    }
  });

  test('teams form when single batches are too small but combined coverage hits the threshold', () => {
    const window = makeWindow([
      { iso: '2026-05-05', dayName: 'Tue', cookDate: '05/05/2026' },
    ]);
    const a = makeBatch({
      type: 'Soup', cookDate: '04/05/2026', name: 'Small A',
      inventory: [inv(30, 'west')],
    });
    const b = makeBatch({
      type: 'Soup', cookDate: '04/05/2026', name: 'Small B',
      inventory: [inv(30, 'west')],
    });
    const guestsFn = (loc: Location, _iso: string, _meal: Meal) =>
      loc === 'west' ? 30 : 0;
    runFallbackLadder([a, b], window, fixedCalcRequired(1), guestsFn);
    expect(a.services.length + b.services.length).toBeGreaterThan(0);
  });
});

// ─── Idempotency ──────────────────────────────────────────────────────────

describe('algorithm idempotency (double-press doesn\'t change assignments)', () => {
  test('running scoredGreedyAssignment twice produces the same final state', () => {
    const window = makeWindow([
      { iso: '2026-05-05', dayName: 'Tue', cookDate: '05/05/2026' },
      { iso: '2026-05-06', dayName: 'Wed', cookDate: '06/05/2026' },
    ]);
    const make = () => [
      makeBatch({ type: 'Soup', cookDate: '04/05/2026', name: 'A', inventory: [inv(100, 'west')] }),
      makeBatch({ type: 'Main course', cookDate: '04/05/2026', name: 'B', inventory: [inv(100, 'west')] }),
    ];

    const run1 = make();
    scoredGreedyAssignment(run1, window, fixedCalcRequired(1), TEN_GUESTS, NO_POT_CAPS);
    const run1Sigs = run1.map(b =>
      `${b.name}:${(b.services || []).map((s: Service) => `${s.loc}|${s.date}|${s.meal}`).sort().join(',')}`,
    );

    const run2 = make();
    scoredGreedyAssignment(run2, window, fixedCalcRequired(1), TEN_GUESTS, NO_POT_CAPS);
    const run2Sigs = run2.map(b =>
      `${b.name}:${(b.services || []).map((s: Service) => `${s.loc}|${s.date}|${s.meal}`).sort().join(',')}`,
    );

    expect(run1Sigs).toEqual(run2Sigs);
  });
});

// ─── Constants ────────────────────────────────────────────────────────────

describe('constants', () => {
  test('COOK_RHYTHM weekly totals (8 soups, 9 mains — Tue is 1+1)', () => {
    const totals = Object.values(COOK_RHYTHM).reduce(
      (acc, day) => ({ soup: acc.soup + day.soup, main: acc.main + day.main }),
      { soup: 0, main: 0 },
    );
    expect(totals.soup).toBe(8);
    expect(totals.main).toBe(9);
  });

  test('SLOTS_PER_TYPE is 2', () => {
    expect(SLOTS_PER_TYPE).toBe(2);
  });

  test('PLANNING_HORIZON_DAYS is 7', () => {
    expect(PLANNING_HORIZON_DAYS).toBe(7);
  });

  test('TYPES_TO_PLAN excludes Dessert (auto-rotation only handles Soup + Main)', () => {
    expect(TYPES_TO_PLAN).toEqual(['Soup', 'Main course']);
  });
});

// ─── buildPlanningWindow (smoke) ─────────────────────────────────────────

describe('buildPlanningWindow', () => {
  test('produces PLANNING_HORIZON_DAYS days starting today', () => {
    const today = new Date('2026-05-04T08:00:00');
    const window = buildPlanningWindow(today);
    expect(window).toHaveLength(PLANNING_HORIZON_DAYS);
    // Each day has 4 slots (2 locs × 2 meals).
    expect(window[0].slots).toHaveLength(4);
  });
});

// ─── Cook rhythm config (editable Fix My Menu rules) ───────────────────────

describe('cook rhythm config', () => {
  // S is a singleton; reset so the rest of the suite sees built-in defaults.
  afterEach(() => { S.cookRhythm = null; });

  test('getActiveRhythm returns the built-in defaults when nothing is saved', () => {
    S.cookRhythm = null;
    const r = getActiveRhythm();
    expect(r.Sun).toEqual({ soup: 3, main: 3, chefs: 6 });
    expect(r.Mon).toEqual({ soup: 0, main: 1, chefs: 1 });
    expect(r.Wed).toEqual({ soup: 1, main: 1, chefs: 2 });
  });

  test('getActiveRhythm layers a saved day over the defaults, keeping the rest', () => {
    S.cookRhythm = { days: { Wed: { soup: 2, main: 3, chefs: 5 } } };
    const r = getActiveRhythm();
    expect(r.Wed).toEqual({ soup: 2, main: 3, chefs: 5 }); // overridden
    expect(r.Mon).toEqual({ soup: 0, main: 1, chefs: 1 }); // default preserved
  });

  test('getActiveRhythm fills a missing chef count with soup+main (legacy rows)', () => {
    S.cookRhythm = { days: { Thu: { soup: 2, main: 1 } } } as unknown as CookRhythmConfig;
    expect(getActiveRhythm().Thu.chefs).toBe(3);
  });

  test('getActiveRhythm drops a malformed day (non-numeric soup/main) back to the default', () => {
    // Last line of defense for legacy/SSE-injected rows that bypass the route's
    // numeric validation — a junk day must not poison the rhythm.
    S.cookRhythm = { days: { Wed: { soup: 'oops', main: 1, chefs: 2 } } } as unknown as CookRhythmConfig;
    expect(getActiveRhythm().Wed).toEqual({ soup: 1, main: 1, chefs: 2 }); // default Wed preserved
  });

  test('generateMissingPlaceholders honours a bumped rhythm', () => {
    S.cookRhythm = { days: { Mon: { soup: 2, main: 2, chefs: 4 } } };
    const window = makeWindow([{ iso: '2026-05-04', dayName: 'Mon', cookDate: '04/05/2026' }]);
    const ph = generateMissingPlaceholders(window, snapshotBatches([], window));
    expect(ph.filter(b => b.type === 'Soup')).toHaveLength(2);
    expect(ph.filter(b => b.type === 'Main course')).toHaveLength(2);
  });

  test('generateMissingPlaceholders generates nothing for a closed day', () => {
    S.cookRhythm = { days: { Tue: { soup: 0, main: 0, chefs: 0 } } };
    const window = makeWindow([{ iso: '2026-05-05', dayName: 'Tue', cookDate: '05/05/2026' }]);
    expect(generateMissingPlaceholders(window, snapshotBatches([], window))).toHaveLength(0);
  });
});

// ─── Dynamic chef capacity (computeWeeklyCapacities) ───────────────────────

describe('computeWeeklyCapacities (chefs share the week\'s cooking)', () => {
  afterEach(() => { S.cookRhythm = null; });

  test('splits the week\'s demand proportionally to each day\'s chefs', () => {
    // Default rhythm: Sunday 6 chefs, Monday 1 chef → Sunday gets 6× the capacity.
    const window = makeWindow([
      { iso: '2026-05-03', dayName: 'Sun', cookDate: '03/05/2026' },
      { iso: '2026-05-04', dayName: 'Mon', cookDate: '04/05/2026' },
    ]);
    const guests = (_l: Location, _i: string, _m: Meal) => 50;
    const caps = computeWeeklyCapacities(window, guests);
    const sun = caps.get('Sun')!, mon = caps.get('Mon')!;
    expect(sun / mon).toBeCloseTo(6);                 // chef ratio 6:1
    // Capacities sum to the week's total demand: 2 days × 4 slots × 2 types × 50 guests × 0.28 L.
    expect(sun + mon).toBeCloseTo(2 * 4 * 2 * 50 * 280 / 1000);
  });

  test('scales with demand — a busier week raises every day\'s capacity', () => {
    const window = makeWindow([{ iso: '2026-05-05', dayName: 'Tue', cookDate: '05/05/2026' }]);
    const low = computeWeeklyCapacities(window, () => 20).get('Tue')!;
    const high = computeWeeklyCapacities(window, () => 80).get('Tue')!;
    expect(high).toBeCloseTo(low * 4);                // 4× guests → 4× capacity
  });

  test('returns an empty map (escape disabled) when there are no guests', () => {
    const window = makeWindow([{ iso: '2026-05-05', dayName: 'Tue', cookDate: '05/05/2026' }]);
    expect(computeWeeklyCapacities(window, () => 0).size).toBe(0);
  });

  test('returns an empty map when no day is staffed (zero total chefs, no div-by-zero)', () => {
    const window = makeWindow([{ iso: '2026-05-05', dayName: 'Tue', cookDate: '05/05/2026' }]);
    // Guests > 0 but the only window day has 0 chefs → escape disabled, not NaN.
    S.cookRhythm = { days: { Tue: { soup: 0, main: 0, chefs: 0 } } };
    expect(computeWeeklyCapacities(window, () => 50).size).toBe(0);
  });

  test('more chefs on a day = a bigger slice of the same total', () => {
    const window = makeWindow([
      { iso: '2026-05-05', dayName: 'Tue', cookDate: '05/05/2026' },
      { iso: '2026-05-06', dayName: 'Wed', cookDate: '06/05/2026' },
    ]);
    const guests = (_l: Location, _i: string, _m: Meal) => 40;
    // Tue staffed at 3 chefs, Wed at 1 → Tue capacity is 3× Wed's, total unchanged.
    S.cookRhythm = { days: { Tue: { soup: 1, main: 1, chefs: 3 }, Wed: { soup: 1, main: 1, chefs: 1 } } };
    const caps = computeWeeklyCapacities(window, guests);
    expect(caps.get('Tue')! / caps.get('Wed')!).toBeCloseTo(3);
    expect(caps.get('Tue')! + caps.get('Wed')!).toBeCloseTo(2 * 4 * 2 * 40 * 280 / 1000);
  });
});

// ─── collectWarnings: undeliverable-Centraal Sunday exception ──────────────

describe('collectWarnings undeliverable-centraal (Sunday delivery exception)', () => {
  const TEN = (_l: Location, _i: string, _m: Meal) => 10;
  const has = (ws: { category: string }[]) => ws.some(w => w.category === 'undeliverable-centraal');

  test('Sunday West cook serving Centraal SAME-DAY dinner is NOT flagged', () => {
    const window = makeWindow([{ iso: '2026-05-03', dayName: 'Sun', cookDate: '03/05/2026' }]);
    const b = makeBatch({
      type: 'Soup', cookDate: '03/05/2026', name: 'Sun soup',
      inventory: [inv(80, 'west')],
      services: [{ loc: 'centraal', date: '2026-05-03', meal: 'dinner' }],
    });
    const ws = collectWarnings([b], window, [], fixedCalcRequired(1), NO_POT_CAPS, null, TEN);
    expect(has(ws)).toBe(false);
  });

  test('Sunday West cook serving Centraal same-day LUNCH is still flagged', () => {
    const window = makeWindow([{ iso: '2026-05-03', dayName: 'Sun', cookDate: '03/05/2026' }]);
    const b = makeBatch({
      type: 'Soup', cookDate: '03/05/2026', name: 'Sun soup lunch',
      inventory: [inv(80, 'west')],
      services: [{ loc: 'centraal', date: '2026-05-03', meal: 'lunch' }],
    });
    const ws = collectWarnings([b], window, [], fixedCalcRequired(1), NO_POT_CAPS, null, TEN);
    expect(has(ws)).toBe(true);
  });

  test('non-Sunday West cook serving Centraal same-day dinner is still flagged', () => {
    const window = makeWindow([{ iso: '2026-05-06', dayName: 'Wed', cookDate: '06/05/2026' }]);
    const b = makeBatch({
      type: 'Soup', cookDate: '06/05/2026', name: 'Wed soup',
      inventory: [inv(80, 'west')],
      services: [{ loc: 'centraal', date: '2026-05-06', meal: 'dinner' }],
    });
    const ws = collectWarnings([b], window, [], fixedCalcRequired(1), NO_POT_CAPS, null, TEN);
    expect(has(ws)).toBe(true);
  });
});

// ─── collectWarnings + closed services ─────────────────────────────────────

describe('closed services: Fix My Menu warnings', () => {
  const TEN = (_l: Location, _i: string, _m: Meal) => 10;
  const hasCat = (ws: { category: string }[], cat: string) => ws.some(w => w.category === cat);
  afterEach(() => { S.closedServices = null; });

  test('a dish left on a CLOSED Centraal slot is not flagged undeliverable-centraal', () => {
    // Without closure this is exactly the "non-Sunday West cook → Centraal
    // same-day dinner" case that IS flagged (describe above). Closing the slot
    // must suppress the delivery warning — decision #6 keeps the dish (removable).
    S.closedServices = { recurring: { centraal: { Wed: ['dinner'] } } } as any;
    const window = makeWindow([{ iso: '2026-05-06', dayName: 'Wed', cookDate: '06/05/2026' }]);
    const b = makeBatch({
      type: 'Soup', cookDate: '06/05/2026', name: 'Wed soup',
      inventory: [inv(80, 'west')],
      services: [{ loc: 'centraal', date: '2026-05-06', meal: 'dinner' }],
    });
    const ws = collectWarnings([b], window, [], fixedCalcRequired(1), NO_POT_CAPS, null, TEN);
    expect(hasCat(ws, 'undeliverable-centraal')).toBe(false);
  });

  test('a CLOSED slot with guests is skipped by under-filled; the same slot open IS flagged', () => {
    const z = () => ({ Mon: { lunch: 0, dinner: 0 }, Tue: { lunch: 0, dinner: 0 }, Wed: { lunch: 0, dinner: 0 }, Thu: { lunch: 0, dinner: 0 }, Fri: { lunch: 0, dinner: 0 }, Sat: { lunch: 0, dinner: 0 }, Sun: { lunch: 0, dinner: 0 } });
    S.guests = { west: z(), centraal: z() } as any;
    S.guests.centraal.Wed.dinner = 10;  // demand exists, but no dish is on the slot
    S.predictions = {} as any; S.guestsNextWeeks = {} as any; S.batches = []; S.planner = {};
    const window = makeWindow([{ iso: '2026-05-06', dayName: 'Wed', cookDate: '06/05/2026' }]);
    const isClosedDinner = (w: { category: string; anchor?: { kind: string; loc?: Location; date?: string; meal?: Meal } }) =>
      w.category === 'under-filled-slot' && !!w.anchor && w.anchor.loc === 'centraal'
      && w.anchor.meal === 'dinner' && w.anchor.date === '2026-05-06';

    // Closed → effective guests 0 → slot skipped, no under-filled warning for it.
    S.closedServices = { recurring: { centraal: { Wed: ['dinner'] } } } as any;
    buildRollMap();
    const wsClosed = collectWarnings([], window, [], fixedCalcRequired(1), NO_POT_CAPS, null, getEffectiveGuests);
    expect(wsClosed.some(isClosedDinner)).toBe(false);

    // Open → 10 guests, no dish → under-filled warning appears.
    S.closedServices = null;
    buildRollMap();
    const wsOpen = collectWarnings([], window, [], fixedCalcRequired(1), NO_POT_CAPS, null, getEffectiveGuests);
    expect(wsOpen.some(isClosedDinner)).toBe(true);
  });
});
