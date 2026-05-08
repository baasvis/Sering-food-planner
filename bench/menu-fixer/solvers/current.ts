/**
 * Current 5-pass solver — baseline strategy.
 *
 * Wraps the existing public/js/menu-fixer.ts pipeline:
 *   consolidate → stripFuture → cleanup orphans → generate placeholders →
 *   Pass 1 (cooked-finish) → Pass 2 (2-newest) → Pass 3 (ignore-pot-cap) →
 *   Pass 4 (finish-off) → Pass 5 (combination team)
 *
 * Returns the mutated batches in their post-pipeline state.
 */

import type { SolverFn, SolverResult } from '../types';
import type { Batch } from '../../../shared/types';
import { installFixture, uninstallFixture } from '../sandbox';

export const current: SolverFn = (input): SolverResult => {
  const { fixture, batches } = input;
  // Capture real-time timestamps OUTSIDE the mocked Date span. We grab the
  // real Date constructor first, then mock; the mock only affects the
  // solver's own `new Date()` calls, not our timing here.
  const RealDate = Date;
  const start = RealDate.now();

  // Async import → sync wait via deasync isn't great; restructure to wrap
  // in a synchronous shell. Since SolverFn is synchronous, we do a top-level
  // dynamic import and then run the pipeline here. The harness can await
  // a wrapper if we expose runSolverAsync — but for simplicity we make the
  // SolverFn return a Promise-like by stashing a deferred. To keep the
  // contract clean we'll switch SolverFn to support async.
  //
  // Workaround: run synchronously by requiring the modules through Node's
  // CommonJS resolver. The frontend modules use ES import syntax but @swc
  // compiles them to CJS-compatible output. tsx supports both.

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { rebuildPlanner, consolidateFamilies, calcRequired, getGuests } = require('../../../public/js/core');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const menuFixer = require('../../../public/js/menu-fixer');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { S } = require('../../../public/js/state');

  // Install fixture synchronously (require, not dynamic import)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sandbox = require('../sandbox');
  sandbox.mockToday(fixture.today);
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
  rebuildPlanner();

  try {
    // Step −2: consolidate same-loc same-family duplicates
    const consolidation = consolidateFamilies(S.batches);
    if (consolidation.removed.length > 0) {
      S.batches = consolidation.kept;
    }

    // Step −1: strip every future service entry
    menuFixer.stripFutureServices(S.batches);

    // Step 0: cleanup orphan placeholders
    const orphans = menuFixer.findOrphanPlaceholders(S.batches);
    if (orphans.length > 0) {
      const orphanIds = new Set<string>(orphans.map((b: Batch) => b.id));
      S.batches = S.batches.filter((b: Batch) => !orphanIds.has(b.id));
    }

    // Step 1: planning window
    const planWindow = menuFixer.buildPlanningWindow(new Date(fixture.today + 'T08:00:00'));

    // Step 2: snapshot
    const snapshot = menuFixer.snapshotBatches(S.batches, planWindow);

    // Step 3: generate placeholders
    const newPlaceholders = menuFixer.generateMissingPlaceholders(planWindow, snapshot);
    for (const b of newPlaceholders) S.batches.push(b);
    rebuildPlanner();

    // calcReqLive: rebuild planner before each call
    const calcReqLive = (b: Batch): number => {
      rebuildPlanner();
      return calcRequired(b);
    };

    const biggestPot = S.kitchenEquipment && S.kitchenEquipment.pots.length > 0
      ? Math.max(...S.kitchenEquipment.pots)
      : undefined;

    const pass1 = menuFixer.assignServicesPass1(S.batches, planWindow, calcReqLive, getGuests);
    rebuildPlanner();
    const pass2 = menuFixer.assignServicesPass2(S.batches, planWindow, calcReqLive, getGuests, biggestPot);
    rebuildPlanner();
    const pass3 = menuFixer.assignServicesPass3(S.batches, planWindow, calcReqLive, getGuests, biggestPot);
    rebuildPlanner();
    const pass4 = menuFixer.assignServicesPass4(S.batches, planWindow, calcReqLive, getGuests);
    rebuildPlanner();
    const pass5 = menuFixer.assignServicesPass5(S.batches, planWindow, calcReqLive, getGuests);
    rebuildPlanner();

    return {
      batches: S.batches,
      durationMs: RealDate.now() - start,
      stats: {
        consolidated: consolidation.removed.length,
        orphansRemoved: orphans.length,
        placeholdersCreated: newPlaceholders.length,
        pass1Added: pass1.servicesAdded,
        pass2Added: pass2.servicesAdded,
        pass3Added: pass3.servicesAdded,
        pass4Added: pass4.servicesAdded,
        pass5Added: pass5.servicesAdded,
        pass5Teams: pass5.teamsFormed,
      },
    };
  } finally {
    uninstallFixture();
  }
};
