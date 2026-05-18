// ─────────────────────────────────────────────────────────────────────────────
// Transport card — "Pack for Centraal — tomorrow"
//
// Lives on the West dashboard only. Surfaces what should leave Sering West for
// Sering Centraal in the next 3 Centraal service slots, after subtracting
// stock that's already at Centraal. "Pack and send" calls
// POST /api/batches/:id/ship per row — backend handles pack-accumulation
// (same toLoc + storage + cookDate folds into an existing pending shipment)
// so the frontend doesn't need to dedupe.
//
// Pure logic (computeTransportPlan, readiness helpers) is exported separately
// from the DOM render/confirm so the same code can be unit-tested without a
// browser.
// ─────────────────────────────────────────────────────────────────────────────
import type { Batch, Service, Location, DishType } from '@shared/types';
import { S } from './state';
import { isBatchCooked, calcRequiredAtService, isServicePast, getToday, dateToIso, rebuildPlanner, getStockAt, getServeableStockAt, getPendingFromShipments } from './core';
import { esc } from './modal';
import { trackEvent } from './telemetry';
import { rerenderCurrentView } from './navigate';
import { toast, toastError, apiPost } from './utils';

export type TransportMode = 'lean' | 'bulk';

export interface TransportRow {
  /** West batch this row sources from. */
  batchId: string;
  /** Display name (split suffix preserved). */
  name: string;
  type: DishType;
  /** Liters demanded at Centraal across all in-window services for this batch. */
  totalDemand: number;
  /** Liters of the same dish already cooked-and-arrived at Centraal. */
  destStock: number;
  /** What to actually send (max(0, demand - destStock)), capped at the
   *  batch's available West stock. */
  sendQty: number;
  /** Human-readable list of which services this row covers. */
  services: Array<{ date: string; meal: string }>;
  /** True if any of `services` is beyond the 3-slot lean horizon (only set in
   *  bulk mode). Lets the UI mark consolidation rows distinctly. */
  future: boolean;
}

export interface ReadinessState {
  inventoryDone: boolean;
  cookDone: boolean;
  fixMyMenuRun: boolean;
  /** True iff all three above are true. The card is "lit" in this case. */
  allReady: boolean;
}

const FIX_MY_MENU_RUN_KEY = 'sering-fix-my-menu-last-run';

// How far ahead bulk mode looks (in days) when consolidating extra services
// onto already-shipping dishes.
const BULK_HORIZON_DAYS = 7;

// Card-level UI state. Stored module-locally because it's purely visual and
// doesn't need cross-tab persistence.
let _mode: TransportMode = 'lean';

// ── Public helpers ───────────────────────────────────────────────────────

/** Mark Fix My Menu as run *now*. Called from menu-fixer.ts at the end of
 *  `fixMyMenu()` so the dashboard readiness banner can flip to green. */
export function markFixMyMenuRun(): void {
  try {
    localStorage.setItem(FIX_MY_MENU_RUN_KEY, new Date().toISOString());
  } catch (_e: unknown) {
    // Private-mode browsers can throw on setItem — silently ignore. The
    // banner stays at "fix my menu" indefinitely, which is the safe default.
  }
}

/** Returns true iff Fix My Menu was run at any point during the current local
 *  calendar day. */
export function wasFixMyMenuRunToday(now: Date = new Date()): boolean {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(FIX_MY_MENU_RUN_KEY);
  } catch (_e: unknown) {
    return false;
  }
  if (!stored) return false;
  const t = Date.parse(stored);
  if (isNaN(t)) return false;
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return t >= startOfToday;
}

// ── Dish equality ────────────────────────────────────────────────────────
//
// Used both for destination-stock subtraction (find Centraal batches of "the
// same dish" as a West row) and for bulk-mode consolidation (find other West
// batches of the same dish that should ship together). Convention matches
// what consolidateFamilies uses internally: prefer recipeId; fall back to a
// normalized lowercase name with the trailing " (split)" suffix stripped.

/** Identity key for a dish — `recipeId` if set, otherwise normalized name. */
export function dishIdentity(b: Batch): string {
  if (b.recipeId) return `r:${b.recipeId}`;
  const stripped = (b.name || '').replace(/ \(split\)$/i, '').trim().toLowerCase();
  return `n:${stripped}`;
}

// ── Lookahead window ─────────────────────────────────────────────────────

interface SlotKey {
  date: string;
  meal: string;
  /** Slot key as used by S.planner: `loc-date-meal`. Always loc='centraal'. */
  key: string;
}

