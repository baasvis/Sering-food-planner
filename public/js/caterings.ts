import { S, DAYS, MEALS, LOCATIONS, ALLERGENS } from './state';
import { newId, scheduleSave, toast } from './utils';
import { pushUndo } from './undo';
import { rebuildPlanner, calcRequired, typeBadge, typeBadgeClass, TYPES, getToday, isBatchCooked, diffStr, strToDate, getTotalStock, getStockAt, sortByCookDate } from './core';
import { showModal, closeModal, esc } from './modal';
import { cookDateToISO, isoToCookDate, renderBatchTile } from './dishes';
import { locName } from '@shared/location';
import type { Batch, Location, Catering } from '@shared/types';

/**
 * Compact stock-location summary for the catering picker. Shows the primary
 * cook location for empty-inventory batches, or a "WL/CL" badge with the
 * non-zero loc qtys for batches with settled stock at one or both kitchens.
 */
function batchStockLocLabel(b: Batch): string {
  const inv = b.inventory || [];
  if (inv.length === 0) return locName('west');  // default cook loc for placeholders
  const west = getStockAt(b, 'west');
  const centraal = getStockAt(b, 'centraal');
  if (west > 0 && centraal > 0) return `${locName('west')} + ${locName('centraal')}`;
  if (west > 0) return locName('west');
  if (centraal > 0) return locName('centraal');
  // All inventory entries are zero-qty markers — fall back to the primary loc.
  return locName(inv[0].loc as Location);
}

// ── CATERINGS ─────────────────────────────────────────────

/** Search text for the right-pane dish list — module-level so it survives the
 *  full screen re-render that toggleBatchExpand (tile foldout) triggers. */
let cateringDishQuery = '';

/** Last-known scroll offsets of the two panes — module-level so they survive
 *  the full #planner-content rebuild that rerenderCurrentView() performs. */
let cateringListScrollTop = 0;
let cateringDishScrollTop = 0;

export function renderCaterings() {
  const el = document.getElementById('planner-content');
  if (!el) return;

  el.innerHTML = `<div class="catering-layout">
    <div class="catering-pane catering-pane-left">
      <div class="btn-row" style="margin-bottom:12px;">
        <button class="btn btn-primary" onclick="openNewCatering()">+ New Catering</button>
      </div>
      <div id="caterings-list"></div>
    </div>
    <div class="catering-pane catering-pane-right">
      <div class="catering-dish-hdr">Dishes — drag onto a catering</div>
      <input type="text" class="dish-search" id="catering-dish-search" placeholder="Search planned &amp; cooked dishes..." value="${esc(cateringDishQuery)}" oninput="searchCateringDishes()" />
      <div id="catering-dish-results">${renderCateringDishTiles(cateringDishQuery)}</div>
    </div>
  </div>`;

  renderCateringList();

  // Restore pane scroll across the full rebuild. rerenderCurrentView() (a dish-
  // tile foldout toggle, an SSE patch, a live-sync reconnect) goes through
  // renderWeekPlan(), which recreates #planner-content — so the old DOM is gone
  // before this runs. The offsets are kept in module state by these listeners.
  const newLeft = el.querySelector('.catering-pane-left') as HTMLElement | null;
  if (newLeft) {
    newLeft.scrollTop = cateringListScrollTop;
    newLeft.addEventListener('scroll', () => { cateringListScrollTop = newLeft.scrollTop; });
  }
  const newDish = el.querySelector('#catering-dish-results') as HTMLElement | null;
  if (newDish) {
    newDish.scrollTop = cateringDishScrollTop;
    newDish.addEventListener('scroll', () => { cateringDishScrollTop = newDish.scrollTop; });
  }

  // While a dish tile is dragged, flag every catering card as a drop target.
  // The tiles drag via the planner's batchDragStart (it only highlights planner
  // slots), so the catering-card cue is wired here through event bubbling.
  const layout = el.querySelector('.catering-layout') as HTMLElement | null;
  layout?.addEventListener('dragstart', e => {
    if ((e.target as HTMLElement)?.closest?.('.batch-tile')) {
      document.querySelectorAll('.catering-card').forEach(c => c.classList.add('catering-drop-target'));
    }
  });
  layout?.addEventListener('dragend', () => {
    document.querySelectorAll('.catering-card').forEach(c => c.classList.remove('catering-drop-target', 'catering-drag-over'));
  });
}

