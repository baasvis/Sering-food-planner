import type { Batch, InventoryEntry, Shipment, RecipeFull, DishType, Location, Meal, Service, StorageType } from '@shared/types';
import { S, DAYS, MEALS, STORAGE, LOCATIONS, ALLERGENS, ACCOMPANIMENTS, getStorageColor } from './state';
import { newId, scheduleSave, toast, toastError, apiPost } from './utils';
import { rebuildPlanner, isBatchCooked, getAmsterdamNow, dateToDayName, dateToIso, isServicePast, calcRequired, calcRequiredBreakdown, calcTotalGuests, storageBadge, storageBadgeClass, typeBadge, typeBadgeClass, TYPES, cycleType, getGuests, chipClass, getToday, dateToStr, strToDate, diffStr, openServedDialog, openServedDialogForLoc, sortByCookDate, getTotalStock, getStockAt, getPendingFromShipments, isStaleEntry } from './core';
import { isServableBy } from './menu-fixer';
import { getVisibleDays, localDateStr, renderDayNav } from './predictions';
import { renderBatchTile, confirmCooked, calcRequiredForLoc, setCookDay, openNewDish, renderDishesOverview, cleanCateringRefs } from './dishes';
import { calcLitersForService, getMenuDishes, renderDashboard } from './dashboard';
import { showModal, closeModal, esc, setOpenInventoryFn } from './modal';
import { renderCaterings } from './caterings';
import { rerenderCurrentView, registerRenderer } from './navigate';
import { trackEvent } from './telemetry';
import { pushUndo } from './undo';
import { locName } from '@shared/location';

// ── WEEK PLAN (UNIFIED) ──────────────────────────────────

let _plannerInitialLocApplied = false;
export function renderWeekPlan() {
  // showScreen used to call rebuildPlanner() before dispatching here.
  // Each renderer that needs planner state now does it itself.
  rebuildPlanner();
  // On first render, default to the user's global location
  if (!_plannerInitialLocApplied) {
    _plannerInitialLocApplied = true;
    S.plannerSubTab = S.currentLoc;
  }
  const tab = S.plannerSubTab;
  const el = document.getElementById('screen-planner');
  // Visible count of items currently in transport, shown as a badge on the
  // sub-tab so users can immediately see when there's something to move
  // (addresses feedback #351 — "I can't see the items set to transport").
  // Pending-shipment count: one badge per shipment (not per batch), since
  // a single batch can have multiple shipments (8am + 1pm sends).
  const transportCount =
    S.batches.reduce((s, d) => s + (d.shipments || []).filter(sh => !sh.arrived).length, 0) +
    (S.transportItems || []).length;
  const transportLabel = transportCount > 0
    ? `To Transport <span class="sub-tab-badge">${transportCount}</span>`
    : 'To Transport';
  const tabs = [
    { id: 'west', label: 'Sering West' },
    { id: 'centraal', label: 'Sering Centraal' },
    { id: 'transport', label: transportLabel },
    { id: 'caterings', label: 'Caterings' },
    { id: 'overview', label: 'Overview' },
  ];
  let html = `<div class="sub-tab-bar">`;
  tabs.forEach(t => {
    html += `<button class="sub-tab ${tab === t.id ? 'active' : ''}" data-tab="${t.id}" onclick="setPlannerSubTab('${t.id}')">${t.label}</button>`;
  });
  html += `</div><div id="planner-content"></div>`;
  el.innerHTML = html;
  renderPlannerSubTab();
}

export function setPlannerSubTab(tab: string) {
  S.plannerSubTab = tab;
  document.querySelectorAll('.sub-tab').forEach(b => {
    b.classList.toggle('active', (b as HTMLElement).dataset.tab === tab);
  });
  renderPlannerSubTab();
}

export function renderPlannerSubTab() {
  const tab = S.plannerSubTab;
  if (tab === 'west') renderLocationPlan('west');
  else if (tab === 'centraal') renderLocationPlan('centraal');
  else if (tab === 'transport') renderTransportView();
  else if (tab === 'caterings') renderCaterings();
  else if (tab === 'overview') renderDishesOverview();
}

// Dispatcher: called by dishes.js and core.js instead of old renderDishes()
// Re-export from navigate so existing imports keep working
export { rerenderCurrentView } from './navigate';

// Register openInventory callback with modal system (for served dialog → inventory reopen)
// This runs at import time, which is fine since it's a simple assignment.
setOpenInventoryFn(openInventory);

export let _plannerDayOffset = 0;

export function changePlannerDay(delta: number) {
  _plannerDayOffset = Math.max(-14, Math.min(14, _plannerDayOffset + delta));
  renderPlannerSubTab();
}

// ── LOCATION PLAN (West / Centraal) ─────────────────────
export function renderLocationPlan(loc: string) {
  const typeGroups = [
    { key: 'Soup', label: 'Soups', cls: 'chip-soup' },
    { key: 'Main course', label: 'Mains', cls: 'chip-main' },
    { key: 'Dessert', label: 'Desserts', cls: 'chip-dessert' },
  ];

  const days = getVisibleDays(_plannerDayOffset);

  // Only show inventory button on the user's current location
  const invBtn = loc === S.currentLoc ? getInventoryButton(loc) : '';
  let html = renderDayNav(_plannerDayOffset, -14, 14, 'changePlannerDay', '');

  // Fix My Menu button only on West (it plans both locations + caterings globally
  // — see .claude/plans/fix-my-menu.md §4.1). Equipment editor sits next to it.
  const fixMenuBtn = loc === 'west'
    ? `<button class="btn btn-fix-menu" onclick="fixMyMenu()" title="Generate placeholders for missing cook events and assign service slots">✨ Fix my menu</button>
       <button class="btn btn-keq" onclick="openKitchenEquipmentModal()" title="Pots and burners — used by Fix My Menu to size batches">⚙️ Equipment</button>`
    : '';

  html += `<div class="btn-row" style="margin-bottom:12px;display:flex;gap:8px;align-items:center;">
    <button class="btn btn-primary" data-testid="new-batch-btn" onclick="openNewDish()">+ New batch</button>
    ${fixMenuBtn}
    ${invBtn}
  </div>
  <div id="split-bar-area"></div>`;

  const otherLoc = loc === 'west' ? 'centraal' : 'west';
  const otherLabel = loc === 'west' ? 'Centraal' : 'West';

  typeGroups.forEach(tg => {
    // Type section header (no collapse — dish lists moved to batch pool)
    html += `<div class="type-section">`;
    html += `<div class="type-section-hdr"><span class="type-dot ${tg.cls}"></span>${tg.label}</div>`;

    // Calendar grid for this type
    html += `<div class="week-scroll"><div class="week-grid"><div></div>`;

    // Day headers with copy button
    days.forEach(d => {
      const dispDate = `${d.date.getDate()}/${d.date.getMonth()+1}`;
      const isoDate = dateToIso(d.date);
      html += `<div class="day-hdr${d.isToday ? ' today-hdr' : ''}${d.isPast ? ' past-hdr' : ''}">${d.dayName}<span class="gt-date">${dispDate}</span><button class="copy-day-btn" onclick="event.stopPropagation();copyDayToOther('${loc}','${isoDate}')" title="Copy all ${d.dayName} batches to ${otherLabel}">&rarr; ${otherLabel}</button></div>`;
    });

    // Meal rows
    MEALS.forEach(meal => {
      const mealLabel = meal.charAt(0).toUpperCase() + meal.slice(1);
      html += `<div class="meal-lbl">${mealLabel}</div>`;
      days.forEach(d => {
        const isoDate = dateToIso(d.date);
        const k = `${loc}-${isoDate}-${meal}`;
        const slotDishes = (S.planner[k] || []).filter(dish => dish.type === tg.key);
        const slotServed = isServicePast({loc: loc as Location, date: isoDate, meal});
        html += `<div class="slot${d.isToday ? ' today' : ''}${d.isPast ? ' past-slot' : ''}" data-loc="${loc}" data-date="${isoDate}" data-meal="${meal}" data-type="${tg.key}" onclick="openAddDishTyped('${loc}','${isoDate}','${meal}','${tg.key}')" ondragover="slotDragOver(event)" ondragleave="slotDragLeave(event)" ondrop="slotDrop(event,'${loc}','${isoDate}','${meal}')">`;
        // One chip per batch — unified-batch model means each batch is its
        // own canonical menu option. Cross-batch same-recipe duplicates
        // (audit S7) intentionally render as separate chips: cook can see
        // them as distinct pots and remove individually.
        for (const dish of slotDishes) {
          // Pending-shipment hint: if this batch has stock pending arrival
          // at any loc, give the chip the transit-border treatment.
          const hasPending = (dish.shipments || []).some(s => !s.arrived);
          const trClass = hasPending ? ' chip-tr-border' : '';
          const servedClass = slotServed ? ' dish-chip-served' : '';
          // "Cross-loc" hint: if the slot is at this loc but the batch's
          // stock is all at the OTHER loc (will require a ship), show an
          // arrow from the off-loc to make this obvious.
          const stockHere = getStockAt(dish, loc as Location);
          const stockOther = getTotalStock(dish) - stockHere;
          const fromOther = stockHere === 0 && stockOther > 0;
          const fromTag = fromOther
            ? `<span class="chip-from">&larr; ${loc === 'west' ? 'Centraal' : 'West'}</span>`
            : '';
          html += `<div class="dish-chip ${tg.cls}${trClass}${servedClass}${fromOther ? ' chip-cross-loc' : ''}" title="${esc(dish.name)}"><span class="chip-nm">${esc(dish.name)}</span>${fromTag}${servedClass ? '<span class="chip-served">✓</span>' : `<span class="chip-x" onclick="event.stopPropagation();removeDishFromSlot('${dish.id}','${loc}','${isoDate}','${meal}')">&#10005;</span>`}</div>`;
        }
        html += `<div class="add-slot-btn" data-testid="slot-add-btn" onclick="event.stopPropagation();openAddDishTyped('${loc}','${isoDate}','${meal}','${tg.key}')">+</div>`;
        html += `</div>`;
      });
    });

    html += '</div></div>'; // close week-grid and week-scroll

    // Per-type batch pool directly below this type's calendar
    html += renderTypeBatchPool(loc, tg.key, tg.label, tg.cls);

    html += `</div>`; // close type-section
  });

  // ── "Show all batches" collapsible section ──────────────
  html += renderShowAllBatches(loc);

  document.getElementById('planner-content').innerHTML = html;
}

