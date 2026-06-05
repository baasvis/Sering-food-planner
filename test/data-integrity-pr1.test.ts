/**
 * Regression tests for the data-integrity PR (audit 2026-06-05):
 *
 *  - CORR-2: ingredient stock must not be double-deducted. resolveStockDeduction
 *    is the pure decision helper used by brSave — once a batch's stock has been
 *    deducted it must never deduct again, and the flag must never regress to
 *    false on a later save with the box unticked.
 *
 *  - PERF-1: a debounced planner save must not round-trip a stale inventory[]/
 *    shipments[] over a concurrent /ship|/transfer|/arrived. computePatch omits
 *    those arrays when THEY did not change, and applyRemotePatch preserves the
 *    local copy when an incoming patch omits them.
 *
 * Browser-global stubs come from test/setup-dom-stubs.ts. modal/navigate are
 * mocked because applyRemotePatch → rerenderCurrentView/toast touch DOM the
 * headless stub doesn't fully provide (same pattern as
 * inventory-disappear-investigation.test.ts).
 */
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
  getCurrentScreen: jest.fn(() => 'dashboard'),
  setCurrentScreen: jest.fn(),
  getScreenFromHash: jest.fn(() => 'dashboard'),
  showScreen: jest.fn(),
  setOnScreenChange: jest.fn(),
  setBackgroundRefresh: jest.fn(),
}));

import { S } from '../public/js/state';
import { computePatch, takeSnapshot, applyRemotePatch } from '../public/js/utils';
import { resolveStockDeduction } from '../public/js/recipe-editor';
import type { Batch, DishType, InventoryEntry, Location, StorageType } from '../shared/types';

let _idCounter = 0;
const nextId = () => `di-test-${++_idCounter}`;

function inv(qty: number, loc: Location = 'west', storage: StorageType = 'Gastro', cookDate = '15/05/2026'): InventoryEntry {
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

beforeEach(() => { S.batches = []; });

describe('CORR-2 — resolveStockDeduction (no double-deduct)', () => {
  test('deducts when ticked and not yet deducted', () => {
    expect(resolveStockDeduction(false, true)).toEqual({ willDeduct: true, nextFlag: true });
  });
  test('does NOT deduct again when already deducted, even if re-ticked', () => {
    expect(resolveStockDeduction(true, true)).toEqual({ willDeduct: false, nextFlag: true });
  });
  test('the flag never regresses to false on a save left unticked', () => {
    expect(resolveStockDeduction(true, false)).toEqual({ willDeduct: false, nextFlag: true });
  });
  test('no deduction and flag stays false when never ticked', () => {
    expect(resolveStockDeduction(false, false)).toEqual({ willDeduct: false, nextFlag: false });
  });
});

describe('PERF-1 — computePatch omits unchanged inventory/shipments', () => {
  test('a name-only edit does NOT resend inventory or shipments', () => {
    const b = makeBatch({ inventory: [inv(50)], shipments: [] });
    S.batches = [b];
    takeSnapshot();
    b.name = 'Renamed soup'; // edit an unrelated field
    const patch = computePatch();
    expect(patch.batches).toHaveLength(1);
    const sent = patch.batches![0] as unknown as Record<string, unknown>;
    expect(sent.name).toBe('Renamed soup');
    expect('inventory' in sent).toBe(false);
    expect('shipments' in sent).toBe(false);
  });

  test('a real inventory edit DOES resend inventory', () => {
    const b = makeBatch({ inventory: [inv(50)] });
    S.batches = [b];
    takeSnapshot();
    b.inventory = [inv(30)]; // e.g. the inventory editor adjusting settled stock
    const patch = computePatch();
    const sent = patch.batches![0] as unknown as Record<string, unknown>;
    expect('inventory' in sent).toBe(true);
    expect((sent.inventory as InventoryEntry[])[0].qty).toBe(30);
  });

  test('a brand-new batch is sent in full (inventory included)', () => {
    takeSnapshot(); // snapshot is empty
    const b = makeBatch({ inventory: [inv(10)] });
    S.batches = [b];
    const patch = computePatch();
    const sent = patch.batches![0] as unknown as Record<string, unknown>;
    expect('inventory' in sent).toBe(true);
  });
});

describe('PERF-1 — applyRemotePatch preserves stock when a patch omits it', () => {
  test('an incoming batch without inventory keeps the local inventory', () => {
    const local = makeBatch({ inventory: [inv(50)], shipments: [] });
    S.batches = [local];
    // Simulate a remote name-only patch (inventory omitted, per the computePatch fix)
    const partial: Record<string, unknown> = { ...local };
    delete partial.inventory;
    delete partial.shipments;
    partial.name = 'Remote rename';
    applyRemotePatch({ batches: [partial], user: 'Other' } as unknown as Parameters<typeof applyRemotePatch>[0]);
    const after = S.batches.find(x => x.id === local.id)!;
    expect(after.name).toBe('Remote rename'); // the real change applied
    expect((after.inventory || []).reduce((s, e) => s + e.qty, 0)).toBe(50); // stock preserved
  });

  test('an incoming batch WITH inventory replaces it', () => {
    const local = makeBatch({ inventory: [inv(50)] });
    S.batches = [local];
    const incoming = { ...local, inventory: [inv(9)] };
    applyRemotePatch({ batches: [incoming], user: 'Other' } as unknown as Parameters<typeof applyRemotePatch>[0]);
    const after = S.batches.find(x => x.id === local.id)!;
    expect((after.inventory || []).reduce((s, e) => s + e.qty, 0)).toBe(9);
  });
});
