/**
 * Regression test for CORR-1 (2026-06-05 audit): the /api/data/patch delete
 * path (dbDeleteBatchIds) must honour the same cannot-delete-with-stock
 * invariant as DELETE /api/batches/:id. batchRowHasStock is the shared
 * predicate; these are pure unit tests (no DB) of that predicate.
 */
import { batchRowHasStock } from '../lib/db';

describe('batchRowHasStock — cannot-delete-with-stock guard', () => {
  test('empty inventory and shipments → no stock (deletable)', () => {
    expect(batchRowHasStock({ inventory: [], shipments: [] })).toBe(false);
  });

  test('settled inventory with qty > 0 → has stock (protected)', () => {
    expect(batchRowHasStock({
      inventory: [{ loc: 'west', storage: 'gastro', qty: 5, cookDate: '2026-06-01' }],
      shipments: [],
    })).toBe(true);
  });

  test('only all-zero inventory entries → no stock (deletable)', () => {
    expect(batchRowHasStock({
      inventory: [{ loc: 'west', storage: 'gastro', qty: 0, cookDate: '2026-06-01' }],
      shipments: [],
    })).toBe(false);
  });

  test('a pending (not-yet-arrived) shipment → has stock (protected)', () => {
    expect(batchRowHasStock({
      inventory: [],
      shipments: [{ id: 's1', toLoc: 'centraal', qty: 3, arrived: false }],
    })).toBe(true);
  });

  test('only arrived shipments → no stock (deletable)', () => {
    expect(batchRowHasStock({
      inventory: [],
      shipments: [{ id: 's1', toLoc: 'centraal', qty: 3, arrived: true }],
    })).toBe(false);
  });

  test('non-array / garbage JSON → treated as no stock (safe default, never throws)', () => {
    expect(batchRowHasStock({ inventory: null, shipments: undefined })).toBe(false);
    expect(batchRowHasStock({ inventory: 'oops', shipments: 42 })).toBe(false);
  });

  test('mixed: zero inventory but a pending shipment → still protected', () => {
    expect(batchRowHasStock({
      inventory: [{ loc: 'west', storage: 'gastro', qty: 0, cookDate: '2026-06-01' }],
      shipments: [{ id: 's1', toLoc: 'centraal', qty: 2, arrived: false }],
    })).toBe(true);
  });
});
