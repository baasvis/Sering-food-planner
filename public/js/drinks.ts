// ─────────────────────────────────────────────────────────────────────────────
// DRINKS SCREEN — one nav screen with internal sub-tabs (mirrors planner /
// orders). M2 ships the Catalogue + Suppliers tabs; later milestones add
// Recipes / Stocktake / Orders / Production / Bar / Menus.
//
// Search/Filter Input Rule: the catalogue search box is rendered once in the
// tab shell; keystrokes update only #drinks-cat-results.
// ─────────────────────────────────────────────────────────────────────────────

import { S } from './state';
import { newId, apiPost, toast, toastError, loadDrinks, loadDrinkSuppliers } from './utils';
import { showModal, closeModal, esc } from './modal';
import { pushUndo } from './undo';
import { registerRenderer } from './navigate';
import {
  DRINK_LOCATIONS, DRINK_GLASS_TYPES, DRINK_SERVING_TEMPS, DRINK_CATALOGUE_CATEGORIES,
  NON_SELLABLE_CATEGORIES, drinkCategoryLabel,
} from './drinks-constants';
import {
  makeCostContext, drinkTotalCostExBtw, effectiveBtw, targetMarkupFor, actualMarkup,
} from '@shared/drink-cost';
import type { CostContext } from '@shared/drink-cost';
import { renderRecipesTab } from './drinks-recipe';
import { renderDrinksStocktakeTab } from './drinks-stocktake';
import { renderDrinksOrdersTab } from './drinks-order';
import { renderDrinksProductionTab } from './drinks-production';
import { renderDrinksBarTab } from './drinks-service';
import { renderDrinksMenusTab } from './drinks-menu';
import type { Drink, DrinkServingFormat, DrinkSupplier } from '@shared/types';

function isManager(): boolean { return !!S.user?.isManager; }

/** Tabs implemented so far — extended each milestone. */
function drinkTabs(): { key: string; label: string }[] {
  return [
    { key: 'catalogue', label: 'Catalogue' },
    { key: 'bar', label: 'Bar' },
    { key: 'recipes', label: 'Recipes' },
    { key: 'stocktake', label: 'Stocktake' },
    { key: 'orders', label: 'Orders' },
    { key: 'production', label: 'Production' },
    { key: 'menus', label: 'Menus' },
    { key: 'suppliers', label: 'Suppliers' },
  ];
}

// ── Screen render ────────────────────────────────────────────────────────────

export function renderDrinks(): void {
  const tabs = drinkTabs();
  if (!tabs.some(t => t.key === S.drinksSubTab)) S.drinksSubTab = 'catalogue';
  const el = document.getElementById('screen-drinks');
  if (!el) return;
  el.innerHTML = `
    <div class="drinks-tabs" role="tablist">
      ${tabs.map(t => `<button class="drinks-tab ${S.drinksSubTab === t.key ? 'on' : ''}" data-testid="drinks-tab-${t.key}" onclick="drinksSetTab('${t.key}')">${esc(t.label)}</button>`).join('')}
    </div>
    <div id="drinks-tab-body"></div>`;
  renderDrinkTabBody();
}

export function drinksSetTab(tab: string): void {
  S.drinksSubTab = tab;
  document.querySelectorAll('.drinks-tabs .drinks-tab').forEach(b => {
    b.classList.toggle('on', (b as HTMLElement).dataset.testid === `drinks-tab-${tab}`);
  });
  renderDrinkTabBody();
}

function renderDrinkTabBody(): void {
  const body = document.getElementById('drinks-tab-body');
  if (!body) return;
  if (S.drinksSubTab === 'bar') { renderDrinksBarTab(); return; }
  if (S.drinksSubTab === 'recipes') { renderRecipesTab(); return; }
  if (S.drinksSubTab === 'stocktake') { renderDrinksStocktakeTab(); return; }
  if (S.drinksSubTab === 'orders') { renderDrinksOrdersTab(); return; }
  if (S.drinksSubTab === 'production') { renderDrinksProductionTab(); return; }
  if (S.drinksSubTab === 'menus') { renderDrinksMenusTab(); return; }
  if (S.drinksSubTab === 'suppliers') { body.innerHTML = suppliersHtml(); return; }
  body.innerHTML = catalogueShellHtml();
  updateCatalogueResults();
}

// ── Catalogue tab ────────────────────────────────────────────────────────────

/** Categories that actually have catalogue drinks, for the filter bar. */
function catalogueCategoriesPresent(): { key: string; label: string }[] {
  const present = new Set((S.drinks || []).filter(d => d.mode === 'catalogue').map(d => d.category));
  return DRINK_CATALOGUE_CATEGORIES.filter(c => present.has(c.key)).map(c => ({ key: c.key, label: c.label }));
}

/** Show inactive-at-location drinks too (off by default so the location view is
 *  clean; on so a manager can re-activate a hidden drink — see catalogue #7). */
let _showInactive = false;

