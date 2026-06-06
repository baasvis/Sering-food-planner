import type { Ingredient, StorageLocationMap } from '@shared/types';
import { S, STORAGE, LOCATIONS, ALLERGENS, INGREDIENT_TYPES, INGREDIENT_CATEGORIES, INGREDIENT_TYPE_TO_GROUP, ALL_CATEGORIES, PRICE_LEVELS, STORAGE_CATEGORIES, rebuildStorageCategories, getStorageConfigForLoc, getStorageColor, DEFAULT_STORAGE_CONFIG } from './state';
import { toast, toastError, apiGet, apiPost, saveStorageConfig, loadIngredientDb } from './utils';
import { chipClass } from './core';
import { showModal, closeModal, esc } from './modal';
import { renderOrders } from './orders';
import { locName } from '@shared/location';

// ── INGREDIENT DATABASE TAB ──────────────────────────────────

/** Read `ing.storageLocations`, tolerating a missing map. */
function storLocsOf(ing: Ingredient): StorageLocationMap {
  return ing.storageLocations || {};
}

/**
 * Category/location of a single storage entry. Object entries carry the
 * structured value; legacy bare-string entries have no structured
 * category/location and read as empty — this matches the pre-cleanup
 * behavior of `(entry && entry.category) || ''`.
 */
function storLocParts(entry: StorageLocationMap[string] | undefined): { category: string; location: string } {
  if (!entry || typeof entry === 'string') return { category: '', location: '' };
  return { category: entry.category || '', location: entry.location || '' };
}

// State
// `S.ingredientDb` is the single source of truth. `loadIngredientDb()` (utils)
// fetches the slim shape; `loadIngredientDbFull()` below fetches the rich shape
// (with priceHistory / nutrition / pricePer100g) and replaces it. The
// `S.ingredientDbFullyLoaded` flag tracks which one is in memory.
export let ingredientDbSearch = '';
export let ingredientDbTypeFilter = 'all'; // 'all' | 'Food' | 'Drinks' | 'Non-food'
export let ingredientDbCatFilter = 'all';  // 'all' | category name
export let ingredientDbStatusFilter = 'active'; // 'all' | 'active' | 'inactive'
export let ingredientDbSort = 'name';   // 'name' | 'supplier' | 'category' | 'type'
export let ingredientDbEditId: string | null = null;   // id of ingredient being edited inline

/** Set the edit ID from onclick handlers (module variable, must go through this function) */
export function setIngredientDbEditId(id: string | null) {
  ingredientDbEditId = id;
}
interface SupplierProduct {
  orderCode: string;
  recentOrders: number;
  title: string;
  price: number;
  orderUnit: string;
  orderUnitSize: number;
  priceHistory?: Array<{ month: string; price: number }>;
  nutrition?: Record<string, number>;
}

export let supplierUploadData: SupplierProduct[] | null = null;   // parsed Hanos XLSX data for import
export let ingredientDbPage = 0;        // current page for pagination
export const INGREDIENTS_PER_PAGE = 50;

export function updateIngredientSearch(el: HTMLInputElement) {
  ingredientDbSearch = el.value;
  ingredientDbPage = 0;
  // Split-container rule (audit UIUX-6): update only the results container, never
  // the search input itself, so the caret never jumps and we skip a full
  // Orders-screen rebuild on every keystroke. The caret-restore rAF workaround
  // the old code needed is gone with it.
  updateIngredientDbResults();
}

export async function loadIngredientDbFull() {
  try {
    S.ingredientDb = await apiGet('/api/ingredients/full');
    S.ingredientDbFullyLoaded = true;
  } catch (e: unknown) {
    // Don't blank existing data on a transient error — it'll show stale
    // info instead of an empty editor. Just flag that the rich payload
    // hasn't loaded so the editor can show its loading state.
    S.ingredientDbFullyLoaded = false;
    console.error('Failed to load ingredient DB:', e);
  }
}

export function getCategoriesForTypeFilter() {
  if (ingredientDbTypeFilter === 'all') return ALL_CATEGORIES;
  if (INGREDIENT_CATEGORIES[ingredientDbTypeFilter]) return INGREDIENT_CATEGORIES[ingredientDbTypeFilter];
  // For individual types like 'Kitchen Equipment', get categories from its group
  const group = INGREDIENT_TYPE_TO_GROUP[ingredientDbTypeFilter];
  return group ? INGREDIENT_CATEGORIES[group] : ALL_CATEGORIES;
}

export function ingredientMatchesTypeFilter(ing: Ingredient) {
  if (ingredientDbTypeFilter === 'all') return true;
  const types = ing.types || [];
  if (ingredientDbTypeFilter === 'Food' || ingredientDbTypeFilter === 'Drinks' || ingredientDbTypeFilter === 'Non-food') {
    if (ingredientDbTypeFilter === 'Non-food') {
      return types.some(t => INGREDIENT_TYPE_TO_GROUP[t] === 'Non-food');
    }
    return types.includes(ingredientDbTypeFilter);
  }
  return types.includes(ingredientDbTypeFilter);
}

export function getFilteredIngredients() {
  let list = S.ingredientDb;

  // Type filter
  if (ingredientDbTypeFilter !== 'all') list = list.filter(ingredientMatchesTypeFilter);

  // Category filter
  if (ingredientDbCatFilter !== 'all') list = list.filter(i => i.category === ingredientDbCatFilter);

  // Status filter
  if (ingredientDbStatusFilter === 'active') list = list.filter(i => i.active !== false);
  else if (ingredientDbStatusFilter === 'inactive') list = list.filter(i => i.active === false);

  // Search
  if (ingredientDbSearch) {
    const q = ingredientDbSearch.toLowerCase();
    list = list.filter(i =>
      (i.name || '').toLowerCase().includes(q) ||
      (i.supplierName || '').toLowerCase().includes(q) ||
      (i.orderCode || '').includes(q) ||
      (i.supplier || '').toLowerCase().includes(q) ||
      (i.notes || '').toLowerCase().includes(q) ||
      (i.category || '').toLowerCase().includes(q)
    );
  }

  // Sort
  if (ingredientDbSort === 'supplier') list = [...list].sort((a: Ingredient, b: Ingredient) => (a.supplier || '').localeCompare(b.supplier || '') || a.name.localeCompare(b.name));
  else if (ingredientDbSort === 'category') list = [...list].sort((a: Ingredient, b: Ingredient) => (a.category || '').localeCompare(b.category || '') || a.name.localeCompare(b.name));
  else if (ingredientDbSort === 'type') list = [...list].sort((a: Ingredient, b: Ingredient) => ((a.types||[])[0]||'').localeCompare((b.types||[])[0]||'') || a.name.localeCompare(b.name));
  else list = [...list].sort((a: Ingredient, b: Ingredient) => a.name.localeCompare(b.name));

  return list;
}

export function renderTypePills(types: string[]) {
  if (!types || !types.length) return '<span style="color:var(--text3);font-size:11px;">—</span>';
  return types.map(t => {
    const colors: Record<string, string> = {Food:'--green',Drinks:'--blue','Kitchen Equipment':'--text2',Cleaning:'--purple','FOH Supplies':'--orange','FOH Equipment':'--orange',Office:'--text2'};
    const c = colors[t] || '--text2';
    return `<span class="type-pill" style="border-color:var(${c});color:var(${c});">${esc(t)}</span>`;
  }).join(' ');
}

export function renderPriceLevel(level: string) {
  if (!level) return '';
  const icons: Record<string, string> = {cheap:'$',medium:'$$',expensive:'$$$'};
  const colors: Record<string, string> = {cheap:'var(--green)',medium:'var(--orange)',expensive:'var(--red)'};
  return `<span style="font-size:11px;font-weight:600;color:${colors[level]||'var(--text2)'};" title="${level}">${icons[level]||level}</span>`;
}

export function renderInlineStock(ing: Ingredient) {
  const stock = ing.stock || {};
  const wAmt = (stock.west && stock.west.amount) || '';
  const cAmt = (stock.centraal && stock.centraal.amount) || '';
  const u = (ing.unit || 'Grams').toLowerCase();
  const unitLabel = u === 'ml' ? 'ml' : u === 'pieces' || u === 'amount' ? 'pcs' : 'g';
  return `<div style="display:flex;gap:2px;align-items:center;">
    <span style="font-size:9px;color:var(--text3);">W:</span><input class="order-stock-input" style="width:45px;font-size:11px;height:22px;" type="number" min="0" step="1" value="${wAmt}" placeholder="0" oninput="saveInlineStock('${esc(ing.id)}','west',this.value)" /><span style="font-size:9px;color:var(--text3);">${unitLabel}</span>
    <span style="font-size:9px;color:var(--text3);margin-left:2px;">C:</span><input class="order-stock-input" style="width:45px;font-size:11px;height:22px;" type="number" min="0" step="1" value="${cAmt}" placeholder="0" oninput="saveInlineStock('${esc(ing.id)}','centraal',this.value)" /><span style="font-size:9px;color:var(--text3);">${unitLabel}</span>
  </div>`;
}

// Per-row debouncers keyed by `${ingredientId}|${location}`. A single shared
// timeout (the previous design — audit A19) cancelled the pending POST for
// ingredient A whenever the user moved on to ingredient B, so A's edit was
// stuck in S.ingredientDb but never reached the server.
export const _inlineStockTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
export function saveInlineStock(ingId: string, location: string, val: string) {
  const amount = parseFloat(val) || 0;

  const ing = S.ingredientDb.find(i => i.id === ingId);
  if (ing) {
    if (!ing.stock) ing.stock = {};
    ing.stock[location] = { amount, date: new Date().toISOString().slice(0, 10) };
  }

  // Debounced save to backend. apiPost throws on non-2xx (instead of the
  // bare-fetch silent fail the audit flagged as T4) — pipe to toastError so
  // a kitchen-network blip is visible instead of a UI value that "looks
  // saved" but never persisted.
  const key = `${ingId}|${location}`;
  const existing = _inlineStockTimeouts.get(key);
  if (existing) clearTimeout(existing);
  _inlineStockTimeouts.set(key, setTimeout(() => {
    _inlineStockTimeouts.delete(key);
    apiPost('/api/ingredients/stock', { ingredientId: ingId, location, amount }).catch((e: unknown) => {
      toastError('Stock save failed: ' + (e instanceof Error ? e.message : 'Unknown error'));
    });
  }, 600));
}

