// ── ORDER OVERVIEW ────────────────────────────────────────

// State
let orderInventory = {};        // in-stock amounts for dish ingredients (keyed by name lowercase)
let combinedOrderStock = {};   // in-stock amounts for combined order tab (grams, keyed by name lowercase)
let currentOrdersTab = 'combined'; // 'combined' | 'standard' | 'batches' | 'ingredientDb'
let currentOrdersLoc = '';  // set on first render from S.currentLoc
let siSearchQuery = '';
let hanosStatus = { configured: false, west: false, centraal: false };
let hanosStatusChecked = false;
let combinedIncludeDishes = true; // toggle: include dish ingredients in combined order

// ── Shared helpers ────────────────────────────────────────

// Convert to base units: grams for weight, ml for volume, raw count for pieces
function toBaseUnit(amount, unit) {
  const u = (unit || '').toLowerCase().replace(/'/g, '');
  if (u === 'kilos' || u === 'kilo' || u === 'kg') return amount * 1000;
  if (u === 'liters' || u === 'liter' || u === 'litres' || u === 'l') return amount * 1000;
  return amount;
}

function normalizeSupplier(s) {
  if (!s) return 'Unknown';
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

// Format a base-unit amount with the right suffix (g/kg, ml/L, or pcs)
function formatAmount(val, baseUnit) {
  const u = (baseUnit || 'g').toLowerCase();
  if (u === 'ml' || u === 'liters' || u === 'l') {
    if (val >= 1000) {
      const l = Math.round(val / 100) / 10;
      return { amount: l, unit: 'L' };
    }
    return { amount: Math.round(val), unit: 'ml' };
  }
  if (u === 'pieces' || u === 'pcs' || u === 'amount') {
    return { amount: Math.round(val), unit: 'pcs' };
  }
  // Default: weight (g/kg)
  if (val >= 1000) {
    const kg = Math.round(val / 100) / 10;
    return { amount: kg, unit: 'kg' };
  }
  return { amount: Math.round(val), unit: 'g' };
}

function lookupIngredient(name) {
  if (!S.ingredientDb.length || !name) return null;
  const q = name.toLowerCase().trim();
  let match = S.ingredientDb.find(i => i.name.toLowerCase().trim() === q);
  if (match) return match;
  match = S.ingredientDb.find(i => {
    const dn = i.name.toLowerCase().trim();
    return dn.startsWith(q) || q.startsWith(dn);
  });
  if (match) return match;
  const qBase = q.replace(/\s*\(.*\)\s*$/, '').trim();
  if (qBase !== q) {
    match = S.ingredientDb.find(i => i.name.toLowerCase().trim().replace(/\s*\(.*\)\s*$/, '').trim() === qBase);
  }
  return match || null;
}

function getDbStockTotal(db) {
  if (!db || !db.stock) return 0;
  let total = 0;
  if (db.stock.west) total += (db.stock.west.amount || 0);
  if (db.stock.centraal) total += (db.stock.centraal.amount || 0);
  return total;
}

function formatStorageLoc(s) {
  if (!s) return '';
  if (typeof s === 'string') return s; // backward compat
  if (s.category && s.location) return s.category + ' / ' + s.location;
  if (s.category) return s.category;
  return '';
}

function getStorageCategory(db, building) {
  if (!db || !db.storageLocations) return '';
  const s = db.storageLocations[building];
  if (!s) return '';
  if (typeof s === 'string') return s;
  return s.category || '';
}

function renderStorageBadge(db, loc) {
  if (!db || !db.storageLocations) return '';
  const building = loc || currentOrdersLoc || 'west';
  const s = db.storageLocations[building];
  const label = formatStorageLoc(s);
  if (!label) return `<span class="stock-badge" style="cursor:pointer;font-size:10px;color:var(--text2);border:1px dashed var(--border2);" onclick="openStoragePopover('${esc(db.id)}',this)" title="Click to set">No location set</span>`;
  const cat = getStorageCategory(db, building);
  const color = cat ? getStorageColor(cat, building) : '#999';
  return `<span class="stock-badge" style="cursor:pointer;font-size:10px;background:${color}22;color:${color};border:1px solid ${color}44;" onclick="openStoragePopover('${esc(db.id)}',this)" title="Click to edit">${esc(label)}</span>`;
}

function calcOrderUnits(amountBase, dbEntry) {
  if (!dbEntry || !dbEntry.orderUnitSize || dbEntry.orderUnitSize <= 0) return null;
  const units = Math.ceil(amountBase / dbEntry.orderUnitSize);
  return { units, perUnit: dbEntry.orderUnitSize, unitType: dbEntry.unit || 'g' };
}

// ── Standard Inventory (now reads from ingredient targetStock) ──

// Get ingredients that have targetStock set for a location
function getStandardInventoryItems(loc) {
  return S.ingredientDb.filter(ing => {
    const ts = ing.targetStock;
    return ts && ts[loc] && ts[loc] > 0;
  });
}

function updateSiSearch(val) {
  siSearchQuery = val;
  const sugContainer = document.getElementById('si-suggestions');
  if (!sugContainer) return;
  const query = val.toLowerCase().trim();
  const loc = currentOrdersLoc || 'west';
  const addedIds = new Set(getStandardInventoryItems(loc).map(i => i.id));
  const suggestions = query.length >= 2
    ? S.ingredientDb.filter(i => i.name.toLowerCase().includes(query) || (i.orderCode && i.orderCode.toLowerCase().includes(query))).slice(0, 8)
    : [];
  let html = suggestions.map(ing => {
    const isAdded = addedIds.has(ing.id);
    return `<div class="si-suggestion${isAdded ? ' si-suggestion-added' : ''}" ${!isAdded ? `onclick="addToStandardInventory('${esc(ing.id)}')"` : ''}>
      <span class="si-sug-name">${esc(ing.name)}</span>
      <span class="si-sug-meta">${ing.supplier ? esc(ing.supplier) + ' · ' : ''}${ing.orderCode ? esc(ing.orderCode) + ' · ' : ''}${ing.unit || 'g'}</span>
      ${isAdded ? '<span style="color:var(--green);font-size:11px;font-weight:600;">\u2713 added</span>' : ''}
    </div>`;
  }).join('');
  sugContainer.innerHTML = html;
  sugContainer.style.display = html ? 'block' : 'none';
}

function hideSiSuggestions() {
  setTimeout(() => {
    siSearchQuery = '';
    const sugContainer = document.getElementById('si-suggestions');
    if (sugContainer) { sugContainer.innerHTML = ''; sugContainer.style.display = 'none'; }
    const input = document.getElementById('si-search-input');
    if (input) input.value = '';
  }, 200);
}

async function addToStandardInventory(ingredientId) {
  const loc = currentOrdersLoc || 'west';
  const ing = S.ingredientDb.find(i => i.id === ingredientId);
  if (!ing) return;
  // Set a default target of 0 (user will edit)
  if (!ing.targetStock) ing.targetStock = {};
  ing.targetStock[loc] = 1; // placeholder — user edits the real target
  siSearchQuery = '';
  try {
    await apiPost('/api/ingredients/target-stock', { ingredientId, location: loc, amount: 1 });
  } catch (e) { toast('Failed to add: ' + e.message, true); }
  renderOrders();
}

async function removeSiItem(ingredientId) {
  const loc = currentOrdersLoc || 'west';
  const ing = S.ingredientDb.find(i => i.id === ingredientId);
  if (ing && ing.targetStock) delete ing.targetStock[loc];
  try {
    await apiPost('/api/ingredients/target-stock', { ingredientId, location: loc, amount: null });
  } catch (e) { toast('Failed to remove: ' + e.message, true); }
  renderOrders();
}

let siTargetTimeout = null;
function updateSiTarget(ingredientId, val) {
  const loc = currentOrdersLoc || 'west';
  const ing = S.ingredientDb.find(i => i.id === ingredientId);
  if (!ing) return;
  if (!ing.targetStock) ing.targetStock = {};
  // Input is in order units — convert to base units for storage
  const orderUnits = parseFloat(val) || 0;
  const baseAmount = ing.orderUnitSize > 0 ? orderUnits * ing.orderUnitSize : orderUnits;
  ing.targetStock[loc] = baseAmount;
  _updateSiToOrder(ingredientId, ing);
  clearTimeout(siTargetTimeout);
  siTargetTimeout = setTimeout(async () => {
    try {
      await apiPost('/api/ingredients/target-stock', { ingredientId, location: loc, amount: baseAmount });
    } catch (e) { toast('Failed to save target: ' + e.message, true); }
  }, 800);
}

let siStockTimeout = null;
function updateSiStock(ingredientId, val) {
  const loc = currentOrdersLoc || 'west';
  const ing = S.ingredientDb.find(i => i.id === ingredientId);
  if (!ing) return;
  if (!ing.stock) ing.stock = {};
  // Input is in order units — convert to base units for storage
  const orderUnits = parseFloat(val) || 0;
  const baseAmount = ing.orderUnitSize > 0 ? orderUnits * ing.orderUnitSize : orderUnits;
  ing.stock[loc] = { amount: baseAmount, date: new Date().toISOString().slice(0, 10) };
  _updateSiToOrder(ingredientId, ing);
  clearTimeout(siStockTimeout);
  siStockTimeout = setTimeout(async () => {
    try {
      await apiPost('/api/ingredients/stock', { ingredientId, location: loc, amount: baseAmount });
    } catch (e) { toast('Failed to save stock: ' + e.message, true); }
  }, 800);
}

/** Inline update the to-order cell for a standard inventory row */
function _updateSiToOrder(ingredientId, ing) {
  const loc = currentOrdersLoc || 'west';
  const row = document.querySelector(`tr[data-si-id="${ingredientId}"]`);
  if (!row) return;
  const toOrderCell = row.querySelector('.si-to-order');
  if (!toOrderCell) return;

  const targetBase = (ing.targetStock && ing.targetStock[loc]) || 0;
  const stockBase = (ing.stock && ing.stock[loc]) ? (ing.stock[loc].amount || 0) : 0;
  const deficit = Math.max(0, targetBase - stockBase);
  const hasOrderUnit = ing.orderUnitSize > 0;
  const orderUnitLabel = ing.orderUnit || '';
  const unitSuffix = hasOrderUnit ? (orderUnitLabel || 'units') : (() => { const f = formatAmount(0, ing.unit); return f.unit; })();

  if (deficit > 0) {
    const calc = hasOrderUnit ? calcOrderUnits(deficit, ing) : null;
    toOrderCell.innerHTML = calc
      ? `<span class="to-order-positive">${calc.units}x ${esc(unitSuffix)}</span>`
      : (() => { const f = formatAmount(deficit, ing.unit); return `<span class="to-order-positive">${f.amount} ${f.unit}</span>`; })();
  } else {
    toOrderCell.innerHTML = '<span class="to-order-zero">\u2713 full</span>';
  }
}

// ── Tab switching ─────────────────────────────────────────

function switchOrdersTab(tab) {
  currentOrdersTab = tab;
  renderOrders();
}

function switchOrdersLoc(loc) {
  currentOrdersLoc = loc;
  renderOrders();
}

// ── Main render ────────────────────────────────────────────

function renderOrders() {
  if (!ingredientDbLoaded) {
    document.getElementById('screen-orders').innerHTML = '<div class="empty">Loading ingredient database...</div>';
    setTimeout(renderOrders, 500);
    return;
  }

  if (!currentOrdersLoc) currentOrdersLoc = S.currentLoc || 'west';
  rebuildStorageCategories(currentOrdersLoc);
  checkHanosStatus();

  const locBar = `<div class="order-loc-bar">
    <button class="order-loc-btn${currentOrdersLoc === 'west' ? ' active' : ''}" onclick="switchOrdersLoc('west')">Sering West</button>
    <button class="order-loc-btn${currentOrdersLoc === 'centraal' ? ' active' : ''}" onclick="switchOrdersLoc('centraal')">Sering Centraal</button>
  </div>`;

  const tabBar = `<div class="order-tab-bar">
    <button class="order-tab-btn${currentOrdersTab === 'combined' ? ' active' : ''}" onclick="switchOrdersTab('combined')">🛒 Combined Order</button>
    <button class="order-tab-btn${currentOrdersTab === 'standard' ? ' active' : ''}" onclick="switchOrdersTab('standard')">📦 Standard Inventory</button>
    <button class="order-tab-btn${currentOrdersTab === 'batches' ? ' active' : ''}" onclick="switchOrdersTab('batches')">🍽️ Batch Ingredients</button>
    <button class="order-tab-btn${currentOrdersTab === 'ingredientDb' ? ' active' : ''}" onclick="switchOrdersTab('ingredientDb')">🗄️ Ingredient Database</button>
  </div>`;

  let content;
  if (currentOrdersTab === 'standard') content = renderStandardInventoryTab();
  else if (currentOrdersTab === 'batches') content = renderDishesTab();
  else if (currentOrdersTab === 'ingredientDb') content = renderIngredientDbTab();
  else content = renderCombinedOrderTab();

  document.getElementById('screen-orders').innerHTML = locBar + tabBar + content;
}

// ── Standard Inventory tab ────────────────────────────────

function renderStandardInventoryTab() {
  const curLoc = currentOrdersLoc || 'west';
  const siItems = getStandardInventoryItems(curLoc);

  // Build enriched list with stock, target, deficit, and order calculations
  // Stock and target are stored in base units (g/ml/pcs) but displayed in order units when possible
  const ingList = siItems.map(ing => {
    const targetBase = ing.targetStock[curLoc] || 0;
    const stockBase = (ing.stock && ing.stock[curLoc]) ? (ing.stock[curLoc].amount || 0) : 0;
    const deficit = Math.max(0, targetBase - stockBase);
    const orderCalc = deficit > 0 ? calcOrderUnits(deficit, ing) : null;
    const hasOrderUnit = ing.orderUnitSize > 0;
    // Convert to order units for display
    const stockUnits = hasOrderUnit ? Math.round(stockBase / ing.orderUnitSize * 10) / 10 : stockBase;
    const targetUnits = hasOrderUnit ? Math.round(targetBase / ing.orderUnitSize * 10) / 10 : targetBase;
    return {
      ...ing,
      targetBase,
      stockBase,
      stockUnits,
      targetUnits,
      hasOrderUnit,
      deficit,
      orderCalc,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  // Calculate total estimated order cost
  let totalValue = 0;
  ingList.forEach(ing => {
    if (ing.orderCalc && ing.orderPrice) {
      totalValue += ing.orderCalc.units * ing.orderPrice;
    }
  });

  // Group by storage category
  const byStorage = {};
  ingList.forEach(ing => {
    const cat = getStorageCategory(ing, curLoc) || 'Unsorted';
    if (!byStorage[cat]) byStorage[cat] = [];
    byStorage[cat].push(ing);
  });
  const storageCatOrder = Object.keys(STORAGE_CATEGORIES);
  const storageOrder = [...storageCatOrder.filter(c => byStorage[c]), ...Object.keys(byStorage).filter(c => !storageCatOrder.includes(c))];

  let itemsHtml = '';
  if (siItems.length === 0) {
    itemsHtml = '<div class="empty">No items yet. Search above to add ingredients to the standard inventory.</div>';
  } else {
    storageOrder.forEach(storageCat => {
      const items = byStorage[storageCat];
      const codesForCopy = items.filter(i => i.orderCode && !i.orderCode.startsWith('http')).map(i => i.orderCode);
      const catColor = getStorageColor(storageCat, curLoc);

      itemsHtml += `<div class="storage-group" style="margin-bottom:16px;border-left:4px solid ${catColor};padding-left:10px;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
          <span class="storage-group-dot" style="background:${catColor};"></span>
          <span style="font-weight:600;font-size:14px;">${esc(storageCat)}</span>
          <span style="font-size:12px;color:var(--text2);">(${items.length} item${items.length !== 1 ? 's' : ''})</span>
          ${codesForCopy.length ? `<button class="copy-all-btn" onclick="copySiOrderCodes('${esc(storageCat)}')">Copy all codes</button>` : ''}
        </div>
        <div style="overflow-x:auto;"><table class="ing-table">
        <thead><tr>
          <th>Ingredient</th>
          <th>Storage</th>
          <th>Order code</th>
          <th>Unit / Price</th>
          <th>In stock</th>
          <th>Target</th>
          <th>To order</th>
          <th></th>
        </tr></thead><tbody>`;

      items.forEach(ing => {
        const isUrl = ing.orderCode && (ing.orderCode.startsWith('http') || ing.orderCode.startsWith('www'));
        let codeDisplay;
        if (!ing.orderCode) codeDisplay = '<span style="color:var(--text2);font-size:11px;">\u2014</span>';
        else if (isUrl) codeDisplay = `<a href="${esc(ing.orderCode.startsWith('http') ? ing.orderCode : 'https://'+ing.orderCode)}" target="_blank" rel="noopener" style="font-size:11px;color:var(--blue);">Order link \u2197</a>`;
        else codeDisplay = `<span class="order-code">${esc(ing.orderCode)}</span>`;

        const orderUnitLabel = ing.orderUnit ? esc(ing.orderUnit) : '';
        const unitPrice = (orderUnitLabel || 'unit') + (ing.orderPrice ? ' \u00B7 \u20AC' + Number(ing.orderPrice).toFixed(2) : '');

        // Display in order units when possible, otherwise in base units
        const unitSuffix = ing.hasOrderUnit ? (orderUnitLabel || 'units') : (() => { const f = formatAmount(0, ing.unit); return f.unit; })();
        const stockColor = ing.stockBase >= ing.targetBase ? 'var(--green)' : ing.stockBase > 0 ? 'var(--orange, #e67e22)' : 'var(--red)';

        const deficitDisplay = ing.deficit > 0
          ? (ing.orderCalc
            ? `<span class="to-order-positive">${ing.orderCalc.units}x ${unitSuffix}</span>`
            : (() => { const f = formatAmount(ing.deficit, ing.unit); return `<span class="to-order-positive">${f.amount} ${f.unit}</span>`; })())
          : '<span class="to-order-zero">\u2713 full</span>';

        itemsHtml += `<tr data-si-id="${esc(ing.id)}">
          <td style="font-weight:500;cursor:pointer;text-decoration:underline dotted;text-underline-offset:3px;" onclick="openIngredientModal('${esc(ing.name)}')">${esc(ing.name)}</td>
          <td>${renderStorageBadge(ing)}</td>
          <td>${codeDisplay}</td>
          <td style="font-size:12px;">${unitPrice}</td>
          <td style="white-space:nowrap;">
            <input class="order-stock-input" type="number" min="0" step="0.1" value="${ing.stockUnits || ''}" placeholder="0" style="width:55px;" oninput="updateSiStock('${esc(ing.id)}', this.value)" />
            <span class="order-units" style="margin-left:2px;">x ${unitSuffix}</span>
          </td>
          <td style="white-space:nowrap;">
            <input class="order-stock-input" type="number" min="0" step="1" value="${ing.targetUnits > 0 ? ing.targetUnits : ''}" placeholder="0" style="width:55px;" oninput="updateSiTarget('${esc(ing.id)}', this.value)" />
            <span class="order-units" style="margin-left:2px;">x ${unitSuffix}</span>
          </td>
          <td class="si-to-order">${deficitDisplay}</td>
          <td></td>
          <td><button class="btn btn-danger btn-sm" onclick="removeSiItem('${esc(ing.id)}')">Remove</button></td>
        </tr>`;
      });

      itemsHtml += `</tbody></table></div></div>`;
    });
  }

  return `
    <div>
      <div class="section-title" style="display:flex;justify-content:space-between;align-items:center;">
        <span>Set Standard Inventory &mdash; ${esc(curLoc === 'west' ? 'Sering West' : 'Sering Centraal')}</span>
        ${totalValue > 0 ? `<span style="font-size:13px;font-weight:600;">Estimated order: \u20AC${totalValue.toFixed(2)}</span>` : ''}
      </div>
      <p style="font-size:13px;color:var(--text2);margin-bottom:14px;">Set target stock levels for each ingredient. The order is calculated automatically from the deficit (target \u2212 current stock).</p>
      <div style="position:relative;margin-bottom:16px;">
        <input
          id="si-search-input"
          type="text"
          class="dish-search"
          style="margin-bottom:0;"
          placeholder="Search ingredients to add..."
          oninput="updateSiSearch(this.value)"
          onblur="hideSiSuggestions()"
          autocomplete="off"
        />
        <div id="si-suggestions" class="si-suggestions" style="display:none;"></div>
      </div>
      ${itemsHtml}
    </div>
  `;
}

// ── Dishes tab ────────────────────────────────────────────

function renderDishesTab() {
  const orderedDishes = S.batches.filter(d => d.orderFor);
  const combined = {};

  orderedDishes.forEach(dish => {
    const ings = calcIngredientsFromRecipe(dish);
    ings.forEach(ing => {
      const key = ing.name.toLowerCase().trim();
      if (!combined[key]) combined[key] = { name: ing.name, amount: 0, unit: ing.unit, source: ing.source, dishes: [] };
      combined[key].amount += ing.amount;
      if (!combined[key].dishes.includes(dish.name)) combined[key].dishes.push(dish.name);
      if (!combined[key].source && ing.source) combined[key].source = ing.source;
    });
  });

  const ingList = Object.values(combined).map(ing => {
    const db = lookupIngredient(ing.name);
    const amtInGrams = toBaseUnit(ing.amount, ing.unit);
    return {
      ...ing,
      db,
      amountInGrams: amtInGrams,
      supplier: normalizeSupplier((db && db.supplier) || ing.source || ''),
      orderCode: db ? db.orderCode : '',
      orderCalc: db ? calcOrderUnits(amtInGrams, db) : null,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  const curLoc = currentOrdersLoc || 'west';
  const byStorage = {};
  ingList.forEach(ing => {
    const cat = getStorageCategory(ing.db, curLoc) || 'Unsorted';
    if (!byStorage[cat]) byStorage[cat] = [];
    byStorage[cat].push(ing);
  });
  const storageCatOrder = Object.keys(STORAGE_CATEGORIES);
  const storageOrder = [...storageCatOrder.filter(c => byStorage[c]), ...Object.keys(byStorage).filter(c => !storageCatOrder.includes(c))];

  const dishesWithSheets = orderedDishes.filter(d => d.recipeSheetId);
  const hanosAllBatchBtn = isHanosEnabled() && ingList.length ? `<button class="hanos-bulk-btn" onclick="hanosConfirmBulkBatches()" title="Send all batch ingredients to Hanos cart">🛒 Send all to Hanos</button>` : '';
  let html = `<div style="margin-bottom:20px;">
    <div class="section-title" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
      <span>Ingredient order (${orderedDishes.length} batch${orderedDishes.length !== 1 ? 'es' : ''} flagged)</span>
      <div style="display:flex;align-items:center;gap:8px;">
        <span style="font-weight:400;font-size:12px;color:var(--text2);">${orderedDishes.map(d => esc(d.name)).join(' · ')}</span>
        ${dishesWithSheets.length ? `<button class="copy-all-btn" onclick="refreshAllRecipes()">↻ Refresh recipe data</button>` : ''}
        ${hanosAllBatchBtn}
      </div>
    </div>`;

  if (!ingList.length) {
    if (orderedDishes.length === 0) {
      html += `<div class="empty">No batches flagged for order. In the Week plan, toggle the order flag on batches you want to include.</div>`;
    } else {
      html += `<div class="empty">Batches are flagged but have no recipe data. Make sure they have a linked recipe sheet with ingredients.</div>`;
    }
  } else {
    storageOrder.forEach(storageCat => {
      const items = byStorage[storageCat];
      const codesForCopy = items.filter(i => i.orderCode && !i.orderCode.startsWith('http')).map(i => i.orderCode);
      const catColor = getStorageColor(storageCat, curLoc);
      const hanosItemsForCat = isHanosEnabled() ? items.filter(i => i.orderCode && !i.orderCode.startsWith('http')) : [];
      const hanosBatchBtn = hanosItemsForCat.length ? `<button class="hanos-bulk-btn" onclick="hanosConfirmBulkBatches('${esc(storageCat)}')" title="Add all items to Hanos cart">🛒 Send to Hanos</button>` : '';

      html += `<div class="storage-group" data-storage-cat="${esc(storageCat)}" style="margin-bottom:16px;border-left:4px solid ${catColor};padding-left:10px;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
          <span class="storage-group-dot" style="background:${catColor};"></span>
          <span style="font-weight:600;font-size:14px;">${esc(storageCat)}</span>
          <span style="font-size:12px;color:var(--text2);">(${items.length} item${items.length !== 1 ? 's' : ''})</span>
          ${codesForCopy.length ? `<button class="copy-all-btn" onclick="copyDishOrderCodes('${esc(storageCat)}')">Copy all codes</button>` : ''}
          ${hanosBatchBtn}
        </div>
        <div style="overflow-x:auto;"><table class="ing-table">
        <thead><tr>
          <th>Ingredient</th><th>Category</th><th>Storage</th><th>Order code</th>
          <th>Needed</th><th>In stock</th><th>To order</th><th>For batches</th>
        </tr></thead><tbody>`;

      items.forEach(ing => {
        const key = ing.name.toLowerCase().trim();
        const isUrl = ing.orderCode && (ing.orderCode.startsWith('http') || ing.orderCode.startsWith('www'));
        const amtNeededBase = Math.round(ing.amountInGrams);
        const db = ing.db;
        const hasOrderUnit = db && db.orderUnitSize > 0;
        const orderUnitLabel = db && db.orderUnit ? esc(db.orderUnit) : '';
        const unitSuffix = hasOrderUnit ? (orderUnitLabel || 'units') : (() => { const f = formatAmount(0, db ? db.unit : 'g'); return f.unit; })();

        let codeDisplay;
        if (!db) codeDisplay = '<span style="color:var(--red);font-size:10px;opacity:.7;">not in DB</span>';
        else if (!ing.orderCode) codeDisplay = '<span style="color:var(--text2);font-size:11px;">no code</span>';
        else if (isUrl) codeDisplay = `<a href="${esc(ing.orderCode.startsWith('http') ? ing.orderCode : 'https://'+ing.orderCode)}" target="_blank" rel="noopener" style="font-size:11px;color:var(--blue);">Order link \u2197</a>`;
        else codeDisplay = `<span class="order-code" title="Click to select">${esc(ing.orderCode)}</span>`;

        // Amount needed in order units
        const neededCalc = hasOrderUnit ? calcOrderUnits(amtNeededBase, db) : null;
        const neededDisplay = neededCalc
          ? `<span class="order-amt">${neededCalc.units}x</span> <span class="order-units">${unitSuffix}</span>`
          : (() => { const f = formatAmount(amtNeededBase, db ? db.unit : 'g'); return `<span class="order-amt">${f.amount}</span> <span class="order-units">${f.unit}</span>`; })();

        // Stock in order units
        const dbStock = getDbStockTotal(db);
        const hasManualStock = orderInventory[key] !== undefined;
        // orderInventory stores values in order units now
        const stockInUnits = hasManualStock ? (parseFloat(orderInventory[key]) || 0) : (hasOrderUnit && dbStock > 0 ? Math.round(dbStock / db.orderUnitSize * 10) / 10 : dbStock);
        const stockDisplayVal = hasManualStock ? orderInventory[key] : (dbStock > 0 ? (hasOrderUnit ? Math.round(dbStock / db.orderUnitSize * 10) / 10 : dbStock) : '');
        const stockLabel = (!hasManualStock && dbStock > 0) ? ' <span style="font-size:9px;color:var(--blue);vertical-align:super;">DB</span>' : '';
        const stockInput = `<input class="order-stock-input" type="number" min="0" step="0.1" value="${stockDisplayVal}" placeholder="0" oninput="updateOrderStock('${esc(key)}',this.value)" /><span class="order-units" style="margin-left:2px;">${unitSuffix}</span>${stockLabel}`;

        // To order: convert stock back to base for calculation
        const effectiveStockBase = hasManualStock
          ? (hasOrderUnit ? (parseFloat(orderInventory[key]) || 0) * db.orderUnitSize : (parseFloat(orderInventory[key]) || 0))
          : dbStock;
        const hasStockValue = hasManualStock || dbStock > 0;
        const toOrderBase = Math.max(0, amtNeededBase - effectiveStockBase);
        const toOrderCalc = hasOrderUnit ? calcOrderUnits(toOrderBase, db) : null;

        let toOrderDisplay;
        if (!hasStockValue) {
          toOrderDisplay = `<span style="color:var(--text2);font-size:11px;">enter stock \u2192</span>`;
        } else if (toOrderBase <= 0) {
          toOrderDisplay = '<span class="to-order-zero">\u2713 enough</span>';
        } else if (toOrderCalc) {
          const hanosBtnBatch = (isHanosEnabled() && ing.orderCode && !isUrl && toOrderCalc.units > 0)
            ? ` <button class="hanos-btn" onclick="hanosAddSingle('${esc(ing.orderCode)}','${esc(ing.name)}')" title="Add to Hanos cart">🛒</button>`
            : '';
          toOrderDisplay = `<span class="to-order-positive">${toOrderCalc.units}x ${unitSuffix}</span>${hanosBtnBatch}`;
        } else {
          const f = formatAmount(toOrderBase, db ? db.unit : 'g');
          toOrderDisplay = `<span class="to-order-positive">${f.amount} ${f.unit}</span>`;
        }

        html += `<tr data-stock-key="${esc(key)}" data-needed="${amtNeededBase}" data-unit="${esc(db ? db.unit : 'g')}">
          <td style="font-weight:500;cursor:pointer;text-decoration:underline dotted;text-underline-offset:3px;" onclick="openIngredientModal('${esc(ing.name)}')">${esc(ing.name)}</td>
          <td style="font-size:12px;">${db && db.category ? esc(db.category) : '\u2014'}</td>
          <td>${renderStorageBadge(db)}</td>
          <td>${codeDisplay}</td>
          <td>${neededDisplay}</td>
          <td>${stockInput}</td>
          <td class="to-order-cell">${toOrderDisplay}</td>
          <td style="font-size:11px;color:var(--text2);">${ing.dishes.map(n => esc(n.length > 20 ? n.slice(0,18)+'\u2026' : n)).join(', ')}</td>
        </tr>`;
      });

      html += `</tbody></table></div></div>`;
    });
  }
  html += `</div>`;

  if (ingredientDbError || S.ingredientDb.length === 0) {
    html += `<div style="font-size:11px;color:var(--text2);margin-top:12px;padding:8px;border-top:1px solid var(--border);">
      ${ingredientDbError ? `<span style="color:var(--red);">Ingredient DB error: ${esc(ingredientDbError)}</span>` : ''}
      ${S.ingredientDb.length === 0 && !ingredientDbError ? 'Ingredient database is empty. <button class="btn btn-sm" onclick="loadIngredientDb().then(renderOrders)">Retry</button>' : ''}
    </div>`;
  }

  return html;
}

// ── Combined Order tab ────────────────────────────────────

function renderCombinedOrderTab() {
  const combined = {};
  const orderedDishes = S.batches.filter(d => d.orderFor);

  function addToMap(name, amtGrams, isStandard, dishName) {
    const key = name.toLowerCase().trim();
    if (!combined[key]) combined[key] = { name, totalGrams: 0, standardGrams: 0, dishGrams: 0, dishes: [] };
    combined[key].totalGrams += amtGrams;
    if (isStandard) {
      combined[key].standardGrams += amtGrams;
    } else if (dishName) {
      combined[key].dishGrams += amtGrams;
      if (!combined[key].dishes.includes(dishName)) combined[key].dishes.push(dishName);
    }
  }

  // Add dish ingredients (if toggle is on)
  if (combinedIncludeDishes) {
    orderedDishes.forEach(dish => {
      calcIngredientsFromRecipe(dish).forEach(ing => {
        addToMap(ing.name, toBaseUnit(ing.amount, ing.unit), false, dish.name);
      });
    });
  }

  // Add standard inventory items — ingredients with targetStock for current location
  const curLoc = currentOrdersLoc || 'west';
  getStandardInventoryItems(curLoc).forEach(ing => {
    const target = ing.targetStock[curLoc] || 0;
    const currentStock = (ing.stock && ing.stock[curLoc]) ? (ing.stock[curLoc].amount || 0) : 0;
    const deficit = Math.max(0, target - currentStock);
    if (deficit <= 0) return;
    addToMap(ing.name, deficit, true, null);
  });

  if (!Object.keys(combined).length) {
    return `<div class="empty">No items to order. Add items to Standard Inventory or flag batches for ordering in the Week plan.</div>`;
  }

  const ingList = Object.values(combined).sort((a, b) => a.name.localeCompare(b.name)).map(ing => {
    const db = lookupIngredient(ing.name);
    return {
      ...ing,
      db,
      supplier: normalizeSupplier((db && db.supplier) || ''),
      orderCode: db ? db.orderCode : '',
      orderCalc: db ? calcOrderUnits(ing.totalGrams, db) : null,
    };
  });

  // Group by storage category (current building) instead of supplier
  const byStorage = {};
  ingList.forEach(ing => {
    const cat = getStorageCategory(ing.db, curLoc) || 'Unsorted';
    if (!byStorage[cat]) byStorage[cat] = [];
    byStorage[cat].push(ing);
  });
  const storageCatOrder = Object.keys(STORAGE_CATEGORIES);
  const storageOrder = [...storageCatOrder.filter(c => byStorage[c]), ...Object.keys(byStorage).filter(c => !storageCatOrder.includes(c))];

  // Calculate total value
  let totalValue = 0;
  ingList.forEach(ing => {
    if (!ing.db || !ing.db.orderPrice) return;
    const dbStock = getDbStockTotal(ing.db);
    const key = ing.name.toLowerCase().trim();
    const hasManual = combinedOrderStock[key] !== undefined;
    const effectiveStock = hasManual ? (parseFloat(combinedOrderStock[key]) || 0) : dbStock;
    const toOrderGrams = Math.max(0, ing.totalGrams - effectiveStock);
    const orderAmtGrams = (hasManual || dbStock > 0) ? toOrderGrams : ing.totalGrams;
    const calc = calcOrderUnits(orderAmtGrams, ing.db);
    if (calc && calc.units > 0) totalValue += calc.units * ing.db.orderPrice;
  });

  // Price alert banner
  const alertItems = ingList.filter(i => i.db && i.db.priceAlert);
  let html = `<div style="margin-bottom:20px;">`;

  if (alertItems.length) {
    html += `<div class="price-alert-banner">
      <strong>Price alerts:</strong> ${alertItems.map(i => esc(i.name)).join(', ')} had significant price increases.
    </div>`;
  }

  const hanosAllCombinedBtn = isHanosEnabled() && ingList.length ? `<button class="hanos-bulk-btn" onclick="hanosConfirmBulk()" title="Send entire combined order to Hanos cart">🛒 Send all to Hanos</button>` : '';
  html += `<div class="section-title" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
      <span>Combined Order &mdash; ${esc(curLoc === 'west' ? 'Sering West' : 'Sering Centraal')}</span>
      <div style="display:flex;align-items:center;gap:8px;">
        <span style="font-size:13px;font-weight:600;">${totalValue > 0 ? 'Estimated: \u20AC' + totalValue.toFixed(2) : ''}</span>
        ${hanosAllCombinedBtn}
      </div>
    </div>
    <div class="order-toggle-bar">
      <label class="order-toggle${combinedIncludeDishes ? ' on' : ''}" onclick="combinedIncludeDishes=!combinedIncludeDishes;renderOrders();">
        <span class="tbox${combinedIncludeDishes ? ' on' : ''}"><span class="tknob"></span></span>
        Include batch ingredients
      </label>
    </div>`;

  storageOrder.forEach(storageCat => {
    const items = byStorage[storageCat];
    const codesForCopy = items.filter(i => i.orderCode && !i.orderCode.startsWith('http')).map(i => i.orderCode);

    const catColor = getStorageColor(storageCat, curLoc);
    const hanosItems = isHanosEnabled() ? items.filter(i => i.orderCode && !i.orderCode.startsWith('http')) : [];
    const hanosBulkBtn = hanosItems.length ? `<button class="hanos-bulk-btn" onclick="hanosConfirmBulk('${esc(storageCat)}')" title="Add all items to Hanos cart">🛒 Send to Hanos</button>` : '';

    html += `<div class="storage-group" data-storage-cat="${esc(storageCat)}" style="margin-bottom:16px;border-left:4px solid ${catColor};padding-left:10px;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
        <span class="storage-group-dot" style="background:${catColor};"></span>
        <span style="font-weight:600;font-size:14px;">${esc(storageCat)}</span>
        <span style="font-size:12px;color:var(--text2);">(${items.length} item${items.length !== 1 ? 's' : ''})</span>
        ${codesForCopy.length ? `<button class="copy-all-btn" onclick="copyCombinedOrderCodes('${esc(storageCat)}')">Copy all codes</button>` : ''}
        ${hanosBulkBtn}
      </div>
      <div style="overflow-x:auto;"><table class="ing-table">
      <thead><tr>
        <th>Ingredient</th>
        <th>Category</th>
        <th>Storage</th>
        <th>Order code</th>
        <th>Unit / Price</th>
        <th style="cursor:pointer;" title="Click a row to see breakdown">Needed</th>
        <th>In stock</th>
        <th>To order</th>
      </tr></thead><tbody>`;

    items.forEach(ing => {
      const key = ing.name.toLowerCase().trim();
      const db = ing.db;
      const hasOrderUnit = db && db.orderUnitSize > 0;
      const orderUnitLabel = db && db.orderUnit ? esc(db.orderUnit) : '';
      const unitSuffix = hasOrderUnit ? (orderUnitLabel || 'units') : (() => { const f = formatAmount(0, db ? db.unit : 'g'); return f.unit; })();
      const isUrl = ing.orderCode && (ing.orderCode.startsWith('http') || ing.orderCode.startsWith('www'));

      let codeDisplay;
      if (!db) codeDisplay = '<span style="color:var(--red);font-size:10px;opacity:.7;">not in DB</span>';
      else if (!ing.orderCode) codeDisplay = '<span style="color:var(--text2);font-size:11px;">no code</span>';
      else if (isUrl) codeDisplay = `<a href="${esc(ing.orderCode.startsWith('http') ? ing.orderCode : 'https://'+ing.orderCode)}" target="_blank" rel="noopener" style="font-size:11px;color:var(--blue);">Order link \u2197</a>`;
      else codeDisplay = `<span class="order-code">${esc(ing.orderCode)}</span>`;

      const unitPrice = db ? (db.orderUnit ? esc(db.orderUnit) : '') + (db.orderPrice ? ' \u00B7 \u20AC' + Number(db.orderPrice).toFixed(2) : '') : '';

      // Needed in order units
      const neededCalc = hasOrderUnit ? calcOrderUnits(ing.totalGrams, db) : null;
      const neededDisplay = neededCalc
        ? `<span class="order-amt">${neededCalc.units}x</span> <span class="order-units">${unitSuffix}</span>`
        : (() => { const f = formatAmount(ing.totalGrams, db ? db.unit : 'g'); return `<span class="order-amt">${f.amount}</span> <span class="order-units">${f.unit}</span>`; })();

      // Breakdown (shown on click) — in order units when possible
      const parts = [];
      if (ing.standardGrams > 0) {
        const sc = hasOrderUnit ? calcOrderUnits(ing.standardGrams, db) : null;
        parts.push(sc
          ? `<span class="combined-part combined-standard">${sc.units}x ${unitSuffix} standard</span>`
          : (() => { const f = formatAmount(ing.standardGrams, db ? db.unit : 'g'); return `<span class="combined-part combined-standard">${f.amount}${f.unit} standard</span>`; })());
      }
      if (ing.dishGrams > 0) {
        const dc = hasOrderUnit ? calcOrderUnits(ing.dishGrams, db) : null;
        parts.push(dc
          ? `<span class="combined-part combined-dishes">${dc.units}x ${unitSuffix} ${esc(ing.dishes.join(', '))}</span>`
          : (() => { const f = formatAmount(ing.dishGrams, db ? db.unit : 'g'); return `<span class="combined-part combined-dishes">${f.amount}${f.unit} ${esc(ing.dishes.join(', '))}</span>`; })());
      }
      const breakdownHtml = parts.length ? `<div class="breakdown-detail" style="display:none;font-size:11px;margin-top:2px;">${parts.join(' + ')}</div>` : '';

      // Stock in order units
      const dbStock = getDbStockTotal(db);
      const hasManualStock = combinedOrderStock[key] !== undefined;
      const stockDisplayVal = hasManualStock ? combinedOrderStock[key] : (dbStock > 0 ? (hasOrderUnit ? Math.round(dbStock / db.orderUnitSize * 10) / 10 : dbStock) : '');
      const stockLabel = (!hasManualStock && dbStock > 0) ? ' <span style="font-size:9px;color:var(--blue);vertical-align:super;">DB</span>' : '';
      const stockInput = `<input class="order-stock-input" type="number" min="0" step="0.1" value="${stockDisplayVal}" placeholder="0" oninput="updateCombinedOrderStock('${esc(key)}',this.value)" /><span class="order-units" style="margin-left:2px;">${unitSuffix}</span>${stockLabel}`;

      // To order
      const effectiveStockBase = hasManualStock
        ? (hasOrderUnit ? (parseFloat(combinedOrderStock[key]) || 0) * db.orderUnitSize : (parseFloat(combinedOrderStock[key]) || 0))
        : dbStock;
      const hasStockValue = hasManualStock || dbStock > 0;
      const toOrderBase = Math.max(0, ing.totalGrams - effectiveStockBase);
      const toOrderCalc = hasOrderUnit ? calcOrderUnits(toOrderBase, db) : null;

      let toOrderDisplay;
      if (!hasStockValue) {
        toOrderDisplay = `<span style="color:var(--text2);font-size:11px;">enter stock \u2192</span>`;
      } else if (toOrderBase <= 0) {
        toOrderDisplay = '<span class="to-order-zero">\u2713 enough</span>';
      } else if (toOrderCalc) {
        const hanosBtn = (isHanosEnabled() && ing.orderCode && !isUrl && toOrderCalc.units > 0)
          ? ` <button class="hanos-btn" onclick="hanosAddSingle('${esc(ing.orderCode)}','${esc(ing.name)}')" title="Add to Hanos cart">🛒</button>`
          : '';
        toOrderDisplay = `<span class="to-order-positive">${toOrderCalc.units}x ${unitSuffix}</span>${hanosBtn}`;
      } else {
        const f = formatAmount(toOrderBase, db ? db.unit : 'g');
        toOrderDisplay = `<span class="to-order-positive">${f.amount} ${f.unit}</span>`;
      }

      // g/piece input for items without orderUnitSize
      const isStukNoWeight = db && db.orderCode && (!db.orderUnitSize || db.orderUnitSize <= 0);
      if (isStukNoWeight && ing.totalGrams > 0 && toOrderBase > 0) {
        toOrderDisplay += ` <input class="order-stock-input gpstuk-input" type="number" min="1" step="1" placeholder="g/piece" title="Fill in grams per piece to calculate order units" onchange="saveGramsPerPiece('${esc(db.id)}','${esc(key)}',this.value)" style="width:65px;" />`;
      }

      const priceAlertIcon = (db && db.priceAlert) ? ' <span style="color:var(--red);font-size:11px;" title="Price increased">\u25B2</span>' : '';

      html += `<tr data-combined-key="${esc(key)}" data-needed="${ing.totalGrams}" data-dbname="${esc(ing.name)}">
        <td style="font-weight:500;cursor:pointer;text-decoration:underline dotted;text-underline-offset:3px;" onclick="openIngredientModal('${esc(ing.name)}')">${esc(ing.name)}${priceAlertIcon}</td>
        <td style="font-size:12px;">${db && db.category ? esc(db.category) : '\u2014'}</td>
        <td>${renderStorageBadge(db)}</td>
        <td>${codeDisplay}</td>
        <td style="font-size:12px;">${unitPrice}</td>
        <td style="cursor:pointer;" onclick="this.querySelector('.breakdown-detail')&&(this.querySelector('.breakdown-detail').style.display=this.querySelector('.breakdown-detail').style.display==='none'?'block':'none')">
          ${neededDisplay}
          ${breakdownHtml}
        </td>
        <td>${stockInput}</td>
        <td class="to-order-cell">${toOrderDisplay}</td>
      </tr>`;
    });

    html += `</tbody></table></div></div>`;
  });

  html += `</div>`;
  return html;
}

// ── Copy helpers ──────────────────────────────────────────

function copyOrderCodes(supplier) {
  const items = [];
  S.batches.filter(d => d.orderFor).forEach(dish => {
    calcIngredientsFromRecipe(dish).forEach(ing => {
      const db = lookupIngredient(ing.name);
      if (db && db.orderCode && !db.orderCode.startsWith('http') && (db.supplier || '').toLowerCase().includes(supplier.toLowerCase())) {
        if (!items.includes(db.orderCode)) items.push(db.orderCode);
      }
    });
  });
  if (items.length) navigator.clipboard.writeText(items.join('\n')).then(() => toast(items.length + ' order codes copied'));
}

function copyDishOrderCodes(storageCat) {
  const curLoc = currentOrdersLoc || 'west';
  const items = new Set();
  S.batches.filter(d => d.orderFor).forEach(dish => {
    calcIngredientsFromRecipe(dish).forEach(ing => {
      const db = lookupIngredient(ing.name);
      if (db && db.orderCode && !db.orderCode.startsWith('http')) {
        const cat = getStorageCategory(db, curLoc) || 'Unsorted';
        if (cat === storageCat) items.add(db.orderCode);
      }
    });
  });
  const arr = [...items];
  if (arr.length) navigator.clipboard.writeText(arr.join('\n')).then(() => toast(arr.length + ' order codes copied'));
}

function copySiOrderCodes(storageCat) {
  const curLoc = currentOrdersLoc || 'west';
  const items = new Set();
  getStandardInventoryItems(curLoc).forEach(ing => {
    if (ing.orderCode && !ing.orderCode.startsWith('http')) {
      const cat = getStorageCategory(ing, curLoc) || 'Unsorted';
      if (cat === storageCat) items.add(ing.orderCode);
    }
  });
  const arr = [...items];
  if (arr.length) navigator.clipboard.writeText(arr.join('\n')).then(() => toast(arr.length + ' order codes copied'));
}

function copyCombinedOrderCodes(supplier) {
  const items = new Set();
  S.batches.filter(d => d.orderFor).forEach(dish => {
    calcIngredientsFromRecipe(dish).forEach(ing => {
      const db = lookupIngredient(ing.name);
      if (db && db.orderCode && !db.orderCode.startsWith('http') && normalizeSupplier(db.supplier || '').toLowerCase().includes(supplier.toLowerCase())) {
        items.add(db.orderCode);
      }
    });
  });
  getStandardInventoryItems(currentOrdersLoc || 'west').forEach(ing => {
    if (ing.orderCode && !ing.orderCode.startsWith('http') && normalizeSupplier(ing.supplier || '').toLowerCase().includes(supplier.toLowerCase())) {
      items.add(ing.orderCode);
    }
  });
  const arr = [...items];
  if (arr.length) navigator.clipboard.writeText(arr.join('\n')).then(() => toast(arr.length + ' order codes copied'));
}

// ── Hanos integration ────────────────────────────────────

async function checkHanosStatus() {
  if (hanosStatusChecked) return;
  hanosStatusChecked = true;
  try {
    const prev = hanosStatus.configured;
    hanosStatus = await apiGet('/api/hanos/status');
    // Re-render if status changed (first load with credentials configured)
    if (!prev && hanosStatus.configured) renderOrders();
  } catch (e) {
    console.error('Hanos status check failed:', e);
    hanosStatus = { configured: false, west: false, centraal: false };
  }
}

function isHanosEnabled() {
  const loc = currentOrdersLoc || 'west';
  return hanosStatus[loc] || false;
}

/** Collect all Hanos items from the combined order table that need ordering */
function collectHanosItems(storageCat) {
  const rows = document.querySelectorAll('.ing-table tr[data-combined-key]');
  const items = [];
  rows.forEach(row => {
    // If filtering by storage category, check the group
    if (storageCat) {
      const group = row.closest('.storage-group');
      if (!group || !group.dataset.storageCat || group.dataset.storageCat !== storageCat) return;
    }
    const key = row.dataset.combinedKey;
    const dbName = row.dataset.dbname;
    const db = dbName ? lookupIngredient(dbName) : null;
    if (!db || !db.orderCode || db.orderCode.startsWith('http')) return;

    // Calculate order units for this row — stock values are in order units, convert to base
    const neededBase = parseFloat(row.dataset.needed) || 0;
    const dbStock = getDbStockTotal(db);
    const hasManual = combinedOrderStock[key] !== undefined;
    const effectiveStockBase = hasManual
      ? (db.orderUnitSize > 0 ? (parseFloat(combinedOrderStock[key]) || 0) * db.orderUnitSize : (parseFloat(combinedOrderStock[key]) || 0))
      : dbStock;
    const hasStockValue = hasManual || dbStock > 0;
    const toOrderBase = hasStockValue ? Math.max(0, neededBase - effectiveStockBase) : neededBase;
    const calc = calcOrderUnits(toOrderBase, db);
    if (!calc || calc.units <= 0) return;

    items.push({
      name: db.name,
      orderCode: db.orderCode,
      quantity: calc.units,
      unit: 'ST',
      unitLabel: db.orderUnit || '',
      price: db.orderPrice || 0,
    });
  });
  return items;
}

/** Send a single item to Hanos cart */
async function hanosAddSingle(orderCode, name) {
  const db = lookupIngredient(name);
  if (!db) return;

  // Calculate quantity from the DOM row — stock is in order units, convert to base
  const key = name.toLowerCase().trim();
  const row = document.querySelector(`[data-combined-key="${key}"]`) || document.querySelector(`[data-stock-key="${key}"]`);
  let quantity = 1;
  if (row) {
    const neededBase = parseFloat(row.dataset.needed) || 0;
    const dbStock = getDbStockTotal(db);
    const stockObj = row.dataset.combinedKey ? combinedOrderStock : orderInventory;
    const hasManual = stockObj[key] !== undefined;
    const effectiveStockBase = hasManual
      ? (db.orderUnitSize > 0 ? (parseFloat(stockObj[key]) || 0) * db.orderUnitSize : (parseFloat(stockObj[key]) || 0))
      : dbStock;
    const hasStockValue = hasManual || dbStock > 0;
    const toOrderBase = hasStockValue ? Math.max(0, neededBase - effectiveStockBase) : neededBase;
    const calc = calcOrderUnits(toOrderBase, db);
    if (calc && calc.units > 0) quantity = calc.units;
  }

  toast(`Adding ${name} to Hanos cart...`);
  try {
    const resp = await apiPost('/api/hanos/add-to-cart', { items: [{ orderCode, quantity, unit: 'ST' }], location: currentOrdersLoc || 'west' });
    if (resp.ok > 0) {
      toast(`Added ${quantity}x ${name} to Hanos cart`);
    } else {
      const err = resp.results && resp.results[0] ? resp.results[0].error : 'Unknown error';
      toast(`Failed: ${err}`, true);
    }
  } catch (e) {
    toast('Hanos error: ' + e.message, true);
  }
}

/** Show confirmation modal for bulk Hanos add (combined order) */
function hanosConfirmBulk(storageCat) {
  const items = collectHanosItems(storageCat);
  if (!items.length) {
    toast('No items with order codes and quantities to send');
    return;
  }
  showHanosConfirmModal(items, storageCat, 'combined');
}

/** Collect Hanos items from batch ingredients tab */
function collectHanosBatchItems(storageCat) {
  const rows = document.querySelectorAll('.ing-table tr[data-stock-key]');
  const items = [];
  rows.forEach(row => {
    if (storageCat) {
      const group = row.closest('.storage-group');
      if (!group || !group.dataset.storageCat || group.dataset.storageCat !== storageCat) return;
    }
    const key = row.dataset.stockKey;
    const db = key ? lookupIngredient(key) : null;
    if (!db || !db.orderCode || db.orderCode.startsWith('http')) return;

    const neededBase = parseFloat(row.dataset.needed) || 0;
    const dbStock = getDbStockTotal(db);
    const hasManual = orderInventory[key] !== undefined;
    const effectiveStockBase = hasManual
      ? (db.orderUnitSize > 0 ? (parseFloat(orderInventory[key]) || 0) * db.orderUnitSize : (parseFloat(orderInventory[key]) || 0))
      : dbStock;
    const hasStockValue = hasManual || dbStock > 0;
    const toOrderBase = hasStockValue ? Math.max(0, neededBase - effectiveStockBase) : neededBase;
    const calc = calcOrderUnits(toOrderBase, db);
    if (!calc || calc.units <= 0) return;

    items.push({
      name: db.name,
      orderCode: db.orderCode,
      quantity: calc.units,
      unit: 'ST',
      unitLabel: db.orderUnit || '',
      price: db.orderPrice || 0,
    });
  });
  return items;
}

/** Show confirmation modal for batch ingredients Hanos add */
function hanosConfirmBulkBatches(storageCat) {
  const items = collectHanosBatchItems(storageCat);
  if (!items.length) {
    toast('No items with order codes and quantities to send');
    return;
  }
  showHanosConfirmModal(items, storageCat, 'batches');
}

/** Shared confirmation modal with €200 warning */
function showHanosConfirmModal(items, storageCat, source) {
  // Check for items over €200
  const expensiveItems = items.filter(i => i.price && i.quantity * i.price > 200);

  let warningHtml = '';
  if (expensiveItems.length) {
    warningHtml = `<div style="background:var(--red-bg, #fde8e8);border:1px solid var(--red);border-radius:var(--radius);padding:10px 14px;margin-bottom:12px;">
      <strong style="color:var(--red);">High-value items (over \u20AC200):</strong>
      <ul style="margin:6px 0 0;padding-left:18px;font-size:12px;">
        ${expensiveItems.map(i => `<li><strong>${esc(i.name)}</strong>: ${i.quantity}x \u00D7 \u20AC${i.price.toFixed(2)} = <strong>\u20AC${(i.quantity * i.price).toFixed(2)}</strong></li>`).join('')}
      </ul>
    </div>`;
  }

  const listHtml = items.map(i => {
    const total = i.price ? i.quantity * i.price : 0;
    const isExpensive = total > 200;
    return `<tr${isExpensive ? ' style="background:var(--red-bg, #fde8e8);"' : ''}>
      <td style="font-weight:500;">${esc(i.name)}</td>
      <td style="font-family:monospace;font-size:12px;">${esc(i.orderCode)}</td>
      <td style="text-align:right;font-weight:600;">${i.quantity}x</td>
      <td style="font-size:12px;color:var(--text2);">${esc(i.unitLabel)}</td>
      <td style="text-align:right;font-size:12px;${isExpensive ? 'color:var(--red);font-weight:600;' : ''}">${total > 0 ? '\u20AC' + total.toFixed(2) : ''}</td>
    </tr>`;
  }).join('');

  const label = storageCat ? esc(storageCat) : 'all groups';
  const totalCost = items.reduce((sum, i) => sum + (i.price ? i.quantity * i.price : 0), 0);

  showModal(`
    <h3 style="margin-bottom:12px;">Add to Hanos Cart</h3>
    <p style="font-size:13px;margin-bottom:12px;">Send <strong>${items.length} item(s)</strong> from ${label} to the Hanos cart:</p>
    ${warningHtml}
    <div style="max-height:300px;overflow-y:auto;margin-bottom:12px;">
      <table class="ing-table" style="font-size:12px;">
        <thead><tr><th>Item</th><th>Code</th><th>Qty</th><th>Unit</th><th>Est. cost</th></tr></thead>
        <tbody>${listHtml}</tbody>
      </table>
    </div>
    ${totalCost > 0 ? `<p style="font-size:13px;font-weight:600;margin-bottom:12px;">Total estimated: \u20AC${totalCost.toFixed(2)}</p>` : ''}
    <div style="display:flex;gap:8px;justify-content:flex-end;">
      <button class="btn btn-sm" onclick="closeModal()">Cancel</button>
      <button class="btn btn-sm" style="background:var(--blue);color:#fff;border-color:var(--blue);" onclick="hanosExecuteFromModal('${esc(source)}','${esc(storageCat || '')}')">
        ${expensiveItems.length ? 'Confirm & Send' : 'Send to Hanos'}
      </button>
    </div>
  `);
}

/** Execute from the shared modal */
async function hanosExecuteFromModal(source, storageCat) {
  const items = source === 'batches'
    ? collectHanosBatchItems(storageCat || null)
    : collectHanosItems(storageCat || null);
  if (!items.length) { closeModal(); return; }

  const modalBody = document.querySelector('.modal');
  if (modalBody) {
    modalBody.innerHTML = `
      <h3 style="margin-bottom:12px;">Sending to Hanos...</h3>
      <p style="font-size:13px;">Adding ${items.length} item(s) to cart. Please wait...</p>
      <div style="margin-top:16px;height:4px;background:var(--border);border-radius:2px;overflow:hidden;">
        <div style="height:100%;background:var(--blue);width:0%;transition:width .3s;" id="hanos-progress"></div>
      </div>
    `;
  }

  try {
    const resp = await apiPost('/api/hanos/add-to-cart', {
      items: items.map(i => ({ orderCode: i.orderCode, quantity: i.quantity, unit: i.unit })),
      location: currentOrdersLoc || 'west',
    });

    const progEl = document.getElementById('hanos-progress');
    if (progEl) progEl.style.width = '100%';

    setTimeout(() => {
      closeModal();
      if (resp.failed === 0) {
        toast(`All ${resp.ok} items added to Hanos cart`);
      } else {
        toast(`${resp.ok} added, ${resp.failed} failed`, true);
        console.warn('Hanos bulk results:', resp.results);
      }
    }, 400);
  } catch (e) {
    closeModal();
    toast('Hanos error: ' + e.message, true);
  }
}

// ── Grams-per-piece for stuk items ──────────────────────

async function saveGramsPerPiece(ingredientId, combinedKey, value) {
  const grams = parseInt(value, 10);
  if (!grams || grams <= 0) return;

  const db = S.ingredientDb.find(i => i.id === ingredientId);
  if (!db) return;

  // Update locally
  db.orderUnitSize = grams;

  // Save to server
  try {
    await apiPost(`/api/ingredients/${ingredientId}`, { ...db, orderUnitSize: grams });
    toast(`Saved ${grams}g per piece for ${db.name}`);
    renderOrders();
  } catch (e) {
    toast('Failed to save: ' + e.message, true);
  }
}

// ── Existing helpers ──────────────────────────────────────

function toggleOrderSection(key) { S.orderToggles[key] = !S.orderToggles[key]; renderOrders(); }

// Persist stock to the ingredient DB so it survives reloads and syncs across tabs
let _stockSaveTimeout = null;
function persistIngredientStock(ingredientName, amount) {
  const db = lookupIngredient(ingredientName);
  if (!db || !db.id) return;
  const loc = S.currentLoc || 'west';
  const amountNum = parseFloat(amount) || 0;

  // Update in S.ingredientDb immediately
  if (!db.stock) db.stock = {};
  db.stock[loc] = { amount: amountNum, date: new Date().toISOString().slice(0, 10) };

  // Update in ingredientDbFull too (if loaded)
  if (typeof ingredientDbFull !== 'undefined') {
    const full = ingredientDbFull.find(i => i.id === db.id);
    if (full) {
      if (!full.stock) full.stock = {};
      full.stock[loc] = { amount: amountNum, date: new Date().toISOString().slice(0, 10) };
    }
  }

  // Debounced save to backend
  clearTimeout(_stockSaveTimeout);
  _stockSaveTimeout = setTimeout(() => {
    fetch('/api/ingredients/stock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ingredientId: db.id, location: loc, amount: amountNum }),
    }).catch(e => console.error('Stock save failed:', e));
  }, 600);
}

// Shared inline stock update — input is in order units, convert to base for storage
function _updateStockInline(storageObj, key, val, rowSelector, neededAttr) {
  if (val === '' || val === null) {
    delete storageObj[key];
  } else {
    storageObj[key] = parseFloat(val) || 0;
  }

  const db = lookupIngredient(key);
  // Persist to DB in base units
  if (db) {
    const baseAmount = (db.orderUnitSize > 0) ? (parseFloat(val) || 0) * db.orderUnitSize : (parseFloat(val) || 0);
    persistIngredientStock(db.name, baseAmount);
  }

  const row = document.querySelector(rowSelector);
  if (!row) return;
  const neededBase = parseFloat(row.dataset[neededAttr]) || 0;
  const stockUnits = parseFloat(val) || 0;
  const stockBase = (db && db.orderUnitSize > 0) ? stockUnits * db.orderUnitSize : stockUnits;
  const toOrderBase = Math.max(0, neededBase - stockBase);
  const hasOrderUnit = db && db.orderUnitSize > 0;
  const orderUnitLabel = db && db.orderUnit ? db.orderUnit : '';
  const unitSuffix = hasOrderUnit ? (orderUnitLabel || 'units') : (() => { const f = formatAmount(0, db ? db.unit : 'g'); return f.unit; })();

  const toOrderEl = row.querySelector('.to-order-cell');
  if (toOrderEl) {
    if (val === '' || val === null || val === undefined) {
      toOrderEl.innerHTML = '<span style="color:var(--text2);font-size:11px;">enter stock \u2192</span>';
    } else if (toOrderBase <= 0) {
      toOrderEl.innerHTML = '<span class="to-order-zero">\u2713 enough</span>';
    } else {
      const calc = hasOrderUnit ? calcOrderUnits(toOrderBase, db) : null;
      if (calc) {
        toOrderEl.innerHTML = `<span class="to-order-positive">${calc.units}x ${esc(unitSuffix)}</span>`;
      } else {
        const f = formatAmount(toOrderBase, db ? db.unit : 'g');
        toOrderEl.innerHTML = `<span class="to-order-positive">${f.amount} ${esc(f.unit)}</span>`;
      }
    }
  }
}

function updateCombinedOrderStock(key, val) {
  _updateStockInline(combinedOrderStock, key, val, `[data-combined-key="${key}"]`, 'needed');
}

function updateOrderStock(key, val) {
  _updateStockInline(orderInventory, key, val, `[data-stock-key="${key}"]`, 'needed');
}

async function refreshAllRecipes() {
  const dishes = S.batches.filter(d => d.orderFor && d.recipeSheetId);
  if (!dishes.length) { toast('No batches with recipe sheets to refresh'); return; }
  toast('Refreshing ' + dishes.length + ' recipe(s)...');
  let ok = 0;
  for (const d of dishes) {
    try {
      const recipe = await apiGet(`/api/recipe?sheetId=${d.recipeSheetId}`);
      if (recipe.allergens) d.allergens = recipe.allergens;
      if (recipe.recipeVolume) d.recipeVolume = recipe.recipeVolume;
      if (recipe.serving) d.serving = recipe.serving;
      if (recipe.ingredients) d.recipeIngredients = recipe.ingredients;
      ok++;
    } catch (e) { console.error('Failed to refresh ' + d.name, e); }
  }
  scheduleSave();
  renderOrders();
  toast(ok + ' recipe(s) refreshed');
}