// Unified-batch: "all frozen" means every non-empty inventory entry is
// Frozen. Single legacy `b.storage === 'Frozen'` check no longer fits.
function isAllFrozen(b: Batch): boolean {
  const inv = b.inventory || [];
  if (inv.length === 0) return false;
  return inv.every(e => e.qty === 0 || e.storage === 'Frozen');
}

// ── BATCH POOL (per-type, below each calendar) ─────────
//
// A batch shows up in a location's pool when it's either physically here
// or has an UPCOMING service here. Past-only service ties are excluded —
// once the food is served, a Centraal-located batch shouldn't keep
// appearing in the West tab just because it served West last week.
export function getPoolBatches(loc: string) {
  return S.batches.filter(d => {
    // "Physically here" now means any stock at this loc, OR a pending
    // shipment in-flight to this loc (so the cook can see incoming food).
    const stockHere = getStockAt(d, loc as Location) > 0;
    const incomingHere = getPendingFromShipments(d, loc as Location) > 0;
    const hasUpcomingSvcHere = (d.services || []).some(s =>
      s.loc === loc && !isServicePast(s));
    return stockHere || incomingHere || hasUpcomingSvcHere;
  });
}

export function toggleTypeBatchPool(typeKey: string) {
  if (!S.openBatchPools) S.openBatchPools = new Set();
  if (S.openBatchPools.has(typeKey)) S.openBatchPools.delete(typeKey);
  else S.openBatchPools.add(typeKey);
  rerenderCurrentView();
}

export function renderTypeBatchPool(loc: string, typeKey: string, typeLabel: string, typeCls: string) {
  const poolBatches = getPoolBatches(loc).filter(d => d.type === typeKey);
  if (poolBatches.length === 0) return '';

  if (!S.openBatchPools) S.openBatchPools = new Set();
  const isOpen = S.openBatchPools.has(typeKey);

  let html = `<div class="batch-pool batch-pool-inline">`;
  html += `<button class="batch-pool-toggle" onclick="toggleTypeBatchPool('${typeKey}')">
    <span class="batch-pool-toggle-arrow">${isOpen ? '▾' : '▸'}</span>
    <span class="type-dot ${typeCls}"></span>${typeLabel}
    <span class="batch-pool-count">${poolBatches.length}</span>
  </button>`;

  if (isOpen) {
    const toCook = sortByCookDate(poolBatches.filter(d => !isBatchCooked(d) && !isAllFrozen(d)));
    const cooked = sortByCookDate(poolBatches.filter(d => isBatchCooked(d) && !isAllFrozen(d)));
    const frozen = poolBatches.filter(d => isAllFrozen(d));

    const renderGroup = (batches: Batch[]) => {
      return `<div class="batch-tile-grid">${batches.map(b => renderBatchTile(b)).join('')}</div>`;
    };

    if (toCook.length) {
      html += `<div class="dish-section-hdr"><div class="dish-section-dot" style="background:var(--amber);"></div>To cook <span class="dish-section-count">(${toCook.length})</span></div>`;
      html += renderGroup(toCook);
    }
    if (cooked.length) {
      html += `<div class="dish-section-hdr"><div class="dish-section-dot" style="background:var(--green);"></div>Cooked <span class="dish-section-count">(${cooked.length})</span></div>`;
      html += renderGroup(cooked);
    }
    if (frozen.length) {
      html += `<div class="dish-section-hdr"><div class="dish-section-dot" style="background:var(--blue);"></div>Frozen <span class="dish-section-count">(${frozen.length})</span></div>`;
      html += renderGroup(frozen);
    }
  }

  html += `</div>`;
  return html;
}

// ── "SHOW ALL BATCHES" COLLAPSIBLE ──────────────────────
export function toggleShowAllBatches() {
  S.showAllBatches = !S.showAllBatches;
  rerenderCurrentView();
}

export function renderShowAllBatches(loc: string) {
  const poolBatches = getPoolBatches(loc);
  if (poolBatches.length === 0) return '';

  let html = `<div class="batch-pool-showAll">`;
  html += `<button class="btn-show-all-batches" onclick="toggleShowAllBatches()">
    ${S.showAllBatches ? '▾ Hide all batches' : '▸ Show all batches'} <span class="batch-pool-count">${poolBatches.length}</span>
  </button>`;

  if (S.showAllBatches) {
    const toCook = sortByCookDate(poolBatches.filter(d => !isBatchCooked(d) && !isAllFrozen(d)));
    const cooked = sortByCookDate(poolBatches.filter(d => isBatchCooked(d) && !isAllFrozen(d)));
    const frozen = poolBatches.filter(d => isAllFrozen(d));

    const renderGroup = (batches: Batch[]) => {
      return `<div class="batch-tile-grid">${batches.map(b => renderBatchTile(b)).join('')}</div>`;
    };

    if (toCook.length) {
      html += `<div class="dish-section-hdr"><div class="dish-section-dot" style="background:var(--amber);"></div>To cook <span class="dish-section-count">(${toCook.length})</span></div>`;
      html += renderGroup(toCook);
    }
    if (cooked.length) {
      html += `<div class="dish-section-hdr"><div class="dish-section-dot" style="background:var(--green);"></div>Cooked <span class="dish-section-count">(${cooked.length})</span></div>`;
      html += renderGroup(cooked);
    }
    if (frozen.length) {
      html += `<div class="dish-section-hdr"><div class="dish-section-dot" style="background:var(--blue);"></div>Frozen <span class="dish-section-count">(${frozen.length})</span></div>`;
      html += renderGroup(frozen);
    }
  }

  html += `</div>`;
  return html;
}

// ── DRAG & DROP ─────────────────────────────────────────
export function batchDragStart(e: DragEvent, batchId: string) {
  S.draggingBatchId = batchId;
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', batchId);
  }
  (e.target as HTMLElement)?.closest('.batch-tile')?.classList.add('dragging');
  // Highlight all slots as drop targets
  document.querySelectorAll('.slot').forEach(s => s.classList.add('slot-assign-target'));
}

export function batchDragEnd(e: DragEvent) {
  S.draggingBatchId = null;
  const tile = (e.target as HTMLElement)?.closest('.batch-tile');
  if (tile) tile.classList.remove('dragging');
  document.querySelectorAll('.slot').forEach(s => {
    s.classList.remove('slot-assign-target', 'slot-drag-over');
  });
}

export function slotDragOver(e: DragEvent) {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  (e.currentTarget as HTMLElement)?.classList.add('slot-drag-over');
}

export function slotDragLeave(e: DragEvent) {
  (e.currentTarget as HTMLElement)?.classList.remove('slot-drag-over');
}

export function slotDrop(e: DragEvent, loc: string, date: string, meal: string) {
  trackEvent('batch_assign_drag');
  e.preventDefault();
  (e.currentTarget as HTMLElement)?.classList.remove('slot-drag-over');
  const batchId = S.draggingBatchId || e.dataTransfer?.getData('text/plain');
  if (!batchId) return;
  const batch = S.batches.find(d => d.id === batchId);
  if (!batch) return;
  S.draggingBatchId = null;
  const added = assignFamilyToSlot(batch, loc, date, meal);
  if (added.length === 0) {
    toast('Already assigned to this slot');
    return;
  }
  rebuildPlanner();
  scheduleSave();
  rerenderCurrentView();
  // Toast: family-aware language. If only the dragged batch got the
  // service, behave like the old toast. If siblings also got pulled in,
  // call out the family.
  if (added.length === 1) {
    toast(`${batch.name} assigned to ${dateToDayName(date)} ${meal}`);
  } else {
    const familyName = batch.name.replace(/\s*\(split\)\s*$/i, '').trim();
    toast(`${familyName} family assigned to ${dateToDayName(date)} ${meal} (${added.length} batches)`);
  }
}

/**
 * Family-aware service assignment. When the cook assigns ANY batch to a slot,
 * also assign every OTHER family member that can physically reach that slot
 * (per isServableBy). Otherwise the lone-assigned batch absorbs the entire
 * family's share of the slot's demand and goes negative on stock — forcing
 * the cook to manually assign each family member separately.
 *
 * Returns the list of batches that received a NEW service entry. Members
 * that already had it, or can't reach the slot, are skipped.
 *
 * The seed (the batch the user explicitly dragged/clicked) is always assigned
 * unless it already has that service entry — the user's explicit instruction
 * outranks logistics heuristics. (Note: legacy family-auto-assign logic is
 * gone in the unified-batch model — each batch is its own canonical row,
 * so dragging a batch into a slot adds only that batch's service. No
 * sibling pull-in. The function signature is preserved for call-site
 * compatibility; it now always returns a 1-element array.)
 */
export function assignFamilyToSlot(seed: Batch, loc: string, date: string, meal: string): Batch[] {
  if ((seed.services || []).some(s => s.loc === loc && s.date === date && s.meal === meal)) return [];
  if (!seed.services) seed.services = [];
  seed.services.push({ loc, date, meal } as Service);
  return [seed];
}

