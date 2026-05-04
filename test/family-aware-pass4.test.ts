/**
 * Pass 4 (finish-off) tests against the REAL calcRequired + rebuildPlanner
 * (not the per-test fixedCalcRequired stub used in menu-fixer.test.ts).
 *
 * These exercise the interaction between:
 *   - Pass 4's tentative-push capacity check
 *   - The greedy family allocator that rebuildPlanner refreshes
 *   - The "finish-off" surplus threshold that decides whether a batch is a
 *     tail-leftover candidate for piling onto 2/2 slots as a 3rd peer.
 *
 * Why a separate file from menu-fixer.test.ts: those tests stub calcRequired
 * to be peer-blind (1L per service), so the family cache is irrelevant. Here
 * we want the production allocator in the loop because Pass 4's bugs only
 * surface when greedy redistributes between siblings.
 */

import type { Batch, DishType, Location, Meal, Service, StorageType } from '../shared/types';
import { calcRequired, rebuildPlanner } from '../public/js/core';
import { assignServicesPass4, type PlanDay, countTypeInSlot } from '../public/js/menu-fixer';
import { S } from '../public/js/state';

let _id = 0;
const nextId = () => `b-${++_id}`;

function makeBatch(overrides: Partial<Batch> & { type: DishType; cookDate: string }): Batch {
  return {
    id: nextId(),
    name: overrides.name || 'Test',
    type: overrides.type,
    stock: 0,
    serving: 280,
    storage: 'Gastro' as StorageType,
    location: 'west' as Location,
    inTransit: false,
    allergens: [],
    extraAllergens: [],
    orderFor: false,
    parentId: null,
    cookDate: overrides.cookDate,
    recipeSheetId: null,
    recipeVolume: null,
    recipeIngredients: null,
    note: '',
    services: [],
    createdAt: '2026-05-01T00:00:00.000Z',
    recipeId: null,
    actualIngredients: null,
    cookNotes: '',
    stockDeducted: false,
    generated: false,
    ...overrides,
  };
}

/** Build a real PlanDay window over the given ISO dates with all 4 slots
 *  marked future (non-past). Cook date string is whatever the test seeds —
 *  not derived, so the ISO and cookDate stay in sync without date math. */
function makeWindow(days: { iso: string; cookDate: string; dayName: string }[]): PlanDay[] {
  return days.map(d => ({
    date: new Date(d.iso + 'T12:00:00'),
    isoDate: d.iso,
    cookDateStr: d.cookDate,
    dayName: d.dayName,
    slots: [
      { loc: 'centraal' as Location, meal: 'lunch' as Meal, isPast: false },
      { loc: 'centraal' as Location, meal: 'dinner' as Meal, isPast: false },
      { loc: 'west' as Location,     meal: 'lunch' as Meal, isPast: false },
      { loc: 'west' as Location,     meal: 'dinner' as Meal, isPast: false },
    ],
  }));
}

/** Pass 4 in production passes calcReqLive — a wrapper that rebuilds the
 *  planner before each calcReq call so the greedy cache reflects the just-
 *  pushed tentative service. We mirror that here. */
function calcReqLive(b: Batch): number {
  rebuildPlanner();
  return calcRequired(b);
}

beforeEach(() => {
  _id = 0;
  // Seed 130 guests at every weekday dinner so the multi-slot scenarios
  // reliably produce 18.2L family-share per slot for a 280g soup.
  const dinner130 = (d: string) => ({ [d]: { lunch: 90, dinner: 130 } });
  S.guests = {
    centraal: { ...dinner130('Mon'), ...dinner130('Tue'), ...dinner130('Wed'), ...dinner130('Thu'), ...dinner130('Fri') } as any,
    west: { ...dinner130('Mon'), ...dinner130('Tue'), ...dinner130('Wed'), ...dinner130('Thu'), ...dinner130('Fri') } as any,
  };
  S.batches = [];
  S.planner = {};
  S.caterings = [];
  S.guestsNextWeeks = {};
});

