// Unit tests for the drinks costing engine (GOAL §4): recursive cost rollup
// incl. a building block used by another building block, labour amortisation,
// markup/rounding, suggested price, bottle yield, cycle safety.

import {
  makeCostContext, drinkCostPerMl, rowsCost, labourPerServe, drinkTotalCostExBtw,
  yieldBottles, targetMarkupFor, roundToStep, suggestedPriceInclBtw, actualMarkup, markupLight,
  CostIngredient,
} from '../shared/drink-cost';
import { DEFAULT_DRINK_CONFIG } from '../lib/drinks';
import type { Drink, DrinkIngredientRow } from '../shared/types';

const cfg = DEFAULT_DRINK_CONFIG;

// Minimal Drink factory — fills the fields the cost engine reads.
function d(p: Partial<Drink> & { id: string }): Drink {
  return {
    id: p.id, name: p.name || p.id, mode: p.mode || 'recipe', category: p.category || 'cocktail',
    subtype: '', abv: p.abv ?? 0, btwRate: p.btwRate ?? null, status: 'published', archived: false,
    sellable: true, supplier: '', orderUnit: '', orderUnitMl: p.orderUnitMl ?? null, packNote: '',
    itemId: null, deposit: 0, costPrice: p.costPrice ?? null, costNote: '', formats: p.formats || [],
    locations: {}, info: {}, tebiProductNames: [], serveVolumeMl: p.serveVolumeMl ?? null, glass: '',
    glassVolumeMl: null, servingTemp: '', characteristics: [], garnish: [], seasonality: '',
    serviceInstructions: '', prepSteps: [], batch: p.batch || { volumeMl: 0, bottleSizeMl: null },
    prepTime: p.prepTime || { prebatchMin: 0, perServeMin: 0 }, shelfLifeDays: null,
    costPerServe: null, suggestedPrice: null, createdAt: '', updatedAt: '',
    ingredientRows: p.ingredientRows || [],
  };
}

function row(p: Partial<DrinkIngredientRow>): DrinkIngredientRow {
  return { id: p.id || 'r', drinkId: 'x', sortOrder: 0, refKind: p.refKind || 'ingredient',
    ingredientId: p.ingredientId ?? null, refDrinkId: p.refDrinkId ?? null, amount: p.amount ?? null,
    unit: p.unit || 'ml', note: '' };
}

const ingredients: CostIngredient[] = [
  { id: 'sugar', pricePer100: 0.10 }, // €1/kg
  { id: 'water', pricePer100: 0 },
  { id: 'bayleaf', pricePer100: 2.0 },
];

// Catalogue spirit: €12.99 / 1000ml bottle → 0.01299 €/ml
const vodka = d({ id: 'vodka', mode: 'catalogue', category: 'spirits', costPrice: 12.99, orderUnitMl: 1000 });
// Building block: 500g sugar + 500ml water in a 1000ml batch
const simpleSyrup = d({ id: 'simple', category: 'building-block', batch: { volumeMl: 1000, bottleSizeMl: 1000 },
  ingredientRows: [row({ refKind: 'ingredient', ingredientId: 'sugar', amount: 500, unit: 'g' }),
    row({ refKind: 'ingredient', ingredientId: 'water', amount: 500, unit: 'ml' })] });
// Building block that uses another building block (bb→bb)
const bayleafSyrup = d({ id: 'bayleaf', category: 'building-block', batch: { volumeMl: 1000, bottleSizeMl: 1000 },
  ingredientRows: [row({ refKind: 'drink', refDrinkId: 'simple', amount: 1000, unit: 'ml' }),
    row({ refKind: 'ingredient', ingredientId: 'bayleaf', amount: 10, unit: 'g' })] });
// Served cocktail: 45ml vodka + 15ml simple syrup per serve
const martini = d({ id: 'martini', category: 'cocktail', abv: 20, serveVolumeMl: 100,
  prepTime: { prebatchMin: 60, prebatchYieldServings: 150, perServeMin: 1 },
  ingredientRows: [row({ refKind: 'drink', refDrinkId: 'vodka', amount: 45, unit: 'ml' }),
    row({ refKind: 'drink', refDrinkId: 'simple', amount: 15, unit: 'ml' })] });

function ctx() { return makeCostContext([vodka, simpleSyrup, bayleafSyrup, martini], ingredients, cfg); }

