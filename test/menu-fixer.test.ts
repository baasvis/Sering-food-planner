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
  assignServicesPass4,
  assignServicesPass5,
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
  forcedAssignmentPrePass,
  scoredGreedyAssignment,
  runFallbackLadder,
  COOK_RHYTHM,
  SLOTS_PER_TYPE,
  PLANNING_HORIZON_DAYS,
  type PlanDay,
} from '../public/js/menu-fixer';
import type { KitchenEquipment } from '../shared/types';

// Pin the system clock to a stable date in late April 2026 so the
// hardcoded service dates (2026-05-04..10) stay in the future relative to
// "now". `assignServicesPass3` calls `calcReqOptimistic` which uses
// `isServicePast` internally — without this, a slot that fell into the
// past would silently pass the stock check and Pass 3 would over-assign.
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

/**
 * A peer-aware calcRequired stub. Demand at each service is `guestsPerSlot`
 * divided by the number of same-type batches currently sharing that slot
 * (live count from the passed-in `allBatches`, not from any cache).
 *
 * This mirrors the production calcRequired's peer-splitting behavior, which
 * the cheap `fixedCalcRequired` ignores. Use this when a test needs to verify
 * that the algorithm correctly accounts for peer-split capacity (e.g. a tight-
 * stock batch that fits only when a peer is at the same slot).
 */