export function renderStockBadges(stock: Ingredient['stock'] | undefined) {
  if (!stock || (!stock.west && !stock.centraal)) return '<span style="color:var(--text3);font-size:11px;">—</span>';
  const parts = [];
  if (stock.west) parts.push(`<span class="stock-badge" title="West: ${stock.west.date||''}">W:${stock.west.amount||0}</span>`);
  if (stock.centraal) parts.push(`<span class="stock-badge" title="Centraal: ${stock.centraal.date||''}">C:${stock.centraal.amount||0}</span>`);
  return parts.join(' ');
}

export function renderIngredientDbTab() {
  if (!S.ingredientDbFullyLoaded) {
    loadIngredientDbFull().then(() => renderOrders());
    return '<div class="empty">Loading ingredient database...</div>';
  }

  const filtered = getFilteredIngredients();
  const availableCats = getCategoriesForTypeFilter();

  // Category dropdown options
  const catOptions = [
    '<option value="all"' + (ingredientDbCatFilter === 'all' ? ' selected' : '') + '>All categories</option>',
    ...availableCats.map(c => '<option value="' + esc(c) + '"' + (ingredientDbCatFilter === c ? ' selected' : '') + '>' + esc(c) + '</option>')
  ].join('');

  // Split-container (CLAUDE.md Search/Filter rule, audit UIUX-6): the search
  // input is rendered ONCE here and never replaced; keystrokes update only
  // #ingredient-db-results via updateIngredientSearch → updateIngredientDbResults.
  // The non-text filter controls (type pills, category/status/sort selects,
  // pagination) still call renderOrders() — they carry no caret to lose and the
  // category dropdown options depend on the type filter, so a full re-render is
  // the correct, low-risk path for those.
  let html = `<div>
    <div class="section-title" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
      <span>Ingredient Database (${S.ingredientDb.length} total, <span id="ing-db-count">${filtered.length}</span> shown)</span>
      <div style="display:flex;gap:8px;align-items:center;">
        <button class="btn btn-sm" onclick="openAddIngredientModal()">+ Add ingredient</button>
        <button class="btn btn-sm" onclick="openStorageLocationsModal()">Storage locations</button>
        <label class="btn btn-sm" style="cursor:pointer;">
          Upload Hanos XLSX
          <input type="file" accept=".xlsx,.xls" style="display:none;" onchange="handleSupplierUpload(this.files[0])" />
        </label>
      </div>
    </div>

    <div class="ing-filter-bar">
      <div class="ing-type-pills">
        <button class="ing-type-pill${ingredientDbTypeFilter==='all'?' active':''}" onclick="ingredientDbTypeFilter='all';ingredientDbCatFilter='all';ingredientDbPage=0;renderOrders()">All</button>
        <button class="ing-type-pill${ingredientDbTypeFilter==='Food'?' active':''}" onclick="ingredientDbTypeFilter='Food';ingredientDbCatFilter='all';ingredientDbPage=0;renderOrders()">Food</button>
        <button class="ing-type-pill${ingredientDbTypeFilter==='Drinks'?' active':''}" onclick="ingredientDbTypeFilter='Drinks';ingredientDbCatFilter='all';ingredientDbPage=0;renderOrders()">Drinks</button>
        <button class="ing-type-pill${ingredientDbTypeFilter==='Non-food'?' active':''}" onclick="ingredientDbTypeFilter='Non-food';ingredientDbCatFilter='all';ingredientDbPage=0;renderOrders()">Non-food</button>
      </div>
      <input type="text" class="dish-search" style="flex:1;min-width:180px;margin:0;" placeholder="Search name, supplier, code..."
        id="ing-db-search" value="${esc(ingredientDbSearch)}" oninput="updateIngredientSearch(this)" />
      <select class="dish-search" style="width:auto;margin:0;" onchange="ingredientDbCatFilter=this.value;ingredientDbPage=0;renderOrders()">
        ${catOptions}
      </select>
      <select class="dish-search" style="width:auto;margin:0;" onchange="ingredientDbStatusFilter=this.value;ingredientDbPage=0;renderOrders()">
        <option value="all"${ingredientDbStatusFilter==='all'?' selected':''}>All status</option>
        <option value="active"${ingredientDbStatusFilter==='active'?' selected':''}>Active only</option>
        <option value="inactive"${ingredientDbStatusFilter==='inactive'?' selected':''}>Inactive only</option>
      </select>
      <select class="dish-search" style="width:auto;margin:0;" onchange="ingredientDbSort=this.value;ingredientDbPage=0;renderOrders()">
        <option value="name"${ingredientDbSort === 'name' ? ' selected' : ''}>Sort: Name</option>
        <option value="type"${ingredientDbSort === 'type' ? ' selected' : ''}>Sort: Type</option>
        <option value="category"${ingredientDbSort === 'category' ? ' selected' : ''}>Sort: Category</option>
        <option value="supplier"${ingredientDbSort === 'supplier' ? ' selected' : ''}>Sort: Supplier</option>
      </select>
    </div>
    <div id="ingredient-db-results">${renderIngredientDbResults(filtered)}</div>
  </div>`;
  return html;
}

/** Render only the supplier-import panel + ingredient table + pagination — the
 *  portion that lives inside #ingredient-db-results. Kept separate from the
 *  filter bar so a search keystroke can update results without replacing the
 *  search input (split-container rule, audit UIUX-6). The caller may pass a
 *  precomputed filtered list to avoid filtering twice on the initial render. */
function renderIngredientDbResults(filtered: Ingredient[] = getFilteredIngredients()): string {
  let html = '';

  if (supplierUploadData) {
    html += renderSupplierImportPanel();
  }

  if (!filtered.length) {
    html += '<div class="empty">No ingredients match your search.</div>';
  } else {
    const totalPages = Math.ceil(filtered.length / INGREDIENTS_PER_PAGE);
    if (ingredientDbPage >= totalPages) ingredientDbPage = Math.max(0, totalPages - 1);
    const start = ingredientDbPage * INGREDIENTS_PER_PAGE;
    const pageItems = filtered.slice(start, start + INGREDIENTS_PER_PAGE);
    // If editing an item not on the current page, include it
    const editItem = ingredientDbEditId ? filtered.find(i => i.id === ingredientDbEditId) : null;
    const showItems = editItem && !pageItems.find(i => i.id === editItem.id)
      ? [editItem, ...pageItems]
      : pageItems;

    html += `<div style="overflow-x:auto;"><table class="ing-table">
      <thead><tr>
        <th>Name</th>
        <th>Type(s)</th>
        <th>Category</th>
        <th>Supplier</th>
        <th>Order code</th>
        <th>Unit / Price</th>
        <th>Price</th>
        <th>Stock</th>
        <th>Active</th>
        <th></th>
      </tr></thead><tbody>`;

    showItems.forEach(ing => {
      if (ingredientDbEditId === ing.id) {
        html += renderIngredientEditRow(ing);
      } else {
        const activeClass = ing.active === false ? ' style="opacity:.5;"' : '';
        const priceAlertIcon = ing.priceAlert ? ' <span title="Price increased significantly" style="color:var(--red);font-size:12px;">&#9650;</span>' : '';
        html += `<tr${activeClass}>
          <td style="font-weight:500;">
            ${esc(ing.name)}
            <div style="font-size:11px;color:var(--text3);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(ing.supplierName||'')}">${esc(ing.supplierName || '')}</div>
          </td>
          <td>${renderTypePills(ing.types)}</td>
          <td style="font-size:12px;cursor:pointer;color:var(--blue);" onclick="showInlineCategoryEdit('${esc(ing.id)}',this)" title="Click to change">${esc(ing.category || '—')}</td>
          <td style="font-size:12px;">${esc(ing.supplier || '—')}</td>
          <td>${ing.orderCode ? '<span class="order-code">' + esc(ing.orderCode) + '</span>' : '<span style="color:var(--text3);">—</span>'}</td>
          <td style="font-size:12px;">${ing.orderUnit ? esc(ing.orderUnit) : esc(ing.unit || '—')}${ing.orderPrice ? ' · \u20AC' + Number(ing.orderPrice).toFixed(2) : ''}</td>
          <td style="font-size:11px;">${renderPriceLevel(ing.priceLevel)}${priceAlertIcon}${ing.pricePer100 ? '<div style="color:var(--text3);">\u20AC' + ing.pricePer100.toFixed(2) + '/100</div>' : ''}</td>
          <td>${renderInlineStock(ing)}</td>
          <td><span style="cursor:pointer;font-size:16px;" onclick="toggleIngredientActive('${esc(ing.id)}')">${ing.active !== false ? '\u2705' : '\u274C'}</span></td>
          <td>
            <button class="btn btn-sm" onclick="setIngredientDbEditId('${esc(ing.id)}');renderOrders()">Edit</button>
          </td>
        </tr>`;
      }
    });

    html += '</tbody></table></div>';

    // Pagination controls
    if (totalPages > 1) {
      html += `<div style="display:flex;justify-content:center;align-items:center;gap:8px;padding:12px 0;">
        <button class="btn btn-sm" ${ingredientDbPage === 0 ? 'disabled' : ''} onclick="ingredientDbPage=0;renderOrders()">&laquo;</button>
        <button class="btn btn-sm" ${ingredientDbPage === 0 ? 'disabled' : ''} onclick="ingredientDbPage--;renderOrders()">&lsaquo; Prev</button>
        <span style="font-size:12px;color:var(--text2);">Page ${ingredientDbPage + 1} of ${totalPages} (${filtered.length} items)</span>
        <button class="btn btn-sm" ${ingredientDbPage >= totalPages - 1 ? 'disabled' : ''} onclick="ingredientDbPage++;renderOrders()">Next &rsaquo;</button>
        <button class="btn btn-sm" ${ingredientDbPage >= totalPages - 1 ? 'disabled' : ''} onclick="ingredientDbPage=${totalPages - 1};renderOrders()">&raquo;</button>
      </div>`;
    }
  }

  return html;
}

