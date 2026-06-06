// ─────────────────────────────────────────────────────────────────────────────
// DRINKS — Recipes tab + recipe form (M3). Recipe-mode drinks: ingredient/drink
// building-block rows, batch + bottle yield, prep steps, and a LIVE cost +
// suggested-price + markup-traffic-light preview computed client-side via the
// shared cost engine (the same engine the backend recalc uses).
// ─────────────────────────────────────────────────────────────────────────────

import { S } from './state';
import { newId, apiPost, toast, toastError, loadDrinks } from './utils';
import { showModal, closeModal, esc } from './modal';
import { pushUndo } from './undo';
import { DRINK_RECIPE_CATEGORIES, DRINK_GLASS_TYPES, DRINK_SERVING_TEMPS, drinkCategoryLabel } from './drinks-constants';
import {
  makeCostContext, drinkTotalCostExBtw, suggestedPriceInclBtw, targetMarkupFor,
  effectiveBtw, actualMarkup, markupLight, yieldBottles, CostContext,
} from '@shared/drink-cost';
import type { Drink, DrinkConfig, DrinkServingFormat } from '@shared/types';

const FALLBACK_CFG: DrinkConfig = {
  labourRatePerMin: 0.29, priceRounding: 0.1,
  btwRule: { alcoholicAbvThreshold: 0.5, alcoholic: 21, nonAlcoholic: 9 },
  markupTargets: { defaultMultiple: 4.0 }, demandNudgeThresholdPct: 25, defaultShelfLifeDays: 7,
};
function cfg(): DrinkConfig { return S.drinkConfig || FALLBACK_CFG; }
function isManager(): boolean { return !!S.user?.isManager; }
function jsEsc(s: string): string { return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, ' '); }
function ingredientsForCost() { return (S.ingredientDb || []).map(i => ({ id: i.id, pricePer100: i.pricePer100 || 0 })); }
/** Cost context over the live catalogue. The form drink is computed against it. */
function costCtx(extra?: Drink): CostContext {
  const drinks = extra ? [...(S.drinks || []).filter(d => d.id !== extra.id), extra] : (S.drinks || []);
  return makeCostContext(drinks, ingredientsForCost(), cfg());
}

// ── Recipes tab ──────────────────────────────────────────────────────────────

let _recSearch = '';
let _recCat = 'all';

export function renderRecipesTab(): void {
  const body = document.getElementById('drinks-tab-body');
  if (!body) return;
  const cats = DRINK_RECIPE_CATEGORIES.filter(c => (S.drinks || []).some(d => d.mode === 'recipe' && d.category === c.key));
  body.innerHTML = `
    <div class="drinks-toolbar">
      <button class="btn btn-primary" data-testid="drink-recipe-add-btn" onclick="openDrinkRecipeForm()">+ Add recipe drink</button>
      <input class="drinks-search" id="drinks-rec-search" placeholder="Search recipes…" value="${esc(_recSearch)}" oninput="drinksSetRecSearch(this.value)">
    </div>
    <div class="drinks-filter-bar">
      <button class="fc ${_recCat === 'all' ? 'on' : ''}" onclick="drinksSetRecCategory('all')">All</button>
      ${cats.map(c => `<button class="fc ${_recCat === c.key ? 'on' : ''}" onclick="drinksSetRecCategory('${c.key}')">${esc(c.label)}</button>`).join('')}
    </div>
    <div id="drinks-rec-results"></div>`;
  updateRecipeResults();
}

export function drinksSetRecSearch(v: string): void { _recSearch = v; updateRecipeResults(); }
export function drinksSetRecCategory(c: string): void {
  _recCat = c;
  document.querySelectorAll('#drinks-tab-body .drinks-filter-bar .fc').forEach(b => {
    b.classList.toggle('on', ((b as HTMLElement).getAttribute('onclick') || '').includes(`'${c}'`));
  });
  updateRecipeResults();
}