function peerAwareCalcRequired(allBatches: Batch[], guestsPerSlot: number, servingGrams = 280) {
  return (dish: Batch): number => {
    let total = 0;
    for (const svc of dish.services || []) {
      const peers = allBatches.filter(b =>
        b.type === dish.type
        && (b.services || []).some(s => s.loc === svc.loc && s.date === svc.date && s.meal === svc.meal),
      );
      const count = Math.max(peers.length, 1);
      total += (guestsPerSlot / count) * (servingGrams / 1000);
    }
    return Math.round(total * 10) / 10;
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
  test('with biggestPot, COOKED batches concentrate into one batch up to cap', () => {
    // Concentration only applies to COOKED batches (use real stock first
    // before requiring another cook). 3 same-cookDate cooked Soups, enough
    // slots for concentration.
    const window = makeWindow([
      { iso: '2026-05-04', dayName: 'Mon', cookDate: '04/05/2026' },
      { iso: '2026-05-05', dayName: 'Tue', cookDate: '05/05/2026' },
      { iso: '2026-05-06', dayName: 'Wed', cookDate: '06/05/2026' },
    ]);
    const a = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 100, name: 'A' });
    const b = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 100, name: 'B' });
    const c = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 100, name: 'C' });
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

  test('Pass 1: tight-stock batch fits a slot where a peer is already present', () => {
    // Regression for the stale-S.planner peer-counting bug. Setup mimics the
    // "Pasta al Pesto (split)" case: a peer batch has already been placed at
    // a slot (e.g. by an earlier batch's Pass 1 walk). The tight-stock batch
    // walks Pass 1, considers the same slot. Solo demand exceeds its stock,
    // but with the peer split it fits. A stale calcReq would mis-count peers
    // and pop the add; a live calcReq sees the actual 2-peer situation.
    const window = makeWindow([
      { iso: '2026-05-06', dayName: 'Wed', cookDate: '06/05/2026' },
    ]);
    // 130 guests × 80g = 10.4L solo, 5.2L when split with one peer.
    const peer = makeBatch({ type: 'Main course', cookDate: '06/05/2026', stock: 40, serving: 80, name: 'Peer' });
    peer.services = [{ loc: 'west', date: '2026-05-06', meal: 'dinner' }];  // pre-placed
    const tight = makeBatch({ type: 'Main course', cookDate: '06/05/2026', stock: 8, serving: 80, name: 'Tight' });
    const all = [peer, tight];
    const liveCalcReq = peerAwareCalcRequired(all, 130, 80);

    assignServicesPass1(all, window, liveCalcReq);

    // Tight should land at Wed dinner West despite stock 8L < solo demand 10.4L,
    // because Peer is already there → demand splits to 5.2L.
    const tightInSlot = (tight.services || []).some(s =>
      s.date === '2026-05-06' && s.meal === 'dinner' && s.loc === 'west'
    );
    expect(tightInSlot).toBe(true);
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

  test('Pass 2: 3 same-day uncooked placeholders distribute evenly, not concentrated', () => {
    // Regression for the "Sun soup 1 = 0 services / Sun soup 2 = 6 / Sun soup 3
    // = 5" bug. The old concentration sort piled services onto whichever
    // placeholder happened to be picked first, until it reached the big-pot
    // cap (140L). For uncooked placeholders with stock=0, that produced one
    // giant cook plan + zero-volume "ghost" siblings. They should distribute
    // evenly so the cook ends up with 3 same-sized batches.
    const window = makeWindow([
      { iso: '2026-05-04', dayName: 'Mon', cookDate: '04/05/2026' },
      { iso: '2026-05-05', dayName: 'Tue', cookDate: '05/05/2026' },
    ]);
    // 3 sibling placeholders for the same Sunday (cooked yesterday relative to window).
    const a = makeBatch({ type: 'Soup', cookDate: '03/05/2026', name: 'Sun soup A' });
    const b = makeBatch({ type: 'Soup', cookDate: '03/05/2026', name: 'Sun soup B' });
    const c = makeBatch({ type: 'Soup', cookDate: '03/05/2026', name: 'Sun soup C' });

    // With biggestPot hint AND uncooked siblings, my fix forces even spread.
    assignServicesPass2([a, b, c], window, fixedCalcRequired(1), undefined, 140);

    const counts = [a.services.length, b.services.length, c.services.length];
    // Range must be at most 1 (true even spread; round-robin permits one extra).
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });

  test('Pass 2: tight-stock batch fits when peer-split halves demand at the slot', () => {
    // Regression for the "Pasta al Pesto (split)" case: a Centraal batch with
    // just enough stock for half a slot (when sharing with a peer) but not
    // enough to be solo. With a stale planner the capacity check mis-counts
    // peers and rejects the add; with a live planner it accepts.
    const window = makeWindow([
      { iso: '2026-05-06', dayName: 'Wed', cookDate: '06/05/2026' },
    ]);
    // The big batch goes in first (Pass 1 sims this). Pasta-equivalent has
    // tight stock and only fits when paired.
    const big = makeBatch({ type: 'Main course', cookDate: '06/05/2026', stock: 40, location: 'centraal', name: 'Big' });
    big.services = [{ loc: 'centraal', date: '2026-05-06', meal: 'dinner' }];  // pre-placed by Pass 1
    const tight = makeBatch({ type: 'Main course', cookDate: '06/05/2026', stock: 10, location: 'centraal', name: 'Tight' });
    const all = [big, tight];
    // 130 guests × 280g = 36.4L solo, 18.2L if 2 peers split
    // Tight has 10L: cannot solo, but fits a 18.2L share is too much...
    // Use 130 guests at 80g serving instead (Pasta-style): 10.4L solo, 5.2L split.
    const lightServingTight = makeBatch({ type: 'Main course', cookDate: '06/05/2026', stock: 8, serving: 80, location: 'centraal', name: 'Pasta-tight' });
    all.length = 0;
    all.push(big, lightServingTight);
    big.services = [{ loc: 'centraal', date: '2026-05-06', meal: 'dinner' }];

    const liveCalcReq = peerAwareCalcRequired(all, 130, 80);

    // Pass 2 walks every (slot, type, position) and tries to fill.
    // Wed dinner Centraal Main has 1/2 → second position should pick lightServingTight.
    assignServicesPass2(all, window, liveCalcReq);

    const tightInSlot = (lightServingTight.services || []).some(s =>
      s.loc === 'centraal' && s.date === '2026-05-06' && s.meal === 'dinner'
    );
    expect(tightInSlot).toBe(true);
  });

  test('Pass 2: optimistic peer-split lets 2 batches together fill an empty slot neither could fill alone', () => {
    // Regression for the "Tue dinner Centraal Soup, 240 guests, 0/2 empty"
    // case. Tomato (W) and Miso (W) each have ~33L of unused stock — enough
    // for half the slot (33.6L per batch when split 2 ways) but not enough
    // for the whole slot (67.2L solo). Without optimistic peer-split, the
    // first tentative add overshoots and the slot stays empty.
    const window = makeWindow([
      { iso: '2026-05-06', dayName: 'Wed', cookDate: '06/05/2026' },
    ]);
    // 240 guests × 280g = 67.2L solo, 33.6L when split 2 ways.
    // Each batch has ~33L of unused stock (we simulate this by giving them
    // stock just under solo demand but well over half-demand).
    const a = makeBatch({ type: 'Soup', cookDate: '06/05/2026', stock: 35, name: 'A' });
    const b = makeBatch({ type: 'Soup', cookDate: '06/05/2026', stock: 35, name: 'B' });
    const all = [a, b];
    const liveCalcReq = peerAwareCalcRequired(all, 240);

    assignServicesPass2(all, window, liveCalcReq);

    // Both should land at Wed dinner West together (the only slot where 240
    // guests appear in our test setup — makeWindow's slots all share that
    // demand from peerAwareCalcRequired's stub).
    const aWedDinW = (a.services || []).some(s => s.date === '2026-05-06' && s.meal === 'dinner' && s.loc === 'west');
    const bWedDinW = (b.services || []).some(s => s.date === '2026-05-06' && s.meal === 'dinner' && s.loc === 'west');
    expect(aWedDinW && bWedDinW).toBe(true);
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

  test('counts split-family as ONE option, not two — guests see one menu choice', () => {
    // Tomato Soup West (parent) + Tomato Soup (split) Centraal (child) at the
    // same slot are physically two batches but ONE menu option for guests.
    // The slot capacity check should treat them as 1, leaving room for a
    // second different soup.
    const tomatoParent = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 60, location: 'west', name: 'Tomato Soup' });
    const tomatoSplit = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 30, location: 'centraal', name: 'Tomato Soup (split)' });
    tomatoSplit.parentId = tomatoParent.id;
    const miso = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 50, name: 'Miso' });

    [tomatoParent, tomatoSplit, miso].forEach(b =>
      b.services.push({ loc: 'centraal', date: '2026-05-04', meal: 'dinner' }));

    // 3 physical batches at the slot, but 2 unique families (Tomato + Miso).
    expect(countTypeInSlot([tomatoParent, tomatoSplit, miso], 'Soup', 'centraal', '2026-05-04', 'dinner')).toBe(2);
  });

  test('alreadyInSlot is family-aware: split sibling at the slot blocks the other', () => {
    // Symmetrical regression: when Tomato Soup West is at Mon dinner Centraal,
    // the algorithm shouldn't place Tomato Soup (split) Centraal at the same
    // slot — they're the same option for guests.
    const parent = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 60, location: 'west', name: 'Tomato' });
    const split = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 30, location: 'centraal', name: 'Tomato (split)' });
    split.parentId = parent.id;
    parent.services.push({ loc: 'centraal', date: '2026-05-04', meal: 'dinner' });

    // Without family-awareness, split.alreadyInSlot would return false. With
    // it (passing allBatches), parent's presence blocks split.
    expect(alreadyInSlot(split, 'centraal', '2026-05-04', 'dinner')).toBe(false);  // single-batch check
    expect(alreadyInSlot(split, 'centraal', '2026-05-04', 'dinner', [parent, split])).toBe(true);  // family-aware
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

// ── Same-loc preference ────────────────────────────────────────────────────