/** Update ONLY the results container + the "shown" count — never the search
 *  input (split-container rule, audit UIUX-6). No-op if the ingredient-db tab
 *  isn't currently mounted. */
export function updateIngredientDbResults(): void {
  const el = document.getElementById('ingredient-db-results');
  if (!el) return;
  const filtered = getFilteredIngredients();
  el.innerHTML = renderIngredientDbResults(filtered);
  const count = document.getElementById('ing-db-count');
  if (count) count.textContent = String(filtered.length);
}

export function renderIngredientEditRow(ing: Ingredient) {
  const types = ing.types || [];
  const storLocs = storLocsOf(ing);
  const nutrition = ing.nutrition || {};

  // Type checkboxes
  const typeChecks = INGREDIENT_TYPES.map(t =>
    `<label class="ing-edit-type-label"><input type="checkbox" class="ing-edit-type-cb" value="${esc(t)}" ${types.includes(t)?'checked':''} onchange="updateEditCategoryOptions()" /> ${esc(t)}</label>`
  ).join('');

  // Category dropdown — show categories for currently checked types
  const checkedTypes = types.length ? types : [];
  const groups = new Set(checkedTypes.map(t => INGREDIENT_TYPE_TO_GROUP[t]).filter(Boolean));
  let catOptions = [];
  if (groups.size === 0) { catOptions = ALL_CATEGORIES; }
  else { groups.forEach(g => { catOptions = catOptions.concat(INGREDIENT_CATEGORIES[g] || []); }); }
  const catSelect = '<option value="">— Select —</option>' + catOptions.map(c =>
    `<option value="${esc(c)}"${ing.category===c?' selected':''}>${esc(c)}</option>`
  ).join('');

  // Storage location dropdowns (category + location per building)
  const storageCatNames = Object.keys(STORAGE_CATEGORIES);
  const { category: westCat, location: westLoc } = storLocParts(storLocs.west);
  const { category: centraalCat, location: centraalLoc } = storLocParts(storLocs.centraal);
  const westCatOpts = '<option value="">—</option>' + storageCatNames.map(c => `<option value="${esc(c)}"${westCat===c?' selected':''}>${esc(c)}</option>`).join('');
  const westLocOpts = '<option value="">—</option>' + (westCat && STORAGE_CATEGORIES[westCat] ? STORAGE_CATEGORIES[westCat] : []).map(l => `<option value="${esc(l)}"${westLoc===l?' selected':''}>${esc(l)}</option>`).join('');
  const centraalCatOpts = '<option value="">—</option>' + storageCatNames.map(c => `<option value="${esc(c)}"${centraalCat===c?' selected':''}>${esc(c)}</option>`).join('');
  const centraalLocOpts = '<option value="">—</option>' + (centraalCat && STORAGE_CATEGORIES[centraalCat] ? STORAGE_CATEGORIES[centraalCat] : []).map(l => `<option value="${esc(l)}"${centraalLoc===l?' selected':''}>${esc(l)}</option>`).join('');

  return `<tr style="background:var(--bg2);">
    <td colspan="10" style="padding:12px;">
      <div class="ing-edit-grid">
        <div class="ing-edit-section">
          <div class="ing-edit-row">
            <div style="flex:2;">
              <label class="ing-edit-label">Name *</label>
              <input class="order-stock-input" style="width:100%;" value="${esc(ing.name)}" id="ing-edit-name" />
            </div>
            <div style="flex:2;">
              <label class="ing-edit-label">Supplier name</label>
              <input class="order-stock-input" style="width:100%;" value="${esc(ing.supplierName || '')}" id="ing-edit-supplierName" />
            </div>
            <div style="flex:1;">
              <label class="ing-edit-label">Supplier</label>
              <input class="order-stock-input" style="width:100%;" value="${esc(ing.supplier || '')}" id="ing-edit-supplier" />
            </div>
          </div>

          <div class="ing-edit-row">
            <div style="flex:1;">
              <label class="ing-edit-label">Types</label>
              <div class="ing-edit-types">${typeChecks}</div>
            </div>
          </div>

          <div class="ing-edit-row">
            <div style="flex:1;">
              <label class="ing-edit-label">Category</label>
              <select class="order-stock-input" style="width:100%;" id="ing-edit-category">${catSelect}</select>
            </div>
            <div style="flex:1;">
              <label class="ing-edit-label">Unit</label>
              <select class="order-stock-input" style="width:100%;" id="ing-edit-unit">
                <option${ing.unit==='Grams'?' selected':''}>Grams</option>
                <option${ing.unit==='ML'?' selected':''}>ML</option>
                <option${ing.unit==='pieces'?' selected':''}>pieces</option>
              </select>
            </div>
            <div style="flex:1;">
              <label class="ing-edit-label">Price level</label>
              <select class="order-stock-input" style="width:100%;" id="ing-edit-priceLevel">
                <option value="">—</option>
                ${PRICE_LEVELS.map(l => `<option value="${l}"${ing.priceLevel===l?' selected':''}>${l}</option>`).join('')}
              </select>
            </div>
            <div>
              <label class="ing-edit-label">Active</label>
              <div><input type="checkbox" id="ing-edit-active" ${ing.active !== false ? 'checked' : ''} /></div>
            </div>
          </div>
        </div>

        <div class="ing-edit-section">
          <div class="ing-edit-row">
            <div style="flex:1;">
              <label class="ing-edit-label">Order code</label>
              <input class="order-stock-input" style="width:100%;" value="${esc(ing.orderCode || '')}" id="ing-edit-orderCode" />
            </div>
            <div style="flex:1;">
              <label class="ing-edit-label">Order unit</label>
              <input class="order-stock-input" style="width:100%;" value="${esc(ing.orderUnit || '')}" id="ing-edit-orderUnit" />
            </div>
            <div style="flex:1;">
              <label class="ing-edit-label">Price (\u20AC)</label>
              <input class="order-stock-input" style="width:100%;" type="number" step="0.01" value="${ing.orderPrice || ''}" placeholder="0.00" id="ing-edit-orderPrice" />
            </div>
            <div style="flex:1;">
              <label class="ing-edit-label">Amount (g/ml)</label>
              <input class="order-stock-input" style="width:100%;" type="number" step="1" value="${ing.orderUnitSize || ''}" placeholder="0" id="ing-edit-orderUnitSize" />
            </div>
          </div>

          <div class="ing-edit-row">
            <div style="flex:1;">
              <label class="ing-edit-label">West: Area</label>
              <select class="order-stock-input" style="width:100%;" id="ing-edit-storageWestCat" onchange="updateStorageLocOpts('west')">${westCatOpts}</select>
            </div>
            <div style="flex:1;">
              <label class="ing-edit-label">West: Spot</label>
              <select class="order-stock-input" style="width:100%;" id="ing-edit-storageWestLoc">${westLocOpts}</select>
            </div>
            <div style="flex:1;">
              <label class="ing-edit-label">Centraal: Area</label>
              <select class="order-stock-input" style="width:100%;" id="ing-edit-storageCentraalCat" onchange="updateStorageLocOpts('centraal')">${centraalCatOpts}</select>
            </div>
            <div style="flex:1;">
              <label class="ing-edit-label">Centraal: Spot</label>
              <select class="order-stock-input" style="width:100%;" id="ing-edit-storageCentraalLoc">${centraalLocOpts}</select>
            </div>
            <div style="flex:2;">
              <label class="ing-edit-label">Notes</label>
              <input class="order-stock-input" style="width:100%;" value="${esc(ing.notes || '')}" id="ing-edit-notes" placeholder="Notes..." />
            </div>
          </div>

          <div class="ing-edit-row">
            <div style="flex:1;">
              <label class="ing-edit-label">Allergens</label>
              <input class="order-stock-input" style="width:100%;" value="${esc(ing.allergens || '')}" id="ing-edit-allergens" placeholder="Allergens" />
            </div>
            <div style="flex:1;">
              <label class="ing-edit-label">Price/100 ${ing.unit === 'ML' ? 'ml' : ing.unit === 'pieces' ? 'pcs' : 'g'}</label>
              <span style="font-size:12px;color:var(--text2);">${ing.pricePer100 ? '\u20AC' + ing.pricePer100.toFixed(2) : '—'}</span>
            </div>
            <div style="flex:1;">
              <label class="ing-edit-label">Stock West (${ing.unit === 'ML' ? 'ml' : ing.unit === 'pieces' ? 'pcs' : 'g'})</label>
              <input class="order-stock-input" style="width:80px;" type="number" min="0" step="1" value="${(ing.stock&&ing.stock.west)?ing.stock.west.amount:''}" placeholder="0" id="ing-edit-stockWest" />
            </div>
            <div style="flex:1;">
              <label class="ing-edit-label">Stock Centraal (${ing.unit === 'ML' ? 'ml' : ing.unit === 'pieces' ? 'pcs' : 'g'})</label>
              <input class="order-stock-input" style="width:80px;" type="number" min="0" step="1" value="${(ing.stock&&ing.stock.centraal)?ing.stock.centraal.amount:''}" placeholder="0" id="ing-edit-stockCentraal" />
            </div>
          </div>

          <details class="ing-edit-nutrition">
            <summary style="font-size:11px;color:var(--text2);cursor:pointer;">Nutrition info (per 100g)</summary>
            <div class="ing-edit-row" style="margin-top:6px;">
              ${['energyKj','energyKcal','protein','carbs','sugar','fat','saturatedFat','fiber','salt'].map(k => {
                const labels = {energyKj:'Energy kJ',energyKcal:'Energy kcal',protein:'Protein g',carbs:'Carbs g',sugar:'Sugar g',fat:'Fat g',saturatedFat:'Sat. fat g',fiber:'Fiber g',salt:'Salt g'};
                return `<div style="flex:1;min-width:70px;">
                  <label class="ing-edit-label">${labels[k]}</label>
                  <input class="order-stock-input" style="width:100%;" type="number" step="0.1" value="${nutrition[k]||''}" placeholder="—" id="ing-edit-nut-${k}" />
                </div>`;
              }).join('')}
            </div>
          </details>
        </div>

        <div style="display:flex;gap:8px;justify-content:flex-end;align-items:center;margin-top:8px;">
          <button class="btn btn-sm btn-danger" onclick="deleteIngredient('${esc(ing.id)}','${esc(ing.name)}')">Delete</button>
          <button class="btn btn-sm" onclick="setIngredientDbEditId(null);renderOrders()">Cancel</button>
          <button class="btn btn-sm" style="background:var(--green);color:white;" onclick="saveIngredientEdit('${esc(ing.id)}')">Save</button>
        </div>
      </div>
    </td>
  </tr>`;
}

