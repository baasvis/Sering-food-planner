// public/js/today-panel.ts
//
// The always-on "Today" guidance panel at the top of the dashboard. Renders
// the per-location daily ritual (from ritual.ts) as a phase-grouped checklist:
// the current phase is emphasised, steps that ticked themselves show a status
// dot, signal-less steps show a tappable check, overdue close-steps go red,
// and each actionable step deep-links to where it's done.
//
// Builds a RitualContext from S + the Amsterdam clock and renders. It's
// re-rendered by the dashboard's 60s tick, so status flips (overdue at 14:30 /
// 21:15, phase changes) appear without a reload. Navigation reuses the global
// onclick handlers registered in main.ts (the app's convention), so this
// module pulls in no screen modules and creates no import cycle.

import { S } from './state';
import { getAmsterdamNow } from './core';
import { todayIso, isRitualStepDone, markRitualStep } from './utils';
import { esc } from './modal';
import { rerenderCurrentView } from './navigate';
import { computeTransportPlan } from './transport-card';
import {
  computeRitual, PHASE_LABEL,
  type RitualContext, type RitualPhase, type RitualStepView, type RitualAction,
} from './ritual';

const PHASE_SEQUENCE: RitualPhase[] = ['morning', 'lunch-close', 'afternoon', 'dinner-close'];

// Status → leading glyph for derived (non-manual) steps. Colour/weight comes
// from the ritual-<status> class; manual steps render a tappable box instead.
const STATUS_GLYPH: Record<RitualStepView['status'], string> = {
  done: '✓',
  active: '●',
  overdue: '!',
  past: '○',
  upcoming: '○',
};

function packPendingFor(loc: string): boolean {
  if (loc !== 'west') return false;
  // computeTransportPlan only returns rows with sendQty > 0, so any row means
  // there's still Centraal-bound stock to pack. rebuildPlanner() has already
  // run — renderDashboardContent calls it before this. 'lean' = the next 3
  // Centraal service slots only (deliberate: pack-send tracks IMMINENT packing,
  // not stock due for slots further out that tonight's pack needn't cover).
  return computeTransportPlan('lean', S.batches).length > 0;
}

/** Build the live ritual view for the current location + clock. */
function currentView() {
  const loc = S.currentLoc;
  const ctx: RitualContext = {
    loc,
    now: getAmsterdamNow(),
    todayIso: todayIso(),
    batches: S.batches,
    inventoryCompletions: S.inventoryCompletions,
    ritualDone: (step) => isRitualStepDone(loc, step),
    packPending: packPendingFor(loc),
  };
  return computeRitual(ctx);
}

// Map a step's action to the onclick that takes the cook there. Reuses the
// global window handlers registered in main.ts.
function goAttr(action: RitualAction, loc: string): string {
  switch (action) {
    case 'inventory': return `onclick="openInventory('${esc(loc)}')"`;
    case 'fmm': return `onclick="fixMyMenu()"`;
    case 'planner': return `onclick="showScreen('planner')"`;
    case 'orders': return `onclick="showScreen('orders')"`;
    case 'transport': return `onclick="showScreen('planner')"`;
    case 'arrivals': return `onclick="ritualScrollToArrivals()"`;
    default: return '';
  }
}

// Which steps are folded open to show their "why". Module-local UI state keyed
// `loc:key`, so it survives the dashboard's frequent re-renders (60s tick, ticks)
// without being persisted — it's purely presentational.
const _expandedWhy = new Set<string>();
function isWhyOpen(loc: string, key: string): boolean {
  return _expandedWhy.has(`${loc}:${key}`);
}

