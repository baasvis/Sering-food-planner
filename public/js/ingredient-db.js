// ── INGREDIENT DATABASE TAB ──────────────────────────────────

// State
let ingredientDbFull = [];       // full ingredient list from /api/ingredients/full
let ingredientDbFullLoaded = false;
let ingredientDbSearch = '';
let ingredientDbTypeFilter = 'all'; // 'all' | 'Food' | 'Drinks' | 'Non-food'
let ingredientDbCatFilter = 'all';  // 'all' | category name
let ingredientDbStatusFilter = 'active'; // 'all' | 'active' | 'inactive'
let ingredientDbSort = 'name';   // 'name' | 'supplier' | 'category' | 'type'
let ingredientDbEditId = null;   // id of ingredient being edited inline
let supplierUploadData = null;   // parsed Hanos XLSX data for import
let ingredientDbPage = 0;        // current page for pagination
const INGREDIENTS_PER_PAGE = 50;

function updateIngredientSearch(el) {
  const pos = el.selectionStart;
  ingredientDbSearch = el.value;
  ingredientDbPage = 0;
  renderOrders();
  requestAnimationFrame(() => {
    const input = document.getElementById('ing-db-search');
    if (input) { input.focus(); input.setSelectionRange(pos, pos); }
  });
}

async function loadIngredientDbFull() {
  try {
    ingredientDbFull = await apiGet('/api/ingredients/full');
    ingredientDbFullLoaded = true;
  } catch (e) {
    ingredientDbFull = [];
    ingredientDbFullLoaded = true;
    console.error('Failed to load ingredient DB:', e);
  }
}

function getCategoriesForTypeFilter() {
  if (ingredientDbTypeFilter === 'all') return ALL_CATEGORIES;
  if (INGREDIENT_CATEGORIES[ingredientDbTypeFilter]) return INGREDIENT_CATEGORIES[ingredientDbTypeFilter];
  // For individual types like 'Kitchen Equipment', get categories from its group
  const group = INGREDIENT_TYPE_TO_GROUP[ingredientDbTypeFilter];
  return group ? INGREDIENT_CATEGORIES[group] : ALL_CATEGORIES;
}

function ingredientMatchesTypeFilter(ing) {
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

function getFilteredIngredients() {
  let list = ingredientDbFull;

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
  if (ingredientDbSort === 'supplier') list = [...list].sort((a, b) => (a.supplier || '').localeCompare(b.supplier || '') || a.name.localeCompare(b.name));
  else if (ingredientDbSort === 'category') list = [...list].sort((a, b) => (a.category || '').localeCompare(b.category || '') || a.name.localeCompare(b.name));
  else if (ingredientDbSort === 'type') list = [...list].sort((a, b) => ((a.types||[])[0]||'').localeCompare((b.types||[])[0]||'') || a.name.localeCompare(b.name));
  else list = [...list].sort((a, b) => a.name.localeCompare(b.name));

  return list;
}

function renderTypePills(types) {
  if (!types || !types.length) return '<span style="color:var(--text3);font-size:11px;">—</span>';
  return types.map(t => {
    const colors = {Food:'--green',Drinks:'--blue','Kitchen Equipment':'--text2',Cleaning:'--purple','FOH Supplies':'--orange','FOH Equipment':'--orange',Office:'--text2'};
    const c = colors[t] || '--text2';
    return `<span class="type-pill" style="border-color:var(${c});color:var(${c});">${esc(t)}</span>`;
  }).join(' ');
}

function renderPriceLevel(level) {
  if (!level) return '';
  const icons = {cheap:'$',medium:'$$',expensive:'$$$'};
  const colors = {cheap:'var(--green)',medium:'var(--orange)',expensive:'var(--red)'};
  return `<span style="font-size:11px;font-weight:600;color:${colors[level]||'var(--text2)'};" title="${level}">${icons[level]||level}</span>`;
}

function renderInlineStock(ing) {
  const stock = ing.stock || {};
  const wAmt = (stock.west && stock.west.amount) || '';
  const cAmt = (stock.centraal && stock.centraal.amount) || '';
  return `<div style="display:flex;gap:2px;align-items:center;">
    <span style="font-size:9px;color:var(--text3);">W:</span><input class="order-stock-input" style="width:45px;font-size:11px;height:22px;" type="number" min="0" step="1" value="${wAmt}" placeholder="0" oninput="saveInlineStock('${esc(ing.id)}','west',this.value)" />
    <span style="font-size:9px;color:var(--text3);">C:</span><input class="order-stock-input" style="width:45px;font-size:11px;height:22px;" type="number" min="0" step="1" value="${cAmt}" placeholder="0" oninput="saveInlineStock('${esc(ing.id)}','centraal',this.value)" />
  </div>`;
}

let _inlineStockTimeout = null;
function saveInlineStock(ingId, location, val) {
  const amount = parseFloat(val) || 0;

  // Update local state
  const ing = ingredientDbFull.find(i => i.id === ingId);
  if (ing) {
    if (!ing.stock) ing.stock = {};
    ing.stock[location] = { amount, date: new Date().toISOString().slice(0, 10) };
  }
  const dbIng = S.ingredientDb.find(i => i.id === ingId);
  if (dbIng) {
    if (!dbIng.stock) dbIng.stock = {};
    dbIng.stock[location] = { amount, date: new Date().toISOString().slice(0, 10) };
  }

  // Debounced save to backend
  clearTimeout(_inlineStockTimeout);
  _inlineStockTimeout = setTimeout(() => {
    fetch('/api/ingredients/stock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ingredientId: ingId, location, amount }),
    }).catch(e => console.error('Stock save failed:', e));
  }, 600);
}

