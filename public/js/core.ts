// CORE LOGIC
// ═══════════════════════════════════════════════════════════════════

import { S, DAYS, allActiveLocations, eventLocById, isEventLoc } from './state';
import type { InventoryDone } from './state';
import type { Batch, Service, Catering, CateringDish, Location, Meal, DishType, StorageType, BatchRatings, InventoryEntry } from '@shared/types';
import { scheduleSave, apiPost } from './utils';
import { pushUndo } from './undo';
import { showModal, closeModal, esc } from './modal';
import { rerenderCurrentView } from './navigate';
import { renderFamilyGrouped } from './dishes';
import { locName } from '@shared/location';

// Callback to refresh an open inventory modal — set by main.ts to avoid a
// core → planner circular import. Used after an undo restores an archived
// batch so the modal the cook is looking at reflects the restored state.
let _refreshInventoryModal: (() => void) | null = null;
export function setRefreshInventoryModal(fn: () => void): void { _refreshInventoryModal = fn; }

export function isBatchCooked(d: Batch): boolean {
  // A batch is "cooked" if it has any inventory or any in-flight shipment.
  // Pending shipments still count: the food was cooked + sent, just not yet
  // arrived at destination — the batch lifecycle is past PLANNED.
  return (d.inventory || []).some(e => (e.qty || 0) > 0)
      || (d.shipments || []).some(s => !s.arrived && (s.qty || 0) > 0);
}

/** Where a batch is (or will be) COOKED — the single source of truth, shared
 *  by the planner pool, the dashboard cook lists, and the Orders tab so a
 *  dish never appears "to cook" at one location while its ingredient demand
 *  sits at another.
 *
 *  Cooked batches: `inventory[0].loc` (sticky from the first confirmCooked —
 *  the "primary location" decision). Uncooked batches default to 'west', with
 *  ONE exception: services ALL at a single EVENT location → it will be cooked
 *  on-site there (Daan 2026-07-19: festival-cooked dishes must not clutter the
 *  West planner). Restricted to event locations so west/centraal behaviour is
 *  provably unchanged — any all-west, all-centraal or mixed batch still
 *  defaults to 'west'. A festival dish meant to be cooked AT WEST reappears at
 *  West the moment it's confirmed cooked there (inventory wins over the
 *  heuristic). */
export function batchCookLoc(b: Batch): Location {
  if (b.inventory && b.inventory.length > 0) return b.inventory[0].loc;
  const svcs = b.services || [];
  if (svcs.length > 0) {
    const first = svcs[0].loc;
    if (isEventLoc(first) && svcs.every(s => s.loc === first)) return first;
  }
  return 'west';
}

// ── Inventory helpers (unified-batch model) ────────────────────────────────
//
// Read the new b.inventory[] and b.shipments[] shape. Each batch is its own
// canonical pool; same-recipe duplicates across batches stay separate
// (audit S7).
//
// Batch-TOTAL helpers (getTotalStock, getServeableTotalStock) count settled
// inventory PLUS in-flight shipments (arrived:false) — food on a truck is
// still the batch's food, so a transfer keeps the total conserved.
// Per-LOCATION helpers (getStockAt, getServeableStockAt) count settled
// inventory only; use getPendingFromShipments for stock incoming to a loc.

export function getTotalStock(b: Batch): number {
  const settled = (b.inventory || []).reduce((s, e) => s + (e.qty || 0), 0);
  const inTransit = (b.shipments || [])
    .filter(s => !s.arrived)
    .reduce((s, sh) => s + (sh.qty || 0), 0);
  return settled + inTransit;
}

export function getStockAt(b: Batch, loc: Location, storage?: StorageType): number {
  return (b.inventory || [])
    .filter(e => e.loc === loc && (storage === undefined || e.storage === storage))
    .reduce((s, e) => s + (e.qty || 0), 0);
}

/** Stock that's directly available to serve at `loc` — i.e. excludes Frozen.
 *  Frozen stock has to be thawed (cook action) before it can serve, so the
 *  auto-allocator (Fix My Menu, transport plan destination-coverage check)
 *  treats it as reserved. Cooks can still ship/assign frozen manually; this
 *  helper only governs what AUTOMATED logic counts as available. */
export function getServeableStockAt(b: Batch, loc: Location): number {
  return (b.inventory || [])
    .filter(e => e.loc === loc && e.storage !== 'Frozen')
    .reduce((s, e) => s + (e.qty || 0), 0);
}

/** Total serveable stock (non-Frozen — Frozen needs thawing first) across all
 *  locations, including in-flight shipments.
 *  Pair with getServeableStockAt when the allocator needs to know whether
 *  a batch has any thawed coverage at all. */
export function getServeableTotalStock(b: Batch): number {
  const settled = (b.inventory || [])
    .filter(e => e.storage !== 'Frozen')
    .reduce((s, e) => s + (e.qty || 0), 0);
  const inTransit = (b.shipments || [])
    .filter(s => !s.arrived && s.storage !== 'Frozen')
    .reduce((s, sh) => s + (sh.qty || 0), 0);
  return settled + inTransit;
}

/** True only when the batch's *remaining* stock is entirely Frozen: it has at
 *  least one Frozen entry with qty > 0 and no non-Frozen entry with qty > 0.
 *  A batch with no live stock at all — empty inventory, or only depleted /
 *  0-qty marker entries such as an emergency placeholder's location pin — is
 *  NOT frozen; it belongs in the To-cook group. Display bucketing only (the
 *  planner pool + dishes screens). Distinct from menu-fixer's `isOnlyFrozen`,
 *  which keys on storage type alone for auto-rotation exclusion. */
export function isBatchAllFrozen(b: Batch): boolean {
  let hasFrozenStock = false;
  for (const e of (b.inventory || [])) {
    if ((e.qty || 0) <= 0) continue;
    if (e.storage === 'Frozen') hasFrozenStock = true;
    else return false;
  }
  return hasFrozenStock;
}

export function getPendingFromShipments(b: Batch, loc: Location): number {
  return (b.shipments || [])
    .filter(s => !s.arrived && s.toLoc === loc)
    .reduce((sum, s) => sum + (s.qty || 0), 0);
}

/** Serveable (non-Frozen) stock in-transit toward `loc`. Pairs with
 *  getServeableStockAt for "on-site serveable" reachability checks where Frozen
 *  in-transit must not count (it still needs thawing on arrival). */
export function getServeablePendingTo(b: Batch, loc: Location): number {
  return (b.shipments || [])
    .filter(s => !s.arrived && s.toLoc === loc && s.storage !== 'Frozen')
    .reduce((sum, s) => sum + (s.qty || 0), 0);
}

// Mirrors mergeIntoInventory in routes/batches.ts so server and client agree
// on the (loc, storage, cookDate) merge key.
export function consolidateInventory(b: Batch): void {
  const out: InventoryEntry[] = [];
  for (const entry of (b.inventory || [])) {
    const idx = out.findIndex(e =>
      e.loc === entry.loc && e.storage === entry.storage && e.cookDate === entry.cookDate,
    );
    if (idx >= 0) out[idx] = { ...out[idx], qty: out[idx].qty + entry.qty };
    else out.push({ ...entry });
  }
  b.inventory = out;
}

export function addInventory(b: Batch, entry: InventoryEntry): void {
  if (!b.inventory) b.inventory = [];
  b.inventory.push(entry);
  consolidateInventory(b);
}

export function removeInventory(b: Batch, idx: number): void {
  if (!b.inventory || idx < 0 || idx >= b.inventory.length) return;
  b.inventory.splice(idx, 1);
}

// Per-storage shelf life in days (locked decision: Gastro 3, Frozen 60,
// Vac-packed 10). cookDate is freshness origin (resets on freeze per the
// /transfer cookDate rules in routes/batches.ts).
const SHELF_LIFE_DAYS: Record<StorageType, number> = {
  'Gastro': 3,
  'Frozen': 60,
  'Vac-packed': 10,
};

