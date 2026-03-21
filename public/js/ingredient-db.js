// ── INGREDIENT DATABASE TAB ──────────────────────────────────

// State
let ingredientDbFull = [];       // full ingredient list from /api/ingredients/full
let ingredientDbFullLoaded = false;
let ingredientDbSearch = '';
let ingredientDbFilter = 'all';  // 'all' | 'active' | 'inactive' | category name
let ingredientDbSort = 'name';   // 'name' | 'supplier' | 'category'
let ingredientDbEditId = null;   // id of ingredient being edited inline
let supplierUploadData = null;   // parsed Hanos XLSX data for import

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

function getIngredientCategories() {
  const cats = new Set();
  ingredientDbFull.forEach(i => { if (i.category) cats.add(i.category); });
  return [...cats].sort();
}

function getFilteredIngredients() {
  let list = ingredientDbFull;

  // Filter
  if (ingredientDbFilter === 'active') list = list.filter(i => i.active !== false);
  else if (ingredientDbFilter === 'inactive') list = list.filter(i => i.active === false);
  else if (ingredientDbFilter !== 'all') list = list.filter(i => i.category === ingredientDbFilter);

  // Search
  if (ingredientDbSearch) {
    const q = ingredientDbSearch.toLowerCase();
    list = list.filter(i =>
      (i.name || '').toLowerCase().includes(q) ||
      (i.supplierName || '').toLowerCase().includes(q) ||
      (i.orderCode || '').includes(q) ||
      (i.supplier || '').toLowerCase().includes(q) ||
      (i.notes || '').toLowerCase().includes(q)
    );
  }

  // Sort
  if (ingredientDbSort === 'supplier') list = [...list].sort((a, b) => (a.supplier || '').localeCompare(b.supplier || '') || a.name.localeCompare(b.name));
  else if (ingredientDbSort === 'category') list = [...list].sort((a, b) => (a.category || '').localeCompare(b.category || '') || a.name.localeCompare(b.name));
  else list = [...list].sort((a, b) => a.name.localeCompare(b.name));

  return list;
}

