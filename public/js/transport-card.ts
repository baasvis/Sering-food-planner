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
import { S, allActiveLocations } from './state';
import { locName } from '@shared/location';
import { isBatchCooked, calcRequiredAtService, isServicePast, getToday, dateToIso, rebuildPlanner, getStockAt, getServeableStockAt, getPendingFromShipments } from './core';
import { showModal, closeModal, esc } from './modal';
import { trackEvent } from './telemetry';
import { rerenderCurrentView, getCurrentScreen } from './navigate';
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

/** A dish scheduled for a Centraal service in the next-3-slot horizon that is
 *  NOT cooked yet. Surfaced on the card (greyed, not packable) so a dish added
 *  or moved on delivery day is visible instead of silently missing. */
export interface PendingUncookedRow {
  batchId: string;
  name: string;
  type: DishType;
  /** Liters this dish will need at Centraal once cooked. */
  totalDemand: number;
  services: Array<{ date: string; meal: string }>;
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

// Manual pack overrides (Task: "change what is packed"). When non-null this is
// the explicit pack list (batchId → litres) the cook edited by hand; it
// replaces the auto-computed plan until they pack-and-send (which clears it).
let _packEdits: Map<string, number> | null = null;

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
    // Round the packed amount up to a whole/nice litre count (see roundUpPack),
    // then cap at the batch's available West stock (was b.stock; now
    // getStockAt(b, 'west')). Backend's /ship endpoint also caps and surfaces
    // a warning, so this is a hint not a hard limit.
    const sendQty = Math.min(roundUpPack(netDemand), getStockAt(a.batch, 'west'));
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

/** Round a Centraal pack quantity UP to a "nice" amount. Packing happens in
 *  whole-litre containers, so we always round up to a whole litre — and if the
 *  amount lands within 2 L below a multiple of 5 (5, 10, 15, 20, …) we round up
 *  to that multiple instead, so the cook packs e.g. a clean 10 L rather than
 *  8.2 L. Pure + exported for unit testing. */
export function roundUpPack(n: number): number {
  if (n <= 0) return 0;
  const nextFive = Math.ceil(n / 5 - 1e-9) * 5;
  if (nextFive - n <= 2) return nextFive;
  return Math.ceil(n - 1e-9);
}

/** Build transport rows from a manual pack-edit map (batchId → litres),
 *  capping each at the batch's available West stock. Used when the cook has
 *  hand-edited what to pack via the pack editor. */
function buildRowsFromEdits(edits: Map<string, number>): TransportRow[] {
  const rows: TransportRow[] = [];
  for (const [batchId, qty] of edits) {
    const b = S.batches.find(x => x.id === batchId);
    if (!b || qty <= 0) continue;
    const capped = Math.min(qty, getStockAt(b, 'west'));
    if (capped <= 0) continue;
    rows.push({
      batchId,
      name: b.name,
      type: b.type,
      totalDemand: round1(capped),
      destStock: 0,
      sendQty: round1(capped),
      services: [],
      future: false,
    });
  }
  const typeOrder: Record<string, number> = { 'Soup': 0, 'Main course': 1, 'Dessert': 2 };
  rows.sort((a, b) => (typeOrder[a.type] ?? 9) - (typeOrder[b.type] ?? 9) || a.name.localeCompare(b.name));
  return rows;
}

/** The rows the card should actually show / pack: the cook's manual edits if
 *  they've made any, otherwise the auto-computed plan. */
export function effectivePackRows(): TransportRow[] {
  if (_packEdits) return buildRowsFromEdits(_packEdits);
  return computeTransportPlan(_mode, S.batches);
}

/** Count batches that *would* be in the lean plan if they were cooked —
 *  i.e. they have a Centraal service in the next-3-slot horizon and
 *  `isBatchCooked` is currently false.
 *
 *  Superseded for the card UI by computePendingUncookedRows (which lists the
 *  dishes themselves); retained for its unit tests / potential reuse.
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

/** Rows for batches scheduled for a Centraal service in the next 3 slots that
 *  are NOT cooked yet. They can't be packed (no stock exists), but listing
 *  them means a dish added or moved on delivery day shows on the card instead
 *  of silently missing from it. `packedRows` is the cooked transport plan — a
 *  dish already listed there is dropped here so it isn't shown in both
 *  sections (e.g. two batches of one recipe, one cooked and one not).
 *
 *  Like computeTransportPlan this reads the family-allocation cache, so
 *  callers must have run rebuildPlanner() first (renderTransportCard does). */
export function computePendingUncookedRows(
  batches: Batch[],
  packedRows: TransportRow[] = [],
): PendingUncookedRow[] {
  const horizonSlots = nextCentraalSlots(batches, 3);
  if (horizonSlots.length === 0) return [];
  const horizonKeys = new Set(horizonSlots.map(s => s.key));

  // A dish already shown in the packable section is on the card — don't also
  // list it here. This section exists to surface dishes that would OTHERWISE
  // be missing, so a dish with a cooked, packable batch doesn't belong.
  const batchById = new Map<string, Batch>(batches.map((b): [string, Batch] => [b.id, b]));
  const packedIdentities = new Set<string>();
  for (const r of packedRows) {
    const pb = batchById.get(r.batchId);
    if (pb) packedIdentities.add(dishIdentity(pb));
  }

  const rows: PendingUncookedRow[] = [];
  for (const b of batches) {
    if (isBatchCooked(b)) continue;
    if (packedIdentities.has(dishIdentity(b))) continue;
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
      rows.push({
        batchId: b.id,
        name: b.name,
        type: b.type,
        totalDemand: round1(demand),
        services: svcs.sort(compareSlots),
      });
    }
  }