export function isStaleEntry(entry: InventoryEntry): boolean {
  const cooked = strToDate(entry.cookDate);
  // TODO(checkpoint-5): emit a telemetry event for unparseable cookDate so
  // we can spot DB drift. For now, treat as fresh — false-alarms erode
  // trust; the cook visually inspects food anyway.
  if (!cooked) return false;
  const today = getToday();
  // Calendar-day diff via UTC anchors. Naïve ms-division undercounts by one
  // when the window straddles a DST spring-forward (one of the 24h slots is
  // 23h, floor() rounds down). Anchoring both ends at midnight UTC sidesteps
  // DST entirely — the local Y/M/D is the only thing that matters for shelf-
  // life, and we never compare across actual zones.
  const todayUtc = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const cookedUtc = Date.UTC(cooked.getFullYear(), cooked.getMonth(), cooked.getDate());
  const daysOld = Math.floor((todayUtc - cookedUtc) / 86_400_000);
  const limit = SHELF_LIFE_DAYS[entry.storage] ?? 3;
  return daysOld > limit;
}

// Amsterdam time helper (shared — also used by planner.js inventory).
// The toLocaleString timezone conversion is ~10µs; isServicePast calls this on
// hot paths (Fix My Menu evaluates it hundreds of thousands of times per run).
// Memoize the conversion with a 1s TTL — 1s-stale wall-clock is immaterial for
// the minute-granularity deadline checks isServicePast performs — while still
// returning a fresh Date each call so no caller can corrupt the cache.
let _amsNowCache: { at: number; ms: number } | null = null;
export function getAmsterdamNow(): Date {
  const now = Date.now();
  if (!_amsNowCache || now - _amsNowCache.at >= 1000) {
    _amsNowCache = {
      at: now,
      ms: new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Amsterdam' })).getTime(),
    };
  }
  return new Date(_amsNowCache.ms);
}

// Convert a date string ("2026-03-23") to a day name ("Mon", "Tue", etc.)
export function dateToDayName(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00'); // noon to avoid timezone edge cases
  return DAYS[(d.getDay() + 6) % 7];
}

// Convert a JS Date object to ISO date string "2026-03-23".
// Delegates to @shared/dates#formatIso — single source of truth.
// `import as` + `export` (not pure `export { X } from 'foo'`) so the
// alias is in the local scope; later code in this file calls `dateToIso(...)`.
import { formatIso as dateToIso } from '@shared/dates';
export { dateToIso };

// Check if a service is past / "served".
// Services store date as ISO string (e.g., "2026-03-23").
// A service is served when:
// - Its date is before today, OR
// - Its date is today AND (clock past deadline OR inventory done after urgent)
export function isServicePast(svc: Service): boolean {
  const now = getAmsterdamNow();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const svcDate = new Date(svc.date + 'T12:00:00');
  const svcDay = new Date(svcDate.getFullYear(), svcDate.getMonth(), svcDate.getDate());
  if (svcDay < today) return true;       // past date
  if (svcDay > today) return false;      // future date
  // Today — check time and inventory state. Each location (incl. event
  // locations) reads its OWN inventory-done state; the old `west-or-else-
  // centraal` normalizer made a third location read Centraal's numbers.
  const mins = now.getHours() * 60 + now.getMinutes();
  const lk: Location = svc.loc;
  const todayStr = dateToIso(now);
  const inv: Partial<InventoryDone> = S.inventoryDone[lk] || {};
  if (svc.meal === 'lunch') {
    const deadline = 13 * 60 + 45;     // 13:45
    const urgentFrom = deadline - 60;   // 12:45
    return mins >= deadline || (inv.lunch === todayStr && mins >= urgentFrom);
  }
  if (svc.meal === 'dinner') {
    const deadline = 20 * 60 + 15;     // 20:15
    const urgentFrom = deadline - 60;   // 19:15
    return mins >= deadline || (inv.dinner === todayStr && mins >= urgentFrom);
  }
  return false;
}

/** Date-only "past" check: true only when the service's calendar date is
 *  strictly before today. Unlike isServicePast it ignores the time-of-day and
 *  the inventory-done acceleration — used where a service dated today must
 *  never count as already-served (e.g. Fix-my-menu auto-retirement). */
export function isServiceDatePast(svc: Service): boolean {
  const now = getAmsterdamNow();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const svcDate = new Date(svc.date + 'T12:00:00');
  const svcDay = new Date(svcDate.getFullYear(), svcDate.getMonth(), svcDate.getDate());
  return svcDay < today;
}

export function rebuildPlanner(): void {
  S.planner = {};
  S.batches.forEach((d: Batch) => {
    (d.services || []).forEach((svc: Service) => {
      const k = `${svc.loc}-${svc.date}-${svc.meal}`;
      if (!S.planner[k]) S.planner[k] = [];
      if (!S.planner[k].find((x: Batch) => x.id === d.id)) S.planner[k].push(d);
    });
  });
  // Refresh per-batch peer-share demand cache read by
  // calcRequired/calcRequiredAtService/calcRequiredBreakdown/calcTotalGuests.
  recomputeBatchAllocations();
}

// ── Per-batch demand allocator (unified-batch model) ───────────────────────
//
// Each batch is its own canonical pool with `inventory[]` spread across
// locations. Demand math is pure peer-share: at each slot, divide guests by
// the number of distinct same-type batches and multiply by serving size.
// Cross-batch same-recipe duplicates intentionally count as separate peers
// (audit S7). The cache lives in module scope and rebuilds with rebuildPlanner.

function slotKey(svc: Service): string {
  return `${svc.loc}-${svc.date}-${svc.meal}`;
}

function recordAllocation(byBatch: Map<string, Map<string, number>>, batchId: string, key: string, amount: number): void {
  let inner = byBatch.get(batchId);
  if (!inner) { inner = new Map(); byBatch.set(batchId, inner); }
  inner.set(key, Math.round(amount * 10) / 10);
}

let _batchAllocations: { byBatch: Map<string, Map<string, number>> } = { byBatch: new Map() };

/** Production-reserve multiplier on per-service cooking demand.
 *  Cook-set on the West planner (S.costTargets.reservePercent). At 0% this
 *  returns 1.0 — a literal no-op, so all demand math is unchanged until a reserve
 *  is dialed in. Applied symmetrically in the cached allocator and the two FMM
 *  live functions so calcRequired/calcRequiredLive stay identical. Catering is
 *  NOT padded: it's a contracted exact order added as a separate term outside
 *  the allocator. There's no label anywhere — staff just see slightly higher
 *  demand, indistinguishable from real demand. */
export function reserveFactor(): number {
  const pct = S.costTargets?.reservePercent ?? 0;
  return pct > 0 ? 1 + pct / 100 : 1;
}

export function recomputeBatchAllocations(): void {
  buildRollMap(); // refresh closed->open roll-map before any getEffectiveGuests read
  const byBatch = new Map<string, Map<string, number>>();

  for (const b of S.batches) {
    for (const svc of (b.services || [])) {
      if (isServicePast(svc)) continue;
      const k = slotKey(svc);
      const peers = (S.planner[k] || []).filter(p => p.type === b.type);
      const peerCount = Math.max(peers.length, 1);
      const guests = getEffectiveGuests(svc.loc, svc.date, svc.meal);
      const serving = (b.serving || 280) / 1000;
      const liters = (guests / peerCount) * serving * reserveFactor();
      recordAllocation(byBatch, b.id, k, liters);
    }
  }

  _batchAllocations = { byBatch };
}

/** Read this batch's per-slot peer-share demand from the new cache.
 *  Returns undefined if no cache entry — callers default to 0. */
function lookupBatchAllocation(batch: Batch, svc: Service): number | undefined {
  const inner = _batchAllocations.byBatch.get(batch.id);
  if (!inner) return undefined;
  return inner.get(slotKey(svc));
}

export function renderDishListSplit(dishes: Batch[]): string {
  const cooked = sortByCookDate(dishes.filter((d: Batch) => isBatchCooked(d)));
  const uncooked = sortByCookDate(dishes.filter((d: Batch) => !isBatchCooked(d)));
  let html = '';
  if (uncooked.length > 0) {
    html += `<div class="cook-group-hdr uncooked-hdr">To cook (${uncooked.length})</div>`;
    // renderFamilyGrouped (defined in dishes.ts) wraps split families in a
    // .batch-family-card with per-location sections + same-loc merging +
    // arrived-vs-in-transit split. Single-member families render bare.
    // Single source of truth for family-aware tile rendering.
    html += renderFamilyGrouped(uncooked);
  }
  if (cooked.length > 0) {
    html += `<div class="cook-group-hdr cooked-hdr">Cooked (${cooked.length})</div>`;
    html += renderFamilyGrouped(cooked);
  }
  return html;
}

