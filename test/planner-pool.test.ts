/**
 * Unit tests for getPoolBatches' location-tab visibility — specifically the
 * "cooked-here" rule: a batch cooked at a location shows on that location's tab
 * even when all its services are at the other location (so West-cooked food
 * still appears on West). See planner.ts getPoolBatches.
 *
 * Browser-global stubs come from test/setup-dom-stubs.ts (jest setupFiles).
 */
import type { Batch, DishType } from '../shared/types';
import { S } from '../public/js/state';
import { getPoolBatches } from '../public/js/planner';

// Pin to Fri 1 May 2026 so the hardcoded future/past service dates are stable.
beforeAll(() => { jest.useFakeTimers(); jest.setSystemTime(new Date('2026-05-01T08:00:00Z')); });
afterAll(() => { jest.useRealTimers(); });

let _id = 0;
function makeBatch(o: Partial<Batch> & { type: DishType }): Batch {
  const base: Batch = {
    id: `b-${++_id}`, name: 'X', type: 'Soup', serving: 280, cookDate: null,
    inventory: [], shipments: [], allergens: [], extraAllergens: [], orderFor: false,
    note: '', services: [], createdAt: '2026-05-01T00:00:00.000Z', recipeId: null,
    actualIngredients: null, cookNotes: '', stockDeducted: false, generated: false,
  };
  return { ...base, ...o };
}

beforeEach(() => { S.batches = []; S.caterings = []; });

describe('getPoolBatches cooked-here visibility', () => {
  test('a West-cooked placeholder serving only Centraal still shows on the West tab', () => {
    // Empty inventory → cook loc defaults to West; only a Centraal service.
    const b = makeBatch({
      type: 'Main course', name: 'Mon main', cookDate: '04/05/2026', inventory: [],
      services: [{ loc: 'centraal', date: '2026-05-05', meal: 'lunch' }],
    });
    S.batches = [b];
    expect(getPoolBatches('west').map(x => x.id)).toContain(b.id);     // via cooked-here
    expect(getPoolBatches('centraal').map(x => x.id)).toContain(b.id); // via upcoming service
  });

  test('a Centraal-cooked batch serving only Centraal does NOT show on West', () => {
    const b = makeBatch({
      type: 'Soup', name: 'C soup', cookDate: '04/05/2026',
      inventory: [{ loc: 'centraal', storage: 'Gastro', qty: 40, cookDate: '04/05/2026' }],
      services: [{ loc: 'centraal', date: '2026-05-05', meal: 'dinner' }],
    });
    S.batches = [b];
    expect(getPoolBatches('west').map(x => x.id)).not.toContain(b.id);
    expect(getPoolBatches('centraal').map(x => x.id)).toContain(b.id);
  });

  test('a West-cooked batch with only PAST services and no stock drops off West', () => {
    const b = makeBatch({
      type: 'Soup', name: 'Old', cookDate: '28/04/2026', inventory: [],
      services: [{ loc: 'west', date: '2026-04-28', meal: 'dinner' }],
    });
    S.batches = [b];
    expect(getPoolBatches('west').map(x => x.id)).not.toContain(b.id);
  });

  test('a West-cooked batch attached only to an upcoming catering shows on West (no services)', () => {
    // Real case: a main on a catering but no planner service. West must still
    // see it to know what to cook.
    const b = makeBatch({ type: 'Main course', name: 'South Indian chickpea curry', cookDate: '05/05/2026', inventory: [], services: [] });
    S.batches = [b];
    S.caterings = [{ id: 'c1', name: 'AZC lunch', date: '05/05/2026', guestCount: 50, deliveryMode: 'pickup', dishes: [{ dishId: b.id, name: b.name, type: 'Main course' }], logisticsNotes: '' }];
    expect(getPoolBatches('west').map(x => x.id)).toContain(b.id);
  });

  test('a West-cooked batch with a future cook date but no demand still shows on West (planned cook)', () => {
    const b = makeBatch({ type: 'Soup', name: 'Planned soup', cookDate: '05/05/2026', inventory: [], services: [] });
    S.batches = [b];
    expect(getPoolBatches('west').map(x => x.id)).toContain(b.id);
  });

  test('a West-cooked batch tied only to a PAST catering, no stock/service, drops off West', () => {
    const b = makeBatch({ type: 'Main course', name: 'Old catering main', cookDate: '28/04/2026', inventory: [], services: [] });
    S.batches = [b];
    S.caterings = [{ id: 'c2', name: 'Past event', date: '28/04/2026', guestCount: 30, deliveryMode: 'pickup', dishes: [{ dishId: b.id, name: b.name, type: 'Main course' }], logisticsNotes: '' }];
    expect(getPoolBatches('west').map(x => x.id)).not.toContain(b.id);
  });
});