  const typeOrder: Record<string, number> = { 'Soup': 0, 'Main course': 1, 'Dessert': 2 };
  rows.sort((a, b) => (typeOrder[a.type] ?? 9) - (typeOrder[b.type] ?? 9) || a.name.localeCompare(b.name));
  return rows;
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
    <button class="tcard-mode-btn ${lean}" data-mode="lean" onclick="setTransportMode('lean')" title="Just enough for the next 3 Centraal service slots">Lean</button>
    <button class="tcard-mode-btn ${bulk}" data-mode="bulk" onclick="setTransportMode('bulk')" title="Pack the next 7 days of Centraal demand at once for any dish you're already shipping">Bulk-by-dish</button>
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

/** Like rowHtml but for a not-yet-cooked dish: greyed, no send qty and no
 *  destination subtraction — it shows the liters the dish WILL need once
 *  cooked, not a packable amount. */
function uncookedRowHtml(row: PendingUncookedRow): string {
  const svcText = row.services
    .map(s => `${s.meal === 'lunch' ? '☀️' : '🌙'} ${formatShortDate(s.date)}`)
    .join(' · ');
  return `<div class="tcard-row tcard-row-uncooked" data-batch-id="${esc(row.batchId)}">
    <div class="tcard-row-main">
      <span class="tcard-row-name">${esc(row.name)}</span>
      <span class="tcard-row-svc">${esc(svcText)}</span>
    </div>
    <div class="tcard-row-qty">
      <span class="tcard-row-willneed">${row.totalDemand} L</span>
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

  const rows = effectivePackRows();
  const uncookedRows = computePendingUncookedRows(S.batches, rows);
  const totalSendQty = round1(rows.reduce((s, r) => s + r.sendQty, 0));
  const edited = _packEdits !== null;
  const readiness = getReadiness(S.batches, S.inventoryCompletions);
  const lit = readiness.allReady && rows.length > 0 ? 'tcard-lit' : '';

  // Only count this as "shown" when the dashboard is the visible screen —
  // renderTransportCard also runs during background refreshes (see
  // setBackgroundRefresh), where the card isn't actually on screen.
  if (getCurrentScreen() === 'dashboard') {
    trackEvent('transport_card_shown', _mode, { rowCount: rows.length, totalVolume: totalSendQty });
  }

  // Cooked, packable rows + total + the "Food is packed" action. An "Edit
  // pack" button lets the cook add West-stock dishes or change amounts.
  const editBtn = `<button class="btn btn-sm tcard-edit" onclick="openPackEditor()" title="Add dishes from West stock or change the packed amounts">✏️ Edit pack</button>`;
  const editedNote = edited
    ? `<div class="tcard-edited-note">Hand-edited pack list — <button class="tcard-reset-link" onclick="resetPackEditor()">reset to auto</button></div>`
    : '';
  const packSection = (rows.length === 0 && !edited)
    ? `<div class="tcard-empty-edit">Nothing auto-scheduled for Centraal. ${editBtn}</div>`
    : `${editedNote}
       <div class="tcard-rows">${rows.map(rowHtml).join('')}</div>
       <div class="tcard-footer">
         <div class="tcard-total"><span class="tcard-total-label">Total to pack</span> <span class="tcard-total-qty">${totalSendQty} L</span></div>
         <div class="tcard-actions">
           ${editBtn}
           <button class="btn btn-primary tcard-confirm" onclick="confirmTransportPlan()">Food is packed for tomorrow</button>
         </div>
       </div>`;

  // Dishes scheduled for Centraal but not cooked yet — greyed, not packable.
  // Shown so a dish added or changed on delivery day is visible on the card.
  const uncookedSection = uncookedRows.length === 0
    ? ''
    : `<div class="tcard-uncooked-hdr">Not cooked yet — can't pack until cooked</div>
       <div class="tcard-rows">${uncookedRows.map(uncookedRowHtml).join('')}</div>`;

  const body = (rows.length === 0 && uncookedRows.length === 0 && !edited)
    ? `<div class="tcard-empty">Nothing scheduled to leave for Centraal in the next 3 services. <button class="btn btn-sm tcard-edit" onclick="openPackEditor()" title="Pack dishes from West stock by hand">✏️ Pack something anyway</button></div>`
    : packSection + uncookedSection;

  return `<div class="dash-card tcard ${lit}">
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
  const rows = effectivePackRows();
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
  // The pack is done — drop any hand-edited override so the card returns to the
  // live auto plan for the next pack.
  _packEdits = null;
  // Refresh the card so the just-shipped rows drop off immediately. Without
  // this it keeps showing the old plan (and its action button) until the next
  // 60s tick — long enough to accidentally submit the same pack twice. Mirrors
  // confirmCentraalArrivals, which already does this.
  rebuildPlanner();
  rerenderCurrentView();
}

// ── Pack editor ──────────────────────────────────────────────────────────
//
// Lets the cook change what's packed for Centraal by hand: add any cooked
// dish with West stock, raise/lower an amount, or drop a dish (set to 0).
// Seeds from the current plan so the common case is a quick tweak.

/** Open the "edit what's packed" modal. Lists every cooked batch with West
 *  stock, each with a litres input pre-filled from the current pack plan. */
export function openPackEditor(): void {
  if (S.currentLoc !== 'west') return;
  rebuildPlanner();
  const current = new Map((_packEdits ? buildRowsFromEdits(_packEdits) : computeTransportPlan(_mode, S.batches))
    .map(r => [r.batchId, r.sendQty] as const));

  // Candidate dishes: anything cooked with West stock, plus anything already
  // in the current pack list (defensive — should be a subset).
  const candidates = S.batches.filter(b => isBatchCooked(b) && getStockAt(b, 'west') > 0);
  for (const id of current.keys()) {
    if (!candidates.some(c => c.id === id)) {
      const b = S.batches.find(x => x.id === id);
      if (b) candidates.push(b);
    }
  }
  const typeOrder: Record<string, number> = { 'Soup': 0, 'Main course': 1, 'Dessert': 2 };
  candidates.sort((a, b) => (typeOrder[a.type] ?? 9) - (typeOrder[b.type] ?? 9) || a.name.localeCompare(b.name));

  if (candidates.length === 0) {
    showModal(`<h3>Edit pack for Centraal</h3>
      <p style="color:var(--text2);">No cooked dishes with stock at Sering West to pack.</p>
      <div class="modal-actions"><button class="btn" onclick="closeModal()">Close</button></div>`);
    return;
  }

  const rowsHtml = candidates.map(b => {
    const avail = round1(getStockAt(b, 'west'));
    const val = current.get(b.id);
    return `<div class="pack-edit-row">
      <div class="pack-edit-name">${esc(b.name)} <span class="pack-edit-avail">${avail} L at West</span></div>
      <div class="pack-edit-qty">
        <input type="number" min="0" step="0.5" max="${avail}" value="${val != null ? val : ''}"
          placeholder="0" data-pack-edit="${esc(b.id)}" class="re-inline-input re-inline-num" style="width:80px;" />
        <span>L</span>
      </div>
    </div>`;
  }).join('');

  showModal(`<h3>Edit pack for Centraal</h3>
    <p style="font-size:12px;color:var(--text2);margin-bottom:10px;">Set how many litres of each dish to pack. Leave at 0 to skip a dish. You can't pack more than is in stock at West.</p>
    <div class="pack-edit-list">${rowsHtml}</div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="savePackEditor()">Save pack list</button>
    </div>`);
}

/** Persist the pack-editor inputs into `_packEdits` and refresh the card. */
export function savePackEditor(): void {
  const map = new Map<string, number>();
  document.querySelectorAll('[data-pack-edit]').forEach(el => {
    const input = el as HTMLInputElement;
    const id = input.getAttribute('data-pack-edit');
    if (!id) return;
    const v = parseFloat(input.value);
    if (v && v > 0) {
      const b = S.batches.find(x => x.id === id);
      const capped = b ? Math.min(v, getStockAt(b, 'west')) : v;
      if (capped > 0) map.set(id, Math.round(capped * 10) / 10);
    }
  });
  _packEdits = map;
  trackEvent('transport_pack_edited', '', { rowCount: map.size });
  closeModal();
  rebuildPlanner();
  rerenderCurrentView();
}

/** Discard manual edits and return to the auto-computed pack plan. */
export function resetPackEditor(): void {
  _packEdits = null;
  closeModal();
  rebuildPlanner();
  rerenderCurrentView();
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

/** All not-yet-arrived shipments heading to `loc`, plus a liter total. */
export function pendingArrivalsFor(batches: Batch[], loc: string): { refs: PendingArrivalRef[]; liters: number } {
  const refs: PendingArrivalRef[] = [];
  let liters = 0;
  for (const b of batches) {
    for (const s of (b.shipments || [])) {
      if (s.arrived || s.toLoc !== loc) continue;
      refs.push({ batchId: b.id, shipmentId: s.id });
      liters += s.qty || 0;
    }
  }
  return { refs, liters: round1(liters) };
}

/** Back-compat wrapper (unit tests + external callers). */
export function pendingCentraalArrivals(batches: Batch[]): { refs: PendingArrivalRef[]; liters: number } {
  return pendingArrivalsFor(batches, 'centraal');
}

/** Inner HTML for the red arrival block — shipments heading to the CURRENT
 *  location (Centraal's daily van, an event location's manual sends, or
 *  leftovers returning to West). Empty string when nothing is in transit —
 *  a permanent red block with nothing to confirm would just be noise.
 *  Behaviour at Centraal is identical to the old Centraal-only block. */
export function renderArrivalBlock(): string {
  const loc = S.currentLoc;
  const { refs, liters } = pendingArrivalsFor(S.batches, loc);
  if (refs.length === 0) return '';
  const n = refs.length;
  // Name the sending side(s) — usually just one.
  const fromLocs = new Set<string>();
  for (const b of S.batches) {
    for (const s of (b.shipments || [])) {
      if (!s.arrived && s.toLoc === loc) fromLocs.add(s.fromLoc);
    }
  }
  const fromLabel = [...fromLocs].map(l => locName(l)).join(' + ') || 'the other kitchen';
  return `<div class="dash-arrival-block" role="button" tabindex="0"
      onclick="confirmArrivals()"
      onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();confirmArrivals();}">
    <span class="dash-arrival-icon">🚚</span>
    <div class="dash-arrival-text">
      <div class="dash-arrival-title">Did the transport arrive today?</div>
      <div class="dash-arrival-sub">${n} batch${n === 1 ? '' : 'es'} (${liters} L) on the way from ${esc(fromLabel)} — tap to confirm it's here.</div>
    </div>
  </div>`;
}

/** Mark every shipment pending at the CURRENT location arrived in one go.
 *  Mirrors confirmTransportPlan: per-shipment POST, local state updated from
 *  each response, an individual failure doesn't abort the loop. */
export async function confirmArrivals(): Promise<void> {
  const loc = S.currentLoc;
  const { refs } = pendingArrivalsFor(S.batches, loc);
  if (refs.length === 0) {
    toast('Nothing in transit');
    return;
  }
  trackEvent('centraal_arrivals_confirmed', loc, { count: refs.length });
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
      console.error('confirmArrivals: /arrived failed for shipment', ref.shipmentId, message);
    }
  }
  const failed = refs.length - okCount;
  if (okCount > 0 && failed > 0) {
    // Partial failure: the block re-renders and the unconfirmed shipments stay,
    // so the cook can tap again — but tell them, don't show a plain success.
    toastError(`${okCount} confirmed, ${failed} couldn't be — tap again to retry the rest.`);
  } else if (okCount > 0) {
    toast(`${okCount} shipment${okCount > 1 ? 's' : ''} arrived at ${locName(loc)}`);
  } else {
    toastError('Could not confirm arrivals — try the Transport tab');
  }
  rebuildPlanner();
  rerenderCurrentView();
}

