// Unit tests for location-aware stock lookup functions.
// These test the pure logic of getDbStockForLoc and hasDbStockEntryForLoc
// without importing frontend modules (which rely on browser globals).

type StockEntry = { amount: number; date?: string };
type MockDb = { stock?: Record<string, StockEntry> } | null | undefined;

// ── Implementations under test ────────────────────────────────────────────────
// Mirrors what is in public/js/orders.ts — update both together if logic changes.

function getDbStockForLoc(db: MockDb, loc: string): number {
  if (!db || !db.stock) return 0;
  const entry = db.stock[loc];
  return entry ? (entry.amount || 0) : 0;
}

function hasDbStockEntryForLoc(db: MockDb, loc: string): boolean {
  if (!db || !db.stock) return false;
  return !!(db.stock[loc]?.date);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('getDbStockForLoc', () => {
  const db = {
    stock: {
      west:     { amount: 4, date: '2026-04-20' },
      centraal: { amount: 2, date: '2026-04-18' },
    },
  };

  it('returns west stock when loc=west', () => {
    expect(getDbStockForLoc(db, 'west')).toBe(4);
  });

  it('returns centraal stock when loc=centraal', () => {
    expect(getDbStockForLoc(db, 'centraal')).toBe(2);
  });

  it('returns 0 for unknown location', () => {
    expect(getDbStockForLoc(db, 'testtafel')).toBe(0);
  });

  it('returns 0 when db is null', () => {
    expect(getDbStockForLoc(null, 'west')).toBe(0);
  });

  it('returns 0 when stock is missing', () => {
    expect(getDbStockForLoc({}, 'west')).toBe(0);
  });

  it('returns 0 when amount is missing from entry', () => {
    const dbNoAmt = { stock: { west: {} as StockEntry } };
    expect(getDbStockForLoc(dbNoAmt, 'west')).toBe(0);
  });

  it('does NOT sum both locations', () => {
    // This is the core fix: west=4, centraal=2, should return 4 not 6
    expect(getDbStockForLoc(db, 'west')).not.toBe(6);
  });

  it('one location has stock, other does not', () => {
    const dbWestOnly = { stock: { west: { amount: 3, date: '2026-04-20' } } };
    expect(getDbStockForLoc(dbWestOnly, 'west')).toBe(3);
    expect(getDbStockForLoc(dbWestOnly, 'centraal')).toBe(0);
  });
});

describe('hasDbStockEntryForLoc', () => {
  const db = {
    stock: {
      west:     { amount: 4, date: '2026-04-20' },
      centraal: { amount: 0, date: '2026-04-18' },
    },
  };

  it('returns true when the location has a dated stock entry', () => {
    expect(hasDbStockEntryForLoc(db, 'west')).toBe(true);
    expect(hasDbStockEntryForLoc(db, 'centraal')).toBe(true);
  });

  it('returns false for a location with no stock entry', () => {
    expect(hasDbStockEntryForLoc(db, 'testtafel')).toBe(false);
  });

  it('returns false when entry exists but has no date (not yet counted)', () => {
    const dbUndated = { stock: { west: { amount: 5 } as StockEntry } };
    expect(hasDbStockEntryForLoc(dbUndated, 'west')).toBe(false);
  });

  it('returns false when db is null', () => {
    expect(hasDbStockEntryForLoc(null, 'west')).toBe(false);
  });

  it('does NOT return true because another location was counted', () => {
    // If only west was counted, centraal should not be considered "counted"
    const dbWestOnly = { stock: { west: { amount: 3, date: '2026-04-20' } } };
    expect(hasDbStockEntryForLoc(dbWestOnly, 'centraal')).toBe(false);
  });
});

// ── Event-location keys (all-locations aggregates) ───────────────────────────
// Mirrors getDbStockTotal / hasDbStockEntry in public/js/orders.ts, which sum
// over EVERY stock key so an event location's stocktake counts.

function getDbStockTotal(db: MockDb): number {
  if (!db || !db.stock) return 0;
  let total = 0;
  for (const entry of Object.values(db.stock)) {
    if (entry) total += (entry.amount || 0);
  }
  return total;
}

function hasDbStockEntry(db: MockDb): boolean {
  if (!db || !db.stock) return false;
  return Object.values(db.stock).some(entry => !!entry?.date);
}

describe('all-locations aggregates with event keys', () => {
  const db = {
    stock: {
      west:                  { amount: 4, date: '2026-07-10' },
      centraal:              { amount: 2 },
      'ev-landjuweel-2026':  { amount: 9, date: '2026-07-16' },
    },
  };

  it('getDbStockTotal sums permanent + event keys', () => {
    expect(getDbStockTotal(db)).toBe(15);
  });

  it('per-loc reads work for event keys', () => {
    expect(getDbStockForLoc(db, 'ev-landjuweel-2026')).toBe(9);
    expect(hasDbStockEntryForLoc(db, 'ev-landjuweel-2026')).toBe(true);
  });

  it('hasDbStockEntry counts an event-only stocktake', () => {
    const onlyEvent = { stock: { 'ev-landjuweel-2026': { amount: 0, date: '2026-07-16' } } };
    expect(hasDbStockEntry(onlyEvent)).toBe(true);
    expect(hasDbStockEntry({ stock: { west: { amount: 3 } } })).toBe(false);
  });
});
