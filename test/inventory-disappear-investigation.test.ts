/**
 * Regression tests for the "batches disappear after Do inventory" fixes
 * (2026-05-16). These started as characterization tests from the investigation
 * (reports/issues/2026-05-16-batches-disappear-after-inventory.md); the
 * assertions were flipped to the fixed behaviour once the fixes were approved.
 *
 * Covered: Finding 1 (the "Served" button + its new undo), Finding 2 (the
 * in-flight-save race), Finding 4 (Fix-my-menu retirement).
 *
 * Browser-global stubs (document, localStorage, ...) come from
 * test/setup-dom-stubs.ts in the jest setupFiles list.
 */

// modal.ts and the screen renderers write into DOM elements the headless test
// stub does not provide. archiveDish() calls closeModal() + rerenderCurrentView();
// both are pure presentation. Mock them so the batch logic under test (does the
// batch survive in S.batches?) runs unhindered.
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
import { archiveDish } from '../public/js/core';
import { computePatch, takeSnapshot, doSave } from '../public/js/utils';
import { executeUndo, flushUndo } from '../public/js/undo';
import { findSpentBatches } from '../public/js/menu-fixer';
import type { Batch, DishType, InventoryEntry, Location, Service, StorageType } from '../shared/types';

let _idCounter = 0;
const nextId = () => `inv-test-${++_idCounter}`;

function inv(qty: number, loc: Location = 'west', storage: StorageType = 'Gastro', cookDate = '15/05/2026'): InventoryEntry {
  return { loc, storage, qty, cookDate };
}

function makeBatch(overrides: Partial<Batch> = {}): Batch {
  return {
    id: nextId(),
    name: 'Test soup',
    type: 'Soup' as DishType,
    serving: 280,
    cookDate: '15/05/2026',
    inventory: [],
    shipments: [],
    allergens: [],
    extraAllergens: [],
    orderFor: false,
    note: '',
    services: [],
    createdAt: '2026-05-15T00:00:00.000Z',
    recipeId: null,
    actualIngredients: null,
    cookNotes: '',
    stockDeducted: false,
    generated: false,
    ...overrides,
  };
}

beforeEach(() => {
  S.batches = [];
  S.archive = [];
});
afterEach(() => {
  flushUndo(); // never let a pending undo leak into the next test
});