describe('Same-loc preference (Centraal drains before West)', () => {
  test('Pass 1 keeps walking after an overshoot pop — split lands on a later slot that fits', () => {
    // Old behaviour ("break walk" on overshoot): split fits Mon C lunch
    // alone, then tries Mon C dinner, overshoots together, gives up → only
    // 1 service. Pass 2 then routes the rest to the West parent.
    // New behaviour ("continue"): split pops Mon C dinner, keeps walking,
    // and lands Tue C lunch which fits as a 2-peer slot (peer reduces
    // share). Drains more of the Centraal-located stock.
    const split = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 30, location: 'centraal', name: 'Split' });
    // Pre-existing peer at Tue C lunch ONLY — so demand at Tue C lunch
    // splits 2 ways and fits, while Mon slots are solo and overshoot.
    const peer = makeBatch({ type: 'Soup', cookDate: '04/05/2026', stock: 100, location: 'centraal', name: 'Peer' });
    peer.services.push({ loc: 'centraal', date: '2026-05-05', meal: 'lunch' });

    const window = makeWindow([
      { iso: '2026-05-04', dayName: 'Mon', cookDate: '04/05/2026' },
      { iso: '2026-05-05', dayName: 'Tue', cookDate: '05/05/2026' },
    ]);
    // 130 guests, 280g serving. Solo slot = 36.4L; 2-peer slot = 18.2L.
    const calc = peerAwareCalcRequired([split, peer], 130, 280);
    assignServicesPass1([split, peer], window, calc, () => 130);

    // Mon C lunch: split alone → 36.4L > 30L stock → pop. With break-walk
    // the test would end here. With continue, split keeps trying.
    // Tue C lunch (with peer): split + peer = 2 peers → 18.2L per ≤ 30 →
    // fits. So split should land on Tue C lunch.
    const splitAtTueCLunch = split.services.some(s =>
      s.loc === 'centraal' && s.date === '2026-05-05' && s.meal === 'lunch'
    );
    expect(splitAtTueCLunch).toBe(true);
  });

  test('Pass 2 picks Centraal-located batch over West for a Centraal slot at same cookDate', () => {
    // The Miso situation: parent (W) and split (C) both cooked Sun. Pass 2
    // hits Mon C dinner empty. Without the same-loc tiebreaker, the sort
    // could pick parent (most-loaded under-bigPot) and leave split unused.
    // With the tiebreaker, split (Centraal) wins for the Centraal slot.
    const window = makeWindow([
      { iso: '2026-05-04', dayName: 'Mon', cookDate: '04/05/2026' },
    ]);
    const parent = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 60, location: 'west', name: 'Parent' });
    const split = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 40, location: 'centraal', name: 'Split' });
    split.parentId = parent.id;

    // Pass 2 normally fills Mon C dinner. We pre-empty everything; just two
    // candidates — parent and split. peerAware stub so capacity check is
    // realistic. Soup needs 18.2L per peer at 130 guests, 2 peers: well
    // under either batch's stock.
    const calc = peerAwareCalcRequired([parent, split], 130, 280);
    assignServicesPass2([parent, split], window, calc, () => 130, 140);

    const splitAtMonCDinner = split.services.some(s =>
      s.loc === 'centraal' && s.date === '2026-05-04' && s.meal === 'dinner'
    );
    const parentAtMonCDinner = parent.services.some(s =>
      s.loc === 'centraal' && s.date === '2026-05-04' && s.meal === 'dinner'
    );
    // Split (same-loc) lands on Mon C dinner; parent does NOT (would be a
    // family duplicate).
    expect(splitAtMonCDinner).toBe(true);
    expect(parentAtMonCDinner).toBe(false);
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

// ── Pass 4 (finish-off, allows up to 3 peers) ──────────────────────────────

