import { S, DAYS, MEALS, STORAGE, LOCATIONS, ALLERGENS, INGREDIENT_TYPES, INGREDIENT_CATEGORIES, ACCOMPANIMENTS, getStorageColor } from './state';
import { newId, scheduleSave, toast, toastError, apiPost, apiGet, todayIso } from './utils';
import { pushUndo } from './undo';
import { rebuildPlanner, isBatchCooked, getAmsterdamNow, dateToDayName, dateToIso, isServicePast, calcRequired, calcRequiredAtService, calcRequiredBreakdown, calcTotalGuests, calcIngredientsFromRecipe, diffStr, storageBadge, storageBadgeClass, typeBadge, typeBadgeClass, TYPES, cycleType, chipClass, getToday, dateToStr, strToDate, openServedDialog, getGuests, toggleOrder, getTotalStock, getStockAt, getPendingFromShipments, addInventory, removeInventory, consolidateInventory, isStaleEntry } from './core';
import { showModal, closeModal, esc } from './modal';
import { rerenderCurrentView, getCurrentScreen } from './navigate';
import { trackEvent } from './telemetry';
import { addDishFromRecipe } from './recipes';
import { openPostCookRecording, openBatchRecipe } from './recipe-editor';
import { batchDragStart, batchDragEnd, openReplaceBatch } from './planner';
import type { Batch, CateringDish, DishType, Location, StorageType, Service, InventoryEntry, Shipment } from '@shared/types';
import { locName } from '@shared/location';

/** Check if a batch has a v2 recipe with unresolved flexible ingredient slots */
function hasUnresolvedFlexible(d: Batch): boolean {
  if (!d.recipeId) return false;
  const recipe = S.recipes.find(r => r.id === d.recipeId);
  if (!recipe) return false;
  const hasFlex = recipe.ingredients.some(i => i.isFlexible);
  if (!hasFlex) return false;
  // Check if already resolved via actualIngredients
  const resolved = d.actualIngredients as Array<{ ingredientId: string; name: string }> | undefined;
  if (resolved && resolved.length > 0) return false;
  return true;
}

// Legacy fields that exist on batch objects at runtime but aren't in the Batch interface
interface BatchWithLegacy extends Batch {
  cookMode?: string;
  cookDay?: string | null;
}

// ── Unified-batch tile helpers ──────────────────────────────────────────────
//
// In the unified-batch model a single Batch can carry stock at multiple
// (loc, storage) pairs PLUS pending shipments. These helpers produce the
// short, compact strings tile rendering uses everywhere.

/** Compact "where the food is" line, e.g. "55L West/Gastro · 25L Centraal/Gastro · +10L → Centraal pending". */
function renderInventorySummary(d: Batch): string {
  const inv = (d.inventory || []).filter(e => e.qty > 0);
  const ship = (d.shipments || []).filter(s => !s.arrived);
  if (inv.length === 0 && ship.length === 0) return '<span style="color:var(--text3);font-size:11px;">empty</span>';
  const invParts = inv.map(e => `${e.qty.toFixed(1)}L ${e.loc === 'centraal' ? 'C' : 'W'}/${e.storage}`);
  const shipParts = ship.map(s => `+${s.qty.toFixed(1)}L &rarr; ${s.toLoc === 'centraal' ? 'C' : 'W'} pending`);
  return [...invParts, ...shipParts].join(' &middot; ');
}

/** Storage-aware compact location chips for the tile. Returns one badge per
 *  inventory entry + one per pending shipment.
 *
 *  Color encoding (cook needs to read these at a glance during service):
 *   - West Gastro/Vac-packed:     amber (b-west)
 *   - Centraal Gastro/Vac-packed: green (b-centraal)
 *   - West Frozen:                light blue (b-frozen-west)
 *   - Centraal Frozen:            dark blue (b-frozen-centraal)
 *  Frozen badges also carry a ❄️ prefix so colorblind cooks have a second
 *  signal. Pending shipments stay in the destination color (green = "going
 *  to Centraal" etc.) plus the → arrow. */
function renderInventoryBadges(d: Batch): string {
  const inv = (d.inventory || []).filter(e => e.qty > 0);
  const ship = (d.shipments || []).filter(s => !s.arrived);
  const badges: string[] = [];
  for (const e of inv) {
    const isFrozen = e.storage === 'Frozen';
    const cls = isFrozen
      ? (e.loc === 'centraal' ? 'b-frozen-centraal' : 'b-frozen-west')
      : (e.loc === 'centraal' ? 'b-centraal' : 'b-west');
    const prefix = isFrozen ? '❄️ ' : '';
    badges.push(`<span class="badge ${cls}" title="${e.qty.toFixed(1)}L at ${locName(e.loc)} (${e.storage})">${prefix}${e.qty.toFixed(1)}L ${e.loc === 'centraal' ? 'C' : 'W'}</span>`);
  }
  for (const s of ship) {
    const cls = s.toLoc === 'centraal' ? 'b-twc' : 'b-tww';
    badges.push(`<span class="badge ${cls}" title="${s.qty.toFixed(1)}L pending shipment to ${locName(s.toLoc)}">&rarr; ${s.qty.toFixed(1)}L ${s.toLoc === 'centraal' ? 'C' : 'W'}</span>`);
  }
  return badges.join(' ');
}

// ── DISH LIST ─────────────────────────────────────────────
export let dishSort = { col: 'default', dir: 'asc' };

export function renderDishesOverview() {
  const f = S.filters;
  const filtered = S.batches.filter(d => {
    if (f.loc !== 'all') {
      const loc = f.loc as Location;
      // Show batches with stock at this loc OR services at this loc.
      // Pending shipments TO this loc also count — the food is on its way.
      const hasStock = getStockAt(d, loc) > 0;
      const hasIncoming = getPendingFromShipments(d, loc) > 0;
      const hasService = (d.services || []).some(s => s.loc === loc);
      if (!hasStock && !hasIncoming && !hasService) return false;
    }
    if (f.storage !== 'all') {
      const stor = f.storage as StorageType;
      // Storage filter matches if ANY inventory entry uses this storage.
      const hasStorage = (d.inventory || []).some(e => e.storage === stor && e.qty > 0);
      if (!hasStorage) return false;
    }
    return true;
  });

  // Sort
  const sorted = dishSort.col === 'default' ? filtered : [...filtered].sort((a: Batch, b: Batch) => {
    let va: string | number, vb: string | number;
    switch (dishSort.col) {
      case 'name': va = a.name.toLowerCase(); vb = b.name.toLowerCase(); break;
      case 'date':
        va = a.cookDate ? cookDateSortVal(a.cookDate) : '9999';
        vb = b.cookDate ? cookDateSortVal(b.cookDate) : '9999';
        break;
      case 'type': va = a.type || ''; vb = b.type || ''; break;
      case 'stock': va = getTotalStock(a); vb = getTotalStock(b); break;
      case 'diff':
        va = diffStr(a).diff; vb = diffStr(b).diff;
        break;
      default: va = 0; vb = 0;
    }
    if (va < vb) return dishSort.dir === 'asc' ? -1 : 1;
    if (va > vb) return dishSort.dir === 'asc' ? 1 : -1;
    return 0;
  });

  const arrow = (col: string) => dishSort.col === col ? (dishSort.dir === 'asc' ? ' ▲' : ' ▼') : '';
  const sCls = (col: string) => `sortable${dishSort.col === col ? ' active' : ''}`;

  const html = `
  <div class="btn-row" style="margin-bottom:12px;">
    <button class="btn btn-primary" data-testid="new-batch-btn" onclick="openNewDish()">+ New batch</button>
  </div>
  <div class="filter-bar">
    <div style="display:flex;gap:4px;flex-wrap:wrap;">
      <button class="fc ${f.loc === 'all' ? 'on' : ''}" onclick="setFilter('loc','all')">All locations</button>
      <button class="fc ${f.loc === 'west' ? 'on' : ''}" onclick="setFilter('loc','west')">Sering West</button>
      <button class="fc ${f.loc === 'centraal' ? 'on' : ''}" onclick="setFilter('loc','centraal')">Sering Centraal</button>
    </div>
    <div class="filter-sep"></div>
    <div style="display:flex;gap:4px;flex-wrap:wrap;">
      <button class="fc ${f.storage === 'all' ? 'on' : ''}" onclick="setFilter('storage','all')">All storage</button>
      ${STORAGE.map(s => `<button class="fc ${f.storage === s ? 'on' : ''}" onclick="setFilter('storage','${s}')">${s}</button>`).join('')}
    </div>
  </div>
  <div style="display:flex;gap:12px;font-size:10px;color:var(--text3);margin-bottom:8px;padding:4px 0;">
    <span><span style="display:inline-block;width:10px;height:10px;background:#BA7517;border-radius:2px;vertical-align:middle;margin-right:3px;"></span>At West</span>
    <span><span style="display:inline-block;width:10px;height:10px;background:#0F6E56;border-radius:2px;vertical-align:middle;margin-right:3px;"></span>At Centraal</span>
    <span><span style="display:inline-block;width:10px;height:10px;background:#97C459;border-radius:2px;vertical-align:middle;margin-right:3px;"></span>Pending shipment</span>
  </div>
  <div style="display:flex;gap:8px;align-items:center;font-size:12px;color:var(--text2);margin-bottom:8px;">
    <span>${sorted.length} batch${sorted.length !== 1 ? 'es' : ''}</span>
    <span style="margin-left:auto;">Sort:</span>
    <button class="fc ${dishSort.col === 'name' ? 'on' : ''}" onclick="dishSortBy('name')">Name${arrow('name')}</button>
    <button class="fc ${dishSort.col === 'date' ? 'on' : ''}" onclick="dishSortBy('date')">Cook date${arrow('date')}</button>
    <button class="fc ${dishSort.col === 'stock' ? 'on' : ''}" onclick="dishSortBy('stock')">Stock${arrow('stock')}</button>
    <button class="fc ${dishSort.col === 'diff' ? 'on' : ''}" onclick="dishSortBy('diff')">+/-${arrow('diff')}</button>
  </div>
  ${sorted.length === 0 ? '<div class="empty">No batches match these filters</div>' : (dishSort.col !== 'default' ? sorted.map(d => renderBatchTile(d)).join('') : renderDishGroups(sorted))}`;

  document.getElementById('planner-content')!.innerHTML = html;
}

export function dishSortBy(col: string) {
  if (dishSort.col === col) {
    if (dishSort.dir === 'asc') dishSort.dir = 'desc';
    else { dishSort.col = 'default'; dishSort.dir = 'asc'; } // third click resets
  } else {
    dishSort.col = col;
    dishSort.dir = col === 'stock' || col === 'diff' ? 'desc' : 'asc';
  }
  rerenderCurrentView();
}

export function cookDateSortVal(ddmmyyyy: string) {
  if (!ddmmyyyy) return '9999-99-99';
  const parts = ddmmyyyy.split('/');
  if (parts.length === 3) return parts[2] + '-' + parts[1] + '-' + parts[0];
  return ddmmyyyy;
}

