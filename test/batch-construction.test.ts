/**
 * Guard: the UI actions that hand-build a Batch object literal must produce a
 * batch in the unified shape — inventory[] + shipments[] arrays, and none of
 * the legacy stock/location/storage/inTransit/parentId/recipeSheetId fields.
 *
 * Why this file exists: the unified-batch rewrite (PR #60) migrated the
 * helpers and API endpoints but not every UI action that hand-builds a Batch
 * object literal. addPlaceholderDish shipped on the legacy shape (fixed in
 * 8bdc050); addDishFromV2Recipe — the recipe list's "+ Menu" button — shipped
 * the same way. Both made the save fail with "inventory must be an array"
 * because nothing type-checked or tested the literal. This test invokes each
 * constructor and runs its output through the real validateBatch (the exact
 * gate POST /api/data/patch uses), so a future drift back to the legacy shape
 * fails CI instead of reaching a cook.
 *
 * Covered here: addDishFromV2Recipe, addPlaceholderDish, replaceWithV2Recipe.
 * saveNewDish reads DOM form inputs, so it is covered by
 * e2e/batch-create.spec.ts instead. menu-fixer.ts also constructs batches
 * (generated placeholders, emergency cooks) — those are exercised by
 * test/menu-fixer.test.ts.
 */

// Browser-global stubs (document, localStorage, ...) come from
// test/setup-dom-stubs.ts in the jest setupFiles list — it runs before the
// module imports below.

// closeModal + rerenderCurrentView do raw DOM writes (modal.ts uses a
// non-null assertion on #modal-root) that the lightweight setup-dom-stubs
// document can't satisfy. Stub just those two — every other collaborator the
// constructors call (rebuildPlanner, scheduleSave, toast) is DOM-safe or
// timer-inert, so the batch object under test is still built by real code.
jest.mock('../public/js/modal', () => ({
  ...jest.requireActual('../public/js/modal'),
  closeModal: jest.fn(),
}));
jest.mock('../public/js/navigate', () => ({
  ...jest.requireActual('../public/js/navigate'),
  rerenderCurrentView: jest.fn(),
}));

import { S } from '../public/js/state';
import { addDishFromV2Recipe } from '../public/js/recipes';
import { addPlaceholderDish, replaceWithV2Recipe } from '../public/js/planner';
import type { Batch } from '../shared/types';

// validateBatch is the exact server-side gate. Importing lib/db constructs a
// Prisma client but never connects unless a query runs — validateBatch is pure.
const { validateBatch, prisma } = require('../lib/db');

// Legacy fields that must NOT appear on a unified-batch row. Their presence is
// the fingerprint of an un-migrated constructor.
const LEGACY_FIELDS = [
  'stock', 'location', 'storage', 'inTransit', 'parentId',
  'recipeSheetId', 'recipeVolume', 'recipeIngredients',
];

function assertUnifiedShape(b: Batch): void {
  // The exact check the server runs on every batch — null means "valid".
  expect(validateBatch(b)).toBeNull();
  // Explicit signal on top of validateBatch's generic message.
  expect(Array.isArray(b.inventory)).toBe(true);
  expect(Array.isArray(b.shipments)).toBe(true);
  for (const f of LEGACY_FIELDS) {
    expect(b as Record<string, unknown>).not.toHaveProperty(f);
  }
}

// Minimal v2 recipe — only the fields the constructors actually read.
function makeRecipe(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rec-test-1',
    name: 'Test Lentil Soup',
    type: 'Soup',
    servingSize: 280,
    recipeVolume: 5,
    autoAllergens: ['Celery'],
    extraAllergens: ['Gluten'],
    ingredients: [],
    ...overrides,
  };
}

// Inert the scheduleSave() debounce timer so it can never fire a real
// POST /api/data/patch at the test DB, and pin the clock for determinism.
beforeAll(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-05-15T10:00:00Z'));
});
afterAll(async () => {
  jest.useRealTimers();
  await prisma.$disconnect();
});