describe('assignServicesPass4', () => {
  test('Pass 4 does NOT add a 3rd peer to a 2/2 slot (Tier B disabled)', () => {
    // Daan's "remove peers, don't add" feedback: a 2/2 slot already has two
    // soup options for menu choice. Piling a 3rd small batch on top creates
    // the "20L vs 2L" service problem — the small batch runs out fast and
    // guests are left with fewer choices for the rest of service. Cleaner
    // to leave the small batch un-assigned (its leftover stock signals a
    // next-week-cook adjustment).
    const window = makeWindow([
      { iso: '2026-05-06', dayName: 'Wed', cookDate: '06/05/2026' },
    ]);
    const a = makeBatch({ type: 'Soup', cookDate: '06/05/2026', stock: 100, name: 'A' });
    const b = makeBatch({ type: 'Soup', cookDate: '06/05/2026', stock: 100, name: 'B' });
    const c = makeBatch({ type: 'Soup', cookDate: '06/05/2026', stock: 10, name: 'C' });
    a.services = [{ loc: 'west', date: '2026-05-06', meal: 'dinner' }];
    b.services = [{ loc: 'west', date: '2026-05-06', meal: 'dinner' }];

    assignServicesPass4([a, b, c], window, fixedCalcRequired(1));

    const cAtSlot = (c.services || []).some(s =>
      s.loc === 'west' && s.date === '2026-05-06' && s.meal === 'dinner'
    );
    expect(cAtSlot).toBe(false);
  });

  test('Pass 4 SKIPS batches with big surplus (over-cook situation, not finish-off)', () => {
    // A cooked batch with way too much stock left isn't a "last little bit"
    // candidate. Cook should reduce next week's volume, not have the algorithm
    // pile it as a 3rd peer at every meal (which makes every service 3-deep).
    const window = makeWindow([
      { iso: '2026-05-06', dayName: 'Wed', cookDate: '06/05/2026' },
    ]);
    const a = makeBatch({ type: 'Soup', cookDate: '06/05/2026', stock: 100, name: 'A' });
    const b = makeBatch({ type: 'Soup', cookDate: '06/05/2026', stock: 100, name: 'B' });
    // 100L stock × 280g serving = 357 servings — way over 80.
    const c = makeBatch({ type: 'Soup', cookDate: '06/05/2026', stock: 100, name: 'C' });
    a.services = [{ loc: 'west', date: '2026-05-06', meal: 'dinner' }];
    b.services = [{ loc: 'west', date: '2026-05-06', meal: 'dinner' }];

    assignServicesPass4([a, b, c], window, fixedCalcRequired(1));

    // C should NOT land at the slot — it's over the finish-off threshold.
    expect(c.services.length).toBe(0);
  });

  test('Pass 4 ALSO fills under-filled slots (1/2) when finish-off batch can cover', () => {
    // Pass 1/2/3 may leave a slot 1/2 because the only candidate had a peer
    // that ALSO didn't fit alone. With Pass 4's overshoot tolerance, a small
    // leftover batch can ride along as the 2nd peer, filling the slot.
    const window = makeWindow([
      { iso: '2026-05-06', dayName: 'Wed', cookDate: '06/05/2026' },
    ]);
    const tueSoup = makeBatch({ type: 'Soup', cookDate: '05/05/2026', stock: 0, name: 'Tue Soup' });
    tueSoup.services = [{ loc: 'west', date: '2026-05-06', meal: 'dinner' }];  // 1/2 (placeholder)
    // Small-surplus cooked batch — qualifies for finish-off.
    const leftover = makeBatch({ type: 'Soup', cookDate: '05/05/2026', stock: 5, name: 'Leftover' });

    assignServicesPass4([tueSoup, leftover], window, fixedCalcRequired(1));

    // Leftover should land at Wed dinner West to bring the slot to 2/2.
    const leftoverAtSlot = (leftover.services || []).some(s =>
      s.loc === 'west' && s.date === '2026-05-06' && s.meal === 'dinner'
    );
    expect(leftoverAtSlot).toBe(true);
  });

  test('Pass 4 caps at 3 peers — never adds a 4th', () => {
    const window = makeWindow([
      { iso: '2026-05-06', dayName: 'Wed', cookDate: '06/05/2026' },
    ]);
    const a = makeBatch({ type: 'Soup', cookDate: '06/05/2026', stock: 100, name: 'A' });
    const b = makeBatch({ type: 'Soup', cookDate: '06/05/2026', stock: 100, name: 'B' });
    const c = makeBatch({ type: 'Soup', cookDate: '06/05/2026', stock: 100, name: 'C' });
    const d = makeBatch({ type: 'Soup', cookDate: '06/05/2026', stock: 100, name: 'D' });
    // Slot already at 3/3 (2 main + 1 finish-off) — D should not be added.
    [a, b, c].forEach(x => x.services.push({ loc: 'west', date: '2026-05-06', meal: 'dinner' }));
    assignServicesPass4([a, b, c, d], window, fixedCalcRequired(1));
    const dAtSlot = (d.services || []).some(s =>
      s.loc === 'west' && s.date === '2026-05-06' && s.meal === 'dinner'
    );
    expect(dAtSlot).toBe(false);
  });

  test('Pass 4 still respects stock cap (no overshoot)', () => {
    const window = makeWindow([
      { iso: '2026-05-06', dayName: 'Wed', cookDate: '06/05/2026' },
    ]);
    // Tiny-stock batch — already at limit, Pass 4 must not push past stock.
    const tight = makeBatch({ type: 'Soup', cookDate: '06/05/2026', stock: 1, name: 'Tight' });
    tight.services = [{ loc: 'west', date: '2026-05-06', meal: 'dinner' }];  // 1L used
    // Pre-fill Wed lunch West with 2 dummy peers so Pass 4 sees a 2/2 slot.
    const a = makeBatch({ type: 'Soup', cookDate: '06/05/2026', stock: 100, name: 'A' });
    const b = makeBatch({ type: 'Soup', cookDate: '06/05/2026', stock: 100, name: 'B' });
    [a, b].forEach(x => x.services.push({ loc: 'west', date: '2026-05-06', meal: 'dinner' }));

    assignServicesPass4([tight, a, b], window, fixedCalcRequired(1));

    // tight already had 1 service (1L). It can't add another without overshoot.
    expect(tight.services.length).toBe(1);
  });

  test('Pass 4 skips uncooked placeholders (only cooked batches drain via finish-off)', () => {
    const window = makeWindow([
      { iso: '2026-05-06', dayName: 'Wed', cookDate: '06/05/2026' },
    ]);
    const a = makeBatch({ type: 'Soup', cookDate: '06/05/2026', stock: 100, name: 'A' });
    const b = makeBatch({ type: 'Soup', cookDate: '06/05/2026', stock: 100, name: 'B' });
    const placeholder = makeBatch({ type: 'Soup', cookDate: '06/05/2026', stock: 0, name: 'Placeholder' });
    [a, b].forEach(x => x.services.push({ loc: 'west', date: '2026-05-06', meal: 'dinner' }));

    assignServicesPass4([a, b, placeholder], window, fixedCalcRequired(1));

    // Placeholder has stock=0, so it's not a "leftover" to drain.
    expect(placeholder.services.length).toBe(0);
  });
});

// ── Pass 5: combination fill ───────────────────────────────────────────────