export function showInlineCategoryEdit(ingId: string, td: HTMLElement) {
  const ing = S.ingredientDb.find(i => i.id === ingId);
  if (!ing) return;
  const opts = '<option value="">—</option>' + ALL_CATEGORIES.map(c =>
    `<option value="${esc(c)}"${ing.category===c?' selected':''}>${esc(c)}</option>`
  ).join('');
  td.innerHTML = `<select class="order-stock-input" style="width:100%;text-align:left;font-size:12px;" onchange="saveInlineCategory('${esc(ingId)}',this.value)" onblur="renderOrders()">${opts}</select>`;
  td.querySelector('select').focus();
}

export async function saveInlineCategory(ingId: string, value: string) {
  const ing = S.ingredientDb.find(i => i.id === ingId);
  if (!ing) return;
  ing.category = value;
  try {
    await apiPost('/api/ingredients/' + ingId, ing);
    loadIngredientDb();
    renderOrders();
    toast('Category updated');
  } catch (e: unknown) {
    toastError('Save failed');
  }
}

export function updateStorageLocOpts(building: string) {
  const catSel = document.getElementById('ing-edit-storage' + (building === 'west' ? 'West' : 'Centraal') + 'Cat') as HTMLSelectElement | null;
  const locSel = document.getElementById('ing-edit-storage' + (building === 'west' ? 'West' : 'Centraal') + 'Loc') as HTMLSelectElement | null;
  if (!catSel || !locSel) return;
  const cat = catSel.value;
  const locs = cat && STORAGE_CATEGORIES[cat] ? STORAGE_CATEGORIES[cat] : [];
  locSel.innerHTML = '<option value="">—</option>' + locs.map(l => `<option value="${esc(l)}">${esc(l)}</option>`).join('');
}

export function updateEditCategoryOptions() {
  const checks = document.querySelectorAll<HTMLInputElement>('.ing-edit-type-cb');
  const checked = [...checks].filter(c => c.checked).map(c => c.value);
  const groups = new Set(checked.map(t => INGREDIENT_TYPE_TO_GROUP[t]).filter(Boolean));
  let catOptions: string[] = [];
  if (groups.size === 0) { catOptions = ALL_CATEGORIES; }
  else { groups.forEach(g => { catOptions = catOptions.concat(INGREDIENT_CATEGORIES[g] || []); }); }

  const sel = document.getElementById('ing-edit-category') as HTMLSelectElement | null;
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="">— Select —</option>' + catOptions.map(c =>
    `<option value="${esc(c)}"${current===c?' selected':''}>${esc(c)}</option>`
  ).join('');
}

export async function saveIngredientEdit(id: string) {
  const ing = S.ingredientDb.find(i => i.id === id);
  if (!ing) return;

  const nameVal = ((document.getElementById('ing-edit-name') as HTMLInputElement | null)?.value || '').trim();
  if (!nameVal) { toastError('Name is required'); return; }
  const catVal = (document.getElementById('ing-edit-category') as HTMLSelectElement | null)?.value || '';
  if (!catVal) { toastError('Category is required'); return; }

  // Collect types from checkboxes
  const typeChecks = document.querySelectorAll<HTMLInputElement>('.ing-edit-type-cb');
  const types = [...typeChecks].filter(c => c.checked).map(c => c.value);
  if (!types.length) { toastError('At least one type is required'); return; }

  // Collect nutrition
  const nutrition: Record<string, number> = {};
  ['energyKj','energyKcal','protein','carbs','sugar','fat','saturatedFat','fiber','salt'].forEach(k => {
    const el = document.getElementById('ing-edit-nut-' + k) as HTMLInputElement | null;
    if (el && el.value !== '') nutrition[k] = parseFloat(el.value) || 0;
  });

  const orderPrice = parseFloat((document.getElementById('ing-edit-orderPrice') as HTMLInputElement).value) || null;
  const orderUnitSize = parseFloat((document.getElementById('ing-edit-orderUnitSize') as HTMLInputElement).value) || 0;

  const updated = {
    ...ing,
    name: (document.getElementById('ing-edit-name') as HTMLInputElement).value.trim(),
    supplierName: (document.getElementById('ing-edit-supplierName') as HTMLInputElement).value.trim(),
    types,
    category: (document.getElementById('ing-edit-category') as HTMLSelectElement).value,
    unit: (document.getElementById('ing-edit-unit') as HTMLSelectElement).value,
    supplier: (document.getElementById('ing-edit-supplier') as HTMLInputElement).value.trim(),
    orderCode: (document.getElementById('ing-edit-orderCode') as HTMLInputElement).value.trim(),
    orderUnit: (document.getElementById('ing-edit-orderUnit') as HTMLInputElement).value.trim(),
    orderPrice,
    orderUnitSize,
    priceLevel: (document.getElementById('ing-edit-priceLevel') as HTMLSelectElement).value,
    pricePer100: (orderPrice && orderUnitSize > 0) ? Math.round((orderPrice / orderUnitSize) * 10000) / 100 : 0,
    storageLocations: {
      west: { category: (document.getElementById('ing-edit-storageWestCat') as HTMLSelectElement).value, location: (document.getElementById('ing-edit-storageWestLoc') as HTMLSelectElement).value },
      centraal: { category: (document.getElementById('ing-edit-storageCentraalCat') as HTMLSelectElement).value, location: (document.getElementById('ing-edit-storageCentraalLoc') as HTMLSelectElement).value },
    },
    stock: {
      west: { amount: parseFloat((document.getElementById('ing-edit-stockWest') as HTMLInputElement).value) || 0, date: new Date().toISOString().slice(0, 10) },
      centraal: { amount: parseFloat((document.getElementById('ing-edit-stockCentraal') as HTMLInputElement).value) || 0, date: new Date().toISOString().slice(0, 10) },
    },
    nutrition: Object.keys(nutrition).length ? nutrition : {},
    active: (document.getElementById('ing-edit-active') as HTMLInputElement).checked,
    notes: (document.getElementById('ing-edit-notes') as HTMLInputElement).value.trim(),
    allergens: (document.getElementById('ing-edit-allergens') as HTMLInputElement).value.trim(),
  };

  if (!updated.name) { toastError('Name is required'); return; }

  try {
    await apiPost('/api/ingredients/' + id, updated);
    Object.assign(ing, updated);
    ingredientDbEditId = null;
    closeModal();
    loadIngredientDb();
    renderOrders();
    toast('Ingredient saved');
  } catch (e: unknown) {
    toastError('Save failed: ' + (e instanceof Error ? e.message : 'Unknown error'));
  }
}

export async function toggleIngredientActive(id: string) {
  const ing = S.ingredientDb.find(i => i.id === id);
  if (!ing) return;
  ing.active = !ing.active;
  try {
    await apiPost('/api/ingredients/' + id, ing);
    renderOrders();
  } catch (e: unknown) {
    ing.active = !ing.active;
    toastError('Save failed');
  }
}

export async function deleteIngredient(id: string, name: string) {
  if (!confirm('Delete "' + name + '"? This cannot be undone.')) return;
  try {
    const r = await fetch('/api/ingredients/' + id, { method: 'DELETE' });
    if (!r.ok) throw new Error('Delete failed');
    S.ingredientDb = S.ingredientDb.filter(i => i.id !== id);
    ingredientDbEditId = null;
    loadIngredientDb();
    renderOrders();
    toast('Ingredient deleted');
  } catch (e: unknown) {
    toastError('Delete failed: ' + (e instanceof Error ? e.message : 'Unknown error'));
  }
}

