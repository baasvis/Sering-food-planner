/**
 * Unit tests for the Fix My Menu service assigner (Slice 3).
 *
 * Tests the two-pass scheduler in isolation by passing fake `calcRequired`
 * functions and constructed Batch / PlanDay objects. The S object isn't
 * touched.
 */

// Browser-global stubs (document, localStorage, etc.) come from
// test/setup-dom-stubs.ts in the jest setupFiles list — that runs before
// module imports here.

import type { Batch, DishType, Location, Meal, Service, StorageType } from '../shared/types';
import {
  assignServicesPass1,
  assignServicesPass2,
  buildPlanningWindow,
  isServableBy,
  isStaleAtSlot,
  countTypeInSlot,
  alreadyInSlot,
  findOrphanPlaceholders,
  generateMissingPlaceholders,
  snapshotBatches,
  COOK_RHYTHM,
  SLOTS_PER_TYPE,
  type PlanDay,
} from '../public/js/menu-fixer';

// ── Helpers ─────────────────────────────────────────────────────────────────

let _idCounter = 0;
function nextId() { return `b-${++_idCounter}`; }

function makeBatch(overrides: Partial<Batch> & { type: DishType; cookDate: string }): Batch {
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
    cookDate: overrides.cookDate,
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

/**
 * Build a window manually (without going through buildPlanningWindow which
 * uses the real "today" clock). All slots are non-past — this is what we want
 * for testing future-slot assignment.
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
 * Catering hold can be added via the `hold` map.
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

// ── Eligibility helpers ─────────────────────────────────────────────────────

describe('isServableBy', () => {
  test('cookDate=Wed → not servable Wed lunch, servable Wed dinner', () => {
    expect(isServableBy('06/05/2026', '2026-05-06', 'lunch')).toBe(false);
    expect(isServableBy('06/05/2026', '2026-05-06', 'dinner')).toBe(true);
  });
  test('cookDate=Wed → servable any later day', () => {
    expect(isServableBy('06/05/2026', '2026-05-07', 'lunch')).toBe(true);
    expect(isServableBy('06/05/2026', '2026-05-07', 'dinner')).toBe(true);
  });
  test('cookDate=Wed → not servable Tue', () => {
    expect(isServableBy('06/05/2026', '2026-05-05', 'lunch')).toBe(false);
    expect(isServableBy('06/05/2026', '2026-05-05', 'dinner')).toBe(false);
  });
  test('null cookDate → never servable', () => {
    expect(isServableBy(null, '2026-05-06', 'dinner')).toBe(false);
  });
});

describe('isStaleAtSlot', () => {
  test('stale on day +3 (default threshold)', () => {
    expect(isStaleAtSlot('06/05/2026', '2026-05-06')).toBe(false);
    expect(isStaleAtSlot('06/05/2026', '2026-05-08')).toBe(false);
    expect(isStaleAtSlot('06/05/2026', '2026-05-09')).toBe(true);  // 3 days later
    expect(isStaleAtSlot('06/05/2026', '2026-05-10')).toBe(true);
  });
});

// ── Step 0: cleanup orphans ─────────────────────────────────────────────────

describe('findOrphanPlaceholders', () => {
  test('finds generated empty placeholders, leaves cook-created alone', () => {
    const cookCreated = makeBatch({ type: 'Soup', cookDate: '02/05/2026', name: 'Daans Soup' });
    const generatedEmpty = makeBatch({ type: 'Soup', cookDate: '03/05/2026', name: 'Sun Soup', generated: true });
    const generatedAssigned = makeBatch({ type: 'Soup', cookDate: '04/05/2026', name: 'Mon Soup', generated: true });
    generatedAssigned.services = [{ loc: 'west', date: '2026-05-04', meal: 'dinner' }];
    const generatedConverted = makeBatch({ type: 'Soup', cookDate: '05/05/2026', name: 'Pumpkin', generated: true, recipeId: 'r1' });

    const orphans = findOrphanPlaceholders([cookCreated, generatedEmpty, generatedAssigned, generatedConverted]);
    expect(orphans).toEqual([generatedEmpty]);
  });
});

// ── Step 3: placeholder generation ──────────────────────────────────────────

describe('generateMissingPlaceholders', () => {
  test('empty week → exactly the rhythm count', () => {
    const window = makeWindow([
      { iso: '2026-05-03', dayName: 'Sun', cookDate: '03/05/2026' },  // 3+3
      { iso: '2026-05-04', dayName: 'Mon', cookDate: '04/05/2026' },  // 0+1
      { iso: '2026-05-05', dayName: 'Tue', cookDate: '05/05/2026' },  // 1+0
      { iso: '2026-05-06', dayName: 'Wed', cookDate: '06/05/2026' },  // 1+1
    ]);
    const snapshot = snapshotBatches([], window);
    const placeholders = generateMissingPlaceholders(window, snapshot);
    expect(placeholders.length).toBe(3 + 3 + 0 + 1 + 1 + 0 + 1 + 1);  // 10
    const sun = placeholders.filter(b => b.cookDate === '03/05/2026');
    expect(sun.filter(b => b.type === 'Soup').length).toBe(3);
    expect(sun.filter(b => b.type === 'Main course').length).toBe(3);
    // Multi-batch days get numbered names
    expect(sun.filter(b => b.type === 'Soup').map(b => b.name).sort()).toEqual(['Sun Soup 1', 'Sun Soup 2', 'Sun Soup 3']);
    // Single-batch days get unnumbered names
    const wed = placeholders.filter(b => b.cookDate === '06/05/2026');
    expect(wed.find(b => b.type === 'Soup')!.name).toBe('Wed Soup');
  });

  test('partial coverage → only fills the gap', () => {
    const window = makeWindow([
      { iso: '2026-05-03', dayName: 'Sun', cookDate: '03/05/2026' },  // 3 soups wanted
    ]);
    const existing = [
      makeBatch({ type: 'Soup', cookDate: '03/05/2026', name: 'Real Pea Soup' }),
      makeBatch({ type: 'Main course', cookDate: '03/05/2026', name: 'Real Curry' }),
    ];
    const snapshot = snapshotBatches(existing, window);
    const placeholders = generateMissingPlaceholders(window, snapshot);
    // 2 more soups + 2 more mains
    expect(placeholders.filter(b => b.type === 'Soup').length).toBe(2);
    expect(placeholders.filter(b => b.type === 'Main course').length).toBe(2);
  });

  test('over-rhythm day → does not delete extras', () => {
    const window = makeWindow([
      { iso: '2026-05-06', dayName: 'Wed', cookDate: '06/05/2026' },  // rhythm wants 1+1
    ]);
    const existing = [
      makeBatch({ type: 'Soup', cookDate: '06/05/2026' }),
      makeBatch({ type: 'Soup', cookDate: '06/05/2026' }),  // extra
      makeBatch({ type: 'Main course', cookDate: '06/05/2026' }),
    ];
    const snapshot = snapshotBatches(existing, window);
    const placeholders = generateMissingPlaceholders(window, snapshot);
    expect(placeholders.length).toBe(0);  // nothing to add, nothing removed
  });
});

// ── Step 4: Pass 1 (cooked finish) ─────────────────────────────────────────

describe('assignServicesPass1', () => {
  test('cooked batch with surplus stock gets extended forward', () => {
    const window = makeWindow([
      { iso: '2026-05-06', dayName: 'Wed', cookDate: '06/05/2026' },
      { iso: '2026-05-07', dayName: 'Thu', cookDate: '07/05/2026' },
    ]);
    const cooked = makeBatch({ type: 'Soup', cookDate: '06/05/2026', stock: 100 });  // huge surplus
    const calcReq = fixedCalcRequired(1);  // 1L per service

    const result = assignServicesPass1([cooked], window, calcReq);

    // Servable (cookDate=Wed → dinner of Wed onwards):
    //   Wed dinner (Centraal + West)        = 2 positions
    //   Thu lunch  (Centraal + West)        = 2 positions
    //   Thu dinner (Centraal + West)        = 2 positions
    // = 6 positions total. Stock is huge, so all 6 get filled.
    // Wed lunch is excluded (cooking happens during the day, not before lunch).
    expect(cooked.services.length).toBe(6);
    expect(result.servicesAdded).toBe(6);
    // Every assigned slot must be Wed-dinner-or-later.
    expect(cooked.services.every(s =>
      s.date > '2026-05-06' || (s.date === '2026-05-06' && s.meal === 'dinner')
    )).toBe(true);
  });

  test('Pass 1 stops at stale day boundary', () => {
    const window = makeWindow([
      { iso: '2026-05-06', dayName: 'Wed', cookDate: '06/05/2026' },
      { iso: '2026-05-07', dayName: 'Thu', cookDate: '07/05/2026' },
      { iso: '2026-05-08', dayName: 'Fri', cookDate: '08/05/2026' },
      { iso: '2026-05-09', dayName: 'Sat', cookDate: '09/05/2026' },  // stale (3 days after Wed)
      { iso: '2026-05-10', dayName: 'Sun', cookDate: '10/05/2026' },
    ]);
    const cooked = makeBatch({ type: 'Soup', cookDate: '06/05/2026', stock: 100 });
    const calcReq = fixedCalcRequired(1);

    assignServicesPass1([cooked], window, calcReq);

    // Sat (06/05 + 3 days) is stale — Pass 1 stops before it.
    // Servable & not-stale slots: Wed dinner(2) + Thu lunch(2) + Thu dinner(2)
    //   + Fri lunch(2) + Fri dinner(2) = 10 positions.
    expect(cooked.services.length).toBe(10);
    expect(cooked.services.every(s => s.date < '2026-05-09')).toBe(true);
  });

  test('Pass 1 respects 2-per-slot capacity (cooked batch never doubles up in one slot)', () => {
    const window = makeWindow([
      { iso: '2026-05-06', dayName: 'Wed', cookDate: '06/05/2026' },
    ]);
    const cooked = makeBatch({ type: 'Soup', cookDate: '06/05/2026', stock: 100 });
    const calcReq = fixedCalcRequired(1);

    assignServicesPass1([cooked], window, calcReq);

    // 4 slots/day × 1 dinner-onwards constraint → only the 2 dinner slots.
    // No duplication.
    const slotKeys = cooked.services.map(s => `${s.loc}|${s.date}|${s.meal}`);
    expect(new Set(slotKeys).size).toBe(slotKeys.length);
  });

  test('Pass 1 skips frozen batches', () => {
    const window = makeWindow([
      { iso: '2026-05-06', dayName: 'Wed', cookDate: '06/05/2026' },
    ]);
    const frozen = makeBatch({ type: 'Soup', cookDate: '06/05/2026', stock: 10, storage: 'Frozen' });
    assignServicesPass1([frozen], window, fixedCalcRequired(1));
    expect(frozen.services.length).toBe(0);
  });

  test('Pass 1 catering hold reduces extension headroom', () => {
    const window = makeWindow([
      { iso: '2026-05-06', dayName: 'Wed', cookDate: '06/05/2026' },
      { iso: '2026-05-07', dayName: 'Thu', cookDate: '07/05/2026' },
    ]);
    const cooked = makeBatch({ type: 'Soup', cookDate: '06/05/2026', stock: 5 });
    const holds = new Map<string, number>([[cooked.id, 3]]);  // 3L locked for catering
    const calcReq = fixedCalcRequired(1, holds);

    assignServicesPass1([cooked], window, calcReq);

    // Only 2 services fit (5L stock - 3L catering = 2L for services).
    expect(cooked.services.length).toBe(2);
  });
});

// ── Step 4: Pass 2 (2-newest) ──────────────────────────────────────────────

describe('assignServicesPass2', () => {
  test('2-newest pairs newest with second-newest at each slot', () => {
    const window = makeWindow([
      { iso: '2026-05-06', dayName: 'Wed', cookDate: '06/05/2026' },
      { iso: '2026-05-07', dayName: 'Thu', cookDate: '07/05/2026' },
    ]);
    const tueSoup = makeBatch({ type: 'Soup', cookDate: '05/05/2026', name: 'Tue Soup' });
    const wedSoup = makeBatch({ type: 'Soup', cookDate: '06/05/2026', name: 'Wed Soup' });
    const thuSoup = makeBatch({ type: 'Soup', cookDate: '07/05/2026', name: 'Thu Soup' });
    const batches = [tueSoup, wedSoup, thuSoup];

    assignServicesPass2(batches, window, fixedCalcRequired(1));

    // Wed dinner: Wed-soup is the newest servable; Tue-soup is second-newest.
    const wedDinnerWest = batches.filter(b => b.services.some(s => s.loc === 'west' && s.date === '2026-05-06' && s.meal === 'dinner'));
    expect(wedDinnerWest.map(b => b.name).sort()).toEqual(['Tue Soup', 'Wed Soup']);

    // Thu lunch: Thu-soup not yet servable (cookDate=Thu, only dinner of Thu onwards). So Wed+Tue.
    const thuLunchWest = batches.filter(b => b.services.some(s => s.loc === 'west' && s.date === '2026-05-07' && s.meal === 'lunch'));
    expect(thuLunchWest.map(b => b.name).sort()).toEqual(['Tue Soup', 'Wed Soup']);

    // Thu dinner: Thu-soup is newest, Wed-soup is second. Tue-soup retires.
    const thuDinnerWest = batches.filter(b => b.services.some(s => s.loc === 'west' && s.date === '2026-05-07' && s.meal === 'dinner'));
    expect(thuDinnerWest.map(b => b.name).sort()).toEqual(['Thu Soup', 'Wed Soup']);
  });

  test('Sundays 3 same-day soups distribute evenly via least-loaded tiebreaker', () => {
    // With the least-loaded tiebreaker, same-cookDate batches stay within 1
    // service of each other regardless of how the bucket shrinks mid-slot.
    const window = makeWindow([
      { iso: '2026-05-03', dayName: 'Sun', cookDate: '03/05/2026' },
      { iso: '2026-05-04', dayName: 'Mon', cookDate: '04/05/2026' },
      { iso: '2026-05-05', dayName: 'Tue', cookDate: '05/05/2026' },
    ]);
    const a = makeBatch({ type: 'Soup', cookDate: '03/05/2026', name: 'Sun Soup A' });
    const b = makeBatch({ type: 'Soup', cookDate: '03/05/2026', name: 'Sun Soup B' });
    const c = makeBatch({ type: 'Soup', cookDate: '03/05/2026', name: 'Sun Soup C' });
    const tue = makeBatch({ type: 'Soup', cookDate: '05/05/2026', name: 'Tue Soup' });

    assignServicesPass2([a, b, c, tue], window, fixedCalcRequired(1));

    // No orphans.
    expect(a.services.length).toBeGreaterThan(0);
    expect(b.services.length).toBeGreaterThan(0);
    expect(c.services.length).toBeGreaterThan(0);
    expect(tue.services.length).toBeGreaterThan(0);

    // Strong fairness: max-min ≤ 1 across the same-cookDate Sun batches.
    const counts = [a.services.length, b.services.length, c.services.length];
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });

  test('frozen batches never auto-assigned', () => {
    const window = makeWindow([
      { iso: '2026-05-06', dayName: 'Wed', cookDate: '06/05/2026' },
    ]);
    const frozen = makeBatch({ type: 'Soup', cookDate: '01/05/2026', stock: 5, storage: 'Frozen', name: 'Frozen Pea' });
    assignServicesPass2([frozen], window, fixedCalcRequired(1));
    expect(frozen.services.length).toBe(0);
  });

  test('cooked batch at stock limit gets skipped (next candidate picked)', () => {
    const window = makeWindow([
      { iso: '2026-05-06', dayName: 'Wed', cookDate: '06/05/2026' },
    ]);
    // Maxed-out cooked: 1L stock, already at limit
    const maxed = makeBatch({ type: 'Soup', cookDate: '05/05/2026', stock: 1, name: 'Maxed' });
    maxed.services = [{ loc: 'west', date: '2026-05-05', meal: 'dinner' }];
    // Available alternative
    const fresh = makeBatch({ type: 'Soup', cookDate: '05/05/2026', name: 'Fresh' });

    assignServicesPass2([maxed, fresh], window, fixedCalcRequired(1));

    // Maxed should not have gained any new services; Fresh covers Wed slots.
    expect(maxed.services.length).toBe(1);
    expect(fresh.services.length).toBeGreaterThan(0);
  });

  test('same batch never appears in both slots of one service', () => {
    const window = makeWindow([
      { iso: '2026-05-06', dayName: 'Wed', cookDate: '06/05/2026' },
    ]);
    // Only one batch available — second slot must remain empty (not a duplicate).
    const onlyOne = makeBatch({ type: 'Soup', cookDate: '05/05/2026', name: 'OnlyOne' });
    assignServicesPass2([onlyOne], window, fixedCalcRequired(1));

    // Group services by (loc, date, meal) and assert no duplicates of OnlyOne.
    const slotKeys = onlyOne.services.map(s => `${s.loc}|${s.date}|${s.meal}`);
    expect(new Set(slotKeys).size).toBe(slotKeys.length);
  });

  test('past slots not assigned to', () => {
    const window: PlanDay[] = makeWindow([
      { iso: '2026-05-06', dayName: 'Wed', cookDate: '06/05/2026' },
    ]);
    // Mark all slots as past
    window[0].slots.forEach(s => s.isPast = true);

    const batch = makeBatch({ type: 'Soup', cookDate: '05/05/2026' });
    assignServicesPass2([batch], window, fixedCalcRequired(1));

    expect(batch.services.length).toBe(0);
  });

  test('Centraal slot filled in same pass as West (no separate copy step needed)', () => {
    const window = makeWindow([
      { iso: '2026-05-06', dayName: 'Wed', cookDate: '06/05/2026' },
    ]);
    const wedSoup = makeBatch({ type: 'Soup', cookDate: '05/05/2026', name: 'Wed Soup' });
    assignServicesPass2([wedSoup], window, fixedCalcRequired(1));

    const locsAtWedDinner = wedSoup.services
      .filter(s => s.date === '2026-05-06' && s.meal === 'dinner')
      .map(s => s.loc)
      .sort();
    expect(locsAtWedDinner).toEqual(['centraal', 'west']);
  });
});

// ── Slot helpers ────────────────────────────────────────────────────────────

describe('countTypeInSlot / alreadyInSlot', () => {
  test('counts only matching type+slot combinations', () => {
    const a = makeBatch({ type: 'Soup', cookDate: '05/05/2026' });
    const b = makeBatch({ type: 'Soup', cookDate: '05/05/2026' });
    const c = makeBatch({ type: 'Main course', cookDate: '05/05/2026' });
    a.services = [{ loc: 'west', date: '2026-05-06', meal: 'dinner' }];
    b.services = [{ loc: 'west', date: '2026-05-06', meal: 'dinner' }];
    c.services = [{ loc: 'west', date: '2026-05-06', meal: 'dinner' }];

    expect(countTypeInSlot([a, b, c], 'Soup', 'west', '2026-05-06', 'dinner')).toBe(2);
    expect(countTypeInSlot([a, b, c], 'Main course', 'west', '2026-05-06', 'dinner')).toBe(1);
    expect(countTypeInSlot([a, b, c], 'Soup', 'centraal', '2026-05-06', 'dinner')).toBe(0);

    expect(alreadyInSlot(a, 'west', '2026-05-06', 'dinner')).toBe(true);
    expect(alreadyInSlot(a, 'west', '2026-05-06', 'lunch')).toBe(false);
  });
});

// ── Cook rhythm sanity check ────────────────────────────────────────────────

describe('COOK_RHYTHM constant', () => {
  test('weekly totals match spec (8 soups, 8 mains)', () => {
    const totals = Object.values(COOK_RHYTHM).reduce(
      (acc, day) => ({ soup: acc.soup + day.soup, main: acc.main + day.main }),
      { soup: 0, main: 0 }
    );
    expect(totals.soup).toBe(8);
    expect(totals.main).toBe(8);
  });
  test('SLOTS_PER_TYPE is 2', () => {
    expect(SLOTS_PER_TYPE).toBe(2);
  });
});