// ── TRANSPORT VIEW ───────────────────────────────────────
export function renderTransportView() {
  // Unified-batch model: collect pending shipments (one row per shipment),
  // grouped by batch so the cook sees N rows under each batch's header.
  // 8am send + 1pm send of the same batch render as 2 rows (locked decision
  // §"Repack mid-day").
  type ShipRow = { batch: Batch; shipment: Shipment };
  const shipRows: ShipRow[] = [];
  for (const b of S.batches) {
    for (const s of (b.shipments || [])) {
      if (!s.arrived) shipRows.push({ batch: b, shipment: s });
    }
  }
  // Stable sort: by batch name, then by sentAt ascending within a batch.
  shipRows.sort((a, b) => {
    const n = a.batch.name.localeCompare(b.batch.name);
    if (n !== 0) return n;
    return a.shipment.sentAt.localeCompare(b.shipment.sentAt);
  });

  let html = '';

  // ── Transport items (custom free-text items) ──
  html += `<div class="type-section">`;
  html += `<div class="type-section-hdr">Items to transport</div>`;
  html += `<div style="display:flex;gap:6px;margin-bottom:8px;">
    <input type="text" id="transport-item-input" placeholder="Add item to remember..." style="flex:1;font-size:13px;height:32px;border:1px solid var(--border2);border-radius:var(--radius);padding:0 10px;background:var(--bg);color:var(--text);" onkeydown="if(event.key==='Enter')addTransportItem()" />
    <button class="btn btn-primary" onclick="addTransportItem()" style="height:32px;">Add</button>
  </div>`;
  if ((S.transportItems || []).length > 0) {
    S.transportItems.forEach(item => {
      html += `<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);margin-bottom:4px;">
        <span style="flex:1;font-size:13px;">${esc(item.text)}</span>
        <button class="btn btn-sm" style="font-size:11px;color:var(--green);border-color:var(--green);" onclick="deliverTransportItem('${item.id}')">Delivered</button>
      </div>`;
    });
  } else {
    html += `<div style="font-size:12px;color:var(--text3);padding:4px 0;">No extra items</div>`;
  }
  html += `</div>`;

  // ── Pending shipments — one row per shipment, grouped by batch ──
  if (shipRows.length > 0) {
    html += `<div class="type-section">`;
    html += `<div class="type-section-hdr">Pending shipments</div>`;
    // Group rows by batch.id so each batch gets a header followed by its
    // shipment rows. Iteration order is preserved (alphabetical by batch
    // name, chronological within batch) thanks to the stable sort above.
    let lastBatchId: string | null = null;
    for (const { batch, shipment } of shipRows) {
      if (batch.id !== lastBatchId) {
        if (lastBatchId !== null) html += `</div>`; // close prior batch card
        lastBatchId = batch.id;
        html += `<div class="ship-batch-card" style="border:1px solid var(--border);border-radius:var(--radius);padding:8px;margin-bottom:8px;background:var(--bg);">
          <div class="ship-batch-hdr" style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
            <span style="font-weight:500;">${esc(batch.name)}</span>
            <span class="${typeBadgeClass(batch.type)}">${batch.type}</span>
          </div>`;
      }
      const fromLocLabel = locName(shipment.fromLoc);
      const toLocLabel = locName(shipment.toLoc);
      const sentAtDate = new Date(shipment.sentAt);
      const sentAtStr = !isNaN(sentAtDate.getTime())
        ? sentAtDate.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
        : esc(shipment.sentAt);
      html += `<div class="ship-row" style="display:flex;align-items:center;gap:8px;padding:6px 4px;border-top:1px dashed var(--border);font-size:13px;">
        <span class="ship-route" style="flex:1;">${fromLocLabel} &rarr; ${toLocLabel} &middot; ${shipment.storage} &middot; cooked ${esc(shipment.cookDate)}</span>
        <span class="ship-qty" style="font-weight:500;min-width:48px;text-align:right;">${shipment.qty.toFixed(1)}L</span>
        <span class="ship-when" style="font-size:11px;color:var(--text2);min-width:90px;text-align:right;">sent ${sentAtStr}</span>
        <button class="btn btn-sm" style="color:var(--green);border-color:var(--green);" onclick="markShipmentArrived('${batch.id}','${shipment.id}')">Mark arrived</button>
        <button class="btn btn-sm btn-danger" onclick="cancelShipment('${batch.id}','${shipment.id}')">× Cancel send</button>
      </div>`;
    }
    if (lastBatchId !== null) html += `</div>`; // close final batch card
    html += `</div>`; // close type-section
  } else {
    html += `<div class="empty" style="margin-top:12px;">No pending shipments</div>`;
  }

  document.getElementById('planner-content').innerHTML = html;
}

// ── Transport item functions ─────────────────────────────
export function addTransportItem() {
  const input = document.getElementById('transport-item-input') as HTMLInputElement | null;
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  S.transportItems.push({ id: newId(), text });
  input.value = '';
  scheduleSave();
  rerenderCurrentView();
}

export function deliverTransportItem(id: string) {
  S.transportItems = S.transportItems.filter(i => i.id !== id);
  scheduleSave();
  rerenderCurrentView();
  toast('Item delivered');
}

// Legacy bulk-mark-arrived flow is replaced by per-shipment buttons in the
// transport tab. Keeping the function as a no-op stub avoids breaking any
// external callers (e.g. old keyboard shortcuts); a real call surfaces a
// helpful toast pointing the cook at the new per-row button.
export function markSelectedArrived() {
  toast('Use the per-shipment "Mark arrived" buttons in the Transport tab');
}

/** Per-shipment mark-arrived. POSTs the dedicated /arrived endpoint and
 *  updates local state from the response. */
export async function markShipmentArrived(batchId: string, shipmentId: string) {
  trackEvent('shipment_mark_arrived', '', { batchId, shipmentId });
  try {
    const res = await apiPost(`/api/batches/${batchId}/shipments/${shipmentId}/arrived`, {});
    if (res && res.batch) {
      const idx = S.batches.findIndex(b => b.id === batchId);
      if (idx >= 0) S.batches[idx] = res.batch;
    }
    toast('Shipment arrived');
    rebuildPlanner();
    rerenderCurrentView();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    toastError('Mark arrived failed: ' + msg);
  }
}

/** Per-shipment cancel. Soft-deletes through the undo manager (5s window)
 *  so a misclick is recoverable on a kitchen tablet. After 5s the dedicated
 *  /cancel endpoint fires and the source-inventory restore happens
 *  server-side. */
export function cancelShipment(batchId: string, shipmentId: string) {
  const b = S.batches.find(x => x.id === batchId);
  if (!b) return;
  const shipment = (b.shipments || []).find(s => s.id === shipmentId);
  if (!shipment) return;

  // Snapshot + position for restore
  const snapshot = structuredClone(shipment);
  const originalIdx = (b.shipments || []).indexOf(shipment);

  // Optimistic local remove — UI updates immediately
  b.shipments = (b.shipments || []).filter(s => s.id !== shipmentId);
  rebuildPlanner();
  rerenderCurrentView();

  pushUndo({
    label: `Cancelled shipment (${(shipment.qty || 0).toFixed(1)} L → ${locName(shipment.toLoc)})`,
    restore: () => {
      const bb = S.batches.find(x => x.id === batchId);
      if (!bb) return;
      if (!bb.shipments) bb.shipments = [];
      const insertAt = Math.min(originalIdx, bb.shipments.length);
      bb.shipments.splice(insertAt, 0, snapshot);
      rebuildPlanner();
      rerenderCurrentView();
    },
    commit: () => {
      trackEvent('shipment_cancel', '', { batchId, shipmentId });
      apiPost(`/api/batches/${batchId}/shipments/${shipmentId}/cancel`, {})
        .then((res: { batch?: Batch } | undefined) => {
          if (res && res.batch) {
            const bidx = S.batches.findIndex(x => x.id === batchId);
            if (bidx >= 0) S.batches[bidx] = res.batch;
            rebuildPlanner();
            rerenderCurrentView();
          }
        })
        .catch((e: unknown) => {
          const msg = e instanceof Error ? e.message : 'Unknown error';
          // Restore optimistically-removed shipment so cook can retry
          const bb = S.batches.find(x => x.id === batchId);
          if (bb) {
            if (!bb.shipments) bb.shipments = [];
            const insertAt = Math.min(originalIdx, bb.shipments.length);
            bb.shipments.splice(insertAt, 0, snapshot);
            rebuildPlanner();
            rerenderCurrentView();
          }
          toastError('Cancel failed: ' + msg + ' — shipment restored');
        });
    },
  });
}

// ── ADD DISH MODAL ───────────────────────────────────────
export function removeDishFromSlot(dishId: string, loc: string, date: string, meal: string) {
  const dish = S.batches.find(d => d.id === dishId);
  if (dish) { dish.services = (dish.services || []).filter(s => !(s.loc === loc && s.date === date && s.meal === meal)); }
  rebuildPlanner(); rerenderCurrentView(); scheduleSave();
}

/**
 * Family-aware chip removal: when the cook clicks × on a merged family chip,
 * clear the slot's service entry from EVERY contributing physical batch.
 * Without this, removing the chip would only clear one batch and the chip
 * would stay because the other family member still has the service.
 */
export function removeFamilyFromSlot(memberIdsCsv: string, loc: string, date: string, meal: string) {
  const ids = memberIdsCsv.split(',');
  for (const id of ids) {
    const dish = S.batches.find(d => d.id === id);
    if (dish) {
      dish.services = (dish.services || []).filter(s => !(s.loc === loc && s.date === date && s.meal === meal));
    }
  }
  rebuildPlanner(); rerenderCurrentView(); scheduleSave();
}

export function toggleTypeCollapse(key: string) {
  S.collapsedTypes[key] = !S.collapsedTypes[key];
  rerenderCurrentView();
}

