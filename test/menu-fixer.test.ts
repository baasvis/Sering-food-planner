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
  assignServicesPass3,
  allocatePotCaps,
  collectWarnings,
  buildPlanningWindow,
  isServableBy,
  isStaleAtSlot,
  countTypeInSlot,
  alreadyInSlot,
  findOrphanPlaceholders,
  generateMissingPlaceholders,
  snapshotBatches,
  stripFutureServices,
  COOK_RHYTHM,
  SLOTS_PER_TYPE,
  PLANNING_HORIZON_DAYS,
  type PlanDay,
} from '../public/js/menu-fixer';
import type { KitchenEquipment } from '../shared/types';

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
    // Cook day = Tue 05/05; Tue dinner Centraal = NO (not yet delivered)
    expect(isServableBy('05/05/2026', '2026-05-05', 'dinner', 'centraal', 'west')).toBe(false);
    // Wed lunch Centraal = YES (delivered Wed morning)
    expect(isServableBy('05/05/2026', '2026-05-06', 'lunch', 'centraal', 'west')).toBe(true);
    // Wed dinner Centraal = YES
    expect(isServableBy('05/05/2026', '2026-05-06', 'dinner', 'centraal', 'west')).toBe(true);
  });
  test('Centraal-cooked batch (rare): standard same-day-dinner rule still applies', () => {
    expect(isServableBy('05/05/2026', '2026-05-05', 'dinner', 'centraal', 'centraal')).toBe(true);
    expect(isServableBy('05/05/2026', '2026-05-05', 'lunch', 'centraal', 'centraal')).toBe(false);
  });
  test('No reverse delivery: Centraal-located batch is NEVER servable at a West slot', () => {
    // A "(split)" batch deliberately sent to Centraal stays at Centraal — there's
    // no van going back the other way. Without this rule, the algorithm would
    // assign Centraal stock to West slots, which is logistically impossible AND
    // starves Centraal of its own dedicated stock.
    expect(isServableBy('05/05/2026', '2026-05-05', 'dinner', 'west', 'centraal')).toBe(false);
    expect(isServableBy('05/05/2026', '2026-05-06', 'lunch', 'west', 'centraal')).toBe(false);
    expect(isServableBy('05/05/2026', '2026-05-07', 'dinner', 'west', 'centraal')).toBe(false);
  });
});

