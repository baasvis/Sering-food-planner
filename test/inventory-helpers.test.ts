/**
 * Unit tests for the unified-batch inventory helpers (Checkpoint 5.4 — playbook §17).
 *
 * Locked decisions exercised here:
 *   §15  Stock shape: full inventory list `[{loc, storage, qty, cookDate}]`
 *   §22  Stale-food: per-entry cookDate; freezing resets
 *   §31  Zero-qty entries kept (no auto-prune)
 *   §37  Shelf life: Gastro 3, Frozen 60, Vac-packed 10
 *   §38  Arrival merge: same (loc, storage, cookDate) merges
 *
 * These helpers also mirror the server-side mergeIntoInventory invariant in
 * routes/batches.ts — bugs that violate the merge key here would corrupt
 * /ship, /transfer, /shipments/:id/arrived, /shipments/:id/cancel.
 */

import type { Batch, InventoryEntry, Shipment } from '../shared/types';
import {
  getTotalStock,
  getStockAt,
  getPendingFromShipments,
  consolidateInventory,
  addInventory,
  removeInventory,
  isStaleEntry,
  dateToStr,
  getToday,
} from '../public/js/core';

// ── helpers ────────────────────────────────────────────────────────────────

function entry(overrides: Partial<InventoryEntry> = {}): InventoryEntry {
  return {
    loc: 'west',
    storage: 'Gastro',
    qty: 10,
    cookDate: '01/05/2026',
    ...overrides,
  };
}

function shipment(overrides: Partial<Shipment> = {}): Shipment {
  return {
    id: 'sh-' + Math.random().toString(36).slice(2, 8),
    fromLoc: 'west',
    toLoc: 'centraal',
    storage: 'Gastro',
    qty: 10,
    sentAt: '2026-05-01T08:00:00.000Z',
    arrived: false,
    cookDate: '01/05/2026',
    ...overrides,
  };
}

function makeBatch(overrides: Partial<Batch> = {}): Batch {
  return {
    id: 'b-' + Math.random().toString(36).slice(2, 8),
    name: 'Tomato Soup',
    type: 'Soup',
    recipeId: null,
    serving: 280,
    cookDate: '01/05/2026',
    inventory: [],
    shipments: [],
    services: [],
    allergens: [],
    extraAllergens: [],
    note: '',
    cookNotes: '',
    actualIngredients: null,
    orderFor: false,
    stockDeducted: false,
    createdAt: '2026-05-01T08:00:00.000Z',
    ...overrides,
  };
}

// Build a DD/MM/YYYY string for `daysAgo` days before today (test-stable).
function daysAgoStr(daysAgo: number): string {
  const d = getToday();
  d.setDate(d.getDate() - daysAgo);
  return dateToStr(d);
}

// ── getTotalStock ─────────────────────────────────────────────────────────

describe('getTotalStock', () => {
  it('sums all inventory entries regardless of loc/storage', () => {
    const b = makeBatch({
      inventory: [
        entry({ loc: 'west', qty: 30 }),
        entry({ loc: 'centraal', qty: 20 }),
        entry({ loc: 'west', storage: 'Frozen', qty: 15 }),
      ],
    });
    expect(getTotalStock(b)).toBe(65);
  });

  it('returns 0 for an empty batch', () => {
    expect(getTotalStock(makeBatch())).toBe(0);
  });

  it('treats missing inventory array as empty (defensive for legacy rows)', () => {
    // Migrations should always populate inventory[], but JSON columns can be
    // null in flight — we don't want a crash on a legacy snapshot.
    const b = makeBatch();
    (b as unknown as { inventory: null }).inventory = null;
    expect(getTotalStock(b)).toBe(0);
  });

  it('counts zero-qty entries as 0 (not skipped, not error)', () => {
    // Locked §31: zero-qty entries are kept; the cook prunes manually.
    const b = makeBatch({
      inventory: [entry({ qty: 0 }), entry({ qty: 5 })],
    });
    expect(getTotalStock(b)).toBe(5);
  });
});

// ── getStockAt ────────────────────────────────────────────────────────────

