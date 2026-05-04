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
import { calcRequired, recomputeFamilyAllocations } from '../public/js/core';
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
  // Refresh the greedy family allocation cache that calcRequired reads from.
  recomputeFamilyAllocations();
}

beforeEach(() => {
  _id = 0;
  // Seed S.guests for every weekday so the multi-slot test can rely on
  // 130 guests at every dinner.
  const dinner130 = (d: string) => ({ [d]: { lunch: 90, dinner: 130 } });
  S.guests = {
    centraal: { ...dinner130('Mon'), ...dinner130('Tue'), ...dinner130('Wed'), ...dinner130('Thu'), ...dinner130('Fri') } as any,
    west: { Mon: { lunch: 100, dinner: 110 } } as any,
  };
  S.batches = [];
  S.planner = {};
  S.caterings = [];
  S.guestsNextWeeks = {};
});

describe('family-aware calcRequired', () => {
  test('Single Centraal slot — greedy drains the same-loc split first', () => {
    // Slot: Mon dinner Centraal, 130 guests. Tomato family at the slot:
    //   - Tomato West (parent, 50L) — off-loc relative to slot
    //   - Tomato Centraal (split, 20L) — SAME-loc as slot
    //   - Courgette Centraal (50L) — different family
    // Family share = 130/2 × 280g = 18.2L.
    // GREEDY: same-loc first. Split (20L) absorbs the full 18.2L of family
    // demand at this slot — its remaining stock drops to 1.8L. Parent gets
    // charged 0L because the split alone can cover the slot.
    const tomatoParent = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 50, location: 'west', name: 'Tomato' });
    const tomatoSplit = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 20, location: 'centraal', name: 'Tomato (split)' });
    tomatoSplit.parentId = tomatoParent.id;
    const courgette = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 50, location: 'centraal', name: 'Courgette' });

    const slot: Service = { loc: 'centraal', date: '2026-05-04', meal: 'dinner' };
    [tomatoParent, tomatoSplit, courgette].forEach(b => b.services.push(slot));

    S.batches = [tomatoParent, tomatoSplit, courgette];
    rebuildPlanner(S.batches);

    // Greedy: split (same-loc) absorbs full 18.2L, parent unused.
    expect(calcRequired(tomatoSplit)).toBeCloseTo(18.2, 1);
    expect(calcRequired(tomatoParent)).toBeCloseTo(0, 1);
    // Family total still equals slot's family share.
    expect(calcRequired(tomatoSplit) + calcRequired(tomatoParent)).toBeCloseTo(18.2, 1);
    // Courgette gets the other half.
    expect(calcRequired(courgette)).toBeCloseTo(18.2, 1);
  });

  test('Multiple Centraal slots — split fills first slot fully, parent picks up the rest chronologically', () => {
    // Daan's exact scenario. Tomato split (20L) at C, parent (50L) at W.
    // 3 Centraal slots Mon/Tue/Wed dinner, 130 guests each = 18.2L family
    // share each. Total family demand: 54.6L. Total stock: 70L. Should fit.
    // GREEDY chronological:
    //   Mon dinner C (slot 1): split tries to absorb 18.2L → has 20L → take
    //     all 18.2L. Split remaining: 1.8L. Parent: 0L charged.
    //   Tue dinner C (slot 2): split has 1.8L, takes 1.8L. Parent absorbs
    //     16.4L. Split remaining: 0L. Parent remaining: 33.6L.
    //   Wed dinner C (slot 3): split exhausted (0L), parent absorbs full 18.2L.
    //     Parent remaining: 15.4L.
    // Final: split = 20L (drained), parent = 34.6L of 50L used.
    const parent = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 50, location: 'west', name: 'Tomato' });
    const split = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 20, location: 'centraal', name: 'Tomato (split)' });
    split.parentId = parent.id;
    const courgette = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 50, location: 'centraal', name: 'Courgette' });

    const slot1: Service = { loc: 'centraal', date: '2026-05-04', meal: 'dinner' };
    const slot2: Service = { loc: 'centraal', date: '2026-05-05', meal: 'dinner' };
    const slot3: Service = { loc: 'centraal', date: '2026-05-06', meal: 'dinner' };
    [parent, split, courgette].forEach(b => b.services.push(slot1, slot2, slot3));

    S.batches = [parent, split, courgette];
    rebuildPlanner(S.batches);

    // Split is drained fully (20L), parent picks up 34.6L. Neither overshoots.
    expect(calcRequired(split)).toBeCloseTo(20.0, 1);
    expect(calcRequired(parent)).toBeCloseTo(34.6, 1);
    // Family total = 54.6L (3 slots × 18.2L).
    expect(calcRequired(split) + calcRequired(parent)).toBeCloseTo(54.6, 1);
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

  test('Family-only at slot — greedy drains same-loc first then off-loc', () => {
    // Slot at Centraal, Tomato family is the only menu option (130 guests).
    // Family share = 130 × 280g = 36.4L (full slot, alone on menu).
    // Both batches have 50L. Same-loc (split) drains first up to 36.4L,
    // parent gets 0L.
    const parent = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 50, location: 'west', name: 'Tomato' });
    const split = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 50, location: 'centraal', name: 'Tomato (split)' });
    split.parentId = parent.id;
    const slot: Service = { loc: 'centraal', date: '2026-05-04', meal: 'dinner' };
    [parent, split].forEach(b => b.services.push(slot));

    S.batches = [parent, split];
    rebuildPlanner(S.batches);

    // Greedy: split (same-loc) takes the full 36.4L, parent gets 0.
    expect(calcRequired(split)).toBeCloseTo(36.4, 1);
    expect(calcRequired(parent)).toBeCloseTo(0, 1);
    // Family total = full slot demand
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
