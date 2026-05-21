/**
 * Regression notes for Finding 3 — "the Do-inventory modal mis-routes a typed
 * quantity under live-sync" (2026-05-16).
 *
 * The modal embeds inventory ARRAY POSITIONS into its row markup
 * (updatePowerEntryQty(id, idx, ...) / updateLocScopedQty(id, ..., idxCsv, ...)).
 * The fix (Finding 3) refreshes the modal whenever a live-sync patch arrives,
 * so the embedded positions are always rebuilt from fresh state.
 *
 * These tests document WHY that refresh is necessary: updatePowerEntryQty
 * itself trusts the index it is handed, so a stale index still writes to the
 * wrong entry. With the modal-refresh fix in place, a stale index can no
 * longer reach this function during normal use.
 *
 * Kept in its own file because planner.ts is a heavy screen module; an import
 * failure here must not take down the main investigation suite.
 */

// planner.ts pulls in DOM-only modules; mock them so the import graph loads.
jest.mock('../public/js/modal', () => ({
  __esModule: true,
  showModal: jest.fn(),
  closeModal: jest.fn(),
  esc: (s: unknown) => (s == null ? '' : String(s)),
  setOpenInventoryFn: jest.fn(),
}));
jest.mock('../public/js/navigate', () => ({
  __esModule: true,
  registerRenderer: jest.fn(),
  rerenderCurrentView: jest.fn(),
  getCurrentScreen: jest.fn(() => 'planner'),
  setCurrentScreen: jest.fn(),
  getScreenFromHash: jest.fn(() => 'planner'),
  showScreen: jest.fn(),
  setOnScreenChange: jest.fn(),
  setBackgroundRefresh: jest.fn(),
}));

import { S } from '../public/js/state';
import { updatePowerEntryQty } from '../public/js/planner';
import type { Batch, DishType, InventoryEntry, Location, StorageType } from '../shared/types';

let _idCounter = 0;
const nextId = () => `stale-test-${++_idCounter}`;

function inv(qty: number, loc: Location, storage: StorageType, cookDate: string): InventoryEntry {
  return { loc, storage, qty, cookDate };
}

function makeBatch(overrides: Partial<Batch> = {}): Batch {
  return {
    id: nextId(), name: 'Test soup', type: 'Soup' as DishType, serving: 280,
    cookDate: '15/05/2026', inventory: [], shipments: [], allergens: [],
    extraAllergens: [], orderFor: false, note: '', services: [],
    createdAt: '2026-05-15T00:00:00.000Z', recipeId: null, actualIngredients: null,
    cookNotes: '', stockDeducted: false, generated: false, ...overrides,
  };
}

beforeAll(() => { jest.useFakeTimers(); });
afterAll(() => { jest.useRealTimers(); });
beforeEach(() => { S.batches = []; });

describe('Finding 3 — why the modal must refresh on live-sync (updatePowerEntryQty)', () => {
  test('a stale row index writes the typed quantity to the WRONG inventory entry', () => {
    const gastro = inv(10, 'west', 'Gastro', '10/05/2026');
    const frozen = inv(5, 'west', 'Frozen', '12/05/2026');
    const batch = makeBatch({ inventory: [gastro, frozen] });
    S.batches = [batch];

    // The modal rendered with Gastro at index 0, Frozen at index 1.
    // A live-sync patch then replaces b.inventory with a reordered array:
    batch.inventory = [frozen, gastro]; // Frozen now index 0, Gastro now index 1

    // The cook edits the Gastro row — its stale captured index is still 0:
    updatePowerEntryQty(batch.id, 0, '2', 'west');

    // Index 0 is now the Frozen entry, so the cook's "2" landed on the wrong one.
    expect(batch.inventory[0].storage).toBe('Frozen');
    expect(batch.inventory[0].qty).toBe(2);  // Frozen wrongly changed
    expect(batch.inventory[1].qty).toBe(10); // Gastro untouched — the edit missed its target
  });

  test('a stale row index is silently dropped when it no longer exists', () => {
    const gastro = inv(10, 'west', 'Gastro', '10/05/2026');
    const frozen = inv(5, 'west', 'Frozen', '12/05/2026');
    const batch = makeBatch({ inventory: [gastro, frozen] });
    S.batches = [batch];

    // Live-sync patch shrinks the array (e.g. another cook shipped the Gastro out):
    batch.inventory = [frozen]; // length 1 — index 1 no longer exists

    // The cook edits what they saw as the Frozen row at stale index 1:
    updatePowerEntryQty(batch.id, 1, '2', 'west');

    // Out-of-range index → the edit is silently dropped, Frozen still 5.
    expect(batch.inventory[0].qty).toBe(5);
  });
});

describe('Finding 1c — a quantity that rounds down to 0 is rejected', () => {
  test('updatePowerEntryQty rejects 0.04 — it would round to 0, so use "Served" instead', () => {
    const batch = makeBatch({ inventory: [inv(5, 'west', 'Gastro', '12/05/2026')] });
    S.batches = [batch];

    updatePowerEntryQty(batch.id, 0, '0.04', 'west');

    // 0.04 rounds to 0 — rejected, the entry keeps its 5 L (no zeroing-by-the-back-door).
    expect(batch.inventory[0].qty).toBe(5);
  });
});