export function logisticsRowClass(d: Batch) {
  // Unified-batch model: a batch may have inventory at multiple locs and
  // pending shipments. Pick the "primary" loc for color-coding by where
  // most stock currently lives. If empty, use the destination of the first
  // pending shipment. Default West.
  const inv = d.inventory || [];
  const totalAt = (loc: Location) => inv.filter(e => e.loc === loc).reduce((s, e) => s + (e.qty || 0), 0);
  const west = totalAt('west');
  const centraal = totalAt('centraal');
  if (west > 0 || centraal > 0) {
    return centraal > west ? 'log-centraal' : 'log-west';
  }
  const pending = (d.shipments || []).find(s => !s.arrived);
  if (pending) return pending.toLoc === 'centraal' ? 'log-twc' : 'log-tww';
  return 'log-west';
}

export function renderDishGroups(dishes: Batch[]) {
  // Frozen now means "any inventory entry uses Frozen storage" since a single
  // batch can hold multiple entries. A batch with both Gastro and Frozen
  // entries counts as cooked (Gastro is the primary working stock); we only
  // pull batches into the Frozen section when ALL their stock is Frozen.
  const allFrozen = (b: Batch) => {
    const inv = b.inventory || [];
    const totalQty = inv.reduce((s, e) => s + (e.qty || 0), 0);
    if (totalQty <= 0) return false;
    return inv.every(e => e.qty === 0 || e.storage === 'Frozen');
  };
  const toCook = dishes.filter(d => !isBatchCooked(d) && !allFrozen(d));
  const cooked = dishes.filter(d => isBatchCooked(d) && !allFrozen(d));
  const frozen = dishes.filter(d => allFrozen(d));

  let html = '';

  // Per audit S7: same-recipe-different-batch is intentional in the new
  // model. Render each batch as its own tile, no family grouping.
  if (toCook.length) {
    html += `<div class="dish-section-hdr"><div class="dish-section-dot" style="background:var(--amber);"></div>To cook <span class="dish-section-count">(${toCook.length})</span></div>`;
    html += toCook.map(d => renderBatchTile(d)).join('');
  }

  if (cooked.length) {
    html += `<div class="dish-section-hdr"><div class="dish-section-dot" style="background:var(--green);"></div>Cooked <span class="dish-section-count">(${cooked.length})</span></div>`;
    html += cooked.map(d => renderBatchTile(d)).join('');
  }

  if (frozen.length) {
    html += `<div class="dish-section-hdr"><div class="dish-section-dot" style="background:var(--blue);"></div>Frozen <span class="dish-section-count">(${frozen.length})</span></div>`;
    html += frozen.map(d => renderBatchTile(d)).join('');
  }

  return html;
}

// renderMergedSameLocationTile + renderFamilyGrouped were deleted in the
// unified-batch rewrite (Checkpoint 3 Task B). The new model has no families,
// so cross-batch merging is no longer a thing. renderDishGroups now renders
// each batch as its own tile.
//
// Stub kept temporarily for outside callers still importing the old name
// (orders.ts, dashboard.ts — Checkpoint 5 work). Will be removed once all
// consumers update. Just maps each batch to renderBatchTile.
//
// @deprecated Use `dishes.map(d => renderBatchTile(d)).join('')` directly.
export function renderFamilyGrouped(dishes: Batch[], tileOpts?: BatchTileOptions): string {
  return dishes.map(d => renderBatchTile(d, tileOpts)).join('');
}

// NOTE: This was overwritten in original JS by the 2-arg version below.
// Renamed to avoid duplicate export. This is dead code.
export function renderBatchTileOverview(d: Batch) {
  const { str, cls } = diffStr(d);
  const totalStock = getTotalStock(d);
  // Stale = ANY non-Frozen inventory entry past its shelf life. Surfaces the
  // worst-case so the cook investigates via Edit modal Power view.
  const hasStaleEntry = (d.inventory || []).some(e => e.qty > 0 && e.storage !== 'Frozen' && isStaleEntry(e));
  const allFrozen = (d.inventory || []).length > 0 && (d.inventory || []).every(e => e.qty === 0 || e.storage === 'Frozen');
  const allAg = [...(d.allergens || []), ...(d.extraAllergens || [])];
  const svcLbls = (d.services || []).map(s => {
    const ml = s.meal === 'lunch' ? 'L' : 'D';
    const lc = s.loc === 'west' ? 'SW' : 'SC';
    return `<strong>${dateToDayName(s.date)}</strong> ${ml} ${lc}`;
  }).join(' · ');
  const isSel = S.selected.has(d.id);
  const cookHtml = getCookCellHtml(d);
  const logClass = logisticsRowClass(d);
  const inventoryBadges = renderInventoryBadges(d);
  return `<div class="dish-row ${logClass}${isSel ? ' selected' : ''}${hasStaleEntry ? ' stale-row' : ''}${allFrozen ? ' frozen-row' : ''}">
    <div class="sel-box${isSel ? ' checked' : ''}" onclick="toggleSelect('${d.id}')"></div>
    <div>
      <input class="inline-edit inline-edit-name" value="${esc(d.name)}" onchange="inlineEdit('${d.id}','name',this.value)" onclick="event.stopPropagation();this.select()" />
      <div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;margin-top:2px;padding-left:6px;">
        <span class="${typeBadgeClass(d.type)}" style="cursor:pointer;" onclick="event.stopPropagation();cycleType('${d.id}')" title="Click to change">${d.type}</span>
        <div class="allergen-inline" id="ag-inline-${d.id}" style="display:inline-flex;">
          ${allAg.map(a => `<span class="allergen-pill" onclick="event.stopPropagation();inlineRemoveAllergen('${d.id}','${esc(a)}')" title="Click to remove">${esc(a)}</span>`).join('')}
          <button class="allergen-add-btn" onclick="event.stopPropagation();inlineAddAllergenStart('${d.id}',event)" title="Add allergen">+</button>
        </div>
        ${svcLbls ? `<span style="font-size:12px;color:var(--text);">${svcLbls}</span>` : '<span style="font-size:12px;font-weight:600;color:var(--red);">no day assigned</span>'}
      </div>
    </div>
    <div class="col-cook">${cookHtml}</div>
    <div class="col-stock">
      <span class="batch-stock-total" style="font-weight:500;cursor:pointer;text-decoration:underline;text-decoration-style:dotted;text-underline-offset:2px;" onclick="event.stopPropagation();openInventoryEditor('${d.id}')" title="Click to edit per-location stock">${totalStock.toFixed(1)}L</span>
    </div>
    <div class="col-diff ${cls}" title="${calcRequiredBreakdown(d).join('&#10;') || 'No services assigned'}">${str}</div>
    <div class="col-logistics" style="display:flex;flex-wrap:wrap;gap:3px;">
      ${inventoryBadges}
    </div>
    <div><button class="order-toggle-btn${d.orderFor ? ' on' : ''}" onclick="event.stopPropagation();toggleOrder('${d.id}')">${d.orderFor ? 'Order' : '—'}</button></div>
    <div><button class="served-btn" onclick="event.stopPropagation();openServedDialog('${d.id}')">Served</button></div>
    <div class="m-stock-row">
      <span style="font-size:12px;color:var(--text2);">Stock</span>
      <span class="batch-stock-total" style="font-weight:500;cursor:pointer;text-decoration:underline;text-decoration-style:dotted;text-underline-offset:2px;" onclick="event.stopPropagation();openInventoryEditor('${d.id}')" title="Click to edit per-location stock">${totalStock.toFixed(1)}L</span>
      <span class="${cls}" style="font-size:12px;" title="${calcRequiredBreakdown(d).join('&#10;') || 'No services assigned'}">${str}</span>
      <span style="display:flex;flex-wrap:wrap;gap:3px;font-size:10px;">${inventoryBadges}</span>
      <button class="btn btn-sm served-btn" onclick="event.stopPropagation();openServedDialog('${d.id}')" style="margin-left:auto;">Served</button>
    </div>
  </div>`;
}

// ── BATCH TILE (compact/expand) ──────────────────────────
export function toggleBatchExpand(id: string) {
  // Don't toggle during drag — the click fires after dragstart and
  // rerenderCurrentView() would destroy the DOM element being dragged,
  // silently canceling the browser's native drag operation.
  if (S.draggingBatchId) return;
  if (S.expandedBatches.has(id)) S.expandedBatches.delete(id);
  else S.expandedBatches.add(id);
  rerenderCurrentView();
}

export interface BatchTileOptions {
  showActions?: boolean;
  showRecipe?: boolean;
  compact?: boolean;
}

export function toggleBreakdown(id: string) {
  if (S.expandedBreakdowns.has(id)) S.expandedBreakdowns.delete(id);
  else S.expandedBreakdowns.add(id);
  rerenderCurrentView();
}

export function showNoteInput(id: string) {
  const b = S.batches.find(b => b.id === id);
  if (b) { b.note = ''; rerenderCurrentView(); }
}