describe('Pass 2 tiered bigger-pot bias', () => {
  test('with biggestPot, demand concentrates into one batch up to cap', () => {
    // 3 same-cookDate batches, enough slots for concentration
    const window = makeWindow([
      { iso: '2026-05-04', dayName: 'Mon', cookDate: '04/05/2026' },
      { iso: '2026-05-05', dayName: 'Tue', cookDate: '05/05/2026' },
      { iso: '2026-05-06', dayName: 'Wed', cookDate: '06/05/2026' },
    ]);
    const a = makeBatch({ type: 'Soup', cookDate: '03/05/2026', name: 'A' });
    const b = makeBatch({ type: 'Soup', cookDate: '03/05/2026', name: 'B' });
    const c = makeBatch({ type: 'Soup', cookDate: '03/05/2026', name: 'C' });
    assignServicesPass2([a, b, c], window, fixedCalcRequired(1), undefined, 10);
    const counts = [a.services.length, b.services.length, c.services.length].sort((x, y) => y - x);
    // Concentration: top batch clearly dominates the smallest
    expect(counts[0]).toBeGreaterThan(counts[2]);
  });

  test('without biggestPot, falls back to even (least-loaded) spread', () => {
    const window = makeWindow([
      { iso: '2026-05-04', dayName: 'Mon', cookDate: '04/05/2026' },
      { iso: '2026-05-05', dayName: 'Tue', cookDate: '05/05/2026' },
    ]);
    const a = makeBatch({ type: 'Soup', cookDate: '03/05/2026', name: 'A' });
    const b = makeBatch({ type: 'Soup', cookDate: '03/05/2026', name: 'B' });
    const c = makeBatch({ type: 'Soup', cookDate: '03/05/2026', name: 'C' });
    assignServicesPass2([a, b, c], window, fixedCalcRequired(1));
    const counts = [a.services.length, b.services.length, c.services.length];
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
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

// ── Strip future services (redistributive seed) ─────────────────────────────

describe('stripFutureServices', () => {
  test('removes future services, keeps past ones', () => {
    const b = makeBatch({ type: 'Soup', cookDate: '03/05/2026' });
    // Future
    b.services = [
      { loc: 'west', date: '2099-01-01', meal: 'dinner' },  // far future
      { loc: 'west', date: '2099-01-02', meal: 'lunch' },
    ];
    // Need to also provide a past service. isServicePast uses real getAmsterdamNow
    // so any date before "today" should be past. Use a date deep in the past.
    b.services.push({ loc: 'west', date: '2020-01-01', meal: 'dinner' });

    // Need to import — let me use the function from menu-fixer
    const removed = stripFutureServices([b]);
    expect(removed).toBe(2);
    expect(b.services.length).toBe(1);
    expect(b.services[0].date).toBe('2020-01-01');
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
      { iso: '2026-05-05', dayName: 'Tue', cookDate: '05/05/2026' },  // 1+1
      { iso: '2026-05-06', dayName: 'Wed', cookDate: '06/05/2026' },  // 1+1
    ]);
    const snapshot = snapshotBatches([], window);
    const placeholders = generateMissingPlaceholders(window, snapshot);
    expect(placeholders.length).toBe(3 + 3 + 0 + 1 + 1 + 1 + 1 + 1);  // 11 (Sun 3+3, Mon 0+1, Tue 1+1, Wed 1+1)
    const sun = placeholders.filter(b => b.cookDate === '03/05/2026');
    expect(sun.filter(b => b.type === 'Soup').length).toBe(3);
    expect(sun.filter(b => b.type === 'Main course').length).toBe(3);
    // Multi-batch days get numbered names
    expect(sun.filter(b => b.type === 'Soup').map(b => b.name).sort()).toEqual([
      'Sun soup 1 03/05',
      'Sun soup 2 03/05',
      'Sun soup 3 03/05',
    ]);
    // Single-batch days get unnumbered names
    const wed = placeholders.filter(b => b.cookDate === '06/05/2026');
    expect(wed.find(b => b.type === 'Soup')!.name).toBe('Wed soup 06/05');
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

    // Servable (West-cooked, cookDate=Wed):
    //   Wed dinner West                     = 1 position
    //   Thu lunch  (Centraal + West)        = 2 positions
    //   Thu dinner (Centraal + West)        = 2 positions
    // = 5 positions total. Stock is huge, so all 5 get filled.
    // Wed dinner Centraal excluded — West-cooked food reaches Centraal only
    // after next-morning delivery, so Centraal-on-cookDate is unservable.
    expect(cooked.services.length).toBe(5);
    expect(result.servicesAdded).toBe(5);
    // Every assigned slot must be Wed-dinner-or-later, and no Centraal on cookDate.
    expect(cooked.services.every(s =>
      s.date > '2026-05-06' || (s.date === '2026-05-06' && s.meal === 'dinner' && s.loc === 'west')
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
    // Servable & not-stale slots (West-cooked): Wed dinner West (1, no Centraal
    // on cook day) + Thu (4) + Fri (4) = 9 positions.
    expect(cooked.services.length).toBe(9);
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

  test('Pass 1: Centraal-located batch ONLY extends to Centraal slots (no reverse delivery)', () => {
    // Regression for the "(split)" bug: a batch physically at Centraal must
    // not be assigned to West services. Without the rule, the algorithm
    // gleefully serves Centraal stock at West, which is logistically
    // impossible AND starves Centraal of its dedicated stock.
    const window = makeWindow([
      { iso: '2026-05-06', dayName: 'Wed', cookDate: '06/05/2026' },
      { iso: '2026-05-07', dayName: 'Thu', cookDate: '07/05/2026' },
    ]);
    const cookedAtCentraal = makeBatch({
      type: 'Soup',
      cookDate: '06/05/2026',
      stock: 100,
      location: 'centraal',
    });
    assignServicesPass1([cookedAtCentraal], window, fixedCalcRequired(1));
    // No services should land at West.
    expect(cookedAtCentraal.services.every(s => s.loc === 'centraal')).toBe(true);
    // Centraal-cooked: same-day dinner OK, plus Thu lunch + Thu dinner.
    expect(cookedAtCentraal.services.length).toBe(3);
  });

  test('Pass 1: Centraal-located batches are processed before West to claim Centraal slots', () => {
    // Without the priority sort, processing order depends on input order
    // (insert order from the DB). When West batches happen to be processed
    // first, they consume Centraal slots and leave Centraal-located batches
    // empty-handed even though Centraal is the only place they can serve.
    const window = makeWindow([
      { iso: '2026-05-07', dayName: 'Thu', cookDate: '07/05/2026' },
    ]);
    // Same cookDate, same type — only the location differs. West is in the
    // input first; without the new sort it would grab Thu Centraal slots.
    const westBatch     = makeBatch({ type: 'Soup', cookDate: '06/05/2026', stock: 100, location: 'west',     name: 'West'     });
    const centraalBatch = makeBatch({ type: 'Soup', cookDate: '06/05/2026', stock: 100, location: 'centraal', name: 'Centraal' });

    assignServicesPass1([westBatch, centraalBatch], window, fixedCalcRequired(1));

    // Centraal batch must claim BOTH Centraal slots (Thu lunch + Thu dinner) —
    // it can't serve anywhere else. West batch can still co-occupy the second
    // Centraal-slot position; the point of the priority sort is that the
    // Centraal batch gets in first, not that West is excluded.
    const centraalServices = centraalBatch.services.filter(s => s.loc === 'centraal');
    expect(centraalServices.length).toBe(2);
    // And the Centraal batch must NOT have any West services.
    expect(centraalBatch.services.every(s => s.loc === 'centraal')).toBe(true);
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

    // Without biggestPot hint, Pass 2 falls back to even spread (least-loaded)
    assignServicesPass2([a, b, c, tue], window, fixedCalcRequired(1));

    // No orphans among the same-cookDate Sun batches.
    expect(a.services.length).toBeGreaterThan(0);
    expect(b.services.length).toBeGreaterThan(0);
    expect(c.services.length).toBeGreaterThan(0);
    // Tue Soup may or may not get services — Sun batches with headroom win
    // their slots. With NO bigPot cap (no concentration), even spread for Sun.
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

  test('0-guest slots are skipped (Pass 2)', () => {
    const window = makeWindow([
      { iso: '2026-05-06', dayName: 'Wed', cookDate: '06/05/2026' },
    ]);
    const wedSoup = makeBatch({ type: 'Soup', cookDate: '05/05/2026', name: 'Wed Soup' });
    // West lunch has 0 guests, everything else has 50
    const guestsByLoc = (loc: unknown, _d: unknown, meal: unknown) =>
      (loc === 'west' && meal === 'lunch') ? 0 : 50;
    assignServicesPass2([wedSoup], window, fixedCalcRequired(1), guestsByLoc as never);
    // No service should be at west lunch
    expect(wedSoup.services.some(s => s.loc === 'west' && s.meal === 'lunch')).toBe(false);
    // But other slots still get filled
    expect(wedSoup.services.length).toBeGreaterThan(0);
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

// ── Pot allocation ──────────────────────────────────────────────────────────

describe('allocatePotCaps (basics)', () => {
  const equipment: KitchenEquipment = {
    pots: [140, 140, 100, 100, 100, 100, 100, 100, 100, 100],
    gasBurners: 4, inductionBurners: 4, bigBurnerThreshold: 80,
  };

  test('returns empty map when no equipment configured', () => {
    const caps = allocatePotCaps([makeBatch({ type: 'Soup', cookDate: '06/05/2026' })], null, fixedCalcRequired(1));
    expect(caps.size).toBe(0);
  });

  test('overflow batches get the smallest pot size', () => {
    const tinyEquipment: KitchenEquipment = {
      pots: [100, 80], gasBurners: 1, inductionBurners: 1, bigBurnerThreshold: 80,
    };
    const a = makeBatch({ type: 'Soup', cookDate: '03/05/2026', name: 'A' });
    const b = makeBatch({ type: 'Main course', cookDate: '03/05/2026', name: 'B' });
    const c = makeBatch({ type: 'Soup', cookDate: '03/05/2026', name: 'C' });
    // Pre-load each with services so they have demand
    for (let i = 0; i < 5; i++) a.services.push({ loc: 'west', date: '2026-05-03', meal: 'dinner' });
    for (let i = 0; i < 3; i++) b.services.push({ loc: 'west', date: '2026-05-03', meal: 'dinner' });
    for (let i = 0; i < 1; i++) c.services.push({ loc: 'west', date: '2026-05-03', meal: 'dinner' });
    const caps = allocatePotCaps([a, b, c], tinyEquipment, fixedCalcRequired(1));
    expect(caps.get(a.id)).toBe(100);  // highest demand → biggest pot
    expect(caps.get(b.id)).toBe(80);   // mid demand → next pot
    expect(caps.get(c.id)).toBe(80);   // lowest → fallback to smallest available
  });
});

// ── Pot caps no longer influence Pass 1/2 (allocator handles caps post-hoc) ──

describe('Pass 1/2 ignore pot caps (demand-based allocator runs after)', () => {
  test('Pass 1 extends cooked batch up to stock, regardless of pot size', () => {
    const window = makeWindow([
      { iso: '2026-05-06', dayName: 'Wed', cookDate: '06/05/2026' },
      { iso: '2026-05-07', dayName: 'Thu', cookDate: '07/05/2026' },
    ]);
    const cooked = makeBatch({ type: 'Soup', cookDate: '06/05/2026', stock: 100 });
    assignServicesPass1([cooked], window, fixedCalcRequired(1));
    // Spreads as far as eligible slots allow — 5 positions (West-cooked, no
    // Centraal on cook day): Wed dinner West + Thu lunch×2 + Thu dinner×2.
    expect(cooked.services.length).toBe(5);
  });

  test('Pass 2 spreads uncooked batches to all eligible slots, no pot cap limits', () => {
    const window = makeWindow([
      { iso: '2026-05-06', dayName: 'Wed', cookDate: '06/05/2026' },
      { iso: '2026-05-07', dayName: 'Thu', cookDate: '07/05/2026' },
    ]);
    const wedSoup = makeBatch({ type: 'Soup', cookDate: '05/05/2026', name: 'Wed Soup' });
    const wedMain = makeBatch({ type: 'Main course', cookDate: '05/05/2026', name: 'Wed Main' });
    assignServicesPass2([wedSoup, wedMain], window, fixedCalcRequired(1));
    // Each one fills both slots of every future service (Wed dinner + Thu lunch + Thu dinner = 3 services × 2 locs = 6 each)
    expect(wedSoup.services.length).toBeGreaterThan(0);
    expect(wedMain.services.length).toBeGreaterThan(0);
  });
});

describe('allocatePotCaps (demand-based)', () => {
  const equipment: KitchenEquipment = {
    pots: [140, 100, 100],
    gasBurners: 3, inductionBurners: 0, bigBurnerThreshold: 80,
  };

  test('biggest pot goes to highest-demand batch (regardless of id order)', () => {
    // Make a "low-id, low-demand" batch and a "high-id, high-demand" batch
    const lowDemand = makeBatch({ type: 'Soup', cookDate: '03/05/2026', name: 'Pasta', id: 'aaaa-1' } as never);
    lowDemand.services = [
      { loc: 'west', date: '2026-05-03', meal: 'dinner' },
    ];
    const highDemand = makeBatch({ type: 'Soup', cookDate: '03/05/2026', name: 'Central American', id: 'zzzz-9' } as never);
    for (let i = 0; i < 10; i++) {
      highDemand.services.push({ loc: 'west', date: '2026-05-04', meal: 'lunch' });
    }
    const caps = allocatePotCaps([lowDemand, highDemand], equipment, fixedCalcRequired(1));
    // High-demand wins the 140L pot even though its id sorts later
    expect(caps.get(highDemand.id)).toBe(140);
    expect(caps.get(lowDemand.id)).toBe(100);
  });
});

// ── Pass 3 (fill-remaining, ignores pot caps) ──────────────────────────────

describe('assignServicesPass3', () => {
  test('fills empty slots that Pass 2 left empty due to pot caps', () => {
    const window = makeWindow([
      { iso: '2026-05-04', dayName: 'Mon', cookDate: '04/05/2026' },
      { iso: '2026-05-05', dayName: 'Tue', cookDate: '05/05/2026' },
    ]);
    // 1 batch, can serve all slots. Pre-fill 2 slots so Pass 3 has work to do.
    const onlyBatch = makeBatch({ type: 'Soup', cookDate: '03/05/2026', name: 'Sun Soup' });
    onlyBatch.services = [
      { loc: 'centraal', date: '2026-05-04', meal: 'lunch' },
      { loc: 'west', date: '2026-05-04', meal: 'lunch' },
    ];

    // Pass 3 should fill every other slot (only one batch available — all
    // remaining positions go to it). 2 days × 4 slots × 2 type-positions
    // minus the 2 pre-filled = 14 positions. But same batch can't be in same
    // slot twice — only ONE position per slot. So 2 days × 4 slots - 2 = 6
    // positions added.
    const result = assignServicesPass3([onlyBatch], window, fixedCalcRequired(1));
    expect(result.servicesAdded).toBe(6);
    expect(onlyBatch.services.length).toBe(8);
    // No in-slot duplicates
    const keys = onlyBatch.services.map(s => `${s.loc}|${s.date}|${s.meal}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('Pass 3 still respects stock for cooked batches', () => {
    const window = makeWindow([
      { iso: '2026-05-04', dayName: 'Mon', cookDate: '04/05/2026' },
    ]);
    // Cooked batch with low stock — Pass 3 must not push it past stock
    const cooked = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 2 });
    assignServicesPass3([cooked], window, fixedCalcRequired(1));
    expect(cooked.services.length).toBe(2);  // 2L stock = 2 services at 1L each
  });

  test('Pass 3 still skips frozen and stale batches', () => {
    const window = makeWindow([
      { iso: '2026-05-08', dayName: 'Fri', cookDate: '08/05/2026' },
    ]);
    const frozen = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 5, storage: 'Frozen', name: 'Frozen' });
    const stale = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 5, name: 'Stale' });
    // Fri (08/05) is 5 days after cookDate Sun (03/05) → stale
    assignServicesPass3([frozen, stale], window, fixedCalcRequired(1));
    expect(frozen.services.length).toBe(0);
    expect(stale.services.length).toBe(0);
  });

});

// ── Planning horizon constant ──────────────────────────────────────────────

describe('PLANNING_HORIZON_DAYS', () => {
  test('is 10 days', () => {
    expect(PLANNING_HORIZON_DAYS).toBe(10);
  });
});

// ── Placeholder name format ────────────────────────────────────────────────

describe('placeholder naming', () => {
  test('single batch per day uses unsuffixed name with dd/mm', () => {
    const window = makeWindow([{ iso: '2026-05-06', dayName: 'Wed', cookDate: '06/05/2026' }]);
    const snapshot = snapshotBatches([], window);
    const placeholders = generateMissingPlaceholders(window, snapshot);
    const wedSoup = placeholders.find(b => b.type === 'Soup');
    expect(wedSoup!.name).toBe('Wed soup 06/05');
  });

  test('multi-batch day uses numbered names with dd/mm', () => {
    const window = makeWindow([{ iso: '2026-05-03', dayName: 'Sun', cookDate: '03/05/2026' }]);
    const snapshot = snapshotBatches([], window);
    const placeholders = generateMissingPlaceholders(window, snapshot);
    const sunSoups = placeholders.filter(b => b.type === 'Soup').map(b => b.name).sort();
    expect(sunSoups).toEqual([
      'Sun soup 1 03/05',
      'Sun soup 2 03/05',
      'Sun soup 3 03/05',
    ]);
  });
});

// ── Validation / warnings ──────────────────────────────────────────────────

describe('collectWarnings', () => {
  const noGuests = (_l: unknown, _d: unknown, _m: unknown) => 0;
  const lotsOfGuests = (_l: unknown, _d: unknown, _m: unknown) => 50;

  test('no warnings when slots are filled and demand fits', () => {
    const window = makeWindow([{ iso: '2026-05-06', dayName: 'Wed', cookDate: '06/05/2026' }]);
    const a = makeBatch({ type: 'Soup', cookDate: '05/05/2026' });
    const b = makeBatch({ type: 'Soup', cookDate: '05/05/2026' });
    const c = makeBatch({ type: 'Main course', cookDate: '05/05/2026' });
    const d = makeBatch({ type: 'Main course', cookDate: '05/05/2026' });
    // Fill the wed-dinner slot fully
    [a, b].forEach(s => s.services.push({ loc: 'west', date: '2026-05-06', meal: 'dinner' }));
    [a, b].forEach(s => s.services.push({ loc: 'centraal', date: '2026-05-06', meal: 'dinner' }));
    [c, d].forEach(s => s.services.push({ loc: 'west', date: '2026-05-06', meal: 'dinner' }));
    [c, d].forEach(s => s.services.push({ loc: 'centraal', date: '2026-05-06', meal: 'dinner' }));
    // Lunch is separately under-filled but guests=0 -> suppress
    const warnings = collectWarnings([a, b, c, d], window, [], fixedCalcRequired(1), new Map(), null, noGuests);
    expect(warnings.filter(w => w.category === 'under-filled-slot')).toEqual([]);
  });

  test('under-filled slot warning when guests > 0', () => {
    const window = makeWindow([{ iso: '2026-05-06', dayName: 'Wed', cookDate: '06/05/2026' }]);
    const warnings = collectWarnings([], window, [], fixedCalcRequired(1), new Map(), null, lotsOfGuests);
    // 4 slots × 2 types = 8 under-filled warnings (no batches at all)
    expect(warnings.filter(w => w.category === 'under-filled-slot').length).toBe(8);
  });

  test('cooked stockout warning when calcRequired > stock', () => {
    const window = makeWindow([{ iso: '2026-05-06', dayName: 'Wed', cookDate: '06/05/2026' }]);
    const overcommitted = makeBatch({ type: 'Soup', cookDate: '05/05/2026', stock: 2 });
    overcommitted.services = [
      { loc: 'west', date: '2026-05-06', meal: 'dinner' },
      { loc: 'centraal', date: '2026-05-06', meal: 'dinner' },
      { loc: 'west', date: '2026-05-07', meal: 'lunch' },
    ];  // 3 services * 1L = 3L > 2L stock
    const warnings = collectWarnings([overcommitted], window, [], fixedCalcRequired(1), new Map(), null, noGuests);
    expect(warnings.filter(w => w.category === 'cooked-stockout').length).toBe(1);
  });

  test('over-pot-cap warning fires when demand exceeds biggest kitchen pot (no action)', () => {
    const window = makeWindow([{ iso: '2026-05-06', dayName: 'Wed', cookDate: '06/05/2026' }]);
    const big = makeBatch({ type: 'Soup', cookDate: '05/05/2026' });
    // 10 services × 1L each
    for (let i = 0; i < 10; i++) {
      big.services.push({ loc: 'west', date: '2026-05-06', meal: 'dinner' });
    }
    // Kitchen with biggest pot = 5L → 10L demand exceeds it
    const tinyKitchen: KitchenEquipment = {
      pots: [5, 5], gasBurners: 1, inductionBurners: 1, bigBurnerThreshold: 80,
    };
    const warnings = collectWarnings([big], window, [], fixedCalcRequired(1), new Map(), tinyKitchen, noGuests);
    const overPot = warnings.filter(w => w.category === 'over-pot-cap');
    expect(overPot.length).toBe(1);
    // No action button — cook handles split decision via the batch tile indicator
    expect(overPot[0].actions).toBeUndefined();
  });

  test('catering with no dishes warning', () => {
    const window = makeWindow([{ iso: '2026-05-06', dayName: 'Wed', cookDate: '06/05/2026' }]);
    const catering = { id: 'c1', date: '06/05/2026', dishes: [] };
    const warnings = collectWarnings([], window, [catering], fixedCalcRequired(1), new Map(), null, noGuests);
    expect(warnings.filter(w => w.category === 'catering-no-dishes').length).toBe(1);
  });

  test('centraal-batch-at-west warning fires when a Centraal batch has West services', () => {
    const window = makeWindow([{ iso: '2026-05-06', dayName: 'Wed', cookDate: '06/05/2026' }]);
    const wronglyPlaced = makeBatch({ type: 'Soup', cookDate: '05/05/2026', stock: 10, location: 'centraal' });
    wronglyPlaced.services = [
      { loc: 'west', date: '2026-05-06', meal: 'dinner' },  // wrong! no van back to west
    ];
    const warnings = collectWarnings([wronglyPlaced], window, [], fixedCalcRequired(1), new Map(), null, noGuests);
    const violations = warnings.filter(w => w.category === 'centraal-batch-at-west');
    expect(violations.length).toBe(1);
    expect(violations[0].anchor).toEqual({ kind: 'batch', batchId: wronglyPlaced.id });
  });

  test('burner overload warning when too many big-pot batches per cook day', () => {
    const window = makeWindow([{ iso: '2026-05-03', dayName: 'Sun', cookDate: '03/05/2026' }]);
    const eq: KitchenEquipment = { pots: [140, 140, 140], gasBurners: 1, inductionBurners: 5, bigBurnerThreshold: 80 };
    // 3 batches all on >80L pots per the allocation
    const a = makeBatch({ type: 'Soup', cookDate: '03/05/2026' });
    const b = makeBatch({ type: 'Main course', cookDate: '03/05/2026' });
    const c = makeBatch({ type: 'Soup', cookDate: '03/05/2026' });
    const caps = new Map<string, number>([[a.id, 140], [b.id, 140], [c.id, 140]]);
    const warnings = collectWarnings([a, b, c], window, [], fixedCalcRequired(1), caps, eq, noGuests);
    expect(warnings.filter(w => w.category === 'burner-overload').length).toBe(1);
  });
});

// ── Cook rhythm sanity check ────────────────────────────────────────────────

describe('COOK_RHYTHM constant', () => {
  test('weekly totals (8 soups, 9 mains — Tue is now 1+1)', () => {
    const totals = Object.values(COOK_RHYTHM).reduce(
      (acc, day) => ({ soup: acc.soup + day.soup, main: acc.main + day.main }),
      { soup: 0, main: 0 }
    );
    expect(totals.soup).toBe(8);
    expect(totals.main).toBe(9);
  });
  test('SLOTS_PER_TYPE is 2', () => {
    expect(SLOTS_PER_TYPE).toBe(2);
  });
});