beforeEach(() => {
  // Mirrors the known-good S setup from transport-card.test.ts — rebuildPlanner
  // (called by every constructor) reads guests + planner.
  S.guests = {
    west: { Mon: { lunch: 80, dinner: 90 }, Tue: { lunch: 80, dinner: 90 }, Wed: { lunch: 80, dinner: 90 }, Thu: { lunch: 80, dinner: 90 }, Fri: { lunch: 80, dinner: 90 }, Sat: { lunch: 0, dinner: 0 }, Sun: { lunch: 0, dinner: 0 } },
    centraal: { Mon: { lunch: 60, dinner: 70 }, Tue: { lunch: 60, dinner: 70 }, Wed: { lunch: 60, dinner: 70 }, Thu: { lunch: 60, dinner: 70 }, Fri: { lunch: 60, dinner: 70 }, Sat: { lunch: 0, dinner: 0 }, Sun: { lunch: 0, dinner: 0 } },
  } as never;
  S.batches = [];
  S.planner = {};
  S.caterings = [];
  S.recipes = [];
  S.guestsNextWeeks = {};
  S.deletedBatches = [];
});

// ── addDishFromV2Recipe (recipe list → "+ Menu" button) ─────────────────────

describe('addDishFromV2Recipe', () => {
  it('produces a batch in the unified shape that passes validateBatch', () => {
    S.recipes = [makeRecipe()] as unknown as typeof S.recipes;
    addDishFromV2Recipe('rec-test-1');

    expect(S.batches).toHaveLength(1);
    assertUnifiedShape(S.batches[0]);
  });

  it('links the batch to the recipe and starts with empty stock', () => {
    S.recipes = [makeRecipe()] as unknown as typeof S.recipes;
    addDishFromV2Recipe('rec-test-1');

    const b = S.batches[0];
    expect(b.recipeId).toBe('rec-test-1');
    expect(b.inventory).toEqual([]);
    expect(b.shipments).toEqual([]);
    // auto + extra allergens fold into `allergens`; extraAllergens stays empty.
    expect(b.allergens).toEqual(expect.arrayContaining(['Celery', 'Gluten']));
  });

  it('is a no-op for an unknown recipe id', () => {
    addDishFromV2Recipe('does-not-exist');
    expect(S.batches).toHaveLength(0);
  });
});

// ── addPlaceholderDish (planner slot → "+ Placeholder") ─────────────────────

describe('addPlaceholderDish', () => {
  it('produces a batch in the unified shape that passes validateBatch', () => {
    (S as Record<string, unknown>)._addModalState = {
      loc: 'west', date: '2026-05-20', meal: 'lunch', typeFilter: 'Soup',
    };
    addPlaceholderDish();

    expect(S.batches).toHaveLength(1);
    assertUnifiedShape(S.batches[0]);
    // The slot it was created from becomes its one service.
    expect(S.batches[0].services).toEqual([
      { loc: 'west', date: '2026-05-20', meal: 'lunch' },
    ]);
  });
});

// ── replaceWithV2Recipe (planner → swap a dish for a recipe) ────────────────

describe('replaceWithV2Recipe', () => {
  it('produces a replacement batch in the unified shape that passes validateBatch', () => {
    const oldBatch: Batch = {
      id: 'old-batch-1', name: 'Old Soup', type: 'Soup', recipeId: null,
      serving: 280, cookDate: null, inventory: [], shipments: [],
      services: [{ loc: 'west', date: '2026-05-21', meal: 'dinner' }],
      allergens: [], extraAllergens: [], note: '', cookNotes: '',
      actualIngredients: null, orderFor: false, stockDeducted: false,
      createdAt: '2026-05-15T00:00:00.000Z',
    };
    S.batches = [oldBatch];
    S.recipes = [makeRecipe()] as unknown as typeof S.recipes;
    (S as Record<string, unknown>)._replaceState = { oldBatchId: 'old-batch-1' };

    replaceWithV2Recipe('rec-test-1');

    const replacement = S.batches.find(b => b.recipeId === 'rec-test-1');
    expect(replacement).toBeDefined();
    assertUnifiedShape(replacement!);
    // The old batch's services carry over to the replacement.
    expect(replacement!.services).toEqual(oldBatch.services);
  });
});
