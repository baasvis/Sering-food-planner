import {
  computeSupplyDemand,
  supplyPricePerGuest,
  cateringDateToIso,
  dayName,
  isoToDate,
  dateToIso,
} from '../shared/supply-demand';
import type { Supply, GuestsData, Catering } from '../shared/types';

function makeGuests(overrides: Partial<Record<string, Partial<Record<string, { lunch: number; dinner: number }>>>> = {}): GuestsData {
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const base: GuestsData = { west: {}, centraal: {} };
  for (const d of days) {
    base.west[d]     = { lunch: d === 'Sat' || d === 'Sun' ? 0 : 100, dinner: d === 'Sat' || d === 'Sun' ? 0 : 110 };
    base.centraal[d] = { lunch: d === 'Sat' || d === 'Sun' ? 0 : 80,  dinner: d === 'Sat' || d === 'Sun' ? 0 : 85  };
  }
  for (const [loc, days] of Object.entries(overrides)) {
    if (!days) continue;
    for (const [d, g] of Object.entries(days)) {
      if (g) base[loc][d] = { lunch: g.lunch, dinner: g.dinner };
    }
  }
  return base;
}

function makeStandardSupply(overrides: Partial<Supply> = {}): Supply {
  return {
    id: 'sup-aioli',
    name: 'Aioli',
    kind: 'standard',
    unit: 'boxes',
    recipeId: null,
    guestsPerUnit: 10,
    prepHorizonDays: 4,
    prepMode: 'centralized',
    oneoffLocation: null,
    unitsPerService: null,
    oneoffStartDate: null,
    stock: {},
    costPerUnit: null,
    preservationMethod: null,
    archived: false,
    ...overrides,
  };
}

function makeOneoffSupply(overrides: Partial<Supply> = {}): Supply {
  return {
    id: 'sup-chimichurri',
    name: 'Chimichurri',
    kind: 'oneoff',
    unit: 'jars',
    recipeId: null,
    guestsPerUnit: null,
    prepHorizonDays: null,
    prepMode: null,
    oneoffLocation: 'west',
    unitsPerService: 2,
    oneoffStartDate: '2026-05-11',
    stock: { west: { amount: 6, lastMakeDate: '2026-05-10' } },
    costPerUnit: null,
    preservationMethod: null,
    archived: false,
    ...overrides,
  };
}

// ── helpers ──

describe('cateringDateToIso', () => {
  it('converts DD/MM/YYYY → YYYY-MM-DD', () => {
    expect(cateringDateToIso('11/05/2026')).toBe('2026-05-11');
  });
  it('returns null for invalid input', () => {
    expect(cateringDateToIso('')).toBeNull();
    expect(cateringDateToIso(null)).toBeNull();
    expect(cateringDateToIso('2026-05-11')).toBeNull();
    expect(cateringDateToIso('11-05-2026')).toBeNull();
  });
});

describe('isoToDate / dateToIso / dayName', () => {
  it('round-trips ISO without UTC drift', () => {
    expect(dateToIso(isoToDate('2026-05-11'))).toBe('2026-05-11');
  });
  it('dayName returns the correct day-of-week', () => {
    expect(dayName(isoToDate('2026-05-11'))).toBe('Mon'); // 2026-05-11 is a Monday
    expect(dayName(isoToDate('2026-05-15'))).toBe('Fri');
    expect(dayName(isoToDate('2026-05-16'))).toBe('Sat');
  });
});

// ── computeSupplyDemand: standard supplies ──