export async function openIngredientModal(name: string) {
  if (!S.ingredientDbFullyLoaded) await loadIngredientDbFull();
  const ing = S.ingredientDb.find(i => i.name.toLowerCase().trim() === name.toLowerCase().trim());
  if (!ing) { toastError('Ingredient not found in database'); return; }

  // Reuse the full edit form from renderIngredientEditRow, adapted for modal
  const types = ing.types || [];
  const storLocs = storLocsOf(ing);
  const nutrition = ing.nutrition || {};

  const typeChecks = INGREDIENT_TYPES.map(t =>
    `<label class="ing-edit-type-label"><input type="checkbox" class="ing-edit-type-cb" value="${esc(t)}" ${types.includes(t)?'checked':''} onchange="updateEditCategoryOptions()" /> ${esc(t)}</label>`
  ).join('');

  const checkedTypes = types.length ? types : [];
  const groups = new Set(checkedTypes.map(t => INGREDIENT_TYPE_TO_GROUP[t]).filter(Boolean));
  let catOptions = [];
  if (groups.size === 0) { catOptions = ALL_CATEGORIES; }
  else { groups.forEach(g => { catOptions = catOptions.concat(INGREDIENT_CATEGORIES[g] || []); }); }
  const catSelect = '<option value="">— Select —</option>' + catOptions.map(c =>
    `<option value="${esc(c)}"${ing.category===c?' selected':''}>${esc(c)}</option>`
  ).join('');

  const storageCatNames = Object.keys(STORAGE_CATEGORIES);
  const { category: westCat, location: westLoc } = storLocParts(storLocs.west);
  const { category: centraalCat, location: centraalLoc } = storLocParts(storLocs.centraal);
  const westCatOpts = '<option value="">—</option>' + storageCatNames.map(c => `<option value="${esc(c)}"${westCat===c?' selected':''}>${esc(c)}</option>`).join('');
  const westLocOpts = '<option value="">—</option>' + (westCat && STORAGE_CATEGORIES[westCat] ? STORAGE_CATEGORIES[westCat] : []).map(l => `<option value="${esc(l)}"${westLoc===l?' selected':''}>${esc(l)}</option>`).join('');
  const centraalCatOpts = '<option value="">—</option>' + storageCatNames.map(c => `<option value="${esc(c)}"${centraalCat===c?' selected':''}>${esc(c)}</option>`).join('');
  const centraalLocOpts = '<option value="">—</option>' + (centraalCat && STORAGE_CATEGORIES[centraalCat] ? STORAGE_CATEGORIES[centraalCat] : []).map(l => `<option value="${esc(l)}"${centraalLoc===l?' selected':''}>${esc(l)}</option>`).join('');

  const modalHtml = `
    <div style="padding:20px;max-width:600px;">
      <h3 style="margin:0 0 16px;">Edit: ${esc(ing.name)}</h3>
      <div style="margin-bottom:12px;padding:8px 12px;background:var(--bg2);border-radius:var(--radius);border:1px solid var(--border);">
        <label class="ing-edit-label" style="margin-bottom:4px;">🔍 Hanos lookup — paste order code or URL</label>
        <div style="display:flex;gap:6px;">
          <input class="order-stock-input" style="flex:1;" id="ing-hanos-lookup" placeholder="e.g. 34295808 or https://www.hanos.nl/..." />
          <button class="btn btn-sm" style="white-space:nowrap;background:var(--blue);color:white;" onclick="hanosLookupProduct()">Lookup</button>
        </div>
        <div id="ing-hanos-status" style="font-size:11px;color:var(--text2);margin-top:4px;"></div>
      </div>
      <div class="ing-edit-grid">
        <div class="ing-edit-section">
          <div class="ing-edit-row">
            <div style="flex:2;">
              <label class="ing-edit-label">Name *</label>
              <input class="order-stock-input" style="width:100%;" value="${esc(ing.name)}" id="ing-edit-name" />
            </div>
            <div style="flex:2;">
              <label class="ing-edit-label">Supplier name</label>
              <input class="order-stock-input" style="width:100%;" value="${esc(ing.supplierName || '')}" id="ing-edit-supplierName" />
            </div>
            <div style="flex:1;">
              <label class="ing-edit-label">Supplier</label>
              <input class="order-stock-input" style="width:100%;" value="${esc(ing.supplier || '')}" id="ing-edit-supplier" />
            </div>
          </div>

          <div class="ing-edit-row">
            <div style="flex:1;">
              <label class="ing-edit-label">Types</label>
              <div class="ing-edit-types">${typeChecks}</div>
            </div>
          </div>

          <div class="ing-edit-row">
            <div style="flex:1;">
              <label class="ing-edit-label">Category</label>
              <select class="order-stock-input" style="width:100%;" id="ing-edit-category">${catSelect}</select>
            </div>
            <div style="flex:1;">
              <label class="ing-edit-label">Unit</label>
              <select class="order-stock-input" style="width:100%;" id="ing-edit-unit">
                <option${ing.unit==='Grams'?' selected':''}>Grams</option>
                <option${ing.unit==='ML'?' selected':''}>ML</option>
                <option${ing.unit==='pieces'?' selected':''}>pieces</option>
              </select>
            </div>
            <div style="flex:1;">
              <label class="ing-edit-label">Price level</label>
              <select class="order-stock-input" style="width:100%;" id="ing-edit-priceLevel">
                <option value="">—</option>
                ${PRICE_LEVELS.map(l => `<option value="${l}"${ing.priceLevel===l?' selected':''}>${l}</option>`).join('')}
              </select>
            </div>
            <div>
              <label class="ing-edit-label">Active</label>
              <div><input type="checkbox" id="ing-edit-active" ${ing.active !== false ? 'checked' : ''} /></div>
            </div>
          </div>
        </div>

        <div class="ing-edit-section">
          <div class="ing-edit-row">
            <div style="flex:1;">
              <label class="ing-edit-label">Order code</label>
              <input class="order-stock-input" style="width:100%;" value="${esc(ing.orderCode || '')}" id="ing-edit-orderCode" />
            </div>
            <div style="flex:1;">
              <label class="ing-edit-label">Order unit</label>
              <input class="order-stock-input" style="width:100%;" value="${esc(ing.orderUnit || '')}" id="ing-edit-orderUnit" />
            </div>
            <div style="flex:1;">
              <label class="ing-edit-label">Price (\u20AC)</label>
              <input class="order-stock-input" style="width:100%;" type="number" step="0.01" value="${ing.orderPrice || ''}" placeholder="0.00" id="ing-edit-orderPrice" />
            </div>
            <div style="flex:1;">
              <label class="ing-edit-label">Amount (g/ml)</label>
              <input class="order-stock-input" style="width:100%;" type="number" step="1" value="${ing.orderUnitSize || ''}" placeholder="0" id="ing-edit-orderUnitSize" />
            </div>
          </div>

          <div class="ing-edit-row">
            <div style="flex:1;">
              <label class="ing-edit-label">West: Area</label>
              <select class="order-stock-input" style="width:100%;" id="ing-edit-storageWestCat" onchange="updateStorageLocOpts('west')">${westCatOpts}</select>
            </div>
            <div style="flex:1;">
              <label class="ing-edit-label">West: Spot</label>
              <select class="order-stock-input" style="width:100%;" id="ing-edit-storageWestLoc">${westLocOpts}</select>
            </div>
            <div style="flex:1;">
              <label class="ing-edit-label">Centraal: Area</label>
              <select class="order-stock-input" style="width:100%;" id="ing-edit-storageCentraalCat" onchange="updateStorageLocOpts('centraal')">${centraalCatOpts}</select>
            </div>
            <div style="flex:1;">
              <label class="ing-edit-label">Centraal: Spot</label>
              <select class="order-stock-input" style="width:100%;" id="ing-edit-storageCentraalLoc">${centraalLocOpts}</select>
            </div>
          </div>

          <div class="ing-edit-row">
            <div style="flex:1;">
              <label class="ing-edit-label">Allergens</label>
              <input class="order-stock-input" style="width:100%;" value="${esc(ing.allergens || '')}" id="ing-edit-allergens" placeholder="Allergens" />
            </div>
            <div style="flex:1;">
              <label class="ing-edit-label">Notes</label>
              <input class="order-stock-input" style="width:100%;" value="${esc(ing.notes || '')}" id="ing-edit-notes" placeholder="Notes..." />
            </div>
          </div>

          <div class="ing-edit-row">
            <div style="flex:1;">
              <label class="ing-edit-label">Stock West (${ing.unit === 'ML' ? 'ml' : ing.unit === 'pieces' ? 'pcs' : 'g'})</label>
              <input class="order-stock-input" style="width:80px;" type="number" min="0" step="1" value="${(ing.stock&&ing.stock.west)?ing.stock.west.amount:''}" placeholder="0" id="ing-edit-stockWest" />
            </div>
            <div style="flex:1;">
              <label class="ing-edit-label">Stock Centraal (${ing.unit === 'ML' ? 'ml' : ing.unit === 'pieces' ? 'pcs' : 'g'})</label>
              <input class="order-stock-input" style="width:80px;" type="number" min="0" step="1" value="${(ing.stock&&ing.stock.centraal)?ing.stock.centraal.amount:''}" placeholder="0" id="ing-edit-stockCentraal" />
            </div>
          </div>

          <details class="ing-edit-nutrition">
            <summary style="font-size:11px;color:var(--text2);cursor:pointer;">Nutrition info (per 100g)</summary>
            <div class="ing-edit-row" style="margin-top:6px;">
              ${['energyKj','energyKcal','protein','carbs','sugar','fat','saturatedFat','fiber','salt'].map(k => {
                const labels = {energyKj:'Energy kJ',energyKcal:'Energy kcal',protein:'Protein g',carbs:'Carbs g',sugar:'Sugar g',fat:'Fat g',saturatedFat:'Sat. fat g',fiber:'Fiber g',salt:'Salt g'};
                return `<div style="flex:1;min-width:70px;">
                  <label class="ing-edit-label">${labels[k]}</label>
                  <input class="order-stock-input" style="width:100%;" type="number" step="0.1" value="${nutrition[k]||''}" placeholder="—" id="ing-edit-nut-${k}" />
                </div>`;
              }).join('')}
            </div>
          </details>
        </div>

        <div style="display:flex;gap:8px;justify-content:flex-end;align-items:center;margin-top:8px;">
          <button class="btn btn-sm" onclick="closeModal()">Cancel</button>
          <button class="btn btn-sm" style="background:var(--green);color:white;" onclick="saveIngredientFromModal('${esc(ing.id)}')">Save</button>
        </div>
      </div>
    </div>`;
  showModal(modalHtml);
}

