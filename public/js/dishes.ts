import { S, DAYS, MEALS, STORAGE, LOCATIONS, ALLERGENS, INGREDIENT_TYPES, INGREDIENT_CATEGORIES, ACCOMPANIMENTS, getStorageColor } from './state';
import { newId, scheduleSave, toast, toastError, apiPost, apiGet } from './utils';
import { pushUndo } from './undo';
import { rebuildPlanner, isBatchCooked, locationBadge, getAmsterdamNow, dateToDayName, dateToIso, isServicePast, calcRequired, calcRequiredBreakdown, calcTotalGuests, calcIngredientsFromRecipe, diffStr, storageBadge, storageBadgeClass, cycleStorage, logisticsBadge, logisticsBadgeClass, logisticsShort, cycleLocation, typeBadge, typeBadgeClass, TYPES, cycleType, chipClass, getToday, dateToStr, strToDate, openServedDialog, getGuests, toggleOrder, getFamilyMembers, getFamilyStock, getRootId } from './core';
import { showModal, closeModal, esc } from './modal';
import { rerenderCurrentView } from './navigate';
import { trackEvent } from './telemetry';
import { addDishFromRecipe } from './recipes';
import { openPostCookRecording, openBatchRecipe } from './recipe-editor';
import { batchDragStart, batchDragEnd, startAssignMode, openReplaceBatch } from './planner';
import type { Batch, CateringDish, DishType, Location, StorageType, Service, RecipeIngredient } from '@shared/types';
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

// ── DISH LIST ─────────────────────────────────────────────
export let dishSort = { col: 'default', dir: 'asc' };