export function sortByCookDate(dishes: Batch[]): Batch[] {
  return [...dishes].sort((a: Batch, b: Batch) => {
    const da = a.cookDate ? strToDate(a.cookDate) : null;
    const db = b.cookDate ? strToDate(b.cookDate) : null;
    // No date goes to bottom
    if (!da && !db) return 0;
    if (!da) return 1;
    if (!db) return -1;
    return da.getTime() - db.getTime();
  });
}

// Get guest count for a location, date string, and meal
export function getGuests(loc: string, dateStr: string, meal: Meal | string): number {
  // Event locations only have guests inside their date window — a stray base
  // weekday pattern must not generate phantom demand (supplies, coverage,
  // FMM capacity) across the whole planning horizon outside the festival.
  // An ARCHIVED event has no demand at all: a festival archived mid-window
  // (cancelled, or closed early) must stop feeding cook/supply/order demand
  // even for dates inside its window.
  const ev = eventLocById(loc);
  if (ev && (ev.archived || dateStr < ev.startDate || dateStr > ev.endDate)) return 0;
  const lk = loc;
  const dn = dateToDayName(dateStr);

  // Determine if dateStr falls in the current week
  const d = new Date(dateStr + 'T12:00:00');
  const dow = d.getDay();
  const mon = new Date(d);
  mon.setDate(d.getDate() + (dow === 0 ? -6 : 1 - dow));
  const mk = dateToIso(mon);

  const today = getToday();
  const todayDow = today.getDay();
  const curMon = new Date(today);
  curMon.setDate(today.getDate() + (todayDow === 0 ? -6 : 1 - todayDow));
  const curMk = dateToIso(curMon);

  // Current week: prefer a week-specific value carried forward from when this week
  // was still "next week" (guestsNextWeeks), else the base weekday pattern. Without
  // this, a count entered for the week (e.g. a 240-guest event) is silently dropped
  // for the default pattern the moment the week becomes current. Editing a current-
  // week cell clears the carried value (see updateGuests), so a manual edit wins.
  if (mk === curMk) {
    const wk = S.guestsNextWeeks[mk];
    if (wk && wk[lk] && wk[lk][dn] && (wk[lk][dn] as any)[meal] !== undefined) {
      return (wk[lk][dn] as any)[meal];
    }
    return ((S.guests[lk] || {})[dn] || {} as any)[meal] || 0;
  }

  // Future/past weeks: use guestsNextWeeks predictions
  const weekData = S.guestsNextWeeks[mk];
  if (weekData && weekData[lk] && weekData[lk][dn] && weekData[lk][dn][meal] !== undefined) {
    return weekData[lk][dn][meal];
  }

  // Fall back to predicted counts (from POS history) before base counts —
  // base counts hold the current week's day-of-week values, which would
  // return 0 for a future Monday if this Monday already passed.
  if (S.predictions && S.predictions[lk] && S.predictions[lk][dn] && S.predictions[lk][dn][meal] !== undefined) {
    return S.predictions[lk][dn][meal];
  }

  // Final fallback to base counts
  return ((S.guests[lk] || {})[dn] || {} as any)[meal] || 0;
}

// ── Closed services + demand roll-back ──────────────────────────────────────
//
// A service can be marked closed (no seating) while the guest/staff demand
// registered to it still gets cooked — by rolling that demand onto the previous
// OPEN service at the same location. The roll-map below is built once per
// rebuildPlanner() so every demand consumer agrees and the hot loop stays O(1).

const CLOSED_WALK_DAYS = 21;   // how far to walk for the previous/next open service
const ROLL_HORIZON_DAYS = 56;  // forward scan horizon (>= planner/guests/Fix-My-Menu windows)
const MEAL_ORDER: Meal[] = ['lunch', 'dinner']; // earliest -> latest within a day

/** Is this (loc, date, meal) marked closed? Per-date overrides win over the
 *  recurring weekday rule. Null config -> everything open. */
export function isServiceClosed(loc: string, dateStr: string, meal: Meal | string): boolean {
  const cfg = S.closedServices;
  if (!cfg) return false;
  const overrides = cfg.dates ? cfg.dates[dateStr] : undefined;
  if (overrides) {
    for (const o of overrides) {
      if (o.loc !== loc) continue;
      if (o.open && o.open.indexOf(meal as Meal) !== -1) return false;   // re-opened for this date
      if (o.closed && o.closed.indexOf(meal as Meal) !== -1) return true;
    }
  }
  const rec = cfg.recurring && cfg.recurring[loc];
  const meals = rec ? rec[dateToDayName(dateStr)] : undefined;
  return !!meals && meals.indexOf(meal as Meal) !== -1;
}

/** Demand registered to a CLOSED slot: the entered count if any, else the
 *  predicted count for that loc/weekday/meal (predictions already fold staff
 *  into lunch/dinner) — so forgotten/late staff meals still roll. */
function closedSlotDemand(loc: string, dateStr: string, meal: Meal | string): number {
  const entered = getGuests(loc, dateStr, meal);
  if (entered > 0) return entered;
  const lk = loc; // predictions have no event-location keys — reads fall to 0
  const dn = dateToDayName(dateStr);
  if (S.predictions && S.predictions[lk] && S.predictions[lk][dn] && S.predictions[lk][dn][meal] !== undefined) {
    const p = S.predictions[lk][dn][meal];
    return typeof p === 'number' && p > 0 ? p : 0;
  }
  return 0;
}

/** The open service a closed slot's demand rolls onto: walk BACKWARD (earlier
 *  meal same day, then prior days latest->earliest) for a still-cookable
 *  "cook ahead" service, then a FORWARD fallback to the next open service.
 *  A target must be open AND not already past: a service whose cook window has
 *  closed can't take on rolled demand, so we skip it and keep walking. That's
 *  what lets demand roll FORWARD to the next still-cookable service when the
 *  usual backward cook-ahead slot has already passed (rather than vanishing).
 *  Ignores whether a batch is assigned. null only when no non-past open service
 *  exists within the walk window. */
export function previousOpenService(loc: string, dateStr: string, meal: Meal): Service | null {
  const base = new Date(dateStr + 'T12:00:00');
  const startIdx = MEAL_ORDER.indexOf(meal);
  const viable = (iso: string, m: Meal): boolean =>
    !isServiceClosed(loc, iso, m) && !isServicePast({ loc: loc as Location, date: iso, meal: m });
  for (let off = 0; off <= CLOSED_WALK_DAYS; off++) {
    const d = new Date(base); d.setDate(base.getDate() - off);
    const iso = dateToIso(d);
    const meals = off === 0 ? MEAL_ORDER.slice(0, startIdx).reverse() : MEAL_ORDER.slice().reverse();
    for (const m of meals) if (viable(iso, m)) return { loc: loc as Location, date: iso, meal: m };
  }
  for (let off = 0; off <= CLOSED_WALK_DAYS; off++) {
    const d = new Date(base); d.setDate(base.getDate() + off);
    const iso = dateToIso(d);
    const meals = off === 0 ? MEAL_ORDER.slice(startIdx + 1) : MEAL_ORDER.slice();
    for (const m of meals) if (viable(iso, m)) return { loc: loc as Location, date: iso, meal: m };
  }
  return null;
}

// Roll-map: open-slot key -> rolled guest amount. Warnings: slot key -> reason.
let _rollMap = new Map<string, number>();
let _rollWarn = new Map<string, { amount: number; reason: 'no-dish' | 'no-target' }>();
// Per open-target: the set of source meals whose closed-slot demand rolled in.
// Used only to label the rolled-in badge ("from Dinner" vs a generic label when
// the demand aggregates from more than one kind of source meal).
let _rollFrom = new Map<string, Set<Meal>>();

/** Rebuild the closed->open roll-map. Called at the top of
 *  recomputeBatchAllocations (i.e. once per rebuildPlanner). Iterating closed
 *  slots and resolving each via previousOpenService once means the sum-side and
 *  the target-side can never disagree. Depends only on closures + raw/predicted
 *  guests, so it stays valid through Fix My Menu's speculative assignment. */
