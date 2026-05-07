// Unit tests for applyToolCall + summarizeTool from lib/recipe-ai.ts.
// Both functions are pure — no DB / API needed. Covers tool semantics:
// partial-update for basics, full-replace for ingredients/steps, ingredient
// id validation against the catalog, and the unknown-tool error path.

import { applyToolCall, summarizeTool, type AIRecipeState } from '../lib/recipe-ai';
import type { Ingredient } from '../shared/types';

const emptyState = (): AIRecipeState => ({
  name: '',
  type: 'Soup',
  structure: '',
  seasonality: '',
  servingTemp: '',
  servingSize: 280,
  ingredients: [],
  prepSteps: [],
  coolingMethod: '',
  storageMethod: '',
  extraAllergens: [],
});

const fakeIngredient = (id: string, name: string): Ingredient => ({
  id, name,
  supplierName: '', types: [], category: 'Vegetables & Fruit',
  measureMode: 'weight', unit: 'g', supplier: '', orderCode: '',
  orderUnit: '', orderPrice: null, orderUnitSize: 0,
  priceLevel: '', pricePer100: 0.5, priceAlert: false,
  storageLocations: {}, stock: {}, targetStock: {},
  allergens: '', notes: '', active: true,
});

const catalog = [
  fakeIngredient('ing-onion', 'onion'),
  fakeIngredient('ing-carrot', 'carrot'),
  fakeIngredient('ing-lentil', 'red lentil'),
];

