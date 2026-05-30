// public/js/ritual.ts
//
// The daily-ritual MODEL: the per-location list of steps that make up a day's
// operational flow, each with a pure `done(ctx)` predicate, plus the clock /
// phase and order-day logic that drives the dashboard "Today" panel.
//
// Design rule (see CLAUDE.md + project memory): a step's done-ness is DERIVED
// from real domain state wherever a signal exists (inventory completions,
// batch cookDate, shipments, placeholder replacement). Only steps with NO
// observable signal read the persisted RitualCompletion store via
// `ctx.ritualDone()`. Nothing in this file mutates state or touches the DOM —
// it's pure and unit-testable; the panel constructs the context and renders,
// and Slice-4 auto-ticks call markRitualStep() from the relevant actions.

import type { Batch, Location } from '@shared/types';

// ── Clock thresholds (Amsterdam local minutes-of-day) ────────────────────
// Confirmed with Daan 2026-05-30. Soft deadlines ~13:45 / ~20:45; hard
// "overdue" backstops at 14:30 (lunch close) and 21:15 (dinner close).
const LUNCH_CLOSE_FROM = 13 * 60 + 45;   // 13:45
const LUNCH_OVERDUE = 14 * 60 + 30;      // 14:30
const AFTERNOON_FROM = 17 * 60;          // 17:00
const DINNER_CLOSE_FROM = 20 * 60 + 45;  // 20:45
const DINNER_OVERDUE = 21 * 60 + 15;     // 21:15

export type RitualPhase = 'morning' | 'lunch-close' | 'afternoon' | 'dinner-close';

const PHASE_ORDER: RitualPhase[] = ['morning', 'lunch-close', 'afternoon', 'dinner-close'];

export const PHASE_LABEL: Record<RitualPhase, string> = {
  'morning': 'Morning',
  'lunch-close': 'After lunch',
  'afternoon': 'Afternoon',
  'dinner-close': 'After dinner',
};

// Order days: Monday, Tuesday, Thursday (both locations). Ingredients arrive
// the next day. JS getDay(): Sun=0 .. Sat=6.
const ORDER_DAYS = new Set([1, 2, 4]);

function minutesOfDay(now: Date): number {
  return now.getHours() * 60 + now.getMinutes();
}

/** Which ritual phase the clock is in. `now` must be Amsterdam local time —
 *  the panel passes getAmsterdamNow(), the same source the meal toggle uses. */
export function currentPhase(now: Date): RitualPhase {
  const m = minutesOfDay(now);
  if (m < LUNCH_CLOSE_FROM) return 'morning';
  if (m < AFTERNOON_FROM) return 'lunch-close';
  if (m < DINNER_CLOSE_FROM) return 'afternoon';
  return 'dinner-close';
}

/** True on Mon/Tue/Thu — the days an order goes to Hanos (both locations). */
export function isOrderDay(now: Date): boolean {
  return ORDER_DAYS.has(now.getDay());
}

/** A West Fix-My-Menu run maps to the lunch or dinner ritual depending on when
 *  it's run (split at 17:00, the same boundary as the afternoon phase). Lets
 *  the panel tell the ~13:45 run apart from the ~20:45 one. */
export function fixMyMenuRitualStep(now: Date): 'fmm-lunch' | 'fmm-dinner' {
  return minutesOfDay(now) < AFTERNOON_FROM ? 'fmm-lunch' : 'fmm-dinner';
}

// ── Context the predicates read ──────────────────────────────────────────

export interface RitualContext {
  loc: Location;
  /** Amsterdam local "now". */
  now: Date;
  /** Local Y-M-D for `now` (today), matching Service.date format. */
  todayIso: string;
  batches: Batch[];
  /** Server-persisted inventory completion timestamps per loc/window. */
  inventoryCompletions: Record<string, { lunch: string | null; dinner: string | null }>;
  /** Reads S.ritualCompletions[loc] — for steps with no derivable signal. */
  ritualDone: (step: string) => boolean;
  /** West only: true if Centraal-bound stock still needs packing (the
   *  transport plan has sendable rows). Passed in because computing it needs
   *  the planner's family-allocation cache, which isn't pure over `batches`. */
  packPending: boolean;
}

// ── Derived-signal helpers (pure over ctx) ───────────────────────────────

