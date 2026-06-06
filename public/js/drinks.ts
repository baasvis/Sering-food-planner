// ─────────────────────────────────────────────────────────────────────────────
// DRINKS SCREEN — one nav screen with internal sub-tabs (mirrors planner /
// orders). M2 ships the Catalogue + Suppliers tabs; later milestones add
// Recipes / Stocktake / Orders / Production / Bar / Menus.
//
// Search/Filter Input Rule: the catalogue search box is rendered once in the
// tab shell; keystrokes update only #drinks-cat-results.
// ─────────────────────────────────────────────────────────────────────────────

import { S } from './state';
import { newId, apiPost, toast, toastError, loadDrinks } from './utils';
import { showModal, closeModal, esc } from './modal';
import { pushUndo } from './undo';
import { registerRenderer } from './navigate';
import {
  DRINK_LOCATIONS, DRINK_GLASS_TYPES, DRINK_CATALOGUE_CATEGORIES, drinkCategoryLabel,
} from './drinks-constants';
import { renderRecipesTab } from './drinks-recipe';
import { renderDrinksStocktakeTab } from './drinks-stocktake';
import { renderDrinksOrdersTab } from './drinks-order';
import { renderDrinksProductionTab } from './drinks-production';
import { renderDrinksBarTab } from './drinks-service';
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

function catalogueShellHtml(): string {
  const f = S.drinksFilters;
  const cats = catalogueCategoriesPresent();
  return `
    <div class="drinks-toolbar">
      ${isManager() ? `<button class="btn btn-primary" data-testid="drink-add-btn" onclick="openDrinkForm()">+ Add drink</button>` : ''}
      <input class="drinks-search" id="drinks-cat-search" data-testid="drinks-search" placeholder="Search drinks…" value="${esc(S.drinksSearch)}" oninput="drinksSetCatSearch(this.value)">
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
  const loc = S.currentLoc || 'west';
  let list = (S.drinks || []).filter(d => d.mode === 'catalogue');
  if (S.drinksFilters.category !== 'all') list = list.filter(d => d.category === S.drinksFilters.category);
  const q = S.drinksSearch.trim().toLowerCase();
  if (q) {
    list = list.filter(d =>
      d.name.toLowerCase().includes(q)
      || (d.subtype || '').toLowerCase().includes(q)
      || (d.supplier || '').toLowerCase().includes(q));
  }
  list = [...list].sort((a, b) => a.category === b.category ? a.name.localeCompare(b.name) : a.category.localeCompare(b.category));

  if (list.length === 0) {
    container.innerHTML = `<div class="drinks-empty">No drinks${q ? ' match your search' : ''}.</div>`;
    return;
  }

  const mgr = isManager();
  const rows = list.map(d => {
    const stock = d.stockByLocation?.[loc];
    const par = d.locations?.[loc]?.par;
    const parStock = `${par != null ? par : '–'} / ${stock != null ? round1(stock) : '–'}`;
    const btw = effBtw(d);
    return `<tr data-testid="drink-row" data-id="${esc(d.id)}">
      <td class="drink-name">${esc(d.name)}${d.status === 'published' ? ' <span class="drink-pub" title="Published">●</span>' : ''}${d.subtype ? `<div class="muted small">${esc(d.subtype)}</div>` : ''}</td>
      <td>${esc(drinkCategoryLabel(d.category))}</td>
      <td>${esc(d.supplier || '—')}</td>
      <td class="num">${d.abv ? d.abv + '%' : '—'}</td>
      <td class="num" title="BTW">${btw}%</td>
      <td class="num" title="par / stock @ ${esc(loc)}">${parStock}</td>
      <td>${formatPriceSummary(d, loc)}</td>
      <td class="num">${d.deposit ? '€' + d.deposit.toFixed(2) : '—'}</td>
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
          <th>Name</th><th>Category</th><th>Supplier</th><th class="num">ABV</th>
          <th class="num">BTW</th><th class="num">Par/Stock</th><th>Price (${esc(loc)})</th><th class="num">Deposit</th>
          ${mgr ? '<th></th>' : ''}
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
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
  if (sups.length === 0) {
    return `<div class="drinks-empty">No drink suppliers yet.</div>`;
  }
  const cards = sups.map(s => supplierCard(s)).join('');
  return `<div class="drink-suppliers-grid">${cards}</div>`;
}