export function buildRollMap(): void {
  _rollMap = new Map();
  _rollWarn = new Map();
  _rollFrom = new Map();
  if (!S.closedServices) return;
  // Horizon: today - walk .. max(today + ROLL_HORIZON_DAYS, latest service date) + walk.
  const today = getToday();
  let maxTime = today.getTime() + ROLL_HORIZON_DAYS * 86400000;
  for (const b of S.batches) {
    for (const svc of (b.services || [])) {
      const t = new Date(svc.date + 'T12:00:00').getTime();
      if (t > maxTime) maxTime = t;
    }
  }
  const cur = new Date(today.getTime() - CLOSED_WALK_DAYS * 86400000);
  const end = new Date(maxTime + CLOSED_WALK_DAYS * 86400000);
  while (cur <= end) {
    const iso = dateToIso(cur);
    for (const loc of allActiveLocations()) {
      for (const meal of MEAL_ORDER) {
        if (!isServiceClosed(loc, iso, meal)) continue;
        const svc: Service = { loc, date: iso, meal };
        if (isServicePast(svc)) continue;
        const amt = closedSlotDemand(loc, iso, meal);
        if (amt <= 0) continue;
        // previousOpenService skips past services in both directions, so the
        // target is always a still-cookable open service: if the usual backward
        // "cook ahead" slot has already passed (e.g. a closed Fri dinner whose
        // same-day Fri lunch is over by the afternoon), the demand rolls FORWARD
        // onto the next open service instead of vanishing. Only a genuinely
        // all-closed/all-past window yields null → a no-target warning.
        const tgt = previousOpenService(loc, iso, meal);
        if (!tgt) { _rollWarn.set(slotKey(svc), { amount: amt, reason: 'no-target' }); continue; }
        const tk = slotKey(tgt);
        _rollMap.set(tk, (_rollMap.get(tk) || 0) + amt);
        let fromSet = _rollFrom.get(tk);
        if (!fromSet) { fromSet = new Set(); _rollFrom.set(tk, fromSet); }
        fromSet.add(meal);
      }
    }
    cur.setDate(cur.getDate() + 1);
  }
  // Flag roll-targets that currently have no dish assigned (#7 — empty target).
  for (const [tk, amount] of _rollMap) {
    if (!(S.planner[tk] || []).length) _rollWarn.set(tk, { amount, reason: 'no-dish' });
  }
}

/** Guests a service actually needs cooking for: a closed slot -> 0 (counted at
 *  its roll-target); an open slot -> its own raw guests + anything rolled in.
 *  O(1): reads the cached roll-map (callers must rebuildPlanner first). */
export function getEffectiveGuests(loc: string, dateStr: string, meal: Meal | string): number {
  if (isServiceClosed(loc, dateStr, meal)) return 0;
  return getGuests(loc, dateStr, meal) + (_rollMap.get(`${loc}-${dateStr}-${meal}`) || 0);
}

/** Guests rolled INTO this open slot from closed siblings (0 if none). */
export function rolledInto(loc: string, dateStr: string, meal: Meal | string): number {
  return _rollMap.get(`${loc}-${dateStr}-${meal}`) || 0;
}

/** Roll warning for a slot, or null. 'no-dish' = open target has rolled demand
 *  but no batch; 'no-target' = closed slot found no open service in window. */
export function rollWarning(loc: string, dateStr: string, meal: Meal | string): { amount: number; reason: 'no-dish' | 'no-target' } | null {
  return _rollWarn.get(`${loc}-${dateStr}-${meal}`) || null;
}

/** The source meal of demand rolled INTO this open slot, when unambiguous
 *  (a single kind of source meal — e.g. a closed dinner rolling onto lunch).
 *  Returns null when demand aggregates from more than one source meal (e.g. a
 *  whole closed day rolling cross-day), so callers can show a generic label
 *  instead of mislabelling the source. */
export function rolledFromMeal(loc: string, dateStr: string, meal: Meal | string): Meal | null {
  const set = _rollFrom.get(`${loc}-${dateStr}-${meal}`);
  if (set && set.size === 1) return [...set][0];
  return null;
}

/** Per-service allocation in liters, read from the per-batch peer-share
 *  allocator cache (set by recomputeBatchAllocations).
 *  Single source of truth for "how many liters does this batch contribute
 *  to this slot" — used by calcRequired, calcRequiredBreakdown, the dish
 *  tile per-service line, and calcRequiredForLoc so all consumers agree.
 *
 *  Returns 0 for past services (no longer pulling stock) and 0 when the
 *  cache has no entry (caller hasn't rebuilt the planner yet — same
 *  contract as the calcRequired total). */
export function calcRequiredAtService(dish: Batch, svc: Service): number {
  if (isServicePast(svc)) return 0;
  return lookupBatchAllocation(dish, svc) ?? 0;
}

/** Catering demand in liters for a dish — guest count split across the
 *  catering's same-type peer dishes. Catering routes to the specific dishId
 *  (no family-wide reallocation). Shared by calcRequired (cache-backed) and
 *  calcRequiredLive (uncached) so the catering half of the two functions
 *  cannot drift apart. */
/** A catering still pulls cooking + ordering demand UNLESS it has already been
 *  delivered — i.e. its date is strictly before today (Amsterdam-local, matching
 *  isServiceDatePast / the service retirement FMM uses). Undated caterings, and a
 *  catering dated today, keep counting (the explicit "did today's catering leave?"
 *  inventory prompt is a separate future step). An unparseable date fails safe
 *  (keeps counting). SINGLE SOURCE OF TRUTH for catering retirement — cateringDemand,
 *  calcTotalGuests, calcRequiredBreakdown and the dish detail view all gate on this
 *  so cooking-litres and ingredient-order quantities can never drift apart. */
export function cateringActive(c: { date: string | null }): boolean {
  if (!c.date) return true;
  const d = strToDate(c.date);
  if (!d || isNaN(d.getTime())) return true;   // unparseable date → fail safe: keep cooking
  const now = getAmsterdamNow();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const cDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return cDay >= today;
}

function cateringDemand(dish: Batch): number {
  let total = 0;
  (S.caterings || []).forEach((c: Catering) => {
    if (!cateringActive(c)) return;   // delivered catering — demand retired
    const cd = (c.dishes || []).find((cd: CateringDish) => cd.dishId === dish.id);
    if (cd) {
      const peers = (c.dishes || []).filter((d: CateringDish) => d.type === dish.type).length;
      total += ((c.guestCount || 0) / Math.max(peers, 1)) * ((dish.serving || 280) / 1000);
    }
  });
  return total;
}

export function calcRequired(dish: Batch): number {
  let total = 0;
  (dish.services || []).forEach((svc: Service) => {
    if (isServicePast(svc)) return; // Skip served services — no longer pulling stock
    // Per-slot demand comes from the per-batch peer-share cache (set by
    // rebuildPlanner → recomputeBatchAllocations). Callers must rebuild
    // the planner before reading; missing entries default to 0 so a
    // not-yet-assigned service contributes nothing instead of silently
    // invoking a stale even-split fallback.
    total += lookupBatchAllocation(dish, svc) ?? 0;
  });
  total += cateringDemand(dish);
  return Math.round(total * 10) / 10;
}

/** Like calcRequired, but derives each service's peer-share demand directly
 *  from live S.batches state instead of reading the _batchAllocations cache.
 *  Returns a value identical to `rebuildPlanner(); calcRequired(dish)` — same
 *  peer count, same per-service 0.1 L rounding (mirrors recordAllocation),
 *  same catering term — but WITHOUT the global O(batches × services) rebuild.
 *
 *  Fix My Menu's scored algorithm evaluates one candidate batch at a time
 *  inside tight nested loops; calling rebuildPlanner() per candidate froze the
 *  browser for seconds. This reads dish.services live, so it stays correct
 *  under the algorithm's speculative `services.push(...) / pop()` pattern. */