function startOfTodayMs(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

/** An inventory window counts as done if its completion timestamp is today. */
function inventoryFresh(ctx: RitualContext, window: 'lunch' | 'dinner'): boolean {
  const iso = ctx.inventoryCompletions[ctx.loc]?.[window] ?? null;
  if (!iso) return false;
  const t = Date.parse(iso);
  return !isNaN(t) && t >= startOfTodayMs(ctx.now);
}

/** Every batch with a West service today has a cookDate (cooking done).
 *  Empty set is trivially done. Mirrors transport-card getReadiness. */
function cooksDone(ctx: RitualContext): boolean {
  for (const b of ctx.batches) {
    const hasTodayWest = (b.services || []).some(s => s.loc === 'west' && s.date === ctx.todayIso);
    if (!hasTodayWest) continue;
    if (!b.cookDate) return false;
  }
  return true;
}

/** No shipment is still in flight toward Centraal. */
function noPendingArrivals(ctx: RitualContext): boolean {
  return !ctx.batches.some(b => (b.shipments || []).some(s => s.toLoc === 'centraal' && !s.arrived));
}

/** No generated placeholder (generated && no recipe) still has an upcoming
 *  service — i.e. cooks have replaced them with real recipes so the order's
 *  dish-ingredient demand is accurate. */
function placeholdersReplaced(ctx: RitualContext): boolean {
  return !ctx.batches.some(b =>
    b.generated === true && !b.recipeId &&
    (b.services || []).some(s => s.date >= ctx.todayIso));
}

// ── Step definitions ─────────────────────────────────────────────────────

export type StepStatus = 'done' | 'active' | 'overdue' | 'past' | 'upcoming';

export type RitualAction = 'inventory' | 'fmm' | 'planner' | 'orders' | 'transport' | 'arrivals' | null;

export interface RitualStep {
  key: string;
  label: string;
  phase: RitualPhase;
  /** Hard overdue deadline in minutes-of-day, or null for no hard backstop. */
  overdueAfter: number | null;
  /** Only show on order days (Mon/Tue/Thu). */
  orderDayOnly?: boolean;
  /** Deep-link target for the panel's "go" affordance (wired in Slice 3). */
  action: RitualAction;
  /** True iff this step has no derivable signal and is ticked by hand (so the
   *  panel can render a checkbox rather than a read-only status dot). */
  manual?: boolean;
  /** One-line rationale — why this action happens at this point in the day.
   *  Shown when the cook folds the step open in the panel. */
  why: string;
  done: (ctx: RitualContext) => boolean;
}

const WEST_STEPS: RitualStep[] = [
  { key: 'cook-underway', label: "Cook today's food", phase: 'morning', overdueAfter: null, action: 'planner',
    why: 'Start cooking as early as possible in the day. This leaves time for the food to cook, cool down, and to be packed for Centraal.',
    done: cooksDone },
  { key: 'inv-lunch', label: 'Cooked-food inventory', phase: 'lunch-close', overdueAfter: LUNCH_OVERDUE, action: 'inventory',
    why: 'After lunch, count the cooked food. Based on these numbers the plan for this evening, and the rest of the week is made. The earlier we know what is up, the better. Count both the cold food, and the food still in pots.',
    done: (c) => inventoryFresh(c, 'lunch') },
  { key: 'fmm-lunch', label: 'Run Fix My Menu', phase: 'lunch-close', overdueAfter: LUNCH_OVERDUE, action: 'fmm',
    why: 'After inventory is done both here, and at Centraal, run "Fix My Menu". Based on how busy it was during lunch the food will be redivided over both locations. It will warn you if there is a problem after this reorganisation.',
    done: (c) => c.ritualDone('fmm-lunch') },
  { key: 'replace-placeholders', label: 'Replace placeholders with recipes', phase: 'afternoon', overdueAfter: null, orderDayOnly: true, action: 'planner',
    why: 'On order days, change the placeholder dishes into real recipes first. The order is based on the recipes.',
    done: placeholdersReplaced },
  { key: 'stocktake', label: 'Ingredient stocktake', phase: 'afternoon', overdueAfter: null, orderDayOnly: true, action: 'orders', manual: true,
    why: 'Count your ingredients before you order. Then the amount to order is correct.',
    done: (c) => c.ritualDone('stocktake') },
  { key: 'inv-dinner', label: 'Cooked-food inventory', phase: 'dinner-close', overdueAfter: DINNER_OVERDUE, action: 'inventory',
    why: 'At dinner, count the cooked food that is leftover from the day. Make sure the food that has been cooked this day is counted as well. Our plans for tomorrow and the upcoming days depend on these numbers.',
    done: (c) => inventoryFresh(c, 'dinner') },
  { key: 'fmm-dinner', label: 'Run Fix My Menu', phase: 'dinner-close', overdueAfter: DINNER_OVERDUE, action: 'fmm',
    why: 'After counting, run Fix My Menu. It will redivide the food over the upcoming services. It will tell you if there are problems.',
    done: (c) => c.ritualDone('fmm-dinner') },
  { key: 'pack-send', label: 'Pack & send for Centraal', phase: 'dinner-close', overdueAfter: DINNER_OVERDUE, action: 'transport',
    why: "Pack Centraal's food tonight. It will be picked up early in the morning, when there is no time to pack.",
    done: (c) => !c.packPending },
  { key: 'hanos-order', label: 'Place Hanos order', phase: 'dinner-close', overdueAfter: DINNER_OVERDUE, orderDayOnly: true, action: 'orders', manual: true,
    why: 'Order now, when the plan is ready. The ingredients arrive the next day.',
    done: (c) => c.ritualDone('hanos-order') },
];

const CENTRAAL_STEPS: RitualStep[] = [
  { key: 'arrivals', label: 'Confirm transport arrived', phase: 'morning', overdueAfter: null, action: 'arrivals',
    why: 'Say yes when the food arrives. It goes into your stock, so your numbers stay correct.',
    done: noPendingArrivals },
  { key: 'service-lunch', label: 'Set up lunch service', phase: 'morning', overdueAfter: null, action: null, manual: true,
    why: 'Set up lunch before the guests come.',
    done: (c) => c.ritualDone('service-lunch') },
  { key: 'inv-lunch', label: 'Cooked-food inventory', phase: 'lunch-close', overdueAfter: LUNCH_OVERDUE, action: 'inventory',
    why: 'After lunch, count the cooked food. Do it as close to 13:45 as possible! The people at West are waiting on your inventory to make the cooking plan. Count both the cold food, and the food still in pots.',
    done: (c) => inventoryFresh(c, 'lunch') },
  { key: 'service-dinner', label: 'Set up dinner service', phase: 'afternoon', overdueAfter: null, action: null, manual: true,
    why: 'Set up dinner before the evening.',
    done: (c) => c.ritualDone('service-dinner') },
  { key: 'stocktake', label: 'Ingredient stocktake', phase: 'afternoon', overdueAfter: null, orderDayOnly: true, action: 'orders', manual: true,
    why: 'Count your ingredients before you order. Then the amount to order is correct.',
    done: (c) => c.ritualDone('stocktake') },
  { key: 'inv-dinner', label: 'Cooked-food inventory', phase: 'dinner-close', overdueAfter: DINNER_OVERDUE, action: 'inventory',
    why: 'At the end of the day, count the cooked food. Do this around 20:45 if possible! The people at West are waiting on this info for placing their order and packing the food for tomorrow.',
    done: (c) => inventoryFresh(c, 'dinner') },
  { key: 'hanos-order', label: 'Place Hanos order', phase: 'dinner-close', overdueAfter: DINNER_OVERDUE, orderDayOnly: true, action: 'orders', manual: true,
    why: 'Order now. The ingredients arrive the next day.',
    done: (c) => c.ritualDone('hanos-order') },
];

export function stepsForLocation(loc: Location): RitualStep[] {
  return loc === 'west' ? WEST_STEPS : CENTRAAL_STEPS;
}

// ── Compute the panel's view model ───────────────────────────────────────

export interface RitualStepView {
  key: string;
  label: string;
  phase: RitualPhase;
  action: RitualAction;
  manual: boolean;
  why: string;
  done: boolean;
  status: StepStatus;
}

export interface RitualView {
  loc: Location;
  phase: RitualPhase;
  isOrderDay: boolean;
  steps: RitualStepView[];
  doneCount: number;
  total: number;
}

function statusFor(step: RitualStep, done: boolean, now: Date, phase: RitualPhase): StepStatus {
  if (done) return 'done';
  const m = minutesOfDay(now);
  // Hard backstop wins: an undone close-step past its deadline is overdue (red)
  // regardless of which phase the clock is technically in.
  if (step.overdueAfter != null && m >= step.overdueAfter) return 'overdue';
  if (step.phase === phase) return 'active';
  const stepIdx = PHASE_ORDER.indexOf(step.phase);
  const curIdx = PHASE_ORDER.indexOf(phase);
  if (stepIdx < curIdx) return 'past';      // window passed, no hard deadline (amber)
  return 'upcoming';
}

/** Build the full view model for the dashboard "Today" panel. Pure given ctx
 *  — the panel constructs ctx from S + getAmsterdamNow() and renders the
 *  result. Order-day-only steps are dropped on non-order days. */
export function computeRitual(ctx: RitualContext): RitualView {
  const phase = currentPhase(ctx.now);
  const order = isOrderDay(ctx.now);
  const steps: RitualStepView[] = [];
  let doneCount = 0;
  for (const step of stepsForLocation(ctx.loc)) {
    if (step.orderDayOnly && !order) continue;
    const done = step.done(ctx);
    if (done) doneCount++;
    steps.push({
      key: step.key,
      label: step.label,
      phase: step.phase,
      action: step.action,
      manual: step.manual === true,
      why: step.why,
      done,
      status: statusFor(step, done, ctx.now, phase),
    });
  }
  return { loc: ctx.loc, phase, isOrderDay: order, steps, doneCount, total: steps.length };
}