export function renderBatchTile(d: Batch, opts: BatchTileOptions = {}) {
  const showActions = opts.showActions !== false;
  const showRecipe = opts.showRecipe !== false;

  const { str, cls } = diffStr(d);
  const totalStock = getTotalStock(d);
  const isExpanded = !opts.compact && S.expandedBatches.has(d.id);
  const isStale = isDishStale(d);
  // Color-code by where most stock currently lives (logisticsRowClass picks
  // the dominant loc, falling back to first pending shipment, falling back
  // to West).
  const locCls = logisticsRowClass(d).replace(/^log-/, 'loc-').replace('twc', 'centraal').replace('tww', 'west');
  // Pending-shipment indicator on the tile chrome.
  const hasPendingShipment = (d.shipments || []).some(s => !s.arrived);
  const transitCls = hasPendingShipment ? ' in-transit' : '';
  // Stale = ANY non-Frozen entry past shelf life.
  const hasStaleEntry = (d.inventory || []).some(e => e.qty > 0 && e.storage !== 'Frozen' && isStaleEntry(e));
  // Frozen = ALL stock at Frozen storage (matches renderDishGroups).
  const inv = d.inventory || [];
  const allFrozen = inv.length > 0 && inv.every(e => e.qty === 0 || e.storage === 'Frozen');
  const frozenCls = allFrozen ? ' frozen-row' : '';
  const staleCls = (hasStaleEntry || isStale) ? ' stale-row' : '';
  const expandCls = isExpanded ? ' expanded' : '';

  // "Too big" badge: this batch's projected demand exceeds the biggest pot
  // in the kitchen, meaning the cook can't make it in a single pot.
  const biggestPot = S.kitchenEquipment && S.kitchenEquipment.pots.length > 0
    ? Math.max(...S.kitchenEquipment.pots) : Infinity;
  const projected = calcRequired(d);
  const tooBig = projected > biggestPot;
  const tooBigBadge = tooBig
    ? `<span class="batch-too-big-badge" title="Needs ${projected.toFixed(1)}L but biggest pot is ${biggestPot}L — cook in 2 pots">⚠️ Too big</span>`
    : '';

  // Compact row — show the inventory badges (one per (loc, storage) entry +
  // one per pending shipment) instead of the legacy single-loc badge.
  let html = `<div class="batch-tile ${locCls}${transitCls}${frozenCls}${staleCls}${expandCls}" data-testid="batch-tile" data-id="${d.id}" draggable="true" ondragstart="batchDragStart(event,'${d.id}')" ondragend="batchDragEnd(event)">
    <div class="batch-tile-compact" onclick="toggleBatchExpand('${d.id}')">
      <span class="batch-type-dot batch-type-${(d.type||'Soup').toLowerCase().replace(/ /g,'-')}"></span>
      ${isExpanded
        ? `<input class="batch-tile-name batch-name-edit" size="${Math.min(Math.max((d.name||'').length, 6), 30)}" value="${esc(d.name)}" onchange="inlineEdit('${d.id}','name',this.value)" onclick="event.stopPropagation();this.select()" />`
        : `<span class="batch-tile-name">${esc(d.name)}</span>`}
      <span class="batch-status ${isBatchCooked(d) ? ((hasStaleEntry || isStale) ? 'status-stale' : 'status-cooked') : 'status-tocook'}">${isBatchCooked(d) ? ((hasStaleEntry || isStale) ? 'Stale' : 'Cooked') : 'To cook'}</span>
      <span class="batch-tile-cook">${batchCookLabel(d)}</span>
      <span class="batch-tile-stock ${cls}" onclick="event.stopPropagation();openInventoryEditor('${d.id}')" title="Click to edit per-location stock">${totalStock.toFixed(1)}L <small>${str}</small></span>
      ${tooBigBadge}
      <span class="batch-tile-logistics" style="display:inline-flex;flex-wrap:wrap;gap:3px;font-size:10px;">${renderInventoryBadges(d)}</span>
      <span class="batch-expand-arrow">${isExpanded ? '▾' : '▸'}</span>
    </div>`;

  // Expanded detail panel
  if (isExpanded) {
    const allAg = [...(d.allergens || []), ...(d.extraAllergens || [])];
    const cookHtml = getCookCellHtml(d);

    // Build structured service data split by location
    interface SvcLine { day: string; meal: string; liters: string; served: boolean }
    const westSvcs: SvcLine[] = [];
    const centraalSvcs: SvcLine[] = [];
    const fullDayNames: Record<string, string> = { Mon:'Monday', Tue:'Tuesday', Wed:'Wednesday', Thu:'Thursday', Fri:'Friday', Sat:'Saturday', Sun:'Sunday' };
    (d.services || []).forEach(svc => {
      const meal = svc.meal === 'lunch' ? 'Lunch' : 'Dinner';
      const past = isServicePast(svc);
      // Services always show day names (Monday, Tuesday, etc.)
      const short = dateToDayName(svc.date);
      const dayLabel = fullDayNames[short] || short;
      let liters = '';
      if (!past) {
        // Read from the family-aware allocator cache so this line agrees
        // with calcRequired's total and the diff badge. Doing the per-peer
        // math inline used to undercount split-batch demand (peers were
        // counted as raw batches, not unique families).
        const l = Math.round(calcRequiredAtService(d, svc) * 10) / 10;
        liters = `${l}L`;
      }
      const line = { day: dayLabel, meal, liters, served: past };
      if (svc.loc === 'west') westSvcs.push(line); else centraalSvcs.push(line);
    });

    // Catering lines (go into a separate list)
    const cateringLines: string[] = [];
    (S.caterings || []).forEach(c => {
      const cd = (c.dishes || []).find(cd => cd.dishId === d.id);
      if (cd) {
        const peers = (c.dishes || []).filter(dd => dd.type === d.type).length;
        const l = Math.round(((c.guestCount || 0) / Math.max(peers, 1)) * ((d.serving || 280) / 1000) * 10) / 10;
        if (l > 0) cateringLines.push(`${l}L — ${esc(c.name)}`);
      }
    });

    const renderSvcCol = (lines: SvcLine[]) => lines.length === 0
      ? '<div class="bx-svc-empty">—</div>'
      : lines.map(l => `<div class="bx-svc-line${l.served ? ' served' : ''}"><span class="bx-svc-day">${l.day}</span><span class="bx-svc-meal">${l.meal}</span>${l.served ? '<span class="bx-svc-liters">✓</span>' : `<span class="bx-svc-liters">${l.liters}</span>`}</div>`).join('');

    const hasServices = westSvcs.length > 0 || centraalSvcs.length > 0;
    const hasBothLocs = westSvcs.length > 0 && centraalSvcs.length > 0;

    // Single- or dual-column service grid
    let servicesHtml = '';
    if (!hasServices) {
      servicesHtml = '<span style="color:var(--red);font-weight:600;">No services assigned</span>';
    } else if (hasBothLocs) {
      servicesHtml = `<div class="bx-svc-grid">
        <div class="bx-svc-col"><div class="bx-svc-col-title loc-west-text">Sering West</div>${renderSvcCol(westSvcs)}</div>
        <div class="bx-svc-col"><div class="bx-svc-col-title loc-centraal-text">Sering Centraal</div>${renderSvcCol(centraalSvcs)}</div>
      </div>`;
    } else {
      // Only one location — no columns needed
      const lines = westSvcs.length > 0 ? westSvcs : centraalSvcs;
      const locName = westSvcs.length > 0 ? 'Sering West' : 'Sering Centraal';
      const locCls2 = westSvcs.length > 0 ? 'loc-west-text' : 'loc-centraal-text';
      servicesHtml = `<div class="bx-svc-single"><div class="bx-svc-col-title ${locCls2}">${locName}</div>${renderSvcCol(lines)}</div>`;
    }

    // Recipe row — legacy v1 recipeSheetId fields removed in the unified
    // batch rewrite; only v2 recipeId remains.
    let recipeHtml = '';
    if (showRecipe) {
      if (d.recipeId) {
        recipeHtml = `<div class="bx-row bx-recipe">
          <button class="bx-recipe-btn bx-recipe-app" onclick="event.stopPropagation();openBatchRecipe('${d.id}')">${hasUnresolvedFlexible(d) ? '&#x26A0; Resolve &amp; edit' : 'Open batch recipe'}</button>
          <span class="bx-serving">${d.serving || 280} ml/guest</span>
        </div>`;
      } else {
        recipeHtml = `<div class="bx-row bx-recipe bx-recipe-empty">
          <span class="bx-no-recipe">No recipe linked</span>
          <span class="bx-serving">${d.serving || 280} ml/guest</span>
        </div>`;
      }
    }

    // Note row. The note may be the empty string after the user clicks
    // "+ Add note" but before they type — we still need to render the input
    // in that state, otherwise the click feels like a no-op.
    const hasNote = d.note !== undefined;
    const noteHtml = hasNote
      ? `<div class="bx-row bx-note"><input class="bx-note-input" value="${esc(d.note || '')}" placeholder="Add a note..." onchange="inlineEdit('${d.id}','note',this.value)" onclick="event.stopPropagation()" /></div>`
      : `<div class="bx-row bx-note bx-note-empty"><button class="bx-add-note" onclick="event.stopPropagation();showNoteInput('${d.id}')">+ Add note</button></div>`;

    html += `<div class="batch-expanded">
      ${recipeHtml}
      <div class="bx-columns">
        <div class="bx-section bx-col-main">
          <div class="bx-section-title">Stock & services</div>
          ${servicesHtml}
          ${cateringLines.length ? `<div class="bx-catering-lines">${cateringLines.map(l => `<div class="bx-svc-line">${l}</div>`).join('')}</div>` : ''}
        </div>
        <div class="bx-section bx-col-side">
          <div class="bx-section-title">Properties</div>
          <div class="bx-row bx-schedule">
            <div class="bx-cook">${cookHtml}</div>
            <div class="bx-badges">
              <span class="${typeBadgeClass(d.type)}" style="cursor:pointer;" onclick="event.stopPropagation();cycleType('${d.id}')">${d.type}</span>
            </div>
          </div>
          <div class="bx-row bx-allergens">
            <div class="allergen-inline" id="ag-inline-${d.id}">
              ${allAg.map(a => `<span class="allergen-pill" onclick="event.stopPropagation();inlineRemoveAllergen('${d.id}','${esc(a)}')" title="Click to remove">${esc(a)}</span>`).join('')}
              <button class="allergen-add-btn" onclick="event.stopPropagation();inlineAddAllergenStart('${d.id}',event)" title="Add allergen">+</button>
            </div>
          </div>
          ${noteHtml}
        </div>
      </div>
      ${showActions ? `<div class="bx-row bx-actions">
        <button class="order-toggle-btn${d.orderFor ? ' on' : ''}" onclick="event.stopPropagation();toggleOrder('${d.id}')">${d.orderFor ? 'Order' : '—'}</button>
        <div class="bx-actions-right">
          ${isBatchCooked(d)
            ? `<button class="served-btn" onclick="event.stopPropagation();openServedDialog('${d.id}')">Served</button>`
            : `${(d.services || []).length > 0 ? `<button class="btn btn-sm" style="background:var(--blue);color:white;" onclick="event.stopPropagation();openReplaceBatch('${d.id}')">Replace</button>` : ''}
               <button class="btn btn-sm btn-danger" data-testid="batch-delete-btn" onclick="event.stopPropagation();deleteBatch('${d.id}')">Delete</button>`
          }
        </div>
      </div>` : ''}
    </div>`;
  }

  html += '</div>';
  return html;
}

// Remove or replace a batch reference in all caterings
export function cleanCateringRefs(oldId: string, newId: string | null) {
  (S.caterings || []).forEach(c => {
    if (!c.dishes) return;
    if (newId) {
      // Replace: point catering dishes from old batch to new batch
      const newBatch = S.batches.find(x => x.id === newId);
      c.dishes = c.dishes.map(d => d.dishId === oldId
        ? { ...d, dishId: newId, name: newBatch ? newBatch.name : d.name }
        : d);
    } else {
      // Delete: remove references to the old batch
      c.dishes = c.dishes.filter(d => d.dishId !== oldId);
    }
  });
}

export function deleteBatch(id: string) {
  trackEvent('batch_delete');
  const d = S.batches.find(x => x.id === id);
  if (!d) return;
  if (isBatchCooked(d)) {
    toast('Cannot delete a cooked batch — serve it first');
    return;
  }
  // Capture state for undo
  const deletedBatch = structuredClone(d);
  const savedCateringDishes: { id: string; dishes: CateringDish[] }[] = [];
  for (const c of S.caterings) {
    if (c.dishes?.some(cd => cd.dishId === id)) {
      savedCateringDishes.push({ id: c.id, dishes: structuredClone(c.dishes) });
    }
  }
  // Perform deletion
  S.batches = S.batches.filter(x => x.id !== id);
  cleanCateringRefs(id, null);
  S.expandedBatches.delete(id);
  S.selected.delete(id);
  rebuildPlanner();
  rerenderCurrentView();
  pushUndo({
    label: esc(d.name) + ' deleted',
    restore: () => {
      S.batches.push(deletedBatch);
      for (const snap of savedCateringDishes) {
        const c = S.caterings.find(x => x.id === snap.id);
        if (c) c.dishes = snap.dishes;
      }
      rebuildPlanner();
      rerenderCurrentView();
    },
    commit: () => { scheduleSave(); },
  });
}

export function inlineEdit(id: string, field: string, value: string) {
  const d = S.batches.find(x => x.id === id);
  if (!d) return;
  if (field === 'name') { d.name = value.trim() || d.name; }
  else if (field === 'note') { d.note = value; }
  // Legacy 'stock' / 'location' handlers removed — those concepts no longer
  // map to single fields. Cook edits per-entry via the Power view of the
  // Edit modal (updateInventoryField), or moves stock via openSendModal /
  // openTransferModal. Auto-cookDate-on-first-stock moves to confirmCooked.
  rebuildPlanner();
  scheduleSave();
}