// ── Item 4: family-level capacity check ────────────────────────────────────

describe('Pass 4 family-level capacity check', () => {
  test('Per-batch fits but family overshoots → push REJECTED', () => {
    // Setup: parent W 50L + split C 1L (starved). Family stock = 51L.
    // Pre-existing services: split at Mon C (taking 1L of demand, then
    // absorbing the 17.2L overflow as the only family member at-slot),
    // parent at Tue C and Wed C dinner (each ~18.2L).
    //
    // Family demand currently: split 18.2L + parent 36.4L = 54.6L on 51L
    // stock = 7% overshoot (within family tolerance).
    //
    // Now Pass 4 considers parent for Thu C (1/2 under-filled slot — Tier A).
    // Push Thu C onto parent makes parent calcReq = 54.6L (50L stock = 9%
    // per-batch overshoot, within naive 25% tolerance).
    // Family-level: split 18.2L + parent 54.6L = 72.8L on 51L stock = 43%
    // overshoot → OVER 25% family tolerance → must REJECT.
    const parent = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 50, location: 'west', name: 'Tomato' });
    const split = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 1, location: 'centraal', name: 'Tomato (split)' });
    split.parentId = parent.id;

    parent.services.push({ loc: 'centraal', date: '2026-05-05', meal: 'dinner' });
    parent.services.push({ loc: 'centraal', date: '2026-05-06', meal: 'dinner' });
    split.services.push({ loc: 'centraal', date: '2026-05-04', meal: 'dinner' });

    // A placeholder at Thu C dinner so Pass 4's Tier A sees it as 1/2.
    const placeholder = makeBatch({ type: 'Soup', cookDate: '07/05/2026', stock: 0, location: 'centraal', name: 'Thu placeholder' });
    placeholder.services.push({ loc: 'centraal', date: '2026-05-07', meal: 'dinner' });

    S.batches = [parent, split, placeholder];
    rebuildPlanner();

    const window = makeWindow([
      { iso: '2026-05-04', cookDate: '04/05/2026', dayName: 'Mon' },
      { iso: '2026-05-05', cookDate: '05/05/2026', dayName: 'Tue' },
      { iso: '2026-05-06', cookDate: '06/05/2026', dayName: 'Wed' },
      { iso: '2026-05-07', cookDate: '07/05/2026', dayName: 'Thu' },
    ]);

    assignServicesPass4(S.batches, window, calcReqLive);

    // Parent must NOT have been added to Thu C dinner — it would push the
    // family to 43% overshoot, well past the 25% tolerance.
    const parentAtThuC = parent.services.some(s =>
      s.loc === 'centraal' && s.date === '2026-05-07' && s.meal === 'dinner'
    );
    expect(parentAtThuC).toBe(false);
  });

  test('Tier A push that would push family over stock pool by ANY amount → REJECTED', () => {
    // The "no unnecessary overshoot" guarantee — if there's a family with
    // surplus elsewhere that could cover this slot, don't make a tight-
    // family push into a real stockout. Tighter than the pre-fix 25%
    // tolerance: now any positive overshoot is rejected.
    //
    // Setup uses far-future dates (2030) to avoid wall-clock interference:
    // isServicePast checks against `new Date()` not a mocked clock.
    // Parent W 30L + split C 50L = 80L family stock. Pre-existing services
    // bring family demand ≈ 86.8L (already past stock). Pass 4 should
    // recognise this and skip — 0% tolerance means even 6.8L overshoot is
    // rejected. (Old 25% tolerance would have allowed it.)
    const parent = makeBatch({ type: 'Soup', cookDate: '03/06/2030', stock: 30, location: 'west', name: 'Bean Stew' });
    const split = makeBatch({ type: 'Soup', cookDate: '03/06/2030', stock: 50, location: 'centraal', name: 'Bean Stew (split)' });
    split.parentId = parent.id;

    // 90/130 guests are seeded for Mon-Fri day NAMES (not dates), so the
    // test still gets sensible per-slot demand. 2030-06-03 = Monday. We
    // pre-load three slots that put the family well over its stock pool.
    parent.services.push({ loc: 'west', date: '2030-06-03', meal: 'lunch' });    // 25.2L
    split.services.push({ loc: 'centraal', date: '2030-06-03', meal: 'lunch' }); // 25.2L
    split.services.push({ loc: 'centraal', date: '2030-06-03', meal: 'dinner' }); // 36.4L
    // Family demand ≈ 86.8L vs stock 80L → ALREADY 8% over.

    // Tue 2030-06-04 C lunch — under-filled (placeholder only). Pass 4
    // would normally pile split here. With 0% tolerance, family is already
    // over, so familySurplusPre <= 0 → skip.
    const placeholder = makeBatch({ type: 'Soup', cookDate: '04/06/2030', stock: 0, location: 'centraal', name: 'Tue placeholder' });
    placeholder.services.push({ loc: 'centraal', date: '2030-06-04', meal: 'lunch' });

    S.batches = [parent, split, placeholder];
    rebuildPlanner();

    const window = makeWindow([
      { iso: '2030-06-04', cookDate: '04/06/2030', dayName: 'Tue' },
    ]);

    assignServicesPass4(S.batches, window, calcReqLive);

    const familyAtTueCLunch = S.batches.some(b =>
      (b === parent || b === split) &&
      b.services.some(s => s.loc === 'centraal' && s.date === '2030-06-04' && s.meal === 'lunch')
    );
    expect(familyAtTueCLunch).toBe(false);
  });

  test('Per-batch fits AND family fits → push ACCEPTED (slot reaches 2/2)', () => {
    // Sanity: when the family has slack, Pass 4's Tier A should fill an
    // under-filled slot.
    //
    // Family: parent W 100L + split C 100L (200L stock). Both at zero slots.
    // Placeholder at Tue C dinner = 1/2.
    const parent = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 100, location: 'west', name: 'Tomato' });
    const split = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 100, location: 'centraal', name: 'Tomato (split)' });
    split.parentId = parent.id;

    const placeholder = makeBatch({ type: 'Soup', cookDate: '05/05/2026', stock: 0, location: 'centraal', name: 'Tue placeholder' });
    placeholder.services.push({ loc: 'centraal', date: '2026-05-05', meal: 'dinner' });

    S.batches = [parent, split, placeholder];
    rebuildPlanner();

    const window = makeWindow([
      { iso: '2026-05-05', cookDate: '05/05/2026', dayName: 'Tue' },
    ]);

    assignServicesPass4(S.batches, window, calcReqLive);

    // Some family member should now be at Tue C dinner — Pass 4 isn't
    // required to prefer same-loc, but SOMEONE from the family should fill
    // the under-filled slot. Counted via family-aware countTypeInSlot which
    // collapses parent+split into one menu option.
    const familiesAtTueC = countTypeInSlot(S.batches, 'Soup', 'centraal', '2026-05-05', 'dinner');
    expect(familiesAtTueC).toBe(2);
  });
});