function supplierCard(s: DrinkSupplier): string {
  const contactBits: string[] = [];
  if (s.contact?.name) contactBits.push(esc(s.contact.name));
  if (s.contact?.email) contactBits.push(`<a href="mailto:${esc(s.contact.email)}">${esc(s.contact.email)}</a>`);
  if (s.contact?.phone) contactBits.push(esc(s.contact.phone));
  if (s.contact?.url) contactBits.push(`<a href="${esc(s.contact.url)}" target="_blank" rel="noopener">site</a>`);
  return `<div class="drink-supplier-card">
    <h4>${esc(s.name)}</h4>
    ${s.products ? `<p class="muted small">${esc(s.products)}</p>` : ''}
    ${s.orderDays?.length ? `<p><strong>Order days:</strong> ${s.orderDays.map(esc).join(', ')}${s.orderDaysNote ? ` <span class="muted small">(${esc(s.orderDaysNote)})</span>` : ''}</p>` : ''}
    ${s.deliveryWindow ? `<p><strong>Delivery:</strong> ${esc(s.deliveryWindow)}</p>` : ''}
    ${s.minimumOrder ? `<p><strong>Minimum:</strong> ${esc(s.minimumOrder)}</p>` : ''}
    ${contactBits.length ? `<p class="small">${contactBits.join(' · ')}</p>` : ''}
    ${s.notes ? `<p class="muted small">${esc(s.notes)}</p>` : ''}
  </div>`;
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
  const info = d?.info || {};
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
      <label class="df-field">ABV %
        <input id="df-abv" type="number" step="0.1" min="0" max="100" value="${d ? v(d.abv) : '5'}" oninput="drinkFormBtwHint()">
      </label>
      <label class="df-field">BTW %
        <input id="df-btw" type="number" step="1" min="0" max="100" value="${v(d?.btwRate)}" placeholder="auto">
        <span class="df-hint" id="df-btw-hint"></span>
      </label>
      <label class="df-field df-check">
        <input id="df-sellable" type="checkbox" ${d ? (d.sellable ? 'checked' : '') : 'checked'}> Sellable
      </label>
      <label class="df-field df-check">
        <input id="df-published" type="checkbox" ${d?.status === 'published' ? 'checked' : ''}> Published (on service cards)
      </label>
    </div>

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
    </fieldset>

    <fieldset class="df-section">
      <legend>Info (wine &amp; specialty)</legend>
      <div class="df-grid">
        <label class="df-field">Producer / winery <input id="df-producer" value="${v(info.producer)}"></label>
        <label class="df-field">Region / country <input id="df-region" value="${v(info.region)}"></label>
        <label class="df-field">Vintage <input id="df-vintage" value="${v(info.vintage)}"></label>
        <label class="df-field">Soil <input id="df-soil" value="${v(info.soil)}"></label>
        <label class="df-field">Grape(s) <input id="df-grapes" value="${v(info.grapes)}"></label>
        <label class="df-field df-check"><input id="df-natural" type="checkbox" ${info.natural ? 'checked' : ''}> Natural</label>
        <label class="df-field df-check"><input id="df-bio" type="checkbox" ${info.bio ? 'checked' : ''}> Bio / organic</label>
        <label class="df-field df-col2">Flavour profile <input id="df-profile" value="${v(info.profile)}"></label>
        <label class="df-field df-col2">Tasting notes <input id="df-notes" value="${v(info.notes)}"></label>
      </div>
    </fieldset>

    <fieldset class="df-section">
      <legend>Serving formats &amp; prices</legend>
      <div id="df-formats"></div>
      <button class="btn btn-sm" type="button" onclick="drinkFormAddFormat()">+ Add format</button>
    </fieldset>

    <fieldset class="df-section">
      <legend>Per-location par &amp; availability</legend>
      <div class="df-grid">
        ${DRINK_LOCATIONS.map(l => {
          const li = d?.locations?.[l.key];
          return `<div class="df-loc-block">
            <strong>${esc(l.label)}</strong>
            <label class="df-field">Par (order units) <input id="df-par-${l.key}" type="number" step="0.5" min="0" value="${li?.par != null ? esc(String(li.par)) : ''}"></label>
            <label class="df-field df-check"><input id="df-active-${l.key}" type="checkbox" ${!li || li.active !== false ? 'checked' : ''}> Active here</label>
          </div>`;
        }).join('')}
      </div>
    </fieldset>

    <label class="df-field df-col2">Tebi product names (comma-separated — Phase-2 sales link)
      <input id="df-tebi" value="${d?.tebiProductNames?.length ? esc(d.tebiProductNames.join(', ')) : ''}">
    </label>

    <div class="modal-actions">
      <button class="btn" type="button" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" data-testid="drink-save-btn" type="button" onclick="saveDrinkForm()">${d ? 'Save changes' : 'Add drink'}</button>
    </div>
  </div>`;
}

/** Update the subtype datalist when the category dropdown changes. */
export function drinkFormCategoryChange(catKey: string): void {
  const def = DRINK_CATALOGUE_CATEGORIES.find(c => c.key === catKey);
  const dl = document.getElementById('df-subtype-list');
  if (dl && def) dl.innerHTML = def.subtypes.map(s => `<option value="${esc(s)}">`).join('');
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
  for (const [id, key] of [['df-producer', 'producer'], ['df-region', 'region'], ['df-vintage', 'vintage'], ['df-soil', 'soil'], ['df-grapes', 'grapes'], ['df-profile', 'profile'], ['df-notes', 'notes']] as const) {
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