describe('getStockAt', () => {
  it('filters by loc only when storage is omitted', () => {
    const b = makeBatch({
      inventory: [
        entry({ loc: 'west', storage: 'Gastro', qty: 30 }),
        entry({ loc: 'west', storage: 'Frozen', qty: 10 }),
        entry({ loc: 'centraal', storage: 'Gastro', qty: 25 }),
      ],
    });
    expect(getStockAt(b, 'west')).toBe(40);
    expect(getStockAt(b, 'centraal')).toBe(25);
  });

  it('filters by both loc and storage when storage is given', () => {
    const b = makeBatch({
      inventory: [
        entry({ loc: 'west', storage: 'Gastro', qty: 30 }),
        entry({ loc: 'west', storage: 'Frozen', qty: 10 }),
        entry({ loc: 'centraal', storage: 'Gastro', qty: 25 }),
      ],
    });
    expect(getStockAt(b, 'west', 'Gastro')).toBe(30);
    expect(getStockAt(b, 'west', 'Frozen')).toBe(10);
    expect(getStockAt(b, 'west', 'Vac-packed')).toBe(0);
    expect(getStockAt(b, 'centraal', 'Frozen')).toBe(0);
  });

  it('returns 0 for empty inventory', () => {
    expect(getStockAt(makeBatch(), 'west')).toBe(0);
  });
});

// ── getPendingFromShipments ───────────────────────────────────────────────

describe('getPendingFromShipments', () => {
  it('sums pending shipments destined for the loc', () => {
    const b = makeBatch({
      shipments: [
        shipment({ toLoc: 'centraal', qty: 20, arrived: false }),
        shipment({ toLoc: 'centraal', qty: 5, arrived: false }),
        shipment({ toLoc: 'west', qty: 7, arrived: false }),
      ],
    });
    expect(getPendingFromShipments(b, 'centraal')).toBe(25);
    expect(getPendingFromShipments(b, 'west')).toBe(7);
  });

  it('skips arrived shipments — those qtys are already in inventory', () => {
    const b = makeBatch({
      shipments: [
        shipment({ toLoc: 'centraal', qty: 20, arrived: true, arrivedAt: '2026-05-01T13:00:00.000Z' }),
        shipment({ toLoc: 'centraal', qty: 5, arrived: false }),
      ],
    });
    expect(getPendingFromShipments(b, 'centraal')).toBe(5);
  });

  it('returns 0 with no shipments', () => {
    expect(getPendingFromShipments(makeBatch(), 'centraal')).toBe(0);
  });
});

// ── consolidateInventory ──────────────────────────────────────────────────

describe('consolidateInventory', () => {
  it('merges entries with the same (loc, storage, cookDate)', () => {
    const b = makeBatch({
      inventory: [
        entry({ loc: 'west', storage: 'Gastro', qty: 10, cookDate: '01/05/2026' }),
        entry({ loc: 'west', storage: 'Gastro', qty: 25, cookDate: '01/05/2026' }),
      ],
    });
    consolidateInventory(b);
    expect(b.inventory).toHaveLength(1);
    expect(b.inventory[0].qty).toBe(35);
  });

  it('keeps entries separate when cookDate differs', () => {
    // Two cookDates of the same Gastro stock at West sit as two entries until
    // a /transfer or arrival merges them — preserves freshness lineage.
    const b = makeBatch({
      inventory: [
        entry({ cookDate: '01/05/2026', qty: 10 }),
        entry({ cookDate: '03/05/2026', qty: 8 }),
      ],
    });
    consolidateInventory(b);
    expect(b.inventory).toHaveLength(2);
  });

  it('keeps entries separate when storage differs', () => {
    const b = makeBatch({
      inventory: [
        entry({ storage: 'Gastro', qty: 10 }),
        entry({ storage: 'Frozen', qty: 8 }),
      ],
    });
    consolidateInventory(b);
    expect(b.inventory).toHaveLength(2);
  });

  it('keeps entries separate when loc differs', () => {
    const b = makeBatch({
      inventory: [
        entry({ loc: 'west', qty: 10 }),
        entry({ loc: 'centraal', qty: 8 }),
      ],
    });
    consolidateInventory(b);
    expect(b.inventory).toHaveLength(2);
  });

  it('handles no-op (single entry) without mutation surprises', () => {
    const b = makeBatch({ inventory: [entry({ qty: 10 })] });
    consolidateInventory(b);
    expect(b.inventory).toHaveLength(1);
    expect(b.inventory[0].qty).toBe(10);
  });

  it('does not auto-prune zero-qty entries (locked §31)', () => {
    // Two entries with different cookDates so they DON'T merge; the
    // zero-qty one must survive — the cook prunes via Edit modal.
    const b = makeBatch({
      inventory: [
        entry({ qty: 0, cookDate: '01/05/2026' }),
        entry({ qty: 5, cookDate: '03/05/2026' }),
      ],
    });
    consolidateInventory(b);
    expect(b.inventory).toHaveLength(2);
  });
});