function catalogueShellHtml(): string {
  const f = S.drinksFilters;
  const cats = catalogueCategoriesPresent();
  return `
    <div class="drinks-toolbar">
      ${isManager() ? `<button class="btn btn-primary" data-testid="drink-add-btn" onclick="openDrinkForm()">+ Add drink</button>` : ''}
      <input class="drinks-search" id="drinks-cat-search" data-testid="drinks-search" placeholder="Search drinks…" value="${esc(S.drinksSearch)}" oninput="drinksSetCatSearch(this.value)">
      <div class="drinks-loc-toggle" data-testid="drinks-loc-toggle">
        ${DRINK_LOCATIONS.map(l => `<button class="lc ${f.location === l.key ? 'on' : ''}" data-loc="${l.key}" onclick="drinksSetCatLocation('${l.key}')">${esc(l.label)}</button>`).join('')}
      </div>
      <label class="drinks-show-inactive"><input type="checkbox" ${_showInactive ? 'checked' : ''} onchange="drinksToggleShowInactive(this.checked)"> Show inactive</label>
    </div>
    <div class="drinks-filter-bar">
      <button class="fc ${f.category === 'all' ? 'on' : ''}" onclick="drinksSetCatCategory('all')">All</button>
      ${cats.map(c => `<button class="fc ${f.category === c.key ? 'on' : ''}" onclick="drinksSetCatCategory('${c.key}')">${esc(c.label)}</button>`).join('')}
    </div>
    <div id="drinks-cat-results"></div>`;
}

export function drinksSetCatSearch(v: string): void {
  S.drinksSearch = v;
  updateCatalogueResults();
}

export function drinksSetCatCategory(cat: string): void {
  S.drinksFilters.category = cat;
  // Update only the filter pills + results (don't recreate the search input).
  document.querySelectorAll('.drinks-filter-bar .fc').forEach(b => {
    const oc = (b as HTMLElement).getAttribute('onclick') || '';
    b.classList.toggle('on', oc.includes(`'${cat}'`));
  });
  updateCatalogueResults();
}

/** West/Centraal toggle: scope the Needed/Stock/Price/Cost columns to one
 *  location and hide drinks not active there. Updates only the toggle highlight
 *  + results (search input stays put per the Search/Filter rule). */
export function drinksSetCatLocation(loc: string): void {
  S.drinksFilters.location = loc;
  document.querySelectorAll('.drinks-loc-toggle .lc').forEach(b => {
    b.classList.toggle('on', (b as HTMLElement).dataset.loc === loc);
  });
  updateCatalogueResults();
}

export function drinksToggleShowInactive(on: boolean): void {
  _showInactive = on;
  updateCatalogueResults();
}

/** Active at a location: explicit `active:false` hides it; missing entry = active. */
function activeAtLoc(d: Drink, loc: string): boolean {
  return d.locations?.[loc]?.active !== false;
}

/** Price summary for a drink at the current location: "glass €5.50 · bottle €30". */
function formatPriceSummary(d: Drink, loc: string): string {
  const parts = (d.formats || [])
    .map(fmt => {
      const p = fmt.price?.[loc];
      return p != null ? `${esc(fmt.name)} €${p.toFixed(2)}` : null;
    })
    .filter(Boolean);
  return parts.length ? parts.join(' · ') : '<span class="muted">—</span>';
}