function compareSlots(a: { date: string; meal: string }, b: { date: string; meal: string }): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.meal === b.meal) return 0;
  return a.meal === 'lunch' ? -1 : 1;
}

/** Find the next N distinct Centraal service slots in chronological order,
 *  starting from `today` (or the cook's "now"). Past slots are excluded via
 *  isServicePast — same gating that calcRequired and the family allocator
 *  use. */
export function nextCentraalSlots(batches: Batch[], n: number): SlotKey[] {
  const seen = new Set<string>();
  const slots: SlotKey[] = [];
  for (const b of batches) {
    for (const svc of b.services || []) {
      if (svc.loc !== 'centraal') continue;
      if (isServicePast(svc)) continue;
      const k = `${svc.loc}-${svc.date}-${svc.meal}`;
      if (seen.has(k)) continue;
      seen.add(k);
      slots.push({ date: svc.date, meal: svc.meal, key: k });
    }
  }
  slots.sort(compareSlots);
  return slots.slice(0, n);
}

// ── Plan computation ─────────────────────────────────────────────────────

/** Compute the transport plan rows for "today/tomorrow's" pack-and-send.
 *
 *  IMPORTANT: this function reads from the family-allocation cache that
 *  rebuildPlanner refreshes (via calcRequiredAtService). Callers must have
 *  invoked rebuildPlanner() before calling this — see renderTransportCard
 *  below which does so.
 *
 *  Returns rows sorted by dish type then name. */
