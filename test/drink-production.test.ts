// Unit tests for production + write-off helpers (GOAL §4: premix two-stage flow,
// write-off stock effect).

import { producedUnits, consumedBuildingBlocks, writeOffDelta, expiryDate } from '../shared/drink-production';
import type { Drink, DrinkIngredientRow } from '../shared/types';

function d(p: Partial<Drink> & { id: string }): Drink {
  return {
    id: p.id, name: p.id, mode: 'recipe', category: p.category || 'cocktail', subtype: '', abv: 0,
    btwRate: null, status: 'published', archived: false, sellable: true, supplier: 'Homemade',
    orderUnit: '', orderUnitMl: null, packNote: '', itemId: null, deposit: 0, costPrice: null, costNote: '',
    formats: [], locations: {}, info: {}, tebiProductNames: [], serveVolumeMl: p.serveVolumeMl ?? null,
    glass: '', glassVolumeMl: null, servingTemp: '', characteristics: [], garnish: [], seasonality: '',
    serviceInstructions: '', prepSteps: [], batch: p.batch || { volumeMl: 0, bottleSizeMl: null },
    prepTime: p.prepTime || { prebatchMin: 0, perServeMin: 0 }, shelfLifeDays: null, costPerServe: null,
    suggestedPrice: null, createdAt: '', updatedAt: '', ingredientRows: p.ingredientRows || [],
  };
}
function row(p: Partial<DrinkIngredientRow>): DrinkIngredientRow {
  return { id: 'r', drinkId: 'x', sortOrder: 0, refKind: p.refKind || 'drink', ingredientId: null,
    refDrinkId: p.refDrinkId ?? null, amount: p.amount ?? null, unit: p.unit || 'ml', note: '' };
}

describe('producedUnits (premix stage 1)', () => {
  it('bottles when the batch bottles up', () => {
    const cocktail = d({ id: 'c', batch: { volumeMl: 5000, bottleSizeMl: 750 } });
    expect(producedUnits(cocktail, 1)).toEqual({ qty: 6.67, unit: 'bottle' });
    expect(producedUnits(cocktail, 2)).toEqual({ qty: 13.33, unit: 'bottle' });
  });
  it('litres when there is no bottle size', () => {
    const block = d({ id: 'b', category: 'building-block', batch: { volumeMl: 1000, bottleSizeMl: null } });
    expect(producedUnits(block, 5)).toEqual({ qty: 5, unit: 'liter' });
  });
});

describe('consumedBuildingBlocks', () => {
  it('served recipe: amount × prebatchYield × batches', () => {
    const cocktail = d({ id: 'c', category: 'cocktail', serveVolumeMl: 100,
      prepTime: { prebatchMin: 60, prebatchYieldServings: 150, perServeMin: 1 },
      ingredientRows: [row({ refKind: 'drink', refDrinkId: 'syrup', amount: 15 })] });
    // 15ml/serve × 150 serves/batch × 1 batch = 2250ml = 2.25 L
    expect(consumedBuildingBlocks(cocktail, 1)).toEqual([{ drinkId: 'syrup', liters: 2.25 }]);
  });
  it('building block: amount × batches (rows are per-batch)', () => {
    const block = d({ id: 'b', category: 'building-block', batch: { volumeMl: 1000, bottleSizeMl: 1000 },
      ingredientRows: [row({ refKind: 'drink', refDrinkId: 'base', amount: 1000 })] });
    expect(consumedBuildingBlocks(block, 3)).toEqual([{ drinkId: 'base', liters: 3 }]);
  });
  it('ignores ingredient rows (only building-block drink refs consume here)', () => {
    const c = d({ id: 'c', ingredientRows: [row({ refKind: 'ingredient', refDrinkId: null, amount: 50 })] });
    expect(consumedBuildingBlocks(c, 1)).toEqual([]);
  });
});

describe('writeOffDelta', () => {
  it('is the negative quantity', () => {
    expect(writeOffDelta(3)).toBe(-3);
    expect(writeOffDelta(0)).toBe(0);
  });
});

describe('expiryDate', () => {
  it('adds shelf-life days', () => {
    expect(expiryDate('2026-06-06', 7)).toBe('2026-06-13');
  });
  it('null when no shelf life', () => {
    expect(expiryDate('2026-06-06', null)).toBeNull();
    expect(expiryDate('2026-06-06', 0)).toBeNull();
  });
});