// ── Event locations: where does a festival dish live? (Daan 2026-07-19) ─────
//
// Rule: an UNCOOKED dish whose services are ALL at one event location is
// cooked on-site → it lives on the event tab only, not West's. A dish that
// ALSO has a West service always stays visible at West (a service here always
// wins). Once cooked, inventory decides.

describe('getPoolBatches event-location visibility', () => {
  const EV = 'ev-fest-2026';

  beforeEach(() => {
    S.eventLocations = [{
      slug: EV, name: 'Fest 2026', startDate: '2026-05-02', endDate: '2026-05-10',
      hanosAccount: 'west', archived: false, createdAt: '2026-05-01T00:00:00.000Z', archivedAt: null,
    }];
  });
  afterEach(() => { S.eventLocations = []; });

  test('uncooked dish served ONLY at the event is hidden from West, shown at the event', () => {
    const b = makeBatch({
      type: 'Soup', name: 'Fest soup', cookDate: '04/05/2026', inventory: [],
      services: [
        { loc: EV, date: '2026-05-04', meal: 'lunch' },
        { loc: EV, date: '2026-05-05', meal: 'dinner' },
      ],
    });
    S.batches = [b];
    expect(getPoolBatches('west').map(x => x.id)).not.toContain(b.id);
    expect(getPoolBatches(EV).map(x => x.id)).toContain(b.id); // cooks on-site
  });

  test('uncooked dish assigned to BOTH West and the event stays visible at West (and the event)', () => {
    const b = makeBatch({
      type: 'Main course', name: 'Shared main', cookDate: '04/05/2026', inventory: [],
      services: [
        { loc: 'west', date: '2026-05-04', meal: 'lunch' },
        { loc: EV, date: '2026-05-05', meal: 'dinner' },
      ],
    });
    S.batches = [b];
    expect(getPoolBatches('west').map(x => x.id)).toContain(b.id);
    expect(getPoolBatches(EV).map(x => x.id)).toContain(b.id);
  });

  test('dish COOKED at the event but with a West service still shows at West', () => {
    const b = makeBatch({
      type: 'Soup', name: 'Fest-cooked, west-served', cookDate: '03/05/2026',
      inventory: [{ loc: EV, storage: 'Gastro', qty: 30, cookDate: '03/05/2026' }],
      services: [
        { loc: 'west', date: '2026-05-05', meal: 'lunch' },
        { loc: EV, date: '2026-05-05', meal: 'dinner' },
      ],
    });
    S.batches = [b];
    expect(getPoolBatches('west').map(x => x.id)).toContain(b.id); // West service wins
    expect(getPoolBatches(EV).map(x => x.id)).toContain(b.id);
  });

  test('dish cooked AND served only at the event never appears at West', () => {
    const b = makeBatch({
      type: 'Soup', name: 'Pure fest soup', cookDate: '03/05/2026',
      inventory: [{ loc: EV, storage: 'Gastro', qty: 30, cookDate: '03/05/2026' }],
      services: [{ loc: EV, date: '2026-05-05', meal: 'dinner' }],
    });
    S.batches = [b];
    expect(getPoolBatches('west').map(x => x.id)).not.toContain(b.id);
    expect(getPoolBatches(EV).map(x => x.id)).toContain(b.id);
  });

  test('festival dish confirmed cooked AT WEST reappears at West (inventory beats the heuristic)', () => {
    const b = makeBatch({
      type: 'Soup', name: 'West-cooked fest soup', cookDate: '03/05/2026',
      inventory: [{ loc: 'west', storage: 'Gastro', qty: 40, cookDate: '03/05/2026' }],
      services: [{ loc: EV, date: '2026-05-05', meal: 'dinner' }],
    });
    S.batches = [b];
    expect(getPoolBatches('west').map(x => x.id)).toContain(b.id); // stock at West
    expect(getPoolBatches(EV).map(x => x.id)).toContain(b.id);     // upcoming service
  });

  test('west/centraal-only batches are untouched by the event rule (regression)', () => {
    const b = makeBatch({
      type: 'Main course', name: 'Normal main', cookDate: '04/05/2026', inventory: [],
      services: [{ loc: 'centraal', date: '2026-05-05', meal: 'lunch' }],
    });
    S.batches = [b];
    expect(getPoolBatches('west').map(x => x.id)).toContain(b.id); // cooked-here default west
    expect(getPoolBatches('centraal').map(x => x.id)).toContain(b.id);
  });
});