export function updateRecipeResults(): void {
  const container = document.getElementById('drinks-rec-results');
  if (!container) return;
  let list = (S.drinks || []).filter(d => d.mode === 'recipe');
  if (_recCat !== 'all') list = list.filter(d => d.category === _recCat);
  const q = _recSearch.trim().toLowerCase();
  if (q) list = list.filter(d => d.name.toLowerCase().includes(q) || (d.subtype || '').toLowerCase().includes(q));
  list = [...list].sort((a, b) => a.category === b.category ? a.name.localeCompare(b.name) : a.category.localeCompare(b.category));
  if (list.length === 0) { container.innerHTML = `<div class="drinks-empty">No recipe drinks${q ? ' match your search' : ''}.</div>`; return; }

  const c = cfg();
  const ctx = costCtx();
  const rows = list.map(d => {
    const isBlock = d.category === 'building-block';
    const btw = effectiveBtw(d.abv, d.btwRate, c);
    const target = targetMarkupFor(d.category, c);
    const menuPrice = (d.formats || []).find(f => f.price?.west != null)?.price?.west ?? null;
    const cost = d.costPerServe;
    let markupCell = '<span class="muted">—</span>';
    if (!isBlock && cost != null) {
      const am = actualMarkup(menuPrice, btw, cost);
      const light = markupLight(am, target);
      markupCell = `<span class="ml-dot ml-${light}" title="target ${target}×"></span>${am != null ? am.toFixed(1) + '×' : '—'}`;
    }
    const costCell = cost != null ? (isBlock ? `€${cost.toFixed(2)}/L` : `€${cost.toFixed(2)}`) : '<span class="muted">—</span>';
    return `<tr data-testid="drink-recipe-row" data-id="${esc(d.id)}">
      <td class="drink-name">${esc(d.name)}${d.status === 'published' ? ' <span class="drink-pub" title="Published">●</span>' : ' <span class="muted small">draft</span>'}</td>
      <td>${esc(drinkCategoryLabel(d.category))}</td>
      <td class="num">${d.serveVolumeMl ? d.serveVolumeMl + 'ml' : '—'}</td>
      <td class="num">${costCell}</td>
      <td class="num">${d.suggestedPrice != null ? '€' + d.suggestedPrice.toFixed(2) : '—'}</td>
      <td class="num">${menuPrice != null ? '€' + menuPrice.toFixed(2) : '<span class="muted">—</span>'}</td>
      <td class="num">${markupCell}</td>
      <td class="drink-actions">
        <button class="btn btn-sm" onclick="openDrinkRecipeForm('${esc(d.id)}')">Edit</button>
        <button class="btn btn-sm btn-danger" onclick="deleteDrinkRecipe('${esc(d.id)}')">✕</button>
      </td>
    </tr>`;
  }).join('');

  container.innerHTML = `
    <div class="drinks-table-wrap"><table class="drinks-table" data-testid="drinks-recipe-table">
      <thead><tr><th>Name</th><th>Category</th><th class="num">Serve</th><th class="num">Cost</th><th class="num">Suggested</th><th class="num">Menu</th><th class="num">Markup</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

// ── Recipe form ──────────────────────────────────────────────────────────────

interface FormRow { refKind: 'ingredient' | 'drink'; refId: string | null; refName: string; amount: number | null; unit: string }
interface RecipeForm { id: string; isNew: boolean; rows: FormRow[]; prepSteps: string[] }
let _rf: RecipeForm | null = null;

export function openDrinkRecipeForm(id?: string): void {
  const existing = id ? (S.drinks || []).find(d => d.id === id && d.mode === 'recipe') : null;
  _rf = {
    id: id || newId(),
    isNew: !existing,
    rows: existing ? existing.ingredientRows.map(r => ({
      refKind: r.refKind, refId: r.refKind === 'drink' ? r.refDrinkId : r.ingredientId,
      refName: refDisplayName(r.refKind, r.refKind === 'drink' ? r.refDrinkId : r.ingredientId) || r.note,
      amount: r.amount, unit: r.unit,
    })) : [],
    prepSteps: existing ? [...existing.prepSteps] : [],
  };
  showModal(recipeFormHtml(existing || null));
  renderRecipeRows();
  renderPrepSteps();
  recipeFormRecost();
}

function refDisplayName(kind: 'ingredient' | 'drink', refId: string | null): string {
  if (!refId) return '';
  if (kind === 'drink') return (S.drinks || []).find(d => d.id === refId)?.name || '';
  return (S.ingredientDb || []).find(i => i.id === refId)?.name || '';
}

function recipeFormHtml(d: Drink | null): string {
  const cat = d?.category || 'cocktail';
  const v = (x: string | number | null | undefined) => x == null ? '' : esc(String(x));
  const b = d?.batch || { volumeMl: 0, bottleSizeMl: null };
  const pt = d?.prepTime || { prebatchMin: 0, perServeMin: 0 };
  const serveFmt = (d?.formats || []).find(f => f.price?.west != null) || (d?.formats || [])[0];
  const servePrice = serveFmt?.price?.west ?? null;
  return `
  <div class="drink-form" data-testid="drink-recipe-form">
    <h3>${d ? 'Edit recipe drink' : 'Add recipe drink'}</h3>
    <div class="df-grid">
      <label class="df-field df-col2">Name <input id="rf-name" data-testid="drink-recipe-name" value="${v(d?.name)}" placeholder="e.g. Espresso Martini"></label>
      <label class="df-field">Category
        <select id="rf-category" onchange="recipeFormRecost()">
          ${DRINK_RECIPE_CATEGORIES.map(c => `<option value="${c.key}" ${c.key === cat ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}
        </select>
      </label>
      <label class="df-field">Subtype <input id="rf-subtype" value="${v(d?.subtype)}"></label>
      <label class="df-field">ABV % <input id="rf-abv" type="number" step="0.1" min="0" max="100" value="${d ? v(d.abv) : '0'}" oninput="recipeFormRecost()"></label>
      <label class="df-field">Serve volume (ml) <input id="rf-serveVol" type="number" step="1" min="0" value="${v(d?.serveVolumeMl)}" oninput="recipeFormRecost()"></label>
      <label class="df-field">Glass
        <select id="rf-glass"><option value="">—</option>${DRINK_GLASS_TYPES.map(g => `<option value="${esc(g.name)}" ${g.name === d?.glass ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select>
      </label>
      <label class="df-field">Serving temp
        <select id="rf-temp"><option value="">—</option>${DRINK_SERVING_TEMPS.map(t => `<option value="${esc(t)}" ${t === d?.servingTemp ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
      </label>
      <label class="df-field">Shelf life (days) <input id="rf-shelf" type="number" step="1" min="0" value="${v(d?.shelfLifeDays)}"></label>
      <label class="df-field df-check"><input id="rf-published" type="checkbox" ${d?.status === 'published' ? 'checked' : ''}> Published</label>
    </div>

    <fieldset class="df-section"><legend>Batch &amp; labour</legend>
      <div class="df-grid">
        <label class="df-field">Batch volume (ml) <input id="rf-batchVol" type="number" step="1" min="0" value="${v(b.volumeMl)}" oninput="recipeFormRecost()"></label>
        <label class="df-field">Bottle size (ml) <input id="rf-bottleSize" type="number" step="1" min="0" value="${v(b.bottleSizeMl)}" oninput="recipeFormRecost()"></label>
        <label class="df-field">Prebatch minutes <input id="rf-prebatchMin" type="number" step="1" min="0" value="${v(pt.prebatchMin)}" oninput="recipeFormRecost()"></label>
        <label class="df-field">Prebatch yield (servings) <input id="rf-prebatchYield" type="number" step="1" min="0" value="${v(pt.prebatchYieldServings)}" placeholder="auto from batch÷serve" oninput="recipeFormRecost()"></label>
        <label class="df-field">Per-serve minutes <input id="rf-perServeMin" type="number" step="0.5" min="0" value="${v(pt.perServeMin)}" oninput="recipeFormRecost()"></label>
        <div class="df-field"><span class="df-hint" id="rf-yield-hint"></span></div>
      </div>
    </fieldset>

    <fieldset class="df-section"><legend>Ingredients &amp; building blocks</legend>
      <div id="rf-rows"></div>
      <button class="btn btn-sm" type="button" onclick="recipeFormAddRow()">+ Add ingredient/drink</button>
    </fieldset>

    <fieldset class="df-section"><legend>Prep steps</legend>
      <div id="rf-prep"></div>
      <button class="btn btn-sm" type="button" onclick="recipeFormAddPrep()">+ Add step</button>
    </fieldset>

    <label class="df-field df-col2">Service instructions (bartender card) <input id="rf-service" value="${v(d?.serviceInstructions)}"></label>

    ${isManager() ? `<label class="df-field df-col2">Serve price € (incl BTW) <input id="rf-price" type="number" step="0.10" min="0" value="${v(servePrice)}" oninput="recipeFormRecost()"></label>`
      : `<input type="hidden" id="rf-price" value="${v(servePrice)}"><p class="muted small">Serve price is manager-set — you'll see the suggested price below.</p>`}

    <div class="recipe-cost-preview" id="rf-cost-preview" data-testid="drink-recipe-cost"></div>

    <div class="modal-actions">
      <button class="btn" type="button" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" data-testid="drink-recipe-save" type="button" onclick="saveDrinkRecipe()">${d ? 'Save changes' : 'Add recipe'}</button>
    </div>
  </div>`;
}

function renderRecipeRows(): void {
  const wrap = document.getElementById('rf-rows');
  if (!wrap || !_rf) return;
  if (_rf.rows.length === 0) { wrap.innerHTML = `<p class="muted small">No ingredients yet.</p>`; return; }
  wrap.innerHTML = _rf.rows.map((r, i) => `
    <div class="rf-row" data-idx="${i}">
      <select class="rf-kind" onchange="recipeFormRowKind(${i}, this.value)">
        <option value="ingredient" ${r.refKind === 'ingredient' ? 'selected' : ''}>Ingredient</option>
        <option value="drink" ${r.refKind === 'drink' ? 'selected' : ''}>Drink (building block)</option>
      </select>
      <div class="rf-pick">
        <input class="rf-search" data-idx="${i}" value="${esc(r.refName)}" placeholder="search…" oninput="recipeRowSearch(${i}, this.value)" onblur="recipeRowHide(${i})" autocomplete="off">
        <div class="rf-sug" id="rf-sug-${i}"></div>
      </div>
      <input class="rf-amount" type="number" step="0.1" min="0" value="${r.amount != null ? esc(String(r.amount)) : ''}" placeholder="amt" oninput="recipeFormRowAmount(${i}, this.value)">
      <select class="rf-unit" onchange="recipeFormRowUnit(${i}, this.value)">
        ${['ml', 'g', 'piece'].map(u => `<option value="${u}" ${u === r.unit ? 'selected' : ''}>${u}</option>`).join('')}
      </select>
      <button class="btn btn-sm btn-danger" type="button" onclick="recipeFormRemoveRow(${i})">✕</button>
    </div>`).join('');
}

export function recipeFormAddRow(): void { if (!_rf) return; _rf.rows.push({ refKind: 'ingredient', refId: null, refName: '', amount: null, unit: 'ml' }); renderRecipeRows(); }
export function recipeFormRemoveRow(i: number): void { if (!_rf) return; _rf.rows.splice(i, 1); renderRecipeRows(); recipeFormRecost(); }
export function recipeFormRowKind(i: number, kind: string): void { if (!_rf) return; _rf.rows[i].refKind = kind === 'drink' ? 'drink' : 'ingredient'; _rf.rows[i].refId = null; _rf.rows[i].refName = ''; renderRecipeRows(); recipeFormRecost(); }
export function recipeFormRowAmount(i: number, v: string): void { if (!_rf) return; _rf.rows[i].amount = v === '' ? null : Number(v); recipeFormRecost(); }
export function recipeFormRowUnit(i: number, v: string): void { if (!_rf) return; _rf.rows[i].unit = v; recipeFormRecost(); }

export function recipeRowSearch(i: number, query: string): void {
  if (!_rf) return;
  _rf.rows[i].refName = query;
  _rf.rows[i].refId = null; // unresolved until picked
  const el = document.getElementById(`rf-sug-${i}`);
  if (!el) return;
  const q = query.trim().toLowerCase();
  if (q.length < 2) { el.innerHTML = ''; return; }
  let matches: { id: string; label: string; sub: string }[] = [];
  if (_rf.rows[i].refKind === 'drink') {
    matches = (S.drinks || []).filter(d => d.name.toLowerCase().includes(q) && d.id !== _rf!.id)
      .slice(0, 8).map(d => ({ id: d.id, label: d.name, sub: drinkCategoryLabel(d.category) }));
  } else {
    matches = (S.ingredientDb || []).filter(x => x.active !== false && x.name.toLowerCase().includes(q))
      .slice(0, 8).map(x => ({ id: x.id, label: x.name, sub: x.category || '' }));
  }
  el.innerHTML = matches.map(m => `<div class="rf-sug-item" onmousedown="recipeRowPick(${i}, '${jsEsc(m.id)}', '${jsEsc(m.label)}')"><span>${esc(m.label)}</span><span class="muted small">${esc(m.sub)}</span></div>`).join('');
}
export function recipeRowPick(i: number, refId: string, refName: string): void {
  if (!_rf) return;
  _rf.rows[i].refId = refId; _rf.rows[i].refName = refName;
  const el = document.getElementById(`rf-sug-${i}`); if (el) el.innerHTML = '';
  const input = document.querySelector(`.rf-search[data-idx="${i}"]`) as HTMLInputElement; if (input) input.value = refName;
  recipeFormRecost();
}
export function recipeRowHide(i: number): void { setTimeout(() => { const el = document.getElementById(`rf-sug-${i}`); if (el) el.innerHTML = ''; }, 150); }

function renderPrepSteps(): void {
  const wrap = document.getElementById('rf-prep');
  if (!wrap || !_rf) return;
  if (_rf.prepSteps.length === 0) { wrap.innerHTML = `<p class="muted small">No steps yet.</p>`; return; }
  wrap.innerHTML = _rf.prepSteps.map((s, i) => `
    <div class="rf-prep-row"><span class="rf-prep-n">${i + 1}.</span>
      <input value="${esc(s)}" oninput="recipeFormPrepEdit(${i}, this.value)" placeholder="step…">
      <button class="btn btn-sm btn-danger" type="button" onclick="recipeFormRemovePrep(${i})">✕</button>
    </div>`).join('');
}
export function recipeFormAddPrep(): void { if (!_rf) return; _rf.prepSteps.push(''); renderPrepSteps(); }
export function recipeFormRemovePrep(i: number): void { if (!_rf) return; _rf.prepSteps.splice(i, 1); renderPrepSteps(); }
export function recipeFormPrepEdit(i: number, v: string): void { if (!_rf) return; _rf.prepSteps[i] = v; }

function numv(id: string): number | null { const v = (document.getElementById(id) as HTMLInputElement)?.value; return v === '' || v == null ? null : Number(v); }
function strv(id: string): string { return (document.getElementById(id) as HTMLInputElement)?.value?.trim() || ''; }
function boolv(id: string): boolean { return !!(document.getElementById(id) as HTMLInputElement)?.checked; }

/** Build a Drink from the in-progress form for the live cost preview / save. */
function formDrink(): Drink {
  const serveVol = numv('rf-serveVol');
  const price = numv('rf-price');
  const formats: DrinkServingFormat[] = [{ name: 'serve', volumeMl: serveVol || 0, glass: strv('rf-glass') || undefined, price: { west: price } }];
  return {
    id: _rf!.id, name: strv('rf-name'), mode: 'recipe', category: strv('rf-category'),
    subtype: strv('rf-subtype'), abv: numv('rf-abv') ?? 0, btwRate: null,
    status: boolv('rf-published') ? 'published' : 'draft', archived: false, sellable: strv('rf-category') !== 'building-block',
    supplier: 'Homemade', orderUnit: '', orderUnitMl: null, packNote: '', itemId: null, deposit: 0, costPrice: null, costNote: '',
    formats, locations: {}, info: {}, tebiProductNames: [],
    serveVolumeMl: serveVol, glass: strv('rf-glass'), glassVolumeMl: null, servingTemp: strv('rf-temp'),
    characteristics: [], garnish: [], seasonality: '', serviceInstructions: strv('rf-service'),
    prepSteps: _rf!.prepSteps, batch: { volumeMl: numv('rf-batchVol') || 0, bottleSizeMl: numv('rf-bottleSize') },
    prepTime: { prebatchMin: numv('rf-prebatchMin') || 0, prebatchYieldServings: numv('rf-prebatchYield'), perServeMin: numv('rf-perServeMin') || 0 },
    shelfLifeDays: numv('rf-shelf'), costPerServe: null, suggestedPrice: null, createdAt: '', updatedAt: '',
    ingredientRows: _rf!.rows.map((r, i) => ({
      id: `${_rf!.id}-row-${i}`, drinkId: _rf!.id, sortOrder: i, refKind: r.refKind,
      ingredientId: r.refKind === 'ingredient' ? r.refId : null, refDrinkId: r.refKind === 'drink' ? r.refId : null,
      amount: r.amount, unit: r.unit, note: '',
    })),
  };
}

/** Recompute + render the live cost / suggested-price / markup preview. */
export function recipeFormRecost(): void {
  const panel = document.getElementById('rf-cost-preview');
  if (!panel || !_rf) return;
  const c = cfg();
  const d = formDrink();
  const ctx = costCtx(d);
  const isBlock = d.category === 'building-block';
  const cost = drinkTotalCostExBtw(d, ctx);
  const btw = effectiveBtw(d.abv, d.btwRate, c);
  const target = targetMarkupFor(d.category, c);
  const suggested = suggestedPriceInclBtw(cost, btw, target, c);
  const price = numv('rf-price');
  const yh = document.getElementById('rf-yield-hint');
  if (yh) { const yb = yieldBottles(d); yh.textContent = yb > 0 ? `≈ ${yb.toFixed(1)} bottles/batch` : ''; }

  if (isBlock) {
    panel.innerHTML = `<strong>Cost</strong> €${cost.toFixed(2)}/L · BTW ${btw}% <span class="muted small">(building block — used by other drinks)</span>`;
    return;
  }
  const am = actualMarkup(price, btw, cost);
  const light = markupLight(am, target);
  panel.innerHTML = `
    <span><strong>Cost/serve</strong> €${cost.toFixed(2)} ex-BTW</span>
    <span><strong>Suggested</strong> €${suggested.toFixed(2)} <span class="muted small">(${target}× incl ${btw}% BTW)</span></span>
    ${price != null ? `<span class="ml-${light}"><strong>Markup</strong> ${am != null ? am.toFixed(1) + '×' : '—'} <span class="ml-dot ml-${light}"></span></span>` : ''}`;
}

export async function saveDrinkRecipe(): Promise<void> {
  if (!_rf) return;
  const name = strv('rf-name');
  if (!name) { toastError('Name is required.'); return; }
  const category = strv('rf-category');
  const serveVol = numv('rf-serveVol');
  const price = numv('rf-price');
  const payload = {
    id: _rf.id, mode: 'recipe' as const, name, category, subtype: strv('rf-subtype'),
    abv: numv('rf-abv') ?? 0, btwRate: null,
    status: boolv('rf-published') ? 'published' : 'draft',
    sellable: category !== 'building-block',
    serveVolumeMl: serveVol, glass: strv('rf-glass'), servingTemp: strv('rf-temp'),
    serviceInstructions: strv('rf-service'), shelfLifeDays: numv('rf-shelf'),
    batch: { volumeMl: numv('rf-batchVol') || 0, bottleSizeMl: numv('rf-bottleSize') },
    prepTime: { prebatchMin: numv('rf-prebatchMin') || 0, prebatchYieldServings: numv('rf-prebatchYield'), perServeMin: numv('rf-perServeMin') || 0 },
    prepSteps: _rf.prepSteps.filter(s => s.trim()),
    formats: category === 'building-block' ? [] : [{ name: 'serve', volumeMl: serveVol || 0, glass: strv('rf-glass') || undefined, price: { west: price } }],
    ingredientRows: _rf.rows.filter(r => r.refId || r.amount != null).map((r, i) => ({
      refKind: r.refKind, ingredientId: r.refKind === 'ingredient' ? r.refId : null,
      refDrinkId: r.refKind === 'drink' ? r.refId : null, amount: r.amount, unit: r.unit, note: r.refId ? '' : `unlinked: ${r.refName}`, sortOrder: i,
    })),
  };
  try {
    await apiPost(_rf.isNew ? '/api/drinks' : `/api/drinks/${_rf.id}`, payload, _rf.isNew ? 'POST' : 'PATCH');
    toast(_rf.isNew ? 'Recipe added' : 'Recipe saved');
    _rf = null;
    closeModal();
    await loadDrinks();
    renderRecipesTab();
  } catch (e: unknown) {
    toastError('Could not save: ' + (e instanceof Error ? e.message : 'Unknown error'));
  }
}

export function deleteDrinkRecipe(id: string): void {
  const d = (S.drinks || []).find(x => x.id === id);
  if (!d) return;
  const removed = d;
  S.drinks = (S.drinks || []).filter(x => x.id !== id);
  updateRecipeResults();
  pushUndo({
    label: esc(removed.name) + ' deleted',
    restore: () => { S.drinks = [...(S.drinks || []), removed]; updateRecipeResults(); },
    commit: async () => {
      try { await apiPost(`/api/drinks/${id}`, {}, 'DELETE'); }
      catch (e: unknown) { toastError('Could not delete: ' + (e instanceof Error ? e.message : 'Unknown error')); S.drinks = [...(S.drinks || []), removed]; updateRecipeResults(); }
    },
  });
}