export function inlineRemoveAllergen(id: string, allergen: string) {
  const d = S.batches.find(x => x.id === id);
  if (!d) return;
  d.allergens = (d.allergens || []).filter(a => a !== allergen);
  d.extraAllergens = (d.extraAllergens || []).filter(a => a !== allergen);
  scheduleSave();
  rerenderCurrentView();
}

export function inlineAddAllergenStart(id: string, evt: Event | null) {
  const d = S.batches.find(x => x.id === id);
  if (!d) return;
  // Use the clicked button's parent to avoid duplicate-ID issues (e.g. dashboard shows same batch twice)
  const btn = evt ? (evt.target as HTMLElement).closest('.allergen-add-btn') : null;
  const container = btn ? btn.closest('.allergen-inline') : document.getElementById('ag-inline-' + id);
  if (!container || container.querySelector('.allergen-add-select')) return;
  const addBtn = btn || container.querySelector('.allergen-add-btn');
  const allExisting = [...(d.allergens || []), ...(d.extraAllergens || [])];
  const available = ALLERGENS.filter(a => !allExisting.includes(a));
  const select = document.createElement('select');
  select.className = 'allergen-add-select allergen-add-input';
  select.style.width = '90px';
  select.innerHTML = '<option value="">pick...</option>'
    + available.map(a => `<option value="${a}">${a}</option>`).join('')
    + '<option value="__custom">Other...</option>';
  select.onchange = function(this: HTMLSelectElement) {
    if (this.value === '__custom') {
      this.remove();
      const input = document.createElement('input');
      input.className = 'allergen-add-input';
      input.placeholder = 'type...';
      input.onkeydown = function(this: HTMLInputElement, e: KeyboardEvent) {
        if (e.key === 'Enter') { inlineAddAllergenConfirm(id, this.value); }
        if (e.key === 'Escape') { rerenderCurrentView(); }
      };
      input.onblur = function(this: HTMLInputElement) {
        if (this.value.trim()) inlineAddAllergenConfirm(id, this.value);
        else rerenderCurrentView();
      };
      container.insertBefore(input, addBtn);
      input.focus();
    } else if (this.value) {
      inlineAddAllergenConfirm(id, this.value);
    }
  };
  select.onblur = function(this: HTMLSelectElement) {
    if (!this.value) rerenderCurrentView();
  };
  container.insertBefore(select, addBtn);
  (addBtn as HTMLElement).style.display = 'none';
  select.focus();
}

export function inlineAddAllergenConfirm(id: string, value: string) {
  const val = value.trim();
  if (!val) { rerenderCurrentView(); return; }
  const d = S.batches.find(x => x.id === id);
  if (!d) return;
  if (!d.extraAllergens) d.extraAllergens = [];
  const allExisting = [...(d.allergens || []), ...d.extraAllergens];
  if (!allExisting.includes(val)) d.extraAllergens.push(val);
  scheduleSave();
  rerenderCurrentView();
}

// ── COOK DATE/DAY LOGIC ──────────────────────────────────
// getToday, dateToStr, strToDate are imported from core.ts


export function getCookDayOptions() {
  const today = getToday();
  const todayDow = (today.getDay() + 6) % 7; // 0=Mon
  const dayNames = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
  const opts = [];
  // This week: today through Sunday
  for (let i = todayDow; i < 7; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + (i - todayDow));
    const label = i === todayDow ? 'Today (' + dayNames[i] + ')' : dayNames[i];
    opts.push({ value: dateToStr(d), label });
  }
  // Next week: Monday through Sunday
  const daysUntilNextMon = 7 - todayDow;
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + daysUntilNextMon + i);
    opts.push({ value: dateToStr(d), label: 'Next ' + dayNames[i] });
  }
  return opts;
}

export function isDishCooked(d: Batch) {
  return isBatchCooked(d);
}

export function isCookDayToday(d: Batch) {
  if (!d.cookDate) return false;
  const cd = strToDate(d.cookDate);
  if (!cd) return false;
  const today = getToday();
  return cd.getTime() === today.getTime() && !isBatchCooked(d);
}

export function isDishStale(d: Batch) {
  if (!isBatchCooked(d)) return false;
  // ANY non-Frozen inventory entry past its shelf life makes the dish "stale"
  // for tile-status purposes. Per-entry isStaleEntry uses the entry's own
  // cookDate (which may diverge from b.cookDate after freeze-and-thaw).
  return (d.inventory || []).some(e => e.qty > 0 && e.storage !== 'Frozen' && isStaleEntry(e));
}

export function daysSinceCooked(d: Batch) {
  if (!isBatchCooked(d) || !d.cookDate) return 0;
  const cd = strToDate(d.cookDate);
  if (!cd) return 0;
  return Math.floor((getToday().getTime() - cd.getTime()) / (1000*60*60*24));
}

// Short cook date label for the compact batch tile row
export function batchCookLabel(d: Batch) {
  if (isBatchCooked(d) && d.cookDate) {
    // Already cooked — show date with cooked status
    const iso = cookDateToISO(d.cookDate);
    const dt = new Date(iso);
    if (!isNaN(dt.getTime())) {
      const stale = isDishStale(d);
      const days = daysSinceCooked(d);
      const dateStr = `${dt.getDate()}/${dt.getMonth()+1}`;
      if (stale) {
        return `<span class="cook-label stale" onclick="event.stopPropagation();tileEditCookDate('${d.id}')" title="${days}d ago — serve or freeze">${dateStr}</span>`;
      }
      return `<span class="cook-label cooked" onclick="event.stopPropagation();tileEditCookDate('${d.id}')" title="Cooked on ${dateStr}">${dateStr}</span>`;
    }
    return '';
  }
  if (d.cookDate) {
    // Planned cook date — show day name (Tue, Wed, etc.), prefixed with "Next" if beyond this week
    const iso = cookDateToISO(d.cookDate);
    const dt = new Date(iso);
    if (!isNaN(dt.getTime())) {
      const dayShort = dateToDayName(iso);
      // Determine if cook date is beyond the current week (Mon–Sun)
      const today = getToday();
      const dayOfWeek = today.getDay(); // 0=Sun, 1=Mon, ...
      const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
      const thisMonday = new Date(today);
      thisMonday.setDate(today.getDate() + mondayOffset);
      thisMonday.setHours(0, 0, 0, 0);
      const nextMonday = new Date(thisMonday);
      nextMonday.setDate(thisMonday.getDate() + 7);
      const weekAfterNext = new Date(nextMonday);
      weekAfterNext.setDate(nextMonday.getDate() + 7);
      let label = dayShort;
      if (dt >= weekAfterNext) {
        // 2+ weeks out — show date instead of day name
        label = `${dt.getDate()}/${dt.getMonth()+1}`;
      } else if (dt >= nextMonday) {
        label = `Next ${dayShort}`;
      }
      return `<span class="cook-label planned" onclick="event.stopPropagation();tileEditCookDate('${d.id}')" title="Planned: ${dt.getDate()}/${dt.getMonth()+1}">${label}</span>`;
    }
  }
  // No cook date set
  return `<span class="cook-label none" onclick="event.stopPropagation();tileEditCookDate('${d.id}')" title="Click to set cook date">no date</span>`;
}

// Inline date picker triggered from tile cook label
export function tileEditCookDate(id: string) {
  if (S.draggingBatchId) return;
  const d = S.batches.find(x => x.id === id);
  if (!d) return;
  // Create a temporary hidden date input, trigger it
  const existing = document.getElementById('tile-cook-picker');
  if (existing) existing.remove();
  const inp = document.createElement('input');
  inp.type = 'date';
  inp.id = 'tile-cook-picker';
  inp.style.cssText = 'position:fixed;top:-100px;left:-100px;opacity:0;';
  inp.value = d.cookDate ? cookDateToISO(d.cookDate) : '';
  inp.onchange = function(this: HTMLInputElement) {
    setCookDateDirect(id, this.value);
    this.remove();
  };
  inp.onblur = function(this: HTMLInputElement) { setTimeout(() => this.remove(), 200); };
  document.body.appendChild(inp);
  inp.showPicker ? inp.showPicker() : inp.click();
}

export function getCookCellHtml(d: Batch) {
  const opts = getCookDayOptions();

  // Already cooked (stock > 0) — show "Cooked on" + date
  if (isBatchCooked(d) && d.cookDate) {
    const stale = isDishStale(d);
    const days = daysSinceCooked(d);
    let html = `<div class="bx-cook-wrap"><span class="bx-cook-label">Cooked on</span><input type="date" class="cook-date-input" value="${cookDateToISO(d.cookDate)}" onchange="setCookDateDirect('${d.id}',this.value)" onclick="event.stopPropagation()" title="Change cooked date" /></div>`;
    if (stale) {
      html += `<div class="cook-stale">${days}d ago — serve or freeze</div>`;
    }
    return html;
  }
  // Planned for today — show confirm button
  if (isCookDayToday(d)) {
    return `<div class="bx-cook-wrap"><span class="bx-cook-label">Cook</span><button class="cook-today-btn" data-testid="cook-today-btn" onclick="event.stopPropagation();confirmCooked('${d.id}')">Today — mark as cooked</button></div>`;
  }
  // Has a planned future day — show "Cook on" + dropdown
  if (d.cookDate && !isBatchCooked(d)) {
    return `<div class="bx-cook-wrap"><span class="bx-cook-label">Cook on</span><select class="cook-select has-date" onchange="setCookDay('${d.id}',this.value)" onclick="event.stopPropagation()">
      <option value="">Select day</option>
      ${opts.map(o => `<option value="${o.value}"${d.cookDate === o.value ? ' selected' : ''}>${o.label}</option>`).join('')}
      <option value="__date">Pick a date...</option>
    </select></div>`;
  }
  // No plan yet — show "Cook on" + dropdown with red warning style
  return `<div class="bx-cook-wrap"><span class="bx-cook-label">Cook on</span><select class="cook-select no-date" data-testid="cook-select" onchange="setCookDay('${d.id}',this.value)" onclick="event.stopPropagation()">
    <option value="">Select day</option>
    ${opts.map(o => `<option value="${o.value}">${o.label}</option>`).join('')}
    <option value="__date">Pick a date...</option>
  </select></div>`;
}

export function cookDateToISO(ddmmyyyy: string) {
  if (!ddmmyyyy) return '';
  const parts = ddmmyyyy.split('/');
  if (parts.length === 3) return parts[2]+'-'+parts[1]+'-'+parts[0];
  return ddmmyyyy;
}

export function isoToCookDate(iso: string) {
  if (!iso) return '';
  const parts = iso.split('-');
  if (parts.length === 3) return parts[2]+'/'+parts[1]+'/'+parts[0];
  return iso;
}

export function setCookDay(id: string, value: string) {
  const d = S.batches.find(x => x.id === id);
  if (!d) return;
  if (value === '__date') {
    // Replace the select with a date input
    const row = document.querySelector(`[onchange="setCookDay('${id}',this.value)"]`);
    if (row) {
      const input = document.createElement('input');
      input.type = 'date';
      input.className = 'cook-date-input';
      input.style.width = '100%';
      input.onchange = function(this: HTMLInputElement) {
        setCookDateDirect(id, this.value);
      };
      input.onclick = function(e: MouseEvent) { e.stopPropagation(); };
      row.replaceWith(input);
      input.focus();
      input.showPicker && input.showPicker();
    }
    return;
  }
  d.cookDate = value || null;
  scheduleSave();
  rerenderCurrentView();
}