/** Back-compat alias (old window bindings / tests). */
export const confirmCentraalArrivals = confirmArrivals;

// ─────────────────────────────────────────────────────────────────────────────
// Manual shipment modal — event locations (festival logistics).
//
// The automated "Pack for Centraal" card above encodes the daily van rhythm
// and stays Centraal-only. Event locations ship BY HAND: pick cooked stock at
// the source, type litres, send. Same POST /api/batches/:id/ship endpoint,
// with an EXPLICIT fromInventoryIdx per entry — /ship's auto-pick takes the
// first entry whose loc ≠ toLoc, which could drain the wrong site when a
// batch holds stock at several locations.
// ─────────────────────────────────────────────────────────────────────────────

let _manualShip: { fromLoc: string; toLoc: string } | null = null;

/** Transport-tab entry point: pick a destination first (skips the picker when
 *  Centraal is the only non-West option). */
export function openManualShipSelect(): void {
  const dests = allActiveLocations().filter(l => l !== 'west');
  if (dests.length === 1) { openManualShipModal(dests[0]); return; }
  const opts = dests.map(l => `<option value="${esc(l)}">${esc(locName(l))}</option>`).join('');
  showModal(`<h3>Send shipment from West</h3>
    <p style="font-size:13px;color:var(--text2);">Where is this shipment going?</p>
    <select id="manual-ship-dest" class="re-inline-input" style="width:100%;margin:10px 0;">${opts}</select>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="openManualShipModal(document.getElementById('manual-ship-dest').value)">Next</button>
    </div>`);
}

