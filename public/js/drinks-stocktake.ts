// ─────────────────────────────────────────────────────────────────────────────
// DRINKS — Stocktake tab (M4). Supplier-cycle counting (primary) or by storage
// area (secondary): pick → list drinks for this location → enter counts in
// order/supplier units → bulk save. Mobile-first: big inputs, sticky save.
// Per DRINKS_DOMAIN §5.
// ─────────────────────────────────────────────────────────────────────────────

import { S } from './state';
import { apiPost, toast, toastError, loadDrinks } from './utils';
import { esc } from './modal';
import { drinkAreasFor, drinkCategoryLabel, DRINK_LOCATIONS } from './drinks-constants';
import type { Drink, DrinkSupplier } from '@shared/types';

let _started = false; // false = stock-list overview; true = in the count flow
let _mode: 'supplier' | 'area' = 'area';
let _supplier: string | null = null;
let _area: string | null = null;
let _values: Record<string, number | undefined> = {};
let _loc = ''; // overview/count location; defaults to the global location

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function loc(): string { return _loc || S.currentLoc || 'west'; }
function round1(n: number): number { return Math.round(n * 10) / 10; }

/** Suppliers ordered with today/tomorrow order-days first ("due" surfaced). */
function suppliersByDue(): { sup: DrinkSupplier; due: boolean }[] {
  const today = WEEKDAYS[new Date().getDay()];
  const tomorrow = WEEKDAYS[(new Date().getDay() + 1) % 7];
  const list = (S.drinkSuppliers || []).map(sup => ({
    sup,
    due: (sup.orderDays || []).some(d => d === today || d === tomorrow),
  }));
  return list.sort((a, b) => (a.due === b.due ? a.sup.name.localeCompare(b.sup.name) : (a.due ? -1 : 1)));
}

/** Drinks counted for a supplier at the current location (active, not archived). */
function drinksForSupplier(name: string): Drink[] {
  return (S.drinks || []).filter(d => d.supplier === name && !d.archived
    && (d.locations?.[loc()]?.active !== false))
    .sort((a, b) => a.name.localeCompare(b.name));
}
/** Drinks whose home storage area at this location is `area` (active, not
 *  archived) — so "count by area" lists only that area's drinks, not all. */