export function setCookDateDirect(id: string, isoDate: string) {
  const d = S.batches.find(x => x.id === id);
  if (!d) return;
  d.cookDate = isoToCookDate(isoDate);
  // If the date is today or in the past and the batch has no inventory yet,
  // route through confirmCooked so the cook picks a location. Saves a
  // separate confirm step for cooks who edit cookDate to "today" by hand.
  const picked = new Date(isoDate);
  const today = getToday();
  if (picked <= today && getTotalStock(d) === 0) {
    confirmCooked(id);
    return;
  }
  scheduleSave();
  rerenderCurrentView();
}

export function confirmCooked(id: string) {
  trackEvent('batch_confirm_cooked');
  const d = S.batches.find(x => x.id === id);
  if (!d) return;

  // Determine cook location. From Dashboard the cook's screen-level loc is
  // ambiguous (Dashboard shows both kitchens) so we MUST force a chooser —
  // otherwise the new inventory entry silently lands at S.currentLoc, which
  // may be wrong (cook standing in Centraal hits "mark cooked" → food lands
  // at West). From any other screen the cook has picked a loc filter, so
  // S.currentLoc is the right answer.
  if (getCurrentScreen() === 'dashboard') {
    showModal(`<h3>Where did you cook "${esc(d.name)}"?</h3>
      <p style="font-size:13px;color:var(--text2);margin-bottom:16px;">Pick the kitchen — this sets the inventory entry's location.</p>
      <div class="modal-actions">
        <button class="btn" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="closeModal();confirmCookedAt('${id}','west')">Sering West</button>
        <button class="btn btn-primary" onclick="closeModal();confirmCookedAt('${id}','centraal')">Sering Centraal</button>
      </div>`);
    return;
  }
  confirmCookedAt(id, S.currentLoc);
}

/** Internal completion of `confirmCooked` once the cook location is known.
 *  Exposed via window so the chooser modal's onclick can call it. */
export function confirmCookedAt(id: string, cookLoc: Location) {
  const d = S.batches.find(x => x.id === id);
  if (!d) return;
  const today = dateToStr(getToday());
  d.cookDate = today;
  // If the batch already has inventory (e.g. cook re-confirms after editing),
  // leave it alone — confirmCooked is meant for the FIRST confirm. Otherwise
  // auto-fill a single Gastro entry at cookLoc with calcRequired worth.
  const totalNow = getTotalStock(d);
  if (totalNow === 0) {
    // calcRequired reads the family-allocation cache — refresh it first, or a
    // stale cache can auto-fill 0 L and leave the cook with a cooked batch
    // that has no stock.
    rebuildPlanner();
    const qty = calcRequired(d);
    if (qty > 0) {
      addInventory(d, { loc: cookLoc, storage: 'Gastro', qty, cookDate: today });
    }
  }
  scheduleSave();
  rerenderCurrentView();
  const finalQty = getTotalStock(d);
  toast(esc(d.name) + ' marked as cooked at ' + locName(cookLoc) + ' — stock ' + finalQty.toFixed(1) + 'L');
  // Offer post-cook recording for v2 recipe batches
  if (d.recipeId) {
    openPostCookRecording(id);
  }
}

/** ── Send modal — POST /api/batches/:id/ship ──
 *
 *  Lets the cook send qty L from one inventory entry to another location.
 *  Pre-fills the From dropdown with all entries NOT at the candidate
 *  destination (so a West→Centraal send shows West entries; if the user
 *  switches To=West the dropdown filters to Centraal entries on re-render). */
export function openSendModal(id: string) {
  const d = S.batches.find(x => x.id === id);
  if (!d) return;
  const inv = (d.inventory || []).filter(e => e.qty > 0);
  if (inv.length === 0) {
    toast('No stock to send — batch is empty');
    return;
  }
  // Default destination = the loc that ISN'T where most stock lives.
  const totalAt = (loc: Location) => inv.filter(e => e.loc === loc).reduce((s, e) => s + e.qty, 0);
  const defaultTo: Location = totalAt('west') > totalAt('centraal') ? 'centraal' : 'west';
  renderSendModal(id, defaultTo);
}

function renderSendModal(id: string, toLoc: Location) {
  const d = S.batches.find(x => x.id === id);
  if (!d) return;
  const inv = (d.inventory || []).filter(e => e.qty > 0);
  // Source candidates = entries NOT at toLoc (you can't ship-to-self).
  const sourceCandidates = inv
    .map((e, idx) => ({ entry: e, idx }))
    .filter(x => x.entry.loc !== toLoc);
  if (sourceCandidates.length === 0) {
    toast(`No stock outside ${locName(toLoc)} to send from`);
    return;
  }
  const defaultSourceIdx = sourceCandidates[0].idx;
  const defaultSourceStorage = sourceCandidates[0].entry.storage;
  showModal(`<h3>Send stock — ${esc(d.name)}</h3>
    <div class="fr"><label>From</label>
      <select id="send-from-idx">
        ${sourceCandidates.map(x => `<option value="${x.idx}"${x.idx === defaultSourceIdx ? ' selected' : ''}>${locName(x.entry.loc)} / ${x.entry.storage} / ${x.entry.qty.toFixed(1)}L (cooked ${x.entry.cookDate})</option>`).join('')}
      </select>
    </div>
    <div class="fr"><label>To</label>
      <select id="send-to-loc" onchange="rerenderSendModal('${id}',this.value)">
        ${LOCATIONS.map(l => `<option value="${l}"${l === toLoc ? ' selected' : ''}>${locName(l)}</option>`).join('')}
      </select>
    </div>
    <div class="fr"><label>Storage at destination</label>
      <select id="send-storage">
        ${STORAGE.map(s => `<option value="${s}"${s === defaultSourceStorage ? ' selected' : ''}>${s}</option>`).join('')}
      </select>
    </div>
    <div class="fr"><label>Quantity (L)</label>
      <input type="number" id="send-qty" step="0.5" min="0.1" placeholder="e.g. 25" />
    </div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="confirmSendShipment('${id}')">Confirm send</button>
    </div>`);
}

/** Re-render the send modal when the To dropdown changes (so source
 *  candidates update). Exposed for the inline onchange handler. */
export function rerenderSendModal(id: string, toLoc: string) {
  if (toLoc !== 'west' && toLoc !== 'centraal') return;
  renderSendModal(id, toLoc as Location);
}

/** POST the /ship request and update local state from the response. */
export async function confirmSendShipment(id: string) {
  const fromIdxStr = (document.getElementById('send-from-idx') as HTMLSelectElement | null)?.value;
  const toLoc = (document.getElementById('send-to-loc') as HTMLSelectElement | null)?.value;
  const storage = (document.getElementById('send-storage') as HTMLSelectElement | null)?.value;
  const qtyStr = (document.getElementById('send-qty') as HTMLInputElement | null)?.value;
  const fromInventoryIdx = fromIdxStr ? parseInt(fromIdxStr, 10) : undefined;
  const qty = qtyStr ? parseFloat(qtyStr) : NaN;
  if (!toLoc || !storage || isNaN(qty) || qty <= 0) {
    toastError('Please fill in all fields with a positive quantity.');
    return;
  }
  trackEvent('batch_ship', '', { batchId: id, toLoc, qty });
  try {
    const res = await apiPost(`/api/batches/${id}/ship`, { toLoc, qty, storage, fromInventoryIdx });
    if (res && res.batch) {
      const idx = S.batches.findIndex(b => b.id === id);
      if (idx >= 0) S.batches[idx] = res.batch;
    }
    if (res && res.warning) {
      toast(res.warning);
    } else {
      toast(`Sent ${qty}L to ${locName(toLoc as Location)}`);
    }
    closeModal();
    rebuildPlanner();
    rerenderCurrentView();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    toastError('Send failed: ' + msg);
  }
}

/** ── Transfer modal — POST /api/batches/:id/transfer ──
 *
 *  Lets the cook move qty L between (loc, storage) entries WITHIN the same
 *  batch. Used for freeze (Gastro→Frozen — backend resets cookDate to today),
 *  thaw (Frozen→Gastro — same reset), and redistribute. */
export function openTransferModal(id: string) {
  const d = S.batches.find(x => x.id === id);
  if (!d) return;
  const inv = (d.inventory || []).filter(e => e.qty > 0);
  if (inv.length === 0) {
    toast('No stock to transfer — batch is empty');
    return;
  }
  const first = inv[0];
  const defaultFromLoc = first.loc;
  const defaultFromStorage = first.storage;
  // Default to-storage = the next state in the cycle (Gastro→Frozen is the
  // most common cook intention — leftover sauce → freezer).
  const cycleNext: Record<StorageType, StorageType> = { 'Gastro': 'Frozen', 'Frozen': 'Gastro', 'Vac-packed': 'Gastro' };
  const defaultToStorage = cycleNext[defaultFromStorage as StorageType] || 'Frozen';
  showModal(`<h3>Transfer stock — ${esc(d.name)}</h3>
    <p style="font-size:12px;color:var(--text2);margin-bottom:12px;">Move stock between (location, storage) entries within this batch. Freezing or thawing resets the cookDate to today.</p>
    <div class="fr"><label>From</label>
      <div style="display:flex;gap:6px;">
        <select id="tx-from-loc" disabled title="Transfer is locked to this kitchen — use Send for cross-loc"><option value="${defaultFromLoc}" selected>${locName(defaultFromLoc)}</option></select>
        <select id="tx-from-storage">${STORAGE.map(s => `<option value="${s}"${s === defaultFromStorage ? ' selected' : ''}>${s}</option>`).join('')}</select>
      </div>
    </div>
    <div class="fr"><label>To</label>
      <div style="display:flex;gap:6px;">
        <select id="tx-to-loc" disabled title="Cross-kitchen moves go through Send so they show in the Transport tab"><option value="${defaultFromLoc}" selected>${locName(defaultFromLoc)}</option></select>
        <select id="tx-to-storage">${STORAGE.map(s => `<option value="${s}"${s === defaultToStorage ? ' selected' : ''}>${s}</option>`).join('')}</select>
      </div>
      <p style="font-size:11px;color:var(--text3);margin-top:4px;">Transfer only changes storage at the same kitchen. For West &harr; Centraal, use the Send button.</p>
    </div>
    <div class="fr"><label>Quantity (L)</label>
      <input type="number" id="tx-qty" step="0.5" min="0.1" placeholder="e.g. 20" />
    </div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="confirmTransferStock('${id}')">Confirm transfer</button>
    </div>`);
}

