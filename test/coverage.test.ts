/**
 * Transport-aware stock coverage engine (public/js/core.ts).
 *
 * The old coverage check pooled ALL of a batch's stock against ALL of its
 * demand. computeCoverage instead allocates each batch's physically-positioned
 * stock across its own services in chronological order, respecting the one-way
 * morning van (West→Centraal, no reverse) and the "same-day Centraal demand =
 * Centraal-on-site only" rule. These tests pin the clock and inject demand so
 * the allocation logic is exercised without building the whole planner.
 *
 * Browser-global stubs come from test/setup-dom-stubs.ts (jest setupFiles).
 *
 * NOTE on the clock: getAmsterdamNow() memoizes with a 1s TTL that only refreshes
 * on forward movement, so the fake clock here moves FORWARD only — the Sunday
 * cases live in a final describe block and never restore backward.
 */

import type { Batch, Catering, DishType, InventoryEntry, Location, Meal, Service, Shipment } from '../shared/types';
import { S, setEventLocationsState } from '../public/js/state';
import { computeCoverage, coverageBadge, serviceShortfall, westReachesCentraal, westReaches, getGuests, isServicePast } from '../public/js/core';

const TODAY = '2026-05-04';     // Monday
const TOMORROW = '2026-05-05';  // Tuesday

beforeAll(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-05-04T08:00:00Z')); // Amsterdam ~10:00, before any service deadline
});
afterAll(() => { jest.useRealTimers(); });

beforeEach(() => {
  S.caterings = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  S.inventoryDone = {} as any;
});

let _id = 0;
function mk(opts: {
  type?: DishType;
  inventory?: InventoryEntry[];
  shipments?: Shipment[];
  services?: Service[];
  serving?: number;
} = {}): Batch {
  return {
    id: `b-${++_id}`,
    name: `batch-${_id}`,
    type: opts.type || 'Soup',
    serving: opts.serving ?? 280,
    cookDate: '01/05/2026',
    inventory: opts.inventory || [],
    shipments: opts.shipments || [],
    services: opts.services || [],
    allergens: [],
    extraAllergens: [],
    note: '',
    cookNotes: '',
    actualIngredients: null,
    orderFor: false,
    stockDeducted: false,
    createdAt: '2026-05-01T00:00:00.000Z',
    recipeId: null,
  };
}

function inv(loc: Location, qty: number, storage: InventoryEntry['storage'] = 'Gastro'): InventoryEntry {
  return { loc, storage, qty, cookDate: '01/05/2026' };
}
function svc(loc: Location, date: string, meal: Meal): Service {
  return { loc, date, meal };
}

/** Demand injector: maps a service slot key to liters. */
function demander(map: Record<string, number>) {
  return (_b: Batch, s: Service) => map[`${s.loc}-${s.date}-${s.meal}`] ?? 0;
}

// ── westReachesCentraal (the one-way van timing rule) ────────────────────────

describe('westReachesCentraal', () => {
  test('next morning onward is always reachable', () => {
    expect(westReachesCentraal(TODAY, TOMORROW, 'lunch')).toBe(true);
    expect(westReachesCentraal(TODAY, TOMORROW, 'dinner')).toBe(true);
  });
  test('same-day is NOT reachable except the Sunday dinner shift', () => {
    expect(westReachesCentraal(TODAY, TODAY, 'lunch')).toBe(false);
    expect(westReachesCentraal(TODAY, TODAY, 'dinner')).toBe(false);
    const SUN = '2026-05-10';
    expect(westReachesCentraal(SUN, SUN, 'dinner')).toBe(true);
    expect(westReachesCentraal(SUN, SUN, 'lunch')).toBe(false);
  });
  test('a past slot is never reachable', () => {
    expect(westReachesCentraal(TODAY, '2026-05-03', 'dinner')).toBe(false);
  });
});

// ── The headline scenario ────────────────────────────────────────────────────