export function updateCatalogueResults(): void {
  const container = document.getElementById('drinks-cat-results');
  if (!container) return;
  const loc = S.drinksFilters.location || 'west';
  const mgr = isManager();
  let list = (S.drinks || []).filter(d => d.mode === 'catalogue');
  if (S.drinksFilters.category !== 'all') list = list.filter(d => d.category === S.drinksFilters.category);
  if (!_showInactive) list = list.filter(d => activeAtLoc(d, loc));
  const q = S.drinksSearch.trim().toLowerCase();
  if (q) {
    list = list.filter(d =>
      d.name.toLowerCase().includes(q)
      || (d.subtype || '').toLowerCase().includes(q)
      || (d.supplier || '').toLowerCase().includes(q));
  }
  list = [...list].sort((a, b) => a.category === b.category ? a.name.localeCompare(b.name) : a.category.localeCompare(b.category));

  const locLabel = DRINK_LOCATIONS.find(l => l.key === loc)?.label || loc;

  if (list.length === 0) {
    container.innerHTML = `<div class="drinks-empty">No drinks${q ? ' match your search' : (_showInactive ? '' : ` active at ${esc(locLabel)}`)}.</div>`;
    return;
  }

  const ctx = S.drinkConfig ? makeCostContext(S.drinks || [], [], S.drinkConfig) : null;

  const rows = list.map(d => {
    const stock = d.stockByLocation?.[loc];
    const par = d.locations?.[loc]?.par;
    const active = activeAtLoc(d, loc);
    const btw = effBtw(d);
    const cp = ctx ? catalogueCostPct(d, loc, ctx) : null;
    const costCell = cp
      ? `<span class="${cp.over ? 'cost-over' : 'cost-ok'}" title="cost as % of price — target ≤ ${cp.targetPct.toFixed(0)}%">${cp.pct.toFixed(0)}%</span>`
      : '<span class="muted">—</span>';
    return `<tr data-testid="drink-row" data-id="${esc(d.id)}" class="${active ? '' : 'drink-inactive'}">
      <td class="drink-name">${esc(d.name)}${d.status === 'published' ? ' <span class="drink-pub" title="Published">●</span>' : ''}${d.subtype ? `<div class="muted small">${esc(d.subtype)}</div>` : ''}</td>
      <td>${esc(drinkCategoryLabel(d.category))}</td>
      <td>${esc(d.supplier || '—')}</td>
      <td class="num">${d.abv ? round1(d.abv) + '%' : '—'}</td>
      <td class="num" title="BTW">${btw}%</td>
      <td class="num" title="target level (par) @ ${esc(locLabel)}">${par != null ? round1(par) : '<span class="muted">–</span>'}</td>
      <td class="num" title="in stock @ ${esc(locLabel)}">${stock != null ? round1(stock) : '<span class="muted">–</span>'}</td>
      <td>${formatPriceSummary(d, loc)}</td>
      <td class="num">${costCell}</td>
      <td class="num"><input type="checkbox" class="drink-active-cb" data-testid="drink-active-cb" ${active ? 'checked' : ''} ${mgr ? '' : 'disabled'} onchange="drinkToggleActive('${esc(d.id)}')" title="Active at ${esc(locLabel)}"></td>
      ${mgr ? `<td class="drink-actions">
        <button class="btn btn-sm" data-testid="drink-edit-btn" onclick="openDrinkForm('${esc(d.id)}')">Edit</button>
        <button class="btn btn-sm btn-danger" onclick="deleteDrink('${esc(d.id)}')">✕</button>
      </td>` : ''}
    </tr>`;
  }).join('');

  container.innerHTML = `
    <div class="drinks-table-wrap">
      <table class="drinks-table" data-testid="drinks-catalogue-table">
        <thead><tr>
          <th>Name</th><th>Category</th><th>Supplier</th><th class="num">Alcohol %</th>
          <th class="num">BTW</th><th class="num" title="target level to keep on hand">Needed</th>
          <th class="num">Stock</th><th>Price (${esc(locLabel)})</th>
          <th class="num" title="cost as % of sales price">Cost %</th><th class="num">Active</th>
          ${mgr ? '<th></th>' : ''}
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

/** Cost as % of (ex-BTW) sales price for a catalogue drink at loc, with the
 *  category target % and whether we're over it (cost too high → red). Uses the
 *  same serve format the cost engine picks. Null when not derivable. */
function catalogueCostPct(d: Drink, loc: string, ctx: CostContext): { pct: number; targetPct: number; over: boolean } | null {
  const cfg = S.drinkConfig;
  if (!cfg) return null;
  const costExBtw = drinkTotalCostExBtw(d, ctx, loc);
  if (!(costExBtw > 0)) return null;
  const fmts = d.formats || [];
  const priced = fmts.find(f => f.price?.[loc] != null) || fmts[0];
  const priceInclBtw = priced?.price?.[loc];
  if (priceInclBtw == null) return null;
  const btw = effectiveBtw(d.abv, d.btwRate, cfg);
  const mk = actualMarkup(priceInclBtw, btw, costExBtw);
  if (mk == null || mk <= 0) return null;
  const pct = 100 / mk;
  const target = targetMarkupFor(d.category, cfg);
  const targetPct = target > 0 ? 100 / target : 100;
  return { pct, targetPct, over: pct > targetPct + 0.5 };
}

/** Inline catalogue tickbox: flip a drink's active flag at the current toggle
 *  location and persist via the focused endpoint (manager-gated). Optimistic. */
export async function drinkToggleActive(id: string): Promise<void> {
  if (!isManager()) { toastError('Manager access required.'); return; }
  const loc = S.drinksFilters.location || 'west';
  const d = (S.drinks || []).find(x => x.id === id);
  if (!d) return;
  const cur = activeAtLoc(d, loc);
  const next = !cur;
  const par = d.locations?.[loc]?.par ?? null;
  d.locations = { ...(d.locations || {}), [loc]: { par, active: next } };
  updateCatalogueResults();
  try {
    await apiPost(`/api/drinks/${id}/active`, { location: loc, active: next }, 'PATCH');
  } catch (e: unknown) {
    d.locations = { ...(d.locations || {}), [loc]: { par, active: cur } };
    updateCatalogueResults();
    toastError('Could not update: ' + (e instanceof Error ? e.message : 'Unknown error'));
  }
}

function round1(n: number): number { return Math.round(n * 10) / 10; }

/** Effective BTW for display: explicit override, else auto from ABV + config. */
function effBtw(d: Drink): number {
  if (d.btwRate != null) return d.btwRate;
  const rule = S.drinkConfig?.btwRule || { alcoholicAbvThreshold: 0.5, alcoholic: 21, nonAlcoholic: 9 };
  return d.abv >= rule.alcoholicAbvThreshold ? rule.alcoholic : rule.nonAlcoholic;
}

// ── Suppliers tab (read-only list for M2; editing lands with Ordering, M5) ─────

function suppliersHtml(): string {
  const sups = S.drinkSuppliers || [];
  const mgr = isManager();
  const toolbar = mgr
    ? `<div class="drinks-toolbar"><button class="btn btn-primary" data-testid="supplier-add-btn" onclick="openSupplierForm()">+ Add supplier</button></div>`
    : '';
  if (sups.length === 0) {
    return `${toolbar}<div class="drinks-empty">No drink suppliers yet.${mgr ? ' Add one above.' : ''}</div>`;
  }
  const cards = [...sups].sort((a, b) => a.name.localeCompare(b.name)).map(s => supplierCard(s, mgr)).join('');
  return `${toolbar}<div class="drink-suppliers-grid">${cards}</div>`;
}

function supplierCard(s: DrinkSupplier, mgr: boolean): string {
  const contactBits: string[] = [];
  if (s.contact?.name) contactBits.push(esc(s.contact.name));
  if (s.contact?.email) contactBits.push(`<a href="mailto:${esc(s.contact.email)}">${esc(s.contact.email)}</a>`);
  if (s.contact?.phone) contactBits.push(esc(s.contact.phone));
  if (s.contact?.url) contactBits.push(`<a href="${esc(s.contact.url)}" target="_blank" rel="noopener">site</a>`);
  return `<div class="drink-supplier-card" data-testid="supplier-card">
    <div class="drink-supplier-head">
      <h4>${esc(s.name)}</h4>
      ${mgr ? `<div class="drink-supplier-actions">
        <button class="btn btn-sm" data-testid="supplier-edit-btn" onclick="openSupplierForm('${esc(s.id)}')">Edit</button>
        <button class="btn btn-sm btn-danger" onclick="deleteSupplier('${esc(s.id)}')">✕</button>
      </div>` : ''}
    </div>
    ${s.products ? `<p class="muted small">${esc(s.products)}</p>` : ''}
    ${s.orderDays?.length ? `<p><strong>Order days:</strong> ${s.orderDays.map(esc).join(', ')}${s.orderDaysNote ? ` <span class="muted small">(${esc(s.orderDaysNote)})</span>` : ''}</p>` : ''}
    ${s.orderCutoff ? `<p><strong>Cutoff:</strong> ${esc(s.orderCutoff)}</p>` : ''}
    ${s.deliveryWindow ? `<p><strong>Delivery:</strong> ${esc(s.deliveryWindow)}</p>` : ''}
    ${s.minimumOrder ? `<p><strong>Minimum:</strong> ${esc(s.minimumOrder)}</p>` : ''}
    ${contactBits.length ? `<p class="small">${contactBits.join(' · ')}</p>` : ''}
    ${s.priceListRef ? `<p class="small muted">Price list: ${esc(s.priceListRef)}</p>` : ''}
    ${s.notes ? `<p class="muted small">${esc(s.notes)}</p>` : ''}
  </div>`;
}

// ── Supplier add/edit form (manager only) ────────────────────────────────────

const SUPPLIER_WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function openSupplierForm(id?: string): void {
  if (!isManager()) { toastError('Manager access required.'); return; }
  const s = id ? (S.drinkSuppliers || []).find(x => x.id === id) || null : null;
  const v = (x: string | null | undefined) => x == null ? '' : esc(String(x));
  const days = s?.orderDays || [];
  showModal(`
  <div class="drink-form" data-testid="supplier-form" data-id="${s ? esc(s.id) : newId()}">
    <h3>${s ? 'Edit supplier' : 'Add drink supplier'}</h3>
    <div class="df-grid">
      <label class="df-field df-col2">Name
        <input id="sf-name" data-testid="supplier-name-input" value="${v(s?.name)}" placeholder="e.g. Two Chefs Brewing">
      </label>
      <label class="df-field df-col2">Products / what they supply
        <input id="sf-products" value="${v(s?.products)}" placeholder="e.g. craft beer kegs & cans">
      </label>
    </div>
    <fieldset class="df-section">
      <legend>Ordering</legend>
      <div class="sf-days">${SUPPLIER_WEEKDAYS.map(d => `<label class="sf-day"><input type="checkbox" class="sf-day-cb" value="${d}" ${days.includes(d) ? 'checked' : ''}> ${d}</label>`).join('')}</div>
      <div class="df-grid">
        <label class="df-field df-col2">Order-days note <input id="sf-orderDaysNote" value="${v(s?.orderDaysNote)}" placeholder="e.g. order by Wed for Fri delivery"></label>
        <label class="df-field">Order cutoff <input id="sf-orderCutoff" value="${v(s?.orderCutoff)}" placeholder="e.g. 12:00 day before"></label>
        <label class="df-field">Delivery window <input id="sf-deliveryWindow" value="${v(s?.deliveryWindow)}" placeholder="e.g. Tue & Fri AM"></label>
        <label class="df-field df-col2">Minimum order <input id="sf-minimumOrder" value="${v(s?.minimumOrder)}" placeholder="e.g. €150 or 1 full crate"></label>
      </div>
    </fieldset>
    <fieldset class="df-section">
      <legend>Contact</legend>
      <div class="df-grid">
        <label class="df-field">Contact name <input id="sf-contact-name" value="${v(s?.contact?.name)}"></label>
        <label class="df-field">Email <input id="sf-contact-email" type="email" value="${v(s?.contact?.email)}"></label>
        <label class="df-field">Phone <input id="sf-contact-phone" value="${v(s?.contact?.phone)}"></label>
        <label class="df-field">Website <input id="sf-contact-url" value="${v(s?.contact?.url)}"></label>
      </div>
    </fieldset>
    <div class="df-grid">
      <label class="df-field df-col2">Price list reference <input id="sf-priceListRef" value="${v(s?.priceListRef)}" placeholder="link or doc name"></label>
      <label class="df-field df-col2">Notes <textarea id="sf-notes" rows="2">${v(s?.notes)}</textarea></label>
    </div>
    <div class="modal-actions">
      <button class="btn" type="button" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" data-testid="supplier-save-btn" type="button" onclick="saveSupplierForm()">${s ? 'Save changes' : 'Add supplier'}</button>
    </div>
  </div>`);
}

export async function saveSupplierForm(): Promise<void> {
  const form = document.querySelector('[data-testid="supplier-form"]') as HTMLElement | null;
  if (!form) return;
  const id = form.dataset.id || newId();
  const isNew = !(S.drinkSuppliers || []).some(x => x.id === id);
  const name = strVal('sf-name');
  if (!name) { toastError('Supplier name is required.'); return; }
  const orderDays = Array.from(document.querySelectorAll<HTMLInputElement>('.sf-day-cb'))
    .filter(cb => cb.checked).map(cb => cb.value);
  const contact: Record<string, string> = {};
  for (const [id2, key] of [['sf-contact-name', 'name'], ['sf-contact-email', 'email'], ['sf-contact-phone', 'phone'], ['sf-contact-url', 'url']] as const) {
    const val = strVal(id2);
    if (val) contact[key] = val;
  }
  const payload = {
    id, name,
    products: strVal('sf-products'),
    orderDays,
    orderDaysNote: strVal('sf-orderDaysNote'),
    orderCutoff: strVal('sf-orderCutoff'),
    deliveryWindow: strVal('sf-deliveryWindow'),
    minimumOrder: strVal('sf-minimumOrder'),
    contact,
    priceListRef: strVal('sf-priceListRef'),
    notes: strVal('sf-notes'),
  };
  try {
    if (isNew) { await apiPost('/api/drinks/suppliers', payload); toast('Supplier added'); }
    else { await apiPost(`/api/drinks/suppliers/${id}`, payload, 'PATCH'); toast('Supplier saved'); }
    closeModal();
    await loadDrinkSuppliers();
    renderDrinkTabBody();
  } catch (e: unknown) {
    toastError('Could not save: ' + (e instanceof Error ? e.message : 'Unknown error'));
  }
}

export function deleteSupplier(id: string): void {
  if (!isManager()) { toastError('Manager access required.'); return; }
  const s = (S.drinkSuppliers || []).find(x => x.id === id);
  if (!s) return;
  const removed = s;
  S.drinkSuppliers = (S.drinkSuppliers || []).filter(x => x.id !== id);
  renderDrinkTabBody();
  pushUndo({
    label: esc(removed.name) + ' deleted',
    restore: () => { S.drinkSuppliers = [...(S.drinkSuppliers || []), removed]; renderDrinkTabBody(); },
    commit: async () => {
      try {
        await apiPost(`/api/drinks/suppliers/${id}`, {}, 'DELETE');
      } catch (e: unknown) {
        toastError('Could not delete: ' + (e instanceof Error ? e.message : 'Unknown error'));
        S.drinkSuppliers = [...(S.drinkSuppliers || []), removed];
        renderDrinkTabBody();
      }
    },
  });
}

// ── Catalogue CRUD form (manager only) ───────────────────────────────────────

interface DrinkFormState { id: string; isNew: boolean; formats: DrinkServingFormat[] }
let _form: DrinkFormState | null = null;

export function openDrinkForm(id?: string): void {
  if (!isManager()) { toastError('Manager access required to edit the catalogue.'); return; }
  const existing = id ? (S.drinks || []).find(d => d.id === id) : null;
  const d: Drink | null = existing || null;
  _form = {
    id: id || newId(),
    isNew: !existing,
    formats: d ? (d.formats || []).map(f => ({ ...f, price: { ...f.price } })) : [],
  };
  showModal(buildDrinkFormHtml(d));
  renderFormatRows();
  drinkFormBtwHint();
}

function buildDrinkFormHtml(d: Drink | null): string {
  const cat = d?.category || 'beer';
  const catDef = DRINK_CATALOGUE_CATEGORIES.find(c => c.key === cat) || DRINK_CATALOGUE_CATEGORIES[0];
  const v = (x: string | number | null | undefined) => x == null ? '' : esc(String(x));
  return `
  <div class="drink-form" data-testid="drink-form">
    <h3>${d ? 'Edit drink' : 'Add catalogue drink'}</h3>

    <div class="df-grid">
      <label class="df-field df-col2">Name
        <input id="df-name" data-testid="drink-name-input" value="${v(d?.name)}" placeholder="e.g. Premium Pilsner (Holy Gunter)">
      </label>
      <label class="df-field">Category
        <select id="df-category" onchange="drinkFormCategoryChange(this.value)">
          ${DRINK_CATALOGUE_CATEGORIES.map(c => `<option value="${c.key}" ${c.key === cat ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}
        </select>
      </label>
      <label class="df-field">Subtype
        <input id="df-subtype" list="df-subtype-list" value="${v(d?.subtype)}">
        <datalist id="df-subtype-list">${catDef.subtypes.map(s => `<option value="${esc(s)}">`).join('')}</datalist>
      </label>
      <label class="df-field df-check">
        <input id="df-sellable" type="checkbox" ${d ? (d.sellable ? 'checked' : '') : 'checked'}> Sellable
      </label>
      <label class="df-field df-check">
        <input id="df-published" type="checkbox" ${d?.status === 'published' ? 'checked' : ''}> Published (on service cards)
      </label>
    </div>

    <div id="df-dynamic">${dynamicSectionsHtml(cat, d)}</div>

    <div class="modal-actions">
      <button class="btn" type="button" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" data-testid="drink-save-btn" type="button" onclick="saveDrinkForm()">${d ? 'Save changes' : 'Add drink'}</button>
    </div>
  </div>`;
}

/** The fields shown depend on the category, so a beer doesn't drown in wine
 *  fields and a wine surfaces origin + tasting notes (catalogue #2). Hidden
 *  inputs keep the save path uniform for fields a type doesn't show. */
function dynamicSectionsHtml(cat: string, d: Drink | null): string {
  const info = d?.info || {};
  const v = (x: string | number | null | undefined) => x == null ? '' : esc(String(x));
  const isAlcoholic = cat === 'beer' || cat === 'wine' || cat === 'spirits';
  const isWine = cat === 'wine';
  const isSoft = cat === 'soft';
  const sellable = !NON_SELLABLE_CATEGORIES.has(cat);
  const out: string[] = [];

  // Basics: alcohol % (alcoholic types) + BTW (sellable types). Non-shown values
  // ride along as hidden inputs so saveDrinkForm reads a consistent set.
  if (sellable) {
    out.push(`
    <fieldset class="df-section">
      <legend>Basics</legend>
      <div class="df-grid">
        ${isAlcoholic
          ? `<label class="df-field">Alcohol %
              <input id="df-abv" type="number" step="0.1" min="0" max="100" value="${d ? v(d.abv) : (cat === 'spirits' ? '40' : '5')}" oninput="drinkFormBtwHint()">
            </label>`
          : `<input id="df-abv" type="hidden" value="${d ? v(d.abv) : '0'}">`}
        <label class="df-field">BTW %
          <input id="df-btw" type="number" step="1" min="0" max="100" value="${v(d?.btwRate)}" placeholder="auto">
          <span class="df-hint" id="df-btw-hint"></span>
        </label>
      </div>
    </fieldset>`);
  } else {
    out.push(`<input id="df-abv" type="hidden" value="${d ? v(d.abv) : '0'}"><input id="df-btw" type="hidden" value="${v(d?.btwRate)}">`);
  }

  // Supplier & ordering — everything is bought, so always shown.
  out.push(`
    <fieldset class="df-section">
      <legend>Supplier &amp; ordering</legend>
      <div class="df-grid">
        <label class="df-field">Supplier
          <input id="df-supplier" list="df-supplier-list" value="${v(d?.supplier)}">
          <datalist id="df-supplier-list">${(S.drinkSuppliers || []).map(s => `<option value="${esc(s.name)}">`).join('')}</datalist>
        </label>
        <label class="df-field">Order unit
          <input id="df-orderUnit" value="${v(d?.orderUnit)}" placeholder="keg / crate / bottle / tray">
        </label>
        <label class="df-field">Order unit volume (ml)
          <input id="df-orderUnitMl" type="number" step="1" min="0" value="${v(d?.orderUnitMl)}" placeholder="keg 20000, bottle 750">
        </label>
        <label class="df-field df-col2">Pack note
          <input id="df-packNote" value="${v(d?.packNote)}" placeholder="e.g. 20L keg / crate 24×200ml">
        </label>
        <label class="df-field">Supplier item code
          <input id="df-itemId" value="${v(d?.itemId)}">
        </label>
        <label class="df-field">Deposit € (statiegeld)
          <input id="df-deposit" type="number" step="0.01" min="0" value="${d ? v(d.deposit) : '0'}">
        </label>
        <label class="df-field">Cost price € (ex BTW, per order unit)
          <input id="df-costPrice" type="number" step="0.01" min="0" value="${v(d?.costPrice)}">
        </label>
        <label class="df-field df-col2">Cost note
          <input id="df-costNote" value="${v(d?.costNote)}">
        </label>
      </div>
    </fieldset>`);

  // Wine info — only for wine (origin + grapes + tasting notes).
  if (isWine) {
    out.push(`
    <fieldset class="df-section">
      <legend>Wine info</legend>
      <div class="df-grid">
        <label class="df-field">Producer / winery <input id="df-producer" value="${v(info.producer)}"></label>
        <label class="df-field">Region <input id="df-region" value="${v(info.region)}"></label>
        <label class="df-field">Country <input id="df-country" value="${v(info.country)}"></label>
        <label class="df-field">Vintage <input id="df-vintage" value="${v(info.vintage)}"></label>
        <label class="df-field">Grape(s) <input id="df-grapes" value="${v(info.grapes)}"></label>
        <label class="df-field">Soil <input id="df-soil" value="${v(info.soil)}"></label>
        <label class="df-field df-check"><input id="df-natural" type="checkbox" ${info.natural ? 'checked' : ''}> Natural</label>
        <label class="df-field df-check"><input id="df-bio" type="checkbox" ${info.bio ? 'checked' : ''}> Bio / organic</label>
        <label class="df-field df-col2">Flavour profile <input id="df-profile" value="${v(info.profile)}" placeholder="e.g. dry, mineral, citrus"></label>
        <label class="df-field df-col2">Tasting notes <textarea id="df-notes" rows="2">${v(info.notes)}</textarea></label>
      </div>
    </fieldset>`);
  }

  // Serving — sellable types: temperature, how-to-serve / pairing, and formats.
  if (sellable) {
    const serveLabel = isSoft ? 'Serving &amp; pairing notes' : 'How to serve';
    const placeholder = isSoft
      ? 'e.g. tall glass over ice with lime — pairs with spicy or fried dishes'
      : 'e.g. chilled, no ice, in a stemmed glass';
    out.push(`
    <fieldset class="df-section">
      <legend>Serving</legend>
      <div class="df-grid">
        <label class="df-field">Serve temperature
          <select id="df-servingTemp">
            <option value="">—</option>
            ${DRINK_SERVING_TEMPS.map(t => `<option value="${esc(t)}" ${d?.servingTemp === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}
          </select>
        </label>
        <label class="df-field df-col2">${serveLabel}
          <textarea id="df-serviceInstructions" rows="2" placeholder="${placeholder}">${v(d?.serviceInstructions)}</textarea>
        </label>
      </div>
    </fieldset>
    <fieldset class="df-section">
      <legend>Serving formats &amp; prices</legend>
      <div id="df-formats"></div>
      <button class="btn btn-sm" type="button" onclick="drinkFormAddFormat()">+ Add format</button>
    </fieldset>`);
  }

  // Per-location stock target ("Needed") + availability — always.
  out.push(`
    <fieldset class="df-section">
      <legend>Per-location stock target &amp; availability</legend>
      <div class="df-grid">
        ${DRINK_LOCATIONS.map(l => {
          const li = d?.locations?.[l.key];
          return `<div class="df-loc-block">
            <strong>${esc(l.label)}</strong>
            <label class="df-field">Needed / target (order units) <input id="df-par-${l.key}" type="number" step="0.5" min="0" value="${li?.par != null ? esc(String(li.par)) : ''}"></label>
            <label class="df-field df-check"><input id="df-active-${l.key}" type="checkbox" ${!li || li.active !== false ? 'checked' : ''}> Active here</label>
          </div>`;
        }).join('')}
      </div>
    </fieldset>`);

  // Tebi sales link — sellable only.
  if (sellable) {
    out.push(`
    <label class="df-field df-col2">Tebi product names (comma-separated — Phase-2 sales link)
      <input id="df-tebi" value="${d?.tebiProductNames?.length ? esc(d.tebiProductNames.join(', ')) : ''}">
    </label>`);
  }

  return out.join('\n');
}

/** Category change: refresh the subtype datalist and re-render the type-specific
 *  sections (category-independent fields repopulate from the saved drink). */
export function drinkFormCategoryChange(catKey: string): void {
  const def = DRINK_CATALOGUE_CATEGORIES.find(c => c.key === catKey);
  const dl = document.getElementById('df-subtype-list');
  if (dl && def) dl.innerHTML = def.subtypes.map(s => `<option value="${esc(s)}">`).join('');
  const dyn = document.getElementById('df-dynamic');
  if (dyn) {
    const existing = _form && !_form.isNew ? (S.drinks || []).find(x => x.id === _form!.id) || null : null;
    dyn.innerHTML = dynamicSectionsHtml(catKey, existing);
    renderFormatRows();
    drinkFormBtwHint();
  }
}

/** Live "auto = N%" hint next to the BTW override input. */
export function drinkFormBtwHint(): void {
  const abv = parseFloat((document.getElementById('df-abv') as HTMLInputElement)?.value || '0') || 0;
  const rule = S.drinkConfig?.btwRule || { alcoholicAbvThreshold: 0.5, alcoholic: 21, nonAlcoholic: 9 };
  const auto = abv >= rule.alcoholicAbvThreshold ? rule.alcoholic : rule.nonAlcoholic;
  const hint = document.getElementById('df-btw-hint');
  if (hint) hint.textContent = `auto: ${auto}%`;
}

function renderFormatRows(): void {
  const wrap = document.getElementById('df-formats');
  if (!wrap || !_form) return;
  if (_form.formats.length === 0) {
    wrap.innerHTML = `<p class="muted small">No serving formats. Add one (e.g. tap glass 250ml €3.70).</p>`;
    return;
  }
  wrap.innerHTML = _form.formats.map((f, i) => `
    <div class="df-format-row" data-idx="${i}">
      <input class="dff-name" placeholder="format (glass/bottle/shot)" value="${esc(f.name)}">
      <input class="dff-vol" type="number" step="1" min="0" placeholder="ml" value="${f.volumeMl ? esc(String(f.volumeMl)) : ''}">
      <select class="dff-glass">
        <option value="">glass…</option>
        ${DRINK_GLASS_TYPES.map(g => `<option value="${esc(g.name)}" ${g.name === f.glass ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}
      </select>
      ${DRINK_LOCATIONS.map(l => `<input class="dff-price" data-loc="${l.key}" type="number" step="0.01" min="0" placeholder="€ ${l.label}" value="${f.price?.[l.key] != null ? esc(String(f.price[l.key])) : ''}">`).join('')}
      <button class="btn btn-sm btn-danger" type="button" onclick="drinkFormRemoveFormat(${i})">✕</button>
    </div>`).join('');
}

/** Read the format rows out of the DOM into _form.formats (called before any
 *  re-render and on save so in-progress edits survive). */
function captureFormatRows(): void {
  if (!_form) return;
  const rows = Array.from(document.querySelectorAll('#df-formats .df-format-row'));
  _form.formats = rows.map(row => {
    const price: Record<string, number | null> = {};
    row.querySelectorAll<HTMLInputElement>('.dff-price').forEach(inp => {
      const loc = inp.dataset.loc!;
      price[loc] = inp.value === '' ? null : Number(inp.value);
    });
    return {
      name: (row.querySelector('.dff-name') as HTMLInputElement).value.trim(),
      volumeMl: Number((row.querySelector('.dff-vol') as HTMLInputElement).value) || 0,
      glass: (row.querySelector('.dff-glass') as HTMLSelectElement).value || undefined,
      price,
    };
  });
}

export function drinkFormAddFormat(): void {
  if (!_form) return;
  captureFormatRows();
  _form.formats.push({ name: '', volumeMl: 0, glass: undefined, price: {} });
  renderFormatRows();
}

export function drinkFormRemoveFormat(i: number): void {
  if (!_form) return;
  captureFormatRows();
  _form.formats.splice(i, 1);
  renderFormatRows();
}

function strVal(id: string): string { return (document.getElementById(id) as HTMLInputElement)?.value.trim() || ''; }
function numVal(id: string): number | null { const v = (document.getElementById(id) as HTMLInputElement)?.value; return v === '' || v == null ? null : Number(v); }
function boolVal(id: string): boolean { return !!(document.getElementById(id) as HTMLInputElement)?.checked; }

export async function saveDrinkForm(): Promise<void> {
  if (!_form) return;
  captureFormatRows();
  const name = strVal('df-name');
  if (!name) { toastError('Name is required.'); return; }
  const category = strVal('df-category');

  const info: Record<string, unknown> = {};
  for (const [id, key] of [['df-producer', 'producer'], ['df-region', 'region'], ['df-country', 'country'], ['df-vintage', 'vintage'], ['df-soil', 'soil'], ['df-grapes', 'grapes'], ['df-profile', 'profile'], ['df-notes', 'notes']] as const) {
    const val = strVal(id);
    if (val) info[key] = val;
  }
  if (boolVal('df-natural')) info.natural = true;
  if (boolVal('df-bio')) info.bio = true;

  const locations: Record<string, { par: number | null; active: boolean }> = {};
  for (const l of DRINK_LOCATIONS) {
    locations[l.key] = { par: numVal(`df-par-${l.key}`), active: boolVal(`df-active-${l.key}`) };
  }

  const tebi = strVal('df-tebi').split(',').map(s => s.trim()).filter(Boolean);

  const payload = {
    id: _form.id,
    mode: 'catalogue' as const,
    name,
    category,
    subtype: strVal('df-subtype'),
    abv: numVal('df-abv') ?? 0,
    btwRate: numVal('df-btw'),
    status: boolVal('df-published') ? 'published' : 'draft',
    sellable: boolVal('df-sellable'),
    supplier: strVal('df-supplier'),
    orderUnit: strVal('df-orderUnit'),
    orderUnitMl: numVal('df-orderUnitMl'),
    packNote: strVal('df-packNote'),
    itemId: strVal('df-itemId') || null,
    deposit: numVal('df-deposit') ?? 0,
    costPrice: numVal('df-costPrice'),
    costNote: strVal('df-costNote'),
    servingTemp: strVal('df-servingTemp'),
    serviceInstructions: strVal('df-serviceInstructions'),
    info,
    formats: _form.formats.filter(f => f.name || f.volumeMl),
    locations,
    tebiProductNames: tebi,
  };

  try {
    if (_form.isNew) {
      await apiPost('/api/drinks', payload);
      toast('Drink added');
    } else {
      await apiPost(`/api/drinks/${_form.id}`, payload, 'PATCH');
      toast('Drink saved');
    }
    _form = null;
    closeModal();
    await loadDrinks();
    renderDrinkTabBody();
  } catch (e: unknown) {
    toastError('Could not save: ' + (e instanceof Error ? e.message : 'Unknown error'));
  }
}

export function deleteDrink(id: string): void {
  if (!isManager()) { toastError('Manager access required.'); return; }
  const d = (S.drinks || []).find(x => x.id === id);
  if (!d) return;
  const removed = d;
  S.drinks = (S.drinks || []).filter(x => x.id !== id);
  updateCatalogueResults();
  pushUndo({
    label: esc(removed.name) + ' deleted',
    restore: () => { S.drinks = [...(S.drinks || []), removed]; updateCatalogueResults(); },
    commit: async () => {
      try {
        await apiPost(`/api/drinks/${id}`, {}, 'DELETE');
      } catch (e: unknown) {
        toastError('Could not delete: ' + (e instanceof Error ? e.message : 'Unknown error'));
        S.drinks = [...(S.drinks || []), removed];
        updateCatalogueResults();
      }
    },
  });
}

// Self-register so navigate.ts can dispatch without importing this module.
registerRenderer('drinks', renderDrinks);