export async function confirmTransferStock(id: string) {
  const fromLoc = (document.getElementById('tx-from-loc') as HTMLSelectElement | null)?.value;
  const fromStorage = (document.getElementById('tx-from-storage') as HTMLSelectElement | null)?.value;
  const toLoc = (document.getElementById('tx-to-loc') as HTMLSelectElement | null)?.value;
  const toStorage = (document.getElementById('tx-to-storage') as HTMLSelectElement | null)?.value;
  const qtyStr = (document.getElementById('tx-qty') as HTMLInputElement | null)?.value;
  const qty = qtyStr ? parseFloat(qtyStr) : NaN;
  if (!fromLoc || !fromStorage || !toLoc || !toStorage || isNaN(qty) || qty <= 0) {
    toastError('Please fill in all fields with a positive quantity.');
    return;
  }
  // Cross-loc moves are blocked at the UI level — both tx-from-loc and
  // tx-to-loc are disabled, locked to the source loc. Belt-and-suspenders:
  // reject any same-storage no-op AND any cross-loc payload that somehow
  // still hits this handler (e.g. a power user editing the DOM). Backend
  // /transfer keeps the looser check for any future power-user case.
  if (fromLoc !== toLoc) {
    toastError('Transfer is locked to the same kitchen. For cross-kitchen moves, use Send.');
    return;
  }
  if (fromStorage === toStorage) {
    toastError('Pick a different storage type — Transfer only changes storage at the same kitchen. For West ↔ Centraal, use Send.');
    return;
  }
  trackEvent('batch_transfer', '', { batchId: id, fromLoc, fromStorage, toLoc, toStorage, qty });
  try {
    const res = await apiPost(`/api/batches/${id}/transfer`, { fromLoc, fromStorage, toLoc, toStorage, qty });
    if (res && res.batch) {
      const idx = S.batches.findIndex(b => b.id === id);
      if (idx >= 0) S.batches[idx] = res.batch;
    }
    if (res && res.warning) toast(res.warning);
    else toast(`Transferred ${qty}L`);
    closeModal();
    rebuildPlanner();
    rerenderCurrentView();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    toastError('Transfer failed: ' + msg);
  }
}

export function setFilter(group: keyof typeof S.filters, val: string) { S.filters[group] = val; S.selected.clear(); rerenderCurrentView(); }
export function toggleSelect(id: string) { if (S.draggingBatchId) return; if (S.selected.has(id)) S.selected.delete(id); else S.selected.add(id); rerenderCurrentView(); }

export function calcRequiredForLoc(dish: Batch, loc: string) {
  // Sum per-batch peer-share demand for services at `loc`. Reads from the
  // recomputeBatchAllocations cache via calcRequiredAtService so this
  // number agrees with the diff badge.
  let total = 0;
  (dish.services || []).forEach(svc => {
    if (svc.loc !== loc) return;
    total += calcRequiredAtService(dish, svc);
  });
  return Math.round(total * 10) / 10;
}

// renderSplitBar / doSplit / doTransportSplit deleted in the unified-batch
// rewrite. The new model uses per-batch /ship and /transfer endpoints called
// from openSendModal / openTransferModal. Transport-card.ts (Pack for Centraal)
// now calls /api/batches/:id/ship directly per row.

// ── NEW DISH ──────────────────────────────────────────────
export function openNewDish() {
  searchNewDishModal();
}

// Live recipe search for the "+ New batch" modal. Picking a recipe leads to a
// small amount + cook-date form (pickRecipeForNewBatch); "Create blank batch"
// keeps the from-scratch placeholder path untouched.
export function searchNewDishModal() {
  const searchQuery = (document.getElementById('new-dish-search') as HTMLInputElement | null)?.value || '';
  const q = searchQuery.trim().toLowerCase();
  const recipes = (S.recipes || [])
    .filter(r => !q || r.name.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name));

  const listHtml = recipes.length === 0
    ? `<div class="empty" style="padding:12px;">No recipes${q ? ` matching "${esc(searchQuery)}"` : ''}. Use "Create blank batch" below.</div>`
    : recipes.slice(0, 50).map(r => {
        const cost = r.costPerServing != null ? `€${r.costPerServing.toFixed(2)}/serving` : '';
        return `<div class="dish-opt" data-testid="new-batch-recipe-opt" onclick="pickRecipeForNewBatch('${esc(r.id)}')">
          <div style="flex:1;">
            <div><span style="font-weight:500;">${esc(r.name)}</span> ${typeBadge((r.type || 'Soup') as DishType)}</div>
            ${cost ? `<div style="font-size:11px;color:var(--text3);margin-top:2px;">${cost}</div>` : ''}
          </div>
        </div>`;
      }).join('');

  // Search-input rule: once the modal is open, only swap the results list so
  // the search field keeps focus and caret position.
  const existingList = document.getElementById('new-dish-list');
  if (existingList) {
    existingList.innerHTML = listHtml;
    return;
  }

  showModal(`<h3>New batch</h3>
    <input type="text" class="dish-search" id="new-dish-search" placeholder="Search recipes..." value="${esc(searchQuery)}"
      oninput="searchNewDishModal()" autofocus />
    <div class="dish-opts-list" style="max-height:300px;" id="new-dish-list">${listHtml}</div>
    <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border);">
      <div style="font-size:12px;color:var(--text2);margin-bottom:8px;">Or create from scratch:</div>
      <button class="btn" data-testid="new-batch-blank-btn" onclick="openNewDishScratch()">Create blank batch</button>
    </div>
    <div class="modal-actions"><button class="btn" onclick="closeModal()">Close</button></div>`);
}

// Step 2 of "+ New batch": recipe picked → ask for liters + cook date. Per
// Daan's spec these are the only two inputs when working from a recipe.
export function pickRecipeForNewBatch(recipeId: string) {
  const r = S.recipes.find(x => x.id === recipeId);
  if (!r) { toastError('Recipe not found'); return; }
  showModal(`<h3>New batch — ${esc(r.name)}</h3>
    <p style="font-size:12px;color:var(--text2);margin-bottom:12px;">Creates a cooked batch with stock at ${esc(locName(S.currentLoc))}.</p>
    <div class="fr"><label>Amount (liters)</label>
      <input type="number" id="nbr-amount" min="0" step="0.5" placeholder="e.g. 40"
        onkeydown="if(event.key==='Enter')saveBatchFromRecipe('${esc(r.id)}')" /></div>
    <div class="fr"><label>Cooking date</label>
      <input type="date" id="nbr-date" value="${todayIso()}" /></div>
    <div class="fr"><label>Storage</label>
      <select id="nbr-storage">
        ${STORAGE.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('')}
      </select></div>
    <div class="modal-actions">
      <button class="btn" onclick="openNewDish()">← Back</button>
      <button class="btn btn-primary" data-testid="new-batch-recipe-submit" onclick="saveBatchFromRecipe('${esc(r.id)}')">Create batch</button>
    </div>`);
  setTimeout(() => (document.getElementById('nbr-amount') as HTMLInputElement | null)?.focus(), 0);
}

export function saveBatchFromRecipe(recipeId: string) {
  const r = S.recipes.find(x => x.id === recipeId);
  if (!r) { toastError('Recipe not found'); return; }
  const amount = parseFloat((document.getElementById('nbr-amount') as HTMLInputElement).value);
  if (!amount || amount <= 0) { toastError('Enter how many liters you are making'); return; }
  const iso = (document.getElementById('nbr-date') as HTMLInputElement).value;
  if (!iso) { toastError('Pick a cooking date'); return; }
  const cookDate = dateToStr(new Date(iso + 'T12:00:00'));
  const storage = (document.getElementById('nbr-storage') as HTMLSelectElement).value as StorageType;
  const loc = S.currentLoc;
  trackEvent('batch_create', 'from_recipe');
  // Recipe-linked batch: recipeId drives ingredients (calcIngredientsFromRecipe)
  // and the batch recipe editor, so ingredients aren't snapshotted here. The
  // amount lands as one Gastro inventory entry — the batch is created cooked.
  const allergens = [...new Set([...(r.autoAllergens || []), ...(r.extraAllergens || [])])];
  const newBatch: Batch = {
    id: newId(),
    name: r.name,
    type: (r.type || 'Soup') as DishType,
    recipeId: r.id,
    serving: r.servingSize || 280,
    cookDate,
    inventory: [{ loc, storage, qty: amount, cookDate }],
    shipments: [],
    services: [],
    allergens,
    extraAllergens: [],
    note: '',
    cookNotes: '',
    actualIngredients: null,
    orderFor: false,
    stockDeducted: false,
    createdAt: new Date().toISOString(),
  };
  S.batches.push(newBatch);
  closeModal();
  rebuildPlanner();
  rerenderCurrentView();
  scheduleSave();
  toast(`"${r.name}" — ${amount}L created at ${locName(loc)}`);
}

export function openNewDishScratch() {
  showModal(`<h3>New batch</h3>
    <p style="font-size:12px;color:var(--text2);margin-bottom:12px;">Creates an empty placeholder. Use the planner to assign services, then click "Mark cooked" once it's actually in the pot.</p>
    <div class="fr"><label>Name</label><input type="text" id="nd-name" placeholder="e.g. Mushroom soup" /></div>
    <div class="fr"><label>Type</label><select id="nd-type">
      <option>Soup</option><option>Main course</option><option>Dessert</option>
    </select></div>
    <div class="fr"><label>Serving size (ml per guest)</label><input type="number" id="nd-serving" value="280" /></div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" data-testid="new-batch-submit" onclick="saveNewDish()">Create batch</button>
    </div>`);
}

export async function saveNewDish() {
  trackEvent('batch_create');
  const name = (document.getElementById('nd-name') as HTMLInputElement).value.trim();
  if (!name) { alert('Please enter a batch name'); return; }
  // Unified-batch model: blank batch starts with empty inventory + shipments.
  // Cook fills inventory via "Mark cooked" (sets first inventory entry) or
  // via the Edit modal's Power view (per-entry add).
  const newDish: Batch = {
    id: newId(), name,
    type: (document.getElementById('nd-type') as HTMLSelectElement).value as DishType,
    serving: parseInt((document.getElementById('nd-serving') as HTMLInputElement).value) || 280,
    allergens: [], extraAllergens: [], orderFor: false,
    cookDate: null,
    inventory: [],
    shipments: [],
    services: [],
    note: '',
    cookNotes: '',
    actualIngredients: null,
    stockDeducted: false,
    recipeId: null,
    createdAt: new Date().toISOString(),
  };
  S.batches.push(newDish);
  closeModal(); rebuildPlanner(); rerenderCurrentView(); scheduleSave();
  toast(`"${name}" added`);
}

// ── EDIT DISH ─────────────────────────────────────────────
//
// Two views per the locked plan:
//   - Normal view (default): single "Where is it?" summary + Send/Transfer
//     buttons + name/type/cookDate/allergens/order. The 95% case for cooks.
//   - Power view: full inventory[] table (per-entry qty + storage editors,
//     +Add row), plus pending-shipments listing with per-row Cancel.
//
// `_editMode` is module-local and resets to 'normal' every time openEditDish
// is called fresh. Toggle button in the modal header re-renders in place.

let _editMode: 'normal' | 'power' = 'normal';

export function openEditDish(id: string, mode: 'normal' | 'power' = 'normal') {
  _editMode = mode;
  _activeInvRender = renderEditDish;
  renderEditDish(id);
}

// ── Simplified inventory editor ────────────────────────────────────────────
//
// Daan asked (smoke 2026-05-12, items 2+3): "When I click the liters I want
// to see only what's needed to change amounts and where they live, with
// Freeze and Send buttons right next to each row."
//
// This is a stripped-down modal: just the inventory grid, per-row Freeze
// and "→ Send to {other}" buttons that open an inline qty form, and a
// "More options" escape hatch to the full Edit dish modal (name, type,
// allergens, etc.) for the rare case the cook needs them.
//
// Per-row pending action state lives module-local — only one row can be in
// "asking for qty" mode at a time. Clicking a different action button on
// another row replaces it; clicking the action button again on the same
// row cancels.

interface PendingInvAction {
  rowIdx: number;
  kind: 'freeze' | 'send';
}
let _invPending: PendingInvAction | null = null;

