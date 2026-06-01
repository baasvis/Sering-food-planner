// Faithful replay of _fixMyMenuBody against the global S, for the bench/repro.
// Assumes S is already loaded and the system clock is mocked to the anchor day.
import type { Batch } from '../../shared/types';
import {
  buildPlanningWindow, snapshotBatches, stripFutureServices,
  findOrphanPlaceholders, findSpentBatches, findStalePlaceholders,
  generateMissingPlaceholders, allocatePotCaps, forcedAssignmentPrePass,
  scoredGreedyAssignment, runFallbackLadder,
} from '../../public/js/menu-fixer';
import { S } from '../../public/js/state';
import { rebuildPlanner, calcRequired, calcRequiredLive, getEffectiveGuests, getToday, dateToIso } from '../../public/js/core';

export function loadFixtureIntoS(dump: any): void {
  S.batches = JSON.parse(JSON.stringify(dump.batches));
  S.guests = JSON.parse(JSON.stringify(dump.guests));
  S.caterings = JSON.parse(JSON.stringify(dump.caterings || []));
  S.kitchenEquipment = JSON.parse(JSON.stringify(dump.kitchenEquipment));
  S.cookRhythm = JSON.parse(JSON.stringify(dump.cookRhythm));
  S.closedServices = JSON.parse(JSON.stringify(dump.closedServices));
  S.guestsNextWeeks = {} as any;
  S.predictions = {} as any;
  S.deletedBatches = [];
  S.planner = {};
}

export function runFixMyMenu(): { emergencies: number; teams: number; abandoned: number; emergencySlots: string[] } {
  stripFutureServices(S.batches);
  const orphanIds = new Set(findOrphanPlaceholders(S.batches).map(b => b.id));
  S.batches = S.batches.filter(b => !orphanIds.has(b.id));
  const todayIso = dateToIso(getToday());
  const retireIds = new Set([...findSpentBatches(S.batches), ...findStalePlaceholders(S.batches, todayIso)].map(b => b.id));
  S.batches = S.batches.filter(b => !retireIds.has(b.id));

  const planWindow = buildPlanningWindow(getToday());
  const snapshot = snapshotBatches(S.batches, planWindow);
  for (const b of generateMissingPlaceholders(planWindow, snapshot)) S.batches.push(b);
  rebuildPlanner();

  const memoGuests = (loc: any, date: string, meal: any) => getEffectiveGuests(loc, date, meal);
  const calcReqLive = (b: Batch) => calcRequiredLive(b, memoGuests);
  const planBatches = () => S.batches.filter(b => b.cookDate && (b.type === 'Soup' || b.type === 'Main course'));

  let potCaps = allocatePotCaps(planBatches(), S.kitchenEquipment, calcRequired);
  forcedAssignmentPrePass(S.batches, planWindow, calcReqLive, memoGuests, potCaps);
  rebuildPlanner();
  potCaps = allocatePotCaps(planBatches(), S.kitchenEquipment, calcRequired);
  scoredGreedyAssignment(S.batches, planWindow, calcReqLive, memoGuests, potCaps);
  rebuildPlanner();
  const phaseC = runFallbackLadder(S.batches, planWindow, calcReqLive, memoGuests);
  rebuildPlanner();
  const emergencySlots = phaseC.emergencyBatches.map(e => {
    const s = (e.services || [])[0];
    const g = s ? getEffectiveGuests(s.loc, s.date, s.meal) : 0;
    return `${e.type === 'Soup' ? 'S' : 'M'} ${s ? `${s.loc}/${s.date.slice(5)}/${s.meal} g=${g}` : '?'}`;
  });
  return { emergencies: phaseC.emergenciesCreated, teams: phaseC.teamsFormed, abandoned: phaseC.abandoned.length, emergencySlots };
}