describe("Daan's tomato-soup scenario", () => {
  test('20L Centraal + 20L West, 30L Centraal dinner TONIGHT → only 20L reachable, 10L short', () => {
    const b = mk({
      inventory: [inv('centraal', 20), inv('west', 20)],
      services: [svc('centraal', TODAY, 'dinner')],
    });
    const cov = computeCoverage(b, demander({ [`centraal-${TODAY}-dinner`]: 30 }));

    expect(cov.centraal.demand).toBe(30);
    expect(cov.centraal.covered).toBe(20);     // only the 20L already at Centraal
    expect(cov.centraal.shortfall).toBe(10);
    expect(cov.todayShortfall).toBe(10);
    expect(cov.shortfall).toBe(10);
    expect(cov.surplus).toBe(20);              // the 20L at West is stranded for tonight

    const d = coverageBadge(cov);
    expect(d.diff).toBe(-10);
    expect(d.str).toBe('-10L');
    expect(d.cls).toBe('stock-miss');
  });

  test('SAME stock but the 30L Centraal demand is TOMORROW → fully covered by the morning van', () => {
    const b = mk({
      inventory: [inv('centraal', 20), inv('west', 20)],
      services: [svc('centraal', TOMORROW, 'dinner')],
    });
    const cov = computeCoverage(b, demander({ [`centraal-${TOMORROW}-dinner`]: 30 }));

    expect(cov.centraal.covered).toBe(30);     // 20 at Centraal + 10 shipped West→Centraal
    expect(cov.shortfall).toBe(0);
    expect(cov.surplus).toBe(10);              // 10L West left over

    const d = coverageBadge(cov);
    expect(d.diff).toBe(10);
    expect(d.str).toBe('+10L');
    expect(d.cls).toBe('stock-ok');
  });
});

// ── Direction: no reverse van ────────────────────────────────────────────────

describe('no reverse van', () => {
  test('Centraal stock can NEVER serve a West service', () => {
    const b = mk({
      inventory: [inv('centraal', 20)],
      services: [svc('west', TODAY, 'dinner')],
    });
    const cov = computeCoverage(b, demander({ [`west-${TODAY}-dinner`]: 15 }));

    expect(cov.west.covered).toBe(0);
    expect(cov.west.shortfall).toBe(15);
    expect(cov.surplus).toBe(20);              // the Centraal stock is unusable here
    expect(coverageBadge(cov).diff).toBe(-15);
  });

  test('West stock serves West demand directly', () => {
    const b = mk({ inventory: [inv('west', 20)], services: [svc('west', TODAY, 'dinner')] });
    const cov = computeCoverage(b, demander({ [`west-${TODAY}-dinner`]: 15 }));
    expect(cov.west.covered).toBe(15);
    expect(cov.shortfall).toBe(0);
    expect(cov.surplus).toBe(5);
  });
});

// ── Chronological reservation across a batch's own services ──────────────────

describe('chronological allocation reserves stock for the soonest service', () => {
  test('20L Centraal across today dinner (15) + tomorrow dinner (10): today wins, tomorrow short 5', () => {
    const b = mk({
      inventory: [inv('centraal', 20)],
      services: [svc('centraal', TODAY, 'dinner'), svc('centraal', TOMORROW, 'dinner')],
    });
    const cov = computeCoverage(b, demander({
      [`centraal-${TODAY}-dinner`]: 15,
      [`centraal-${TOMORROW}-dinner`]: 10,
    }));
    expect(cov.todayShortfall).toBe(0);        // tonight is fully covered
    expect(cov.centraal.shortfall).toBe(5);    // tomorrow is 5 short
    const todaySvc = cov.services.find(s => s.date === TODAY)!;
    const tmrwSvc = cov.services.find(s => s.date === TOMORROW)!;
    expect(todaySvc.shortfall).toBe(0);
    expect(tmrwSvc.shortfall).toBe(5);
  });
});

// ── Per-location attribution (two-pass: West reserved before reachable Centraal) ──

describe('per-location attribution across dates', () => {
  test('a later West-only service reserves West stock over an EARLIER reachable Centraal service', () => {
    // West 10L; Tue Centraal lunch (van-reachable, 10L) is chronologically earlier
    // than Wed West dinner (10L). A naive chronological greedy would hand the West
    // stock to Tue's Centraal lunch and flag the West dinner short. Correct: the
    // West-only service (no fallback) keeps the West stock; the shortfall lands on
    // Centraal (which has a fresh-cook fallback).
    const TUE = '2026-05-05', WED = '2026-05-06';
    const b = mk({
      inventory: [inv('west', 10)],
      services: [svc('centraal', TUE, 'lunch'), svc('west', WED, 'dinner')],
    });
    const cov = computeCoverage(b, demander({
      [`centraal-${TUE}-lunch`]: 10,
      [`west-${WED}-dinner`]: 10,
    }));
    expect(cov.west.covered).toBe(10);     // West dinner keeps the West stock
    expect(cov.west.shortfall).toBe(0);
    expect(cov.centraal.shortfall).toBe(10); // Centraal lunch is the one that's short
    expect(cov.shortfall).toBe(10);          // total unchanged
  });
});

