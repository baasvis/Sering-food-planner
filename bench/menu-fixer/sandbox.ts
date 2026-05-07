/**
 * sandbox.ts — install a Fixture into the global S + mock Date.
 *
 * The existing solver (public/js/menu-fixer.ts) reads from S.batches /
 * S.caterings / S.guests / S.guestsNextWeeks / S.kitchenEquipment and uses
 * `new Date()` via getToday(). To run it headlessly with our fixture data we
 * install everything into S, mock Date, run the solver, then restore.
 *
 * Solvers that DON'T need the existing helpers (e.g. a pure-greedy that
 * receives batches+window directly) can ignore this file.
 */

import type { Fixture } from './types';
import type { Batch } from '../../shared/types';

// Holds the original Date so we can restore it.
let _realDate: typeof Date | null = null;

/** Replace `Date` so getToday() / `new Date()` returns the fixture's anchor. */
export function mockToday(iso: string): void {
  if (_realDate) restoreDate();
  _realDate = Date;
  const mockMs = new _realDate(iso + 'T08:00:00').getTime();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const realCtor: any = _realDate;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const MockDate = function (this: unknown, ...args: any[]) {
    if (args.length === 0) return new realCtor(mockMs);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new (realCtor as any)(...args);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  MockDate.now = () => mockMs;
  MockDate.parse = realCtor.parse;
  MockDate.UTC = realCtor.UTC;
  MockDate.prototype = realCtor.prototype;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).Date = MockDate;
}

export function restoreDate(): void {
  if (_realDate) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).Date = _realDate;
    _realDate = null;
  }
}

/**
 * Install a fixture into the frontend S object and mock the system clock.
 * Returns the cloned batches array so the solver can read it back if needed.
 *
 * Note: this dynamically imports state.ts so the harness file itself doesn't
 * pull in the frontend module graph at top level.
 */
export async function installFixture(fixture: Fixture, batches: Batch[]): Promise<void> {
  mockToday(fixture.today);
  const stateMod = await import('../../public/js/state');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const S: any = stateMod.S;

  S.batches = batches;
  S.caterings = JSON.parse(JSON.stringify(fixture.caterings));
  S.guests = JSON.parse(JSON.stringify(fixture.guestsBase));
  S.guestsNextWeeks = JSON.parse(JSON.stringify(fixture.guestsNextWeeks));
  S.predictions = JSON.parse(JSON.stringify(fixture.guestsPredictions));
  S.kitchenEquipment = JSON.parse(JSON.stringify(fixture.kitchenEquipment));
  S.storageConfig = JSON.parse(JSON.stringify(fixture.storageConfig));
  S.deletedBatches = [];
  S.transportItems = [];
  S.recipes = [];
  S.ingredientDb = [];
  S.planner = {};

  // Rebuild the planner index (needed by calcRequired / lookupAllocation).
  const coreMod = await import('../../public/js/core');
  coreMod.rebuildPlanner();
}

export function uninstallFixture(): void {
  restoreDate();
}
