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

beforeEach(() => { S.batches = []; });

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
});
