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
  getServeableStockAt,
  getServeableTotalStock,
  getPendingFromShipments,
  isBatchAllFrozen,
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

  it('counts pending (non-arrived) shipments toward the total', () => {
    // Food in transit has left the source inventory entry but not yet merged
    // into the destination's — it lives only in shipments[]. The batch total
    // must stay conserved while the food is on the truck.
    const b = makeBatch({
      inventory: [entry({ qty: 30 })],
      shipments: [shipment({ qty: 20, arrived: false })],
    });
    expect(getTotalStock(b)).toBe(50);
  });

  it('excludes arrived shipments — those qtys are already in inventory', () => {
    // On arrival the qty is merged into destination inventory; counting the
    // arrived shipment too would double-count.
    const b = makeBatch({
      inventory: [entry({ loc: 'centraal', qty: 20 })],
      shipments: [shipment({ qty: 20, arrived: true, arrivedAt: '2026-05-01T13:00:00.000Z' })],
    });
    expect(getTotalStock(b)).toBe(20);
  });

  it('sums settled inventory and pending shipments together', () => {
    const b = makeBatch({
      inventory: [
        entry({ loc: 'west', qty: 15 }),
        entry({ loc: 'centraal', qty: 10 }),
      ],
      shipments: [
        shipment({ qty: 8, arrived: false }),
        shipment({ qty: 12, arrived: true, arrivedAt: '2026-05-01T13:00:00.000Z' }),
      ],
    });
    // 15 + 10 settled + 8 pending; the 12 arrived shipment is excluded.
    expect(getTotalStock(b)).toBe(33);
  });

  it('treats a missing shipments array as empty (defensive for legacy rows)', () => {
    const b = makeBatch({ inventory: [entry({ qty: 25 })] });
    (b as unknown as { shipments: null }).shipments = null;
    expect(getTotalStock(b)).toBe(25);
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

// ── getServeableStockAt / getServeableTotalStock ──────────────────────────
//
// Added 2026-05-12 after Daan's localhost smoke surfaced the "frozen counts
// toward auto-allocation" bug. Serveable = non-Frozen. Auto-allocator
// (menu-fixer, transport-card destStock) uses these in place of getStockAt
// when deciding "is this batch's stock available to serve right now?"

describe('getServeableStockAt', () => {
  it('excludes Frozen entries at the loc', () => {
    const b = makeBatch({
      inventory: [
        entry({ loc: 'west', storage: 'Gastro', qty: 40 }),
        entry({ loc: 'west', storage: 'Frozen', qty: 20 }),
        entry({ loc: 'centraal', storage: 'Gastro', qty: 15 }),
        entry({ loc: 'centraal', storage: 'Frozen', qty: 10 }),
      ],
    });
    expect(getServeableStockAt(b, 'west')).toBe(40); // 40 Gastro, 20 Frozen excluded
    expect(getServeableStockAt(b, 'centraal')).toBe(15);
  });

  it('returns 0 when the loc has only Frozen', () => {
    const b = makeBatch({
      inventory: [entry({ loc: 'west', storage: 'Frozen', qty: 50 })],
    });
    expect(getServeableStockAt(b, 'west')).toBe(0);
    // getStockAt should still see the frozen qty — only serveable filters it.
    expect(getStockAt(b, 'west')).toBe(50);
  });

  it('counts Vac-packed as serveable (only Frozen is excluded)', () => {
    const b = makeBatch({
      inventory: [
        entry({ loc: 'west', storage: 'Vac-packed', qty: 12 }),
        entry({ loc: 'west', storage: 'Frozen', qty: 30 }),
      ],
    });
    expect(getServeableStockAt(b, 'west')).toBe(12);
  });

  it('returns 0 for empty inventory', () => {
    expect(getServeableStockAt(makeBatch(), 'west')).toBe(0);
  });
});

describe('getServeableTotalStock', () => {
  it('sums all locations excluding Frozen', () => {
    const b = makeBatch({
      inventory: [
        entry({ loc: 'west', storage: 'Gastro', qty: 40 }),
        entry({ loc: 'west', storage: 'Frozen', qty: 20 }),
        entry({ loc: 'centraal', storage: 'Gastro', qty: 15 }),
        entry({ loc: 'centraal', storage: 'Frozen', qty: 10 }),
      ],
    });
    // 40 (west gastro) + 15 (centraal gastro) = 55. The 30L of frozen is
    // present on the batch but doesn't count for auto-allocation.
    expect(getServeableTotalStock(b)).toBe(55);
    // getTotalStock still sees everything.
    expect(getTotalStock(b)).toBe(85);
  });

  it('returns 0 when all stock is frozen', () => {
    const b = makeBatch({
      inventory: [
        entry({ loc: 'west', storage: 'Frozen', qty: 30 }),
        entry({ loc: 'centraal', storage: 'Frozen', qty: 15 }),
      ],
    });
    expect(getServeableTotalStock(b)).toBe(0);
    expect(getTotalStock(b)).toBe(45);
  });

  it('includes non-arrived non-Frozen shipments', () => {
    const b = makeBatch({
      inventory: [entry({ storage: 'Gastro', qty: 20 })],
      shipments: [shipment({ storage: 'Gastro', qty: 15, arrived: false })],
    });
    expect(getServeableTotalStock(b)).toBe(35);
  });

  it('excludes non-arrived Frozen shipments (Frozen is not serveable)', () => {
    const b = makeBatch({
      inventory: [entry({ storage: 'Gastro', qty: 20 })],
      shipments: [shipment({ storage: 'Frozen', qty: 15, arrived: false })],
    });
    expect(getServeableTotalStock(b)).toBe(20);
    // getTotalStock still sees the in-transit frozen qty.
    expect(getTotalStock(b)).toBe(35);
  });

  it('excludes arrived shipments — already merged into inventory', () => {
    const b = makeBatch({
      inventory: [entry({ loc: 'centraal', storage: 'Gastro', qty: 15 })],
      shipments: [shipment({ storage: 'Gastro', qty: 15, arrived: true, arrivedAt: '2026-05-01T13:00:00.000Z' })],
    });
    expect(getServeableTotalStock(b)).toBe(15);
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

  it('counts 61 calendar days correctly when the window spans Europe spring-forward (DST regression)', () => {
    // Bug caught on Windows verification of b8d526d (host TZ = Europe/Brussels):
    //   today = 2026-05-12; cookDate = 12/03/2026 (61 cal days back, spans
    //   the 29-March spring-forward).
    // Naïve ms-divide:
    //   (May 12 00:00 CEST) − (Mar 12 00:00 CET) = 61·24h − 1h
    //   floor((61·24 − 1) / 24) = 60   ← under by one
    //   60 > 60 = false → REPORTED FRESH (wrong)
    // UTC-anchored calendar-day diff:
    //   Date.UTC(2026,4,12) − Date.UTC(2026,2,12) = 61 days exactly
    //   61 > 60 = true → reported stale (correct)
    //
    // jest.setSystemTime pins "today" regardless of host TZ, so this assertion
    // catches a regression to the naïve math even on UTC CI.
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2026-05-12T12:00:00Z'));
      expect(isStaleEntry(entry({ storage: 'Frozen', cookDate: '12/03/2026' }))).toBe(true);
      // Day 60 across the same DST boundary should still read as fresh —
      // boundary semantics survive the rewrite.
      expect(isStaleEntry(entry({ storage: 'Frozen', cookDate: '13/03/2026' }))).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
});

// ── isBatchAllFrozen ──────────────────────────────────────────────────────
//
// Display-only frozen bucketing for the planner pool + dishes screens. "All
// frozen" means the batch's *remaining* stock is entirely Frozen. A batch with
// no live stock — empty inventory, or only 0-qty marker entries such as an
// emergency placeholder's location pin — is NOT frozen; it belongs in To-cook.

describe('isBatchAllFrozen', () => {
  it('is false for an emergency-placeholder shape (single 0-qty Gastro entry)', () => {
    // createEmergencyPlaceholder pins the cook loc with a {Gastro, qty:0}
    // entry — that marker must NOT make the placeholder read as frozen.
    const b = makeBatch({ inventory: [entry({ storage: 'Gastro', qty: 0 })] });
    expect(isBatchAllFrozen(b)).toBe(false);
  });

  it('is false for empty inventory', () => {
    expect(isBatchAllFrozen(makeBatch({ inventory: [] }))).toBe(false);
  });

  it('is true when all live stock is Frozen', () => {
    const b = makeBatch({ inventory: [entry({ storage: 'Frozen', qty: 50 })] });
    expect(isBatchAllFrozen(b)).toBe(true);
  });

  it('is false when the batch has live Gastro stock', () => {
    const b = makeBatch({ inventory: [entry({ storage: 'Gastro', qty: 80 })] });
    expect(isBatchAllFrozen(b)).toBe(false);
  });

  it('ignores depleted 0-qty non-Frozen entries — still reads as all-frozen', () => {
    const b = makeBatch({
      inventory: [
        entry({ storage: 'Gastro', qty: 0, cookDate: '01/05/2026' }),
        entry({ storage: 'Frozen', qty: 50, cookDate: '03/05/2026' }),
      ],
    });
    expect(isBatchAllFrozen(b)).toBe(true);
  });

  it('is false when live Gastro stock sits alongside Frozen stock', () => {
    const b = makeBatch({
      inventory: [
        entry({ storage: 'Gastro', qty: 30, cookDate: '01/05/2026' }),
        entry({ storage: 'Frozen', qty: 50, cookDate: '03/05/2026' }),
      ],
    });
    expect(isBatchAllFrozen(b)).toBe(false);
  });

  it('treats a missing inventory array as not-frozen (defensive)', () => {
    const b = makeBatch();
    (b as unknown as { inventory: null }).inventory = null;
    expect(isBatchAllFrozen(b)).toBe(false);
  });
});