export async function saveIngredientFromModal(id: string) {
  // Reuse saveIngredientEdit logic but close modal instead of re-rendering inline
  const ing = S.ingredientDb.find(i => i.id === id);
  if (!ing) return;
  const newName = ((document.getElementById('ing-edit-name') as HTMLInputElement | null)?.value || '').trim();
  if (!newName) { toastError('Name is required'); return; }
  const category = (document.getElementById('ing-edit-category') as HTMLSelectElement | null)?.value || '';
  if (!category) { toastError('Category is required'); return; }
  const typeChecks = document.querySelectorAll<HTMLInputElement>('.ing-edit-type-cb');
  const types = [...typeChecks].filter(c => c.checked).map(c => c.value);
  if (!types.length) { toastError('At least one type is required'); return; }

  // Read all fields (same as saveIngredientEdit)
  ing.name = newName;
  ing.supplierName = (document.getElementById('ing-edit-supplierName') as HTMLInputElement | null)?.value.trim() || '';
  ing.supplier = (document.getElementById('ing-edit-supplier') as HTMLInputElement | null)?.value.trim() || '';
  ing.category = (document.getElementById('ing-edit-category') as HTMLSelectElement | null)?.value || '';
  ing.unit = (document.getElementById('ing-edit-unit') as HTMLSelectElement | null)?.value || 'Grams';
  ing.priceLevel = (document.getElementById('ing-edit-priceLevel') as HTMLSelectElement | null)?.value || '';
  ing.active = (document.getElementById('ing-edit-active') as HTMLInputElement | null)?.checked !== false;
  ing.orderCode = (document.getElementById('ing-edit-orderCode') as HTMLInputElement | null)?.value.trim() || '';
  ing.orderUnit = (document.getElementById('ing-edit-orderUnit') as HTMLInputElement | null)?.value.trim() || '';
  ing.orderPrice = parseFloat((document.getElementById('ing-edit-orderPrice') as HTMLInputElement | null)?.value ?? '') || 0;
  ing.orderUnitSize = parseFloat((document.getElementById('ing-edit-orderUnitSize') as HTMLInputElement | null)?.value ?? '') || 0;
  ing.allergens = (document.getElementById('ing-edit-allergens') as HTMLInputElement | null)?.value.trim() || '';
  ing.notes = (document.getElementById('ing-edit-notes') as HTMLInputElement | null)?.value.trim() || '';

  const checks = document.querySelectorAll<HTMLInputElement>('.ing-edit-type-cb');
  ing.types = [...checks].filter(c => c.checked).map(c => c.value);

  ing.storageLocations = {
    west: { category: (document.getElementById('ing-edit-storageWestCat') as HTMLSelectElement | null)?.value || '', location: (document.getElementById('ing-edit-storageWestLoc') as HTMLSelectElement | null)?.value || '' },
    centraal: { category: (document.getElementById('ing-edit-storageCentraalCat') as HTMLSelectElement | null)?.value || '', location: (document.getElementById('ing-edit-storageCentraalLoc') as HTMLSelectElement | null)?.value || '' },
  };

  const stockWest = (document.getElementById('ing-edit-stockWest') as HTMLInputElement | null)?.value;
  const stockCentraal = (document.getElementById('ing-edit-stockCentraal') as HTMLInputElement | null)?.value;
  if (!ing.stock) ing.stock = {};
  if (stockWest !== '' && stockWest !== undefined) ing.stock.west = { amount: parseFloat(stockWest) || 0, date: new Date().toISOString().slice(0, 10) };
  if (stockCentraal !== '' && stockCentraal !== undefined) ing.stock.centraal = { amount: parseFloat(stockCentraal) || 0, date: new Date().toISOString().slice(0, 10) };

  const nut: Record<string, number> = {};
  ['energyKj','energyKcal','protein','carbs','sugar','fat','saturatedFat','fiber','salt'].forEach(k => {
    const v = parseFloat((document.getElementById('ing-edit-nut-' + k) as HTMLInputElement | null)?.value ?? '');
    if (!isNaN(v)) nut[k] = v;
  });
  ing.nutrition = nut;

  if (ing.orderPrice && ing.orderUnitSize) {
    ing.pricePer100 = Math.round(ing.orderPrice / ing.orderUnitSize * 100 * 100) / 100;
  }

  try {
    await apiPost('/api/ingredients/' + id, ing);
    closeModal();
    loadIngredientDb();
    renderOrders();
    toast('Ingredient updated');
  } catch (e: unknown) {
    toastError('Save failed: ' + (e instanceof Error ? e.message : 'Unknown error'));
  }
}

/** Lookup a Hanos product by code or URL and fill in the form fields */
export async function hanosLookupProduct() {
  const input = document.getElementById('ing-hanos-lookup') as HTMLInputElement | null;
  const status = document.getElementById('ing-hanos-status');
  if (!input || !status) return;

  let raw = input.value.trim();
  if (!raw) { status.innerHTML = '<span style="color:var(--red);">Enter a code or URL</span>'; return; }

  // Extract code from URL if pasted (e.g. https://www.hanos.nl/p/34295808 or /product/34295808)
  const urlMatch = raw.match(/\/p\/(\d+)/i) || raw.match(/\/product\/(\d+)/i) || raw.match(/\/(\d{6,})/);
  const code = urlMatch ? urlMatch[1] : raw.replace(/\D/g, '');
  if (!code) { status.innerHTML = '<span style="color:var(--red);">Could not extract product code</span>'; return; }

  status.innerHTML = '<span style="color:var(--blue);">Looking up...</span>';

  try {
    const loc = S.currentLoc;
    const resp = await fetch(`/api/hanos/product/${encodeURIComponent(code)}?location=${loc}`);
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      status.innerHTML = `<span style="color:var(--red);">${esc(err.error || 'Product not found')}</span>`;
      return;
    }

    const product = await resp.json();

    // Fill in form fields
    const setVal = (id: string, val: string | number | null | undefined) => { const el = document.getElementById(id) as HTMLInputElement | null; if (el && val !== undefined && val !== null && val !== '') el.value = String(val); };
    setVal('ing-edit-orderCode', product.orderCode);
    setVal('ing-edit-orderUnit', product.orderUnit);
    setVal('ing-edit-orderPrice', product.orderPrice);
    setVal('ing-edit-orderUnitSize', product.orderUnitSize);
    setVal('ing-edit-supplierName', product.supplierName || product.name);
    setVal('ing-edit-supplier', 'Hanos');
    if (product.allergens) setVal('ing-edit-allergens', product.allergens);

    // Set unit dropdown
    const unitSel = document.getElementById('ing-edit-unit') as HTMLSelectElement | null;
    if (unitSel && product.unit) unitSel.value = product.unit;

    // If name field is empty, fill it too
    const nameField = document.getElementById('ing-edit-name') as HTMLInputElement | null;
    if (nameField && !nameField.value.trim()) {
      nameField.value = product.name;
    }

    // Show success with product details
    const priceStr = product.priceFormatted || (product.orderPrice ? '\u20AC' + Number(product.orderPrice).toFixed(2) : '');
    const unitStr = product.orderUnit || '';
    const sizeStr = product.orderUnitSize ? `(${product.orderUnitSize}${product.unit === 'ML' ? 'ml' : 'g'})` : '';
    status.innerHTML = `<span style="color:var(--green);">\u2713 ${esc(product.name)}</span>` +
      (unitStr ? ` — ${esc(unitStr)}` : '') +
      (sizeStr ? ` ${esc(sizeStr)}` : '') +
      (priceStr ? ` — ${esc(priceStr)}` : '');

  } catch (e: unknown) {
    status.innerHTML = `<span style="color:var(--red);">Lookup failed: ${esc(e instanceof Error ? e.message : 'Unknown error')}</span>`;
  }
}

export function openAddIngredientModal() {
  const id = crypto.randomUUID();

  const typeChecks = INGREDIENT_TYPES.map(t =>
    `<label class="ing-edit-type-label"><input type="checkbox" class="ing-edit-type-cb" value="${esc(t)}" onchange="updateEditCategoryOptions()" /> ${esc(t)}</label>`
  ).join('');

  const catSelect = '<option value="">— Select —</option>' + ALL_CATEGORIES.map(c =>
    `<option value="${esc(c)}">${esc(c)}</option>`
  ).join('');

  const storageCatNames = Object.keys(STORAGE_CATEGORIES);
  const emptyCatOpts = '<option value="">—</option>' + storageCatNames.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  const emptyLocOpts = '<option value="">—</option>';

  const modalHtml = `
    <div style="padding:20px;max-width:600px;">
      <h3 style="margin:0 0 16px;">Add Ingredient</h3>
      <div style="margin-bottom:12px;padding:8px 12px;background:var(--bg2);border-radius:var(--radius);border:1px solid var(--border);">
        <label class="ing-edit-label" style="margin-bottom:4px;">🔍 Hanos lookup — paste order code or URL</label>
        <div style="display:flex;gap:6px;">
          <input class="order-stock-input" style="flex:1;" id="ing-hanos-lookup" placeholder="e.g. 34295808 or https://www.hanos.nl/..." />
          <button class="btn btn-sm" style="white-space:nowrap;background:var(--blue);color:white;" onclick="hanosLookupProduct()">Lookup</button>
        </div>
        <div id="ing-hanos-status" style="font-size:11px;color:var(--text2);margin-top:4px;"></div>
      </div>
      <div class="ing-edit-grid">
        <div class="ing-edit-section">
          <div class="ing-edit-row">
            <div style="flex:2;">
              <label class="ing-edit-label">Name *</label>
              <input class="order-stock-input" style="width:100%;" value="" id="ing-edit-name" placeholder="English name (e.g. Frozen Spinach)" />
            </div>
            <div style="flex:2;">
              <label class="ing-edit-label">Supplier name</label>
              <input class="order-stock-input" style="width:100%;" value="" id="ing-edit-supplierName" placeholder="Hanos product name" />
            </div>
            <div style="flex:1;">
              <label class="ing-edit-label">Supplier</label>
              <input class="order-stock-input" style="width:100%;" value="" id="ing-edit-supplier" placeholder="e.g. Hanos" />
            </div>
          </div>

          <div class="ing-edit-row">
            <div style="flex:1;">
              <label class="ing-edit-label">Types</label>
              <div class="ing-edit-types">${typeChecks}</div>
            </div>
          </div>

          <div class="ing-edit-row">
            <div style="flex:1;">
              <label class="ing-edit-label">Category</label>
              <select class="order-stock-input" style="width:100%;" id="ing-edit-category">${catSelect}</select>
            </div>
            <div style="flex:1;">
              <label class="ing-edit-label">Unit</label>
              <select class="order-stock-input" style="width:100%;" id="ing-edit-unit">
                <option selected>Grams</option>
                <option>ML</option>
                <option>pieces</option>
              </select>
            </div>
            <div style="flex:1;">
              <label class="ing-edit-label">Price level</label>
              <select class="order-stock-input" style="width:100%;" id="ing-edit-priceLevel">
                <option value="">—</option>
                ${PRICE_LEVELS.map(l => `<option value="${l}">${l}</option>`).join('')}
              </select>
            </div>
            <div>
              <label class="ing-edit-label">Active</label>
              <div><input type="checkbox" id="ing-edit-active" checked /></div>
            </div>
          </div>
        </div>

        <div class="ing-edit-section">
          <div class="ing-edit-row">
            <div style="flex:1;">
              <label class="ing-edit-label">Order code</label>
              <input class="order-stock-input" style="width:100%;" value="" id="ing-edit-orderCode" />
            </div>
            <div style="flex:1;">
              <label class="ing-edit-label">Order unit</label>
              <input class="order-stock-input" style="width:100%;" value="" id="ing-edit-orderUnit" />
            </div>
            <div style="flex:1;">
              <label class="ing-edit-label">Price (\u20AC)</label>
              <input class="order-stock-input" style="width:100%;" type="number" step="0.01" value="" placeholder="0.00" id="ing-edit-orderPrice" />
            </div>
            <div style="flex:1;">
              <label class="ing-edit-label">Amount (g/ml)</label>
              <input class="order-stock-input" style="width:100%;" type="number" step="1" value="" placeholder="0" id="ing-edit-orderUnitSize" />
            </div>
          </div>

          <div class="ing-edit-row">
            <div style="flex:1;">
              <label class="ing-edit-label">West: Area</label>
              <select class="order-stock-input" style="width:100%;" id="ing-edit-storageWestCat" onchange="updateStorageLocOpts('west')">${emptyCatOpts}</select>
            </div>
            <div style="flex:1;">
              <label class="ing-edit-label">West: Spot</label>
              <select class="order-stock-input" style="width:100%;" id="ing-edit-storageWestLoc">${emptyLocOpts}</select>
            </div>
            <div style="flex:1;">
              <label class="ing-edit-label">Centraal: Area</label>
              <select class="order-stock-input" style="width:100%;" id="ing-edit-storageCentraalCat" onchange="updateStorageLocOpts('centraal')">${emptyCatOpts}</select>
            </div>
            <div style="flex:1;">
              <label class="ing-edit-label">Centraal: Spot</label>
              <select class="order-stock-input" style="width:100%;" id="ing-edit-storageCentraalLoc">${emptyLocOpts}</select>
            </div>
          </div>

          <div class="ing-edit-row">
            <div style="flex:1;">
              <label class="ing-edit-label">Allergens</label>
              <input class="order-stock-input" style="width:100%;" value="" id="ing-edit-allergens" placeholder="Allergens" />
            </div>
            <div style="flex:1;">
              <label class="ing-edit-label">Notes</label>
              <input class="order-stock-input" style="width:100%;" value="" id="ing-edit-notes" placeholder="Notes..." />
            </div>
          </div>
        </div>

        <div style="display:flex;gap:8px;justify-content:flex-end;align-items:center;margin-top:8px;">
          <button class="btn btn-sm" onclick="closeModal()">Cancel</button>
          <button class="btn btn-sm" style="background:var(--green);color:white;" onclick="saveNewIngredient('${id}')">Add ingredient</button>
        </div>
      </div>
    </div>`;
  showModal(modalHtml);
}