describe('drinkCostPerMl', () => {
  it('catalogue: costPrice ÷ orderUnitMl', () => {
    expect(drinkCostPerMl(vodka, ctx())).toBeCloseTo(0.01299, 6);
  });
  it('building block: batch ingredient cost ÷ batch volume', () => {
    // (500/100 × 0.10) / 1000 = 0.0005
    expect(drinkCostPerMl(simpleSyrup, ctx())).toBeCloseTo(0.0005, 8);
  });
  it('recursive: a building block used by another building block', () => {
    // (1000×0.0005 + 10/100×2.0) / 1000 = (0.5 + 0.2)/1000 = 0.0007
    expect(drinkCostPerMl(bayleafSyrup, ctx())).toBeCloseTo(0.0007, 8);
  });
  it('returns 0 (no hang) on a reference cycle', () => {
    const a = d({ id: 'a', category: 'building-block', batch: { volumeMl: 1000, bottleSizeMl: null }, ingredientRows: [row({ refKind: 'drink', refDrinkId: 'b', amount: 1000 })] });
    const b = d({ id: 'b', category: 'building-block', batch: { volumeMl: 1000, bottleSizeMl: null }, ingredientRows: [row({ refKind: 'drink', refDrinkId: 'a', amount: 1000 })] });
    const c = makeCostContext([a, b], ingredients, cfg);
    expect(Number.isFinite(drinkCostPerMl(a, c))).toBe(true);
  });
});

describe('rowsCost + labour + total', () => {
  it('per-serve ingredient cost sums drink + ingredient refs', () => {
    // 45×0.01299 + 15×0.0005 = 0.58455 + 0.0075 = 0.59205
    expect(rowsCost(martini.ingredientRows, ctx())).toBeCloseTo(0.59205, 5);
  });
  it('labour amortises prebatch over the yield', () => {
    // (60/150 + 1) × 0.29 = 1.4 × 0.29 = 0.406
    expect(labourPerServe(martini, cfg)).toBeCloseTo(0.406, 5);
  });
  it('derives yield from batch ÷ serve when prebatchYieldServings is absent', () => {
    // 4000ml batch ÷ 250ml serve = 16 serves → (20/16 + 1) × 0.29 = 0.6525
    const iced = d({ id: 'iced', category: 'homemade-na', serveVolumeMl: 250,
      batch: { volumeMl: 4000, bottleSizeMl: null }, prepTime: { prebatchMin: 20, perServeMin: 1 } });
    expect(labourPerServe(iced, cfg)).toBeCloseTo(0.6525, 4);
  });
  it('total ex-BTW per serve = ingredient + labour', () => {
    expect(drinkTotalCostExBtw(martini, ctx())).toBeCloseTo(0.99805, 5);
  });
});

describe('markup, rounding, suggested price', () => {
  it('rounds to the nearest step', () => {
    expect(roundToStep(4.83, 0.1)).toBeCloseTo(4.8, 5);
    expect(roundToStep(4.86, 0.1)).toBeCloseTo(4.9, 5);
  });
  it('targetMarkupFor falls back to the default multiple', () => {
    expect(targetMarkupFor('cocktail', cfg)).toBe(4.0);
    expect(targetMarkupFor('wine', { ...cfg, markupTargets: { defaultMultiple: 4, wine: 3.2 } })).toBe(3.2);
    expect(targetMarkupFor('wine', { ...cfg, markupTargets: { defaultMultiple: 4, wine: null } })).toBe(4.0);
  });
  it('suggested price = cost × target, grossed up by BTW, rounded to €0.10', () => {
    // 0.99805 × 4 = 3.9922; × 1.21 = 4.8306; → 4.80
    expect(suggestedPriceInclBtw(0.99805, 21, 4.0, cfg)).toBeCloseTo(4.8, 2);
  });
  it('actual markup strips BTW from the incl-BTW price', () => {
    // (9.5/1.21)/0.99805 ≈ 7.87
    expect(actualMarkup(9.5, 21, 0.99805)).toBeCloseTo(7.866, 2);
    expect(actualMarkup(null, 21, 1)).toBeNull();
    expect(actualMarkup(5, 21, 0)).toBeNull();
  });
  it('traffic light: ±10% band around the target', () => {
    expect(markupLight(4.0, 4.0)).toBe('green');
    expect(markupLight(4.3, 4.0)).toBe('green');   // within +10%
    expect(markupLight(3.5, 4.0)).toBe('red');     // under-priced
    expect(markupLight(7.8, 4.0)).toBe('amber');   // pricey
    expect(markupLight(null, 4.0)).toBe('none');
  });
});

describe('yieldBottles', () => {
  it('batch volume ÷ bottle size', () => {
    expect(yieldBottles(d({ id: 'x', batch: { volumeMl: 5000, bottleSizeMl: 750 } }))).toBeCloseTo(6.6667, 3);
  });
  it('0 when not derivable', () => {
    expect(yieldBottles(d({ id: 'x', batch: { volumeMl: 5000, bottleSizeMl: null } }))).toBe(0);
  });
});