// ── In-transit stock counts toward its destination ───────────────────────────

describe('in-transit stock', () => {
  test('a shipment already heading to Centraal counts toward Centraal coverage tonight', () => {
    const shipment: Shipment = {
      id: 's1', fromLoc: 'west', toLoc: 'centraal', storage: 'Gastro',
      qty: 12, sentAt: '2026-05-04T05:00:00.000Z', arrived: false, cookDate: '01/05/2026',
    };
    const b = mk({
      inventory: [inv('centraal', 10)],
      shipments: [shipment],
      services: [svc('centraal', TODAY, 'dinner')],
    });
    const cov = computeCoverage(b, demander({ [`centraal-${TODAY}-dinner`]: 20 }));
    expect(cov.centraal.positioned).toBe(22);  // 10 settled + 12 in transit
    expect(cov.centraal.covered).toBe(20);
    expect(cov.shortfall).toBe(0);
  });
});

// ── Catering (location-agnostic) ─────────────────────────────────────────────

describe('catering demand', () => {
  function cateringFor(b: Batch, guests: number): Catering {
    return {
      id: 'c1', name: 'Event', date: TOMORROW, guestCount: guests,
      dishes: [{ dishId: b.id, type: b.type, name: b.name }],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }

  test('catering draws from leftover stock regardless of location', () => {
    // serving 1000ml → 1L/guest, so 25 guests = 25L of catering demand.
    const b = mk({ serving: 1000, inventory: [inv('west', 30)] });
    S.caterings = [cateringFor(b, 25)];
    const cov = computeCoverage(b, demander({}));
    expect(cov.demand).toBe(25);
    expect(cov.covered).toBe(25);
    expect(cov.shortfall).toBe(0);
    expect(cov.surplus).toBe(5);
  });

  test('catering beyond available stock shows a shortfall', () => {
    const b = mk({ serving: 1000, inventory: [inv('west', 20)] });
    S.caterings = [cateringFor(b, 25)];
    const cov = computeCoverage(b, demander({}));
    expect(cov.shortfall).toBe(5);
    expect(coverageBadge(cov).diff).toBe(-5);
  });

  test('per-loc leftover (stranded hint) excludes West stock earmarked for a catering', () => {
    // West 20L; Centraal dinner TODAY locked (10L, unreachable from West today);
    // catering tomorrow 15L. The catering eats 15L of the West stock, so only 5L is
    // genuinely idle/stranded — not the full 20L the pre-catering leftover would show.
    const b = mk({ serving: 1000, inventory: [inv('west', 20)], services: [svc('centraal', TODAY, 'dinner')] });
    S.caterings = [cateringFor(b, 15)];
    const cov = computeCoverage(b, demander({ [`centraal-${TODAY}-dinner`]: 10 }));
    expect(cov.centraal.todayShortfall).toBe(10);
    expect(cov.west.leftover).toBe(5);    // 20 − 15 catering
    expect(cov.surplus).toBe(5);
    expect(Math.min(cov.west.leftover, cov.centraal.todayShortfall)).toBe(5);  // stranded badge value
  });
});

// ── Invariants ───────────────────────────────────────────────────────────────

describe('invariants', () => {
  test('covered + shortfall === demand, and per-loc demand sums to total', () => {
    const b = mk({
      inventory: [inv('centraal', 8), inv('west', 5)],
      services: [
        svc('centraal', TODAY, 'dinner'),
        svc('west', TODAY, 'dinner'),
        svc('centraal', TOMORROW, 'lunch'),
      ],
    });
    const cov = computeCoverage(b, demander({
      [`centraal-${TODAY}-dinner`]: 10,
      [`west-${TODAY}-dinner`]: 7,
      [`centraal-${TOMORROW}-lunch`]: 6,
    }));
    expect(Math.round((cov.covered + cov.shortfall) * 10) / 10).toBe(cov.demand);
    expect(Math.round((cov.west.demand + cov.centraal.demand) * 10) / 10).toBe(cov.demand);
  });

  test('empty placeholder with no services is all surplus', () => {
    const b = mk({ inventory: [inv('west', 12)] });
    const cov = computeCoverage(b, demander({}));
    expect(cov.demand).toBe(0);
    expect(cov.shortfall).toBe(0);
    expect(cov.surplus).toBe(12);
    expect(coverageBadge(cov).diff).toBe(12);
    expect(coverageBadge(cov).cls).toBe('stock-ok');
  });

  test('diffStr low band: a thin surplus reads as stock-low', () => {
    const b = mk({ inventory: [inv('west', 12)], services: [svc('west', TODAY, 'dinner')] });
    const cov = computeCoverage(b, demander({ [`west-${TODAY}-dinner`]: 9 }));
    expect(cov.surplus).toBe(3);
    expect(coverageBadge(cov).cls).toBe('stock-low');
  });

  test('per-loc leftover excludes West stock the van already committed to a future Centraal service', () => {
    // West 20L; Centraal dinner TODAY (locked, 10L) + Centraal lunch TOMORROW (18L,
    // van-reachable). The morning van drains 18L of West for tomorrow, so only 2L is
    // genuinely re-routable — NOT the naive positioned(20)−westDemand(0)=20 the old
    // "stuck at West" badge used. This is the bug the review caught.
    const b = mk({
      inventory: [inv('west', 20)],
      services: [svc('centraal', TODAY, 'dinner'), svc('centraal', TOMORROW, 'lunch')],
    });
    const cov = computeCoverage(b, demander({
      [`centraal-${TODAY}-dinner`]: 10,
      [`centraal-${TOMORROW}-lunch`]: 18,
    }));
    expect(cov.centraal.todayShortfall).toBe(10);  // tonight is unreachable from West
    expect(cov.west.leftover).toBe(2);             // only 2L truly free (18 went to tomorrow)
    expect(cov.surplus).toBe(2);
    // The badge's stranded figure = min(leftover, todayShortfall) = 2, not the old 10.
    expect(Math.min(cov.west.leftover, cov.centraal.todayShortfall)).toBe(2);
  });
});

// ── serviceShortfall helper (for slot aggregation) ──────────────────────────

describe('serviceShortfall', () => {
  test('returns the per-slot unmet liters and 0 for unrelated slots', () => {
    const b = mk({
      inventory: [inv('centraal', 20)],
      services: [svc('centraal', TODAY, 'dinner')],
    });
    const dm = demander({ [`centraal-${TODAY}-dinner`]: 30 });
    expect(serviceShortfall(b, 'centraal', TODAY, 'dinner', dm)).toBe(10);
    expect(serviceShortfall(b, 'west', TODAY, 'lunch', dm)).toBe(0);   // batch doesn't serve this slot
  });
});

// ── Sunday dinner same-day exception ─────────────────────────────────────────
// LAST block: jumps the fake clock FORWARD to Sunday and never restores, so the
// getAmsterdamNow cache (forward-only TTL) stays consistent for the whole block.

describe('Sunday dinner exception', () => {
  beforeAll(() => { jest.setSystemTime(new Date('2026-05-10T06:00:00Z')); }); // Sunday morning
  const SUN = '2026-05-10';

  test('West stock reaches Centraal dinner on a Sunday same-day', () => {
    const b = mk({ inventory: [inv('west', 20)], services: [svc('centraal', SUN, 'dinner')] });
    const cov = computeCoverage(b, demander({ [`centraal-${SUN}-dinner`]: 15 }));
    expect(cov.centraal.covered).toBe(15);
    expect(cov.shortfall).toBe(0);
  });

  test('but NOT Centraal lunch on a Sunday', () => {
    const b = mk({ inventory: [inv('west', 20)], services: [svc('centraal', SUN, 'lunch')] });
    const cov = computeCoverage(b, demander({ [`centraal-${SUN}-lunch`]: 15 }));
    expect(cov.centraal.shortfall).toBe(15);
  });

  test('equal date+meal: West reserves its stock before a reachable Centraal slot (order-independent)', () => {
    // West 10L, both a West dinner (10) and a Sunday-reachable Centraal dinner (10).
    // West can ONLY be served from West stock; the Centraal slot has a fallback
    // (Centraal stock / fresh cook), so the West slot must win the West stock and the
    // shortfall must land on Centraal — regardless of services[] order (the bug was
    // order-dependent attribution).
    const dm = demander({ [`west-${SUN}-dinner`]: 10, [`centraal-${SUN}-dinner`]: 10 });
    for (const services of [
      [svc('centraal', SUN, 'dinner'), svc('west', SUN, 'dinner')],
      [svc('west', SUN, 'dinner'), svc('centraal', SUN, 'dinner')],
    ]) {
      const cov = computeCoverage(mk({ inventory: [inv('west', 10)], services }), dm);
      expect(cov.west.shortfall).toBe(0);
      expect(cov.centraal.shortfall).toBe(10);
    }
  });
});

// ── Event locations: hub-and-spoke coverage + normalizers ────────────────────
// (event-locations build, phase E). With no event data every path above is
// bit-identical — these cases exercise the third spoke. NOTE the fake clock
// only ever moves FORWARD (see the header note): the Sunday block above left
// it on 2026-05-10, so these tests advance to Monday 2026-05-11 and use their
// own local dates.

const D0 = '2026-05-11';  // "today" for this block (Monday)
const D1 = '2026-05-12';  // tomorrow

describe('event-location coverage', () => {
  const EV = 'ev-covfest-2026';
  beforeAll(() => { jest.setSystemTime(new Date('2026-05-11T08:00:00Z')); }); // forward from the Sunday block
  beforeEach(() => {
    setEventLocationsState([{
      slug: EV, name: 'Covfest 2026', startDate: '2026-05-11', endDate: '2026-05-20',
      hanosAccount: 'west', archived: false, createdAt: '2026-05-01T00:00:00.000Z', archivedAt: null,
    }]);
  });
  afterEach(() => { setEventLocationsState([]); });

  test('westReaches: Centraal keeps its van rule (Sunday exception); events are next-morning only', () => {
    const SUN = '2026-05-10';
    expect(westReaches('centraal', SUN, SUN, 'dinner')).toBe(true);   // delegates incl. exception
    expect(westReaches(EV, SUN, SUN, 'dinner')).toBe(false);          // no exception for events
    expect(westReaches(EV, D0, D1, 'lunch')).toBe(true);
    expect(westReaches(EV, D0, D0, 'dinner')).toBe(false);
  });

  test('an event service draws its OWN bucket first, then West leftovers (next-morning only)', () => {
    const b = mk({
      inventory: [inv('west', 10), inv(EV as Location, 4)],
      services: [svc(EV as Location, D1, 'lunch')],
    });
    const cov = computeCoverage(b, demander({ [`${EV}-${D1}-lunch`]: 9 }));
    expect(cov.byLoc[EV].demand).toBe(9);
    expect(cov.byLoc[EV].covered).toBe(9);      // 4 on-site + 5 from West (tomorrow = reachable)
    expect(cov.byLoc[EV].shortfall).toBe(0);
    expect(cov.west.leftover).toBe(5);
  });

  test('same-day event demand cannot pull from West (locked to on-site stock)', () => {
    const b = mk({
      inventory: [inv('west', 10), inv(EV as Location, 4)],
      services: [svc(EV as Location, D0, 'dinner')],
    });
    const cov = computeCoverage(b, demander({ [`${EV}-${D0}-dinner`]: 9 }));
    expect(cov.byLoc[EV].covered).toBe(4);
    expect(cov.byLoc[EV].shortfall).toBe(5);
    expect(cov.byLoc[EV].todayShortfall).toBe(5);
    expect(cov.west.leftover).toBe(10);          // untouched — unreachable in time
  });

  test('event stock NEVER covers west/centraal demand', () => {
    const b = mk({
      inventory: [inv(EV as Location, 50)],
      services: [svc('west', D1, 'lunch'), svc('centraal', D1, 'dinner')],
    });
    const cov = computeCoverage(b, demander({
      [`west-${D1}-lunch`]: 10,
      [`centraal-${D1}-dinner`]: 10,
    }));
    expect(cov.west.shortfall).toBe(10);
    expect(cov.centraal.shortfall).toBe(10);
    expect(cov.byLoc[EV].leftover).toBe(50);
    expect(cov.shortfall).toBe(20);
  });

  test('west/centraal split of a shared batch is unchanged by an extra event service', () => {
    const plain = mk({
      inventory: [inv('west', 20)],
      services: [svc('west', D1, 'lunch'), svc('centraal', D1, 'dinner')],
    });
    const demands = { [`west-${D1}-lunch`]: 8, [`centraal-${D1}-dinner`]: 6 };
    const base = computeCoverage(plain, demander(demands));

    const withEvent = mk({
      inventory: [inv('west', 20), inv(EV as Location, 5)],
      services: [svc('west', D1, 'lunch'), svc('centraal', D1, 'dinner'), svc(EV as Location, D1, 'lunch')],
    });
    const cov = computeCoverage(withEvent, demander({ ...demands, [`${EV}-${D1}-lunch`]: 5 }));
    expect(cov.west).toEqual(base.west);
    expect(cov.centraal.demand).toEqual(base.centraal.demand);
    expect(cov.centraal.covered).toEqual(base.centraal.covered);
    expect(cov.byLoc[EV].covered).toBe(5);
    // Aliases hold: byLoc.west IS the west field.
    expect(cov.byLoc.west).toBe(cov.west);
    expect(cov.byLoc.centraal).toBe(cov.centraal);
  });

  test('catering drains west → centraal → event buckets, in that order', () => {
    // Stock EXCEEDS the catering demand so the drain ORDER is observable in
    // the leftovers (a fully-consumed fixture ends at all-zero regardless of
    // order — review finding). 50 guests x 0.28L = 14L demand against
    // 10 + 10 + 10: west drains fully, centraal partially, event untouched.
    const b = mk({ inventory: [inv('west', 10), inv('centraal', 10), inv(EV as Location, 10)] });
    S.caterings = [{
      id: 'c-1', name: 'Big order', date: '12/05/2026', guestCount: 50,
      deliveryMode: 'pickup', dishes: [{ dishId: b.id, name: 'x', type: 'Soup' }],
      logisticsNotes: '',
    } as Catering];
    const cov = computeCoverage(b, demander({}));
    expect(cov.west.leftover).toBe(0);        // drained first, fully
    expect(cov.centraal.leftover).toBe(6);    // 10 − remaining 4
    expect(cov.byLoc[EV].leftover).toBe(10);  // drained last — untouched
    expect(cov.shortfall).toBe(0);
    S.caterings = [];
  });
});

describe('event-location normalizers', () => {
  const EV = 'ev-normfest-2026';
  beforeEach(() => {
    setEventLocationsState([{
      slug: EV, name: 'Normfest 2026', startDate: '2026-05-11', endDate: '2026-05-15',
      hanosAccount: 'west', archived: false, createdAt: '2026-05-01T00:00:00.000Z', archivedAt: null,
    }]);
    S.guests[EV] = {
      Mon: { lunch: 400, dinner: 700 }, Tue: { lunch: 400, dinner: 700 },
      Wed: { lunch: 400, dinner: 700 }, Thu: { lunch: 400, dinner: 700 },
      Fri: { lunch: 400, dinner: 700 }, Sat: { lunch: 400, dinner: 700 }, Sun: { lunch: 400, dinner: 700 },
    };
  });
  afterEach(() => {
    setEventLocationsState([]);
    delete S.guests[EV];
  });

  test('getGuests reads the event key inside the window and clamps to 0 outside it', () => {
    expect(getGuests(EV, '2026-05-11', 'lunch')).toBe(400);   // start day
    expect(getGuests(EV, '2026-05-15', 'dinner')).toBe(700);  // end day
    expect(getGuests(EV, '2026-05-16', 'lunch')).toBe(0);     // day after end → clamped
    expect(getGuests(EV, '2026-05-10', 'lunch')).toBe(0);     // day before start → clamped
  });

  test('getGuests for west/centraal is untouched by the registry', () => {
    const withRegistry = getGuests('west', D1, 'lunch');
    setEventLocationsState([]);
    expect(getGuests('west', D1, 'lunch')).toBe(withRegistry);
  });

  test('isServicePast reads the EVENT location own inventoryDone, not Centraal', () => {
    // Move to 13:00 Amsterdam (past the 12:45 urgentFrom, before the 13:45
    // deadline): Centraal marked lunch-inventory-done → its lunch is "past";
    // the event's lunch, same date, must NOT inherit that.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    S.inventoryDone = { centraal: { lunch: D0, dinner: null } } as any;
    jest.setSystemTime(new Date('2026-05-11T11:00:00Z')); // forward only
    expect(isServicePast({ loc: 'centraal', date: D0, meal: 'lunch' })).toBe(true);
    expect(isServicePast({ loc: EV as Location, date: D0, meal: 'lunch' })).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    S.inventoryDone = {} as any;
  });
});