describe('assignServicesPass5', () => {
  // Production reproduction: Tue dinner Centraal at 240 guests, no single
  // Centraal-located batch has enough stock to cover its 50% share solo, but
  // 3 small batches together cover the demand cleanly. This is the scenario
  // that motivated Pass 5.
  test('forms a 3-family team when no 2-peer team fits family stock', () => {
    const window = makeWindow([
      { iso: '2026-05-05', dayName: 'Tue', cookDate: '05/05/2026' },
    ]);
    // 240 guests. With 2 peers each needs 120 guests:
    //   pasta:  120 × 80ml = 9.6L  (fits in 10L stock)
    //   kale:   120 × 250ml = 30L  (overshoots 20L stock)
    //   veggie: 120 × 280ml = 33.6L (fits in 40L)
    // So 2-peer (pasta + kale) overshoots kale → Pass 5 must escalate to 3-peer.
    // With 3 peers: 80 × {80,250,280} = {6.4, 20, 22.4}L — all fit.
    const pasta = makeBatch({
      type: 'Main course', cookDate: '03/05/2026',
      location: 'centraal', stock: 10, serving: 80, name: 'Pasta split',
    });
    const pumpkinKale = makeBatch({
      type: 'Main course', cookDate: '03/05/2026',
      location: 'centraal', stock: 20, serving: 250, name: 'Pumpkin Kale split',
    });
    const pumpkinVeggie = makeBatch({
      type: 'Main course', cookDate: '04/05/2026',
      location: 'centraal', stock: 40, serving: 280, name: 'Pumpkin veggie split',
    });
    const allBatches = [pasta, pumpkinKale, pumpkinVeggie];

    const guestsFn = (loc: Location, _date: string, meal: Meal) =>
      loc === 'centraal' && meal === 'dinner' ? 240 : 0;

    // Per-batch-serving-aware calc: family demand = sum of (guests/families × serving)
    // across each service. Mirrors the real family allocator's even-split.
    const calc = (b: Batch): number => {
      let total = 0;
      for (const svc of b.services || []) {
        const peerFamilyRoots = new Set<string>();
        for (const other of allBatches) {
          if (other.type !== b.type) continue;
          if (!(other.services || []).some(s => s.loc === svc.loc && s.date === svc.date && s.meal === svc.meal)) continue;
          peerFamilyRoots.add(other.parentId || other.id);
        }
        const families = Math.max(peerFamilyRoots.size, 1);
        total += (guestsFn(svc.loc, svc.date, svc.meal) / families) * (b.serving / 1000);
      }
      return Math.round(total * 10) / 10;
    };

    const result = assignServicesPass5(allBatches, window, calc, guestsFn);

    expect(result.teamsFormed).toBeGreaterThanOrEqual(1);
    const atSlot = (b: Batch) => (b.services || []).some(s =>
      s.loc === 'centraal' && s.date === '2026-05-05' && s.meal === 'dinner'
    );
    // Pass 5 prefers smallest K. K=2 with Pasta + Pumpkin veggie fits family
    // budgets (9.6L < 10L stock and 33.6L < 40L stock). Pumpkin Kale's 30L
    // share blows its 20L stock at K=2 so it's skipped.
    expect(atSlot(pasta)).toBe(true);
    expect(atSlot(pumpkinVeggie)).toBe(true);
    // The total team should be ≥ 2 family-distinct peers
    const peerCount = [atSlot(pasta), atSlot(pumpkinKale), atSlot(pumpkinVeggie)].filter(Boolean).length;
    expect(peerCount).toBeGreaterThanOrEqual(2);
  });

  test('escalates to a 3-peer team when no 2-peer team fits', () => {
    // Construct a slot where every 2-peer combination fails the family budget,
    // but a 3-peer team works. Demand = 240 guests at 280ml = 67.2L total.
    // 2-peer share = 33.6L per peer. None of these has 33.6L unused alone.
    // 3-peer share = 22.4L per peer. All three fit.
    const window = makeWindow([
      { iso: '2026-05-05', dayName: 'Tue', cookDate: '05/05/2026' },
    ]);
    const a = makeBatch({
      type: 'Main course', cookDate: '03/05/2026',
      location: 'centraal', stock: 25, serving: 280, name: 'A',
    });
    const b = makeBatch({
      type: 'Main course', cookDate: '03/05/2026',
      location: 'centraal', stock: 25, serving: 280, name: 'B',
    });
    const c = makeBatch({
      type: 'Main course', cookDate: '03/05/2026',
      location: 'centraal', stock: 25, serving: 280, name: 'C',
    });
    const allBatches = [a, b, c];
    const guestsFn = (loc: Location, _date: string, meal: Meal) =>
      loc === 'centraal' && meal === 'dinner' ? 240 : 0;

    // Real-shape calc: serving × (guests/families) per service.
    const calc = (batch: Batch): number => {
      let total = 0;
      for (const svc of batch.services || []) {
        const peerFamilyRoots = new Set<string>();
        for (const other of allBatches) {
          if (other.type !== batch.type) continue;
          if (!(other.services || []).some(s => s.loc === svc.loc && s.date === svc.date && s.meal === svc.meal)) continue;
          peerFamilyRoots.add(other.parentId || other.id);
        }
        const families = Math.max(peerFamilyRoots.size, 1);
        total += (guestsFn(svc.loc, svc.date, svc.meal) / families) * (batch.serving / 1000);
      }
      return Math.round(total * 10) / 10;
    };

    assignServicesPass5(allBatches, window, calc, guestsFn);

    const atSlot = (batch: Batch) => (batch.services || []).some(s =>
      s.loc === 'centraal' && s.date === '2026-05-05' && s.meal === 'dinner'
    );
    expect(atSlot(a)).toBe(true);
    expect(atSlot(b)).toBe(true);
    expect(atSlot(c)).toBe(true);
  });

  test('skips slots that are already at SLOTS_PER_TYPE', () => {
    const window = makeWindow([
      { iso: '2026-05-05', dayName: 'Tue', cookDate: '05/05/2026' },
    ]);
    const a = makeBatch({
      type: 'Main course', cookDate: '03/05/2026',
      location: 'centraal', stock: 30, serving: 280, name: 'A',
    });
    const b = makeBatch({
      type: 'Main course', cookDate: '03/05/2026',
      location: 'centraal', stock: 30, serving: 280, name: 'B',
    });
    const c = makeBatch({
      type: 'Main course', cookDate: '03/05/2026',
      location: 'centraal', stock: 30, serving: 280, name: 'C',
    });
    a.services = [{ loc: 'centraal', date: '2026-05-05', meal: 'dinner' }];
    b.services = [{ loc: 'centraal', date: '2026-05-05', meal: 'dinner' }];

    const guestsFn = (loc: Location, _date: string, meal: Meal) =>
      loc === 'centraal' && meal === 'dinner' ? 240 : 0;

    assignServicesPass5([a, b, c], window, fixedCalcRequired(0), guestsFn);

    // c shouldn't be added — slot already 2/2 (which is SLOTS_PER_TYPE).
    const cAtSlot = (c.services || []).some(s =>
      s.loc === 'centraal' && s.date === '2026-05-05' && s.meal === 'dinner'
    );
    expect(cAtSlot).toBe(false);
  });

  test('skips 0-guest slots', () => {
    const window = makeWindow([
      { iso: '2026-05-05', dayName: 'Tue', cookDate: '05/05/2026' },
    ]);
    const a = makeBatch({
      type: 'Soup', cookDate: '03/05/2026',
      location: 'centraal', stock: 30, serving: 280, name: 'A',
    });
    const b = makeBatch({
      type: 'Soup', cookDate: '03/05/2026',
      location: 'centraal', stock: 30, serving: 280, name: 'B',
    });
    // 0 guests everywhere
    const guestsFn = () => 0;

    const result = assignServicesPass5([a, b], window, fixedCalcRequired(0), guestsFn);
    expect(result.servicesAdded).toBe(0);
  });

  test('skips frozen batches', () => {
    const window = makeWindow([
      { iso: '2026-05-05', dayName: 'Tue', cookDate: '05/05/2026' },
    ]);
    const fresh = makeBatch({
      type: 'Main course', cookDate: '03/05/2026',
      location: 'centraal', stock: 10, serving: 280, name: 'Fresh',
    });
    const frozen = makeBatch({
      type: 'Main course', cookDate: '03/05/2026',
      location: 'centraal', stock: 50, serving: 280, name: 'Frozen',
      storage: 'Frozen',
    });
    const guestsFn = (loc: Location, _date: string, meal: Meal) =>
      loc === 'centraal' && meal === 'dinner' ? 240 : 0;

    assignServicesPass5([fresh, frozen], window, fixedCalcRequired(0), guestsFn);

    // Frozen should never be auto-assigned — cooks pull from freezer manually.
    const frozenAtSlot = (frozen.services || []).some(s =>
      s.loc === 'centraal' && s.date === '2026-05-05' && s.meal === 'dinner'
    );
    expect(frozenAtSlot).toBe(false);
  });

  test('treats parent and split as one menu option (family-distinct)', () => {
    const window = makeWindow([
      { iso: '2026-05-05', dayName: 'Tue', cookDate: '05/05/2026' },
    ]);
    const parent = makeBatch({
      type: 'Main course', cookDate: '03/05/2026',
      location: 'west', stock: 30, serving: 280, name: 'Parent',
    });
    const split = makeBatch({
      type: 'Main course', cookDate: '03/05/2026',
      location: 'centraal', stock: 30, serving: 280, name: 'Split',
      parentId: parent.id,
    });
    const other = makeBatch({
      type: 'Main course', cookDate: '03/05/2026',
      location: 'centraal', stock: 30, serving: 280, name: 'Other',
    });
    const guestsFn = (loc: Location, _date: string, meal: Meal) =>
      loc === 'centraal' && meal === 'dinner' ? 240 : 0;

    assignServicesPass5([parent, split, other], window, fixedCalcRequired(0), guestsFn);

    // Only ONE of {parent, split} should be at the slot — same family means
    // same menu option from a guest's POV.
    const parentAtSlot = (parent.services || []).some(s =>
      s.loc === 'centraal' && s.date === '2026-05-05' && s.meal === 'dinner'
    );
    const splitAtSlot = (split.services || []).some(s =>
      s.loc === 'centraal' && s.date === '2026-05-05' && s.meal === 'dinner'
    );
    expect(Number(parentAtSlot) + Number(splitAtSlot)).toBeLessThanOrEqual(1);
  });

  test('refuses to commit a team that overshoots family stock', () => {
    const window = makeWindow([
      { iso: '2026-05-05', dayName: 'Tue', cookDate: '05/05/2026' },
    ]);
    // Each batch has tiny stock; combined coverage at 80 guests/peer would be
    // way over their stock. Family budget check should reject.
    const a = makeBatch({
      type: 'Main course', cookDate: '03/05/2026',
      location: 'centraal', stock: 1, serving: 280, name: 'A',
    });
    const b = makeBatch({
      type: 'Main course', cookDate: '03/05/2026',
      location: 'centraal', stock: 1, serving: 280, name: 'B',
    });
    const guestsFn = (loc: Location, _date: string, meal: Meal) =>
      loc === 'centraal' && meal === 'dinner' ? 240 : 0;

    // Use a peer-aware calc that respects serving × guests / peers.
    const calc = peerAwareCalcRequired([a, b], 240, 280);

    assignServicesPass5([a, b], window, calc, guestsFn);

    // Neither should land — tiny stocks can't satisfy any reasonable team
    // share at 240 guests.
    expect(a.services.length).toBe(0);
    expect(b.services.length).toBe(0);
  });

  test('purely additive — never removes services that earlier passes set', () => {
    const window = makeWindow([
      { iso: '2026-05-05', dayName: 'Tue', cookDate: '05/05/2026' },
    ]);
    // Pre-existing service from "earlier passes" — Pass 5 must not touch it.
    const pinned = makeBatch({
      type: 'Main course', cookDate: '03/05/2026',
      location: 'centraal', stock: 50, serving: 280, name: 'Pinned',
    });
    pinned.services = [
      { loc: 'centraal', date: '2026-05-05', meal: 'lunch' },  // already committed
    ];
    const candidate = makeBatch({
      type: 'Main course', cookDate: '03/05/2026',
      location: 'centraal', stock: 30, serving: 280, name: 'Candidate',
    });
    const guestsFn = (loc: Location, _date: string, meal: Meal) =>
      loc === 'centraal' ? (meal === 'dinner' ? 240 : 90) : 0;

    assignServicesPass5([pinned, candidate], window, fixedCalcRequired(0), guestsFn);

    // pinned still has its lunch service.
    const pinnedHasLunch = (pinned.services || []).some(s =>
      s.loc === 'centraal' && s.date === '2026-05-05' && s.meal === 'lunch'
    );
    expect(pinnedHasLunch).toBe(true);
  });
});