function renderIngredientDbTab() {
  if (!ingredientDbFullLoaded) {
    loadIngredientDbFull().then(() => renderOrders());
    return '<div class="empty">Loading ingredient database...</div>';
  }

  const categories = getIngredientCategories();
  const filtered = getFilteredIngredients();

  const filterOptions = [
    '<option value="all"' + (ingredientDbFilter === 'all' ? ' selected' : '') + '>All</option>',
    '<option value="active"' + (ingredientDbFilter === 'active' ? ' selected' : '') + '>Active only</option>',
    '<option value="inactive"' + (ingredientDbFilter === 'inactive' ? ' selected' : '') + '>Inactive only</option>',
    ...categories.map(c => '<option value="' + esc(c) + '"' + (ingredientDbFilter === c ? ' selected' : '') + '>' + esc(c) + '</option>')
  ].join('');

  let html = `<div>
    <div class="section-title" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
      <span>Ingredient Database (${ingredientDbFull.length} total, ${filtered.length} shown)</span>
      <div style="display:flex;gap:8px;align-items:center;">
        <button class="btn btn-sm" onclick="openAddIngredientModal()">+ Add ingredient</button>
        <label class="btn btn-sm" style="cursor:pointer;">
          Upload Hanos XLSX
          <input type="file" accept=".xlsx,.xls" style="display:none;" onchange="handleSupplierUpload(this.files[0])" />
        </label>
      </div>
    </div>
    <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;align-items:center;">
      <input type="text" class="dish-search" style="flex:1;min-width:200px;margin:0;" placeholder="Search by name, supplier name, order code..."
        value="${esc(ingredientDbSearch)}" oninput="ingredientDbSearch=this.value;renderOrders()" />
      <select class="dish-search" style="width:auto;margin:0;" onchange="ingredientDbFilter=this.value;renderOrders()">
        ${filterOptions}
      </select>
      <select class="dish-search" style="width:auto;margin:0;" onchange="ingredientDbSort=this.value;renderOrders()">
        <option value="name"${ingredientDbSort === 'name' ? ' selected' : ''}>Sort: Name</option>
        <option value="supplier"${ingredientDbSort === 'supplier' ? ' selected' : ''}>Sort: Supplier</option>
        <option value="category"${ingredientDbSort === 'category' ? ' selected' : ''}>Sort: Category</option>
      </select>
    </div>`;

  if (supplierUploadData) {
    html += renderSupplierImportPanel();
  }

  if (!filtered.length) {
    html += '<div class="empty">No ingredients match your search.</div>';
  } else {
    html += `<div style="overflow-x:auto;"><table class="ing-table">
      <thead><tr>
        <th>Name</th>
        <th>Supplier name</th>
        <th>Category</th>
        <th>Supplier</th>
        <th>Order code</th>
        <th>Unit / Price</th>
        <th>Active</th>
        <th></th>
      </tr></thead><tbody>`;

    filtered.forEach(ing => {
      if (ingredientDbEditId === ing.id) {
        html += renderIngredientEditRow(ing);
      } else {
        const activeClass = ing.active === false ? ' style="opacity:.5;"' : '';
        html += `<tr${activeClass}>
          <td style="font-weight:500;">${esc(ing.name)}</td>
          <td style="font-size:12px;color:var(--text2);" title="${esc(ing.supplierName)}">${esc(ing.supplierName ? (ing.supplierName.length > 30 ? ing.supplierName.slice(0, 28) + '...' : ing.supplierName) : '—')}</td>
          <td style="font-size:12px;">${esc(ing.category || '—')}</td>
          <td style="font-size:12px;">${esc(ing.supplier || '—')}</td>
          <td>${ing.orderCode ? '<span class="order-code">' + esc(ing.orderCode) + '</span>' : '<span style="color:var(--text3);">—</span>'}</td>
          <td style="font-size:12px;">${ing.orderUnit ? esc(ing.orderUnit) : esc(ing.unit || '—')}${ing.orderPrice ? ' · €' + Number(ing.orderPrice).toFixed(2) : ''}</td>
          <td><span style="cursor:pointer;font-size:16px;" onclick="toggleIngredientActive('${esc(ing.id)}')">${ing.active !== false ? '✅' : '❌'}</span></td>
          <td>
            <button class="btn btn-sm" onclick="ingredientDbEditId='${esc(ing.id)}';renderOrders()">Edit</button>
          </td>
        </tr>`;
      }
    });

    html += '</tbody></table></div>';
  }

  html += '</div>';
  return html;
}

function renderIngredientEditRow(ing) {
  return `<tr style="background:var(--bg2);">
    <td><input class="order-stock-input" style="width:140px;" value="${esc(ing.name)}" id="ing-edit-name" /></td>
    <td><input class="order-stock-input" style="width:140px;" value="${esc(ing.supplierName || '')}" id="ing-edit-supplierName" /></td>
    <td><input class="order-stock-input" style="width:100px;" value="${esc(ing.category || '')}" id="ing-edit-category" /></td>
    <td><input class="order-stock-input" style="width:80px;" value="${esc(ing.supplier || '')}" id="ing-edit-supplier" /></td>
    <td><input class="order-stock-input" style="width:90px;" value="${esc(ing.orderCode || '')}" id="ing-edit-orderCode" /></td>
    <td><input class="order-stock-input" style="width:100px;" value="${esc(ing.orderUnit || '')}" id="ing-edit-orderUnit" />
        <input class="order-stock-input" style="width:60px;margin-top:2px;" type="number" step="0.01" value="${ing.orderPrice || ''}" placeholder="Price" id="ing-edit-orderPrice" /></td>
    <td><input type="checkbox" id="ing-edit-active" ${ing.active !== false ? 'checked' : ''} /></td>
    <td style="white-space:nowrap;">
      <button class="btn btn-sm" onclick="saveIngredientEdit('${esc(ing.id)}')">Save</button>
      <button class="btn btn-sm btn-danger" onclick="ingredientDbEditId=null;renderOrders()">Cancel</button>
    </td>
  </tr>
  <tr style="background:var(--bg2);"><td colspan="8" style="padding-top:0;">
    <div style="display:flex;gap:8px;align-items:center;">
      <span style="font-size:11px;color:var(--text2);">Notes:</span>
      <input class="order-stock-input" style="flex:1;" value="${esc(ing.notes || '')}" id="ing-edit-notes" placeholder="Notes..." />
      <span style="font-size:11px;color:var(--text2);">Storage:</span>
      <input class="order-stock-input" style="width:120px;" value="${esc(ing.storageLocation || '')}" id="ing-edit-storage" placeholder="Storage location" />
      <span style="font-size:11px;color:var(--text2);">Allergens:</span>
      <input class="order-stock-input" style="width:120px;" value="${esc(ing.allergens || '')}" id="ing-edit-allergens" placeholder="Allergens" />
      <button class="btn btn-sm btn-danger" onclick="deleteIngredient('${esc(ing.id)}','${esc(ing.name)}')">Delete</button>
    </div>
  </td></tr>`;
}