export function renderDishesOverview() {
  const f = S.filters;
  const filtered = S.batches.filter(d => {
    if (f.loc !== 'all') {
      const ml = d.location === f.loc;
      const sl = (d.services || []).some(s => s.loc === f.loc);
      if (!ml && !sl) return false;
    }
    if (f.storage !== 'all' && d.storage !== f.storage) return false;
    if (f.inTransit !== 'all') {
      const wantTransit = f.inTransit === 'true';
      if (!!d.inTransit !== wantTransit) return false;
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
      case 'stock': va = a.stock || 0; vb = b.stock || 0; break;
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
    <div class="filter-sep"></div>
    <div style="display:flex;gap:4px;flex-wrap:wrap;">
      <button class="fc ${f.inTransit === 'all' ? 'on' : ''}" onclick="setFilter('inTransit','all')">All</button>
      <button class="fc ${f.inTransit === 'false' ? 'on' : ''}" onclick="setFilter('inTransit','false')">At location</button>
      <button class="fc ${f.inTransit === 'true' ? 'on' : ''}" onclick="setFilter('inTransit','true')">In transit</button>
    </div>
  </div>
  <div style="display:flex;gap:12px;font-size:10px;color:var(--text3);margin-bottom:8px;padding:4px 0;">
    <span><span style="display:inline-block;width:10px;height:10px;background:#BA7517;border-radius:2px;vertical-align:middle;margin-right:3px;"></span>At West</span>
    <span><span style="display:inline-block;width:10px;height:10px;background:#0F6E56;border-radius:2px;vertical-align:middle;margin-right:3px;"></span>At Centraal</span>
    <span><span style="display:inline-block;width:10px;height:10px;background:#97C459;border-radius:2px;vertical-align:middle;margin-right:3px;"></span>Transport → Centraal</span>
    <span><span style="display:inline-block;width:10px;height:10px;background:#EF9F27;border-radius:2px;vertical-align:middle;margin-right:3px;"></span>Transport → West</span>
  </div>
  <div id="split-bar-area"></div>
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
  renderSplitBar();
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
  const loc = d.location || 'west';
  if (d.inTransit) return loc === 'centraal' ? 'log-twc' : 'log-tww';
  return loc === 'centraal' ? 'log-centraal' : 'log-west';
}

export function renderDishGroups(dishes: Batch[]) {
  const toCook = dishes.filter(d => !isBatchCooked(d) && d.storage !== 'Frozen');
  const cooked = dishes.filter(d => isBatchCooked(d) && d.storage !== 'Frozen');
  const frozen = dishes.filter(d => d.storage === 'Frozen');

  let html = '';

  if (toCook.length) {
    html += `<div class="dish-section-hdr"><div class="dish-section-dot" style="background:var(--amber);"></div>To cook <span class="dish-section-count">(${toCook.length})</span></div>`;
    html += renderFamilyGrouped(toCook);
  }

  if (cooked.length) {
    html += `<div class="dish-section-hdr"><div class="dish-section-dot" style="background:var(--green);"></div>Cooked <span class="dish-section-count">(${cooked.length})</span></div>`;
    html += renderFamilyGrouped(cooked);
  }

  if (frozen.length) {
    html += `<div class="dish-section-hdr"><div class="dish-section-dot" style="background:var(--blue);"></div>Frozen <span class="dish-section-count">(${frozen.length})</span></div>`;
    html += renderFamilyGrouped(frozen);
  }

  return html;
}

/**
 * Renders a "merged" tile representing 2+ family members at the same physical
 * location. Cook sees ONE row with the combined stock — but expanding the
 * tile reveals the individual physical batches underneath (so per-batch
 * actions like delete/edit still work).
 *
 * Stock and surplus are summed. The largest member acts as the "primary"
 * batch for the row's chrome (name, type, status). The expanded view shows
 * the breakdown.
 */
function renderMergedSameLocationTile(members: Batch[], tileOpts?: BatchTileOptions | boolean): string {
  // Pick the largest-stock member as the "primary" — its name/type/status
  // drive the visible row chrome. Ties broken by id for determinism.
  const sorted = [...members].sort((a, b) => (b.stock || 0) - (a.stock || 0) || a.id.localeCompare(b.id));
  const primary = sorted[0];
  const totalStock = members.reduce((sum, m) => sum + (m.stock || 0), 0);
  const totalReq = members.reduce((sum, m) => sum + calcRequired(m), 0);
  const diff = Math.round((totalStock - totalReq) * 10) / 10;
  const diffStr = (diff >= 0 ? '+' : '') + diff + 'L';
  const diffCls = diff < 0 ? 'stock-miss' : diff < 5 ? 'stock-low' : 'stock-ok';
  // Note: callers (renderFamilyGrouped) only pass ARRIVED members here.
  // In-transit batches are rendered separately so they don't get folded
  // into the merged total. We list cookDates in the breakdown to help the
  // cook spot mixed-cookDate merges (rare but possible).
  const breakdown = members.map(m =>
    `<li>${esc(m.name)} — ${m.stock || 0}L, cooked ${m.cookDate || '—'}</li>`
  ).join('');
  const expandedKey = 'merged-' + members.map(m => m.id).join('-');
  const isExpanded = S.expandedBatches.has(expandedKey);
  const locCls = primary.location === 'centraal' ? 'loc-centraal' : 'loc-west';
  return `<div class="batch-tile batch-tile-merged ${locCls}${isExpanded ? ' expanded' : ''}" data-merged-ids="${members.map(m => m.id).join(',')}">
    <div class="batch-tile-compact" onclick="toggleBatchExpand('${expandedKey}')">
      <div class="sel-box"></div>
      <span class="batch-type-dot batch-type-${(primary.type||'Soup').toLowerCase().replace(/ /g,'-')}"></span>
      <span class="batch-tile-name">${esc(primary.name)} <span class="batch-merged-count">(${members.length} merged)</span></span>
      <span class="batch-status status-cooked">Combined</span>
      <span class="batch-tile-stock ${diffCls}">${totalStock.toFixed(1)}L <small>${diffStr}</small></span>
      <span class="batch-tile-logistics ${logisticsBadgeClass(primary)}" style="font-size:10px;">${logisticsShort(primary)}</span>
      <span class="batch-expand-arrow">${isExpanded ? '▾' : '▸'}</span>
    </div>
    ${isExpanded ? `<div class="batch-merged-detail">
      <div class="batch-merged-detail-hdr">${members.length} physical batches at ${primary.location === 'centraal' ? 'Centraal' : 'West'}:</div>
      <ul class="batch-merged-list">${breakdown}</ul>
      <div class="batch-merged-individual">
        ${members.map(m => renderBatchTile(m, tileOpts)).join('')}
      </div>
    </div>` : ''}
  </div>`;
}

/**
 * Wraps batches that belong to the same split family in a `.batch-family-card`
 * container (with a header showing the family's combined stock), so the cook
 * sees parent + split as one logical card. Single-member families render bare.
 *
 * Same-location members (e.g. a freshly-arrived in-transit batch landing
 * alongside an existing batch at Centraal) get rendered together in one
 * sub-section so they read as one location's portion of the family.
 *
 * `tileOpts` is forwarded to renderBatchTile so the planner pools can pass
 * `showAssign: true` for the in-pool tiles.
 */
export function renderFamilyGrouped(dishes: Batch[], tileOpts?: BatchTileOptions | boolean): string {
  // Bucket by family root, preserving the input order.
  const families: { rootId: string; members: Batch[] }[] = [];
  const indexByRoot = new Map<string, number>();
  for (const d of dishes) {
    const rootId = getRootId(d, S.batches);
    let idx = indexByRoot.get(rootId);
    if (idx === undefined) {
      idx = families.length;
      indexByRoot.set(rootId, idx);
      families.push({ rootId, members: [] });
    }
    families[idx].members.push(d);
  }
  let html = '';
  for (const { members } of families) {
    if (members.length === 1) {
      html += renderBatchTile(members[0], tileOpts);
      continue;
    }
    // Order: parent first, then splits.
    const sorted = [...members].sort((a, b) => {
      if (!a.parentId && b.parentId) return -1;
      if (a.parentId && !b.parentId) return 1;
      return a.id.localeCompare(b.id);
    });
    const familyName = (sorted.find(m => !m.parentId) || sorted[0]).name.replace(/\s*\(split\)\s*$/i, '').trim();
    // Group members by physical location so same-location batches (e.g. an
    // in-transit batch that just arrived alongside an existing one) appear
    // folded into one section, while still letting the cook see them per-row.
    // In-transit members render in their CURRENT location bucket since
    // physically that's still where they are.
    const byLoc: Record<string, Batch[]> = { west: [], centraal: [] };
    for (const m of sorted) {
      const key = m.location === 'centraal' ? 'centraal' : 'west';
      byLoc[key].push(m);
    }
    // Family total splits arrived (physically here) from in-transit (still
    // moving, will land soon). Cook sees both numbers without ambiguity.
    const arrivedStock = (loc: 'west' | 'centraal') =>
      byLoc[loc].filter(m => !m.inTransit).reduce((s, m) => s + (m.stock || 0), 0);
    const incomingStock = sorted.filter(m => m.inTransit).reduce((s, m) => s + (m.stock || 0), 0);
    const arrivedTotal = arrivedStock('west') + arrivedStock('centraal');
    const totalLine = incomingStock > 0
      ? `${arrivedTotal.toFixed(1)}L here + ${incomingStock.toFixed(1)}L in transit`
      : `${arrivedTotal.toFixed(1)}L total`;
    html += `<div class="batch-family-card">
      <div class="batch-family-header">
        <span class="batch-family-icon">⛓</span>
        <span class="batch-family-title">${esc(familyName)} family</span>
        <span class="batch-family-total">${totalLine}</span>
        <span class="batch-family-breakdown">${arrivedStock('west')}L @W &middot; ${arrivedStock('centraal')}L @C</span>
      </div>`;
    for (const loc of ['west', 'centraal'] as const) {
      const locMembers = byLoc[loc];
      if (locMembers.length === 0) continue;
      const locLabel = loc === 'centraal' ? 'Centraal' : 'West';
      // Split each location bucket into ARRIVED (inTransit=false) vs INCOMING
      // (inTransit=true). The merged display sums ONLY arrived stock — an
      // in-transit batch isn't physically here yet, so it shows below the
      // merged tile as a separate "incoming" line. Once the cook marks it
      // arrived, it folds into the merged total automatically.
      const arrived = locMembers.filter(m => !m.inTransit);
      const incoming = locMembers.filter(m => m.inTransit);
      const incomingL = incoming.reduce((s, m) => s + (m.stock || 0), 0);
      const incomingNote = incoming.length > 0
        ? ` <span class="batch-family-loc-transit">· +${incomingL.toFixed(1)}L in transit</span>`
        : '';
      html += `<div class="batch-family-loc">
        <div class="batch-family-loc-hdr">At ${locLabel}${incomingNote}</div>
        <div class="batch-family-members">`;
      // SAME-LOCATION MERGE for arrived batches.
      if (arrived.length === 1) {
        html += renderBatchTile(arrived[0], tileOpts);
      } else if (arrived.length > 1) {
        html += renderMergedSameLocationTile(arrived, tileOpts);
      }
      // In-transit batches render separately, NOT merged into the arrived
      // total (they're not physically here yet). Cook sees them as pending
      // arrivals.
      for (const m of incoming) html += renderBatchTile(m, tileOpts);
      html += `</div></div>`;
    }
    html += `</div>`;
  }
  return html;
}

// NOTE: This was overwritten in original JS by the 2-arg version below.
// Renamed to avoid duplicate export. This is dead code.
export function renderBatchTileOverview(d: Batch) {
  const req = calcRequired(d);
  const { diff, str, cls } = diffStr(d);
  const allAg = [...(d.allergens || []), ...(d.extraAllergens || [])];
  const svcLbls = (d.services || []).map(s => {
    const ml = s.meal === 'lunch' ? 'L' : 'D';
    const lc = s.loc === 'west' ? 'SW' : 'SC';
    return `<strong>${dateToDayName(s.date)}</strong> ${ml} ${lc}`;
  }).join(' · ');
  const isSel = S.selected.has(d.id);
  const isFrozen = d.storage === 'Frozen';
  const cookHtml = getCookCellHtml(d);
  const isStale = isDishStale(d);
  const logClass = logisticsRowClass(d);
  return `<div class="dish-row ${logClass}${d.parentId ? ' split-child' : ''}${isSel ? ' selected' : ''}${isStale ? ' stale-row' : ''}${isFrozen ? ' frozen-row' : ''}">
    <div class="sel-box${isSel ? ' checked' : ''}" onclick="toggleSelect('${d.id}')"></div>
    <div>
      <input class="inline-edit inline-edit-name" value="${esc(d.name)}" onchange="inlineEdit('${d.id}','name',this.value)" onclick="event.stopPropagation();this.select()" />
      <div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;margin-top:2px;padding-left:6px;">
        <span class="${typeBadgeClass(d.type)}" style="cursor:pointer;" onclick="event.stopPropagation();cycleType('${d.id}')" title="Click to change">${d.type}</span>
        <span class="${storageBadgeClass(d.storage || 'Gastro')}" style="cursor:pointer;" onclick="event.stopPropagation();cycleStorage('${d.id}')" title="Click to change">${d.storage || 'Gastro'}</span>
        ${d.recipeSheetId ? `<a href="https://docs.google.com/spreadsheets/d/${esc(d.recipeSheetId)}/edit" target="_blank" rel="noopener" onclick="event.stopPropagation()" class="recipe-btn">Recipe &#8599;</a>` : ''}
        <div class="allergen-inline" id="ag-inline-${d.id}" style="display:inline-flex;">
          ${allAg.map(a => `<span class="allergen-pill" onclick="event.stopPropagation();inlineRemoveAllergen('${d.id}','${esc(a)}')" title="Click to remove">${esc(a)}</span>`).join('')}
          <button class="allergen-add-btn" onclick="event.stopPropagation();inlineAddAllergenStart('${d.id}',event)" title="Add allergen">+</button>
        </div>
        ${svcLbls ? `<span style="font-size:12px;color:var(--text);">${svcLbls}</span>` : '<span style="font-size:12px;font-weight:600;color:var(--red);">no day assigned</span>'}
      </div>
    </div>
    <div class="col-cook">${cookHtml}</div>
    <div class="col-stock"><input class="inline-edit inline-edit-stock" type="number" value="${d.stock || 0}" step="0.5" min="0" onchange="inlineEdit('${d.id}','stock',this.value)" onclick="event.stopPropagation();this.select()" /></div>
    <div class="col-diff ${cls}" title="${calcRequiredBreakdown(d).join('&#10;') || 'No services assigned'}">${str}</div>
    <div class="col-logistics">
      <span class="${logisticsBadgeClass(d)}" style="cursor:pointer;" onclick="event.stopPropagation();cycleLocation('${d.id}')" title="Click to change">${logisticsShort(d)}</span>
    </div>
    <div><button class="order-toggle-btn${d.orderFor ? ' on' : ''}" onclick="event.stopPropagation();toggleOrder('${d.id}')">${d.orderFor ? 'Order' : '—'}</button></div>
    <div><button class="served-btn" onclick="event.stopPropagation();openServedDialog('${d.id}')">Served</button></div>
    <div class="m-stock-row">
      <label style="font-size:12px;color:var(--text2);">Stock</label>
      <input class="m-stock-input" type="number" value="${d.stock || 0}" step="0.5" min="0" onchange="inlineEdit('${d.id}','stock',this.value)" onclick="event.stopPropagation();this.select()" />
      <span style="font-size:12px;color:var(--text2);">L</span>
      <span class="${cls}" style="font-size:12px;" title="${calcRequiredBreakdown(d).join('&#10;') || 'No services assigned'}">${str}</span>
      <span class="${logisticsBadgeClass(d)}" style="cursor:pointer;font-size:10px;" onclick="event.stopPropagation();cycleLocation('${d.id}')">${logisticsShort(d)}</span>
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
  showAssign?: boolean;
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

export function renderBatchTile(d: Batch, showAssignOrOpts?: boolean | BatchTileOptions) {
  const opts: BatchTileOptions = typeof showAssignOrOpts === 'boolean'
    ? { showAssign: showAssignOrOpts }
    : (showAssignOrOpts || {});
  const showActions = opts.showActions !== false;
  const showRecipe = opts.showRecipe !== false;

  const { str, cls } = diffStr(d);
  const isExpanded = !opts.compact && S.expandedBatches.has(d.id);
  const isSel = S.selected.has(d.id);
  const isStale = isDishStale(d);
  const isAssigning = S.assigningBatchId === d.id;
  const locCls = d.location === 'centraal' ? 'loc-centraal' : 'loc-west';
  const transitCls = d.inTransit ? ' in-transit' : '';
  const frozenCls = d.storage === 'Frozen' ? ' frozen-row' : '';
  const staleCls = isStale ? ' stale-row' : '';
  const selCls = isSel ? ' selected' : '';
  const splitCls = d.parentId ? ' split-child' : '';
  const assignCls = isAssigning ? ' assigning' : '';
  const expandCls = isExpanded ? ' expanded' : '';

  // "Too big" badge: this batch's projected demand exceeds the biggest pot in
  // the kitchen, meaning the cook can't make it in a single pot. Surfaced
  // here on the tile (not as a Fix My Menu modal action) so it's visible in
  // the regular planner view too.
  const biggestPot = S.kitchenEquipment && S.kitchenEquipment.pots.length > 0
    ? Math.max(...S.kitchenEquipment.pots) : Infinity;
  const projected = calcRequired(d);
  const tooBig = projected > biggestPot;
  const tooBigBadge = tooBig
    ? `<span class="batch-too-big-badge" title="Needs ${projected.toFixed(1)}L but biggest pot is ${biggestPot}L — cook in 2 pots">⚠️ Too big</span>`
    : '';

  // Family-aware role marker: family relationship is conveyed by visual
  // grouping in the dish list (.batch-family-card wraps the whole family),
  // so individual tiles only need a small role label — "parent" or "split".
  // Removed the per-tile stock-at-other-loc badge to declutter.
  const family = getFamilyMembers(d, S.batches);
  const isFamilyMember = family.length > 1;
  const isParent = !d.parentId;
  const familyRoleBadge = isFamilyMember
    ? `<span class="batch-family-role ${isParent ? 'role-parent' : 'role-split'}" title="${isParent ? 'Parent batch — original cook. Split children appear grouped with this tile.' : `Split — shipped from the parent at ${d.location === 'west' ? 'Centraal' : 'West'}. Grouped with the parent in the dish list.`}">${isParent ? 'Parent' : 'Split'}</span>`
    : '';

  // Compact row
  let html = `<div class="batch-tile ${locCls}${transitCls}${frozenCls}${staleCls}${selCls}${splitCls}${assignCls}${expandCls}" data-testid="batch-tile" data-id="${d.id}" draggable="true" ondragstart="batchDragStart(event,'${d.id}')" ondragend="batchDragEnd(event)">
    <div class="batch-tile-compact" onclick="toggleBatchExpand('${d.id}')">
      <div class="sel-box${isSel ? ' checked' : ''}" onclick="event.stopPropagation();toggleSelect('${d.id}')"></div>
      <span class="batch-type-dot batch-type-${(d.type||'Soup').toLowerCase().replace(/ /g,'-')}"></span>
      <span class="batch-tile-name">${esc(d.name)}</span>
      <span class="batch-status ${isBatchCooked(d) ? (isDishStale(d) ? 'status-stale' : 'status-cooked') : 'status-tocook'}">${isBatchCooked(d) ? (isDishStale(d) ? 'Stale' : 'Cooked') : 'To cook'}</span>
      <span class="batch-tile-cook">${batchCookLabel(d)}</span>
      <span class="batch-tile-stock ${cls}">${d.stock || 0}L <small>${str}</small></span>
      ${familyRoleBadge}
      ${tooBigBadge}
      <span class="batch-tile-logistics ${logisticsBadgeClass(d)}" style="font-size:10px;">${logisticsShort(d)}</span>
      ${d.inTransit ? `<span class="batch-transit-badge" title="Currently being transported to ${d.location === 'centraal' ? 'Centraal' : 'West'} — ${d.stock || 0}L on the move.">→ ${d.stock || 0}L in transit</span>` : ''}
      ${opts.showAssign && !S.assigningBatchId ? `<button class="batch-assign-btn" onclick="event.stopPropagation();startAssignMode('${d.id}')">Assign</button>` : ''}
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
        const g = getGuests(svc.loc, svc.date, svc.meal);
        const k = `${svc.loc}-${svc.date}-${svc.meal}`;
        const peers = (S.planner[k] || []).filter((p: Batch) => p.type === d.type);
        const count = Math.max(peers.length, 1);
        const l = Math.round((g / count) * ((d.serving || 280) / 1000) * 10) / 10;
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

    // Recipe row
    let recipeHtml = '';
    if (showRecipe) {
      if (d.recipeId) {
        recipeHtml = `<div class="bx-row bx-recipe">
          <button class="bx-recipe-btn bx-recipe-app" onclick="event.stopPropagation();openBatchRecipe('${d.id}')">${hasUnresolvedFlexible(d) ? '&#x26A0; Resolve &amp; edit' : 'Open batch recipe'}</button>
          ${d.recipeSheetId ? `<a class="bx-recipe-link-secondary" href="https://docs.google.com/spreadsheets/d/${esc(d.recipeSheetId)}/edit" target="_blank" rel="noopener" onclick="event.stopPropagation()">Sheets recipe &#8599;</a>` : ''}
          <span class="bx-serving">${d.serving || 280} ml/guest</span>
        </div>`;
      } else if (d.recipeSheetId) {
        recipeHtml = `<div class="bx-row bx-recipe">
          <a class="bx-recipe-btn" href="https://docs.google.com/spreadsheets/d/${esc(d.recipeSheetId)}/edit" target="_blank" rel="noopener" onclick="event.stopPropagation()">Open recipe &#8599;</a>
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
      <div class="bx-header">
        <div class="bx-row bx-name">
          <input class="bx-name-input" value="${esc(d.name)}" onchange="inlineEdit('${d.id}','name',this.value)" onclick="event.stopPropagation();this.select()" />
        </div>
        ${recipeHtml}
      </div>
      <div class="bx-columns">
        <div class="bx-section bx-col-main">
          <div class="bx-section-title">Stock & services</div>
          <div class="bx-row bx-stock">
            <input class="bx-stock-input" type="number" value="${d.stock || 0}" step="0.5" min="0" onchange="inlineEdit('${d.id}','stock',this.value)" onclick="event.stopPropagation();this.select()" />
            <span class="bx-stock-unit">L in stock</span>
            <span class="bx-diff ${cls}">${str}</span>
          </div>
          ${servicesHtml}
          ${cateringLines.length ? `<div class="bx-catering-lines">${cateringLines.map(l => `<div class="bx-svc-line">${l}</div>`).join('')}</div>` : ''}
        </div>
        <div class="bx-section bx-col-side">
          <div class="bx-section-title">Properties</div>
          <div class="bx-row bx-schedule">
            <div class="bx-cook">${cookHtml}</div>
            <div class="bx-badges">
              <span class="${typeBadgeClass(d.type)}" style="cursor:pointer;" onclick="event.stopPropagation();cycleType('${d.id}')">${d.type}</span>
              <span class="${storageBadgeClass(d.storage || 'Gastro')}" style="cursor:pointer;" onclick="event.stopPropagation();cycleStorage('${d.id}')">${d.storage || 'Gastro'}</span>
              <span class="${logisticsBadgeClass(d)}" style="cursor:pointer;" onclick="event.stopPropagation();cycleLocation('${d.id}')">${logisticsShort(d)}</span>
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
  else if (field === 'stock') {
    d.stock = parseFloat(value) || 0;
    // Auto-set cook date when stock first entered
    if (d.stock > 0 && !d.cookDate) d.cookDate = dateToStr(getToday());
  }
  else if (field === 'location') { d.location = value as Location; d.inTransit = false; }
  else if (field === 'note') { d.note = value; }
  rebuildPlanner();
  scheduleSave();
  // Re-render only the computed columns without full re-render (to keep focus)
  const row = document.querySelector(`.dish-row input[onchange*="'${id}','stock'"]`);
  if (row) {
    const rowEl = row.closest('.dish-row');
    const { str, cls } = diffStr(d);
    const diffEl = rowEl.querySelector('.col-diff');
    if (diffEl) { diffEl.textContent = str; diffEl.className = 'col-diff ' + cls; }
  }
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
  if (!isBatchCooked(d) || !d.cookDate) return false;
  if (d.storage === 'Frozen') return false;
  const cd = strToDate(d.cookDate);
  if (!cd) return false;
  const diff = (getToday().getTime() - cd.getTime()) / (1000*60*60*24);
  return diff >= 3;
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
  // If the date is today or in the past and stock is 0, auto-fill stock
  const picked = new Date(isoDate);
  const today = getToday();
  if (picked <= today && (!d.stock || d.stock === 0)) {
    d.stock = calcRequired(d);
    toast(esc(d.name) + ' marked as cooked — stock set to ' + d.stock + 'L');
  }
  scheduleSave();
  rerenderCurrentView();
}

export function confirmCooked(id: string) {
  trackEvent('batch_confirm_cooked');
  const d = S.batches.find(x => x.id === id);
  if (!d) return;
  d.cookDate = dateToStr(getToday());
  // Auto-fill stock to required amount if stock was 0
  if (!d.stock || d.stock === 0) {
    d.stock = calcRequired(d);
  }
  scheduleSave();
  rerenderCurrentView();
  toast(esc(d.name) + ' marked as cooked — stock set to ' + d.stock + 'L');
  // Offer post-cook recording for v2 recipe batches
  if (d.recipeId) {
    openPostCookRecording(id);
  }
}

export function setFilter(group: keyof typeof S.filters, val: string) { S.filters[group] = val; S.selected.clear(); rerenderCurrentView(); }
export function toggleSelect(id: string) { if (S.draggingBatchId) return; if (S.selected.has(id)) S.selected.delete(id); else S.selected.add(id); rerenderCurrentView(); }

export function calcRequiredForLoc(dish: Batch, loc: string) {
  let total = 0;
  (dish.services || []).forEach(svc => {
    if (svc.loc !== loc) return;
    const g = getGuests(svc.loc, svc.date, svc.meal);
    const k = `${svc.loc}-${svc.date}-${svc.meal}`;
    const peers = (S.planner[k] || []).filter(d => d.type === dish.type);
    const count = Math.max(peers.length, 1);
    total += (g / count) * ((dish.serving || 280) / 1000);
  });
  return Math.round(total * 10) / 10;
}

export function renderSplitBar() {
  const area = document.getElementById('split-bar-area');
  if (!area || S.selected.size === 0) { if (area) area.innerHTML = ''; return; }
  const selD = [...S.selected].map(id => S.batches.find(d => d.id === id)).filter((d): d is Batch => !!d);
  const names = selD.map(d => d.name).join(', ');
  const hasWest = selD.some(d => d.location === 'west' && !d.inTransit);
  const hasCentraal = selD.some(d => d.location === 'centraal' && !d.inTransit);

  // Calculate smart amounts for transport splits
  // Centraal is preferred: send what Centraal needs even if it dips below West's local need
  let smartCentraalAmt = 0;
  let smartWestAmt = 0;
  selD.forEach(d => {
    if (d.location === 'west' && !d.inTransit) {
      const neededThere = calcRequiredForLoc(d, 'centraal');
      // Centraal preferred: cap at stock (can't send more than we have), not at surplus
      smartCentraalAmt += Math.min(neededThere, d.stock);
    }
    if (d.location === 'centraal' && !d.inTransit) {
      const neededHere = calcRequiredForLoc(d, 'centraal');
      const surplus = Math.max(0, d.stock - neededHere);
      const neededThere = calcRequiredForLoc(d, 'west');
      smartWestAmt += Math.min(neededThere, surplus);
    }
  });
  smartCentraalAmt = Math.round(smartCentraalAmt * 10) / 10;
  smartWestAmt = Math.round(smartWestAmt * 10) / 10;

  area.innerHTML = `<div class="split-bar">
    <span class="sbar-title">Split stock</span>
    <span style="font-size:12px;color:var(--text2);flex:1;min-width:60px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(names)}</span>
    <label>Amount (L)</label><input type="number" id="sp-amt" min="0.1" step="0.5" value="10" style="width:68px;"/>
    <label>Storage</label><select id="sp-storage">${STORAGE.map(s => `<option>${s}</option>`).join('')}</select>
    <label>Location</label><select id="sp-location">${LOCATIONS.map(l => `<option value="${l}">${locName(l)}</option>`).join('')}</select>
    <button class="btn btn-primary" onclick="doSplit(false)">Split off</button>
    ${hasWest ? `<button class="btn btn-purple" onclick="doTransportSplit('centraal',${smartCentraalAmt})">Split ${smartCentraalAmt}L &rarr; Centraal</button>` : ''}
    ${hasCentraal ? `<button class="btn btn-purple" onclick="doTransportSplit('west',${smartWestAmt})">Split ${smartWestAmt}L &rarr; West</button>` : ''}
    <button class="btn" onclick="S.selected.clear();rerenderCurrentView()">Cancel</button>
  </div>`;
}

export function doSplit(isTransport: boolean, targetLoc?: string, smartAmounts?: boolean) {
  const manualAmt = parseFloat((document.getElementById('sp-amt') as HTMLInputElement).value);
  const defaultStorage = (document.getElementById('sp-storage') as HTMLSelectElement).value;
  const splitLocation = isTransport ? targetLoc! : (document.getElementById('sp-location') as HTMLSelectElement).value;
  const splitInTransit = isTransport ? true : false;
  let errors = [];
  [...S.selected].forEach(id => {
    const d = S.batches.find(x => x.id === id);
    if (!d) return;
    // Inherit storage from source dish (frozen stays frozen)
    const storage = isTransport ? (d.storage || defaultStorage) : defaultStorage;
    // Calculate how much is needed at the current location
    const currentLoc = d.location || 'west';
    const neededHere = calcRequiredForLoc(d, currentLoc);
    // Centraal is preferred: when splitting TO centraal, allow dipping below local need
    const centraalPreferred = splitLocation === 'centraal' && currentLoc === 'west';
    // Max amount we can split off
    const maxSplit = centraalPreferred
      ? d.stock  // can send everything to centraal if needed
      : Math.max(0, Math.round((d.stock - neededHere) * 10) / 10);
    // For transport splits, calculate per-dish amount based on target location needs
    let amt;
    if (isTransport && smartAmounts) {
      const targetLocKey = targetLoc === 'centraal' ? 'centraal' : 'west';
      amt = calcRequiredForLoc(d, targetLocKey);
      if (amt <= 0) { errors.push(`"${d.name}" has no services at ${targetLoc}`); return; }
    } else {
      amt = manualAmt;
    }
    if (!amt || amt <= 0) return;
    // Cap at max split amount
    if (amt > maxSplit) {
      if (maxSplit <= 0) { errors.push(`"${d.name}" needs all ${d.stock}L at ${d.location === 'centraal' ? 'Sering Centraal' : 'Sering West'} (${neededHere}L required)`); return; }
      amt = maxSplit;
    }
    d.stock = Math.round((d.stock - amt) * 10) / 10;
    const targetLocName = targetLoc === 'centraal' ? 'centraal' : 'west';
    const splitName = d.name.replace(/ \(split\)$/, '') + ' (split)';
    const newDish: Batch = {
      id: newId(), name: splitName, type: d.type, storage: storage as StorageType, location: splitLocation as Location, inTransit: splitInTransit, stock: amt,
      serving: d.serving || 280, recipeSheetId: d.recipeSheetId,
      recipeVolume: d.recipeVolume,
      recipeIngredients: d.recipeIngredients ? [...d.recipeIngredients] : null,
      allergens: [...(d.allergens || [])], extraAllergens: [...(d.extraAllergens || [])],
      orderFor: false, parentId: d.id, cookDate: d.cookDate,
      services: (d.services || []).filter(s => s.loc === splitLocation),
      note: d.note || '', createdAt: new Date().toISOString(),
      recipeId: d.recipeId || null, actualIngredients: null, cookNotes: '', stockDeducted: false,
    };
    // Remove services that moved to the new batch
    if (splitLocation !== (d.location || 'west')) {
      d.services = (d.services || []).filter(s => s.loc !== splitLocation);
    }
    S.batches.push(newDish);
  });
  if (errors.length) { alert('Cannot split: ' + errors.join(', ')); return; }
  S.selected.clear(); rebuildPlanner(); rerenderCurrentView(); scheduleSave();
  toast('Stock split created');
}
export function doTransportSplit(tl: string, smartAmt: number) { doSplit(true, tl, true); }

// ── NEW DISH ──────────────────────────────────────────────
export function openNewDish() {
  searchNewDishModal();
}

export function searchNewDishModal() {
  // Legacy v1 recipe-index lookup removed in S12. The v2 "pick from recipes"
  // path lives in planner.ts (renderAddModal). This modal now leads users to
  // either the planner's modal (for v2 picks) or the "Create blank batch"
  // button below.
  const searchQuery = (document.getElementById('new-dish-search') as HTMLInputElement | null)?.value || '';
  const recipeList = '<div class="empty" style="padding:12px;">To pick from a recipe, open the Week plan and click a slot. Or use "Create blank batch" below.</div>';

  // If modal already open, only update the list
  const existingList = document.getElementById('new-dish-list');
  if (existingList) {
    existingList.innerHTML = recipeList;
    return;
  }

  showModal(`<h3>New batch</h3>
    <input type="text" class="dish-search" id="new-dish-search" placeholder="Search recipes..." value="${esc(searchQuery)}"
      oninput="searchNewDishModal()" autofocus />
    <div class="dish-opts-list" style="max-height:260px;" id="new-dish-list">${recipeList}</div>
    <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border);">
      <div style="font-size:12px;color:var(--text2);margin-bottom:8px;">Or create from scratch:</div>
      <button class="btn" data-testid="new-batch-blank-btn" onclick="openNewDishScratch()">Create blank batch</button>
    </div>
    <div class="modal-actions"><button class="btn" onclick="closeModal()">Close</button></div>`);
}

export function openNewDishScratch() {
  showModal(`<h3>New batch</h3>
    <div class="fr"><label>Name</label><input type="text" id="nd-name" placeholder="e.g. Mushroom soup" /></div>
    <div class="fr"><label>Type</label><select id="nd-type">
      <option>Soup</option><option>Main course</option><option>Dessert</option>
    </select></div>
    <div class="fr"><label>Stock (liters)</label><input type="number" id="nd-stock" value="0" step="0.5" min="0" /></div>
    <div class="fr"><label>Serving size (ml per guest)</label><input type="number" id="nd-serving" value="280" /></div>
    <div class="fr"><label>Storage state</label><select id="nd-storage">${STORAGE.map(s => `<option>${s}</option>`).join('')}</select></div>
    <div class="fr"><label>Location</label><select id="nd-location">${LOCATIONS.map(l => `<option value="${l}">${locName(l)}</option>`).join('')}</select></div>
    <div class="fr"><label>Recipe Google Sheet ID (optional)</label>
      <input type="text" id="nd-sheetid" placeholder="Paste the sheet ID from the URL" />
      <div style="font-size:11px;color:var(--text2);margin-top:4px;">Found in the sheet URL: /spreadsheets/d/<strong>THIS_PART</strong>/edit</div>
    </div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" data-testid="new-batch-submit" onclick="saveNewDish()">Create batch</button>
    </div>`);
}

export async function saveNewDish() {
  trackEvent('batch_create');
  const name = (document.getElementById('nd-name') as HTMLInputElement).value.trim();
  if (!name) { alert('Please enter a batch name'); return; }
  const sheetId = (document.getElementById('nd-sheetid') as HTMLInputElement).value.trim();
  const newDish: Partial<Batch> & { recipeVolume?: number | null; recipeIngredients?: RecipeIngredient[] | null } = {
    id: newId(), name,
    type: (document.getElementById('nd-type') as HTMLSelectElement).value as DishType,
    stock: parseFloat((document.getElementById('nd-stock') as HTMLInputElement).value) || 0,
    serving: parseInt((document.getElementById('nd-serving') as HTMLInputElement).value) || 280,
    storage: (document.getElementById('nd-storage') as HTMLSelectElement).value as StorageType,
    location: (document.getElementById('nd-location') as HTMLSelectElement).value as Location,
    inTransit: false,
    recipeSheetId: sheetId || null,
    allergens: [], extraAllergens: [], orderFor: false, parentId: null,
    cookDate: null, services: []
  };
  if (sheetId) {
    try {
      const recipe = await apiGet(`/api/recipe?sheetId=${sheetId}`);
      if (recipe.allergens) newDish.allergens = recipe.allergens;
      if (recipe.serving) newDish.serving = recipe.serving;
      if (recipe.recipeVolume) newDish.recipeVolume = recipe.recipeVolume;
      if (recipe.ingredients) newDish.recipeIngredients = recipe.ingredients;
      toast('Recipe data loaded from Google Sheet');
    } catch (e: unknown) { toastError('Could not fetch recipe: ' + (e instanceof Error ? e.message : 'Unknown error')); }
  }
  S.batches.push(newDish as Batch);
  closeModal(); rebuildPlanner(); rerenderCurrentView(); scheduleSave();
  toast(`"${name}" added`);
}

// ── EDIT DISH ─────────────────────────────────────────────
export function openEditDish(id: string) {
  const d = S.batches.find(x => x.id === id) as BatchWithLegacy | undefined;
  if (!d) return;
  const allAg = [...(d.allergens || []), ...(d.extraAllergens || [])];
  const agHtml = allAg.map(a => {
    const isBase = (d.allergens || []).includes(a);
    return `<div class="at-tag">${esc(a)}${isBase ? ` <span style="opacity:.4;font-size:9px;">base</span>` : ` <span class="at-rm" onclick="removeExtraAllergen('${id}','${esc(a)}')">&#215;</span>`}</div>`;
  }).join('');
  const cookModeDay = d.cookMode !== 'date';
  showModal(`<h3>Edit &mdash; ${esc(d.name)}</h3>
    <div class="fr"><label>Name</label><input type="text" id="ed-name" value="${esc(d.name)}" /></div>
    <div class="fr"><label>Stock (liters)</label><input type="number" id="ed-stock" value="${d.stock || 0}" step="0.5" min="0" /></div>
    <div class="fr"><label>Type</label><select id="ed-type">
      ${['Soup','Main course','Dessert'].map(t => `<option${d.type === t ? ' selected' : ''}>${t}</option>`).join('')}
    </select></div>
    <div class="fr"><label>Storage state</label><select id="ed-storage">
      ${STORAGE.map(s => `<option${d.storage === s ? ' selected' : ''}>${s}</option>`).join('')}
    </select></div>
    <div class="fr"><label>Location</label><select id="ed-location">
      ${LOCATIONS.map(l => `<option value="${l}"${d.location === l ? ' selected' : ''}>${locName(l)}</option>`).join('')}
    </select></div>
    <div class="fr"><label>In transit?</label><select id="ed-intransit">
      <option value="false"${!d.inTransit ? ' selected' : ''}>No — at location</option>
      <option value="true"${d.inTransit ? ' selected' : ''}>Yes — in transport</option>
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
      <div class="modal-note">Allergens marked "base" come from the recipe sheet.</div>
    </div>
    <div class="fr"><label>Include in order list?</label>
      <select id="ed-order">
        <option value="true"${d.orderFor ? ' selected' : ''}>Yes &mdash; include in order list</option>
        <option value="false"${!d.orderFor ? ' selected' : ''}>No</option>
      </select>
    </div>
    ${d.recipeSheetId ? `<div class="modal-note">Recipe sheet linked. <button class="btn btn-sm" onclick="refreshRecipe('${id}')">Refresh from sheet</button></div>` : ''}
    <div class="modal-actions">
      <button class="btn btn-danger btn-sm" onclick="deleteDish('${id}')">Delete</button>
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveEditDish('${id}')">Save</button>
    </div>`);
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

export async function refreshRecipe(id: string) {
  const d = S.batches.find(x => x.id === id); if (!d || !d.recipeSheetId) return;
  try {
    const recipe = await apiGet(`/api/recipe?sheetId=${d.recipeSheetId}`);
    if (recipe.allergens) d.allergens = recipe.allergens;
    if (recipe.recipeVolume) d.recipeVolume = recipe.recipeVolume;
    if (recipe.ingredients) d.recipeIngredients = recipe.ingredients;
    scheduleSave();
    closeModal(); openEditDish(id);
    toast('Recipe refreshed from Google Sheet');
  } catch (e: unknown) { toastError('Could not fetch recipe: ' + (e instanceof Error ? e.message : 'Unknown error')); }
}

export function saveEditDish(id: string) {
  const d = S.batches.find(x => x.id === id) as BatchWithLegacy | undefined; if (!d) return;
  d.name = (document.getElementById('ed-name') as HTMLInputElement).value;
  d.stock = parseFloat((document.getElementById('ed-stock') as HTMLInputElement).value) || 0;
  d.type = (document.getElementById('ed-type') as HTMLSelectElement).value as DishType;
  d.storage = (document.getElementById('ed-storage') as HTMLSelectElement).value as StorageType;
  d.location = (document.getElementById('ed-location') as HTMLSelectElement).value as Location;
  d.inTransit = (document.getElementById('ed-intransit') as HTMLSelectElement).value === 'true';
  d.orderFor = (document.getElementById('ed-order') as HTMLSelectElement).value === 'true';
  if (d.cookMode === 'day') { const el = document.getElementById('ed-cookday') as HTMLSelectElement | null; if (el) d.cookDay = el.value || null; }
  else { const el = document.getElementById('ed-cookdate') as HTMLInputElement | null; if (el) d.cookDate = el.value || null; }
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