describe('computeSupplyDemand (standard, centralized)', () => {
  it('sums guests ÷ guestsPerUnit over horizon, collapses both locations to west', () => {
    const supply = makeStandardSupply({ guestsPerUnit: 10, prepHorizonDays: 1 });
    const guests = makeGuests();
    const today = '2026-05-11'; // Monday
    const demand = computeSupplyDemand(supply, guests, [], today);
    // West Mon: (100+110) ÷ 10 = 21; Centraal Mon: (80+85) ÷ 10 = 16.5
    // Centralized → all to west
    expect(demand.west).toBeCloseTo(37.5);
    expect(demand.centraal).toBe(0);
  });

  it('sums across the prep horizon', () => {
    const supply = makeStandardSupply({ guestsPerUnit: 10, prepHorizonDays: 4 });
    const guests = makeGuests();
    // Mon-Thu all weekdays: each day west 21 + centraal 16.5 = 37.5
    const demand = computeSupplyDemand(supply, guests, [], '2026-05-11');
    expect(demand.west).toBeCloseTo(37.5 * 4);
    expect(demand.centraal).toBe(0);
  });

  it('skips zero-guest weekend days', () => {
    const supply = makeStandardSupply({ guestsPerUnit: 10, prepHorizonDays: 2 });
    const guests = makeGuests();
    // Sat-Sun all zero
    const demand = computeSupplyDemand(supply, guests, [], '2026-05-16');
    expect(demand.west).toBe(0);
    expect(demand.centraal).toBe(0);
  });

  it('rolls catering toppings into west demand on the catering date', () => {
    const supply = makeStandardSupply({ guestsPerUnit: 10, prepHorizonDays: 4 });
    const guests = makeGuests();
    const caterings: Catering[] = [{
      id: 'cat-1', name: 'Wedding', date: '13/05/2026', guestCount: 80,
      deliveryMode: 'delivery', dishes: [],
      toppings: [{ supplyId: supply.id, amount: 8 }],
      logisticsNotes: '',
    }];
    const baseline = computeSupplyDemand(supply, guests, [], '2026-05-11').west;
    const withCatering = computeSupplyDemand(supply, guests, caterings, '2026-05-11').west;
    expect(withCatering - baseline).toBeCloseTo(8);
  });

  it('ignores caterings outside the horizon window', () => {
    const supply = makeStandardSupply({ guestsPerUnit: 10, prepHorizonDays: 1 });
    const guests = makeGuests();
    const caterings: Catering[] = [{
      id: 'cat-1', name: 'Wedding', date: '15/05/2026', guestCount: 80,
      deliveryMode: 'delivery', dishes: [],
      toppings: [{ supplyId: supply.id, amount: 8 }],
      logisticsNotes: '',
    }];
    // Today is Mon, horizon=1, so only Mon counted; Fri catering excluded
    const demand = computeSupplyDemand(supply, guests, caterings, '2026-05-11');
    expect(demand.west).toBeCloseTo(37.5); // standard demand only
  });

  it('ignores caterings whose toppings reference a different supply', () => {
    const supply = makeStandardSupply({ id: 'sup-aioli', guestsPerUnit: 10, prepHorizonDays: 1 });
    const guests = makeGuests();
    const caterings: Catering[] = [{
      id: 'cat-1', name: 'Wedding', date: '11/05/2026', guestCount: 80,
      deliveryMode: 'delivery', dishes: [],
      toppings: [{ supplyId: 'sup-other', amount: 8 }],
      logisticsNotes: '',
    }];
    const demand = computeSupplyDemand(supply, guests, caterings, '2026-05-11');
    expect(demand.west).toBeCloseTo(37.5);
  });
});

describe('computeSupplyDemand (standard, per-location)', () => {
  it('keeps west and centraal demand separate', () => {
    const supply = makeStandardSupply({ prepMode: 'per-location', guestsPerUnit: 10, prepHorizonDays: 1 });
    const guests = makeGuests();
    const demand = computeSupplyDemand(supply, guests, [], '2026-05-11');
    // West Mon: (100+110) ÷ 10 = 21
    // Centraal Mon: (80+85) ÷ 10 = 16.5
    expect(demand.west).toBeCloseTo(21);
    expect(demand.centraal).toBeCloseTo(16.5);
  });
});

describe('computeSupplyDemand: edge cases', () => {
  it('returns zero for one-off supplies', () => {
    const supply = makeOneoffSupply();
    const guests = makeGuests();
    const demand = computeSupplyDemand(supply, guests, [], '2026-05-11');
    expect(demand.west).toBe(0);
    expect(demand.centraal).toBe(0);
  });

  it('returns zero for archived supplies', () => {
    const supply = makeStandardSupply({ archived: true });
    const guests = makeGuests();
    const demand = computeSupplyDemand(supply, guests, [], '2026-05-11');
    expect(demand.west).toBe(0);
    expect(demand.centraal).toBe(0);
  });

  it('returns zero when guestsPerUnit or horizon are missing', () => {
    const guests = makeGuests();
    expect(computeSupplyDemand(makeStandardSupply({ guestsPerUnit: 0 }), guests, [], '2026-05-11').west).toBe(0);
    expect(computeSupplyDemand(makeStandardSupply({ prepHorizonDays: 0 }), guests, [], '2026-05-11').west).toBe(0);
  });
});

// ── supplyPricePerGuest ──

describe('supplyPricePerGuest', () => {
  it('computes costPerUnit ÷ guestsPerUnit for a standard supply', () => {
    // €2.60 per loaf, one loaf serves 6.5 guests → €0.40/guest
    const bread = makeStandardSupply({ costPerUnit: 2.6, guestsPerUnit: 6.5 });
    expect(supplyPricePerGuest(bread)).toBeCloseTo(0.4);
  });

  it('returns null when costPerUnit is unset', () => {
    expect(supplyPricePerGuest(makeStandardSupply({ costPerUnit: null }))).toBeNull();
  });

  it('returns null when guestsPerUnit is missing or zero', () => {
    expect(supplyPricePerGuest(makeStandardSupply({ costPerUnit: 5, guestsPerUnit: 0 }))).toBeNull();
  });

  it('returns null for one-off supplies (no per-guest ratio)', () => {
    expect(supplyPricePerGuest(makeOneoffSupply({ costPerUnit: 4 }))).toBeNull();
  });

  it('handles a zero cost (free / donated topping)', () => {
    expect(supplyPricePerGuest(makeStandardSupply({ costPerUnit: 0, guestsPerUnit: 10 }))).toBe(0);
  });
});
