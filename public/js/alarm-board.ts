// ── ALARM BOARD ─────────────────────────────────────────────────────────────
// Live "issues to fix" counter for the West planner header. Unlike the
// Fix-My-Menu results modal (a one-shot report after a run), this recomputes
// on every planner render, so the count is always current: fix the plan and
// the counter drops without pressing any button.
//
// Checks (7-day horizon, both locations — West production fixes them all):
//   • emergency-dish     — auto-created Emergency stand-ins still serving a slot
//   • cooked-stockout    — cooked batches whose stock won't cover their demand
//   • stale-with-stock   — 4+ day-old unfrozen stock: taste-check, keep serving, freeze, or write off
//   • over-pot-cap       — upcoming cooks whose demand won't fit the biggest pot
//   • catering-no-dishes — dated caterings this week with nothing picked
// The last four reuse the exact collectWarnings check functions from
// menu-fixer.ts, so the live board can never drift from what Fix My Menu
// reports after a run.

import type { Batch } from '@shared/types';
import { addDays } from '@shared/dates';
import { S } from './state';
import { calcRequired, dateToDayName, dateToIso, getTotalStock, getToday, isServiceClosed, isServicePast } from './core';
import type { Warning } from './menu-fixer';
import {
  PLANNING_HORIZON_DAYS, cateringNoDishesWarnings, cookDateToIso,
  overPotCapWarnings, showIssuesModal, staleStockWarnings, stockoutWarnings,
} from './menu-fixer';
import { trackEvent } from './telemetry';

/** Emergency stand-ins (fallback-ladder placeholders + "Emergency morning
 *  cook" batches) still assigned to an upcoming service. Both creation sites
 *  stamp cookNotes with an 'Emergency…' marker and `generated: true`; filling
 *  in a real recipe flips `generated` off (planner.ts / recipes.ts), which
 *  clears the alarm.
 *
 *  Deliberate: a COOKED emergency (stock > 0) keeps alarming until replaced —
 *  the pot exists, but the dish still has no identity (name/recipe), so
 *  menus, allergens and cost tracking are all broken until someone runs the
 *  replace-placeholder flow. Only the message changes to say so. */
export function emergencyDishAlarms(batches: Batch[], horizonEndIso: string): Warning[] {
  const alarms: Warning[] = [];
  const mealRank = { lunch: 0, dinner: 1 } as const;
  for (const b of batches) {
    if (b.generated !== true) continue;
    if (!(b.cookNotes || '').startsWith('Emergency')) continue;
    const upcoming = (b.services || [])
      .filter(s => !isServicePast(s) && !isServiceClosed(s.loc, s.date, s.meal) && s.date <= horizonEndIso)
      .sort((a, z) => a.date === z.date ? mealRank[a.meal] - mealRank[z.meal] : (a.date < z.date ? -1 : 1));
    if (upcoming.length === 0) continue;
    const first = upcoming[0];
    const locLabel = first.loc === 'centraal' ? 'Centraal' : 'West';
    const slot = `${dateToDayName(first.date)} ${first.meal} at ${locLabel}` +
      (upcoming.length > 1 ? ` (+${upcoming.length - 1} more service${upcoming.length === 2 ? '' : 's'})` : '');
    alarms.push({
      category: 'emergency-dish',
      message: getTotalStock(b) > 0
        ? `${slot} is serving "${b.name}" — cooked as an emergency stand-in, still no recipe. Fill in what it actually is so the menu, allergens and costs stay right.`
        : `${slot} is counting on "${b.name}" — an emergency stand-in with no recipe. Decide what will actually be cooked.`,
      anchor: { kind: 'batch', batchId: b.id },
    });
  }
  return alarms;
}

/** All live alarms over the next PLANNING_HORIZON_DAYS days. Uses the cached
 *  demand numbers (calcRequired), so call after rebuildPlanner() — true on
 *  every render path, same as diffStr and the too-big badge. */
export function collectLiveAlarms(): Warning[] {
  const today = getToday();
  const todayIso = dateToIso(today);
  // addDays, not epoch math: +6×86400000 lands on day+5 across the October
  // DST fall-back and silently shrinks the horizon by a day (review finding).
  const horizonEnd = dateToIso(addDays(today, PLANNING_HORIZON_DAYS - 1));
  const batches = S.batches || [];

  const alarms: Warning[] = [];
  alarms.push(...emergencyDishAlarms(batches, horizonEnd));
  alarms.push(...stockoutWarnings(batches, calcRequired));
  alarms.push(...staleStockWarnings(batches, todayIso));
  // Too-large only matters while the cook can still act on it — batches whose
  // cook day is today or later. (Post-FMM the same check runs unwindowed.)
  const upcomingCooks = batches.filter(b => {
    const iso = cookDateToIso(b.cookDate);
    return !!iso && iso >= todayIso;
  });
  alarms.push(...overPotCapWarnings(upcomingCooks, calcRequired, S.kitchenEquipment || null));
  alarms.push(...cateringNoDishesWarnings(S.caterings || [], todayIso, horizonEnd));
  return alarms;
}

/** The issue counter for the West planner header, next to the reserve
 *  control. Red + pulsing (same treatment as the Do-Inventory button) while
 *  there are open issues; a quiet check when the plan is clean. */
export function renderAlarmCounter(): string {
  const n = collectLiveAlarms().length;
  const cls = n > 0 ? 'alarm-urgent' : 'alarm-clear';
  const label = n > 0 ? `🚨 ${n} issue${n === 1 ? '' : 's'}` : '✓ No issues';
  return `<button class="btn alarm-ctl ${cls}" data-testid="alarm-counter" onclick="openAlarmBoard()" title="Live planning issues the production kitchen needs to fix — emergency stand-ins, food running out, oversized batches, old stock, caterings without dishes.">${label}</button>`;
}

/** Open the issue list — the same grouped modal as Fix My Menu's results,
 *  with go-to and quick actions, recomputed fresh on every open. */
export function openAlarmBoard(): void {
  trackEvent('alarm_board_open');
  showIssuesModal(collectLiveAlarms(), '🚨 Planning issues');
}