function renderStockBadges(stock) {
  if (!stock || (!stock.west && !stock.centraal)) return '<span style="color:var(--text3);font-size:11px;">—</span>';
  const parts = [];
  if (stock.west) parts.push(`<span class="stock-badge" title="West: ${stock.west.date||''}">W:${stock.west.amount||0}</span>`);
  if (stock.centraal) parts.push(`<span class="stock-badge" title="Centraal: ${stock.centraal.date||''}">C:${stock.centraal.amount||0}</span>`);
  return parts.join(' ');
}

function renderIngredientDbTab() {
  if (!ingredientDbFullLoaded) {
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

  let html = `<div>
    <div class="section-title" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
      <span>Ingredient Database (${ingredientDbFull.length} total, ${filtered.length} shown)</span>
      <div style="display:flex;gap:8px;align-items:center;">
        <button class="btn btn-sm" onclick="openAddIngredientModal()">+ Add ingredient</button>
        <button class="btn btn-sm" onclick="openStorageLocationsModal()">Storage locations</button>
        <button class="btn btn-sm" onclick="openMigrationModal()">Migrate DB</button>
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
    </div>`;

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
          <td style="font-size:11px;">${renderPriceLevel(ing.priceLevel)}${priceAlertIcon}${ing.pricePer100g ? '<div style="color:var(--text3);">\u20AC' + ing.pricePer100g.toFixed(2) + '/100g</div>' : ''}</td>
          <td>${renderInlineStock(ing)}</td>
          <td><span style="cursor:pointer;font-size:16px;" onclick="toggleIngredientActive('${esc(ing.id)}')">${ing.active !== false ? '\u2705' : '\u274C'}</span></td>
          <td>
            <button class="btn btn-sm" onclick="ingredientDbEditId='${esc(ing.id)}';renderOrders()">Edit</button>
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

  html += '</div>';
  return html;
}

function renderIngredientEditRow(ing) {
  const types = ing.types || [];
  const storLocs = ing.storageLocations || {};
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
  const westCat = (storLocs.west && storLocs.west.category) || '';
  const westLoc = (storLocs.west && storLocs.west.location) || '';
  const centraalCat = (storLocs.centraal && storLocs.centraal.category) || '';
  const centraalLoc = (storLocs.centraal && storLocs.centraal.location) || '';
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
              <input class="order-stock-input" style="width:100%;" type="number" step="1" value="${ing.orderAmountGrams || ''}" placeholder="0" id="ing-edit-orderAmountGrams" />
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
              <label class="ing-edit-label">Price/100g</label>
              <span style="font-size:12px;color:var(--text2);">${ing.pricePer100g ? '\u20AC' + ing.pricePer100g.toFixed(2) : '—'}</span>
            </div>
            <div style="flex:1;">
              <label class="ing-edit-label">Stock West</label>
              <input class="order-stock-input" style="width:80px;" type="number" min="0" step="1" value="${(ing.stock&&ing.stock.west)?ing.stock.west.amount:''}" placeholder="0" id="ing-edit-stockWest" />
            </div>
            <div style="flex:1;">
              <label class="ing-edit-label">Stock Centraal</label>
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
          <button class="btn btn-sm" onclick="ingredientDbEditId=null;renderOrders()">Cancel</button>
          <button class="btn btn-sm" style="background:var(--green);color:white;" onclick="saveIngredientEdit('${esc(ing.id)}')">Save</button>
        </div>
      </div>
    </td>
  </tr>`;
}

function showInlineCategoryEdit(ingId, td) {
  const ing = ingredientDbFull.find(i => i.id === ingId);
  if (!ing) return;
  const opts = '<option value="">—</option>' + ALL_CATEGORIES.map(c =>
    `<option value="${esc(c)}"${ing.category===c?' selected':''}>${esc(c)}</option>`
  ).join('');
  td.innerHTML = `<select class="order-stock-input" style="width:100%;text-align:left;font-size:12px;" onchange="saveInlineCategory('${esc(ingId)}',this.value)" onblur="renderOrders()">${opts}</select>`;
  td.querySelector('select').focus();
}

async function saveInlineCategory(ingId, value) {
  const ing = ingredientDbFull.find(i => i.id === ingId);
  if (!ing) return;
  ing.category = value;
  try {
    await apiPost('/api/ingredients/' + ingId, ing);
    loadIngredientDb();
    renderOrders();
    toast('Category updated');
  } catch (e) {
    toastError('Save failed');
  }
}

function updateStorageLocOpts(building) {
  const catSel = document.getElementById('ing-edit-storage' + (building === 'west' ? 'West' : 'Centraal') + 'Cat');
  const locSel = document.getElementById('ing-edit-storage' + (building === 'west' ? 'West' : 'Centraal') + 'Loc');
  if (!catSel || !locSel) return;
  const cat = catSel.value;
  const locs = cat && STORAGE_CATEGORIES[cat] ? STORAGE_CATEGORIES[cat] : [];
  locSel.innerHTML = '<option value="">—</option>' + locs.map(l => `<option value="${esc(l)}">${esc(l)}</option>`).join('');
}

function updateEditCategoryOptions() {
  const checks = document.querySelectorAll('.ing-edit-type-cb');
  const checked = [...checks].filter(c => c.checked).map(c => c.value);
  const groups = new Set(checked.map(t => INGREDIENT_TYPE_TO_GROUP[t]).filter(Boolean));
  let catOptions = [];
  if (groups.size === 0) { catOptions = ALL_CATEGORIES; }
  else { groups.forEach(g => { catOptions = catOptions.concat(INGREDIENT_CATEGORIES[g] || []); }); }

  const sel = document.getElementById('ing-edit-category');
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="">— Select —</option>' + catOptions.map(c =>
    `<option value="${esc(c)}"${current===c?' selected':''}>${esc(c)}</option>`
  ).join('');
}

async function saveIngredientEdit(id) {
  const ing = ingredientDbFull.find(i => i.id === id);
  if (!ing) return;

  // Collect types from checkboxes
  const typeChecks = document.querySelectorAll('.ing-edit-type-cb');
  const types = [...typeChecks].filter(c => c.checked).map(c => c.value);

  // Collect nutrition
  const nutrition = {};
  ['energyKj','energyKcal','protein','carbs','sugar','fat','saturatedFat','fiber','salt'].forEach(k => {
    const el = document.getElementById('ing-edit-nut-' + k);
    if (el && el.value !== '') nutrition[k] = parseFloat(el.value) || 0;
  });

  const orderPrice = parseFloat(document.getElementById('ing-edit-orderPrice').value) || null;
  const orderAmountGrams = parseFloat(document.getElementById('ing-edit-orderAmountGrams').value) || 0;

  const updated = {
    ...ing,
    name: document.getElementById('ing-edit-name').value.trim(),
    supplierName: document.getElementById('ing-edit-supplierName').value.trim(),
    types,
    category: document.getElementById('ing-edit-category').value,
    unit: document.getElementById('ing-edit-unit').value,
    supplier: document.getElementById('ing-edit-supplier').value.trim(),
    orderCode: document.getElementById('ing-edit-orderCode').value.trim(),
    orderUnit: document.getElementById('ing-edit-orderUnit').value.trim(),
    orderPrice,
    orderAmountGrams,
    priceLevel: document.getElementById('ing-edit-priceLevel').value,
    pricePer100g: (orderPrice && orderAmountGrams > 0) ? Math.round((orderPrice / orderAmountGrams) * 10000) / 100 : 0,
    storageLocations: {
      west: { category: document.getElementById('ing-edit-storageWestCat').value, location: document.getElementById('ing-edit-storageWestLoc').value },
      centraal: { category: document.getElementById('ing-edit-storageCentraalCat').value, location: document.getElementById('ing-edit-storageCentraalLoc').value },
    },
    stock: {
      west: { amount: parseFloat(document.getElementById('ing-edit-stockWest').value) || 0, date: new Date().toISOString().slice(0, 10) },
      centraal: { amount: parseFloat(document.getElementById('ing-edit-stockCentraal').value) || 0, date: new Date().toISOString().slice(0, 10) },
    },
    nutrition: Object.keys(nutrition).length ? nutrition : {},
    active: document.getElementById('ing-edit-active').checked,
    notes: document.getElementById('ing-edit-notes').value.trim(),
    allergens: document.getElementById('ing-edit-allergens').value.trim(),
  };

  if (!updated.name) { toastError('Name is required'); return; }

  try {
    await apiPost('/api/ingredients/' + id, updated);
    Object.assign(ing, updated);
    ingredientDbEditId = null;
    loadIngredientDb();
    renderOrders();
    toast('Ingredient saved');
  } catch (e) {
    toastError('Save failed: ' + e.message);
  }
}

async function toggleIngredientActive(id) {
  const ing = ingredientDbFull.find(i => i.id === id);
  if (!ing) return;
  ing.active = !ing.active;
  try {
    await apiPost('/api/ingredients/' + id, ing);
    renderOrders();
  } catch (e) {
    ing.active = !ing.active;
    toastError('Save failed');
  }
}

async function deleteIngredient(id, name) {
  if (!confirm('Delete "' + name + '"? This cannot be undone.')) return;
  try {
    const r = await fetch('/api/ingredients/' + id, { method: 'DELETE' });
    if (!r.ok) throw new Error('Delete failed');
    ingredientDbFull = ingredientDbFull.filter(i => i.id !== id);
    ingredientDbEditId = null;
    loadIngredientDb();
    renderOrders();
    toast('Ingredient deleted');
  } catch (e) {
    toastError('Delete failed: ' + e.message);
  }
}

function openAddIngredientModal() {
  const id = crypto.randomUUID();

  const typeChecks = INGREDIENT_TYPES.map(t =>
    `<label class="ing-edit-type-label"><input type="checkbox" class="new-ing-type-cb" value="${esc(t)}" onchange="updateNewIngCategoryOptions()" /> ${esc(t)}</label>`
  ).join('');

  const catSelect = '<option value="">— Select —</option>' + ALL_CATEGORIES.map(c =>
    `<option value="${esc(c)}">${esc(c)}</option>`
  ).join('');

  const modalHtml = `
    <div style="padding:20px;max-width:550px;">
      <h3 style="margin:0 0 16px;">Add Ingredient</h3>
      <div style="display:grid;gap:10px;">
        <div>
          <label class="ing-edit-label">Name *</label>
          <input class="order-stock-input" style="width:100%;" id="new-ing-name" placeholder="English name (e.g. Frozen Spinach)" />
        </div>
        <div>
          <label class="ing-edit-label">Types</label>
          <div class="ing-edit-types">${typeChecks}</div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
          <div>
            <label class="ing-edit-label">Category</label>
            <select class="order-stock-input" style="width:100%;" id="new-ing-category">${catSelect}</select>
          </div>
          <div>
            <label class="ing-edit-label">Unit</label>
            <select class="order-stock-input" style="width:100%;" id="new-ing-unit">
              <option>Grams</option><option>ML</option><option>pieces</option>
            </select>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
          <div>
            <label class="ing-edit-label">Supplier</label>
            <input class="order-stock-input" style="width:100%;" id="new-ing-supplier" placeholder="e.g. Hanos" />
          </div>
          <div>
            <label class="ing-edit-label">Order code</label>
            <input class="order-stock-input" style="width:100%;" id="new-ing-orderCode" placeholder="e.g. 34225259" />
          </div>
        </div>
        <div>
          <label class="ing-edit-label">Notes</label>
          <input class="order-stock-input" style="width:100%;" id="new-ing-notes" placeholder="Optional notes" />
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px;">
          <button class="btn btn-sm" onclick="closeModal()">Cancel</button>
          <button class="btn btn-sm" style="background:var(--green);color:white;" onclick="saveNewIngredient('${id}')">Add ingredient</button>
        </div>
      </div>
    </div>`;
  showModal(modalHtml);
}

function updateNewIngCategoryOptions() {
  const checks = document.querySelectorAll('.new-ing-type-cb');
  const checked = [...checks].filter(c => c.checked).map(c => c.value);
  const groups = new Set(checked.map(t => INGREDIENT_TYPE_TO_GROUP[t]).filter(Boolean));
  let catOptions = [];
  if (groups.size === 0) { catOptions = ALL_CATEGORIES; }
  else { groups.forEach(g => { catOptions = catOptions.concat(INGREDIENT_CATEGORIES[g] || []); }); }

  const sel = document.getElementById('new-ing-category');
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="">— Select —</option>' + catOptions.map(c =>
    `<option value="${esc(c)}"${current===c?' selected':''}>${esc(c)}</option>`
  ).join('');
}

async function saveNewIngredient(id) {
  const name = document.getElementById('new-ing-name').value.trim();
  if (!name) { toastError('Name is required'); return; }

  const typeChecks = document.querySelectorAll('.new-ing-type-cb');
  const types = [...typeChecks].filter(c => c.checked).map(c => c.value);

  const ing = {
    id,
    name,
    supplierName: '',
    types,
    category: document.getElementById('new-ing-category').value,
    unit: document.getElementById('new-ing-unit').value,
    supplier: document.getElementById('new-ing-supplier').value.trim(),
    orderCode: document.getElementById('new-ing-orderCode').value.trim(),
    orderUnit: '',
    orderUnitStandard: '',
    orderPrice: null,
    orderAmountGrams: 0,
    priceLevel: '',
    pricePer100g: 0,
    priceHistory: [],
    priceAlert: false,
    storageLocations: {},
    stock: {},
    nutrition: {},
    allergens: '',
    notes: document.getElementById('new-ing-notes').value.trim(),
    active: true,
  };
  try {
    await apiPost('/api/ingredients/' + id, ing);
    ingredientDbFull.push(ing);
    loadIngredientDb();
    closeModal();
    renderOrders();
    toast('Ingredient added');
  } catch (e) {
    toastError('Save failed: ' + e.message);
  }
}

// ── Storage location popover (reusable from any view) ─────────

function openStoragePopover(ingredientId, anchorEl) {
  // Close any existing popover
  const existing = document.getElementById('storage-popover');
  if (existing) existing.remove();

  const ing = ingredientDbFull.find(i => i.id === ingredientId) || S.ingredientDb.find(i => i.id === ingredientId);
  if (!ing) return;

  const storLocs = ing.storageLocations || {};
  const rect = anchorEl.getBoundingClientRect();
  const catNames = Object.keys(STORAGE_CATEGORIES);

  function buildOpts(building) {
    const s = storLocs[building] || {};
    const cat = s.category || '';
    const loc = s.location || '';
    const catOpts = '<option value="">—</option>' + catNames.map(c => `<option value="${esc(c)}"${cat===c?' selected':''}>${esc(c)}</option>`).join('');
    const locOpts = '<option value="">—</option>' + (cat && STORAGE_CATEGORIES[cat] ? STORAGE_CATEGORIES[cat] : []).map(l => `<option value="${esc(l)}"${loc===l?' selected':''}>${esc(l)}</option>`).join('');
    return { catOpts, locOpts };
  }
  const w = buildOpts('west');
  const c = buildOpts('centraal');

  const pop = document.createElement('div');
  pop.id = 'storage-popover';
  pop.className = 'storage-popover';
  pop.style.top = (rect.bottom + window.scrollY + 4) + 'px';
  pop.style.left = Math.max(8, rect.left) + 'px';
  pop.innerHTML = `
    <div style="font-weight:600;font-size:12px;margin-bottom:8px;">Storage locations</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
      <div>
        <label class="ing-edit-label">West: Area</label>
        <select class="order-stock-input" id="pop-storage-west-cat" onchange="updatePopStorageLoc('west')">${w.catOpts}</select>
      </div>
      <div>
        <label class="ing-edit-label">West: Spot</label>
        <select class="order-stock-input" id="pop-storage-west-loc">${w.locOpts}</select>
      </div>
      <div>
        <label class="ing-edit-label">Centraal: Area</label>
        <select class="order-stock-input" id="pop-storage-centraal-cat" onchange="updatePopStorageLoc('centraal')">${c.catOpts}</select>
      </div>
      <div>
        <label class="ing-edit-label">Centraal: Spot</label>
        <select class="order-stock-input" id="pop-storage-centraal-loc">${c.locOpts}</select>
      </div>
    </div>
    <div style="display:flex;gap:6px;justify-content:flex-end;margin-top:8px;">
      <button class="btn btn-sm" onclick="document.getElementById('storage-popover').remove()">Cancel</button>
      <button class="btn btn-sm" style="background:var(--green);color:white;" onclick="saveStorageFromPopover('${esc(ingredientId)}')">Save</button>
    </div>`;

  document.body.appendChild(pop);

  // Close on outside click
  setTimeout(() => {
    document.addEventListener('click', function closePopover(e) {
      if (!pop.contains(e.target) && e.target !== anchorEl) {
        pop.remove();
        document.removeEventListener('click', closePopover);
      }
    });
  }, 50);
}

function updatePopStorageLoc(building) {
  const catSel = document.getElementById('pop-storage-' + building + '-cat');
  const locSel = document.getElementById('pop-storage-' + building + '-loc');
  if (!catSel || !locSel) return;
  const cat = catSel.value;
  const locs = cat && STORAGE_CATEGORIES[cat] ? STORAGE_CATEGORIES[cat] : [];
  locSel.innerHTML = '<option value="">—</option>' + locs.map(l => `<option value="${esc(l)}">${esc(l)}</option>`).join('');
}

async function saveStorageFromPopover(ingredientId) {
  const newLocs = {
    west: { category: document.getElementById('pop-storage-west-cat').value, location: document.getElementById('pop-storage-west-loc').value },
    centraal: { category: document.getElementById('pop-storage-centraal-cat').value, location: document.getElementById('pop-storage-centraal-loc').value },
  };

  // Update in full DB
  const ingFull = ingredientDbFull.find(i => i.id === ingredientId);
  if (ingFull) {
    ingFull.storageLocations = newLocs;
    try {
      await apiPost('/api/ingredients/' + ingredientId, ingFull);
      toast('Storage location saved');
    } catch (e) {
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

async function handleSupplierUpload(file) {
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
  } catch (e) {
    toastError('Upload failed: ' + e.message);
  }
}

function renderSupplierImportPanel() {
  if (!supplierUploadData || !supplierUploadData.length) return '';

  const existingCodes = new Set(ingredientDbFull.map(i => i.orderCode).filter(Boolean));
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

async function applySupplierUpdate() {
  if (!supplierUploadData) return;
  const byCode = {};
  supplierUploadData.forEach(p => { byCode[p.orderCode] = p; });

  let updated = 0;
  ingredientDbFull.forEach(ing => {
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
    ing.orderUnitStandard = sup.orderUnitStandard;
    ing.orderAmountGrams = sup.orderAmountGrams;
    if (!ing.supplier) ing.supplier = 'Hanos';

    // Update price history
    if (sup.priceHistory && sup.priceHistory.length) {
      ing.priceHistory = sup.priceHistory;
    }

    // Update nutrition
    if (sup.nutrition) {
      ing.nutrition = sup.nutrition;
    }

    // Recalculate price per 100g
    if (ing.orderPrice && ing.orderAmountGrams > 0) {
      ing.pricePer100g = Math.round((ing.orderPrice / ing.orderAmountGrams) * 10000) / 100;
    }

    updated++;
  });

  if (updated === 0) { toast('No matching ingredients to update'); return; }

  toast('Saving ' + updated + ' updated ingredients...');
  try {
    await apiPost('/api/ingredients', ingredientDbFull);
    loadIngredientDb();
    supplierUploadData = null;
    renderOrders();
    toast(updated + ' ingredients updated with supplier data');
  } catch (e) {
    toastError('Save failed: ' + e.message);
  }
}

// ── Storage Location Management Modal ─────────────────────────

function openStorageLocationsModal() {
  const cats = Object.keys(STORAGE_CATEGORIES);
  let html = cats.map(cat => {
    const locs = STORAGE_CATEGORIES[cat];
    return `<div style="margin-bottom:12px;padding:8px;background:var(--bg2);border-radius:var(--radius);">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <span style="font-weight:600;font-size:13px;">${esc(cat)}</span>
        <button class="btn btn-sm btn-danger" onclick="removeStorageCategory('${esc(cat)}')">Remove area</button>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px;">
        ${locs.map((l, i) => `<span style="font-size:12px;padding:2px 8px;background:var(--bg);border:1px solid var(--border);border-radius:12px;display:inline-flex;align-items:center;gap:4px;">${esc(l)} <span style="cursor:pointer;opacity:.5;font-size:14px;" onclick="removeStorageSpot('${esc(cat)}',${i})">&times;</span></span>`).join('')}
      </div>
      <div style="display:flex;gap:6px;">
        <input class="order-stock-input" style="flex:1;text-align:left;" id="new-spot-${esc(cat)}" placeholder="New spot..." />
        <button class="btn btn-sm" onclick="addStorageSpot('${esc(cat)}')">Add spot</button>
      </div>
    </div>`;
  }).join('');

  const modalHtml = `
    <div style="padding:20px;max-width:500px;">
      <h3 style="margin:0 0 16px;">Storage Locations</h3>
      <p style="font-size:12px;color:var(--text2);margin:0 0 12px;">
        Define storage areas (Walk-in, Dry storage...) and spots within each (Shelf 1, The cart...).
      </p>
      ${html}
      <div style="display:flex;gap:6px;margin-top:8px;">
        <input class="order-stock-input" style="flex:1;text-align:left;" id="new-storage-cat" placeholder="New area name..." />
        <button class="btn btn-sm" onclick="addStorageCategory()">Add area</button>
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;">
        <button class="btn btn-sm" onclick="closeModal()">Close</button>
      </div>
    </div>`;
  showModal(modalHtml);
}

function addStorageCategory() {
  const input = document.getElementById('new-storage-cat');
  if (!input) return;
  const name = input.value.trim();
  if (!name) return;
  if (STORAGE_CATEGORIES[name]) { toastError('Area already exists'); return; }
  STORAGE_CATEGORIES[name] = [];
  openStorageLocationsModal();
  toast('Area added');
}

function removeStorageCategory(cat) {
  if (!confirm('Remove "' + cat + '" and all its spots?')) return;
  delete STORAGE_CATEGORIES[cat];
  openStorageLocationsModal();
  toast('Area removed');
}

function addStorageSpot(cat) {
  const input = document.getElementById('new-spot-' + cat);
  if (!input) return;
  const name = input.value.trim();
  if (!name) return;
  if (STORAGE_CATEGORIES[cat].includes(name)) { toastError('Spot already exists'); return; }
  STORAGE_CATEGORIES[cat].push(name);
  openStorageLocationsModal();
  toast('Spot added');
}

function removeStorageSpot(cat, idx) {
  STORAGE_CATEGORIES[cat].splice(idx, 1);
  openStorageLocationsModal();
  toast('Spot removed');
}

// ── Migration Modal ───────────────────────────────────────────

function openMigrationModal() {
  const modalHtml = `
    <div style="padding:20px;max-width:500px;">
      <h3 style="margin:0 0 16px;">Migrate Ingredient Database</h3>
      <p style="font-size:12px;color:var(--text2);margin:0 0 12px;">
        Upload the old ingredient CSV and Hanos CSV to rebuild the database. English names from the old DB will be preserved where order codes match. Only ingredients found in the Hanos list will be kept.
      </p>
      <div style="display:grid;gap:12px;">
        <div>
          <label class="ing-edit-label">Old Ingredient Database CSV</label>
          <input type="file" accept=".csv" id="migrate-old-csv" />
        </div>
        <div>
          <label class="ing-edit-label">Hanos CSV (prices export)</label>
          <input type="file" accept=".csv" id="migrate-hanos-csv" />
        </div>
        <div id="migrate-status" style="font-size:12px;color:var(--text2);"></div>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button class="btn btn-sm" onclick="closeModal()">Cancel</button>
          <button class="btn btn-sm" onclick="runMigration(true)">Dry run</button>
          <button class="btn btn-sm" style="background:var(--green);color:white;" onclick="runMigration(false)">Run migration</button>
        </div>
      </div>
    </div>`;
  showModal(modalHtml);
}

async function runMigration(dryRun) {
  const oldFile = document.getElementById('migrate-old-csv').files[0];
  const hanosFile = document.getElementById('migrate-hanos-csv').files[0];
  if (!hanosFile) { toastError('Hanos CSV is required'); return; }

  const status = document.getElementById('migrate-status');
  status.textContent = dryRun ? 'Running dry run...' : 'Running migration...';

  const formData = new FormData();
  if (oldFile) formData.append('oldCsv', oldFile);
  formData.append('hanosCsv', hanosFile);

  try {
    const url = '/api/ingredients/migrate' + (dryRun ? '?dryRun=true' : '');
    const r = await fetch(url, { method: 'POST', body: formData });
    if (!r.ok) throw new Error((await r.json()).error || 'Migration failed');
    const result = await r.json();

    if (dryRun) {
      status.innerHTML = `<strong>Dry run result:</strong><br>
        Total: ${result.total} ingredients<br>
        Matched (old name kept): ${result.matched}<br>
        Hanos only (Dutch name): ${result.hanosOnly}<br>
        Active (ordered in last year): ${result.active}<br>
        Inactive: ${result.inactive}<br>
        <span style="color:var(--green);">Ready to run for real.</span>`;
    } else {
      status.innerHTML = `<strong style="color:var(--green);">Migration complete!</strong><br>
        ${result.total} ingredients saved. ${result.matched} matched with old DB.`;
      ingredientDbFullLoaded = false;
      loadIngredientDb();
      toast('Migration complete: ' + result.total + ' ingredients');
    }
  } catch (e) {
    status.innerHTML = `<span style="color:var(--red);">Error: ${esc(e.message)}</span>`;
    toastError('Migration failed: ' + e.message);
  }
}