export function calcRequiredLive(
  dish: Batch,
  getGuestsFn: (loc: Location, date: string, meal: Meal) => number = getEffectiveGuests,
): number {
  let total = 0;
  (dish.services || []).forEach((svc: Service) => {
    if (isServicePast(svc)) return;
    // Peer count = distinct same-type batches serving this slot — the same
    // set recomputeBatchAllocations counts via S.planner[k].filter(type).
    // dish itself is included (it has svc), matching the cached path.
    let peerCount = 0;
    for (const p of S.batches) {
      if (p.type !== dish.type) continue;
      if ((p.services || []).some((s: Service) => s.loc === svc.loc && s.date === svc.date && s.meal === svc.meal)) {
        peerCount++;
      }
    }
    const guests = getGuestsFn(svc.loc, svc.date, svc.meal);
    const liters = (guests / Math.max(peerCount, 1)) * ((dish.serving || 280) / 1000) * reserveFactor();
    total += Math.round(liters * 10) / 10; // mirror recordAllocation's 0.1 L rounding
  });
  total += cateringDemand(dish);
  return Math.round(total * 10) / 10;
}

/** Live peer-share demand (liters) from this dish's non-past services AT `loc`
 *  only — catering excluded (it isn't location-tagged). Mirrors calcRequiredLive's
 *  per-service math, filtered to one location, so the reachability capacity check
 *  can require a batch's West-located demand to fit its West-located stock (West
 *  ships to Centraal, Centraal never returns to West). Reads live S.batches, so it
 *  stays correct under the engine's speculative services.push()/pop(). */
export function calcRequiredAtLocLive(
  dish: Batch,
  loc: Location,
  getGuestsFn: (loc: Location, date: string, meal: Meal) => number = getEffectiveGuests,
): number {
  let total = 0;
  (dish.services || []).forEach((svc: Service) => {
    if (svc.loc !== loc) return;
    if (isServicePast(svc)) return;
    let peerCount = 0;
    for (const p of S.batches) {
      if (p.type !== dish.type) continue;
      if ((p.services || []).some((s: Service) => s.loc === svc.loc && s.date === svc.date && s.meal === svc.meal)) peerCount++;
    }
    total += Math.round((getGuestsFn(svc.loc, svc.date, svc.meal) / Math.max(peerCount, 1)) * ((dish.serving || 280) / 1000) * reserveFactor() * 10) / 10;
  });
  return Math.round(total * 10) / 10;
}

export interface BreakdownLine {
  text: string;
}

export function calcRequiredBreakdown(dish: Batch): string[] {
  const lines: string[] = [];
  (dish.services || []).forEach((svc: Service) => {
    const loc = locName(svc.loc);
    const meal = svc.meal.charAt(0).toUpperCase() + svc.meal.slice(1);
    const dayName = dateToDayName(svc.date);
    // Past services show as "served" instead of contributing liters
    if (isServicePast(svc)) {
      lines.push(`\u2713 ${dayName} ${meal} ${loc} (served)`);
      return;
    }
    const allocated = lookupBatchAllocation(dish, svc) ?? 0;
    const liters = Math.round(allocated * 10) / 10;
    if (liters > 0) {
      const rolled = rolledInto(svc.loc, svc.date, svc.meal);
      let suffix = '';
      if (rolled > 0) {
        const fromMeal = rolledFromMeal(svc.loc, svc.date, svc.meal);
        const src = fromMeal ? `closed ${fromMeal.charAt(0).toUpperCase() + fromMeal.slice(1)}` : 'closed services';
        suffix = ` (incl. ${Math.round(rolled)} from ${src})`;
      }
      lines.push(`${liters}L \u2014 ${dayName} ${meal} ${loc}${suffix}`);
    }
  });
  (S.caterings || []).forEach((c: Catering) => {
    const cd = (c.dishes || []).find((cd: CateringDish) => cd.dishId === dish.id);
    if (!cd) return;
    if (!cateringActive(c)) {
      // Delivered catering \u2014 shown done (like a served service), pulls no demand,
      // so the breakdown lines keep summing to calcRequired.
      lines.push(`\u2713 ${c.name} (delivered)`);
      return;
    }
    const peers = (c.dishes || []).filter((d: CateringDish) => d.type === dish.type).length;
    const liters = Math.round(((c.guestCount || 0) / Math.max(peers, 1)) * ((dish.serving || 280) / 1000) * 10) / 10;
    if (liters > 0) lines.push(`${liters}L \u2014 ${c.name} (${c.guestCount} guests${peers > 1 ? ', 1/' + peers + ' split' : ''})`);
  });
  return lines;
}

export function calcTotalGuests(dish: Batch): number {
  let g = 0;
  (dish.services || []).forEach((svc: Service) => {
    if (isServicePast(svc)) return; // Skip served services
    // Convert the cached allocation (liters) back to guests by dividing by
    // serving size. Same source of truth as calcRequired.
    const litersHere = lookupBatchAllocation(dish, svc) ?? 0;
    const servingL = (dish.serving || 280) / 1000;
    if (servingL > 0) g += litersHere / servingL;
  });
  // Add catering guests (split by same-type peers) — but only for caterings that
  // haven't been delivered, so ingredient ORDER quantities retire in lockstep
  // with the cooking litres (calcRequired). This is what feeds calcIngredientsFromRecipe.
  (S.caterings || []).forEach((c: Catering) => {
    if (!cateringActive(c)) return;
    const cd = (c.dishes || []).find((cd: CateringDish) => cd.dishId === dish.id);
    if (cd) {
      const peers = (c.dishes || []).filter((d: CateringDish) => d.type === dish.type).length;
      g += (c.guestCount || 0) / Math.max(peers, 1);
    }
  });
  return Math.round(g);
}

export function batchHasRecipe(b: Batch): boolean {
  return !!b.recipeId;
}

export function calcIngredientsFromRecipe(dish: Batch): Array<{ name: string; amount: number; unit: string; source: string }> {
  if (!dish.recipeId) return [];
  const recipe = (S.recipes || []).find(r => r.id === dish.recipeId);
  if (!recipe || !recipe.recipeVolume) return [];
  const recipeVolume = recipe.recipeVolume;
  const serving = recipe.servingSize || dish.serving || 280;
  const ingredients = recipe.ingredients.map(ing => {
    let name = ing.ingredientName || ing.flexLabel || '';
    if (!name && ing.ingredientId) {
      const dbIng = (S.ingredientDb || []).find(i => i.id === ing.ingredientId);
      if (dbIng) name = dbIng.name;
    }
    return { name: name || '(unnamed)', amount: ing.rawAmount, unit: ing.unit || 'Grams', source: '' };
  });

  if (ingredients.length === 0) return [];
  const totalGuests = calcTotalGuests(dish);
  if (totalGuests === 0) return [];
  // recipeVolume is in liters (e.g. 10.78), serving is in ml (e.g. 240).
  // Convert recipe volume to ml to match serving size units.
  const recipeVolumeMl = recipeVolume * 1000;
  const guestsPerRecipe = recipeVolumeMl / serving;
  const mult = totalGuests / guestsPerRecipe;
  return ingredients.map(ing => ({
    name: ing.name,
    amount: Math.round(ing.amount * mult),
    unit: ing.unit,
    source: ing.source,
  }));
}

// ── Per-location, transport-time-aware stock coverage ───────────────────────
//
// The transport model is ONE morning van West→Centraal, no reverse van. Coverage
// answers "can this batch's physical stock actually reach each service in time?"
// instead of the old pooled "total stock ≥ total demand" check.
//
//   - West service:     only stock positioned at West can serve it. Centraal
//                       stock NEVER comes back to West (no reverse van).
//   - Centraal service: stock positioned at Centraal (settled + already in
//                       transit) serves it; West stock can serve it too, but
//                       ONLY via a future morning van — see westReachesCentraal.
//                       Same-day Centraal demand is met from Centraal-on-site only.
//
// Each batch allocates its own stock across its own (non-past) services in
// CHRONOLOGICAL order (soonest first), so Centraal-on-site stock is reserved for
// the nearest Centraal service before West stock is allowed to flow to later
// Centraal services. Whatever a service can't draw is its shortfall; whatever's
// left over is surplus (possibly stranded at the wrong location).

const _MEAL_RANK: Record<string, number> = { lunch: 0, dinner: 1 };