/** Re-renders only the catering cards (left pane) — keeps the dish search box intact. */
export function renderCateringList() {
  const el = document.getElementById('caterings-list');
  if (!el) return;

  const caterings = S.caterings || [];
  if (caterings.length === 0) {
    el.innerHTML = `<div class="empty">No caterings yet. Click "+ New Catering" to add one.</div>`;
    return;
  }

  // Sort by date (earliest first, undated last), then a deterministic tiebreak
  // (createdAt, then id) so same-date caterings keep a fixed order even when
  // loadData() reassigns S.caterings to the DB read order — prisma's
  // catering.findMany() has no stable orderBy, so that order shifts on upsert.
  const sorted = [...caterings].sort((a: Catering, b: Catering) => {
    const da = a.date ? strToDate(a.date) : new Date(9999, 0);
    const db = b.date ? strToDate(b.date) : new Date(9999, 0);
    if (da.getTime() !== db.getTime()) return da.getTime() - db.getTime();
    const ca = a.createdAt || '', cb = b.createdAt || '';
    if (ca !== cb) return ca < cb ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  el.innerHTML = sorted.map(c => {
    const deliveryLabel = { pickup: 'Pickup', delivery: 'Delivery', 'on-location': 'On location' }[c.deliveryMode] || c.deliveryMode;
    const dishes = c.dishes || [];
    const dishList = dishes.map(d => {
      const dish = S.batches.find(x => x.id === d.dishId);
      const serving = dish ? (dish.serving || 280) : 280;
      const peers = dishes.filter(cd => cd.type === d.type).length;
      const liters = Math.round(((c.guestCount || 0) / Math.max(peers, 1)) * serving / 1000 * 10) / 10;
      const badgeCls = d.type === 'Soup' ? 'b-soup' : d.type === 'Dessert' ? 'b-dessert' : 'b-main';
      return `<span class="badge ${badgeCls} ct-card-badge">${esc(d.name)} · ${liters}L<span class="ct-badge-x" onclick="removeCateringDishFromCard('${c.id}','${d.dishId}')" title="Remove">&#10005;</span></span>`;
    }).join('');

    return `<div class="card catering-card" data-catering-id="${c.id}" data-testid="catering-card"
      ondragover="cateringDragOver(event)" ondragleave="cateringDragLeave(event)" ondrop="cateringDrop(event,'${c.id}')">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;">
        <div>
          <div style="font-size:15px;font-weight:600;">${esc(c.name)}</div>
          <div style="font-size:12px;color:var(--text2);margin-top:2px;">${c.date ? `<strong style="color:var(--text);">${c.date}</strong>` : '<strong style="color:var(--red);">No date</strong>'} · ${c.guestCount || '?'} guests · ${deliveryLabel}</div>
        </div>
        <div style="display:flex;gap:4px;">
          <button class="btn btn-sm" onclick="openEditCatering('${c.id}')">Edit</button>
          <button class="btn btn-sm btn-danger" onclick="deleteCatering('${c.id}')">Delete</button>
        </div>
      </div>
      ${dishList ? `<div class="ct-card-dishes">${dishList}</div>` : '<div class="ct-card-empty">Drag dishes here to add them</div>'}
      ${c.logisticsNotes ? `<div style="font-size:12px;color:var(--text2);margin-top:6px;background:var(--bg2);padding:6px 10px;border-radius:var(--radius);">${esc(c.logisticsNotes)}</div>` : ''}
    </div>`;
  }).join('');
}

/**
 * Builds the right-pane dish list using the planner's batch tiles (draggable,
 * with the expandable foldout). Shows soups & mains that are still relevant
 * (planned, or cooked with stock); "used-up" dishes — no stock left and a
 * cook date in the past — are hidden. Oldest cook date first, undated last.
 */
export function renderCateringDishTiles(query: string): string {
  const today = getToday();
  const q = (query || '').toLowerCase();

  const dishes = S.batches.filter(b => {
    if (b.type !== 'Soup' && b.type !== 'Main course') return false;
    if (!isBatchCooked(b) && b.cookDate && strToDate(b.cookDate).getTime() < today.getTime()) return false;
    if (q && !b.name.toLowerCase().includes(q)) return false;
    return true;
  });

  const sorted = sortByCookDate(dishes);
  if (sorted.length === 0) {
    return `<div class="empty">No dishes${query ? ` matching "${esc(query)}"` : ''}.</div>`;
  }
  return sorted.map(d => renderBatchTile(d)).join('');
}

/** Re-renders only the dish tile list — never replaces the search input. */
export function searchCateringDishes() {
  const input = document.getElementById('catering-dish-search') as HTMLInputElement | null;
  cateringDishQuery = input?.value || '';
  const results = document.getElementById('catering-dish-results');
  if (results) results.innerHTML = renderCateringDishTiles(cateringDishQuery);
}

// ── DRAG & DROP (dish tile → catering card) ───────────────
// The dish tiles drag via the planner's batchDragStart / batchDragEnd (built
// into renderBatchTile), which set S.draggingBatchId. Only the drop-side
// handlers on the catering card live here.
export function cateringDragOver(e: DragEvent) {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  (e.currentTarget as HTMLElement)?.classList.add('catering-drag-over');
}

export function cateringDragLeave(e: DragEvent) {
  (e.currentTarget as HTMLElement)?.classList.remove('catering-drag-over');
}

export function cateringDrop(e: DragEvent, cateringId: string) {
  e.preventDefault();
  (e.currentTarget as HTMLElement)?.classList.remove('catering-drag-over');
  const batchId = S.draggingBatchId || e.dataTransfer?.getData('text/plain');
  S.draggingBatchId = null;
  if (!batchId) return;
  const c = S.caterings.find(x => x.id === cateringId);
  const d = S.batches.find(x => x.id === batchId);
  if (!c || !d) return;
  if (!c.dishes) c.dishes = [];
  if (c.dishes.some(x => x.dishId === d.id)) {
    toast(`${d.name} is already in this catering`);
    return;
  }
  c.dishes.push({ dishId: d.id, name: d.name, type: d.type || 'Soup' });
  scheduleSave();
  renderCateringList();
  toast(`${d.name} added to ${c.name}`);
}

/** Removes a dish from a catering card directly (the inline ✕ on a dish badge).
 *  Matches by dishId rather than array index — a render-time index can go stale
 *  if an SSE patch reorders the catering's dishes between render and click. */
export function removeCateringDishFromCard(cateringId: string, dishId: string) {
  const c = S.caterings.find(x => x.id === cateringId);
  if (!c || !c.dishes) return;
  c.dishes = c.dishes.filter(d => d.dishId !== dishId);
  scheduleSave();
  renderCateringList();
}

export function openNewCatering() {
  showModal(`<h3>New Catering</h3>
    <div class="fr"><label>Name / Event</label><input type="text" id="ct-name" placeholder="e.g. Protest march catering" /></div>
    <div class="fr"><label>Date</label><input type="date" id="ct-date" /></div>
    <div class="fr"><label>Guest count</label><input type="number" id="ct-guests" value="50" min="1" /></div>
    <div class="fr"><label>Delivery mode</label><select id="ct-delivery">
      <option value="pickup">Pickup</option>
      <option value="delivery">Delivery</option>
      <option value="on-location">On location (we cook there)</option>
    </select></div>
    <div class="fr"><label>Logistics notes</label><textarea id="ct-notes" rows="3" style="width:100%;font-size:13px;border:1px solid var(--border2);border-radius:var(--radius);padding:8px;background:var(--bg);color:var(--text);font-family:inherit;" placeholder="Address, contact, special instructions..."></textarea></div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveNewCatering()">Create</button>
    </div>`);
}

export function saveNewCatering() {
  const name = (document.getElementById('ct-name') as HTMLInputElement).value.trim();
  if (!name) { alert('Please enter a name'); return; }
  const dateInput = (document.getElementById('ct-date') as HTMLInputElement).value;
  const catering = {
    id: newId(),
    name,
    date: dateInput ? isoToCookDate(dateInput) : null,
    guestCount: parseInt((document.getElementById('ct-guests') as HTMLInputElement).value) || 50,
    deliveryMode: (document.getElementById('ct-delivery') as HTMLSelectElement).value,
    dishes: [],
    logisticsNotes: (document.getElementById('ct-notes') as HTMLTextAreaElement).value.trim(),
  };
  S.caterings.push(catering);
  closeModal(); renderCateringList(); scheduleSave();
  toast(`Catering "${name}" created`);
}

export function openEditCatering(id: any) {
  const c = S.caterings.find(x => x.id === id);
  if (!c) return;
  const dateVal = c.date ? cookDateToISO(c.date) : '';
  showModal(`<h3>Edit Catering</h3>
    <div class="fr"><label>Name / Event</label><input type="text" id="ct-name" value="${esc(c.name)}" /></div>
    <div class="fr"><label>Date</label><input type="date" id="ct-date" value="${dateVal}" /></div>
    <div class="fr"><label>Guest count</label><input type="number" id="ct-guests" value="${c.guestCount || 50}" min="1" /></div>
    <div class="fr"><label>Delivery mode</label><select id="ct-delivery">
      <option value="pickup"${c.deliveryMode === 'pickup' ? ' selected' : ''}>Pickup</option>
      <option value="delivery"${c.deliveryMode === 'delivery' ? ' selected' : ''}>Delivery</option>
      <option value="on-location"${c.deliveryMode === 'on-location' ? ' selected' : ''}>On location (we cook there)</option>
    </select></div>
    <div class="fr"><label>Logistics notes</label><textarea id="ct-notes" rows="3" style="width:100%;font-size:13px;border:1px solid var(--border2);border-radius:var(--radius);padding:8px;background:var(--bg);color:var(--text);font-family:inherit;">${esc(c.logisticsNotes || '')}</textarea></div>
    <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border);">
      <label style="font-size:12px;font-weight:500;color:var(--text2);margin-bottom:6px;display:block;">Batches</label>
      <div id="ct-dish-list">${renderCateringDishList(c)}</div>
      <button class="btn btn-sm" style="margin-top:6px;" onclick="openAddCateringDish('${id}')">+ Add batch</button>
    </div>
    <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border);">
      <label style="font-size:12px;font-weight:500;color:var(--text2);margin-bottom:6px;display:block;">Toppings &amp; bread</label>
      <div id="ct-topping-list">${renderCateringToppingList(c)}</div>
      <div style="display:flex;gap:6px;margin-top:6px;align-items:center;">
        <select id="ct-topping-pick" style="flex:1;font-size:12px;padding:4px;">${cateringToppingOptions(c)}</select>
        <input type="number" min="0" step="1" id="ct-topping-amount" placeholder="amount" style="width:90px;font-size:12px;padding:4px;" />
        <button class="btn btn-sm" onclick="addCateringTopping('${id}')">+ Add</button>
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-danger btn-sm" onclick="deleteCatering('${id}')">Delete</button>
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveEditCatering('${id}')">Save</button>
    </div>`);
}

export function renderCateringToppingList(c: any): string {
  const toppings = (c?.toppings || []) as Array<{ supplyId: string; amount: number }>;
  if (!toppings.length) return '<div style="font-size:12px;color:var(--text3);">No toppings yet</div>';
  return toppings.map((t, i) => {
    const sup = (S.supplies || []).find(s => s.id === t.supplyId);
    // Dangling ref — the supply was deleted/archived after being added here.
    // Flag it clearly so the cook removes it; demand calc silently skips it.
    const nameCell = sup
      ? `<span style="flex:1;">${esc(sup.name)}</span><span style="color:var(--text2);">${t.amount} ${esc(sup.unit)}</span>`
      : `<span style="flex:1;color:var(--red);">&#9888; Deleted topping &mdash; remove this row</span><span style="color:var(--text3);">${t.amount}</span>`;
    return `<div style="display:flex;align-items:center;gap:6px;padding:4px 0;font-size:13px;">
      ${nameCell}
      <button class="btn btn-sm btn-danger" onclick="removeCateringTopping('${c.id}',${i})">&times;</button>
    </div>`;
  }).join('');
}

export function cateringToppingOptions(c: any): string {
  const used = new Set(((c?.toppings || []) as Array<{ supplyId: string }>).map(t => t.supplyId));
  const opts = (S.supplies || []).filter(s => !s.archived && !used.has(s.id));
  if (opts.length === 0) return '<option value="">— no toppings or bread available —</option>';
  return '<option value="">— pick an item —</option>' +
    opts.map(s => `<option value="${esc(s.id)}">${esc(s.name)} (${esc(s.unit)})</option>`).join('');
}

export function addCateringTopping(cateringId: any): void {
  const c = S.caterings.find(x => x.id === cateringId);
  if (!c) return;
  const supplyId = (document.getElementById('ct-topping-pick') as HTMLSelectElement).value;
  const amount = parseFloat((document.getElementById('ct-topping-amount') as HTMLInputElement).value);
  if (!supplyId) { alert('Pick an item'); return; }
  if (!Number.isFinite(amount) || amount <= 0) { alert('Enter a positive amount'); return; }
  if (!c.toppings) c.toppings = [];
  c.toppings.push({ supplyId, amount });
  scheduleSave();
  openEditCatering(cateringId);
}

export function removeCateringTopping(cateringId: any, index: any): void {
  const c = S.caterings.find(x => x.id === cateringId);
  if (!c || !c.toppings) return;
  c.toppings.splice(index, 1);
  scheduleSave();
  openEditCatering(cateringId);
}

export function renderCateringDishList(c: any) {
  if (!c.dishes || c.dishes.length === 0) return '<div style="font-size:12px;color:var(--text3);">No batches yet</div>';
  return c.dishes.map((d: any, i: any) => {
    const dish = S.batches.find(x => x.id === d.dishId);
    const serving = dish ? (dish.serving || 280) : 280;
    const peers = (c.dishes || []).filter(cd => cd.type === d.type).length;
    const liters = Math.round(((c.guestCount || 0) / Math.max(peers, 1)) * serving / 1000 * 10) / 10;
    return `<div style="display:flex;align-items:center;gap:6px;padding:4px 0;">
    ${typeBadge(d.type || 'Soup')}
    <span style="font-size:13px;flex:1;">${esc(d.name)}</span>
    <span style="font-size:12px;color:var(--text2);" title="${c.guestCount} guests${peers > 1 ? ' ÷ ' + peers + ' ' + d.type + 's' : ''} × ${serving}ml">${liters}L</span>
    <button class="btn btn-sm btn-danger" onclick="removeCateringDish('${c.id}',${i})">×</button>
  </div>`;
  }).join('');
}

export function openAddCateringDish(cateringId: any) {
  renderCateringDishPicker(cateringId, '');
}

export function renderCateringDishPicker(cateringId: any, query: any) {
  const c = S.caterings.find(x => x.id === cateringId);
  const alreadyAdded = new Set((c?.dishes || []).map(d => d.dishId));
  const q = query.toLowerCase();

  const available = S.batches
    .filter(d => !alreadyAdded.has(d.id))
    .filter(d => !q || d.name.toLowerCase().includes(q));

  let list = '';

  const SHOW_LIMIT = 100;
  const truncated = available.length > SHOW_LIMIT;

  if (available.length > 0) {
    list += available.slice(0, SHOW_LIMIT).map(d => {
      const { str, cls } = diffStr(d);
      const stockLoc = batchStockLocLabel(d);
      const cookStatus = isBatchCooked(d) ? 'Cooked' : d.cookDate ? 'Cook: ' + d.cookDate : '';
      const serving = d.serving || 280;
      const sameTypePeers = (c.dishes || []).filter(cd => cd.type === d.type).length + 1;
      const cateringLiters = Math.round(((c.guestCount || 0) / sameTypePeers) * serving / 1000 * 10) / 10;
      return `<div class="dish-opt" onclick="addCateringDishFromPlanner('${cateringId}','${d.id}')">
        <div style="flex:1;">
          <div><span style="font-weight:500;">${esc(d.name)}</span> ${typeBadge(d.type)}</div>
          <div style="font-size:11px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:2px;">
            <span style="font-weight:600;">${getTotalStock(d)}L stock</span>
            <span class="${cls}">${str}</span>
            <span style="font-size:10px;color:var(--text2);">${esc(stockLoc)}</span>
            <span style="color:var(--text3);">+${cateringLiters}L for this catering</span>
            ${cookStatus ? `<span style="color:var(--text3);">${cookStatus}</span>` : ''}
          </div>
        </div>
      </div>`;
    }).join('');
    if (truncated) {
      list += `<div style="padding:8px 12px;font-size:12px;color:var(--text3);text-align:center;">Showing first ${SHOW_LIMIT} of ${available.length} — type to search for more…</div>`;
    }
  }

  if (!list) list = `<div class="empty">No planned batches found${q ? ' matching "' + esc(q) + '"' : ''}</div>`;

  // If modal already open, only update the list
  const existingList = document.getElementById('ct-dish-list');
  if (existingList) {
    existingList.innerHTML = list;
    return;
  }

  showModal(`<h3>Add batch to catering</h3>
    <input type="text" class="dish-search" id="ct-dish-search" placeholder="Search planned batches..." value="${esc(query)}"
      oninput="renderCateringDishPicker('${cateringId}',(document.getElementById('ct-dish-search')||{}).value||'')" />
    <div class="dish-opts-list" style="max-height:300px;" id="ct-dish-list">${list}</div>
    <div class="modal-actions"><button class="btn" onclick="openEditCatering('${cateringId}')">Back</button></div>`);
  const si = document.getElementById('ct-dish-search');
  if (si) si.focus();
}

export function addCateringDishFromPlanner(cateringId: any, dishId: any) {
  const c = S.caterings.find(x => x.id === cateringId);
  const d = S.batches.find(x => x.id === dishId);
  if (!c || !d) return;
  if (!c.dishes) c.dishes = [];
  c.dishes.push({ dishId: d.id, name: d.name, type: d.type || 'Soup' });
  scheduleSave();
  openEditCatering(cateringId);
}

export function removeCateringDish(cateringId: any, index: any) {
  const c = S.caterings.find(x => x.id === cateringId);
  if (!c || !c.dishes) return;
  c.dishes.splice(index, 1);
  scheduleSave();
  openEditCatering(cateringId);
}


export function saveEditCatering(id: any) {
  const c = S.caterings.find(x => x.id === id);
  if (!c) return;
  c.name = (document.getElementById('ct-name') as HTMLInputElement).value.trim() || c.name;
  const dateInput = (document.getElementById('ct-date') as HTMLInputElement).value;
  c.date = dateInput ? isoToCookDate(dateInput) : null;
  c.guestCount = parseInt((document.getElementById('ct-guests') as HTMLInputElement).value) || 50;
  c.deliveryMode = (document.getElementById('ct-delivery') as HTMLSelectElement).value;
  c.logisticsNotes = (document.getElementById('ct-notes') as HTMLTextAreaElement).value.trim();
  closeModal(); renderCateringList(); scheduleSave();
  toast('Catering saved');
}

export function deleteCatering(id: any) {
  const c = S.caterings.find(x => x.id === id);
  if (!c) return;
  const deleted = structuredClone(c);
  S.caterings = S.caterings.filter(x => x.id !== id);
  closeModal(); renderCateringList();
  pushUndo({
    label: esc(c.name || 'Catering') + ' deleted',
    restore: () => { S.caterings.push(deleted); renderCateringList(); },
    commit: () => { scheduleSave(); },
  });
}
