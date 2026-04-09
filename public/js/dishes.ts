import { S, DAYS, MEALS, STORAGE, LOCATIONS, ALLERGENS, INGREDIENT_TYPES, INGREDIENT_CATEGORIES, ACCOMPANIMENTS, getStorageColor } from './state';
import { newId, scheduleSave, toast, toastError, apiPost, apiGet } from './utils';
import { rebuildPlanner, isBatchCooked, locationBadge, getAmsterdamNow, dateToDayName, dateToIso, isServicePast, calcRequired, calcRequiredBreakdown, calcTotalGuests, calcIngredientsFromRecipe, diffStr, storageBadge, storageBadgeClass, cycleStorage, logisticsBadge, logisticsBadgeClass, logisticsShort, cycleLocation, typeBadge, typeBadgeClass, TYPES, cycleType, chipClass, getToday, dateToStr, strToDate, openServedDialog, getGuests, toggleOrder } from './core';
import { showModal, closeModal, esc } from './modal';
import { rerenderCurrentView } from './navigate';
import { addDishFromRecipe } from './recipes';
import { batchDragStart, batchDragEnd, startAssignMode, openReplaceBatch } from './planner';

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
  const sorted = dishSort.col === 'default' ? filtered : [...filtered].sort((a: any, b: any) => {
    let va, vb;
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

  const arrow = (col: any) => dishSort.col === col ? (dishSort.dir === 'asc' ? ' ▲' : ' ▼') : '';
  const sCls = (col: any) => `sortable${dishSort.col === col ? ' active' : ''}`;

  const html = `
  <div class="btn-row" style="margin-bottom:12px;">
    <button class="btn btn-primary" onclick="openNewDish()">+ New batch</button>
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

  document.getElementById('planner-content').innerHTML = html;
  renderSplitBar();
}

export function dishSortBy(col: any) {
  if (dishSort.col === col) {
    if (dishSort.dir === 'asc') dishSort.dir = 'desc';
    else { dishSort.col = 'default'; dishSort.dir = 'asc'; } // third click resets
  } else {
    dishSort.col = col;
    dishSort.dir = col === 'stock' || col === 'diff' ? 'desc' : 'asc';
  }
  rerenderCurrentView();
}

export function cookDateSortVal(ddmmyyyy: any) {
  if (!ddmmyyyy) return '9999-99-99';
  const parts = ddmmyyyy.split('/');
  if (parts.length === 3) return parts[2] + '-' + parts[1] + '-' + parts[0];
  return ddmmyyyy;
}

export function logisticsRowClass(d: any) {
  const loc = d.location || 'west';
  if (d.inTransit) return loc === 'centraal' ? 'log-twc' : 'log-tww';
  return loc === 'centraal' ? 'log-centraal' : 'log-west';
}

export function renderDishGroups(dishes: any) {
  const toCook = dishes.filter(d => !isBatchCooked(d) && d.storage !== 'Frozen');
  const cooked = dishes.filter(d => isBatchCooked(d) && d.storage !== 'Frozen');
  const frozen = dishes.filter(d => d.storage === 'Frozen');

  let html = '';

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

// NOTE: This was overwritten in original JS by the 2-arg version below.
// Renamed to avoid duplicate export. This is dead code.
export function renderBatchTileOverview(d: any) {
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
export function toggleBatchExpand(id: any) {
  // Don't toggle during drag — the click fires after dragstart and
  // rerenderCurrentView() would destroy the DOM element being dragged,
  // silently canceling the browser's native drag operation.
  if (S.draggingBatchId) return;
  if (S.expandedBatches.has(id)) S.expandedBatches.delete(id);
  else S.expandedBatches.add(id);
  rerenderCurrentView();
}

export function renderBatchTile(d: any, showAssign?: any) {
  const { str, cls } = diffStr(d);
  const isExpanded = S.expandedBatches.has(d.id);
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

  // Compact row
  let html = `<div class="batch-tile ${locCls}${transitCls}${frozenCls}${staleCls}${selCls}${splitCls}${assignCls}${expandCls}" data-id="${d.id}" draggable="true" ondragstart="batchDragStart(event,'${d.id}')" ondragend="batchDragEnd(event)">
    <div class="batch-tile-compact" onclick="toggleBatchExpand('${d.id}')">
      <div class="sel-box${isSel ? ' checked' : ''}" onclick="event.stopPropagation();toggleSelect('${d.id}')"></div>
      <span class="batch-type-dot batch-type-${(d.type||'Soup').toLowerCase().replace(/ /g,'-')}"></span>
      <span class="batch-tile-name">${esc(d.name)}</span>
      <span class="batch-tile-cook">${batchCookLabel(d)}</span>
      <span class="batch-tile-stock ${cls}">${d.stock || 0}L <small>${str}</small></span>
      <span class="batch-tile-logistics ${logisticsBadgeClass(d)}" style="font-size:10px;">${logisticsShort(d)}</span>
      ${d.inTransit ? '<span class="batch-transit-badge">In transit</span>' : ''}
      ${showAssign && !S.assigningBatchId ? `<button class="batch-assign-btn" onclick="event.stopPropagation();startAssignMode('${d.id}')">Assign</button>` : ''}
      <span class="batch-expand-arrow">${isExpanded ? '▾' : '▸'}</span>
    </div>`;

  // Expanded detail panel
  if (isExpanded) {
    const allAg = [...(d.allergens || []), ...(d.extraAllergens || [])];
    const svcLbls = (d.services || []).map(s => {
      const ml = s.meal === 'lunch' ? 'L' : 'D';
      const lc = s.loc === 'west' ? 'SW' : 'SC';
      const past = isServicePast(s) ? ' served' : '';
      return `<span class="batch-svc-label${past}"><strong>${dateToDayName(s.date)}</strong> ${ml} ${lc}</span>`;
    }).join(' ');
    const cookHtml = getCookCellHtml(d);
    const breakdown = calcRequiredBreakdown(d);

    html += `<div class="batch-tile-expanded">
      <div class="batch-detail-grid">
        <div class="batch-detail-section">
          <label>Name</label>
          <input class="inline-edit" value="${esc(d.name)}" onchange="inlineEdit('${d.id}','name',this.value)" onclick="event.stopPropagation();this.select()" />
        </div>
        <div class="batch-detail-section">
          <label>Stock</label>
          <div style="display:flex;align-items:center;gap:6px;">
            <input class="inline-edit" type="number" value="${d.stock || 0}" step="0.5" min="0" style="width:70px;" onchange="inlineEdit('${d.id}','stock',this.value)" onclick="event.stopPropagation();this.select()" />
            <span style="color:var(--text2);">L</span>
            <span class="${cls}" style="font-weight:600;">${str}</span>
          </div>
          ${breakdown.length ? `<div class="batch-breakdown">${breakdown.map(l => `<div>${l}</div>`).join('')}</div>` : ''}
        </div>
        <div class="batch-detail-section">
          <label>Cook date</label>
          ${cookHtml}
        </div>
        <div class="batch-detail-section">
          <label>Type</label>
          <span class="${typeBadgeClass(d.type)}" style="cursor:pointer;" onclick="event.stopPropagation();cycleType('${d.id}')">${d.type}</span>
        </div>
        <div class="batch-detail-section">
          <label>Storage</label>
          <span class="${storageBadgeClass(d.storage || 'Gastro')}" style="cursor:pointer;" onclick="event.stopPropagation();cycleStorage('${d.id}')">${d.storage || 'Gastro'}</span>
        </div>
        <div class="batch-detail-section">
          <label>Location</label>
          <span class="${logisticsBadgeClass(d)}" style="cursor:pointer;" onclick="event.stopPropagation();cycleLocation('${d.id}')">${logisticsShort(d)}</span>
        </div>
        <div class="batch-detail-section">
          <label>Serving</label>
          <span>${d.serving || 280} ml/guest</span>
        </div>
        ${d.recipeSheetId ? `<div class="batch-detail-section"><label>Recipe</label><a href="https://docs.google.com/spreadsheets/d/${esc(d.recipeSheetId)}/edit" target="_blank" rel="noopener" class="recipe-btn" onclick="event.stopPropagation()">Open recipe &#8599;</a></div>` : ''}
        <div class="batch-detail-section">
          <label>Services</label>
          <div>${svcLbls || '<span style="color:var(--red);font-weight:600;">No services assigned</span>'}</div>
        </div>
        <div class="batch-detail-section">
          <label>Allergens</label>
          <div class="allergen-inline" id="ag-inline-${d.id}">
            ${allAg.map(a => `<span class="allergen-pill" onclick="event.stopPropagation();inlineRemoveAllergen('${d.id}','${esc(a)}')" title="Click to remove">${esc(a)}</span>`).join('')}
            <button class="allergen-add-btn" onclick="event.stopPropagation();inlineAddAllergenStart('${d.id}',event)" title="Add allergen">+</button>
          </div>
        </div>
        ${d.note !== undefined ? `<div class="batch-detail-section"><label>Note</label><input class="inline-edit" value="${esc(d.note || '')}" placeholder="Add a note..." onchange="inlineEdit('${d.id}','note',this.value)" onclick="event.stopPropagation()" /></div>` : ''}
      </div>
      <div class="batch-tile-actions">
        <button class="order-toggle-btn${d.orderFor ? ' on' : ''}" onclick="event.stopPropagation();toggleOrder('${d.id}')">${d.orderFor ? 'Order' : '—'}</button>
        ${isBatchCooked(d)
          ? `<button class="served-btn" onclick="event.stopPropagation();openServedDialog('${d.id}')">Served</button>`
          : `${(d.services || []).length > 0 ? `<button class="btn btn-sm" style="background:var(--blue);color:white;" onclick="event.stopPropagation();openReplaceBatch('${d.id}')">Replace</button>` : ''}
             <button class="btn btn-sm btn-danger" onclick="event.stopPropagation();deleteBatch('${d.id}')">Delete</button>`
        }
      </div>
    </div>`;
  }

  html += '</div>';
  return html;
}

// Remove or replace a batch reference in all caterings
export function cleanCateringRefs(oldId: any, newId: any) {
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

export function deleteBatch(id: any) {
  const d = S.batches.find(x => x.id === id);
  if (!d) return;
  if (isBatchCooked(d)) {
    toast('Cannot delete a cooked batch — serve it first');
    return;
  }
  S.batches = S.batches.filter(x => x.id !== id);
  cleanCateringRefs(id, null);
  S.expandedBatches.delete(id);
  S.selected.delete(id);
  rebuildPlanner();
  scheduleSave();
  rerenderCurrentView();
  toast(esc(d.name) + ' deleted');
}

export function inlineEdit(id: any, field: any, value: any) {
  const d = S.batches.find(x => x.id === id);
  if (!d) return;
  if (field === 'name') { d.name = value.trim() || d.name; }
  else if (field === 'stock') {
    d.stock = parseFloat(value) || 0;
    // Auto-set cook date when stock first entered
    if (d.stock > 0 && !d.cookDate) d.cookDate = dateToStr(getToday());
  }
  else if (field === 'location') { d.location = value; d.inTransit = false; }
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

export function inlineRemoveAllergen(id: any, allergen: any) {
  const d = S.batches.find(x => x.id === id);
  if (!d) return;
  d.allergens = (d.allergens || []).filter(a => a !== allergen);
  d.extraAllergens = (d.extraAllergens || []).filter(a => a !== allergen);
  scheduleSave();
  rerenderCurrentView();
}

export function inlineAddAllergenStart(id: any, evt: any) {
  const d = S.batches.find(x => x.id === id);
  if (!d) return;
  // Use the clicked button's parent to avoid duplicate-ID issues (e.g. dashboard shows same batch twice)
  const btn = evt ? evt.target.closest('.allergen-add-btn') : null;
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
  select.onchange = function() {
    if (this.value === '__custom') {
      this.remove();
      const input = document.createElement('input');
      input.className = 'allergen-add-input';
      input.placeholder = 'type...';
      input.onkeydown = function(e) {
        if (e.key === 'Enter') { inlineAddAllergenConfirm(id, this.value); }
        if (e.key === 'Escape') { rerenderCurrentView(); }
      };
      input.onblur = function() {
        if (this.value.trim()) inlineAddAllergenConfirm(id, this.value);
        else rerenderCurrentView();
      };
      container.insertBefore(input, addBtn);
      input.focus();
    } else if (this.value) {
      inlineAddAllergenConfirm(id, this.value);
    }
  };
  select.onblur = function() {
    if (!this.value) rerenderCurrentView();
  };
  container.insertBefore(select, addBtn);
  addBtn.style.display = 'none';
  select.focus();
}

export function inlineAddAllergenConfirm(id: any, value: any) {
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

export function isDishCooked(d: any) {
  return isBatchCooked(d);
}

export function isCookDayToday(d: any) {
  if (!d.cookDate) return false;
  const cd = strToDate(d.cookDate);
  if (!cd) return false;
  const today = getToday();
  return cd.getTime() === today.getTime() && !isBatchCooked(d);
}

export function isDishStale(d: any) {
  if (!isBatchCooked(d) || !d.cookDate) return false;
  if (d.storage === 'Frozen') return false;
  const cd = strToDate(d.cookDate);
  if (!cd) return false;
  const diff = (getToday() - cd) / (1000*60*60*24);
  return diff >= 3;
}

export function daysSinceCooked(d: any) {
  if (!isBatchCooked(d) || !d.cookDate) return 0;
  const cd = strToDate(d.cookDate);
  if (!cd) return 0;
  return Math.floor((getToday() - cd) / (1000*60*60*24));
}

// Short cook date label for the compact batch tile row
export function batchCookLabel(d: any) {
  if (isBatchCooked(d) && d.cookDate) {
    // Already cooked — show "Cooked DD/M"
    const iso = cookDateToISO(d.cookDate);
    const dt = new Date(iso);
    if (!isNaN(dt)) {
      const stale = isDishStale(d);
      return `<span class="cook-label cooked${stale ? ' stale' : ''}" onclick="event.stopPropagation();tileEditCookDate('${d.id}')" title="Click to change cook date">${dt.getDate()}/${dt.getMonth()+1}</span>`;
    }
    return '';
  }
  if (d.cookDate) {
    // Planned cook date — show "Cook DD/M"
    const iso = cookDateToISO(d.cookDate);
    const dt = new Date(iso);
    if (!isNaN(dt)) {
      return `<span class="cook-label planned" onclick="event.stopPropagation();tileEditCookDate('${d.id}')" title="Click to change cook date">${dt.getDate()}/${dt.getMonth()+1}</span>`;
    }
  }
  // No cook date set
  return `<span class="cook-label none" onclick="event.stopPropagation();tileEditCookDate('${d.id}')" title="Click to set cook date">no date</span>`;
}

// Inline date picker triggered from tile cook label
export function tileEditCookDate(id: any) {
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
  inp.onchange = function() {
    setCookDateDirect(id, this.value);
    this.remove();
  };
  inp.onblur = function() { setTimeout(() => this.remove(), 200); };
  document.body.appendChild(inp);
  inp.showPicker ? inp.showPicker() : inp.click();
}

export function getCookCellHtml(d: any) {
  const opts = getCookDayOptions();

  // Already cooked (stock > 0) — show date + stale warning + editable date
  if (isBatchCooked(d) && d.cookDate) {
    const stale = isDishStale(d);
    const days = daysSinceCooked(d);
    let html = `<input type="date" class="cook-date-input" value="${cookDateToISO(d.cookDate)}" onchange="setCookDateDirect('${d.id}',this.value)" onclick="event.stopPropagation()" title="Change cooked date" />`;
    if (stale) {
      html += `<div class="cook-stale">${days}d ago — serve or freeze</div>`;
    }
    return html;
  }
  // Planned for today — show confirm button
  if (isCookDayToday(d)) {
    return `<button class="cook-today-btn" onclick="event.stopPropagation();confirmCooked('${d.id}')">Click to mark as cooked</button>`;
  }
  // Has a planned future day — show dropdown (with option to switch to date)
  if (d.cookDate && !isBatchCooked(d)) {
    return `<select class="cook-select has-date" onchange="setCookDay('${d.id}',this.value)" onclick="event.stopPropagation()">
      <option value="">Select day/date</option>
      ${opts.map(o => `<option value="${o.value}"${d.cookDate === o.value ? ' selected' : ''}>${o.label}</option>`).join('')}
      <option value="__date">Pick a date...</option>
    </select>`;
  }
  // No plan yet — show dropdown with red warning style
  return `<select class="cook-select no-date" onchange="setCookDay('${d.id}',this.value)" onclick="event.stopPropagation()">
    <option value="">Select day/date</option>
    ${opts.map(o => `<option value="${o.value}">${o.label}</option>`).join('')}
    <option value="__date">Pick a date...</option>
  </select>`;
}

export function cookDateToISO(ddmmyyyy: any) {
  if (!ddmmyyyy) return '';
  const parts = ddmmyyyy.split('/');
  if (parts.length === 3) return parts[2]+'-'+parts[1]+'-'+parts[0];
  return ddmmyyyy;
}

export function isoToCookDate(iso: any) {
  if (!iso) return '';
  const parts = iso.split('-');
  if (parts.length === 3) return parts[2]+'/'+parts[1]+'/'+parts[0];
  return iso;
}

export function setCookDay(id: any, value: any) {
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
      input.onchange = function() {
        setCookDateDirect(id, this.value);
      };
      input.onclick = function(e) { e.stopPropagation(); };
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

export function setCookDateDirect(id: any, isoDate: any) {
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

export function confirmCooked(id: any) {
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
}

export function setFilter(group: any, val: any) { S.filters[group] = val; S.selected.clear(); rerenderCurrentView(); }
export function toggleSelect(id: any) { if (S.draggingBatchId) return; if (S.selected.has(id)) S.selected.delete(id); else S.selected.add(id); rerenderCurrentView(); }

export function calcRequiredForLoc(dish: any, loc: any) {
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
  const selD = [...S.selected].map(id => S.batches.find(d => d.id === id)).filter(Boolean);
  const names = selD.map(d => d.name).join(', ');
  const hasWest = selD.some(d => d.location === 'west' && !d.inTransit);
  const hasCentraal = selD.some(d => d.location === 'centraal' && !d.inTransit);

  // Calculate smart amounts for transport splits (capped at surplus)
  let smartCentraalAmt = 0;
  let smartWestAmt = 0;
  selD.forEach(d => {
    if (d.location === 'west' && !d.inTransit) {
      const neededHere = calcRequiredForLoc(d, 'west');
      const surplus = Math.max(0, d.stock - neededHere);
      const neededThere = calcRequiredForLoc(d, 'centraal');
      smartCentraalAmt += Math.min(neededThere, surplus);
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
    <label>Location</label><select id="sp-location">${LOCATIONS.map(l => `<option value="${l}">${l === 'west' ? 'Sering West' : 'Sering Centraal'}</option>`).join('')}</select>
    <button class="btn btn-primary" onclick="doSplit(false)">Split off</button>
    ${hasWest ? `<button class="btn btn-purple" onclick="doTransportSplit('centraal',${smartCentraalAmt})">Split ${smartCentraalAmt}L &rarr; Centraal</button>` : ''}
    ${hasCentraal ? `<button class="btn btn-purple" onclick="doTransportSplit('west',${smartWestAmt})">Split ${smartWestAmt}L &rarr; West</button>` : ''}
    <button class="btn" onclick="S.selected.clear();rerenderCurrentView()">Cancel</button>
  </div>`;
}

export function doSplit(isTransport: any, targetLoc: any, smartAmounts: any) {
  const manualAmt = parseFloat(document.getElementById('sp-amt').value);
  const defaultStorage = document.getElementById('sp-storage').value;
  const splitLocation = isTransport ? targetLoc : document.getElementById('sp-location').value;
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
    // Surplus = what can be split off (never more than stock minus local need)
    const surplus = Math.max(0, Math.round((d.stock - neededHere) * 10) / 10);
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
    // Cap at surplus — can't split off more than what's not needed here
    if (amt > surplus) {
      if (surplus <= 0) { errors.push(`"${d.name}" needs all ${d.stock}L at ${d.location === 'centraal' ? 'Sering Centraal' : 'Sering West'} (${neededHere}L required)`); return; }
      amt = surplus;
    }
    d.stock = Math.round((d.stock - amt) * 10) / 10;
    const targetLocName = targetLoc === 'centraal' ? 'centraal' : 'west';
    const splitName = d.name.replace(/ \(split\)$/, '') + ' (split)';
    const newDish = {
      id: newId(), name: splitName, type: d.type, storage, location: splitLocation, inTransit: splitInTransit, stock: amt,
      serving: d.serving || 280, recipeSheetId: d.recipeSheetId,
      recipeVolume: d.recipeVolume,
      recipeIngredients: d.recipeIngredients ? [...d.recipeIngredients] : undefined,
      allergens: [...(d.allergens || [])], extraAllergens: [...(d.extraAllergens || [])],
      orderFor: false, parentId: d.id, cookDate: d.cookDate,
      services: (d.services || []).filter(s => s.loc === splitLocation)
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
export function doTransportSplit(tl: any, smartAmt: any) { doSplit(true, tl, true); }

// ── NEW DISH ──────────────────────────────────────────────
export function openNewDish() {
  searchNewDishModal();
}

export function searchNewDishModal() {
  const searchQuery = (document.getElementById('new-dish-search') || {}).value || '';
  let recipes = S.recipeIndex;
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    recipes = recipes.filter(r => r.name.toLowerCase().includes(q));
  }
  const recipeList = recipes.length > 0
    ? recipes.slice(0, 20).map(r => {
      const ags = (r.allergens||[]).slice(0,3).map(a => `<span class="allergen-pill">${esc(a)}</span>`).join('');
      return `<div class="dish-opt" onclick="addDishFromRecipe('${r.id}');closeModal();">
        <div><span style="font-weight:500;">${esc(r.name)}</span> ${typeBadge(r.type||'Soup')} ${ags}</div>
        <div style="font-size:11px;color:var(--text2);">${r.costPerServing || ''}</div>
      </div>`;
    }).join('')
    : `<div class="empty" style="padding:12px;">${S.recipeIndex.length === 0 ? 'No recipes in index yet. Add some in the Recipes tab.' : 'No recipes match "' + esc(searchQuery) + '"'}</div>`;

  // If modal already open, only update the list
  const existingList = document.getElementById('new-dish-list');
  if (existingList) {
    existingList.innerHTML = recipeList;
    return;
  }

  showModal(`<h3>Add batch to menu</h3>
    <div style="font-size:12px;color:var(--text2);margin-bottom:10px;">Pick from your recipe index:</div>
    <input type="text" class="dish-search" id="new-dish-search" placeholder="Search recipes..." value="${esc(searchQuery)}"
      oninput="searchNewDishModal()" autofocus />
    <div class="dish-opts-list" style="max-height:260px;" id="new-dish-list">${recipeList}</div>
    <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border);">
      <div style="font-size:12px;color:var(--text2);margin-bottom:8px;">Or create from scratch:</div>
      <button class="btn" onclick="openNewDishScratch()">Create blank batch</button>
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
    <div class="fr"><label>Location</label><select id="nd-location">${LOCATIONS.map(l => `<option value="${l}">${l === 'west' ? 'Sering West' : 'Sering Centraal'}</option>`).join('')}</select></div>
    <div class="fr"><label>Recipe Google Sheet ID (optional)</label>
      <input type="text" id="nd-sheetid" placeholder="Paste the sheet ID from the URL" />
      <div style="font-size:11px;color:var(--text2);margin-top:4px;">Found in the sheet URL: /spreadsheets/d/<strong>THIS_PART</strong>/edit</div>
    </div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveNewDish()">Create batch</button>
    </div>`);
}

export async function saveNewDish() {
  const name = document.getElementById('nd-name').value.trim();
  if (!name) { alert('Please enter a batch name'); return; }
  const sheetId = document.getElementById('nd-sheetid').value.trim();
  const newDish = {
    id: newId(), name,
    type: document.getElementById('nd-type').value,
    stock: parseFloat(document.getElementById('nd-stock').value) || 0,
    serving: parseInt(document.getElementById('nd-serving').value) || 280,
    storage: document.getElementById('nd-storage').value,
    location: document.getElementById('nd-location').value,
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
  S.batches.push(newDish);
  closeModal(); rebuildPlanner(); rerenderCurrentView(); scheduleSave();
  toast(`"${name}" added`);
}

// ── EDIT DISH ─────────────────────────────────────────────
export function openEditDish(id: any) {
  const d = S.batches.find(x => x.id === id);
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
      ${LOCATIONS.map(l => `<option value="${l}"${d.location === l ? ' selected' : ''}>${l === 'west' ? 'Sering West' : 'Sering Centraal'}</option>`).join('')}
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

export function setCookMode(id: any, mode: any) {
  const d = S.batches.find(x => x.id === id); if (!d) return;
  d.cookMode = mode;
  document.getElementById('ct-day').classList.toggle('active', mode === 'day');
  document.getElementById('ct-date').classList.toggle('active', mode === 'date');
  document.getElementById('cook-input').innerHTML = mode === 'day'
    ? `<select id="ed-cookday">${['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(day => `<option${d.cookDay === day ? ' selected' : ''}>${day}</option>`).join('')}</select>`
    : `<input type="date" id="ed-cookdate" value="${d.cookDate || ''}" />`;
}

export function addExtraAllergen(id: any) {
  const d = S.batches.find(x => x.id === id); if (!d) return;
  const inp = document.getElementById('ag-new');
  const val = (inp.value || '').trim(); if (!val) return;
  if (!d.extraAllergens) d.extraAllergens = [];
  if (!d.extraAllergens.includes(val) && !(d.allergens || []).includes(val)) d.extraAllergens.push(val);
  inp.value = '';
  refreshAllergenTags(d);
}

export function removeExtraAllergen(id: any, allergen: any) {
  const d = S.batches.find(x => x.id === id); if (!d) return;
  d.extraAllergens = (d.extraAllergens || []).filter(a => a !== allergen);
  refreshAllergenTags(d);
}

export function refreshAllergenTags(d: any) {
  const allAg = [...(d.allergens || []), ...(d.extraAllergens || [])];
  document.getElementById('ag-tags').innerHTML = allAg.map(a => {
    const isBase = (d.allergens || []).includes(a);
    return `<div class="at-tag">${esc(a)}${isBase ? ` <span style="opacity:.4;font-size:9px;">base</span>` : ` <span class="at-rm" onclick="removeExtraAllergen('${d.id}','${esc(a)}')">&#215;</span>`}</div>`;
  }).join('') || '<span style="font-size:12px;color:var(--text3);">none</span>';
}

export async function refreshRecipe(id: any) {
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

export function saveEditDish(id: any) {
  const d = S.batches.find(x => x.id === id); if (!d) return;
  d.name = document.getElementById('ed-name').value;
  d.stock = parseFloat(document.getElementById('ed-stock').value) || 0;
  d.type = document.getElementById('ed-type').value;
  d.storage = document.getElementById('ed-storage').value;
  d.location = document.getElementById('ed-location').value;
  d.inTransit = document.getElementById('ed-intransit').value === 'true';
  d.orderFor = document.getElementById('ed-order').value === 'true';
  if (d.cookMode === 'day') { const el = document.getElementById('ed-cookday'); if (el) d.cookDay = el.value || null; }
  else { const el = document.getElementById('ed-cookdate'); if (el) d.cookDate = el.value || null; }
  closeModal(); rebuildPlanner(); rerenderCurrentView(); scheduleSave();
  toast('Batch saved');
}

export function deleteDish(id: any) {
  if (!confirm('Delete this batch? This cannot be undone.')) return;
  S.batches = S.batches.filter(d => d.id !== id);
  closeModal(); rebuildPlanner(); rerenderCurrentView(); scheduleSave();
  toast('Batch deleted');
}
