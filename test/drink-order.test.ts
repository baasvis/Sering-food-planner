// Unit tests for the drinks ordering helpers (GOAL §4): par − stock order math,
// deposit totals, receiving stock deltas, demand nudge.

import {
  suggestedOrderQty, buildOrderSuggestions, orderDepositTotal, receivedStockDeltas, demandNudge,
} from '../shared/drink-order';
import type { Drink } from '../shared/types';

function d(p: Partial<Drink> & { id: string }): Drink {
  return {
    id: p.id, name: p.name || p.id, mode: 'catalogue', category: p.category || 'beer', subtype: '',
    abv: 0, btwRate: null, status: 'published', archived: p.archived ?? false, sellable: true,
    supplier: p.supplier || 'Sup', orderUnit: p.orderUnit || 'keg', orderUnitMl: null, packNote: '',
    itemId: null, deposit: p.deposit ?? 0, costPrice: null, costNote: '', formats: [],
    locations: p.locations || {}, info: {}, tebiProductNames: [], serveVolumeMl: null, glass: '',
    glassVolumeMl: null, servingTemp: '', characteristics: [], garnish: [], seasonality: '',
    serviceInstructions: '', prepSteps: [], batch: { volumeMl: 0, bottleSizeMl: null },
    prepTime: { prebatchMin: 0, perServeMin: 0 }, shelfLifeDays: null, costPerServe: null,
    suggestedPrice: null, createdAt: '', updatedAt: '', ingredientRows: [],
    stockByLocation: p.stockByLocation || {},
  };
}

describe('suggestedOrderQty (par − stock)', () => {
  it('refills to par, whole units', () => {
    expect(suggestedOrderQty(16, 5)).toBe(11);
    expect(suggestedOrderQty(8, 0)).toBe(8);
  });
  it('rounds fractional need up', () => {
    expect(suggestedOrderQty(3, 1.5)).toBe(2);
    expect(suggestedOrderQty(5, 4.1)).toBe(1);
  });
  it('returns 0 when stock meets/exceeds par or par is unset', () => {
    expect(suggestedOrderQty(8, 8)).toBe(0);
    expect(suggestedOrderQty(8, 10)).toBe(0);
    expect(suggestedOrderQty(null, 0)).toBe(0);
    expect(suggestedOrderQty(0, 0)).toBe(0);
  });
});

describe('buildOrderSuggestions', () => {
  const drinks = [
    d({ id: 'a', name: 'Pilsner', supplier: 'TwoChefs', orderUnit: 'keg', deposit: 30, locations: { west: { par: 16, active: true } }, stockByLocation: { west: 5 } }),
    d({ id: 'b', name: 'IPA', supplier: 'TwoChefs', locations: { west: { par: 4, active: true } }, stockByLocation: { west: 4 } }), // at par → skip
    d({ id: 'c', name: 'Other', supplier: 'Kweker', locations: { west: { par: 10, active: true } }, stockByLocation: { west: 0 } }), // wrong supplier
    d({ id: 'e', name: 'Inactive', supplier: 'TwoChefs', locations: { west: { par: 10, active: false } }, stockByLocation: { west: 0 } }), // inactive here
  ];
  it('returns only positive lines for the supplier, active at the location', () => {
    const lines = buildOrderSuggestions(drinks, 'TwoChefs', 'west');
    expect(lines.map(l => l.drinkId)).toEqual(['a']);
    expect(lines[0].orderQty).toBe(11);
    expect(lines[0].deposit).toBe(30);
  });
});

describe('orderDepositTotal', () => {
  it('sums qty × deposit', () => {
    expect(orderDepositTotal([{ orderQty: 11, deposit: 30 }, { orderQty: 2, deposit: 4.5 }])).toBe(339);
  });
});

describe('receivedStockDeltas', () => {
  it('adds receivedQty per drink, routing substitutions to the substitute', () => {
    const deltas = receivedStockDeltas([
      { drinkId: 'a', receivedQty: 5 },
      { drinkId: 'b', receivedQty: 0 },        // nothing received → skip
      { drinkId: 'c', receivedQty: null },     // not received → skip
      { drinkId: 'd', receivedQty: 3, substitutedByDrinkId: 'sub' },
      { drinkId: 'a', receivedQty: 2 },        // merges with first
    ]);
    const map = Object.fromEntries(deltas.map(x => [x.drinkId, x.qty]));
    expect(map).toEqual({ a: 7, sub: 3 });
  });
});

describe('demandNudge', () => {
  it('fires when upcoming exceeds trailing avg by > threshold', () => {
    expect(demandNudge(130, 100, 25)).toBe(true);   // +30% > 25%
    expect(demandNudge(120, 100, 25)).toBe(false);  // +20% < 25%
    expect(demandNudge(100, 0, 25)).toBe(false);    // no baseline
  });
});