// ── Item 3: family-level surplus threshold for Tier B ──────────────────────

describe('Pass 4 finish-off threshold (family-level surplus)', () => {
  test('Batch with low per-batch calcReq because sibling absorbs all → no reckless 3rd-peer pile-on', () => {
    // The bug: under greedy, a parent batch that has ALL its demand absorbed
    // by a sibling shows calcReq=0 → naive Pass 4 sees "100% surplus, small
    // batch (under 80 servings) — must be a tail!" and piles it as a 3rd
    // peer onto every available 2/2 slot. Result: every meal goes 3-deep
    // for no good reason — the family was already balanced.
    //
    // Family-level surplus fixes this: parent's "surplus" looks deceptively
    // small (5L = 18 servings) only because the family pool is small.
    // Family-level metrics expose that the family is at maximum capacity:
    // there's no real tail to drain.
    //
    // Setup: parent W 5L + split C 5L. Family stock 10L.
    //   1 Centraal slot (Mon C dinner) — split takes 5L + absorbs 13.2L
    //     overflow → calcReq(split) = 18.2 on 5L stock (pre-existing
    //     overshoot, Pass 4 won't re-touch split because surplus <= 0).
    //   parent has calcReq = 0 (not at the slot). Per-batch surplus = 5L =
    //     18 servings → naive Tier B threshold says "tail, pile on".
    //   Family demand 18.2L on 10L stock = ALREADY 82% over → no real
    //     surplus to drain.
    //
    // Two unrelated soups already fill Mon W dinner 2/2. Under the bug,
    // parent gets piled onto Mon W. Under the family-aware fix, it doesn't.
    const parent = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 5, location: 'west', name: 'Tomato' });
    const split = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 5, location: 'centraal', name: 'Tomato (split)' });
    split.parentId = parent.id;

    split.services.push({ loc: 'centraal', date: '2026-05-04', meal: 'dinner' });

    const a = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 100, location: 'west', name: 'A' });
    const b = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 100, location: 'west', name: 'B' });
    a.services.push({ loc: 'west', date: '2026-05-04', meal: 'dinner' });
    b.services.push({ loc: 'west', date: '2026-05-04', meal: 'dinner' });

    S.batches = [parent, split, a, b];
    rebuildPlanner();

    const window = makeWindow([
      { iso: '2026-05-04', cookDate: '04/05/2026', dayName: 'Mon' },
    ]);

    assignServicesPass4(S.batches, window, calcReqLive);

    // Parent must NOT have been piled onto Mon W dinner as 3rd peer — the
    // family is over-committed already.
    const parentAtMonW = parent.services.some(s =>
      s.loc === 'west' && s.date === '2026-05-04' && s.meal === 'dinner'
    );
    expect(parentAtMonW).toBe(false);
  });

  test('Single-batch tail does NOT ride along on a 2/2 slot (Tier B disabled)', () => {
    // Pass 4 used to pile small leftover batches as 3rd peers ("tail rides
    // along"). Daan reverted this: the tail batch runs out 5 minutes into
    // service and guests lose menu choice for the rest of the meal. Better
    // to leave the slot at 2/2 and surface the leftover stock as a signal
    // to reduce next week's cook.
    const tail = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 5, location: 'west', name: 'Tail soup' });
    const a = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 100, location: 'west', name: 'A' });
    const b = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 100, location: 'west', name: 'B' });
    a.services.push({ loc: 'west', date: '2026-05-04', meal: 'dinner' });
    b.services.push({ loc: 'west', date: '2026-05-04', meal: 'dinner' });

    S.batches = [tail, a, b];
    rebuildPlanner();

    const window = makeWindow([
      { iso: '2026-05-04', cookDate: '04/05/2026', dayName: 'Mon' },
    ]);

    assignServicesPass4(S.batches, window, calcReqLive);

    const tailAtMonW = tail.services.some(s =>
      s.loc === 'west' && s.date === '2026-05-04' && s.meal === 'dinner'
    );
    expect(tailAtMonW).toBe(false);
  });

  test('Stale-but-edible batch CAN ride along Pass 4 (option 2 soft-stale window)', () => {
    // Pass 1/2/3 use a 3-day freshness window — soup cooked Sunday is
    // "stale" to the fresh menu by Wednesday. But the kitchen still has
    // usable Tomato sitting in the walk-in. Pass 4 runs with a longer
    // stale-limit (FINISH_OFF_STALE_LIMIT_DAYS = 5) so it can ride a
    // Sun-cooked batch along Wed/Thu slots as a finish-off rider.
    //
    // Setup uses a custom 1-slot window (Wed W lunch, 3 days post-cook)
    // to isolate the stale check from Tier A's tendency to fill earlier
    // empty slots first.
    const tomato = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 30, location: 'west', name: 'Sun Tomato' });
    const tueSoup = makeBatch({ type: 'Soup', cookDate: '05/05/2026', stock: 0, location: 'west', name: 'Tue Soup' });
    tueSoup.services.push({ loc: 'west', date: '2026-05-06', meal: 'lunch' });

    S.batches = [tomato, tueSoup];
    rebuildPlanner();

    // Custom single-slot window: only Wed W lunch. Wed is 3 days after the
    // Sun cookDate — past the Pass 1/2/3 cutoff but inside the Pass 4
    // soft-stale window. Slot is 1/2 (Tue Soup placeholder).
    const window: PlanDay[] = [{
      date: new Date('2026-05-06T12:00:00'),
      isoDate: '2026-05-06',
      cookDateStr: '06/05/2026',
      dayName: 'Wed',
      slots: [{ loc: 'west' as Location, meal: 'lunch' as Meal, isPast: false }],
    }];

    assignServicesPass4(S.batches, window, calcReqLive);

    const tomatoAtWedW = tomato.services.some(s =>
      s.loc === 'west' && s.date === '2026-05-06' && s.meal === 'lunch'
    );
    expect(tomatoAtWedW).toBe(true);
  });

  test('Beyond Pass 4 stale limit (5+ days) → batch NOT eligible', () => {
    // Hard cap at FINISH_OFF_STALE_LIMIT_DAYS = 5. A batch cooked Sun would
    // be 6 days old by Saturday, beyond food-safety reach even for finish-
    // off. Pass 4 must stop walking past the limit.
    const tomato = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 30, location: 'west', name: 'Sun Tomato' });
    const satPlaceholder = makeBatch({ type: 'Soup', cookDate: '09/05/2026', stock: 0, location: 'west', name: 'Sat placeholder' });
    satPlaceholder.services.push({ loc: 'west', date: '2026-05-09', meal: 'lunch' });

    S.batches = [tomato, satPlaceholder];
    rebuildPlanner();

    const window: PlanDay[] = [{
      date: new Date('2026-05-09T12:00:00'),
      isoDate: '2026-05-09',
      cookDateStr: '09/05/2026',
      dayName: 'Sat',
      slots: [{ loc: 'west' as Location, meal: 'lunch' as Meal, isPast: false }],
    }];

    assignServicesPass4(S.batches, window, calcReqLive);

    const tomatoAtSatW = tomato.services.some(s =>
      s.loc === 'west' && s.date === '2026-05-09' && s.meal === 'lunch'
    );
    expect(tomatoAtSatW).toBe(false);
  });

  test('Single-batch big over-cook → still SKIPPED (not a tail)', () => {
    // Sanity from the other direction: a lone batch with massive surplus
    // (no family pooling involved) is an over-cook, not a tail. Pass 4
    // should NOT pile it onto a 2/2 slot as a 3rd peer.
    const overcook = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 100, location: 'west', name: 'Over-cook' });
    const a = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 100, location: 'west', name: 'A' });
    const b = makeBatch({ type: 'Soup', cookDate: '03/05/2026', stock: 100, location: 'west', name: 'B' });
    a.services.push({ loc: 'west', date: '2026-05-04', meal: 'dinner' });
    b.services.push({ loc: 'west', date: '2026-05-04', meal: 'dinner' });

    S.batches = [overcook, a, b];
    rebuildPlanner();

    const window = makeWindow([
      { iso: '2026-05-04', cookDate: '04/05/2026', dayName: 'Mon' },
    ]);

    assignServicesPass4(S.batches, window, calcReqLive);

    const overAtMonW = overcook.services.some(s =>
      s.loc === 'west' && s.date === '2026-05-04' && s.meal === 'dinner'
    );
    expect(overAtMonW).toBe(false);
  });
});