// ─────────────────────────────────────────────────────────────────────────────
// Finding 1 — the red "Served" button in the Do-inventory modal.
//
// Flow: openServedFromInventory (planner.ts) → openServedDialogForLoc (core.ts)
// → archiveDish(id, withRating, locScope). archiveDish zeroes the stock at the
// cook's location and archives the whole batch when no stock is left anywhere.
// The fix added a 5-second undo (pushUndo) — archiving is no longer permanent.
// ─────────────────────────────────────────────────────────────────────────────
describe('Finding 1 — "Served" in the Do-inventory modal (archiveDish)', () => {
  beforeAll(() => { jest.useFakeTimers(); jest.setSystemTime(new Date('2026-05-16T10:00:00Z')); });
  afterAll(() => { jest.useRealTimers(); });

  test('"Served" on a batch stocked only at the cook\'s location archives the whole batch', () => {
    const batch = makeBatch({ inventory: [inv(5, 'west')] }); // 5 L still at West
    S.batches = [batch];

    archiveDish(batch.id, false, 'west'); // cook presses "Served" while doing West inventory

    expect(S.batches.find(b => b.id === batch.id)).toBeUndefined(); // removed from the planner
    expect(S.archive.find(a => a.id === batch.id)).toBeDefined();   // moved to archive
  });

  test('the "Served" archive can be undone — executeUndo restores the batch and its stock', () => {
    const batch = makeBatch({ inventory: [inv(5, 'west')] });
    S.batches = [batch];

    archiveDish(batch.id, false, 'west');
    expect(S.batches.find(b => b.id === batch.id)).toBeUndefined(); // archived

    executeUndo(); // cook clicks "Undo" on the toast within 5 s

    const restored = S.batches.find(b => b.id === batch.id);
    expect(restored).toBeDefined();
    // The undo restores the batch AND the 5 L it had — a full reversal.
    expect((restored!.inventory || []).reduce((s, e) => s + (e.qty || 0), 0)).toBe(5);
  });

  test('"Served" still archives a batch that has a future service (left silent, by decision)', () => {
    const futureService: Service = { loc: 'west', date: '2026-05-20', meal: 'lunch' };
    const batch = makeBatch({ inventory: [inv(5, 'west')], services: [futureService] });
    S.batches = [batch];

    archiveDish(batch.id, false, 'west');

    expect(S.batches.find(b => b.id === batch.id)).toBeUndefined();
  });

  test('"Served" keeps the batch when stock remains at the OTHER location', () => {
    const batch = makeBatch({ inventory: [inv(5, 'west'), inv(8, 'centraal')] });
    S.batches = [batch];

    archiveDish(batch.id, false, 'west');

    const still = S.batches.find(b => b.id === batch.id);
    expect(still).toBeDefined();
    expect(still!.inventory.find(e => e.loc === 'west')!.qty).toBe(0);    // West zeroed
    expect(still!.inventory.find(e => e.loc === 'centraal')!.qty).toBe(8); // Centraal untouched
  });

  test('"Served" keeps the batch while a shipment is still in transit', () => {
    const batch = makeBatch({
      inventory: [inv(5, 'west')],
      shipments: [{
        id: 'sh-1', fromLoc: 'west', toLoc: 'centraal', storage: 'Gastro',
        qty: 3, sentAt: '2026-05-16T08:00:00Z', arrived: false, cookDate: '15/05/2026',
      }],
    });
    S.batches = [batch];

    archiveDish(batch.id, false, 'west');

    expect(S.batches.find(b => b.id === batch.id)).toBeDefined(); // in-transit guard holds
  });

  test('two cooks, one per location — the second "Served" archives the batch', () => {
    const batch = makeBatch({ inventory: [inv(5, 'west'), inv(8, 'centraal')] });
    S.batches = [batch];

    archiveDish(batch.id, false, 'west');     // cook A finishes West — batch survives
    expect(S.batches.find(b => b.id === batch.id)).toBeDefined();

    archiveDish(batch.id, false, 'centraal'); // cook B finishes Centraal — batch archived
    expect(S.batches.find(b => b.id === batch.id)).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Finding 2 — edits made while a save is in flight.
//
// doSave() (utils.ts) now snapshots exactly what it SENT (before the await),
// instead of rebuilding the snapshot from live state afterwards. An edit typed
// during the in-flight save therefore stays dirty and is sent on the next save.
// ─────────────────────────────────────────────────────────────────────────────
describe('Finding 2 — edits / new batches made during an in-flight save', () => {
  const realFetch = global.fetch;
  afterEach(() => { (global as typeof globalThis & { fetch: unknown }).fetch = realFetch; });

  test('an edit typed while a save is in flight survives and is sent on the next save', async () => {
    const batch = makeBatch({ inventory: [inv(10, 'west')] });
    S.batches = [batch];
    takeSnapshot(); // baseline: qty 10

    batch.inventory[0].qty = 7; // first edit — this is what the save carries

    let resolveFetch!: (v: unknown) => void;
    (global as typeof globalThis & { fetch: unknown }).fetch =
      jest.fn(() => new Promise(res => { resolveFetch = res; }));

    const saving = doSave(); // computePatch() captures qty 7, POSTs, then awaits

    batch.inventory[0].qty = 3; // SECOND edit — typed during the in-flight save

    resolveFetch({ ok: true, status: 200, json: async () => ({}) });
    await saving; // the snapshot now records only what was sent (qty 7)

    const patch = computePatch();
    const stillPending = patch.batches.find(b => b.id === batch.id);
    expect(stillPending).toBeDefined();                // the mid-save edit was NOT swallowed
    expect(stillPending!.inventory[0].qty).toBe(3);    // and it carries the qty-3 value
  });

  test('a batch created while a save is in flight survives and is sent on the next save', async () => {
    const existing = makeBatch({ inventory: [inv(10, 'west')] });
    S.batches = [existing];
    takeSnapshot();
    existing.inventory[0].qty = 8; // a change to trigger the save

    let resolveFetch!: (v: unknown) => void;
    (global as typeof globalThis & { fetch: unknown }).fetch =
      jest.fn(() => new Promise(res => { resolveFetch = res; }));

    const saving = doSave();

    const created = makeBatch({ name: 'Created mid-save', inventory: [inv(4, 'west')] });
    S.batches.push(created); // a brand-new batch, born during the in-flight save

    resolveFetch({ ok: true, status: 200, json: async () => ({}) });
    await saving;

    const patch = computePatch();
    // The new batch is in the next patch — it will be persisted, not lost.
    expect(patch.batches.find(b => b.id === created.id)).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Finding 4 — "Fix my menu" auto-retirement (findSpentBatches).
//
// findSpentBatches now uses isServiceDatePast — a date-only check. A batch
// scheduled for today is never auto-retired, so running Fix-my-menu right after
// inventory can no longer delete a today batch. It still retires zero-stock
// batches whose service dates are genuinely past; it never touches a batch that
// still has food.
// ─────────────────────────────────────────────────────────────────────────────
describe('Finding 4 — "Fix my menu" retirement (findSpentBatches)', () => {
  beforeAll(() => { jest.useFakeTimers(); jest.setSystemTime(new Date('2026-05-16T12:00:00Z')); });
  afterAll(() => { jest.useRealTimers(); });
  afterEach(() => {
    S.inventoryDone = { west: { lunch: null, dinner: null }, centraal: { lunch: null, dinner: null } };
  });

  test('a batch scheduled for TODAY is not retired — even after inventory is marked done (the fix)', () => {
    // The original trigger: marking inventory done flips isServicePast an hour
    // early. findSpentBatches now uses isServiceDatePast, which ignores that.
    S.inventoryDone = {
      west: { lunch: '2026-05-16', dinner: null }, // today, matching the app's todayStr (dateToIso)
      centraal: { lunch: null, dinner: null },
    };
    const todayBatch = makeBatch({
      type: 'Soup', inventory: [], shipments: [],
      services: [{ loc: 'west', date: '2026-05-16', meal: 'lunch' }], // today
    });

    expect(findSpentBatches([todayBatch])).toHaveLength(0);
  });

  test('a zero-stock batch whose service date is genuinely past is still retired', () => {
    const pastBatch = makeBatch({
      type: 'Soup', inventory: [], shipments: [],
      services: [{ loc: 'west', date: '2026-05-12', meal: 'lunch' }], // past date
    });
    expect(findSpentBatches([pastBatch]).map(b => b.id)).toEqual([pastBatch.id]);
  });

  test('a batch that still has food is never retired', () => {
    const leftover = makeBatch({
      type: 'Soup',
      inventory: [inv(4, 'west', 'Gastro', '12/05/2026')],
      services: [{ loc: 'west', date: '2026-05-12', meal: 'lunch' }],
    });
    expect(findSpentBatches([leftover])).toHaveLength(0);
  });
});
