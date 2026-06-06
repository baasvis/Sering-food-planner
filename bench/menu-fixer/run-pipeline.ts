// Drives the REAL Fix-My-Menu pipeline against the global S, for the
// bench/repro. Assumes S is already loaded and the system clock is mocked to
// the anchor day. Calls the production core (`runFixMyMenuCore`) directly so
// the bench can never silently drift from the live engine — it scores exactly
// what `_fixMyMenuBody` runs, minus the UI/persistence side-effects the core
// deliberately leaves out.
import { runFixMyMenuCore } from '../../public/js/menu-fixer';
import { S } from '../../public/js/state';
import { getEffectiveGuests } from '../../public/js/core';

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
  const result = runFixMyMenuCore();
  const emergencySlots = result.emergencyBatches.map(e => {
    const s = (e.services || [])[0];
    const g = s ? getEffectiveGuests(s.loc, s.date, s.meal) : 0;
    return `${e.type === 'Soup' ? 'S' : 'M'} ${s ? `${s.loc}/${s.date.slice(5)}/${s.meal} g=${g}` : '?'}`;
  });
  return {
    emergencies: result.emergenciesCreated,
    teams: result.teamsFormed,
    abandoned: result.abandoned.length,
    emergencySlots,
  };
}