/** Timing rule for the single morning West→Centraal van. Given a reference day
 *  `refIso` (the day the stock would be loaded — cook day in Fix My Menu, or
 *  "today" for already-cooked stock), can West stock reach a Centraal service
 *  dated `slotIso` at `meal`? Next morning onward: always. Same day: only the
 *  Sunday dinner shift (Sunday's cook starts very early and there's no Centraal
 *  lunch, so the van leaves late enough to make dinner). Single source of truth
 *  for the West→Centraal clause — isServableBy (menu-fixer) delegates here. */
export function westReachesCentraal(refIso: string, slotIso: string, meal: Meal): boolean {
  if (slotIso > refIso) return true;                                    // next morning+
  if (slotIso === refIso) return dateToDayName(refIso) === 'Sun' && meal === 'dinner';
  return false;                                                          // past
}

/** Generalized "can West stock reach a service at `loc` in time?" for the
 *  hub-and-spoke model. Centraal keeps its exact van rule (incl. the Sunday
 *  dinner exception — that encodes Centraal's specific logistics). EVENT
 *  locations get plain next-morning-only: their transport schedule is
 *  unknown, so same-day is never assumed — a genuine same-day run is handled
 *  by manually shipping + marking arrived (the stock then counts as
 *  positioned on-site). Only meaningful for non-west `loc`. */
export function westReaches(loc: string, refIso: string, slotIso: string, meal: Meal): boolean {
  if (loc === 'centraal') return westReachesCentraal(refIso, slotIso, meal);
  return slotIso > refIso;
}

/** Stock physically positioned at `loc` right now: settled inventory there
 *  (any storage, matching getTotalStock's convention) plus stock already
 *  in-transit heading to `loc`. */
function positionedAt(b: Batch, loc: Location): number {
  return getStockAt(b, loc) + getPendingFromShipments(b, loc);
}

export interface CoverageService {
  loc: Location;
  date: string;
  meal: Meal;
  demand: number;     // liters this batch owes this service (peer-share)
  covered: number;    // liters reachable in time
  shortfall: number;  // demand − covered
}

export interface LocCoverage {
  demand: number;        // non-past demand at this loc (liters)
  covered: number;
  shortfall: number;
  todayShortfall: number;
  positioned: number;    // stock positioned at this loc (settled + incoming transit)
  leftover: number;      // stock still free at this loc AFTER the service allocation
                         // (before catering) — i.e. genuinely re-routable, not just
                         // positioned−demand (which ignores stock the van already
                         // committed to a future cross-location service)
}

export interface BatchCoverage {
  demand: number;          // total non-past demand incl catering
  covered: number;
  shortfall: number;       // total demand that can't be served in time
  surplus: number;         // positioned stock left after covering all reachable demand
  todayShortfall: number;  // shortfall on services dated today (the urgent bit)
  /** Per-location coverage keyed by loc string — west/centraal always
   *  present; event locations appear when the batch touches them (stock,
   *  in-flight shipment, or service). New consumers iterate this. */
  byLoc: Record<string, LocCoverage>;
  /** ALIASES of byLoc.west / byLoc.centraal (same objects) — kept so the 30+
   *  legacy `.west`/`.centraal` reads stay bit-identical. */
  west: LocCoverage;
  centraal: LocCoverage;
  services: CoverageService[];
}

const r1 = (n: number): number => Math.round(n * 10) / 10;

/** Transport-aware coverage for a batch (see section header). `demandFn` is
 *  injectable for testing / for a live (uncached) caller; it defaults to the
 *  cached per-service allocation, so production callers must rebuildPlanner()
 *  first (same contract as calcRequired). Catering demand is location-agnostic
 *  (packed from whatever stock is left) so it draws from the leftover pool. */
export function computeCoverage(
  b: Batch,
  demandFn: (batch: Batch, svc: Service) => number = calcRequiredAtService,
): BatchCoverage {
  const today = dateToIso(getToday());

  const svcs = (b.services || [])
    .filter(s => !isServicePast(s))
    .map(s => ({ s, demand: r1(demandFn(b, s)), covered: 0 }))
    .filter(x => x.demand > 0)
    .sort((a, z) => a.s.date !== z.s.date
      ? (a.s.date < z.s.date ? -1 : 1)
      : (_MEAL_RANK[a.s.meal] ?? 0) - (_MEAL_RANK[z.s.meal] ?? 0));

  // One bucket per location: west/centraal always, plus any event location
  // the batch touches (stock, in-flight shipment, or service). Insertion
  // order (west, centraal, events) is also the render + catering-drain order.
  const locs: string[] = ['west', 'centraal'];
  const seen = new Set(locs);
  const addLoc = (loc: string) => { if (!seen.has(loc)) { seen.add(loc); locs.push(loc); } };
  for (const e of (b.inventory || [])) addLoc(e.loc);
  for (const s of (b.shipments || [])) if (!s.arrived) addLoc(s.toLoc);
  for (const a of svcs) addLoc(a.s.loc);

  const buckets = new Map<string, number>();
  const byLoc: Record<string, LocCoverage> = {};
  for (const loc of locs) {
    const positioned = positionedAt(b, loc);
    buckets.set(loc, positioned);
    byLoc[loc] = { demand: 0, covered: 0, shortfall: 0, todayShortfall: 0, positioned, leftover: 0 };
  }

  // Two-pass allocation so a shortfall is attributed to the location that
  // genuinely can't be covered another way (chronological — soonest first):
  //   Pass 1 — every service draws from its OWN location's stock. A West service
  //            can ONLY ever use West stock; a Centraal/event service uses only
  //            its on-site stock. This reserves West stock for West services
  //            regardless of date (fixes cross-date mis-attribution).
  //   Pass 2 — any NON-WEST service still short that West stock can reach in
  //            time (westReaches: Centraal keeps its van rule incl. the Sunday
  //            exception; event locations are next-morning only) pulls from
  //            the West stock LEFT OVER after Pass 1. Nothing ever flows back
  //            to West, and nothing flows between non-West locations.
  for (const a of svcs) {
    const cur = buckets.get(a.s.loc) ?? 0;
    const t = Math.min(a.demand, cur);
    buckets.set(a.s.loc, cur - t);
    a.covered = t;
  }
  for (const a of svcs) {
    if (a.s.loc === 'west') continue;
    const rem = a.demand - a.covered;
    if (rem <= 0 || !westReaches(a.s.loc, today, a.s.date, a.s.meal)) continue;
    const westBucket = buckets.get('west') ?? 0;
    const t = Math.min(rem, westBucket);
    buckets.set('west', westBucket - t);
    a.covered += t;
  }

  const services: CoverageService[] = [];
  for (const a of svcs) {
    const shortfall = r1(a.demand - a.covered);
    const lc = byLoc[a.s.loc];
    lc.demand = r1(lc.demand + a.demand);
    lc.covered = r1(lc.covered + a.covered);
    lc.shortfall = r1(lc.shortfall + shortfall);
    if (a.s.date === today) lc.todayShortfall = r1(lc.todayShortfall + shortfall);
    services.push({ loc: a.s.loc, date: a.s.date, meal: a.s.meal, demand: a.demand, covered: r1(a.covered), shortfall });
  }

  // Catering (location-agnostic) drains the shared pool. Drain West FIRST so each
  // location's leftover reflects what is TRULY idle — the "stuck at West" hint must
  // not count West stock already earmarked for a catering. Event buckets drain
  // last (leftover festival food is packable for a catering too).
  const caterDemand = r1(cateringDemand(b));
  let cater = caterDemand;
  for (const loc of locs) {
    if (cater <= 0) break;
    const cur = buckets.get(loc) ?? 0;
    const t = Math.min(cater, cur);
    buckets.set(loc, r1(cur - t));
    cater = r1(cater - t);
  }
  const caterShort = r1(cater);
  const caterCovered = r1(caterDemand - caterShort);

  let demand = caterDemand, covered = caterCovered, shortfall = caterShort;
  let todayShortfall = 0, surplus = 0;
  for (const loc of locs) {
    const lc = byLoc[loc];
    lc.leftover = r1(buckets.get(loc) ?? 0);
    demand = r1(demand + lc.demand);
    covered = r1(covered + lc.covered);
    shortfall = r1(shortfall + lc.shortfall);
    todayShortfall = r1(todayShortfall + lc.todayShortfall);
    surplus = r1(surplus + lc.leftover);
  }

  return {
    demand,
    covered,
    shortfall,
    surplus: Math.max(0, surplus),
    todayShortfall,
    byLoc,
    west: byLoc.west,
    centraal: byLoc.centraal,
    services,
  };
}