export async function saveNewIngredient(id: string) {
  const name = ((document.getElementById('ing-edit-name') as HTMLInputElement | null)?.value || '').trim();
  if (!name) { toastError('Name is required'); return; }
  const category = (document.getElementById('ing-edit-category') as HTMLSelectElement | null)?.value || '';
  if (!category) { toastError('Category is required'); return; }
  const checks = document.querySelectorAll<HTMLInputElement>('.ing-edit-type-cb');
  const types = [...checks].filter(c => c.checked).map(c => c.value);
  if (!types.length) { toastError('At least one type is required'); return; }

  const ing = {
    id,
    name,
    supplierName: (document.getElementById('ing-edit-supplierName') as HTMLInputElement | null)?.value.trim() || '',
    types,
    category: (document.getElementById('ing-edit-category') as HTMLSelectElement | null)?.value || '',
    unit: (document.getElementById('ing-edit-unit') as HTMLSelectElement | null)?.value || 'Grams',
    supplier: (document.getElementById('ing-edit-supplier') as HTMLInputElement | null)?.value.trim() || '',
    orderCode: (document.getElementById('ing-edit-orderCode') as HTMLInputElement | null)?.value.trim() || '',
    orderUnit: (document.getElementById('ing-edit-orderUnit') as HTMLInputElement | null)?.value.trim() || '',
    orderPrice: parseFloat((document.getElementById('ing-edit-orderPrice') as HTMLInputElement | null)?.value ?? '') || 0,
    orderUnitSize: parseFloat((document.getElementById('ing-edit-orderUnitSize') as HTMLInputElement | null)?.value ?? '') || 0,
    priceLevel: (document.getElementById('ing-edit-priceLevel') as HTMLSelectElement | null)?.value || '',
    active: (document.getElementById('ing-edit-active') as HTMLInputElement | null)?.checked !== false,
    allergens: (document.getElementById('ing-edit-allergens') as HTMLInputElement | null)?.value.trim() || '',
    notes: (document.getElementById('ing-edit-notes') as HTMLInputElement | null)?.value.trim() || '',
    storageLocations: {
      west: { category: (document.getElementById('ing-edit-storageWestCat') as HTMLSelectElement | null)?.value || '', location: (document.getElementById('ing-edit-storageWestLoc') as HTMLSelectElement | null)?.value || '' },
      centraal: { category: (document.getElementById('ing-edit-storageCentraalCat') as HTMLSelectElement | null)?.value || '', location: (document.getElementById('ing-edit-storageCentraalLoc') as HTMLSelectElement | null)?.value || '' },
    },
    measureMode: 'weight',
    pricePer100: 0,
    priceHistory: [],
    priceAlert: false,
    stock: {},
    targetStock: {},
    nutrition: {},
  };

  if (ing.orderPrice && ing.orderUnitSize) {
    ing.pricePer100 = Math.round(ing.orderPrice / ing.orderUnitSize * 100 * 100) / 100;
  }

  try {
    await apiPost('/api/ingredients/' + id, ing);
    S.ingredientDb.push(ing);
    loadIngredientDb();
    closeModal();
    renderOrders();
    toast('Ingredient added');
  } catch (e: unknown) {
    toastError('Save failed: ' + (e instanceof Error ? e.message : 'Unknown error'));
  }
}

// ── Storage location popover (reusable from any view) ─────────

export function openStoragePopover(ingredientId: string, anchorEl: HTMLElement) {
  // Close any existing popover
  const existing = document.getElementById('storage-popover');
  if (existing) existing.remove();

  const ing = S.ingredientDb.find(i => i.id === ingredientId);
  if (!ing) return;

  const storLocs = storLocsOf(ing);
  const rect = anchorEl.getBoundingClientRect();
  const catNames = Object.keys(STORAGE_CATEGORIES);
  const curLoc = S.currentLoc;
  const locLabel = locName(curLoc);

  const { category: cat, location: loc } = storLocParts(storLocs[curLoc]);
  const catOpts = '<option value="">—</option>' + catNames.map(c => `<option value="${esc(c)}"${cat===c?' selected':''}>${esc(c)}</option>`).join('');
  const locOpts = '<option value="">—</option>' + (cat && STORAGE_CATEGORIES[cat] ? STORAGE_CATEGORIES[cat] : []).map(l => `<option value="${esc(l)}"${loc===l?' selected':''}>${esc(l)}</option>`).join('');

  const pop = document.createElement('div');
  pop.id = 'storage-popover';
  pop.className = 'storage-popover';
  pop.style.top = (rect.bottom + window.scrollY + 4) + 'px';
  pop.style.left = Math.max(8, rect.left) + 'px';
  pop.innerHTML = `
    <div style="font-weight:600;font-size:12px;margin-bottom:8px;">Storage — ${esc(locLabel)}</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
      <div>
        <label class="ing-edit-label">Area</label>
        <select class="order-stock-input" id="pop-storage-${curLoc}-cat" onchange="updatePopStorageLoc('${curLoc}')">${catOpts}</select>
      </div>
      <div>
        <label class="ing-edit-label">Spot</label>
        <select class="order-stock-input" id="pop-storage-${curLoc}-loc">${locOpts}</select>
      </div>
    </div>
    <div style="display:flex;gap:6px;justify-content:flex-end;margin-top:8px;">
      <button class="btn btn-sm" onclick="document.getElementById('storage-popover').remove()">Cancel</button>
      <button class="btn btn-sm" style="background:var(--green);color:white;" onclick="saveStorageFromPopover('${esc(ingredientId)}')">Save</button>
    </div>`;

  document.body.appendChild(pop);

  // Close on outside click
  setTimeout(() => {
    document.addEventListener('click', function closePopover(e: MouseEvent) {
      if (!pop.contains(e.target as Node) && e.target !== anchorEl) {
        pop.remove();
        document.removeEventListener('click', closePopover);
      }
    });
  }, 50);
}

export function updatePopStorageLoc(building: string) {
  const catSel = document.getElementById('pop-storage-' + building + '-cat') as HTMLSelectElement | null;
  const locSel = document.getElementById('pop-storage-' + building + '-loc') as HTMLSelectElement | null;
  if (!catSel || !locSel) return;
  const cat = catSel.value;
  const locs = cat && STORAGE_CATEGORIES[cat] ? STORAGE_CATEGORIES[cat] : [];
  locSel.innerHTML = '<option value="">—</option>' + locs.map(l => `<option value="${esc(l)}">${esc(l)}</option>`).join('');
}

export async function saveStorageFromPopover(ingredientId: string) {
  const curLoc = S.currentLoc;
  const catEl = document.getElementById('pop-storage-' + curLoc + '-cat') as HTMLSelectElement | null;
  const locEl = document.getElementById('pop-storage-' + curLoc + '-loc') as HTMLSelectElement | null;
  if (!catEl || !locEl) return;

  // Update in full DB — only change the current location, preserve the other
  const ingFull = S.ingredientDb.find(i => i.id === ingredientId);
  const newLocs: StorageLocationMap = ingFull ? { ...storLocsOf(ingFull) } : {};
  newLocs[curLoc] = { category: catEl.value, location: locEl.value };

  if (ingFull) {
    ingFull.storageLocations = newLocs;
    try {
      await apiPost('/api/ingredients/' + ingredientId, ingFull);
      toast('Storage location saved');
    } catch (e: unknown) {
      toastError('Save failed');
    }
  }

  // Update in S.ingredientDb too
  const ingLight = S.ingredientDb.find(i => i.id === ingredientId);
  if (ingLight) ingLight.storageLocations = newLocs;

  const pop = document.getElementById('storage-popover');
  if (pop) pop.remove();
  renderOrders();
}

// ── Supplier XLSX Upload + Import ────────────────────────────