// Tracks which modal is open so add/remove/update-row helpers re-render the
// right one. Set whenever an inventory-aware modal opens; the helpers below
// call this instead of jumping straight to renderEditDish (which would yank
// the cook out of the simplified editor into the full Edit-dish modal — bug
// reported during Daan's localhost test).
let _activeInvRender: ((id: string) => void) | null = null;

function reRenderActiveInvModal(id: string) {
  if (_activeInvRender) _activeInvRender(id);
}

export function openInventoryEditor(id: string) {
  _invPending = null;
  _activeInvRender = renderInventoryEditor;
  renderInventoryEditor(id);
}

function renderInventoryEditor(id: string) {
  const d = S.batches.find(x => x.id === id);
  if (!d) return;
  const inv = d.inventory || [];
  const otherLoc = (loc: Location): Location => (loc === 'west' ? 'centraal' : 'west');

  // Card-per-entry layout (rather than the old table). Daan's smoke
  // surfaced two issues with the table version: (a) per-row action
  // buttons (Freeze, → other loc, ×) got clipped at the modal's right
  // edge on narrower screens, and (b) it was visually busy. Cards give
  // each entry its own breathing room with the action strip explicitly
  // on a separate line, always visible.
  const cardsHtml = inv.length === 0
    ? '<div style="padding:24px;color:var(--text3);text-align:center;font-size:13px;border:1px dashed var(--border);border-radius:8px;">No inventory yet — use + Add row.</div>'
    : inv.map((e, i) => {
        const freezeBtn = e.storage === 'Frozen'
          ? ''
          : `<button class="btn btn-sm" onclick="setInvAction('${id}',${i},'freeze')" title="Freeze some of this stock">❄️ Freeze</button>`;
        const sendBtn = `<button class="btn btn-sm" onclick="setInvAction('${id}',${i},'send')" title="Send some of this stock to ${locName(otherLoc(e.loc))}">→ ${locName(otherLoc(e.loc))}</button>`;
        const removeBtn = `<button class="btn btn-sm btn-danger" onclick="removeInventoryEntry('${id}',${i})" title="Remove this row entirely">×</button>`;
        const isActive = _invPending && _invPending.rowIdx === i;
        const actionForm = isActive
          ? `<div style="margin-top:8px;padding:10px;background:var(--bg2);border-radius:6px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
              <span style="font-size:12px;color:var(--text2);flex-basis:100%;">
                ${_invPending!.kind === 'freeze'
                  ? `❄️ How many liters to freeze from <strong>${locName(e.loc)} ${e.storage}</strong>?`
                  : `→ How many liters to send to <strong>${locName(otherLoc(e.loc))}</strong>?`}
              </span>
              <input type="number" id="inv-qty-${i}" step="0.5" min="0.1" max="${e.qty}" value="${e.qty.toFixed(1)}" style="width:80px;" autofocus
                onkeydown="if(event.key==='Enter')confirmInvAction('${id}',${i});if(event.key==='Escape')cancelInvAction('${id}')" />
              <span style="font-size:12px;color:var(--text3);">of ${e.qty.toFixed(1)}L available</span>
              <button class="btn btn-sm btn-primary" onclick="confirmInvAction('${id}',${i})">Confirm</button>
              <button class="btn btn-sm" onclick="cancelInvAction('${id}')">Cancel</button>
            </div>`
          : '';
        return `<div style="border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:8px;background:var(--bg);">
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
            <select onchange="updateInventoryField('${id}',${i},'loc',this.value)" style="min-width:130px;">
              ${LOCATIONS.map(l => `<option value="${l}"${e.loc === l ? ' selected' : ''}>${locName(l)}</option>`).join('')}
            </select>
            <select onchange="updateInventoryField('${id}',${i},'storage',this.value)" style="min-width:110px;">
              ${STORAGE.map(s => `<option value="${s}"${e.storage === s ? ' selected' : ''}>${s}</option>`).join('')}
            </select>
            <label style="font-size:12px;color:var(--text2);">Qty</label>
            <input type="number" value="${e.qty}" step="0.5" min="0" style="width:72px;" onchange="updateInventoryField('${id}',${i},'qty',this.value)" />
            <span style="font-size:11px;color:var(--text3);font-family:monospace;margin-left:auto;">cooked ${esc(e.cookDate)}</span>
          </div>
          <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;">
            ${freezeBtn}${sendBtn}
            <span style="flex:1;"></span>
            ${removeBtn}
          </div>
          ${actionForm}
        </div>`;
      }).join('');

  showModal(`<h3>Edit stock &mdash; ${esc(d.name)}</h3>
    <div style="max-height:60vh;overflow-y:auto;margin-bottom:8px;">${cardsHtml}</div>
    <button class="btn btn-sm" onclick="addInventoryEntry('${id}')">+ Add row</button>
    <div class="modal-actions">
      <button class="btn btn-primary" onclick="closeModal()">Done</button>
    </div>`);
}

/** Per-row "Freeze" / "Send" button click → flip the inline qty form on
 *  that row. Clicking the same button again cancels. */
export function setInvAction(id: string, rowIdx: number, kind: string) {
  if (kind !== 'freeze' && kind !== 'send') return;
  if (_invPending && _invPending.rowIdx === rowIdx && _invPending.kind === kind) {
    _invPending = null;
  } else {
    _invPending = { rowIdx, kind };
  }
  renderInventoryEditor(id);
}

export function cancelInvAction(id: string) {
  _invPending = null;
  renderInventoryEditor(id);
}

/** Read the inline qty input, fire the appropriate POST, then re-render
 *  with the fresh batch state from the response. */
export async function confirmInvAction(id: string, rowIdx: number) {
  if (!_invPending || _invPending.rowIdx !== rowIdx) return;
  const action = _invPending;
  const d = S.batches.find(x => x.id === id);
  if (!d || !d.inventory || !d.inventory[rowIdx]) {
    _invPending = null;
    return;
  }
  const entry = d.inventory[rowIdx];
  const input = document.getElementById('inv-qty-' + rowIdx) as HTMLInputElement | null;
  const qty = input ? parseFloat(input.value) : NaN;
  if (isNaN(qty) || qty <= 0) {
    toastError('Please enter a positive quantity.');
    return;
  }
  if (qty > entry.qty + 0.001) {
    toastError(`Can't move ${qty}L — only ${entry.qty.toFixed(1)}L available in this row.`);
    return;
  }

  try {
    if (action.kind === 'freeze') {
      // /transfer with toStorage='Frozen'. Backend resets cookDate.
      trackEvent('batch_transfer', '', { batchId: id, fromLoc: entry.loc, fromStorage: entry.storage, toLoc: entry.loc, toStorage: 'Frozen', qty });
      const res = await apiPost(`/api/batches/${id}/transfer`, {
        fromLoc: entry.loc, fromStorage: entry.storage,
        toLoc: entry.loc, toStorage: 'Frozen',
        qty, fromInventoryIdx: rowIdx,
      });
      if (res && res.batch) {
        const idx = S.batches.findIndex(b => b.id === id);
        if (idx >= 0) S.batches[idx] = res.batch;
      }
      toast(res && res.warning ? res.warning : `Froze ${qty}L at ${locName(entry.loc)}`);
    } else {
      // /ship to the other loc.
      const toLoc: Location = entry.loc === 'west' ? 'centraal' : 'west';
      trackEvent('batch_ship', '', { batchId: id, toLoc, qty });
      const res = await apiPost(`/api/batches/${id}/ship`, {
        toLoc, qty, storage: entry.storage, fromInventoryIdx: rowIdx,
      });
      if (res && res.batch) {
        const idx = S.batches.findIndex(b => b.id === id);
        if (idx >= 0) S.batches[idx] = res.batch;
      }
      toast(res && res.warning ? res.warning : `Sent ${qty}L to ${locName(toLoc)}`);
    }
    _invPending = null;
    rebuildPlanner();
    renderInventoryEditor(id);
    rerenderCurrentView();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    toastError((action.kind === 'freeze' ? 'Freeze' : 'Send') + ' failed: ' + msg);
  }
}

export function setEditMode(id: string, mode: string) {
  if (mode !== 'normal' && mode !== 'power') return;
  _editMode = mode;
  renderEditDish(id);
}

