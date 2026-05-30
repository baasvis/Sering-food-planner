/**
 * Unit tests for the inventory cook-confirm dish filter
 * (planner.plannedCookConfirmDishes). Guards the deep-review findings:
 *   H2 — cook-location routing (West cooks for Centraal; the dish belongs to
 *        West's list, never Centraal's).
 *   M2 — an already-cooked-then-served dish must not reappear.
 * Plus the cook-DAY requirement (only dishes to cook THIS day, not leftovers).
 */

import type { Batch } from '@shared/types';
import { plannedCookConfirmDishes } from '../public/js/planner';

const TODAY = '25/05/2026';   // DD/MM/YYYY — matches Batch.cookDate / dateToStr

function mkBatch(p: Partial<Batch>): Batch {
  return {
    id: p.id ?? 'b1',
    name: p.name ?? 'Test',
    type: p.type ?? 'Soup',
    recipeId: p.recipeId ?? null,
    serving: p.serving ?? 280,
    cookDate: p.cookDate ?? null,
    inventory: p.inventory ?? [],
    shipments: p.shipments ?? [],
    services: p.services ?? [],
    allergens: p.allergens ?? [],
    extraAllergens: p.extraAllergens ?? [],
    note: p.note ?? '',
    cookNotes: p.cookNotes ?? '',
    actualIngredients: p.actualIngredients ?? null,
    orderFor: p.orderFor ?? false,
    generated: p.generated,
    stockDeducted: p.stockDeducted ?? false,
    createdAt: p.createdAt ?? '2026-05-25T00:00:00.000Z',
  };
}
const names = (bs: Batch[]) => bs.map(b => b.name);

describe('plannedCookConfirmDishes', () => {
  it('shows an uncooked West dish under West only', () => {
    const b = mkBatch({ name: 'Soup', cookDate: TODAY, services: [{ loc: 'west', date: '2026-05-25', meal: 'lunch' }] });
    expect(names(plannedCookConfirmDishes([b], 'west', TODAY))).toEqual(['Soup']);
    expect(plannedCookConfirmDishes([b], 'centraal', TODAY)).toEqual([]);
  });

  it('routes a West-cooked-for-Centraal dish to West, not Centraal (H2)', () => {
    // Cooked at West, served only at Centraal: empty inventory + centraal-only
    // services. It belongs to West (which cooks it), never Centraal's list.
    const b = mkBatch({ name: 'Dahl', cookDate: TODAY, services: [{ loc: 'centraal', date: '2026-05-25', meal: 'lunch' }] });
    expect(names(plannedCookConfirmDishes([b], 'west', TODAY))).toEqual(['Dahl']);
    expect(plannedCookConfirmDishes([b], 'centraal', TODAY)).toEqual([]);
  });

  it('excludes leftovers — cook day is not today (past or future)', () => {
    const yesterday = mkBatch({ name: 'Fri Soup', cookDate: '24/05/2026', services: [{ loc: 'west', date: '2026-05-25', meal: 'lunch' }] });
    const tomorrow = mkBatch({ name: 'Sun Soup', cookDate: '26/05/2026', services: [{ loc: 'west', date: '2026-05-26', meal: 'lunch' }] });
    expect(plannedCookConfirmDishes([yesterday, tomorrow], 'west', TODAY)).toEqual([]);
  });

  it('excludes an already-cooked dish (has stock)', () => {
    const cooked = mkBatch({ name: 'Stew', cookDate: TODAY, inventory: [{ loc: 'west', storage: 'Gastro', qty: 40, cookDate: TODAY }] });
    expect(plannedCookConfirmDishes([cooked], 'west', TODAY)).toEqual([]);
  });

  it('excludes a cooked-then-served dish whose zero-qty entry lingers (M2)', () => {
    const served = mkBatch({ name: 'Curry', cookDate: TODAY, inventory: [{ loc: 'west', storage: 'Gastro', qty: 0, cookDate: TODAY }] });
    expect(plannedCookConfirmDishes([served], 'west', TODAY)).toEqual([]);
  });

  it('excludes a cooked-and-shipped dish (pending shipment, empty inventory)', () => {
    const shipped = mkBatch({ name: 'Bisque', cookDate: TODAY, shipments: [{ id: 's1', fromLoc: 'west', toLoc: 'centraal', storage: 'Gastro', qty: 20, sentAt: '2026-05-25T11:00:00.000Z', arrived: false, cookDate: TODAY }] });
    expect(plannedCookConfirmDishes([shipped], 'west', TODAY)).toEqual([]);
  });

  it('sorts the result by name', () => {
    const a = mkBatch({ id: 'a', name: 'Beta', cookDate: TODAY });
    const b = mkBatch({ id: 'b', name: 'Alpha', cookDate: TODAY });
    expect(names(plannedCookConfirmDishes([a, b], 'west', TODAY))).toEqual(['Alpha', 'Beta']);
  });
});