async function saveIngredientEdit(id) {
  const ing = ingredientDbFull.find(i => i.id === id);
  if (!ing) return;

  const updated = {
    ...ing,
    name: document.getElementById('ing-edit-name').value.trim(),
    supplierName: document.getElementById('ing-edit-supplierName').value.trim(),
    category: document.getElementById('ing-edit-category').value.trim(),
    supplier: document.getElementById('ing-edit-supplier').value.trim(),
    orderCode: document.getElementById('ing-edit-orderCode').value.trim(),
    orderUnit: document.getElementById('ing-edit-orderUnit').value.trim(),
    orderPrice: parseFloat(document.getElementById('ing-edit-orderPrice').value) || null,
    active: document.getElementById('ing-edit-active').checked,
    notes: document.getElementById('ing-edit-notes').value.trim(),
    storageLocation: document.getElementById('ing-edit-storage').value.trim(),
    allergens: document.getElementById('ing-edit-allergens').value.trim(),
  };

  if (!updated.name) { toastError('Name is required'); return; }

  try {
    await apiPost('/api/ingredients/' + id, updated);
    Object.assign(ing, updated);
    ingredientDbEditId = null;
    // Also refresh the main ingredientDb used by orders
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
  const modalHtml = `
    <div style="padding:20px;max-width:500px;">
      <h3 style="margin:0 0 16px;">Add Ingredient</h3>
      <div style="display:grid;gap:10px;">
        <div>
          <label style="font-size:12px;font-weight:600;">Name *</label>
          <input class="order-stock-input" style="width:100%;" id="new-ing-name" placeholder="English name (e.g. Frozen Spinach)" />
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
          <div>
            <label style="font-size:12px;font-weight:600;">Category</label>
            <input class="order-stock-input" style="width:100%;" id="new-ing-category" placeholder="e.g. Vegetables" />
          </div>
          <div>
            <label style="font-size:12px;font-weight:600;">Unit</label>
            <select class="order-stock-input" style="width:100%;" id="new-ing-unit">
              <option>Grams</option><option>ML</option><option>pieces</option>
            </select>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
          <div>
            <label style="font-size:12px;font-weight:600;">Supplier</label>
            <input class="order-stock-input" style="width:100%;" id="new-ing-supplier" placeholder="e.g. Hanos" />
          </div>
          <div>
            <label style="font-size:12px;font-weight:600;">Order code</label>
            <input class="order-stock-input" style="width:100%;" id="new-ing-orderCode" placeholder="e.g. 34225259" />
          </div>
        </div>
        <div>
          <label style="font-size:12px;font-weight:600;">Notes</label>
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

async function saveNewIngredient(id) {
  const name = document.getElementById('new-ing-name').value.trim();
  if (!name) { toastError('Name is required'); return; }
  const ing = {
    id,
    name,
    supplierName: '',
    category: document.getElementById('new-ing-category').value.trim(),
    unit: document.getElementById('new-ing-unit').value,
    supplier: document.getElementById('new-ing-supplier').value.trim(),
    orderCode: document.getElementById('new-ing-orderCode').value.trim(),
    orderUnit: '',
    orderUnitStandard: '',
    orderPrice: null,
    orderAmountGrams: 0,
    allergens: '',
    notes: document.getElementById('new-ing-notes').value.trim(),
    storageLocation: '',
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

  // Find which products match existing ingredients by order code
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
    ing.supplierName = sup.title;
    ing.orderPrice = sup.price;
    ing.orderUnit = sup.orderUnit;
    ing.orderUnitStandard = sup.orderUnitStandard;
    ing.orderAmountGrams = sup.orderAmountGrams;
    if (!ing.supplier) ing.supplier = 'Hanos';
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