export function copyDayToOther(fromLoc: string, date: string) {
  const toLoc = fromLoc === 'west' ? 'centraal' : 'west';
  const toLabel = locName(toLoc);
  const dayName = dateToDayName(date);
  let added = 0;
  MEALS.forEach(meal => {
    const k = `${fromLoc}-${date}-${meal}`;
    const dishes = S.planner[k] || [];
    dishes.forEach(dish => {
      const already = (dish.services || []).some(s => s.loc === toLoc && s.date === date && s.meal === meal);
      if (!already) {
        if (!dish.services) dish.services = [];
        dish.services.push({ loc: toLoc, date, meal });
        added++;
      }
    });
  });
  if (added > 0) {
    rebuildPlanner(); rerenderCurrentView(); scheduleSave();
    toast(`${added} batch${added > 1 ? 'es' : ''} copied to ${toLabel} ${dayName}`);
  } else {
    toast('All batches already assigned there');
  }
}

export function copySlotToOther(fromLoc: string, date: string, meal: string) {
  const toLoc = fromLoc === 'west' ? 'centraal' : 'west';
  const toLabel = locName(toLoc);
  const k = `${fromLoc}-${date}-${meal}`;
  const dishes = S.planner[k] || [];
  if (!dishes.length) return;

  let added = 0;
  dishes.forEach(dish => {
    const already = (dish.services || []).some(s => s.loc === toLoc && s.date === date && s.meal === meal);
    if (!already) {
      if (!dish.services) dish.services = [];
      dish.services.push({ loc: toLoc, date, meal: meal as Meal });
      added++;
    }
  });

  if (added > 0) {
    rebuildPlanner(); rerenderCurrentView(); scheduleSave();
    toast(`${added} batch${added > 1 ? 'es' : ''} copied to ${toLabel} ${dateToDayName(date)} ${meal}`);
  } else {
    toast('All batches already assigned there');
  }
}

export function openAddDishTyped(loc: string, date: string, meal: string, type: string) {
  const existing = (S.planner[`${loc}-${date}-${meal}`] || []).map(d => d.id);
  renderAddModal(loc, date, meal, existing, '', type, 'cooked');
}

export function openAddDish(loc: string, date: string, meal: string) {
  const existing = (S.planner[`${loc}-${date}-${meal}`] || []).map(d => d.id);
  renderAddModal(loc, date, meal, existing, '', '', 'cooked');
}