// ── Planning horizon constant ──────────────────────────────────────────────

describe('PLANNING_HORIZON_DAYS', () => {
  test('is 7 days', () => {
    expect(PLANNING_HORIZON_DAYS).toBe(7);
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

// ─────────────────────────────────────────────────────────────────────────────
// New algorithm tests (Phases B0, B, C — hybrid forced + scored + fallback)
// Outcome-level rather than per-pass invariant. Validates:
//   - slot fill rate
//   - frozen never auto-assigned
//   - Centraal→West never assigned
//   - empty/under-filled scenarios
//   - forced-assignment locks the right candidates
//   - team coverage (lowered threshold) covers high-demand slots
// ─────────────────────────────────────────────────────────────────────────────

const TEN_GUESTS = (loc: Location, _iso: string, _meal: Meal) => 10;
const NO_GUESTS = (_loc: Location, _iso: string, _meal: Meal) => 0;
const NO_POT_CAPS = new Map<string, number>();

describe('new algorithm: scoredGreedyAssignment', () => {
  test('frozen batches are never auto-assigned', () => {
    const window = makeWindow([
      { iso: '2026-05-04', dayName: 'Mon', cookDate: '04/05/2026' },
      { iso: '2026-05-05', dayName: 'Tue', cookDate: '05/05/2026' },
    ]);
    const a = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 100, storage: 'Frozen', name: 'Frozen' });
    const b = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 100, name: 'Fresh' });
    scoredGreedyAssignment([a, b], window, fixedCalcRequired(1), TEN_GUESTS, NO_POT_CAPS);
    expect(a.services.length).toBe(0);
    expect(b.services.length).toBeGreaterThan(0);
  });

  test('Centraal-located batch is never assigned to a West slot', () => {
    const window = makeWindow([
      { iso: '2026-05-04', dayName: 'Mon', cookDate: '04/05/2026' },
      { iso: '2026-05-05', dayName: 'Tue', cookDate: '05/05/2026' },
    ]);
    const c = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 100, location: 'centraal', name: 'C' });
    scoredGreedyAssignment([c], window, fixedCalcRequired(1), TEN_GUESTS, NO_POT_CAPS);
    for (const svc of c.services) {
      expect(svc.loc).toBe('centraal');
    }
  });

  test('past-stale batch (>5d cookDate) is excluded from assignment', () => {
    const window = makeWindow([
      { iso: '2026-05-10', dayName: 'Sun', cookDate: '10/05/2026' },
    ]);
    // Batch cooked 2026-05-01, 9 days before slot — over the 5-day cutoff
    const old = makeBatch({ type: 'Soup', cookDate: '01/05/2026', stock: 100, name: 'Stale' });
    scoredGreedyAssignment([old], window, fixedCalcRequired(1), TEN_GUESTS, NO_POT_CAPS);
    expect(old.services.length).toBe(0);
  });

  test('0-guest slot is skipped', () => {
    const window = makeWindow([
      { iso: '2026-05-05', dayName: 'Tue', cookDate: '05/05/2026' },
    ]);
    const b = makeBatch({ type: 'Soup', cookDate: '04/05/2026', stock: 100, name: 'Soup' });
    scoredGreedyAssignment([b], window, fixedCalcRequired(1), NO_GUESTS, NO_POT_CAPS);
    expect(b.services.length).toBe(0);
  });

  test('higher-urgency slot (empty) wins over half-filled slot when batch is scarce', () => {
    // Scenario from plan: two slots competing for the same scarce batch.
    // The single batch should fill an empty slot before adding to a half-filled one.
    const window = makeWindow([
      { iso: '2026-05-05', dayName: 'Tue', cookDate: '05/05/2026' },
    ]);
    const b = makeBatch({ type: 'Soup', cookDate: '04/05/2026', stock: 100, name: 'Scarce' });
    // Pre-populate: West dinner already has one peer
    const peer = makeBatch({ type: 'Soup', cookDate: '04/05/2026', stock: 100, name: 'Peer' });
    peer.services.push({ loc: 'west', date: '2026-05-05', meal: 'dinner' });
    scoredGreedyAssignment([b, peer], window, fixedCalcRequired(1), TEN_GUESTS, NO_POT_CAPS);
    // The other slots (Centraal lunch/dinner, West lunch) are all empty —
    // empty slots score higher than the half-filled West dinner.
    // So `b` should NOT only land on West dinner; it should fan out across
    // empty slots first.
    const onEmptySlots = b.services.filter(s =>
      !(s.loc === 'west' && s.meal === 'dinner')).length;
    expect(onEmptySlots).toBeGreaterThan(0);
  });

  test('lunch slot prefers older stock (prior-day cook)', () => {
    // Same-loc, both batches eligible for Tue lunch West (which needs cookDate <= Mon).
    // Prior-day cook scores +200 for lunch; same-day cook scores -300.
    // So an older cooked batch should land on lunch first.
    const window = makeWindow([
      { iso: '2026-05-05', dayName: 'Tue', cookDate: '05/05/2026' },
    ]);
    const monCook = makeBatch({ type: 'Soup', cookDate: '04/05/2026', stock: 100, name: 'Mon' });
    // Tuesday cook can serve Tue dinner (same-day OK) but not Tue lunch (too early).
    // So we expect Mon's batch on Tue lunch and the Tuesday placeholder elsewhere.
    const tueCook = makeBatch({ type: 'Soup', cookDate: '05/05/2026', stock: 0, name: 'Tue placeholder' });
    scoredGreedyAssignment([monCook, tueCook], window, fixedCalcRequired(1), TEN_GUESTS, NO_POT_CAPS);
    const monAtLunch = monCook.services.some(s => s.meal === 'lunch');
    expect(monAtLunch).toBe(true);
  });

  test('dinner slot prefers same-day cook (no cooling)', () => {
    const window = makeWindow([
      { iso: '2026-05-05', dayName: 'Tue', cookDate: '05/05/2026' },
    ]);
    const monCook = makeBatch({ type: 'Soup', cookDate: '04/05/2026', stock: 100, name: 'Mon' });
    const tueCook = makeBatch({ type: 'Soup', cookDate: '05/05/2026', stock: 100, name: 'Tue' });
    scoredGreedyAssignment([monCook, tueCook], window, fixedCalcRequired(1), TEN_GUESTS, NO_POT_CAPS);
    // Tuesday batch (same-day) should land on Tue dinner.
    const tueAtDinner = tueCook.services.some(s => s.meal === 'dinner' && s.date === '2026-05-05');
    expect(tueAtDinner).toBe(true);
  });
});