/** This batch's unmet liters at one specific service slot (0 if fully covered or
 *  not serving it). Used by the planner to aggregate a slot's shortfall across
 *  all batches assigned to it ("auto-fill from other stock"). `demandFn` is
 *  injectable for the same reason as computeCoverage. */
export function serviceShortfall(
  b: Batch,
  loc: Location,
  date: string,
  meal: Meal,
  demandFn: (batch: Batch, svc: Service) => number = calcRequiredAtService,
): number {
  const s = computeCoverage(b, demandFn).services.find(x => x.loc === loc && x.date === date && x.meal === meal);
  return s ? s.shortfall : 0;
}

/** Map a coverage result to the batch tile's +/− badge. A real shortfall (stock
 *  not positioned to meet demand in time) dominates — surplus stranded at the
 *  wrong location must NOT mask it. Only when nothing is short do we show the
 *  leftover surplus as a positive cushion. Pure, so it's unit-testable directly. */
export function coverageBadge(cov: BatchCoverage): { diff: number; str: string; cls: string } {
  const diff = cov.shortfall > 0 ? -cov.shortfall : r1(cov.surplus);
  return {
    diff,
    str: (diff >= 0 ? '+' : '') + diff + 'L',
    cls: cov.shortfall > 0 ? 'stock-miss' : cov.surplus < 5 ? 'stock-low' : 'stock-ok',
  };
}

export function diffStr(d: Batch): { diff: number; str: string; cls: string } {
  return coverageBadge(computeCoverage(d));
}

const STORAGE_BADGE_MAP: Record<string, string> = { Gastro:'b-gastro', Frozen:'b-frozen', 'Vac-packed':'b-vacpack' };

export function storageBadge(s: StorageType | string): string {
  return `<span class="badge ${STORAGE_BADGE_MAP[s] || 'b-gastro'}">${s}</span>`;
}
export function storageBadgeClass(s: StorageType | string): string {
  return 'badge ' + (STORAGE_BADGE_MAP[s] || 'b-gastro');
}
// ── SERVED / ARCHIVE ─────────────────────────────────────

// Two entry paths into the served/archive flow:
//   - openServedDialog(id) — from a batch tile. Treats the batch as a unit.
//     If the batch has stock at multiple locations OR pending shipments,
//     shows a cross-loc warning first so the cook knows what they're
//     deleting (audit B-revision: prevents silent cross-loc data loss).
//   - openServedDialogForLoc(id, loc) — from the Inventory modal at `loc`.
//     Only consumes THIS loc's inventory; other locs / shipments untouched.
//     Auto-promotes to a full archive only when total stock + shipments = 0.

export function openServedDialog(id: string): void {
  const d = S.batches.find((x: Batch) => x.id === id);
  if (!d) return;

  const inv = (d.inventory || []).filter(e => (e.qty || 0) > 0);
  const distinctLocs = Array.from(new Set(inv.map(e => e.loc)));
  const pendingShipments = (d.shipments || []).filter(s => !s.arrived);

  if (distinctLocs.length > 1 || pendingShipments.length > 0) {
    // Cross-loc / in-transit warning — archiving will delete ALL of it.
    const locParts = distinctLocs.map(l => {
      const lqty = inv.filter(e => e.loc === l).reduce((s, e) => s + (e.qty || 0), 0);
      return `${lqty.toFixed(1)} L at ${locName(l)}`;
    });
    const transitParts = pendingShipments.map(s =>
      `${(s.qty || 0).toFixed(1)} L in transit to ${locName(s.toLoc)}`
    );
    const summary = [...locParts, ...transitParts].join(' · ');
    showModal(`<h3>⚠️ Archive whole batch?</h3>
      <p style="font-size:13px;color:var(--text2);margin-bottom:16px;">
        "${esc(d.name)}" still has stock across multiple locations or in transit:<br>
        <strong>${summary}</strong><br><br>
        Archiving will delete <strong>all of it</strong> — every inventory entry and every pending shipment. If you only meant to mark this kitchen's share as served, open <em>Do Inventory</em> at this kitchen and use the Served button on the row instead.
      </p>
      <div class="modal-actions">
        <button class="btn" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="confirmArchiveWholeBatch('${d.id}')">Yes, archive whole batch</button>
      </div>`);
    return;
  }

  // Single-loc or already-empty batch — straight to rating dialog.
  _showRatingDialog(d, undefined);
}

/** Loc-scoped entry path — called from the Inventory modal where the cook's
 *  loc context is unambiguous. NEVER shows the whole-batch warning. */
export function openServedDialogForLoc(id: string, loc: Location): void {
  const d = S.batches.find((x: Batch) => x.id === id);
  if (!d) return;
  _showRatingDialog(d, loc);
}

/** Confirms past the cross-loc warning into the full-archive rating flow. */
export function confirmArchiveWholeBatch(id: string): void {
  const d = S.batches.find((x: Batch) => x.id === id);
  if (!d) return;
  _showRatingDialog(d, undefined);
}

function _showRatingDialog(d: Batch, locScope: Location | undefined): void {
  const titleSuffix = locScope ? ` at ${locName(locScope)}` : '';
  // Be honest about what "Served" will actually do. archiveDish falls through
  // to a full archive (the whole batch is removed) when no stock remains
  // anywhere else and nothing is in transit.
  let explainer: string;
  if (locScope) {
    const stockElsewhere = (d.inventory || []).some(e => e.loc !== locScope && (e.qty || 0) > 0);
    const inTransit = (d.shipments || []).some(s => !s.arrived && (s.qty || 0) > 0);
    explainer = (!stockElsewhere && !inTransit)
      ? 'This is the last stock of this batch — the whole batch will be removed from the planner. You can undo it for a few seconds. Optionally rate the dish first:'
      : `This zeroes the stock at ${locName(locScope)} only; the batch stays in the planner because it still has stock elsewhere. You can undo it for a few seconds. Optionally rate the dish first:`;
  } else {
    explainer = 'This will remove the batch from the menu planner. You can undo it for a few seconds. Optionally rate it first:';
  }
  const argSuffix = locScope ? `,'${locScope}'` : '';
  showModal(`<h3>Mark "${esc(d.name)}" as served${titleSuffix}</h3>
    <p style="font-size:13px;color:var(--text2);margin-bottom:16px;">${explainer}</p>
    <div class="fr"><label>Skill required (1-5)</label>
      <div class="rating-row" id="rate-skill">${ratingButtons('skill',0)}</div>
    </div>
    <div class="fr"><label>Speed of prep (1-5)</label>
      <div class="rating-row" id="rate-speed">${ratingButtons('speed',0)}</div>
    </div>
    <div class="fr"><label>Banger rating (1-5)</label>
      <div class="rating-row" id="rate-banger">${ratingButtons('banger',0)}</div>
    </div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn" onclick="archiveDish('${d.id}',false${argSuffix})">Skip rating</button>
      <button class="btn btn-primary" onclick="archiveDish('${d.id}',true${argSuffix})">Save &amp; archive</button>
    </div>`);
}

export let pendingRatings: BatchRatings = { skill:0, speed:0, banger:0 };

export function ratingButtons(key: keyof BatchRatings, val: number): string {
  pendingRatings[key] = val;
  return [1,2,3,4,5].map(n =>
    `<button class="rating-btn${n <= val ? ' on' : ''}" onclick="setRating('${key}',${n})">${n}</button>`
  ).join('');
}

export function setRating(key: keyof BatchRatings, val: number): void {
  pendingRatings[key] = val;
  const el = document.getElementById('rate-'+key);
  if (el) el.innerHTML = ratingButtons(key, val);
}