/** List every cooked batch with stock at `fromLoc`, litres input per row.
 *  Reached from the event planner tab ("Ship from West" presets toLoc to the
 *  event; "Return leftovers" flips the direction) and the Transport tab. */
export function openManualShipModal(toLoc: string, fromLoc: string = 'west'): void {
  if (!toLoc || toLoc === fromLoc) return;
  rebuildPlanner();
  _manualShip = { fromLoc, toLoc };
  const candidates = S.batches.filter(b => isBatchCooked(b) && getStockAt(b, fromLoc as Location) > 0);
  const typeOrder: Record<string, number> = { 'Soup': 0, 'Main course': 1, 'Dessert': 2 };
  candidates.sort((a, b) => (typeOrder[a.type] ?? 9) - (typeOrder[b.type] ?? 9) || a.name.localeCompare(b.name));

  if (candidates.length === 0) {
    showModal(`<h3>Ship to ${esc(locName(toLoc))}</h3>
      <p style="color:var(--text2);">No cooked dishes with stock at ${esc(locName(fromLoc))} to ship.</p>
      <div class="modal-actions"><button class="btn" onclick="closeModal()">Close</button></div>`);
    return;
  }

  const rowsHtml = candidates.map(b => {
    const avail = round1(getStockAt(b, fromLoc as Location));
    return `<div class="pack-edit-row">
      <div class="pack-edit-name">${esc(b.name)} <span class="pack-edit-avail">${avail} L at ${esc(locName(fromLoc))}</span></div>
      <div class="pack-edit-qty">
        <input type="number" min="0" step="0.5" max="${avail}" placeholder="0" data-manual-ship="${esc(b.id)}" class="re-inline-input re-inline-num" style="width:80px;" />
        <span>L</span>
      </div>
    </div>`;
  }).join('');

  showModal(`<h3>Ship ${esc(locName(fromLoc))} &rarr; ${esc(locName(toLoc))}</h3>
    <p style="font-size:12px;color:var(--text2);margin-bottom:10px;">Set how many litres of each dish to send. Food travels as an in-transit shipment until someone confirms arrival at ${esc(locName(toLoc))} (their dashboard shows a red confirm block).</p>
    <div class="pack-edit-list">${rowsHtml}</div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" data-testid="manual-ship-confirm" onclick="confirmManualShip()">Send shipment</button>
    </div>`);
}