function drinksForArea(area: string): Drink[] {
  return (S.drinks || []).filter(d => !d.archived
    && (d.locations?.[loc()]?.active !== false)
    && (d.locations?.[loc()]?.area || '') === area)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function renderDrinksStocktakeTab(): void {
  const body = document.getElementById('drinks-tab-body');
  if (!body) return;
  if (_supplier || _area) { renderCountView(); return; }
  if (_started) { renderChooser(); return; }
  renderOverview();
}

/** A distinct colour per storage area (by its position in the location's area
 *  list); Unassigned falls back to grey. */
const STK_AREA_PALETTE = ['#7c3aed', '#2563eb', '#0891b2', '#059669', '#d97706', '#dc2626', '#db2777', '#65a30d'];
function areaColor(area: string): string {
  const i = drinkAreasFor(loc()).indexOf(area);
  return i >= 0 ? STK_AREA_PALETTE[i % STK_AREA_PALETTE.length] : '#9ca3af';
}

function stkStatusHtml(stock: number | null, par: number | null): string {
  if (par == null) return '<span class="muted">—</span>';
  if (stock == null) return '<span class="muted">count?</span>';
  if (stock >= par) return '<span class="stk-ok">✓ enough</span>';
  return `<span class="stk-short">short ${round1(par - stock)}</span>`;
}

function stkOvRow(d: Drink, saveArea: string): string {
  const l = loc();
  const pool = d.stockByLocation?.[l] ?? null;
  const par = d.locations?.[l]?.par ?? null;
  const home = d.locations?.[l]?.area || '';
  const val = pool != null ? String(round1(pool)) : '';
  const areaOpts = ['<option value="">— area —</option>', ...drinkAreasFor(l).map(a => `<option value="${esc(a)}" ${a === home ? 'selected' : ''}>${esc(a)}</option>`)].join('');
  return `<tr data-testid="stk-ov-row">
    <td><button class="stk-ov-name linklike" type="button" onclick="openDrinkForm('${esc(d.id)}')">${esc(d.name)}</button>${d.subtype ? `<div class="muted small">${esc(d.subtype)}</div>` : ''}</td>
    <td><select class="stk-ov-area" onchange="drinkStkSetArea('${esc(d.id)}', this.value)">${areaOpts}</select></td>
    <td class="num">${par != null ? round1(par) : '<span class="muted">—</span>'}</td>
    <td class="num"><input class="stk-ov-input" data-id="${esc(d.id)}" data-area="${esc(saveArea)}" data-par="${par != null ? par : ''}" type="number" min="0" step="0.5" value="${val}" placeholder="—" oninput="drinksStkOvStatus(this)" onchange="drinkStkSaveOne(this)"></td>
    <td class="stk-status">${stkStatusHtml(pool, par)}</td>
  </tr>`;
}

/** Landing view: editable stock for one location, grouped by storage area with
 *  distinctive colours (like the food orders tab). Fill "In stock" inline and
 *  save; names link to the editor. "Count by area" opens the focused flow. */
function renderOverview(): void {
  const body = document.getElementById('drinks-tab-body');
  if (!body) return;
  const l = loc();
  const locLabel = DRINK_LOCATIONS.find(x => x.key === l)?.label || l;
  const items = (S.drinks || []).filter(d => !d.archived && (d.locations?.[l]?.active !== false));
  const groups = new Map<string, Drink[]>();
  for (const d of items) { const a = d.locations?.[l]?.area || ''; const g = groups.get(a) || []; g.push(d); groups.set(a, g); }
  const areaOrder = drinkAreasFor(l);
  const fallbackArea = areaOrder[0] || 'Drinks Storage';
  const keys = [...groups.keys()].sort((a, b) => {
    if (a === '') return 1; if (b === '') return -1;
    const ia = areaOrder.indexOf(a), ib = areaOrder.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  const sectionsHtml = keys.length === 0
    ? '<div class="drinks-empty">No drinks active for this location.</div>'
    : keys.map(area => {
        const rows = (groups.get(area) || []).sort((a, b) => a.name.localeCompare(b.name));
        const color = area ? areaColor(area) : '#9ca3af';
        const label = area || 'Unassigned — set a storage area';
        const saveArea = area || fallbackArea;
        return `<div class="stk-area-group" style="--area-color:${color}">
          <div class="stk-area-head"><span class="stk-area-dot"></span>${esc(label)} <span class="muted small">${rows.length}</span></div>
          <div class="drinks-table-wrap"><table class="drinks-table stk-ov-table">
            <thead><tr><th>Drink</th><th>Area</th><th class="num">Needed</th><th class="num">In stock</th><th>Status</th></tr></thead>
            <tbody>${rows.map(d => stkOvRow(d, saveArea)).join('')}</tbody>
          </table></div>
        </div>`;
      }).join('');
  body.innerHTML = `
    <div class="stk-overview">
      <div class="drinks-toolbar">
        <div class="drinks-loc-toggle" data-testid="stk-loc-toggle">
          ${DRINK_LOCATIONS.map(x => `<button class="lc ${l === x.key ? 'on' : ''}" data-loc="${x.key}" onclick="drinksStkSetLoc('${x.key}')">${esc(x.label)}</button>`).join('')}
        </div>
        <button class="btn" data-testid="stk-start" onclick="drinksStkStart()">📋 Count by area</button>
      </div>
      <p class="muted small">Stock at ${esc(locLabel)}, grouped by storage area. Change a count and it saves automatically; set each drink's area inline; tap a name to edit. Or use “Count by area” for a focused count.</p>
      ${sectionsHtml}
    </div>`;
}

/** Live-update one row's status as the count is typed. */
export function drinksStkOvStatus(input: HTMLInputElement): void {
  const par = input.dataset.par === '' || input.dataset.par == null ? null : Number(input.dataset.par);
  const stock = input.value === '' ? null : Number(input.value);
  const cell = input.closest('tr')?.querySelector('.stk-status');
  if (cell) cell.innerHTML = stkStatusHtml(stock, par);
}

/** Auto-save a single count when its cell changes (blur). Saves to the drink's
 *  home area (or the group's fallback) and refreshes that row's status. */
export async function drinkStkSaveOne(input: HTMLInputElement): Promise<void> {
  if (input.value === '') return; // blank = not counted
  const qty = Number(input.value);
  if (!Number.isFinite(qty) || qty < 0) { toastError('Enter a number ≥ 0.'); return; }
  const area = input.dataset.area as string;
  const drinkId = input.dataset.id as string;
  try {
    await apiPost('/api/drinks/stock/bulk', { location: loc(), area, items: [{ drinkId, qty }] });
    input.classList.add('stk-saved');
    setTimeout(() => input.classList.remove('stk-saved'), 900);
    await loadDrinks();
    const d = (S.drinks || []).find(x => x.id === drinkId);
    const pool = d?.stockByLocation?.[loc()] ?? qty;
    const par = input.dataset.par === '' || input.dataset.par == null ? null : Number(input.dataset.par);
    const cell = input.closest('tr')?.querySelector('.stk-status');
    if (cell) cell.innerHTML = stkStatusHtml(pool, par);
  } catch (e: unknown) {
    toastError('Could not save: ' + (e instanceof Error ? e.message : 'Unknown error'));
  }
}

/** Set a drink's home storage area inline from the list; re-renders so the row
 *  moves to its colour-coded group. */
export async function drinkStkSetArea(id: string, area: string): Promise<void> {
  const d = (S.drinks || []).find(x => x.id === id);
  if (!d) return;
  const l = loc();
  const prev = d.locations?.[l]?.area;
  d.locations = { ...(d.locations || {}), [l]: { par: d.locations?.[l]?.par ?? null, active: d.locations?.[l]?.active !== false, area: area || undefined } };
  renderDrinksStocktakeTab();
  try {
    await apiPost(`/api/drinks/${id}/area`, { location: l, area }, 'PATCH');
  } catch (e: unknown) {
    d.locations = { ...(d.locations || {}), [l]: { par: d.locations?.[l]?.par ?? null, active: d.locations?.[l]?.active !== false, area: prev } };
    renderDrinksStocktakeTab();
    toastError('Could not set area: ' + (e instanceof Error ? e.message : 'Unknown error'));
  }
}

/** The area/supplier picker — reached via "Start stocktake". */
function renderChooser(): void {
  const body = document.getElementById('drinks-tab-body');
  if (!body) return;
  const sups = suppliersByDue();
  const areas = drinkAreasFor(loc());
  const locLabel = DRINK_LOCATIONS.find(l => l.key === loc())?.label || loc();
  body.innerHTML = `
    <div class="stk-chooser">
      <div class="stk-count-head">
        <button class="btn btn-sm" onclick="drinksStkExit()">← Back</button>
        <h3>Stocktake — ${esc(locLabel)}</h3>
      </div>
      <div class="stk-mode">
        <button class="fc ${_mode === 'area' ? 'on' : ''}" onclick="drinksStkSetMode('area')">By storage area</button>
        <button class="fc ${_mode === 'supplier' ? 'on' : ''}" onclick="drinksStkSetMode('supplier')">By supplier</button>
      </div>
      <p class="muted small">Pick ${_mode === 'supplier' ? 'a supplier to count its delivery' : 'a storage area to count'}.</p>
      <div class="stk-grid">
        ${_mode === 'supplier'
          ? sups.map(({ sup, due }) => `<button class="stk-pick" data-testid="stk-supplier" onclick="drinksStkPickSupplier('${esc(sup.name)}')">
              <span>${esc(sup.name)}${due ? ' <span class="stk-due">due</span>' : ''}</span>
              <span class="muted small">${drinksForSupplier(sup.name).length} drinks</span>
            </button>`).join('')
          : areas.map(a => `<button class="stk-pick" data-testid="stk-area" onclick="drinksStkPickArea('${esc(a)}')">
              <span>${esc(a)}</span><span>→</span>
            </button>`).join('')}
      </div>
    </div>`;
}

export function drinksStkStart(): void { _started = true; _mode = 'area'; renderDrinksStocktakeTab(); }
export function drinksStkExit(): void { _started = false; _supplier = null; _area = null; renderDrinksStocktakeTab(); }
export function drinksStkSetLoc(l: string): void { _loc = l; _values = {}; renderDrinksStocktakeTab(); }
export function drinksStkSetMode(m: string): void { _mode = m === 'area' ? 'area' : 'supplier'; renderDrinksStocktakeTab(); }
export function drinksStkPickSupplier(name: string): void { _supplier = name; _area = drinkAreasFor(loc())[0]; _values = {}; renderCountView(); }
export function drinksStkPickArea(area: string): void { _area = area; _supplier = null; _values = {}; renderCountView(); }
export function drinksStkBack(): void { _supplier = null; _area = null; _values = {}; renderDrinksStocktakeTab(); }

function countList(): Drink[] {
  return _supplier ? drinksForSupplier(_supplier) : (_area ? drinksForArea(_area) : []);
}

function renderCountView(): void {
  const body = document.getElementById('drinks-tab-body');
  if (!body) return;
  const items = countList();
  const areas = drinkAreasFor(loc());
  const title = _supplier ? esc(_supplier) : esc(_area || '');
  body.innerHTML = `
    <div class="stk-count">
      <div class="stk-count-head">
        <button class="btn btn-sm" onclick="drinksStkBack()">← Back</button>
        <h3>${title}</h3>
        ${_supplier ? `<label class="stk-area-sel">Area
          <select onchange="drinksStkSetArea(this.value)">${areas.map(a => `<option value="${esc(a)}" ${a === _area ? 'selected' : ''}>${esc(a)}</option>`).join('')}</select>
        </label>` : ''}
      </div>
      <p class="muted small">Count in order units (${_supplier ? 'this supplier' : 'this area'}). Blank = not counted; 0 = counted empty.</p>
      <div class="stk-rows" data-testid="stk-rows">
        ${items.length === 0 ? '<div class="drinks-empty">No drinks here.</div>' : items.map(d => stkRow(d)).join('')}
      </div>
      <div class="stk-savebar">
        <button class="btn btn-primary" data-testid="stk-save" onclick="drinksStkSave()">Save counts</button>
      </div>
    </div>`;
}

function stkRow(d: Drink): string {
  const pool = d.stockByLocation?.[loc()];
  const prefill = _values[d.id] !== undefined ? String(_values[d.id]) : '';
  return `<div class="stk-row" data-id="${esc(d.id)}">
    <div class="stk-row-name"><span>${esc(d.name)}</span><span class="muted small">${esc(drinkCategoryLabel(d.category))} · ${esc(d.orderUnit || 'unit')}${pool != null ? ` · now ${round1(pool)}` : ''}</span></div>
    <input class="stk-input" type="number" min="0" step="0.5" value="${prefill}" placeholder="—" data-id="${esc(d.id)}" oninput="drinksStkInput('${esc(d.id)}', this.value)">
  </div>`;
}

export function drinksStkSetArea(area: string): void { _area = area; }
export function drinksStkInput(id: string, v: string): void { _values[id] = v === '' ? undefined : Number(v); }

export async function drinksStkSave(): Promise<void> {
  const area = _area || drinkAreasFor(loc())[0];
  const itemsToSave = Object.entries(_values)
    .filter(([, v]) => v !== undefined && Number.isFinite(v as number))
    .map(([drinkId, qty]) => ({ drinkId, qty: qty as number }));
  if (itemsToSave.length === 0) { toastError('Nothing counted yet.'); return; }
  try {
    await apiPost('/api/drinks/stock/bulk', { location: loc(), area, items: itemsToSave });
    toast(`${itemsToSave.length} counts saved`);
    _values = {};
    await loadDrinks();
    renderCountView();
  } catch (e: unknown) {
    toastError('Could not save: ' + (e instanceof Error ? e.message : 'Unknown error'));
  }
}
