/**
 * Regression test for family-aware calcRequired.
 *
 * Daan's scenario: Tomato Soup (West parent, 50L) + Tomato Soup (split,
 * Centraal, 20L) + Courgette Soup (Centraal) all assigned to Mon dinner
 * Centraal (130 guests). The OLD behaviour split the slot's demand by 3
 * (counting batches), giving each Tomato 1/3 of the demand. From a guest's
 * point of view there are only TWO menu options (Tomato family, Courgette),
 * so demand should split by 2 — half of which then splits across the two
 * physical Tomato batches.
 */

import type { Batch, DishType, Location, Service, StorageType } from '../shared/types';
import { calcRequired } from '../public/js/core';
import { S } from '../public/js/state';

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

function rebuildPlanner(batches: Batch[]) {
  S.planner = {};
  for (const b of batches) {
    for (const svc of b.services || []) {
      const k = `${svc.loc}-${svc.date}-${svc.meal}`;
      if (!S.planner[k]) S.planner[k] = [];
      S.planner[k].push(b);
    }
  }
}

beforeEach(() => {
  _id = 0;
  // Seed S.guests so getGuests returns 130 for Mon dinner Centraal
  S.guests = {
    centraal: { Mon: { lunch: 90, dinner: 130 } } as any,
    west: { Mon: { lunch: 100, dinner: 110 } } as any,
  };
  S.batches = [];
  S.planner = {};
  S.caterings = [];
  S.guestsNextWeeks = {};
});

describe('family-aware calcRequired', () => {
  test('Tomato family at slot — STOCK-PROPORTIONAL split, smaller batch carries less load', () => {
    // Slot: Mon dinner Centraal, 130 guests, 280g per serving.
    //   - Tomato West (parent, 50L)
    //   - Tomato Centraal (split, 20L) — same family
    //   - Courgette Centraal (50L) — different family
    // 2 menu options. Tomato family share = 130/2 × 280g = 18.2L.
    // Stock-proportional: split (20L) gets 20/(20+50) = 28.6% = 5.2L,
    // parent (50L) gets 50/70 = 71.4% = 13L. Sum still 18.2L.
    // Daan's complaint: with EVEN split (9.1L each) and 3 such slots, the
    // 20L split goes negative (3 × 9.1 = 27.3L). Stock-proportional avoids
    // that — 3 slots × 5.2L = 15.6L for the split, well within 20L.
    const tomatoParent = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 50, location: 'west', name: 'Tomato' });
    const tomatoSplit = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 20, location: 'centraal', name: 'Tomato (split)' });
    tomatoSplit.parentId = tomatoParent.id;
    const courgette = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 50, location: 'centraal', name: 'Courgette' });

    const slot: Service = { loc: 'centraal', date: '2026-05-04', meal: 'dinner' };
    [tomatoParent, tomatoSplit, courgette].forEach(b => b.services.push(slot));

    S.batches = [tomatoParent, tomatoSplit, courgette];
    rebuildPlanner(S.batches);

    // Stock-proportional within Tomato family (20L : 50L)
    expect(calcRequired(tomatoSplit)).toBeCloseTo(5.2, 1);   // 18.2 × 20/70
    expect(calcRequired(tomatoParent)).toBeCloseTo(13.0, 1); // 18.2 × 50/70
    // Tomato family total = 18.2L (half the slot)
    expect(calcRequired(tomatoParent) + calcRequired(tomatoSplit)).toBeCloseTo(18.2, 1);
    // Courgette gets the OTHER half (alone in its family)
    expect(calcRequired(courgette)).toBeCloseTo(18.2, 1);
  });

  test('Single batch (no family) behaves identically to old logic', () => {
    // Sanity: a lone Tomato + lone Courgette should split 50/50 like before.
    const tomato = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 50, location: 'centraal', name: 'Tomato' });
    const courgette = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 50, location: 'centraal', name: 'Courgette' });
    const slot: Service = { loc: 'centraal', date: '2026-05-04', meal: 'dinner' };
    [tomato, courgette].forEach(b => b.services.push(slot));

    S.batches = [tomato, courgette];
    rebuildPlanner(S.batches);

    expect(calcRequired(tomato)).toBeCloseTo(18.2, 1);  // 130 / 2 × 280g
    expect(calcRequired(courgette)).toBeCloseTo(18.2, 1);
  });

  test('Three families at slot → demand splits 3 ways, no duplicate-counting', () => {
    // Mon dinner Centraal, 130 guests, 3 different recipes (no splits).
    const a = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 30, location: 'centraal', name: 'A' });
    const b = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 30, location: 'centraal', name: 'B' });
    const c = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 30, location: 'centraal', name: 'C' });
    const slot: Service = { loc: 'centraal', date: '2026-05-04', meal: 'dinner' };
    [a, b, c].forEach(x => x.services.push(slot));

    S.batches = [a, b, c];
    rebuildPlanner(S.batches);

    // 130 / 3 menu options × 280g = 12.13L each
    expect(calcRequired(a)).toBeCloseTo(12.13, 1);
    expect(calcRequired(b)).toBeCloseTo(12.13, 1);
    expect(calcRequired(c)).toBeCloseTo(12.13, 1);
  });

  test('Family-only at slot: demand splits stock-proportionally across members', () => {
    // Slot has only Tomato family — 2 physical batches with EQUAL stock,
    // 1 menu option. Family share = 130 × 280g = 36.4L.
    // Stock 50:50 → 18.2L each.
    const parent = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 50, location: 'west', name: 'Tomato' });
    const split = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 50, location: 'centraal', name: 'Tomato (split)' });
    split.parentId = parent.id;
    const slot: Service = { loc: 'centraal', date: '2026-05-04', meal: 'dinner' };
    [parent, split].forEach(b => b.services.push(slot));

    S.batches = [parent, split];
    rebuildPlanner(S.batches);

    // Equal stock → equal share
    expect(calcRequired(parent)).toBeCloseTo(18.2, 1);
    expect(calcRequired(split)).toBeCloseTo(18.2, 1);
    // Family total = full slot demand (alone on the menu = 100% of guests)
    expect(calcRequired(parent) + calcRequired(split)).toBeCloseTo(36.4, 1);
  });

  test('All-zero family (uncooked placeholders only) falls back to even split', () => {
    // Edge case: a placeholder family with no cooked siblings. Stock-prop
    // would give each 0% (totalStock=0 division). Fall back to even so the
    // placeholder still surfaces "to be cooked" volume.
    const a = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 0, name: 'Sun soup 1' });
    const b = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 0, name: 'Sun soup 2' });
    b.parentId = a.id;  // pretend they're a family
    const slot: Service = { loc: 'centraal', date: '2026-05-04', meal: 'dinner' };
    [a, b].forEach(x => x.services.push(slot));

    S.batches = [a, b];
    rebuildPlanner(S.batches);

    // Family share = 130 × 280g = 36.4L. Split 50/50 across 2 members.
    expect(calcRequired(a)).toBeCloseTo(18.2, 1);
    expect(calcRequired(b)).toBeCloseTo(18.2, 1);
  });
});