function renderEditDish(id: string) {
  const d = S.batches.find(x => x.id === id) as BatchWithLegacy | undefined;
  if (!d) return;
  const allAg = [...(d.allergens || []), ...(d.extraAllergens || [])];
  const agHtml = allAg.map(a => {
    const isBase = (d.allergens || []).includes(a);
    return `<div class="at-tag">${esc(a)}${isBase ? ` <span style="opacity:.4;font-size:9px;">base</span>` : ` <span class="at-rm" onclick="removeExtraAllergen('${id}','${esc(a)}')">&#215;</span>`}</div>`;
  }).join('');
  const cookModeDay = d.cookMode !== 'date';

  // Mode toggle (lives in the header)
  const modeToggle = `<span class="modal-mode-toggle" style="display:inline-flex;gap:4px;margin-left:12px;font-size:12px;">
    <button class="btn btn-sm${_editMode === 'normal' ? ' btn-primary' : ''}" onclick="setEditMode('${id}','normal')">Normal</button>
    <button class="btn btn-sm${_editMode === 'power' ? ' btn-primary' : ''}" onclick="setEditMode('${id}','power')">Power</button>
  </span>`;

  // ── Inventory section: differs between Normal and Power ─────────────────
  let inventoryHtml = '';
  if (_editMode === 'normal') {
    const summary = renderInventorySummary(d);
    inventoryHtml = `<div class="fr"><label>Where is it?</label>
      <div class="batch-loc-summary" style="font-size:13px;line-height:1.6;">${summary}</div>
      <div style="display:flex;gap:6px;margin-top:8px;">
        <button class="btn btn-sm" onclick="openSendModal('${id}')">Send to other location</button>
        <button class="btn btn-sm" onclick="openTransferModal('${id}')">Transfer / Freeze</button>
      </div>
    </div>`;
  } else {
    // Power view — per-entry editor table + pending shipments listing
    const inv = d.inventory || [];
    const ship = d.shipments || [];
    inventoryHtml = `<div class="fr"><label>Inventory entries</label>
      <table class="inv-grid" style="width:100%;font-size:12px;border-collapse:collapse;">
        <thead><tr style="text-align:left;">
          <th style="padding:4px;">Loc</th><th style="padding:4px;">Storage</th><th style="padding:4px;">Qty (L)</th><th style="padding:4px;">Cook date</th><th></th>
        </tr></thead>
        <tbody>
          ${inv.length === 0 ? '<tr><td colspan="5" style="padding:8px;color:var(--text3);">No inventory</td></tr>' : inv.map((e, i) => `<tr>
            <td style="padding:4px;"><select onchange="updateInventoryField('${id}',${i},'loc',this.value)">${LOCATIONS.map(l => `<option value="${l}"${e.loc === l ? ' selected' : ''}>${locName(l)}</option>`).join('')}</select></td>
            <td style="padding:4px;"><select onchange="updateInventoryField('${id}',${i},'storage',this.value)">${STORAGE.map(s => `<option value="${s}"${e.storage === s ? ' selected' : ''}>${s}</option>`).join('')}</select></td>
            <td style="padding:4px;"><input type="number" value="${e.qty}" step="0.5" min="0" style="width:70px;" onchange="updateInventoryField('${id}',${i},'qty',this.value)" /></td>
            <td style="padding:4px;font-family:monospace;font-size:11px;">${esc(e.cookDate)}</td>
            <td style="padding:4px;"><button class="btn btn-sm btn-danger" onclick="removeInventoryEntry('${id}',${i})" title="Remove this entry">&times;</button></td>
          </tr>`).join('')}
        </tbody>
      </table>
      <button class="btn btn-sm" style="margin-top:6px;" onclick="addInventoryEntry('${id}')">+ Add entry</button>
    </div>
    <div class="fr"><label>Pending shipments</label>
      ${ship.filter(s => !s.arrived).length === 0
        ? '<div style="font-size:12px;color:var(--text3);">No pending shipments</div>'
        : `<ul style="margin:0;padding-left:16px;font-size:12px;">${ship.filter(s => !s.arrived).map(s => `<li style="margin:4px 0;">
            ${s.qty.toFixed(1)}L ${s.fromLoc === 'centraal' ? 'Centraal' : 'West'} → ${s.toLoc === 'centraal' ? 'Centraal' : 'West'}, ${s.storage} (cooked ${esc(s.cookDate)})
            <button class="btn btn-sm btn-danger" style="margin-left:8px;" onclick="cancelShipmentFromEdit('${id}','${s.id}')">Cancel</button>
          </li>`).join('')}</ul>`
      }
    </div>`;
  }

  showModal(`<h3>Edit &mdash; ${esc(d.name)}${modeToggle}</h3>
    ${inventoryHtml}
    <div class="fr"><label>Name</label><input type="text" id="ed-name" value="${esc(d.name)}" /></div>
    <div class="fr"><label>Type</label><select id="ed-type">
      ${['Soup','Main course','Dessert'].map(t => `<option${d.type === t ? ' selected' : ''}>${t}</option>`).join('')}
    </select></div>
    <div class="fr"><label>Cook date / day</label>
      <div class="cook-toggle">
        <button id="ct-day" class="${cookModeDay ? 'active' : ''}" onclick="setCookMode('${id}','day')">Plan a day</button>
        <button id="ct-date" class="${!cookModeDay ? 'active' : ''}" onclick="setCookMode('${id}','date')">Actual date</button>
      </div>
      <div id="cook-input">${cookModeDay
        ? `<select id="ed-cookday">${['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(day => `<option${d.cookDay === day ? ' selected' : ''}>${day}</option>`).join('')}</select>`
        : `<input type="date" id="ed-cookdate" value="${d.cookDate || ''}" />`}
      </div>
    </div>
    <div class="fr"><label>Allergens</label>
      <div class="allergen-tags" id="ag-tags">${agHtml || '<span style="font-size:12px;color:var(--text3);">none</span>'}</div>
      <div class="allergen-input-row">
        <input type="text" id="ag-new" placeholder="Add allergen&hellip;" onkeydown="if(event.key==='Enter')addExtraAllergen('${id}')" />
        <button class="btn btn-sm" onclick="addExtraAllergen('${id}')">Add</button>
      </div>
      <div class="modal-note">Allergens marked "base" come from the recipe.</div>
    </div>
    <div class="fr"><label>Include in order list?</label>
      <select id="ed-order">
        <option value="true"${d.orderFor ? ' selected' : ''}>Yes &mdash; include in order list</option>
        <option value="false"${!d.orderFor ? ' selected' : ''}>No</option>
      </select>
    </div>
    <div class="modal-actions">
      <button class="btn btn-danger btn-sm" onclick="deleteDish('${id}')">Delete</button>
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveEditDish('${id}')">Save</button>
    </div>`);
}

/** Power view: edit one field of one inventory entry. Optimistic mutation +
 *  scheduleSave so the next debounced patch picks it up.
 *
 *  After a loc or storage edit the entry may now share its (loc, storage,
 *  cookDate) key with another row. consolidateInventory folds those together
 *  on the spot, then re-renders the modal so the cook sees the merged
 *  view (matches the Stocktake screen's "one batch" display). */
export function updateInventoryField(id: string, idx: number, field: string, value: string) {
  const d = S.batches.find(x => x.id === id);
  if (!d || !d.inventory || idx < 0 || idx >= d.inventory.length) return;
  const entry = d.inventory[idx];
  let mergeKeyChanged = false;
  if (field === 'loc' && (value === 'west' || value === 'centraal')) {
    entry.loc = value;
    mergeKeyChanged = true;
  }
  else if (field === 'storage' && (value === 'Gastro' || value === 'Frozen' || value === 'Vac-packed')) {
    entry.storage = value;
    mergeKeyChanged = true;
  }
  else if (field === 'qty') {
    const n = parseFloat(value);
    if (!isNaN(n) && n >= 0) entry.qty = n;
  }
  if (mergeKeyChanged) {
    consolidateInventory(d);
    // Re-render the SAME modal the cook is currently in (could be the
    // simplified inventory editor OR the full Edit-dish in Power mode).
    // Always calling renderEditDish ripped the cook out of the simplified
    // editor and into the full form — Daan's smoke item 4.
    reRenderActiveInvModal(id);
  }
  rebuildPlanner();
  scheduleSave();
}

export function removeInventoryEntry(id: string, idx: number) {
  const d = S.batches.find(x => x.id === id);
  if (!d) return;
  removeInventory(d, idx);
  scheduleSave();
  reRenderActiveInvModal(id);
}

export function addInventoryEntry(id: string) {
  const d = S.batches.find(x => x.id === id);
  if (!d) return;
  addInventory(d, { loc: 'west', storage: 'Gastro', qty: 0, cookDate: dateToStr(getToday()) });
  scheduleSave();
  reRenderActiveInvModal(id);
}

export function cancelShipmentFromEdit(id: string, shipmentId: string) {
  const b = S.batches.find(x => x.id === id);
  if (!b) return;
  const shipment = (b.shipments || []).find(s => s.id === shipmentId);
  if (!shipment) return;

  // Snapshot + position for restore
  const snapshot = structuredClone(shipment);
  const originalIdx = (b.shipments || []).indexOf(shipment);

  // Optimistic local remove — Edit modal re-renders without the row
  b.shipments = (b.shipments || []).filter(s => s.id !== shipmentId);
  rebuildPlanner();
  renderEditDish(id);

  pushUndo({
    label: `Cancelled shipment (${(shipment.qty || 0).toFixed(1)} L → ${locName(shipment.toLoc)})`,
    restore: () => {
      const bb = S.batches.find(x => x.id === id);
      if (!bb) return;
      if (!bb.shipments) bb.shipments = [];
      const insertAt = Math.min(originalIdx, bb.shipments.length);
      bb.shipments.splice(insertAt, 0, snapshot);
      rebuildPlanner();
      renderEditDish(id);
    },
    commit: () => {
      trackEvent('shipment_cancel', '', { batchId: id, shipmentId });
      apiPost(`/api/batches/${id}/shipments/${shipmentId}/cancel`, {})
        .then((res: { batch?: Batch } | undefined) => {
          if (res && res.batch) {
            const bidx = S.batches.findIndex(x => x.id === id);
            if (bidx >= 0) S.batches[bidx] = res.batch;
            rebuildPlanner();
            renderEditDish(id);
          }
        })
        .catch((e: unknown) => {
          const msg = e instanceof Error ? e.message : 'Unknown error';
          const bb = S.batches.find(x => x.id === id);
          if (bb) {
            if (!bb.shipments) bb.shipments = [];
            const insertAt = Math.min(originalIdx, bb.shipments.length);
            bb.shipments.splice(insertAt, 0, snapshot);
            rebuildPlanner();
            renderEditDish(id);
          }
          toastError('Cancel failed: ' + msg + ' — shipment restored');
        });
    },
  });
}

export function setCookMode(id: string, mode: string) {
  const d = S.batches.find(x => x.id === id) as BatchWithLegacy | undefined; if (!d) return;
  d.cookMode = mode;
  document.getElementById('ct-day')!.classList.toggle('active', mode === 'day');
  document.getElementById('ct-date')!.classList.toggle('active', mode === 'date');
  document.getElementById('cook-input')!.innerHTML = mode === 'day'
    ? `<select id="ed-cookday">${['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(day => `<option${d.cookDay === day ? ' selected' : ''}>${day}</option>`).join('')}</select>`
    : `<input type="date" id="ed-cookdate" value="${d.cookDate || ''}" />`;
}

export function addExtraAllergen(id: string) {
  const d = S.batches.find(x => x.id === id); if (!d) return;
  const inp = document.getElementById('ag-new') as HTMLInputElement;
  const val = (inp.value || '').trim(); if (!val) return;
  if (!d.extraAllergens) d.extraAllergens = [];
  if (!d.extraAllergens.includes(val) && !(d.allergens || []).includes(val)) d.extraAllergens.push(val);
  inp.value = '';
  refreshAllergenTags(d);
}

export function removeExtraAllergen(id: string, allergen: string) {
  const d = S.batches.find(x => x.id === id); if (!d) return;
  d.extraAllergens = (d.extraAllergens || []).filter(a => a !== allergen);
  refreshAllergenTags(d);
}

export function refreshAllergenTags(d: Batch) {
  const allAg = [...(d.allergens || []), ...(d.extraAllergens || [])];
  document.getElementById('ag-tags')!.innerHTML = allAg.map(a => {
    const isBase = (d.allergens || []).includes(a);
    return `<div class="at-tag">${esc(a)}${isBase ? ` <span style="opacity:.4;font-size:9px;">base</span>` : ` <span class="at-rm" onclick="removeExtraAllergen('${d.id}','${esc(a)}')">&#215;</span>`}</div>`;
  }).join('') || '<span style="font-size:12px;color:var(--text3);">none</span>';
}

// refreshRecipe deleted: legacy v1 recipeSheetId field is gone; v2 recipes
// are managed via /api/recipes and openBatchRecipe.

export function saveEditDish(id: string) {
  const d = S.batches.find(x => x.id === id) as BatchWithLegacy | undefined; if (!d) return;
  d.name = (document.getElementById('ed-name') as HTMLInputElement).value;
  d.type = (document.getElementById('ed-type') as HTMLSelectElement).value as DishType;
  d.orderFor = (document.getElementById('ed-order') as HTMLSelectElement).value === 'true';
  if (d.cookMode === 'day') { const el = document.getElementById('ed-cookday') as HTMLSelectElement | null; if (el) d.cookDay = el.value || null; }
  else { const el = document.getElementById('ed-cookdate') as HTMLInputElement | null; if (el) d.cookDate = el.value || null; }
  // inventory + shipments edits already happened via the Power view's
  // updateInventoryField / addInventoryEntry / removeInventoryEntry handlers.
  closeModal(); rebuildPlanner(); rerenderCurrentView(); scheduleSave();
  toast('Batch saved');
}

export function deleteDish(id: string) {
  const d = S.batches.find(x => x.id === id);
  if (!d) return;
  const deletedBatch = structuredClone(d);
  S.batches = S.batches.filter(x => x.id !== id);
  closeModal(); rebuildPlanner(); rerenderCurrentView();
  pushUndo({
    label: 'Batch deleted',
    restore: () => { S.batches.push(deletedBatch); rebuildPlanner(); rerenderCurrentView(); },
    commit: () => { scheduleSave(); },
  });
}