// ── addInventory ──────────────────────────────────────────────────────────

describe('addInventory', () => {
  it('appends a fresh entry when no merge key matches', () => {
    const b = makeBatch({ inventory: [entry({ loc: 'west', qty: 10 })] });
    addInventory(b, entry({ loc: 'centraal', qty: 5 }));
    expect(b.inventory).toHaveLength(2);
    expect(getStockAt(b, 'centraal')).toBe(5);
  });

  it('merges into an existing entry on (loc, storage, cookDate) match', () => {
    const b = makeBatch({ inventory: [entry({ qty: 10 })] });
    addInventory(b, entry({ qty: 5 }));
    expect(b.inventory).toHaveLength(1);
    expect(b.inventory[0].qty).toBe(15);
  });

  it('initialises inventory[] when missing (defensive)', () => {
    const b = makeBatch();
    (b as unknown as { inventory: undefined }).inventory = undefined;
    addInventory(b, entry({ qty: 7 }));
    expect(b.inventory).toHaveLength(1);
    expect(b.inventory[0].qty).toBe(7);
  });
});

// ── removeInventory ──────────────────────────────────────────────────────

describe('removeInventory', () => {
  it('removes the entry at the given index', () => {
    const b = makeBatch({
      inventory: [
        entry({ loc: 'west', qty: 10 }),
        entry({ loc: 'centraal', qty: 5 }),
      ],
    });
    removeInventory(b, 0);
    expect(b.inventory).toHaveLength(1);
    expect(b.inventory[0].loc).toBe('centraal');
  });

  it('is a no-op for out-of-range index', () => {
    const b = makeBatch({ inventory: [entry({ qty: 10 })] });
    removeInventory(b, 5);
    removeInventory(b, -1);
    expect(b.inventory).toHaveLength(1);
  });

  it('is a no-op when inventory is missing', () => {
    const b = makeBatch();
    (b as unknown as { inventory: null }).inventory = null;
    removeInventory(b, 0);
    expect(b.inventory).toBeNull();
  });
});

// ── isStaleEntry ──────────────────────────────────────────────────────────
//
// Per-storage shelf life (locked §37):
//   Gastro 3 days, Frozen 60 days, Vac-packed 10 days.
// Boundary semantics: `daysOld > limit` (strictly past the limit is stale,
// exactly-at the limit is fresh — gives the cook one full final day).

describe('isStaleEntry', () => {
  it('Gastro: fresh through day 3, stale on day 4', () => {
    expect(isStaleEntry(entry({ storage: 'Gastro', cookDate: daysAgoStr(0) }))).toBe(false);
    expect(isStaleEntry(entry({ storage: 'Gastro', cookDate: daysAgoStr(3) }))).toBe(false);
    expect(isStaleEntry(entry({ storage: 'Gastro', cookDate: daysAgoStr(4) }))).toBe(true);
  });

  it('Frozen: still fresh at 30 days; stale past 60', () => {
    expect(isStaleEntry(entry({ storage: 'Frozen', cookDate: daysAgoStr(30) }))).toBe(false);
    expect(isStaleEntry(entry({ storage: 'Frozen', cookDate: daysAgoStr(60) }))).toBe(false);
    expect(isStaleEntry(entry({ storage: 'Frozen', cookDate: daysAgoStr(61) }))).toBe(true);
  });

  it('Vac-packed: fresh through day 10, stale on day 11', () => {
    expect(isStaleEntry(entry({ storage: 'Vac-packed', cookDate: daysAgoStr(10) }))).toBe(false);
    expect(isStaleEntry(entry({ storage: 'Vac-packed', cookDate: daysAgoStr(11) }))).toBe(true);
  });

  it('treats unparseable cookDate as fresh — false-alarms erode trust (core.ts comment)', () => {
    expect(isStaleEntry(entry({ cookDate: '' }))).toBe(false);
    expect(isStaleEntry(entry({ cookDate: 'not-a-date' }))).toBe(false);
  });
});