function stepRow(step: RitualStepView, loc: string): string {
  const open = isWhyOpen(loc, step.key);
  const cls = `ritual-step ritual-${step.status}${step.done ? ' is-done' : ''}${open ? ' is-open' : ''}`;
  // Leading control: a manual step gets a tappable check; a derived step gets a
  // read-only status glyph (it can't be ticked by hand — it reflects reality).
  const lead = step.manual
    ? `<button class="ritual-check" role="checkbox" aria-checked="${step.done}"
         onclick="toggleRitualStep('${esc(loc)}','${esc(step.key)}')"
         title="${step.done ? 'Mark not done' : 'Mark done'}">${step.done ? '✓' : ''}</button>`
    : `<span class="ritual-dot" aria-hidden="true">${STATUS_GLYPH[step.status]}</span>`;
  const go = step.action && !step.done
    ? `<button class="ritual-go" ${goAttr(step.action, loc)} aria-label="Go to ${esc(step.label)}">→</button>`
    : '';
  // The label is a disclosure button that folds the "why" open. The why text is
  // ALWAYS in the DOM (hidden by CSS until .is-open) so toggling is a local
  // class flip — never a re-render, so the screen never flashes or scrolls back.
  // Layout: [lead] [label (flex)] [why chip] [go | spacer]. The why chip is its
  // own fixed-width control and the go slot always reserves width, so the chips
  // line up in a vertical column across all rows.
  const goSlot = go || `<span class="ritual-go-spacer" aria-hidden="true"></span>`;
  return `<div class="${cls}" data-step="${esc(step.key)}">
    <div class="ritual-step-row">
      ${lead}
      <button class="ritual-label-btn" onclick="toggleRitualWhy('${esc(loc)}','${esc(step.key)}')" aria-expanded="${open}" title="Why do we do this now?">
        <span class="ritual-label">${esc(step.label)}</span>
      </button>
      <button class="ritual-why-tag" onclick="toggleRitualWhy('${esc(loc)}','${esc(step.key)}')" tabindex="-1" title="Why do we do this now?">why<span class="ritual-chev" aria-hidden="true">›</span></button>
      ${goSlot}
    </div>
    <div class="ritual-why">${esc(step.why)}</div>
  </div>`;
}

/** Render the "Today" panel HTML for the current location. */
export function renderTodayPanel(): string {
  const view = currentView();
  if (!view.steps.length) return '';

  const allDone = view.doneCount === view.total;
  const overdueCount = view.steps.filter(s => s.status === 'overdue').length;

  // Group steps by phase, in day order, dropping phases with no steps.
  const groups = PHASE_SEQUENCE
    .map(phase => ({ phase, steps: view.steps.filter(s => s.phase === phase) }))
    .filter(g => g.steps.length > 0);

  const body = groups.map(g => {
    const isNow = g.phase === view.phase;
    const rows = g.steps.map(s => stepRow(s, view.loc)).join('');
    return `<div class="ritual-phase${isNow ? ' ritual-phase-now' : ''}">
      <div class="ritual-phase-head">${esc(PHASE_LABEL[g.phase])}${isNow ? ' <span class="ritual-now-tag">now</span>' : ''}</div>
      ${rows}
    </div>`;
  }).join('');

  const statusLine = allDone
    ? `<span class="ritual-alldone">All done for today 🎉</span>`
    : overdueCount > 0
      ? `<span class="ritual-overdue-tag">${overdueCount} overdue</span>`
      : '';

  return `<div class="dash-card ritual-panel${allDone ? ' is-alldone' : ''}" data-loc="${esc(view.loc)}">
    <div class="dash-card-title">
      <span class="dash-card-icon">📋</span> Today
      <span class="ritual-progress">${view.doneCount}/${view.total}</span>
      ${statusLine}
    </div>
    <div class="ritual-hint">Tap a step to see why we do it now.</div>
    <div class="ritual-body">${body}</div>
  </div>`;
}

// ── Handlers (registered on window in main.ts) ───────────────────────────

/** Toggle a manual ritual step and re-render. */
export function toggleRitualStep(loc: string, key: string): void {
  markRitualStep(loc, key, !isRitualStepDone(loc, key));
  rerenderCurrentView();
}

/** Fold a step open/closed to show why the action happens at this time. Flips
 *  just this step's class in place — NO re-render, so the dashboard doesn't
 *  flash or scroll back to the top. _expandedWhy keeps the open set so the next
 *  legitimate re-render (60s tick, location switch, a tick) restores it. */
export function toggleRitualWhy(loc: string, key: string): void {
  const id = `${loc}:${key}`;
  const opening = !_expandedWhy.has(id);
  if (opening) _expandedWhy.add(id); else _expandedWhy.delete(id);
  const el = document.querySelector(`.ritual-panel[data-loc="${loc}"] .ritual-step[data-step="${key}"]`);
  if (!el) return;
  el.classList.toggle('is-open', opening);
  const btn = el.querySelector('.ritual-label-btn');
  if (btn) btn.setAttribute('aria-expanded', String(opening));
}

/** Scroll the Centraal arrival banner into view (the arrivals step's "go"). */
export function ritualScrollToArrivals(): void {
  const el = document.querySelector('.dash-arrival-block') as HTMLElement | null;
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