export async function handleSupplierUpload(file: File | undefined) {
  if (!file) return;
  toast('Parsing supplier file...');
  const formData = new FormData();
  formData.append('file', file);
  try {
    const r = await fetch('/api/ingredients/upload-supplier', { method: 'POST', body: formData });
    if (!r.ok) throw new Error((await r.json()).error || 'Upload failed');
    supplierUploadData = await r.json();
    toast(supplierUploadData.length + ' products parsed from file');
    renderOrders();
  } catch (e: unknown) {
    toastError('Upload failed: ' + (e instanceof Error ? e.message : 'Unknown error'));
  }
}

export function renderSupplierImportPanel() {
  if (!supplierUploadData || !supplierUploadData.length) return '';

  const existingCodes = new Set(S.ingredientDb.map(i => i.orderCode).filter(Boolean));
  const matched = supplierUploadData.filter(p => existingCodes.has(p.orderCode));
  const unmatched = supplierUploadData.filter(p => !existingCodes.has(p.orderCode) && p.recentOrders > 0);

  return `<div style="background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:16px;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
      <span style="font-weight:600;">Supplier Import: ${supplierUploadData.length} products parsed</span>
      <button class="btn btn-sm btn-danger" onclick="supplierUploadData=null;renderOrders()">Dismiss</button>
    </div>
    <p style="font-size:12px;color:var(--text2);margin:0 0 8px;">
      ${matched.length} match existing ingredients by order code.
      ${unmatched.length} new products with recent orders (not yet in database).
    </p>
    <div style="display:flex;gap:8px;">
      <button class="btn btn-sm" style="background:var(--green);color:white;" onclick="applySupplierUpdate()">
        Update ${matched.length} existing ingredients with latest prices/units
      </button>
    </div>
  </div>`;
}

export async function applySupplierUpdate() {
  if (!supplierUploadData) return;
  const byCode: Record<string, SupplierProduct> = {};
  supplierUploadData.forEach(p => { byCode[p.orderCode] = p; });

  let updated = 0;
  S.ingredientDb.forEach(ing => {
    if (!ing.orderCode) return;
    const sup = byCode[ing.orderCode];
    if (!sup) return;

    // Check for price alert (>15% increase)
    if (ing.orderPrice && sup.price && sup.price > ing.orderPrice * 1.15) {
      ing.priceAlert = true;
    } else {
      ing.priceAlert = false;
    }

    ing.supplierName = sup.title;
    ing.orderPrice = sup.price;
    ing.orderUnit = sup.orderUnit;
    ing.orderUnitSize = sup.orderUnitSize;
    if (!ing.supplier) ing.supplier = 'Hanos';

    // Update price history
    if (sup.priceHistory && sup.priceHistory.length) {
      ing.priceHistory = sup.priceHistory;
    }

    // Update nutrition
    if (sup.nutrition) {
      ing.nutrition = sup.nutrition;
    }

    // Recalculate price per 100 base units
    if (ing.orderPrice && ing.orderUnitSize > 0) {
      ing.pricePer100 = Math.round((ing.orderPrice / ing.orderUnitSize) * 10000) / 100;
    }

    updated++;
  });

  if (updated === 0) { toast('No matching ingredients to update'); return; }

  toast('Saving ' + updated + ' updated ingredients...');
  try {
    await apiPost('/api/ingredients', S.ingredientDb);
    loadIngredientDb();
    supplierUploadData = null;
    renderOrders();
    toast(updated + ' ingredients updated with supplier data');
  } catch (e: unknown) {
    toastError('Save failed: ' + (e instanceof Error ? e.message : 'Unknown error'));
  }
}

// ── Storage Location Management Modal ─────────────────────────

export let storageModalLoc = 'west';
export let storageModalDragIdx: number | null = null;

export function openStorageLocationsModal() {
  storageModalLoc = S.currentLoc;
  renderStorageModal();
}

export function renderStorageModal() {
  if (!S.storageConfig) S.storageConfig = { west: DEFAULT_STORAGE_CONFIG.map(a => ({...a, spots: [...a.spots]})), centraal: DEFAULT_STORAGE_CONFIG.map(a => ({...a, spots: [...a.spots]})) };
  const loc = storageModalLoc;
  const areas = S.storageConfig[loc] || [];

  const locTabs = `<div style="display:flex;gap:4px;margin-bottom:14px;">
    <button class="order-loc-btn${loc === 'west' ? ' active' : ''}" onclick="storageModalLoc='west';renderStorageModal()">Sering West</button>
    <button class="order-loc-btn${loc === 'centraal' ? ' active' : ''}" onclick="storageModalLoc='centraal';renderStorageModal()">Sering Centraal</button>
  </div>`;

  let html = areas.map((area: { name: string; color: string; spots: string[] }, idx: number) => {
    return `<div class="sc-area-row" draggable="true" data-sc-idx="${idx}"
        ondragstart="storageModalDragIdx=${idx};this.style.opacity='.5'"
        ondragend="this.style.opacity='1'"
        ondragover="event.preventDefault();this.classList.add('sc-drag-over')"
        ondragleave="this.classList.remove('sc-drag-over')"
        ondrop="event.preventDefault();this.classList.remove('sc-drag-over');dropStorageArea(${idx})"
      >
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
        <span style="cursor:grab;font-size:16px;opacity:.4;" title="Drag to reorder">&#8942;&#8942;</span>
        <input type="color" value="${area.color || '#999'}" style="width:28px;height:28px;border:none;padding:0;cursor:pointer;border-radius:4px;" oninput="updateStorageColor(${idx},this.value)" />
        <span style="font-weight:600;font-size:13px;flex:1;">${esc(area.name)}</span>
        <button class="btn btn-sm btn-danger" onclick="removeStorageCategory(${idx})">Remove</button>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px;margin-left:52px;">
        ${(area.spots || []).map((l: string, i: number) => `<span style="font-size:12px;padding:2px 8px;background:var(--bg);border:1px solid var(--border);border-radius:12px;display:inline-flex;align-items:center;gap:4px;">${esc(l)} <span style="cursor:pointer;opacity:.5;font-size:14px;" onclick="removeStorageSpot(${idx},${i})">&times;</span></span>`).join('')}
      </div>
      <div style="display:flex;gap:6px;margin-left:52px;">
        <input class="order-stock-input" style="flex:1;text-align:left;" id="new-spot-${idx}" placeholder="New spot..." onkeydown="if(event.key==='Enter')addStorageSpot(${idx})" />
        <button class="btn btn-sm" onclick="addStorageSpot(${idx})">Add spot</button>
      </div>
    </div>`;
  }).join('');

  const modalHtml = `
    <div style="padding:20px;max-width:500px;">
      <h3 style="margin:0 0 16px;">Storage Locations</h3>
      <p style="font-size:12px;color:var(--text2);margin:0 0 12px;">
        Configure storage areas per location. Drag to reorder. Click the color swatch to change colors.
      </p>
      ${locTabs}
      ${html || '<div class="empty" style="margin-bottom:12px;">No areas defined yet.</div>'}
      <div style="display:flex;gap:6px;margin-top:8px;">
        <input class="order-stock-input" style="flex:1;text-align:left;" id="new-storage-cat" placeholder="New area name..." onkeydown="if(event.key==='Enter')addStorageCategory()" />
        <button class="btn btn-sm" onclick="addStorageCategory()">Add area</button>
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;">
        <button class="btn btn-sm" onclick="closeModal()">Close</button>
      </div>
    </div>`;
  showModal(modalHtml);
}

export function dropStorageArea(toIdx: number) {
  const fromIdx = storageModalDragIdx;
  if (fromIdx === null || fromIdx === toIdx) return;
  const loc = storageModalLoc;
  const areas = S.storageConfig[loc] || [];
  const [moved] = areas.splice(fromIdx, 1);
  areas.splice(toIdx, 0, moved);
  S.storageConfig[loc] = areas;
  saveStorageConfig();
  rebuildStorageCategories(loc);
  renderStorageModal();
}

export function updateStorageColor(idx: number, color: string) {
  const loc = storageModalLoc;
  if (S.storageConfig[loc] && S.storageConfig[loc][idx]) {
    S.storageConfig[loc][idx].color = color;
    saveStorageConfig();
  }
}

export function addStorageCategory() {
  const input = document.getElementById('new-storage-cat') as HTMLInputElement | null;
  if (!input) return;
  const name = input.value.trim();
  if (!name) return;
  const loc = storageModalLoc;
  if (!S.storageConfig[loc]) S.storageConfig[loc] = [];
  if (S.storageConfig[loc].find(a => a.name === name)) { toastError('Area already exists'); return; }
  S.storageConfig[loc].push({ name, color: '#999', spots: [] });
  saveStorageConfig();
  rebuildStorageCategories(loc);
  renderStorageModal();
  toast('Area added');
}

export function removeStorageCategory(idx: number) {
  const loc = storageModalLoc;
  const area = S.storageConfig[loc] && S.storageConfig[loc][idx];
  if (!area || !confirm('Remove "' + area.name + '" and all its spots?')) return;
  S.storageConfig[loc].splice(idx, 1);
  saveStorageConfig();
  rebuildStorageCategories(loc);
  renderStorageModal();
  toast('Area removed');
}

export function addStorageSpot(idx: number) {
  const input = document.getElementById('new-spot-' + idx) as HTMLInputElement | null;
  if (!input) return;
  const name = input.value.trim();
  if (!name) return;
  const loc = storageModalLoc;
  const area = S.storageConfig[loc] && S.storageConfig[loc][idx];
  if (!area) return;
  if (!area.spots) area.spots = [];
  if (area.spots.includes(name)) { toastError('Spot already exists'); return; }
  area.spots.push(name);
  saveStorageConfig();
  rebuildStorageCategories(loc);
  renderStorageModal();
  toast('Spot added');
}

export function removeStorageSpot(areaIdx: number, spotIdx: number) {
  const loc = storageModalLoc;
  const area = S.storageConfig[loc] && S.storageConfig[loc][areaIdx];
  if (!area || !area.spots) return;
  area.spots.splice(spotIdx, 1);
  saveStorageConfig();
  rebuildStorageCategories(loc);
  renderStorageModal();
  toast('Spot removed');
}

// Note: openMigrationModal / runMigration were deleted in May 2026 along
// with the backend route — the Sheets→Postgres ingredient migration is
// done. See audit follow-up T19a in audits/2026-05-02-overnight/99-followups.md.