describe('applyToolCall', () => {
  it('throws on unknown tool name', () => {
    expect(() => applyToolCall(emptyState(), 'set_imaginary_field', {}, catalog))
      .toThrow(/Unknown tool/);
  });

  describe('set_recipe_basics', () => {
    it('applies partial updates and leaves omitted fields untouched', () => {
      const before = emptyState();
      before.name = 'old name';
      before.servingSize = 250;
      const after = applyToolCall(before, 'set_recipe_basics', { name: 'New', type: 'Main course' }, catalog);
      expect(after.name).toBe('New');
      expect(after.type).toBe('Main course');
      expect(after.servingSize).toBe(250); // untouched
    });

    it('coerces servingSize to a number', () => {
      const after = applyToolCall(emptyState(), 'set_recipe_basics', { servingSize: '300' as unknown as number }, catalog);
      expect(after.servingSize).toBe(300);
    });

    it('keeps existing servingSize on garbage input', () => {
      const before = { ...emptyState(), servingSize: 280 };
      const after = applyToolCall(before, 'set_recipe_basics', { servingSize: 'not a number' as unknown as number }, catalog);
      expect(after.servingSize).toBe(280);
    });
  });

  describe('set_ingredients', () => {
    it('full-replaces the ingredient list', () => {
      const before = emptyState();
      before.ingredients = [
        { ingredientId: 'ing-old', ingredientName: 'old', rawAmount: 1, unit: 'Kilos', isFlexible: false, flexCategory: null, flexLabel: null },
      ];
      const after = applyToolCall(before, 'set_ingredients', {
        ingredients: [
          { ingredientId: 'ing-onion', ingredientName: 'onion', rawAmount: 500, unit: 'Grams', isFlexible: false, flexCategory: null, flexLabel: null },
          { ingredientId: 'ing-carrot', ingredientName: 'carrot', rawAmount: 1, unit: 'Kilos', isFlexible: false, flexCategory: null, flexLabel: null },
        ],
      }, catalog);
      expect(after.ingredients).toHaveLength(2);
      expect(after.ingredients[0].ingredientId).toBe('ing-onion');
      expect(after.ingredients[1].rawAmount).toBe(1);
    });

    it('drops invalid ingredientIds to null (free-text fallback)', () => {
      const after = applyToolCall(emptyState(), 'set_ingredients', {
        ingredients: [
          { ingredientId: 'does-not-exist', ingredientName: 'mystery', rawAmount: 100, unit: 'Grams' },
        ],
      }, catalog);
      expect(after.ingredients[0].ingredientId).toBeNull();
      expect(after.ingredients[0].ingredientName).toBe('mystery');
    });

    it('preserves valid ingredientIds', () => {
      const after = applyToolCall(emptyState(), 'set_ingredients', {
        ingredients: [
          { ingredientId: 'ing-lentil', ingredientName: 'red lentil', rawAmount: 700, unit: 'Grams' },
        ],
      }, catalog);
      expect(after.ingredients[0].ingredientId).toBe('ing-lentil');
    });

    it('handles flexible slots', () => {
      const after = applyToolCall(emptyState(), 'set_ingredients', {
        ingredients: [
          { ingredientId: null, ingredientName: 'Any vegetables', rawAmount: 2.4, unit: 'Kilos',
            isFlexible: true, flexCategory: 'Vegetables & Fruit', flexLabel: 'Any vegetables' },
        ],
      }, catalog);
      expect(after.ingredients[0].isFlexible).toBe(true);
      expect(after.ingredients[0].flexCategory).toBe('Vegetables & Fruit');
    });

    it('coerces missing/garbage fields to safe defaults', () => {
      const after = applyToolCall(emptyState(), 'set_ingredients', {
        ingredients: [
          // intentionally drop unit, raw amount as string
          { ingredientName: 'salt', rawAmount: '30' as unknown as number },
        ],
      }, catalog);
      expect(after.ingredients[0].rawAmount).toBe(30);
      expect(after.ingredients[0].unit).toBe('Grams');
      expect(after.ingredients[0].isFlexible).toBe(false);
      expect(after.ingredients[0].cookedAmount).toBeNull();
    });

    it('preserves cookedAmount when AI provides it', () => {
      const after = applyToolCall(emptyState(), 'set_ingredients', {
        ingredients: [
          { ingredientId: 'ing-onion', ingredientName: 'onion', rawAmount: 800, cookedAmount: 400, unit: 'Grams' },
          { ingredientId: 'ing-lentil', ingredientName: 'red lentil', rawAmount: 400, cookedAmount: 1000, unit: 'Grams' },
        ],
      }, catalog);
      expect(after.ingredients[0].cookedAmount).toBe(400);
      expect(after.ingredients[1].cookedAmount).toBe(1000);
    });

    it('leaves cookedAmount null when AI omits it', () => {
      const after = applyToolCall(emptyState(), 'set_ingredients', {
        ingredients: [
          { ingredientId: 'ing-onion', ingredientName: 'onion', rawAmount: 500, unit: 'Grams' },
        ],
      }, catalog);
      expect(after.ingredients[0].cookedAmount).toBeNull();
    });

    it('rejects non-finite cookedAmount values', () => {
      const after = applyToolCall(emptyState(), 'set_ingredients', {
        ingredients: [
          { ingredientName: 'a', rawAmount: 100, cookedAmount: NaN as unknown as number, unit: 'Grams' },
          { ingredientName: 'b', rawAmount: 100, cookedAmount: '50' as unknown as number, unit: 'Grams' },
          { ingredientName: 'c', rawAmount: 100, cookedAmount: Infinity as unknown as number, unit: 'Grams' },
        ],
      }, catalog);
      // NaN, string, and Infinity should all coerce to null — the AI must send a real number.
      expect(after.ingredients[0].cookedAmount).toBeNull();
      expect(after.ingredients[1].cookedAmount).toBeNull();
      expect(after.ingredients[2].cookedAmount).toBeNull();
    });
  });

  describe('set_prep_steps', () => {
    it('full-replaces, filters empty steps, and copies optional notes', () => {
      const before = emptyState();
      before.prepSteps = [{ text: 'old step' }];
      const after = applyToolCall(before, 'set_prep_steps', {
        steps: [
          { text: 'Heat oil in a large pot.' },
          { text: '' }, // dropped
          { text: 'Add onions.', note: 'Cut them coarsely.' },
        ],
      }, catalog);
      expect(after.prepSteps).toHaveLength(2);
      expect(after.prepSteps[0].text).toBe('Heat oil in a large pot.');
      expect(after.prepSteps[0].note).toBeUndefined();
      expect(after.prepSteps[1].note).toBe('Cut them coarsely.');
    });
  });

  describe('set_storage', () => {
    it('partial-updates cooling and storage methods', () => {
      const before = { ...emptyState(), coolingMethod: 'old cooling', storageMethod: 'old storage' };
      const after = applyToolCall(before, 'set_storage', { coolingMethod: 'blast chiller' }, catalog);
      expect(after.coolingMethod).toBe('blast chiller');
      expect(after.storageMethod).toBe('old storage');
    });
  });

  describe('set_extra_allergens', () => {
    it('full-replaces the allergen list', () => {
      const before = { ...emptyState(), extraAllergens: ['Sesame'] };
      const after = applyToolCall(before, 'set_extra_allergens', { allergens: ['Gluten', 'Soy'] }, catalog);
      expect(after.extraAllergens).toEqual(['Gluten', 'Soy']);
    });

    it('coerces non-array input to empty list', () => {
      const after = applyToolCall(emptyState(), 'set_extra_allergens', { allergens: undefined }, catalog);
      expect(after.extraAllergens).toEqual([]);
    });
  });

  it('returned states are new objects (no mutation of input)', () => {
    const before = emptyState();
    const beforeFrozen = JSON.stringify(before);
    applyToolCall(before, 'set_recipe_basics', { name: 'mutate me' }, catalog);
    expect(JSON.stringify(before)).toBe(beforeFrozen);
  });
});

describe('summarizeTool', () => {
  it('summarizes set_recipe_basics with the provided fields', () => {
    const newState = applyToolCall(emptyState(), 'set_recipe_basics', { name: 'Tomato soup', type: 'Soup' }, catalog);
    const s = summarizeTool('set_recipe_basics', { name: 'Tomato soup', type: 'Soup' }, newState);
    expect(s).toContain('Tomato soup');
    expect(s).toContain('Soup');
  });

  it('summarizes ingredient count for set_ingredients', () => {
    const newState = applyToolCall(emptyState(), 'set_ingredients', {
      ingredients: [
        { ingredientId: 'ing-onion', ingredientName: 'onion', rawAmount: 500, unit: 'Grams' },
        { ingredientId: 'ing-carrot', ingredientName: 'carrot', rawAmount: 1, unit: 'Kilos' },
      ],
    }, catalog);
    expect(summarizeTool('set_ingredients', {}, newState)).toContain('2');
  });

  it('falls back to the tool name for unknown tools', () => {
    expect(summarizeTool('mystery_tool', {}, emptyState())).toBe('mystery_tool');
  });
});
