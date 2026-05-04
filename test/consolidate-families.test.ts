/**
 * Tests for consolidateFamilies — the data merger that folds same-family
 * same-location batches into a single record. Triggered by Fix My Menu and
 * (future) by save flow.
 */

import type { Batch, DishType, Location, StorageType } from '../shared/types';
import { consolidateFamilies, getRootId } from '../public/js/core';

let _id = 0;
const nextId = () => `b-${++_id}`;

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

beforeEach(() => { _id = 0; });

describe('consolidateFamilies', () => {
  test('no-op when no duplicates exist', () => {
    const a = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 50, name: 'Tomato' });
    const b = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 30, name: 'Miso' });
    const result = consolidateFamilies([a, b]);
    expect(result.removed).toEqual([]);
    expect(result.kept.length).toBe(2);
    expect(result.mergedGroups).toBe(0);
  });

  test('Miso real-prod case: 3 splits at Centraal merge into one', () => {
    // Mirror of the actual prod data Daan flagged.
    const parent = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 64.7, name: 'Miso & ginger soup', location: 'west' });
    const split1 = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 12.1, name: 'Miso & ginger soup (split)', location: 'centraal' });
    const split2 = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 12.6, name: 'Miso & ginger soup (split)', location: 'centraal' });
    const split3 = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 18.0, name: 'Miso & ginger soup (split)', location: 'centraal' });
    [split1, split2, split3].forEach(s => { s.parentId = parent.id; });
    split1.services = [{ loc: 'centraal', date: '2026-05-04', meal: 'lunch' }];
    split2.services = [{ loc: 'centraal', date: '2026-05-04', meal: 'dinner' }];
    split3.services = [
      { loc: 'centraal', date: '2026-05-05', meal: 'lunch' },
      { loc: 'centraal', date: '2026-05-05', meal: 'dinner' },
      { loc: 'centraal', date: '2026-05-06', meal: 'lunch' },
    ];

    const result = consolidateFamilies([parent, split1, split2, split3]);

    expect(result.removed.length).toBe(2);
    expect(result.mergedGroups).toBe(1);
    expect(result.kept.length).toBe(2);  // parent + 1 merged Centraal split

    // The surviving Centraal split has summed stock and unioned services
    const survivingSplit = result.kept.find(b => b.location === 'centraal');
    expect(survivingSplit).toBeDefined();
    expect(survivingSplit!.stock).toBeCloseTo(42.7, 1);
    expect(survivingSplit!.services.length).toBe(5);  // union of 1+1+3
  });

  test('does NOT merge across different storage types', () => {
    const parent = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 50, name: 'Pea Soup', location: 'centraal', storage: 'Gastro' });
    const frozen = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 5, name: 'Pea Soup (split)', location: 'centraal', storage: 'Frozen' });
    frozen.parentId = parent.id;
    const result = consolidateFamilies([parent, frozen]);
    expect(result.removed).toEqual([]);  // different storage → no merge
    expect(result.kept.length).toBe(2);
  });

  test('does NOT merge across different locations', () => {
    const parent = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 50, name: 'Tomato', location: 'west' });
    const split = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 30, name: 'Tomato (split)', location: 'centraal' });
    split.parentId = parent.id;
    const result = consolidateFamilies([parent, split]);
    expect(result.removed).toEqual([]);
    expect(result.kept.length).toBe(2);
  });

  test('does NOT merge in-transit with arrived (physically separate)', () => {
    const arrived = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 30, name: 'Tomato (split)', location: 'centraal', inTransit: false });
    const incoming = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 20, name: 'Tomato (split)', location: 'centraal', inTransit: true });
    incoming.parentId = arrived.id;
    const result = consolidateFamilies([arrived, incoming]);
    expect(result.removed).toEqual([]);
  });

  test('parent (no parentId) wins as primary when in the merge group', () => {
    // Edge case: cook somehow has the parent at the same location as a split
    // (e.g. the parent was relocated). The parent's id should survive.
    const parent = makeBatch({ type: 'Soup', cookDate: '01/05/2026', stock: 30, name: 'Pea', location: 'centraal' });
    const split = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 20, name: 'Pea (split)', location: 'centraal' });
    split.parentId = parent.id;
    const result = consolidateFamilies([parent, split]);
    expect(result.kept.length).toBe(1);
    expect(result.kept[0].id).toBe(parent.id);
    expect(result.kept[0].stock).toBeCloseTo(50, 1);
  });

  test('uses oldest cookDate in merged record', () => {
    const a = makeBatch({ type: 'Soup', cookDate: '05/05/2026', stock: 10, name: 'X', location: 'centraal' });
    const b = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 10, name: 'X', location: 'centraal' });
    b.parentId = a.id;  // a is parent (cooked later but with no parentId)
    const result = consolidateFamilies([a, b]);
    // a wins because it's the parent. cookDate becomes 03/05 (oldest).
    expect(result.kept.length).toBe(1);
    expect(result.kept[0].cookDate).toBe('03/05/2026');
  });

  test('redirects parentId chain after merge so family stays intact', () => {
    // Setup: parent at West + 2 splits at Centraal. The two Centraal splits
    // merge; one is removed. Any third batch that references a removed id as
    // parent should be redirected to the surviving sibling so the family
    // chain stays walkable.
    // Grandchild is FROZEN to escape its own merge bucket — keeps the test
    // focused on the redirect logic.
    const parent = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 50, name: 'Tomato', location: 'west' });
    const split1 = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 20, name: 'Tomato (split)', location: 'centraal' });
    const split2 = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 15, name: 'Tomato (split)', location: 'centraal' });
    split1.parentId = parent.id;
    split2.parentId = parent.id;
    // Grandchild references split2 (a removed id after merge). Frozen so
    // it doesn't get itself merged with anyone.
    const grandchild = makeBatch({
      type: 'Soup', cookDate: '04/05/2026', stock: 5,
      name: 'Tomato (re-split)', location: 'centraal', storage: 'Frozen',
    });
    grandchild.parentId = split2.id;
    const result = consolidateFamilies([parent, split1, split2, grandchild]);
    const updatedGrandchild = result.kept.find(b => b.name === 'Tomato (re-split)')!;
    expect(updatedGrandchild).toBeDefined();
    // grandchild's parentId should NOT still point at the removed id
    expect(updatedGrandchild.parentId).not.toBe(split2.id);
    // Walking the family chain should still reach the original parent
    expect(getRootId(updatedGrandchild, result.kept)).toBe(parent.id);
  });

  test('absorbs same-loc grandchild into parent (full family-loc merge)', () => {
    // Daan's exact ask: "When items of the same batch are at the same
    // location they should become fully one." If a deeper descendant lives
    // at the same physical location as the family parent, fold it in too.
    const parent = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 50, name: 'Tomato', location: 'west' });
    const grandchild = makeBatch({ type: 'Soup', cookDate: '04/05/2026', stock: 8, name: 'Tomato (re-split)', location: 'west' });
    grandchild.parentId = parent.id;
    const result = consolidateFamilies([parent, grandchild]);
    expect(result.kept.length).toBe(1);
    expect(result.kept[0].id).toBe(parent.id);
    expect(result.kept[0].stock).toBeCloseTo(58, 1);
  });

  test('unions services without duplicates (same slot in two batches → one entry)', () => {
    const a = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 20, location: 'centraal' });
    const b = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 20, location: 'centraal' });
    b.parentId = a.id;
    a.services = [{ loc: 'centraal', date: '2026-05-04', meal: 'lunch' }];
    b.services = [
      { loc: 'centraal', date: '2026-05-04', meal: 'lunch' },  // duplicate of a's
      { loc: 'centraal', date: '2026-05-04', meal: 'dinner' },
    ];
    const result = consolidateFamilies([a, b]);
    expect(result.kept.length).toBe(1);
    expect(result.kept[0].services.length).toBe(2);  // de-duplicated, not 3
  });
});