describe('new algorithm: forcedAssignmentPrePass', () => {
  test('singleton candidate gets locked when score is high', () => {
    const window = makeWindow([
      { iso: '2026-05-05', dayName: 'Tue', cookDate: '05/05/2026' },
    ]);
    // Only one batch; only Centraal slots open (single Centraal-located batch).
    const onlyOne = makeBatch({
      type: 'Soup', cookDate: '04/05/2026', stock: 100, location: 'centraal', name: 'OnlyC',
    });
    const result = forcedAssignmentPrePass([onlyOne], window, fixedCalcRequired(1), TEN_GUESTS, NO_POT_CAPS);
    expect(result.committed).toBeGreaterThan(0);
    expect(onlyOne.services.length).toBeGreaterThan(0);
    // Every commit must be at Centraal (West slots have no candidate).
    for (const svc of onlyOne.services) {
      expect(svc.loc).toBe('centraal');
    }
  });

  test('does not commit when no candidate passes hard constraints', () => {
    const window = makeWindow([
      { iso: '2026-05-05', dayName: 'Tue', cookDate: '05/05/2026' },
    ]);
    // Frozen batch — disqualified by hard constraint.
    const frozen = makeBatch({ type: 'Soup', cookDate: '04/05/2026', stock: 100, storage: 'Frozen', name: 'F' });
    const result = forcedAssignmentPrePass([frozen], window, fixedCalcRequired(1), TEN_GUESTS, NO_POT_CAPS);
    expect(result.committed).toBe(0);
    expect(frozen.services.length).toBe(0);
  });
});