/** Confirm the manual-ship modal: per batch, ship per source inventory entry
 *  (largest first) with an explicit fromInventoryIdx. /ship reduces entry qty
 *  in place (no splice), so indexes captured up front stay valid across the
 *  sequential POSTs. Per-row failures don't abort the loop. */
export async function confirmManualShip(): Promise<void> {
  if (!_manualShip) return;
  const { fromLoc, toLoc } = _manualShip;
  const rows: { batchId: string; qty: number }[] = [];
  document.querySelectorAll('[data-manual-ship]').forEach(el => {
    const input = el as HTMLInputElement;
    const id = input.getAttribute('data-manual-ship');
    const v = parseFloat(input.value);
    if (id && v && v > 0) rows.push({ batchId: id, qty: Math.round(v * 10) / 10 });
  });
  if (rows.length === 0) { toast('Nothing to send'); return; }
  closeModal();
  trackEvent('manual_ship_confirmed', toLoc, { rowCount: rows.length, fromLoc });

  let okCount = 0;
  let cappedCount = 0;
  for (const row of rows) {
    try {
      const b = S.batches.find(x => x.id === row.batchId);
      const entries = (b?.inventory || [])
        .map((e, idx) => ({ e, idx }))
        .filter(x => x.e.loc === fromLoc && x.e.qty > 0)
        .sort((a, z) => z.e.qty - a.e.qty);
      let remaining = row.qty;
      for (const { e, idx } of entries) {
        if (remaining <= 0) break;
        const sendQty = Math.min(remaining, round1(e.qty));
        const res = await apiPost(`/api/batches/${row.batchId}/ship`, {
          toLoc, qty: sendQty, storage: e.storage, fromInventoryIdx: idx,
        });
        if (res && res.batch) {
          const bidx = S.batches.findIndex(x => x.id === row.batchId);
          if (bidx >= 0) S.batches[bidx] = res.batch;
        }
        if (res && res.warning) cappedCount++;
        remaining = Math.round((remaining - sendQty) * 10) / 10;
      }
      okCount++;
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Unknown error';
      console.error('manual ship failed for batch', row.batchId, message);
    }
  }
  _manualShip = null;
  if (okCount > 0) {
    const cappedNote = cappedCount > 0 ? ' (some capped to available)' : '';
    toast(`Sent ${okCount} batch${okCount > 1 ? 'es' : ''} to ${locName(toLoc)}${cappedNote}`);
  }
  rebuildPlanner();
  rerenderCurrentView();
}
