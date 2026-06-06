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
/** All stockable drinks at the location (for a by-area full count). */
function allStockableDrinks(): Drink[] {
  return (S.drinks || []).filter(d => !d.archived).sort((a, b) =>
    a.category === b.category ? a.name.localeCompare(b.name) : a.category.localeCompare(b.category));
}

export function renderDrinksStocktakeTab(): void {
  const body = document.getElementById('drinks-tab-body');
  if (!body) return;
  if (_supplier || _area) { renderCountView(); return; }
  if (_started) { renderChooser(); return; }
  renderOverview();
}

/** Landing view: current drink stock for one location (toggle), grouped by
 *  category — like the ingredient list — with a "Start stocktake" button that
 *  drops into the by-area count flow (stocktake #1). */
function renderOverview(): void {
  const body = document.getElementById('drinks-tab-body');
  if (!body) return;
  const locLabel = DRINK_LOCATIONS.find(l => l.key === loc())?.label || loc();
  const items = (S.drinks || []).filter(d => !d.archived && (d.locations?.[loc()]?.active !== false));
  const groups = new Map<string, Drink[]>();
  for (const d of items) { const g = groups.get(d.category) || []; g.push(d); groups.set(d.category, g); }
  const cats = [...groups.keys()].sort((a, b) => a.localeCompare(b));
  const listHtml = cats.length === 0
    ? '<div class="drinks-empty">No drinks for this location.</div>'
    : cats.map(cat => {
        const rows = (groups.get(cat) || []).sort((a, b) => a.name.localeCompare(b.name));
        return `<tbody class="stk-ov-group"><tr class="stk-ov-cat"><td colspan="3">${esc(drinkCategoryLabel(cat))}</td></tr>
          ${rows.map(d => {
            const pool = d.stockByLocation?.[loc()];
            const par = d.locations?.[loc()]?.par;
            const low = par != null && pool != null && pool < par;
            return `<tr data-testid="stk-ov-row"><td>${esc(d.name)}</td>
              <td class="num muted">${esc(d.orderUnit || 'unit')}</td>
              <td class="num ${low ? 'stk-low' : ''}">${pool != null ? round1(pool) : '—'}${par != null ? ` <span class="muted">/ ${round1(par)}</span>` : ''}</td></tr>`;
          }).join('')}</tbody>`;
      }).join('');
  body.innerHTML = `
    <div class="stk-overview">
      <div class="drinks-toolbar">
        <div class="drinks-loc-toggle" data-testid="stk-loc-toggle">
          ${DRINK_LOCATIONS.map(l => `<button class="lc ${loc() === l.key ? 'on' : ''}" data-loc="${l.key}" onclick="drinksStkSetLoc('${l.key}')">${esc(l.label)}</button>`).join('')}
        </div>
        <button class="btn btn-primary" data-testid="stk-start" onclick="drinksStkStart()">📋 Start stocktake</button>
      </div>
      <p class="muted small">Current stock at ${esc(locLabel)} (stock / needed). Tap “Start stocktake” to count by storage area.</p>
      <div class="drinks-table-wrap"><table class="drinks-table stk-ov-table">
        <thead><tr><th>Drink</th><th class="num">Unit</th><th class="num">Stock</th></tr></thead>
        ${listHtml}
      </table></div>
    </div>`;
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
  return _supplier ? drinksForSupplier(_supplier) : allStockableDrinks();
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