export function computeTransportPlan(mode: TransportMode, batches: Batch[]): TransportRow[] {
  const horizonSlots = nextCentraalSlots(batches, 3);
  if (horizonSlots.length === 0) return [];
  const horizonKeys = new Set(horizonSlots.map(s => s.key));

  // For bulk mode: every Centraal service that's not past *and* is within
  // BULK_HORIZON_DAYS of today (so we don't pull a shipment 6 weeks out into
  // the next-3-slot pack).
  const bulkCutoffMs = (() => {
    if (mode !== 'bulk') return -Infinity;
    const today = getToday();
    const cutoff = new Date(today);
    cutoff.setDate(today.getDate() + BULK_HORIZON_DAYS);
    return cutoff.getTime();
  })();

  function svcInBulk(svc: Service): boolean {
    if (mode !== 'bulk') return false;
    if (svc.loc !== 'centraal') return false;
    if (isServicePast(svc)) return false;
    const t = new Date(svc.date + 'T12:00:00').getTime();
    return t <= bulkCutoffMs;
  }

  // Step 1: collect West batches that contribute to lean (in-horizon) demand.
  // Seed identity → row map keyed on dishIdentity so bulk mode can fold extra
  // services onto the same row.
  type Accum = {
    batch: Batch;
    inHorizonDemand: number;
    extraDemand: number; // bulk-only addition
    services: Array<{ date: string; meal: string }>;
    extraServices: Array<{ date: string; meal: string }>;
  };
  const acc = new Map<string, Accum>(); // key = batch.id
  const includedBatchIds = new Set<string>();

  // Lean pass — populate rows for any batch with stock at West that has a
  // Centraal service within the 3-slot horizon. Unified-batch model: a
  // batch is a "West batch" iff it has any qty at loc=west; there's no
  // single `b.location` anymore. inTransit is replaced by per-shipment
  // pending, and Pack-for-Centraal only cares about settled West stock.
  for (const b of batches) {
    if (getStockAt(b, 'west') <= 0) continue;
    if (!isBatchCooked(b)) continue;
    let demand = 0;
    const svcs: Array<{ date: string; meal: string }> = [];
    for (const svc of b.services || []) {
      if (svc.loc !== 'centraal') continue;
      const k = `${svc.loc}-${svc.date}-${svc.meal}`;
      if (!horizonKeys.has(k)) continue;
      const liters = calcRequiredAtService(b, svc);
      if (liters <= 0) continue;
      demand += liters;
      svcs.push({ date: svc.date, meal: svc.meal });
    }
    if (demand > 0) {
      acc.set(b.id, { batch: b, inHorizonDemand: demand, extraDemand: 0, services: svcs, extraServices: [] });
      includedBatchIds.add(b.id);
    }
  }

  // Bulk pass — for every dish identity already in `acc`, find ALL batches
  // with West stock of that same identity and fold their bulk-horizon
  // Centraal demand in.
  if (mode === 'bulk') {
    const includedIdentities = new Set<string>();
    for (const a of acc.values()) includedIdentities.add(dishIdentity(a.batch));

    for (const b of batches) {
      if (getStockAt(b, 'west') <= 0) continue;
      if (!isBatchCooked(b)) continue;
      if (!includedIdentities.has(dishIdentity(b))) continue;

      // Pull this batch's bulk-window services that are NOT in the lean horizon.
      let extraDemand = 0;
      const extraSvcs: Array<{ date: string; meal: string }> = [];
      for (const svc of b.services || []) {
        if (!svcInBulk(svc)) continue;
        const k = `${svc.loc}-${svc.date}-${svc.meal}`;
        if (horizonKeys.has(k)) continue;
        const liters = calcRequiredAtService(b, svc);
        if (liters <= 0) continue;
        extraDemand += liters;
        extraSvcs.push({ date: svc.date, meal: svc.meal });
      }

      if (extraDemand <= 0) continue;

      // If this batch is already in `acc`, just append. Otherwise create a
      // bulk-only row.
      const existing = acc.get(b.id);
      if (existing) {
        existing.extraDemand += extraDemand;
        existing.extraServices.push(...extraSvcs);
      } else {
        acc.set(b.id, {
          batch: b,
          inHorizonDemand: 0,
          extraDemand,
          services: [],
          extraServices: extraSvcs,
        });
        includedBatchIds.add(b.id);
      }
    }
  }

  // Step 2: build rows with destination-stock subtraction. Per audit S12 the
  // cross-batch dedup-by-recipe-identity stays — two different West batches
  // of the same dish should both subtract from the same Centraal stock pile.
  const destStockByIdentity = new Map<string, number>();
  for (const b of batches) {
    if (!isBatchCooked(b)) continue;
    // Settled = stock already at Centraal that's directly servable. Frozen
    // at Centraal doesn't count (it has to thaw before it can serve, so
    // it shouldn't reduce what we pack today). In-flight pending shipments
    // to Centraal also reduce what to pack — covered by an earlier fix.
    const settled = getServeableStockAt(b, 'centraal');
    const inFlight = getPendingFromShipments(b, 'centraal');
    if (settled + inFlight <= 0) continue;
    const key = dishIdentity(b);
    destStockByIdentity.set(key, (destStockByIdentity.get(key) || 0) + settled + inFlight);
  }

  const rows: TransportRow[] = [];
  // Track destination stock that's already been consumed by an earlier row of
  // the same identity, so two West batches of the same dish don't both think
  // they have access to the full Centraal pile.
  const destStockUsedByIdentity = new Map<string, number>();

  for (const a of acc.values()) {
    const totalDemand = a.inHorizonDemand + a.extraDemand;
    const identity = dishIdentity(a.batch);
    const destStockTotal = destStockByIdentity.get(identity) || 0;
    const alreadyUsed = destStockUsedByIdentity.get(identity) || 0;
    const destStockAvailable = Math.max(0, destStockTotal - alreadyUsed);
    const netDemand = Math.max(0, totalDemand - destStockAvailable);
    // Cap sendQty at the batch's available West stock (was b.stock; now
    // getStockAt(b, 'west')). Backend's /ship endpoint also caps and surfaces
    // a warning, so this is a hint not a hard limit.
    const sendQty = Math.min(netDemand, getStockAt(a.batch, 'west'));
    if (sendQty <= 0) continue;
    const consumedThisRow = Math.min(destStockAvailable, totalDemand);
    destStockUsedByIdentity.set(identity, alreadyUsed + consumedThisRow);
    rows.push({
      batchId: a.batch.id,
      name: a.batch.name,
      type: a.batch.type,
      totalDemand: round1(totalDemand),
      destStock: round1(Math.min(destStockAvailable, totalDemand)),
      sendQty: round1(sendQty),
      services: [...a.services, ...a.extraServices].sort(compareSlots),
      future: a.extraServices.length > 0,
    });
  }

  // Sort: type order (Soup, Main course, Dessert), then by name.
  const typeOrder: Record<string, number> = { 'Soup': 0, 'Main course': 1, 'Dessert': 2 };
  rows.sort((a, b) => (typeOrder[a.type] ?? 9) - (typeOrder[b.type] ?? 9) || a.name.localeCompare(b.name));
  return rows;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Count batches that *would* be in the lean plan if they were cooked —
 *  i.e. they have a Centraal service in the next-3-slot horizon and
 *  `isBatchCooked` is currently false. Used to differentiate the empty-state
 *  message: "nothing scheduled" vs "scheduled but not yet cooked".
 *
 *  Unified-batch model: a "would be cooked at West" batch is any uncooked
 *  batch with a Centraal-direction service in the lean horizon. We don't
 *  filter by location because uncooked batches have no inventory yet —
 *  cookLoc is decided at confirmCooked time. */
export function countPendingUncookedForCentraal(batches: Batch[]): number {
  const horizonSlots = nextCentraalSlots(batches, 3);
  if (horizonSlots.length === 0) return 0;
  const horizonKeys = new Set(horizonSlots.map(s => s.key));
  let count = 0;
  for (const b of batches) {
    if (isBatchCooked(b)) continue;
    const hasInHorizon = (b.services || []).some(svc => {
      if (svc.loc !== 'centraal') return false;
      return horizonKeys.has(`${svc.loc}-${svc.date}-${svc.meal}`);
    });
    if (hasInHorizon) count++;
  }
  return count;
}

// ── Readiness banner ─────────────────────────────────────────────────────

/** Compute the "ritual ready" state: today's inventory finished, today's cook
 *  marked done, and Fix My Menu run today. None of these gate the action;
 *  the card just lights up when all are true. */
export function getReadiness(batches: Batch[], inventoryCompletions: typeof S.inventoryCompletions, now: Date = new Date()): ReadinessState {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const todayIsoStr = dateToIso(now);

  // Inventory: any window finished today at *either* location counts. The
  // West cook is the audience, so weight West's completion as the primary
  // signal.
  const westInv = inventoryCompletions['west'] || { lunch: null, dinner: null };
  function freshAt(iso: string | null): boolean {
    if (!iso) return false;
    const t = Date.parse(iso);
    return !isNaN(t) && t >= startOfToday;
  }
  const inventoryDone = freshAt(westInv.lunch) || freshAt(westInv.dinner);

  // Cook done: every batch with a service today (West loc) has a non-null
  // cookDate. Empty-set is trivially "done".
  let cookDone = true;
  for (const b of batches) {
    const hasTodayService = (b.services || []).some(s => s.loc === 'west' && s.date === todayIsoStr);
    if (!hasTodayService) continue;
    if (!b.cookDate) { cookDone = false; break; }
  }

  const fixMyMenuRun = wasFixMyMenuRunToday(now);
  const allReady = inventoryDone && cookDone && fixMyMenuRun;
  return { inventoryDone, cookDone, fixMyMenuRun, allReady };
}

// ── DOM render ───────────────────────────────────────────────────────────

export function getTransportMode(): TransportMode {
  return _mode;
}

export function setTransportMode(m: TransportMode): void {
  if (m !== 'lean' && m !== 'bulk') return;
  if (_mode === m) return;
  _mode = m;
  trackEvent('transport_card_mode_toggled', m);
  // Re-render only this card if the dashboard is up.
  const dashEl = document.getElementById('dash-content');
  if (dashEl) {
    rerenderCurrentView();
  }
}

function readinessBanner(r: ReadinessState): string {
  const missing: string[] = [];
  if (!r.inventoryDone) missing.push("today's inventory");
  if (!r.cookDone) missing.push("today's cook");
  if (!r.fixMyMenuRun) missing.push('Fix My Menu');
  if (missing.length === 0) {
    return `<div class="tcard-banner tcard-banner-ready">All set — inventory, cooking and Fix My Menu done for today.</div>`;
  }
  return `<div class="tcard-banner tcard-banner-pending">Heads up — ${esc(missing.join(', '))} not done yet. The pack list still works, just less reliable.</div>`;
}

function modeToggle(): string {
  const lean = _mode === 'lean' ? 'active' : '';
  const bulk = _mode === 'bulk' ? 'active' : '';
  return `<div class="tcard-mode-toggle" role="group" aria-label="Pack mode">
    <button class="tcard-mode-btn ${lean}" data-mode="lean" data-testid="transport-mode-lean" onclick="setTransportMode('lean')" title="Just enough for the next 3 Centraal service slots">Lean</button>
    <button class="tcard-mode-btn ${bulk}" data-mode="bulk" data-testid="transport-mode-bulk" onclick="setTransportMode('bulk')" title="Pack the next 7 days of Centraal demand at once for any dish you're already shipping">Bulk-by-dish</button>
  </div>`;
}

function rowHtml(row: TransportRow): string {
  const svcText = row.services
    .map(s => `${s.meal === 'lunch' ? '☀️' : '🌙'} ${formatShortDate(s.date)}`)
    .join(' · ');
  const futureBadge = row.future ? `<span class="tcard-row-future" title="Includes Centraal services beyond the next 3 slots">+future</span>` : '';
  const subtractTxt = row.destStock > 0
    ? `<span class="tcard-row-sub" title="Already at Centraal">−${row.destStock} L</span>`
    : '';
  return `<div class="tcard-row" data-batch-id="${esc(row.batchId)}">
    <div class="tcard-row-main">
      <span class="tcard-row-name">${esc(row.name)}</span>
      ${futureBadge}
      <span class="tcard-row-svc">${esc(svcText)}</span>
    </div>
    <div class="tcard-row-qty">
      <span class="tcard-row-send">${row.sendQty} L</span>
      ${subtractTxt}
    </div>
  </div>`;
}

function formatShortDate(iso: string): string {
  const d = new Date(iso + 'T12:00:00');
  const today = getToday();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  if (dateToIso(d) === dateToIso(today)) return 'today';
  if (dateToIso(d) === dateToIso(tomorrow)) return 'tomorrow';
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

/** Return the inner HTML for the transport card (no outer container — caller
 *  inlines this into the dashboard's grid). Skip this card on the Centraal
 *  dashboard — direction is West→Centraal only by design. */
export function renderTransportCard(): string {
  if (S.currentLoc !== 'west') return '';

  // The family allocation cache must be fresh — calcRequiredAtService reads
  // from it. renderDashboardContent calls rebuildPlanner before us, but be
  // defensive in case future callers don't.
  rebuildPlanner();

  const rows = computeTransportPlan(_mode, S.batches);
  const totalSendQty = round1(rows.reduce((s, r) => s + r.sendQty, 0));
  const readiness = getReadiness(S.batches, S.inventoryCompletions);
  const lit = readiness.allReady && rows.length > 0 ? 'tcard-lit' : '';

  trackEvent('transport_card_shown', _mode, { rowCount: rows.length, totalVolume: totalSendQty });

  const pending = rows.length === 0 ? countPendingUncookedForCentraal(S.batches) : 0;
  const emptyMsg = pending > 0
    ? `${pending} dish${pending === 1 ? '' : 'es'} scheduled for Centraal — finish cooking first, then come back.`
    : `Nothing scheduled to leave for Centraal in the next 3 services.`;
  const body = rows.length === 0
    ? `<div class="tcard-empty">${esc(emptyMsg)}</div>`
    : `<div class="tcard-rows">${rows.map(rowHtml).join('')}</div>
       <div class="tcard-footer">
         <div class="tcard-total"><span class="tcard-total-label">Total to pack</span> <span class="tcard-total-qty">${totalSendQty} L</span></div>
         <button class="btn btn-primary tcard-confirm" onclick="confirmTransportPlan()">Pack and send</button>
       </div>`;

  return `<div class="dash-card tcard ${lit}" data-testid="transport-card">
    <div class="dash-card-title">
      <span class="dash-card-icon">🚚</span> Pack for Centraal — tomorrow
      ${modeToggle()}
    </div>
    ${readinessBanner(readiness)}
    ${body}
  </div>`;
}

// ── Confirm action ───────────────────────────────────────────────────────

/** Iterate the current plan rows and call POST /api/batches/:id/ship per
 *  batch. Backend handles auto-cap, pack-accumulate (same toLoc+storage+
 *  cookDate folds into an existing pending shipment), and broadcasts the
 *  updated batch via SSE. We update S.batches[idx] from each response (the
 *  sender doesn't get its own SSE patch — see lead's clarification A).
 *
 *  Errors on individual rows don't abort the loop. */
export async function confirmTransportPlan(): Promise<void> {
  if (S.currentLoc !== 'west') return;
  rebuildPlanner();
  const rows = computeTransportPlan(_mode, S.batches);
  if (rows.length === 0) {
    toast('Nothing to pack');
    return;
  }
  const totalSendQty = round1(rows.reduce((s, r) => s + r.sendQty, 0));
  trackEvent('transport_card_confirmed', _mode, { rowCount: rows.length, totalVolume: totalSendQty });

  let okCount = 0;
  let cappedCount = 0;
  for (const row of rows) {
    try {
      const res = await apiPost(`/api/batches/${row.batchId}/ship`, {
        toLoc: 'centraal',
        qty: row.sendQty,
        storage: 'Gastro',
      });
      if (res && res.batch) {
        const idx = S.batches.findIndex(b => b.id === row.batchId);
        if (idx >= 0) S.batches[idx] = res.batch;
      }
      if (res && res.warning) cappedCount++;
      okCount++;
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Unknown error';
      // Don't break the whole loop on a single failure — log and move on.
      console.error('transport-card: /ship failed for batch', row.batchId, message);
    }
  }
  if (okCount > 0) {
    const cappedNote = cappedCount > 0 ? ` (${cappedCount} capped to available)` : '';
    toast(`Packed ${okCount} batch${okCount > 1 ? 'es' : ''} for Centraal${cappedNote}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Centraal arrival block — "Did the transport arrive?"
//
// Lives on the Sering Centraal dashboard only, directly under the meal toggle.
// Surfaces every pending (not-yet-arrived) shipment bound for Centraal; one tap
// confirms them all, calling POST /api/batches/:id/shipments/:sid/arrived per
// shipment (the same endpoint the Transport tab's per-row button uses), which
// merges each shipment's qty into Centraal inventory.
// ─────────────────────────────────────────────────────────────────────────────

interface PendingArrivalRef {
  batchId: string;
  shipmentId: string;
}

/** All not-yet-arrived shipments heading to Centraal, plus a liter total. */
export function pendingCentraalArrivals(batches: Batch[]): { refs: PendingArrivalRef[]; liters: number } {
  const refs: PendingArrivalRef[] = [];
  let liters = 0;
  for (const b of batches) {
    for (const s of (b.shipments || [])) {
      if (s.arrived || s.toLoc !== 'centraal') continue;
      refs.push({ batchId: b.id, shipmentId: s.id });
      liters += s.qty || 0;
    }
  }
  return { refs, liters: round1(liters) };
}

/** Inner HTML for the red arrival block. Empty string unless the current loc
 *  is Centraal AND something is actually in transit — a permanent red block
 *  with nothing to confirm would just be noise. */
export function renderCentraalArrivalBlock(): string {
  if (S.currentLoc !== 'centraal') return '';
  const { refs, liters } = pendingCentraalArrivals(S.batches);
  if (refs.length === 0) return '';
  const n = refs.length;
  return `<div class="dash-arrival-block" role="button" tabindex="0"
      onclick="confirmCentraalArrivals()"
      onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();confirmCentraalArrivals();}">
    <span class="dash-arrival-icon">🚚</span>
    <div class="dash-arrival-text">
      <div class="dash-arrival-title">Did the transport arrive today?</div>
      <div class="dash-arrival-sub">${n} batch${n === 1 ? '' : 'es'} (${liters} L) on the way from Sering West — tap to confirm it's here.</div>
    </div>
  </div>`;
}

/** Mark every pending Centraal-bound shipment arrived in one go. Mirrors
 *  confirmTransportPlan: per-shipment POST, local state updated from each
 *  response, an individual failure doesn't abort the loop. */
export async function confirmCentraalArrivals(): Promise<void> {
  const { refs } = pendingCentraalArrivals(S.batches);
  if (refs.length === 0) {
    toast('Nothing in transit');
    return;
  }
  trackEvent('centraal_arrivals_confirmed', '', { count: refs.length });
  let okCount = 0;
  for (const ref of refs) {
    try {
      const res = await apiPost(`/api/batches/${ref.batchId}/shipments/${ref.shipmentId}/arrived`, {});
      if (res && res.batch) {
        const idx = S.batches.findIndex(b => b.id === ref.batchId);
        if (idx >= 0) S.batches[idx] = res.batch;
      }
      okCount++;
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Unknown error';
      console.error('confirmCentraalArrivals: /arrived failed for shipment', ref.shipmentId, message);
    }
  }
  const failed = refs.length - okCount;
  if (okCount > 0 && failed > 0) {
    // Partial failure: the block re-renders and the unconfirmed shipments stay,
    // so the cook can tap again — but tell them, don't show a plain success.
    toastError(`${okCount} confirmed, ${failed} couldn't be — tap again to retry the rest.`);
  } else if (okCount > 0) {
    toast(`${okCount} shipment${okCount > 1 ? 's' : ''} arrived at Sering Centraal`);
  } else {
    toastError('Could not confirm arrivals — try the Transport tab');
  }
  rebuildPlanner();
  rerenderCurrentView();
}
