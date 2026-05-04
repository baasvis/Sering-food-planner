/**
 * Regression test for T18 — silent stock-deduct in batch recipe save.
 *
 * The bug: brSave() in public/js/recipe-editor.ts sent
 *   { location, updates: [...] }
 * to /api/ingredients/stock/bulk. The endpoint expects a flat array
 * (`if (!Array.isArray(req.body)) return 400`), so the call returned 400 and
 * a try/catch logged a console.warn. The deduct-from-stock checkbox was
 * silently broken.
 *
 * The fix split the stock-deduct calculation into a pure helper
 * `computeStockDeductionUpdates`. These tests pin BOTH the wire shape (what
 * the helper returns is what the bulk endpoint takes) AND the math (the bulk
 * endpoint SETS absolute values — the helper has to do the read-modify-write
 * client-side because there is no /deduct endpoint).
 */

// Browser-global stubs from test/setup-dom-stubs.ts run before this import.

import { computeStockDeductionUpdates } from '../public/js/recipe-editor';
import type { Ingredient } from '../shared/types';

function makeIng(id: string, stockByLoc: Record<string, number>): Ingredient {
  const stock: Record<string, { amount: number; date: string }> = {};
  for (const [loc, amount] of Object.entries(stockByLoc)) {
    stock[loc] = { amount, date: '2026-04-30' };
  }
  return {
    id, name: id, supplierName: '', types: [], category: '',
    measureMode: 'weight', unit: 'Grams', supplier: '', orderCode: '',
    orderUnit: '', orderPrice: null, orderUnitSize: 0, priceLevel: '',
    pricePer100: 0, priceAlert: false, storageLocations: {},
    stock: stock as Ingredient['stock'], targetStock: {},
    allergens: '', notes: '', active: true,
  };
}

describe('computeStockDeductionUpdates', () => {
  it('subtracts cooked grams from current west stock', () => {
    const db = [makeIng('flour', { west: 5000 })];
    const updates = computeStockDeductionUpdates(
      [{ ingredientId: 'flour', amount: 250, unit: 'Grams' }],
      'west', db,
    );
    expect(updates).toEqual([{ ingredientId: 'flour', location: 'west', amount: 4750 }]);
  });

  it('uses kilo→gram conversion via toGrams', () => {
    const db = [makeIng('flour', { west: 5000 })];
    const updates = computeStockDeductionUpdates(
      [{ ingredientId: 'flour', amount: 1.5, unit: 'Kilos' }],
      'west', db,
    );
    expect(updates).toEqual([{ ingredientId: 'flour', location: 'west', amount: 3500 }]);
  });

  it('reads stock from the batch location, ignoring other locations', () => {
    const db = [makeIng('flour', { west: 5000, centraal: 9000 })];
    const updates = computeStockDeductionUpdates(
      [{ ingredientId: 'flour', amount: 200, unit: 'Grams' }],
      'centraal', db,
    );
    expect(updates).toEqual([{ ingredientId: 'flour', location: 'centraal', amount: 8800 }]);
  });

  it('returns one row per ingredient', () => {
    const db = [
      makeIng('flour', { west: 5000 }),
      makeIng('sugar', { west: 2000 }),
    ];
    const updates = computeStockDeductionUpdates(
      [
        { ingredientId: 'flour', amount: 300, unit: 'Grams' },
        { ingredientId: 'sugar', amount: 150, unit: 'Grams' },
      ],
      'west', db,
    );
    expect(updates).toEqual([
      { ingredientId: 'flour', location: 'west', amount: 4700 },
      { ingredientId: 'sugar', location: 'west', amount: 1850 },
    ]);
  });

  it('treats missing stock entry as zero (results in negative new stock)', () => {
    // No west entry → current = 0 → new = -200. We deliberately do NOT clamp:
    // a negative value is an honest signal that the prior count was wrong.
    const db = [makeIng('flour', { centraal: 1000 })];
    const updates = computeStockDeductionUpdates(
      [{ ingredientId: 'flour', amount: 200, unit: 'Grams' }],
      'west', db,
    );
    expect(updates).toEqual([{ ingredientId: 'flour', location: 'west', amount: -200 }]);
  });

  it('skips ingredients not present in the DB (current=0 path still fires)', () => {
    // Same shape as above but the ingredient is entirely missing from the
    // db — find returns undefined, current falls back to 0.
    const updates = computeStockDeductionUpdates(
      [{ ingredientId: 'unknown', amount: 100, unit: 'Grams' }],
      'west', [],
    );
    expect(updates).toEqual([{ ingredientId: 'unknown', location: 'west', amount: -100 }]);
  });

  it('skips zero-amount ingredients', () => {
    const db = [makeIng('flour', { west: 5000 })];
    const updates = computeStockDeductionUpdates(
      [{ ingredientId: 'flour', amount: 0, unit: 'Grams' }],
      'west', db,
    );
    expect(updates).toEqual([]);
  });

  it('returns a flat array — same shape as /api/ingredients/stock/bulk expects', () => {
    // T18 root cause: the old code wrapped the array in {location, updates}.
    // This test pins the contract.
    const db = [makeIng('flour', { west: 5000 })];
    const updates = computeStockDeductionUpdates(
      [{ ingredientId: 'flour', amount: 100, unit: 'Grams' }],
      'west', db,
    );
    expect(Array.isArray(updates)).toBe(true);
    expect(updates[0]).toMatchObject({
      ingredientId: expect.any(String),
      location: expect.any(String),
      amount: expect.any(Number),
    });
  });
});