export function archiveDish(id: string, withRating: boolean, locScope?: Location): void {
  const d = S.batches.find((x: Batch) => x.id === id);
  if (!d) return;

  // Snapshot the batch before any mutation so "Served" can be undone.
  const before: Batch = structuredClone(d);

  // Loc-scoped path (called from Inventory modal): zero out THIS loc's entries
  // and only fully archive when nothing remains anywhere. Other locs + pending
  // shipments are preserved (audit BL1 fix: cook at West marking lunch served
  // must not delete Centraal's stock).
  if (locScope) {
    let zeroedAny = false;
    for (const entry of (d.inventory || [])) {
      if (entry.loc === locScope && (entry.qty || 0) > 0) {
        entry.qty = 0;
        zeroedAny = true;
      }
    }

    const totalRemaining = (d.inventory || []).reduce((s, e) => s + (e.qty || 0), 0);
    const pendingShipQty = (d.shipments || [])
      .filter(s => !s.arrived)
      .reduce((s, sh) => s + (sh.qty || 0), 0);

    if (totalRemaining > 0 || pendingShipQty > 0) {
      // Batch lives on. Surface the remaining breakdown in the undo toast.
      const remainingPieces: string[] = [];
      const byLoc = new Map<string, number>();
      for (const e of (d.inventory || [])) {
        if ((e.qty || 0) > 0) {
          byLoc.set(e.loc, (byLoc.get(e.loc) || 0) + e.qty);
        }
      }
      for (const [loc, q] of byLoc) {
        remainingPieces.push(`${q.toFixed(1)} L at ${locName(loc as Location)}`);
      }
      if (pendingShipQty > 0) {
        remainingPieces.push(`${pendingShipQty.toFixed(1)} L in transit`);
      }
      pendingRatings = { skill:0, speed:0, banger:0 };
      closeModal();
      rerenderCurrentView();
      const action = zeroedAny ? `Served at ${locName(locScope)}` : `No stock to serve at ${locName(locScope)}`;
      pushUndo({
        label: `${action} — batch still has ${remainingPieces.join(' · ')}`,
        restore: () => {
          const i = S.batches.findIndex((x: Batch) => x.id === id);
          if (i >= 0) S.batches[i] = before;
          else S.batches.push(before);
          rebuildPlanner();
          rerenderCurrentView();
          if (_refreshInventoryModal) _refreshInventoryModal();
        },
        commit: () => { scheduleSave(); },
      });
      return;
    }
    // Nothing left anywhere — fall through to full archive.
  }

  // Full archive — the whole batch leaves the planner.
  const rating = withRating ? { ...pendingRatings } : null;
  if (!S.archive) S.archive = [];
  const archiveEntry = {
    id: d.id,
    name: d.name,
    type: d.type,
    cookedDate: d.cookDate || null,
    archivedDate: dateToStr(getToday()),
    rating,
  };
  S.archive.push(archiveEntry);
  // Capture + drop catering refs to the archived batch so the catering's
  // demand doesn't dangle on a dead id. Inlined rather than calling
  // cleanCateringRefs (dishes.ts) — that import would be circular.
  const savedCateringDishes: { id: string; dishes: CateringDish[] }[] = [];
  for (const c of (S.caterings || [])) {
    if (c.dishes?.some((cd: CateringDish) => cd.dishId === id)) {
      savedCateringDishes.push({ id: c.id, dishes: structuredClone(c.dishes) });
    }
  }
  S.batches = S.batches.filter((x: Batch) => x.id !== id);
  for (const c of (S.caterings || [])) {
    if (c.dishes) c.dishes = c.dishes.filter((cd: CateringDish) => cd.dishId !== id);
  }
  pendingRatings = { skill:0, speed:0, banger:0 };
  closeModal();
  rebuildPlanner();
  rerenderCurrentView();
  pushUndo({
    label: esc(d.name) + ' archived',
    restore: () => {
      S.batches.push(before);
      for (const snap of savedCateringDishes) {
        const c = (S.caterings || []).find(x => x.id === snap.id);
        if (c) c.dishes = snap.dishes;
      }
      const ai = S.archive ? S.archive.indexOf(archiveEntry) : -1;
      if (ai >= 0) S.archive!.splice(ai, 1);
      rebuildPlanner();
      rerenderCurrentView();
      if (_refreshInventoryModal) _refreshInventoryModal();
    },
    commit: () => {
      // Recipe-rating update is deferred to commit so an undo leaves the
      // recipe's averages untouched.
      if (rating && d.recipeId) {
        const recipe = (S.recipes || []).find(r => r.id === d.recipeId);
        if (recipe) {
          const n = recipe.timesServed || 0;
          const newN = n + 1;
          recipe.avgSkill = ((recipe.avgSkill || 0) * n + (rating.skill || 0)) / newN;
          recipe.avgSpeed = ((recipe.avgSpeed || 0) * n + (rating.speed || 0)) / newN;
          recipe.avgBanger = ((recipe.avgBanger || 0) * n + (rating.banger || 0)) / newN;
          recipe.timesServed = newN;
          apiPost(`/api/recipes/${recipe.id}`, { avgSkill: recipe.avgSkill, avgSpeed: recipe.avgSpeed, avgBanger: recipe.avgBanger, timesServed: recipe.timesServed }, 'PATCH')
            .catch((e: unknown) => console.error('Failed to update recipe ratings:', e));
        }
      }
      // The archived batch is leaving the DB. A served batch's food is consumed,
      // so its stock record is meaningless now — drain the server row BEFORE the
      // delete lands. Otherwise the cannot-delete-with-stock guard (CORR-1,
      // dbDeleteBatchIds) refuses the archive and the batch lingers with its old
      // stock. The guard still blocks ACCIDENTAL stock-bearing deletes (those
      // never drain first). .finally() runs the delete save whether or not the
      // drain succeeded: on a drain failure the guard simply skips the delete and
      // the batch survives — safe, no silent stock loss. (e2e: inventory-served-disappear)
      apiPost(`/api/batches/${id}`, { inventory: [], shipments: [] }, 'PATCH')
        .catch((e: unknown) => console.error('Failed to drain archived batch stock before delete:', e))
        .finally(() => scheduleSave());
    },
  });
}
// Maps a recipe/batch type string to its badge CSS modifier. Topping & Bread
// are recipe-only categories (see VALID_RECIPE_TYPES in lib/db.ts).
function typeBadgeModifier(t: DishType | string): string {
  if (t === 'Dessert') return 'b-dessert';
  if (t === 'Topping') return 'b-topping';
  if (t === 'Bread') return 'b-bread';
  return t === 'Soup' ? 'b-soup' : 'b-main';
}
export function typeBadge(t: DishType | string): string {
  return `<span class="badge ${typeBadgeModifier(t)}">${t}</span>`;
}
export function typeBadgeClass(t: DishType | string): string {
  return 'badge ' + typeBadgeModifier(t);
}
export const TYPES: DishType[] = ['Soup','Main course','Dessert'];
export function cycleType(id: string): void {
  const d = S.batches.find((x: Batch) => x.id === id);
  if (!d) return;
  const idx = TYPES.indexOf(d.type || 'Soup');
  d.type = TYPES[(idx + 1) % TYPES.length];
  scheduleSave();
  rerenderCurrentView();
}
export function toggleOrder(id: string): void {
  const d = S.batches.find((x: Batch) => x.id === id);
  if (!d) return;
  d.orderFor = !d.orderFor;
  scheduleSave();
  rerenderCurrentView();
}
export function chipClass(d: Batch): string {
  if ((d.shipments || []).some(s => !s.arrived)) return 'chip-tr';
  if (d.type === 'Soup') return 'chip-soup';
  if (d.type === 'Dessert') return 'chip-dessert';
  return 'chip-main';
}

// ── Date utilities (defined here to avoid circular deps with dishes.ts) ──

export function getToday(): Date {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function dateToStr(d: Date): string {
  const dd = String(d.getDate()).padStart(2,'0');
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const yyyy = d.getFullYear();
  return dd+'/'+mm+'/'+yyyy;
}

export function strToDate(s: string): Date | null {
  if (!s) return null;
  // handle dd/mm/yyyy
  const parts = s.split('/');
  if (parts.length === 3) return new Date(parseInt(parts[2]), parseInt(parts[1])-1, parseInt(parts[0]));
  // handle yyyy-mm-dd (legacy)
  return new Date(s);
}

// ═══════════════════════════════════════════════════════════════════