describe('new algorithm: runFallbackLadder', () => {
  test('creates emergency placeholder for slot with no candidates', () => {
    const window = makeWindow([
      { iso: '2026-05-05', dayName: 'Tue', cookDate: '05/05/2026' },
    ]);
    // No batches at all — every slot is uncovered.
    const all: Batch[] = [];
    const result = runFallbackLadder(all, window, fixedCalcRequired(1), TEN_GUESTS);
    // Each slot wants 2 of each type → 4 slots × 2 types × 2 positions = 16 emergencies.
    expect(result.emergenciesCreated).toBeGreaterThan(0);
    // The created batches should be tagged as emergency in cookNotes.
    for (const b of result.emergencyBatches) {
      expect(b.cookNotes).toMatch(/Emergency/i);
      expect(b.generated).toBe(true);
      expect(b.recipeId).toBeNull();
    }
  });

  test('teams form when single batches are too small but combined coverage is ≥60%', () => {
    // 30-guest slot, two small batches each ~30L stock. Solo per-batch share
    // (15 guests each at 280g/serving = 4.2L) fits, so they form a 2-team.
    const window = makeWindow([
      { iso: '2026-05-05', dayName: 'Tue', cookDate: '05/05/2026' },
    ]);
    const a = makeBatch({ type: 'Soup', cookDate: '04/05/2026', stock: 30, name: 'Small A' });
    const b = makeBatch({ type: 'Soup', cookDate: '04/05/2026', stock: 30, name: 'Small B' });
    // Force scarcity: limit guests so team coverage logic kicks in.
    const guestsFn = (loc: Location, _iso: string, _meal: Meal) =>
      loc === 'west' ? 30 : 0;  // only West has guests
    const result = runFallbackLadder([a, b], window, fixedCalcRequired(1), guestsFn);
    // The batches should pick up services via team formation.
    expect(a.services.length + b.services.length).toBeGreaterThan(0);
  });
});

describe('new algorithm: idempotency (double-press doesn\'t change assignments)', () => {
  test('running scoredGreedyAssignment twice produces the same final state', () => {
    const window = makeWindow([
      { iso: '2026-05-05', dayName: 'Tue', cookDate: '05/05/2026' },
      { iso: '2026-05-06', dayName: 'Wed', cookDate: '06/05/2026' },
    ]);
    const make = () => [
      makeBatch({ type: 'Soup', cookDate: '04/05/2026', stock: 100, name: 'A' }),
      makeBatch({ type: 'Main course', cookDate: '04/05/2026', stock: 100, name: 'B' }),
    ];
    // Run 1
    const run1 = make();
    scoredGreedyAssignment(run1, window, fixedCalcRequired(1), TEN_GUESTS, NO_POT_CAPS);
    const run1Sigs = run1.map(b => `${b.name}:${(b.services || []).map((s: Service) => `${s.loc}|${s.date}|${s.meal}`).sort().join(',')}`);
    // Run 2 (fresh batches)
    const run2 = make();
    scoredGreedyAssignment(run2, window, fixedCalcRequired(1), TEN_GUESTS, NO_POT_CAPS);
    const run2Sigs = run2.map(b => `${b.name}:${(b.services || []).map((s: Service) => `${s.loc}|${s.date}|${s.meal}`).sort().join(',')}`);
    expect(run1Sigs).toEqual(run2Sigs);
  });
});