export function renderAddModal(loc: string, date: string, meal: string, existing: string[], searchQuery: string, typeFilter: string, tab: string, locFilter?: string) {
  // Store modal state globally so onclick/oninput handlers can reference it
  // without embedding JSON in HTML attributes (which breaks on double quotes)
  if (!locFilter) locFilter = loc;
  S._addModalState = { loc, date, meal, existing, typeFilter, tab, locFilter };

  const locLabel = locName(locFilter);
  const typeLabel = typeFilter ? ` (${typeFilter === 'Main course' ? 'Mains' : typeFilter + 's'})` : '';

  // Build filtered lists for counts and display
  let allAvail = S.batches.filter(d => !existing.includes(d.id));
  if (typeFilter) allAvail = allAvail.filter(d => d.type === typeFilter);

  // "Available cooked at locFilter" = batch with any qty at this loc.
  // Pending-incoming shipments also qualify (food is on the way; cook can
  // pre-plan around it). Excludes batches whose stock lives entirely at the
  // OTHER loc (would require a ship before serving at locFilter).
  const cookedDishes = allAvail.filter(d => {
    if (!isBatchCooked(d)) return false;
    return getStockAt(d, locFilter as Location) > 0 || getPendingFromShipments(d, locFilter as Location) > 0;
  });
  const plannedDishes = sortByCookDate(allAvail.filter(d => !isBatchCooked(d) && (d.services || []).length > 0));
  // Recipe v1 index removed in S12 — the legacy "Recipes" tab in this modal
  // now relies entirely on S.recipes (v2). Keeping the empty array here so
  // the existing tab/count layout below renders unchanged.
  type LegacyRecipe = {
    id: string;
    name: string;
    type?: string;
    allergens?: string[];
    costPerServing?: string;
  };
  const allRecipes: LegacyRecipe[] = [];

  // Apply search filter
  let filteredCooked = cookedDishes;
  let filteredPlanned = plannedDishes;
  const filteredRecipes: LegacyRecipe[] = allRecipes;
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    filteredCooked = cookedDishes.filter(d => d.name.toLowerCase().includes(q));
    filteredPlanned = plannedDishes.filter(d => d.name.toLowerCase().includes(q));
  }

  // Render dish options helper — unified-batch model: surface total stock +
  // per-loc breakdown so the cook can see whether the batch has stock at
  // THIS slot's loc or needs to be shipped.
  const renderDishOpts = (dishes: Batch[]) => dishes.map(d => {
    const { str, cls } = diffStr(d);
    const allAg = [...(d.allergens || []), ...(d.extraAllergens || [])];
    const agHtml = allAg.slice(0, 4).map(a => `<span class="allergen-pill">${esc(a)}</span>`).join('');
    const cookInfo = isBatchCooked(d) ? 'Cooked' : d.cookDate ? 'Cook: ' + d.cookDate : '';
    const totalStock = getTotalStock(d);
    const stockHere = getStockAt(d, loc as Location);
    const stockOther = totalStock - stockHere;
    // Compact "55L (here 30 · 25L W)" — only show breakdown when split.
    const locHint = totalStock > 0 && stockOther > 0
      ? ` <small style="color:var(--text2);">(${stockHere.toFixed(0)} here, ${stockOther.toFixed(0)} ${loc === 'west' ? 'C' : 'W'})</small>`
      : '';
    return `<div class="dish-opt" data-testid="dish-opt" onclick="confirmAddDish('${d.id}','${loc}','${date}','${meal}')">
      <div style="flex:1;">
        <div><span style="font-weight:500;">${esc(d.name)}</span> ${typeBadge(d.type)}</div>
        <div style="font-size:11px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:2px;">
          <span class="${cls}">${totalStock.toFixed(1)}L stock${locHint} &middot; ${str}</span>
          ${agHtml ? `<span>${agHtml}</span>` : ''}
          ${cookInfo ? `<span style="color:var(--text3);">${cookInfo}</span>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');

  // Render recipe options helper. Operates on the (now-always-empty)
  // legacy LegacyRecipe[] above; v2 recipes are surfaced through their
  // own helper elsewhere in this modal.
  const renderRecipeOpts = (recipes: LegacyRecipe[]) => recipes.slice(0, 20).map(r => {
    const ags = (r.allergens || []).slice(0, 3).map(a => `<span class="allergen-pill">${esc(a)}</span>`).join('');
    return `<div class="dish-opt" onclick="addRecipeToSlot('${r.id}','${loc}','${date}','${meal}')">
      <div style="flex:1;">
        <div><span style="font-weight:500;">${esc(r.name)}</span> ${typeBadge((r.type || 'Soup') as DishType)}</div>
        <div style="font-size:11px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:2px;">
          ${ags}
          ${r.costPerServing ? `<span style="color:var(--text3);">${esc(r.costPerServing)}</span>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');

  // Build list content based on active tab
  let listHtml = '';
  if (tab === 'cooked') {
    listHtml = filteredCooked.length > 0 ? renderDishOpts(filteredCooked)
      : `<div class="empty">No cooked batches at ${locLabel}${typeLabel}${searchQuery ? ' matching "' + esc(searchQuery) + '"' : ''}</div>`;
  } else if (tab === 'planned') {
    listHtml = filteredPlanned.length > 0 ? renderDishOpts(filteredPlanned)
      : `<div class="empty">No planned batches${typeLabel}${searchQuery ? ' matching "' + esc(searchQuery) + '"' : ''}</div>`;
  } else {
    listHtml = filteredRecipes.length > 0 ? renderRecipeOpts(filteredRecipes)
      : `<div class="empty">No recipes available${typeLabel}${searchQuery ? ' matching "' + esc(searchQuery) + '"' : ''}</div>`;
  }

  // Tab bar
  const tabs = [
    { id: 'cooked', label: 'Cooked', count: filteredCooked.length },
    { id: 'planned', label: 'Planned', count: filteredPlanned.length },
    { id: 'recipes', label: 'Recipes', count: filteredRecipes.length },
  ];
  const tabBarHtml = tabs.map(t =>
    `<button class="sub-tab ${tab === t.id ? 'active' : ''}" onclick="event.stopPropagation();switchAddModalTab('${t.id}')">${t.label} <span style="opacity:.6;font-size:11px;">${t.count}</span></button>`
  ).join('');

  // Location toggle
  const slotLocLabel = locName(loc);
  const locToggleHtml = `<div class="order-loc-bar" style="margin-bottom:10px;" id="add-modal-loc-toggle">
    <button class="order-loc-btn${locFilter === 'west' ? ' active' : ''}" onclick="switchAddModalLoc('west')">Sering West</button>
    <button class="order-loc-btn${locFilter === 'centraal' ? ' active' : ''}" onclick="switchAddModalLoc('centraal')">Sering Centraal</button>
  </div>`;

  // If the modal is already open, only update the dynamic parts
  const existingModal = document.getElementById('add-modal-tabs');
  if (existingModal) {
    document.getElementById('add-modal-loc-toggle').outerHTML = locToggleHtml;
    existingModal.innerHTML = tabBarHtml;
    document.getElementById('add-modal-list').innerHTML = listHtml;
    return;
  }

  // First open — render the full modal
  const dayName = dateToDayName(date);
  showModal(`<h3>Add${typeLabel} to ${dayName} ${meal} &middot; ${slotLocLabel}</h3>
    <input type="text" class="dish-search" id="planner-search" placeholder="Search..." value="${esc(searchQuery)}"
      oninput="searchAddModal()" />
    ${locToggleHtml}
    <div class="sub-tab-bar" style="margin-bottom:10px;" id="add-modal-tabs">${tabBarHtml}</div>
    <div class="dish-opts-list" style="max-height:340px;" id="add-modal-list">${listHtml}</div>
    <div class="modal-actions">
      <button class="btn" style="background:var(--blue);color:white;" onclick="addPlaceholderDish()">+ Placeholder</button>
      <button class="btn" onclick="closeModal()">Close</button>
    </div>`);
  const si = document.getElementById('planner-search');
  if (si) si.focus();
}

export function updateAddModal(loc: string, date: string, meal: string, existing: string[], typeFilter: string, tab: string) {
  const searchQuery = ((document.getElementById('planner-search') as HTMLInputElement | null) || ({} as HTMLInputElement)).value || '';
  const locFilter = S._addModalState ? S._addModalState.locFilter : loc;
  renderAddModal(loc, date, meal, existing, searchQuery, typeFilter, tab, locFilter);
}

export function switchAddModalTab(tab: string) {
  const s = S._addModalState;
  if (!s) return;
  s.tab = tab;
  const searchQuery = ((document.getElementById('planner-search') as HTMLInputElement | null) || ({} as HTMLInputElement)).value || '';
  renderAddModal(s.loc, s.date, s.meal, s.existing, searchQuery, s.typeFilter, tab, s.locFilter);
}

export function switchAddModalLoc(newLoc: string) {
  const s = S._addModalState;
  if (!s) return;
  s.locFilter = newLoc;
  const searchQuery = ((document.getElementById('planner-search') as HTMLInputElement | null) || ({} as HTMLInputElement)).value || '';
  renderAddModal(s.loc, s.date, s.meal, s.existing, searchQuery, s.typeFilter, s.tab, newLoc);
}

export function searchAddModal() {
  const s = S._addModalState;
  if (!s) return;
  const searchQuery = ((document.getElementById('planner-search') as HTMLInputElement | null) || ({} as HTMLInputElement)).value || '';
  renderAddModal(s.loc, s.date, s.meal, s.existing, searchQuery, s.typeFilter, s.tab, s.locFilter);
}

export function confirmAddDish(dishId: string, loc: string, date: string, meal: string) {
  trackEvent('batch_assign_modal');
  const dish = S.batches.find(d => d.id === dishId);
  if (dish) { if (!dish.services) dish.services = []; dish.services.push({ loc: loc as Location, date, meal: meal as Meal }); }
  closeModal(); rebuildPlanner(); rerenderCurrentView(); scheduleSave();
  toast(`${dish.name} added to ${dateToDayName(date)} ${meal}`);
}

// addRecipeToSlot was the v1-index path. Replaced with a deprecation toast —
// the v2 path goes through replaceWithRecipe / addDishFromV2Recipe.
export function addRecipeToSlot(_recipeId: string, _loc: string, _date: string, _meal: string) {
  toastError('Recipe v1 has been removed — use Recipes → "+ Create recipe", then add via the planner.');
}

export function addPlaceholderDish() {
  const s = S._addModalState;
  if (!s) return;
  const { loc, date, meal, typeFilter } = s;
  const dayName = dateToDayName(date);
  const type: DishType = (typeFilter as DishType) || 'Soup';
  const typeLabel = type === 'Main course' ? 'Main' : type;
  const name = `${dayName} ${typeLabel}`;

  // Unified-batch shape. The legacy-field version (stock/location/storage/
  // parentId/recipeSheetId/...) was missed during the C1–C5 rewrite and
  // shipped to prod 2026-05-12; validateBatch on the server then rejected
  // saves with "Batch 0: inventory must be an array". Daan caught this
  // trying to add a placeholder via the slot's + button.
  const newDish: Batch = {
    id: newId(),
    name,
    type,
    serving: 280,
    cookDate: dateToStr(new Date(date)),
    inventory: [],
    shipments: [],
    services: [{ loc: loc as Location, date, meal: meal as Meal }],
    allergens: [],
    extraAllergens: [],
    note: '',
    cookNotes: '',
    actualIngredients: null,
    orderFor: false,
    stockDeducted: false,
    recipeId: null,
    createdAt: new Date().toISOString(),
  };
  S.batches.push(newDish);
  closeModal(); rebuildPlanner(); rerenderCurrentView(); scheduleSave();
  toast(`Placeholder "${name}" added to ${dayName} ${meal}`);
}

// ── REPLACE BATCH ────────────────────────────────────────

export function openReplaceBatch(batchId: string) {
  const old = S.batches.find(d => d.id === batchId);
  if (!old) return;
  if (isBatchCooked(old)) { toast('Cannot replace a cooked batch'); return; }
  if (!(old.services || []).length) { toast('Batch has no services to transfer'); return; }

  S._replaceState = { oldBatchId: batchId, searchQuery: '', tab: 'batches' };
  renderReplaceModal();
}

export function renderReplaceModal() {
  const rs = S._replaceState;
  if (!rs) return;
  const old = S.batches.find(d => d.id === rs.oldBatchId);
  if (!old) return;

  // Show which services will be transferred
  const svcLabels = (old.services || []).map(s =>
    `${dateToDayName(s.date)} ${s.meal}`
  ).join(', ');

  // Candidates: same type, not the old batch, not cooked
  let candidates = S.batches.filter(d =>
    d.id !== old.id && d.type === old.type && !isBatchCooked(d)
  );
  // Recipes: search through ALL v2 recipes of the same type (legacy recipeIndex
  // is no longer the source of truth — see CLAUDE.md "all planner batches now
  // use v2 recipes"). Don't exclude already-active ones; cook may want to use
  // the same recipe twice in a week.
  let recipes = (S.recipes || []).filter(r =>
    (r.type || 'Soup') === old.type
  );

  // Apply search (matches name, structure, seasonality — broader than just name)
  if (rs.searchQuery) {
    const q = rs.searchQuery.toLowerCase();
    candidates = candidates.filter(d => d.name.toLowerCase().includes(q));
    recipes = recipes.filter(r =>
      r.name.toLowerCase().includes(q)
      || (r.structure || '').toLowerCase().includes(q)
      || (r.seasonality || '').toLowerCase().includes(q)
    );
  }

  // Render batch options
  const renderBatchOpts = (batches: Batch[]) => batches.map(d => {
    const allAg = [...(d.allergens || []), ...(d.extraAllergens || [])];
    const agHtml = allAg.slice(0, 4).map(a => `<span class="allergen-pill">${esc(a)}</span>`).join('');
    const cookInfo = d.cookDate ? 'Cook: ' + d.cookDate : '';
    const svcCount = (d.services || []).length;
    const svcNote = svcCount > 0 ? `${svcCount} service${svcCount > 1 ? 's' : ''}` : 'Unassigned';
    // Unified-batch: surface the per-storage breakdown via storage badges
    // (one per distinct storage type the batch holds). Single legacy
    // `d.storage` doesn't exist anymore.
    const storages = Array.from(new Set((d.inventory || []).filter(e => e.qty > 0).map(e => e.storage)));
    const storageBadges = storages.length > 0
      ? storages.map(s => storageBadge(s)).join(' ')
      : '';
    return `<div class="dish-opt" onclick="confirmReplaceBatch('${d.id}')">
      <div style="flex:1;">
        <div><span style="font-weight:500;">${esc(d.name)}</span> ${storageBadges}</div>
        <div style="font-size:11px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:2px;">
          <span style="color:var(--text3);">${svcNote}</span>
          ${agHtml ? `<span>${agHtml}</span>` : ''}
          ${cookInfo ? `<span style="color:var(--text3);">${cookInfo}</span>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');

  const renderRecipeOpts = (recs: RecipeFull[]) => recs.slice(0, 50).map(r => {
    const allAg = [...new Set([...(r.autoAllergens || []), ...(r.extraAllergens || [])])];
    const ags = allAg.slice(0, 3).map(a => `<span class="allergen-pill">${esc(a)}</span>`).join('');
    const meta: string[] = [];
    if (r.structure) meta.push(esc(r.structure));
    if (r.seasonality) meta.push(esc(r.seasonality));
    if (r.costPerServing != null) meta.push(`€${r.costPerServing.toFixed(2)}/p`);
    return `<div class="dish-opt" onclick="replaceWithV2Recipe('${esc(r.id)}')">
      <div style="flex:1;">
        <div><span style="font-weight:500;">${esc(r.name)}</span></div>
        <div style="font-size:11px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:2px;">
          ${ags}
          ${meta.length > 0 ? `<span style="color:var(--text3);">${meta.join(' · ')}</span>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');

  // Tabs
  const tabs = [
    { id: 'batches', label: 'Batches', count: candidates.length },
    { id: 'recipes', label: 'Recipes', count: recipes.length },
  ];
  const tabBarHtml = tabs.map(t =>
    `<button class="sub-tab ${rs.tab === t.id ? 'active' : ''}" onclick="event.stopPropagation();switchReplaceTab('${t.id}')">${t.label} <span style="opacity:.6;font-size:11px;">${t.count}</span></button>`
  ).join('');

  let listHtml = '';
  if (rs.tab === 'batches') {
    listHtml = candidates.length > 0 ? renderBatchOpts(candidates)
      : `<div class="empty">No uncooked ${old.type.toLowerCase()} batches available${rs.searchQuery ? ' matching "' + esc(rs.searchQuery) + '"' : ''}</div>`;
  } else {
    listHtml = recipes.length > 0 ? renderRecipeOpts(recipes)
      : `<div class="empty">No recipes available${rs.searchQuery ? ' matching "' + esc(rs.searchQuery) + '"' : ''}</div>`;
  }

  // If modal already open, update in place
  const existingTabs = document.getElementById('replace-modal-tabs');
  if (existingTabs) {
    existingTabs.innerHTML = tabBarHtml;
    document.getElementById('replace-modal-list').innerHTML = listHtml;
    return;
  }

  const typeLabel = old.type === 'Main course' ? 'main' : old.type.toLowerCase();
  showModal(`<h3>Replace ${esc(old.name)}</h3>
    <div style="font-size:13px;color:var(--text3);margin-bottom:10px;">Assigned to: ${svcLabels}</div>
    <input type="text" class="dish-search" id="replace-search" placeholder="Search ${typeLabel}s..." value="${esc(rs.searchQuery)}"
      oninput="searchReplaceModal()" />
    <div class="sub-tab-bar" style="margin-bottom:10px;" id="replace-modal-tabs">${tabBarHtml}</div>
    <div class="dish-opts-list" style="max-height:340px;" id="replace-modal-list">${listHtml}</div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
    </div>`);
  const si = document.getElementById('replace-search');
  if (si) si.focus();
}

export function switchReplaceTab(tab: string) {
  const rs = S._replaceState;
  if (!rs) return;
  rs.tab = tab;
  rs.searchQuery = ((document.getElementById('replace-search') as HTMLInputElement | null) || ({} as HTMLInputElement)).value || '';
  renderReplaceModal();
}

export function searchReplaceModal() {
  const rs = S._replaceState;
  if (!rs) return;
  rs.searchQuery = ((document.getElementById('replace-search') as HTMLInputElement | null) || ({} as HTMLInputElement)).value || '';
  renderReplaceModal();
}

export function confirmReplaceBatch(newBatchId: string) {
  const rs = S._replaceState;
  if (!rs) return;
  const old = S.batches.find(d => d.id === rs.oldBatchId);
  const replacement = S.batches.find(d => d.id === newBatchId);
  if (!old || !replacement) return;

  // Transfer cook date if replacement doesn't have one
  if (old.cookDate && !replacement.cookDate) {
    replacement.cookDate = old.cookDate;
  }

  // Transfer services, deduplicating
  const existing = replacement.services || [];
  (old.services || []).forEach(svc => {
    const dup = existing.some(e => e.loc === svc.loc && e.date === svc.date && e.meal === svc.meal);
    if (!dup) existing.push(svc);
  });
  replacement.services = existing;

  // Update catering references from old → replacement
  cleanCateringRefs(old.id, newBatchId);

  // Delete old batch
  const oldName = old.name;
  S.batches = S.batches.filter(d => d.id !== old.id);
  if (!S.deletedBatches) S.deletedBatches = [];
  S.deletedBatches.push(old.id);

  closeModal();
  rebuildPlanner();
  rerenderCurrentView();
  scheduleSave();
  toast(`Replaced ${oldName} with ${replacement.name}`);
}

// replaceWithRecipe was the v1-index path. Removed in S12 — replacement now
// goes through replaceWithV2Recipe (below) for the v2 path.
export function replaceWithRecipe(_recipeId: string) {
  toastError('Recipe v1 has been removed — use Recipes → v2 recipe → "Add to menu" instead.');
}

/**
 * V2 recipe replace path. Mirror of replaceWithRecipe but consumes from
 * S.recipes (the v2 recipe library) and links via recipeId rather than
 * recipeSheetId. Transfers services + cookDate from the old batch.
 */
export function replaceWithV2Recipe(recipeId: string) {
  const rs = S._replaceState;
  if (!rs) return;
  const old = S.batches.find(d => d.id === rs.oldBatchId);
  const r = (S.recipes || []).find(x => x.id === recipeId);
  if (!old || !r) return;

  const allAllergens = [...new Set([...(r.autoAllergens || []), ...(r.extraAllergens || [])])];
  // Snapshot ingredients into the JSON shape the order system expects
  const snapshotIngredients = (r.ingredients || []).map(ing => ({
    name: ing.ingredientName || ing.flexLabel || 'Unknown',
    amount: ing.rawAmount,
    unit: ing.unit,
    source: '',
    cost: 0,
  }));

  // Unified-batch model: new replacement starts with empty inventory and
  // shipments. The cook decides where it's cooked at "Mark cooked" time.
  // We don't auto-port `old`'s inventory because the new dish is a
  // different recipe; copying stock would be a unit-of-account error.
  const newBatch: Batch = {
    id: newId(),
    name: r.name,
    type: (r.type || 'Soup') as DishType,
    serving: r.servingSize || 280,
    inventory: [],
    shipments: [],
    allergens: allAllergens,
    extraAllergens: [],
    orderFor: false,
    cookDate: old.cookDate || null,
    note: '',
    services: [...(old.services || [])],
    createdAt: new Date().toISOString(),
    recipeId: r.id,
    actualIngredients: null,
    cookNotes: '',
    stockDeducted: false,
    generated: false,  // a real recipe now, no longer an algorithm placeholder
  };
  // Note: snapshotIngredients (the legacy recipe-ingredients snapshot) is
  // no longer stored on Batch — actualIngredients is the v2 path, populated
  // at post-cook time via openPostCookRecording.
  void snapshotIngredients;
  S.batches.push(newBatch);

  cleanCateringRefs(old.id, newBatch.id);

  const oldName = old.name;
  S.batches = S.batches.filter(d => d.id !== old.id);
  if (!S.deletedBatches) S.deletedBatches = [];
  S.deletedBatches.push(old.id);

  closeModal();
  rebuildPlanner();
  rerenderCurrentView();
  scheduleSave();
  toast(`Replaced ${oldName} with ${r.name}`);
}

// ── INVENTORY ────────────────────────────────────────────
// getAmsterdamNow() is defined in core.js (shared with isServicePast)

export function getInventoryState(loc: string) {
  const now = getAmsterdamNow();
  const h = now.getHours(), m = now.getMinutes();
  const mins = h * 60 + m;
  const lunchDeadline = 13 * 60 + 45; // 13:45
  const dinnerDeadline = 20 * 60 + 15; // 20:15
  const todayStr = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  const inv = S.inventoryDone[loc] || {};
  const lunchDone = inv.lunch === todayStr;
  const dinnerDone = inv.dinner === todayStr;

  // Determine current window
  if (!lunchDone && mins < lunchDeadline) {
    // Before lunch deadline, lunch not done
    return { window: 'lunch', label: 'Do inventory — 13:45', done: false, urgent: mins >= lunchDeadline - 60 };
  }
  if (!lunchDone && mins >= lunchDeadline && mins < dinnerDeadline) {
    // Past lunch deadline, lunch not done
    return { window: 'lunch', label: 'DO INVENTORY', done: false, urgent: true };
  }
  if (lunchDone && mins < dinnerDeadline) {
    // Lunch done, before dinner deadline
    const urgent = mins >= dinnerDeadline - 60;
    return { window: 'dinner', label: dinnerDone ? 'Inventory done' : 'Do inventory — 20:15', done: dinnerDone, urgent: !dinnerDone && urgent };
  }
  if (!dinnerDone && mins >= dinnerDeadline) {
    // Past dinner deadline, dinner not done
    return { window: 'dinner', label: 'DO INVENTORY', done: false, urgent: true };
  }
  // Both done
  return { window: 'done', label: 'Inventory done', done: true, urgent: false };
}

export function getInventoryButton(loc: string) {
  const st = getInventoryState(loc);
  if (st.done && st.window === 'done') {
    return `<button class="btn inv-btn inv-done" disabled>&#10003; Inventory done</button>`;
  }
  const cls = st.urgent ? 'inv-btn inv-urgent' : 'inv-btn';
  return `<button class="btn ${cls}" onclick="openInventory('${loc}')">${st.label}</button>`;
}

// ── INVENTORY MODAL (DAAN-CRITICAL) ─────────────────────────────────────────
//
// Two modes per the locked plan:
//   - LOCATION-SCOPED (default): cook at West sees ONLY West stock; cook at
//     Centraal sees ONLY Centraal stock. ONE row per (batch, storage) at the
//     cook's location. Multiple cookDates at the same (batch, loc, storage)
//     aggregate to one row; qty edits distribute FIFO (oldest cookDate
//     absorbs delta first). This is the safety guarantee — cook never
//     accidentally edits stock at the OTHER location.
//   - POWER: full inventory view across all locs + storages. One row per
//     literal InventoryEntry (no aggregation). For debugging / corrections.
//
// `_invMode` is module-local and ALWAYS resets to 'loc-scoped' on
// `openInventory()` per Q4. Toggle button in the modal header re-renders
// in place.

let _invMode: 'loc-scoped' | 'power' = 'loc-scoped';
// Loc the inventory modal was last rendered for — lets a live-sync patch
// refresh the open modal so its embedded row indices never go stale.
let _lastInventoryLoc = 'west';

export function openInventory(loc: string) {
  _invMode = 'loc-scoped';
  renderInventoryModal(loc);
}

export function setInvMode(loc: string, mode: string) {
  if (mode !== 'loc-scoped' && mode !== 'power') return;
  _invMode = mode;
  renderInventoryModal(loc);
}

/** Aggregated row in location-scoped view: one (batchId, storage) tuple at
 *  this loc may sum across multiple underlying InventoryEntry rows
 *  (different cookDates). FIFO order: entries sorted oldest cookDate first
 *  so the cook's qty delta lands on the oldest entry first, matching
 *  food-safety FIFO. */
interface LocScopedRow {
  batchId: string;
  batchName: string;
  batchType: string;
  storage: StorageType;
  qty: number;
  // Indices into the batch's inventory[] array, oldest cookDate first.
  entryIdxsByAge: number[];
  // Earliest cookDate among contributing entries (for stale check).
  oldestCookDate: string;
}

/** Build the location-scoped rows: one per (batch, storage) at `loc`. */
function buildLocScopedRows(loc: Location): LocScopedRow[] {
  const rows: LocScopedRow[] = [];
  for (const b of S.batches) {
    if (!isBatchCooked(b)) continue;
    // Group this batch's entries-at-this-loc by storage.
    const byStorage = new Map<StorageType, { entries: Array<{ entry: InventoryEntry; idx: number }>; qty: number }>();
    (b.inventory || []).forEach((e, idx) => {
      if (e.loc !== loc) return;
      if (e.qty <= 0) return;
      let g = byStorage.get(e.storage);
      if (!g) {
        g = { entries: [], qty: 0 };
        byStorage.set(e.storage, g);
      }
      g.entries.push({ entry: e, idx });
      g.qty += e.qty;
    });
    for (const [storage, g] of byStorage) {
      // FIFO: oldest cookDate first. cookDate is DD/MM/YYYY — sort via the
      // strToDate helper (returns null for unparseable; null sorts last).
      g.entries.sort((a, b) => {
        const da = strToDate(a.entry.cookDate);
        const db = strToDate(b.entry.cookDate);
        if (!da && !db) return 0;
        if (!da) return 1;
        if (!db) return -1;
        return da.getTime() - db.getTime();
      });
      const oldest = g.entries[0]?.entry.cookDate || '';
      rows.push({
        batchId: b.id,
        batchName: b.name,
        batchType: b.type,
        storage,
        qty: g.qty,
        entryIdxsByAge: g.entries.map(x => x.idx),
        oldestCookDate: oldest,
      });
    }
  }
  return rows;
}

function renderInventoryModal(loc: string) {
  _lastInventoryLoc = loc;
  const locLabel = locName(loc);
  const modeToggle = `<span class="modal-mode-toggle inv-modal-marker" style="display:inline-flex;gap:4px;margin-left:12px;font-size:12px;">
    <button class="btn btn-sm${_invMode === 'loc-scoped' ? ' btn-primary' : ''}" onclick="setInvMode('${loc}','loc-scoped')" title="Show only stock physically at ${locLabel}">${locLabel} only</button>
    <button class="btn btn-sm${_invMode === 'power' ? ' btn-primary' : ''}" onclick="setInvMode('${loc}','power')" title="Show full inventory across all locations">All inventory</button>
  </span>`;

  if (_invMode === 'loc-scoped') {
    renderLocScopedInventory(loc, locLabel, modeToggle);
  } else {
    renderPowerInventory(loc, locLabel, modeToggle);
  }
}

/** Re-render the Do-inventory modal if it is the modal currently on screen.
 *  Called after a live-sync patch so the modal's embedded row indices are
 *  rebuilt from fresh state instead of pointing at stale array positions. */
export function refreshInventoryModalIfOpen(): void {
  const root = document.getElementById('modal-root');
  // .inv-modal-marker sits on the mode-toggle, present in every inventory-modal
  // state (loc-scoped / power, populated / empty) — so an empty modal refreshes
  // too. Don't use .inv-list: it's absent from the empty state.
  if (root && root.querySelector('.inv-modal-marker')) {
    renderInventoryModal(_lastInventoryLoc);
  }
}

function renderLocScopedInventory(loc: string, locLabel: string, modeToggle: string) {
  const rows = buildLocScopedRows(loc as Location);

  if (rows.length === 0) {
    showModal(`<h3>Inventory — ${locLabel}${modeToggle}</h3>
      <div class="empty" style="margin:20px 0;">No cooked stock at ${locLabel}.</div>
      <div class="modal-actions">
        <button class="btn" onclick="S._inventoryLoc=null;closeModal()">Close</button>
      </div>`);
    const modal = document.querySelector('.modal') as HTMLElement | null;
    if (modal) modal.style.width = '560px';
    return;
  }

  const typeOrder: Record<string, number> = { 'Soup': 0, 'Main course': 1, 'Dessert': 2 };
  const fresh = rows.filter(r => r.storage !== 'Frozen').sort((a, b) =>
    (typeOrder[a.batchType] || 0) - (typeOrder[b.batchType] || 0) || a.batchName.localeCompare(b.batchName));
  const frozen = rows.filter(r => r.storage === 'Frozen').sort((a, b) =>
    (typeOrder[a.batchType] || 0) - (typeOrder[b.batchType] || 0) || a.batchName.localeCompare(b.batchName));

  const renderRow = (r: LocScopedRow) => {
    // Stale = oldest cookDate past shelf life for this storage. Reuses the
    // same per-storage limits as isStaleEntry in core.ts.
    const oldestEntry: InventoryEntry = { loc: loc as Location, storage: r.storage, qty: r.qty, cookDate: r.oldestCookDate };
    const stale = isStaleEntry(oldestEntry);
    const staleCls = stale ? 'stock-miss' : 'stock-ok';
    const staleNote = stale ? `<span class="${staleCls}" style="font-size:11px;">stale</span>` : '';
    // Entry-idx CSV for the FIFO distributor (oldest first).
    const idxCsv = r.entryIdxsByAge.join(',');
    return `<div class="inv-row" data-batch="${esc(r.batchId)}" data-storage="${r.storage}">
      <div class="inv-name">
        <span style="font-weight:500;">${esc(r.batchName)}</span>
        <span class="${storageBadgeClass(r.storage)}" style="cursor:pointer;" onclick="cycleInventoryStorageAt('${r.batchId}','${loc}','${r.storage}','${idxCsv}')" title="Click to change storage on this row's entries">${r.storage}</span>
        ${staleNote}
      </div>
      <div class="inv-controls">
        <label style="font-size:11px;color:var(--text2);">Stock here</label>
        <input type="number" class="inv-stock-input" value="${r.qty.toFixed(1)}" step="0.5" min="0" onchange="updateLocScopedQty('${r.batchId}','${loc}','${r.storage}','${idxCsv}',this.value)" />
        <span style="display:inline-block;width:1px;height:24px;background:var(--border);margin:0 6px;vertical-align:middle;"></span>
        <button class="btn btn-sm inv-served-btn" style="background:var(--red);color:#fff;border-color:var(--red);" onclick="openServedFromInventory('${r.batchId}','${loc}')">Served</button>
      </div>
    </div>`;
  };

  let html = `<h3>Inventory — ${locLabel}${modeToggle}</h3>`;
  html += `<div style="font-size:12px;color:var(--text2);margin-bottom:12px;">Editing stock at ${locLabel} only. Multiple cookDates per (batch, storage) aggregate to one row; FIFO — oldest absorbs the delta first.</div>`;
  html += `<div class="inv-list">`;

  let lastType = '';
  fresh.forEach(r => {
    if (r.batchType !== lastType) {
      lastType = r.batchType;
      html += `<div style="font-size:11px;font-weight:600;text-transform:uppercase;color:var(--text2);padding:8px 0 4px;border-bottom:1px solid var(--border);">${r.batchType}</div>`;
    }
    html += renderRow(r);
  });

  if (frozen.length) {
    html += `<div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--blue);padding:12px 0 4px;border-bottom:2px solid var(--blue);margin-top:8px;">❄️ Frozen</div>`;
    lastType = '';
    frozen.forEach(r => {
      if (r.batchType !== lastType) {
        lastType = r.batchType;
        html += `<div style="font-size:10px;font-weight:600;text-transform:uppercase;color:var(--text3);padding:6px 0 2px;">${r.batchType}</div>`;
      }
      html += renderRow(r);
    });
  }

  html += `</div>`;
  html += `<div class="modal-actions">
    <button class="btn" onclick="S._inventoryLoc=null;closeModal()">Cancel</button>
    <button class="btn btn-primary" onclick="finishInventory('${loc}')">Finish inventory</button>
  </div>`;

  showModal(html);
  const modal = document.querySelector('.modal') as HTMLElement | null;
  if (modal) modal.style.width = '560px';
}

function renderPowerInventory(loc: string, locLabel: string, modeToggle: string) {
  // Power view: ALL inventory across all locs + storages. One row per literal
  // InventoryEntry (no aggregation by cookDate). Edits hit that exact entry.
  const cooked = S.batches.filter(d => isBatchCooked(d));
  if (cooked.length === 0) {
    showModal(`<h3>Inventory — all locations${modeToggle}</h3>
      <div class="empty" style="margin:20px 0;">No cooked stock.</div>
      <div class="modal-actions">
        <button class="btn" onclick="S._inventoryLoc=null;closeModal()">Close</button>
      </div>`);
    const modal = document.querySelector('.modal') as HTMLElement | null;
    if (modal) modal.style.width = '720px';
    return;
  }
  const typeOrder: Record<string, number> = { 'Soup': 0, 'Main course': 1, 'Dessert': 2 };
  const sorted = [...cooked].sort((a, b) =>
    (typeOrder[a.type] || 0) - (typeOrder[b.type] || 0) || a.name.localeCompare(b.name));

  let html = `<h3>Inventory — all locations${modeToggle}</h3>`;
  html += `<div style="font-size:12px;color:var(--text2);margin-bottom:12px;">Power mode — per-entry editing across all locations. Use this for cross-loc corrections or to spot mixed cookDates. Default mode (${locLabel} only) is safer for daily inventory rounds.</div>`;
  html += `<div class="inv-list">`;

  for (const b of sorted) {
    const inv = (b.inventory || []);
    if (inv.length === 0) continue;
    html += `<div class="inv-batch-card" style="border:1px solid var(--border);border-radius:var(--radius);padding:8px;margin-bottom:8px;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
        <span style="font-weight:500;">${esc(b.name)}</span>
        <span class="${typeBadgeClass(b.type)}">${b.type}</span>
        <button class="btn btn-sm inv-served-btn" style="margin-left:auto;background:var(--red);color:#fff;border-color:var(--red);" onclick="openServedFromInventory('${b.id}','${loc}')">Served</button>
      </div>
      <table style="width:100%;font-size:12px;border-collapse:collapse;">
        <thead><tr style="text-align:left;color:var(--text2);">
          <th style="padding:2px 4px;">Loc</th><th style="padding:2px 4px;">Storage</th><th style="padding:2px 4px;">Qty (L)</th><th style="padding:2px 4px;">Cook date</th>
        </tr></thead>
        <tbody>
          ${inv.map((e, idx) => `<tr>
            <td style="padding:2px 4px;">${locName(e.loc)}</td>
            <td style="padding:2px 4px;"><span class="${storageBadgeClass(e.storage)}" style="cursor:pointer;font-size:10px;" onclick="cycleEntryStorageAt('${b.id}',${idx},'${loc}')">${e.storage}</span></td>
            <td style="padding:2px 4px;"><input type="number" value="${e.qty.toFixed(1)}" step="0.5" min="0" style="width:80px;" onchange="updatePowerEntryQty('${b.id}',${idx},this.value,'${loc}')" /></td>
            <td style="padding:2px 4px;font-family:monospace;font-size:11px;">${esc(e.cookDate)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
  }

  html += `</div>`;
  html += `<div class="modal-actions">
    <button class="btn" onclick="S._inventoryLoc=null;closeModal()">Cancel</button>
    <button class="btn btn-primary" onclick="finishInventory('${loc}')">Finish inventory</button>
  </div>`;

  showModal(html);
  const modal = document.querySelector('.modal') as HTMLElement | null;
  if (modal) modal.style.width = '720px';
}

/** Apply the cook's new total to an aggregated (batch, loc, storage) row.
 *  FIFO distribution: delta is added to / subtracted from the OLDEST
 *  cookDate entry first. If the delta exceeds an entry's qty, it spills
 *  into the next-oldest entry. Mirrors food-safety FIFO ("oldest food used
 *  first"). Negative qty is clamped to 0 — cook can't go negative. */
export function updateLocScopedQty(id: string, loc: string, storage: string, idxCsv: string, valueStr: string) {
  const d = S.batches.find(x => x.id === id);
  if (!d) return;
  const newTotal = parseFloat(valueStr);
  if (isNaN(newTotal) || newTotal < 0) {
    toastError('Enter a non-negative number');
    renderInventoryModal(loc);
    return;
  }
  if (Math.round(newTotal * 10) / 10 === 0) {
    toastError('To mark a batch as finished, use the "Served" button — you can\'t set the count to 0 here.');
    renderInventoryModal(loc);
    return;
  }
  const idxs = idxCsv.split(',').map(s => parseInt(s, 10)).filter(n => !isNaN(n));
  if (idxs.length === 0) return;
  const inv = d.inventory || [];
  const currentTotal = idxs.reduce((s, i) => s + (inv[i]?.qty || 0), 0);
  let delta = newTotal - currentTotal;
  if (delta < 0) {
    // Decreasing — drain from OLDEST first (FIFO).
    let remaining = -delta;
    for (const i of idxs) {
      if (remaining <= 0) break;
      const e = inv[i];
      if (!e) continue;
      const take = Math.min(remaining, e.qty);
      e.qty = Math.round((e.qty - take) * 10) / 10;
      remaining -= take;
    }
  } else if (delta > 0) {
    // Increasing — add to OLDEST (so older food is what's "topped up").
    // If only one entry exists at this (batch, loc, storage), this just
    // bumps it. If multiple, oldest absorbs. Edge case: if cook entered
    // a positive total but there are zero existing entries (idxs covers
    // ZERO qty rows — should be impossible since buildLocScopedRows
    // filters qty > 0, but defensive), add to the first index.
    inv[idxs[0]].qty = Math.round((inv[idxs[0]].qty + delta) * 10) / 10;
  }
  scheduleSave();
  // Re-render so the row's badge / total / stale-flag refresh.
  renderInventoryModal(loc);
}

/** Cycle storage state on every underlying entry of an aggregated row.
 *  Mirrors the backend /transfer cookDate-reset rules: Gastro↔Frozen
 *  resets each entry's cookDate to today; other transitions preserve. */
export function cycleInventoryStorageAt(id: string, loc: string, fromStorage: string, idxCsv: string) {
  const d = S.batches.find(x => x.id === id);
  if (!d) return;
  const idxs = idxCsv.split(',').map(s => parseInt(s, 10)).filter(n => !isNaN(n));
  const cur = STORAGE.indexOf(fromStorage as StorageType);
  const next = STORAGE[(cur + 1) % STORAGE.length];
  const inv = d.inventory || [];
  const today = dateToStr(getToday());
  const resetsCookDate =
    (fromStorage === 'Gastro' && next === 'Frozen') ||
    (fromStorage === 'Frozen' && next === 'Gastro');
  for (const i of idxs) {
    const e = inv[i];
    if (!e) continue;
    e.storage = next;
    if (resetsCookDate) e.cookDate = today;
  }
  scheduleSave();
  renderInventoryModal(loc);
}

/** Power view — cycle storage on a single InventoryEntry by index. Same
 *  cookDate-reset rules as the aggregated path. */
export function cycleEntryStorageAt(id: string, idx: number, loc: string) {
  const d = S.batches.find(x => x.id === id);
  if (!d || !d.inventory || idx < 0 || idx >= d.inventory.length) return;
  const e = d.inventory[idx];
  const cur = STORAGE.indexOf(e.storage);
  const next = STORAGE[(cur + 1) % STORAGE.length];
  const today = dateToStr(getToday());
  const resetsCookDate =
    (e.storage === 'Gastro' && next === 'Frozen') ||
    (e.storage === 'Frozen' && next === 'Gastro');
  e.storage = next;
  if (resetsCookDate) e.cookDate = today;
  scheduleSave();
  renderInventoryModal(loc);
}

/** Power view — edit one entry's qty by absolute new value. */
export function updatePowerEntryQty(id: string, idx: number, valueStr: string, loc: string) {
  const d = S.batches.find(x => x.id === id);
  if (!d || !d.inventory || idx < 0 || idx >= d.inventory.length) return;
  const v = parseFloat(valueStr);
  if (isNaN(v) || v < 0) {
    toastError('Enter a non-negative number');
    renderInventoryModal(loc);
    return;
  }
  if (Math.round(v * 10) / 10 === 0) {
    toastError('To mark a batch as finished, use the "Served" button — you can\'t set the count to 0 here.');
    renderInventoryModal(loc);
    return;
  }
  d.inventory[idx].qty = Math.round(v * 10) / 10;
  scheduleSave();
  // Don't re-render — the input is what the cook is editing; rerendering
  // resets focus. Power-mode edits are typed-into-input → blur → save.
  // Storage badge / stale-flag updates wait for next open.
}

// Legacy thin wrappers for older entry points. Both route through the new
// aggregated/Power handlers. Kept until external callers (orders.ts, etc.)
// migrate in Checkpoint 5.
export function updateInventoryStock(id: string, value: string) {
  // Legacy path: no entry idx info — fall back to applying the value to the
  // first non-empty inventory entry. Cooks shouldn't hit this in the new
  // modal; external callers will.
  const d = S.batches.find(x => x.id === id);
  if (!d) return;
  const inv = d.inventory || [];
  const first = inv.find(e => e.qty > 0) || inv[0];
  if (first) {
    const v = parseFloat(value);
    if (!isNaN(v) && v >= 0) first.qty = Math.round(v * 10) / 10;
  }
  scheduleSave();
}

export function cycleInventoryStorage(id: string, loc: string) {
  // Legacy path: cycle storage on the first entry at this loc (or first
  // entry overall if none at loc). Mirrors the cookDate-reset rules.
  const d = S.batches.find(x => x.id === id);
  if (!d) return;
  const inv = d.inventory || [];
  const target = inv.find(e => e.loc === loc) || inv[0];
  if (target) {
    const cur = STORAGE.indexOf(target.storage);
    const next = STORAGE[(cur + 1) % STORAGE.length];
    const today = dateToStr(getToday());
    const resetsCookDate =
      (target.storage === 'Gastro' && next === 'Frozen') ||
      (target.storage === 'Frozen' && next === 'Gastro');
    target.storage = next;
    if (resetsCookDate) target.cookDate = today;
  }
  scheduleSave();
  renderInventoryModal(loc);
}

export function openServedFromInventory(id: string, loc: string) {
  // Store that we came from inventory so we can reopen it after the dialog
  // closes. Use the loc-scoped dialog path — only this kitchen's stock is
  // consumed, other locs and pending shipments stay (audit BL1: prevents
  // silent cross-loc data loss when cook marks a single-loc service done).
  S._inventoryLoc = loc;
  openServedDialogForLoc(id, loc as Location);
}

export function finishInventory(loc: string) {
  const now = getAmsterdamNow();
  const todayStr = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  const st = getInventoryState(loc);
  if (!S.inventoryDone[loc]) S.inventoryDone[loc] = { lunch: null, dinner: null };
  S.inventoryDone[loc][st.window] = todayStr;
  // Update local freshness counter immediately so the dashboard chip updates
  // without waiting for the server round-trip.
  if (st.window === 'lunch' || st.window === 'dinner') {
    if (!S.inventoryCompletions[loc as Location]) {
      S.inventoryCompletions[loc as Location] = { lunch: null, dinner: null };
    }
    S.inventoryCompletions[loc as Location][st.window] = new Date().toISOString();
  }
  S._inventoryLoc = null;
  closeModal();
  rebuildPlanner();
  rerenderCurrentView();
  scheduleSave();
  // Persist freshness server-side so other devices see "last inventory N min
  // ago" too. Fire-and-forget; the local stamp above keeps the UI snappy.
  if (st.window === 'lunch' || st.window === 'dinner') {
    apiPost('/api/inventory-completions', { loc, window: st.window }).catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      console.warn('Could not persist inventory completion:', msg);
    });
  }
  toast('Inventory complete!');
}


// Self-register so navigate.ts can dispatch without importing every screen.
registerRenderer('planner', renderWeekPlan);
