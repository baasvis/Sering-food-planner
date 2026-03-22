// ── ORDER OVERVIEW ────────────────────────────────────────

// State
let orderInventory = {};        // in-stock amounts for dish ingredients (keyed by name lowercase)
let combinedOrderStock = {};   // in-stock amounts for combined order tab (grams, keyed by name lowercase)
let standardInventory = { west: [], centraal: [] };  // per-location weekly base order
let siLoaded = false;
let siLoadCalled = false;
let siSaveTimeout = null;
let currentOrdersTab = 'combined'; // 'combined' | 'standard' | 'dishes' | 'ingredientDb'
let currentOrdersLoc = '';  // set on first render from S.currentLoc
let siSearchQuery = '';

// ── Shared helpers ────────────────────────────────────────

function toGrams(amount, unit) {
  const u = (unit || '').toLowerCase().replace(/'/g, '');
  if (u === 'kilos' || u === 'kilo' || u === 'kg') return amount * 1000;
  if (u === 'liters' || u === 'liter' || u === 'litres' || u === 'l') return amount * 1000;
  return amount;
}

function normalizeSupplier(s) {
  if (!s) return 'Unknown';
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function formatGrams(g) {
  if (g >= 1000) {
    const kg = Math.round(g / 100) / 10;
    return { amount: kg % 1 === 0 ? kg : kg, unit: 'kg' };
  }
  return { amount: Math.round(g), unit: 'g' };
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

function calcOrderUnits(amountGrams, dbEntry) {
  if (!dbEntry || !dbEntry.orderAmount || dbEntry.orderAmount <= 0) return null;
  const unitGrams = dbEntry.unitRecalc || dbEntry.orderAmount;
  const units = Math.ceil(amountGrams / unitGrams);
  return { units, perUnit: dbEntry.orderAmount, unitType: dbEntry.actualUnit || dbEntry.unit || 'g' };
}

// ── Standard Inventory API ────────────────────────────────

async function loadStandardInventory() {
  try {
    const [west, centraal] = await Promise.all([
      apiGet('/api/standard-inventory?location=west'),
      apiGet('/api/standard-inventory?location=centraal'),
    ]);
    standardInventory.west = Array.isArray(west) ? west : [];
    standardInventory.centraal = Array.isArray(centraal) ? centraal : [];
  } catch (e) {
    standardInventory = { west: [], centraal: [] };
  }
  siLoaded = true;
}

async function saveStandardInventory(loc) {
  loc = loc || currentOrdersLoc || 'west';
  try {
    await apiPost('/api/standard-inventory', { location: loc, items: standardInventory[loc] || [] });
  } catch (e) {
    toastError('Failed to save standard inventory');
  }
}

function debouncedSaveSI() {
  clearTimeout(siSaveTimeout);
  const loc = currentOrdersLoc || 'west';
  siSaveTimeout = setTimeout(() => saveStandardInventory(loc), 800);
}

// ── Standard Inventory actions ────────────────────────────

function updateSiSearch(val) {
  siSearchQuery = val;
  // re-render only the suggestions part to avoid losing input focus
  const sugContainer = document.getElementById('si-suggestions');
  if (!sugContainer) return;
  const query = val.toLowerCase().trim();
  const loc = currentOrdersLoc || 'west';
  const addedNames = new Set((standardInventory[loc] || []).map(i => i.name.toLowerCase().trim()));
  const suggestions = query.length >= 2
    ? S.ingredientDb.filter(i => i.name.toLowerCase().includes(query) || (i.orderCode && i.orderCode.toLowerCase().includes(query))).slice(0, 8)
    : [];
  let html = suggestions.map(ing => {
    const isAdded = addedNames.has(ing.name.toLowerCase().trim());
    const nameAttr = esc(ing.name);
    const unitAttr = esc(ing.unit || 'g');
    return `<div class="si-suggestion${isAdded ? ' si-suggestion-added' : ''}" ${!isAdded ? `onclick="addToStandardInventory('${nameAttr}', '${unitAttr}')"` : ''}>
      <span class="si-sug-name">${esc(ing.name)}</span>
      <span class="si-sug-meta">${ing.source ? esc(ing.source) + ' · ' : ''}${ing.orderCode ? esc(ing.orderCode) + ' · ' : ''}${ing.unit || 'g'}</span>
      ${isAdded ? '<span style="color:var(--green);font-size:11px;font-weight:600;">✓ added</span>' : ''}
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

function addToStandardInventory(name, unit) {
  const loc = currentOrdersLoc || 'west';
  const list = standardInventory[loc] || [];
  const exists = list.find(i => i.name.toLowerCase().trim() === name.toLowerCase().trim());
  if (exists) return;
  list.push({ id: newId(), name, amount: 0, unit: unit || 'g' });
  standardInventory[loc] = list;
  siSearchQuery = '';
  saveStandardInventory(loc);
  renderOrders();
}

function removeSiItem(idx) {
  const loc = currentOrdersLoc || 'west';
  const list = standardInventory[loc] || [];
  list.splice(idx, 1);
  standardInventory[loc] = list;
  saveStandardInventory(loc);
  renderOrders();
}

function updateSiAmount(idx, val) {
  const loc = currentOrdersLoc || 'west';
  const list = standardInventory[loc] || [];
  if (list[idx]) {
    list[idx].amount = parseFloat(val) || 0;
    debouncedSaveSI();
  }
}

function updateSiUnit(idx, val) {
  const loc = currentOrdersLoc || 'west';
  const list = standardInventory[loc] || [];
  if (list[idx]) {
    list[idx].unit = val;
    debouncedSaveSI();
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
  if (!siLoaded) {
    if (!siLoadCalled) {
      siLoadCalled = true;
      loadStandardInventory().then(renderOrders);
    }
    document.getElementById('screen-orders').innerHTML = '<div class="empty">Loading...</div>';
    return;
  }

  if (!currentOrdersLoc) currentOrdersLoc = S.currentLoc || 'west';
  rebuildStorageCategories(currentOrdersLoc);

  const locBar = `<div class="order-loc-bar">
    <button class="order-loc-btn${currentOrdersLoc === 'west' ? ' active' : ''}" onclick="switchOrdersLoc('west')">Sering West</button>
    <button class="order-loc-btn${currentOrdersLoc === 'centraal' ? ' active' : ''}" onclick="switchOrdersLoc('centraal')">Sering Centraal</button>
  </div>`;

  const tabBar = `<div class="order-tab-bar">
    <button class="order-tab-btn${currentOrdersTab === 'combined' ? ' active' : ''}" onclick="switchOrdersTab('combined')">🛒 Combined Order</button>
    <button class="order-tab-btn${currentOrdersTab === 'standard' ? ' active' : ''}" onclick="switchOrdersTab('standard')">📦 Standard Inventory</button>
    <button class="order-tab-btn${currentOrdersTab === 'dishes' ? ' active' : ''}" onclick="switchOrdersTab('dishes')">🍽️ Dish Ingredients</button>
    <button class="order-tab-btn${currentOrdersTab === 'ingredientDb' ? ' active' : ''}" onclick="switchOrdersTab('ingredientDb')">🗄️ Ingredient Database</button>
  </div>`;

  let content;
  if (currentOrdersTab === 'standard') content = renderStandardInventoryTab();
  else if (currentOrdersTab === 'dishes') content = renderDishesTab();
  else if (currentOrdersTab === 'ingredientDb') content = renderIngredientDbTab();
  else content = renderCombinedOrderTab();

  document.getElementById('screen-orders').innerHTML = locBar + tabBar + content;
}

// ── Standard Inventory tab ────────────────────────────────

function renderStandardInventoryTab() {
  const curLoc = currentOrdersLoc || 'west';
  const siItems = standardInventory[curLoc] || [];

  // Build enriched list (same approach as combined/dishes tabs)
  const ingList = siItems.map((item, idx) => {
    const db = lookupIngredient(item.name);
    const amtGrams = toGrams(item.amount, item.unit || 'g');
    return {
      ...item,
      idx,
      db,
      amountInGrams: amtGrams,
      supplier: normalizeSupplier((db && db.source) || ''),
      orderCode: db ? db.orderCode : '',
      orderCalc: db ? calcOrderUnits(amtGrams, db) : null,
    };
  });

  // Calculate total value using calcOrderUnits (consistent with combined tab)
  let totalValue = 0;
  ingList.forEach(ing => {
    if (ing.db && ing.db.orderPrice && ing.orderCalc && ing.orderCalc.units > 0) {
      totalValue += ing.orderCalc.units * ing.db.orderPrice;
    }
  });

  // Group by storage category (same as combined tab)
  const byStorage = {};
  ingList.forEach(ing => {
    const cat = getStorageCategory(ing.db, curLoc) || 'Unsorted';
    if (!byStorage[cat]) byStorage[cat] = [];
    byStorage[cat].push(ing);
  });
  const storageCatOrder = Object.keys(STORAGE_CATEGORIES);
  const storageOrder = [...storageCatOrder.filter(c => byStorage[c]), ...Object.keys(byStorage).filter(c => !storageCatOrder.includes(c))];

  let itemsHtml = '';
  if (siItems.length === 0) {
    itemsHtml = '<div class="empty">No items yet. Search above to add ingredients from the database.</div>';
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
          <th>Category</th>
          <th>Storage</th>
          <th>Order code</th>
          <th>Unit / Price</th>
          <th>Amount / week</th>
          <th>Order units</th>
          <th></th>
        </tr></thead><tbody>`;

      items.forEach(ing => {
        const db = ing.db;
        const dbUnit = db && db.unit ? esc(db.unit) : (ing.unit ? esc(ing.unit) : 'g');
        const isUrl = ing.orderCode && (ing.orderCode.startsWith('http') || ing.orderCode.startsWith('www'));
        let codeDisplay;
        if (!db) codeDisplay = '<span style="color:var(--red);font-size:10px;opacity:.7;">not in DB</span>';
        else if (!ing.orderCode) codeDisplay = '<span style="color:var(--text2);font-size:11px;">\u2014</span>';
        else if (isUrl) codeDisplay = `<a href="${esc(ing.orderCode.startsWith('http') ? ing.orderCode : 'https://'+ing.orderCode)}" target="_blank" rel="noopener" style="font-size:11px;color:var(--blue);">Order link \u2197</a>`;
        else codeDisplay = `<span class="order-code">${esc(ing.orderCode)}</span>`;
        const unitPrice = db ? (db.orderUnit ? esc(db.orderUnit) : dbUnit) + (db.orderPrice ? ' \u00B7 \u20AC' + Number(db.orderPrice).toFixed(2) : '') : dbUnit;

        const orderUnits = ing.orderCalc && ing.orderCalc.units > 0
          ? `<span class="order-amt">${ing.orderCalc.units}x</span> <span class="order-units">(${ing.orderCalc.perUnit} ${esc(ing.orderCalc.unitType)})</span>`
          : (ing.amount > 0 ? '<span style="color:var(--text2);font-size:11px;">\u2014</span>' : '');

        itemsHtml += `<tr>
          <td style="font-weight:500;cursor:pointer;text-decoration:underline dotted;text-underline-offset:3px;" onclick="openIngredientModal('${esc(ing.name)}')">${esc(ing.name)}</td>
          <td style="font-size:12px;">${db && db.category ? esc(db.category) : '\u2014'}</td>
          <td>${renderStorageBadge(db)}</td>
          <td>${codeDisplay}</td>
          <td style="font-size:12px;">${unitPrice}</td>
          <td><input class="order-stock-input" type="number" min="0" step="any" value="${ing.amount > 0 ? ing.amount : ''}" placeholder="0" oninput="updateSiAmount(${ing.idx}, this.value)" /></td>
          <td>${orderUnits}</td>
          <td><button class="btn btn-danger btn-sm" onclick="removeSiItem(${ing.idx})">Remove</button></td>
        </tr>`;
      });

      itemsHtml += `</tbody></table></div></div>`;
    });
  }

  return `
    <div>
      <div class="section-title" style="display:flex;justify-content:space-between;align-items:center;">
        <span>Standard Inventory &mdash; ${esc(curLoc === 'west' ? 'Sering West' : 'Sering Centraal')}</span>
        ${totalValue > 0 ? `<span style="font-size:13px;font-weight:600;">Estimated: \u20AC${totalValue.toFixed(2)}</span>` : ''}
      </div>
      <p style="font-size:13px;color:var(--text2);margin-bottom:14px;">These items are ordered every week. Adjust amounts as needed before generating the combined order.</p>
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
  const orderedDishes = S.dishes.filter(d => d.orderFor);
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
    const amtInGrams = toGrams(ing.amount, ing.unit);
    return {
      ...ing,
      db,
      amountInGrams: amtInGrams,
      supplier: normalizeSupplier((db && db.source) || ing.source || ''),
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
  let html = `<div style="margin-bottom:20px;">
    <div class="section-title" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
      <span>Ingredient order (${orderedDishes.length} dish${orderedDishes.length !== 1 ? 'es' : ''} flagged)</span>
      <div style="display:flex;align-items:center;gap:8px;">
        <span style="font-weight:400;font-size:12px;color:var(--text2);">${orderedDishes.map(d => esc(d.name)).join(' · ')}</span>
        ${dishesWithSheets.length ? `<button class="copy-all-btn" onclick="refreshAllRecipes()">↻ Refresh recipe data</button>` : ''}
      </div>
    </div>`;

  if (!ingList.length) {
    if (orderedDishes.length === 0) {
      html += `<div class="empty">No dishes flagged for order. In the Week plan, toggle the order flag on dishes you want to include.</div>`;
    } else {
      html += `<div class="empty">Dishes are flagged but have no recipe data. Make sure they have a linked recipe sheet with ingredients.</div>`;
    }
  } else {
    storageOrder.forEach(storageCat => {
      const items = byStorage[storageCat];
      const codesForCopy = items.filter(i => i.orderCode && !i.orderCode.startsWith('http')).map(i => i.orderCode);
      const catColor = getStorageColor(storageCat, curLoc);
      html += `<div class="storage-group" style="margin-bottom:16px;border-left:4px solid ${catColor};padding-left:10px;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
          <span class="storage-group-dot" style="background:${catColor};"></span>
          <span style="font-weight:600;font-size:14px;">${esc(storageCat)}</span>
          <span style="font-size:12px;color:var(--text2);">(${items.length} item${items.length !== 1 ? 's' : ''})</span>
          ${codesForCopy.length ? `<button class="copy-all-btn" onclick="copyDishOrderCodes('${esc(storageCat)}')">Copy all codes</button>` : ''}
        </div>
        <div style="overflow-x:auto;"><table class="ing-table">
        <thead><tr>
          <th>Ingredient</th><th>Category</th><th>Storage</th><th>Order code</th>
          <th>Amount needed</th><th>In stock</th><th>To order</th><th>Order units</th><th>For dishes</th>
        </tr></thead><tbody>`;

      items.forEach(ing => {
        const key = ing.name.toLowerCase().trim();
        const isUrl = ing.orderCode && (ing.orderCode.startsWith('http') || ing.orderCode.startsWith('www'));
        const dbUnit = ing.unit || (ing.db && ing.db.unit) || 'g';
        const amtNeeded = Math.round(ing.amount);

        let codeDisplay;
        if (!ing.db) codeDisplay = '<span style="color:var(--red);font-size:10px;opacity:.7;">not in DB</span>';
        else if (!ing.orderCode) codeDisplay = '<span style="color:var(--text2);font-size:11px;">no code</span>';
        else if (isUrl) codeDisplay = `<a href="${esc(ing.orderCode.startsWith('http') ? ing.orderCode : 'https://'+ing.orderCode)}" target="_blank" rel="noopener" style="font-size:11px;color:var(--blue);">Order link \u2197</a>`;
        else codeDisplay = `<span class="order-code" title="Click to select">${esc(ing.orderCode)}</span>`;

        const dbStock = getDbStockTotal(ing.db);
        const hasManualStock = orderInventory[key] !== undefined;
        const stockVal = hasManualStock ? orderInventory[key] : (dbStock > 0 ? dbStock : '');
        const stockLabel = (!hasManualStock && dbStock > 0) ? ' <span style="font-size:9px;color:var(--blue);vertical-align:super;">DB</span>' : '';
        const stockInput = `<input class="order-stock-input" type="number" min="0" step="1" value="${stockVal}" placeholder="0" oninput="updateOrderStock('${esc(key)}',this.value)" />${stockLabel}`;

        const effectiveStock = hasManualStock ? (parseFloat(orderInventory[key]) || 0) : dbStock;
        const hasStockValue = hasManualStock || dbStock > 0;
        const toOrder = Math.max(0, amtNeeded - effectiveStock);
        const toOrderDisplay = hasStockValue
          ? (toOrder > 0
            ? `<span class="to-order-positive">${toOrder.toLocaleString()} ${esc(dbUnit)}</span>`
            : `<span class="to-order-zero">\u2713 enough</span>`)
          : `<span style="color:var(--text2);font-size:11px;">enter stock \u2192</span>`;

        const orderAmt = hasStockValue ? toOrder : amtNeeded;
        const orderAmtGrams = toGrams(orderAmt, dbUnit);
        const orderCalc = ing.db ? calcOrderUnits(orderAmtGrams, ing.db) : null;
        const orderUnits = orderCalc && orderCalc.units > 0
          ? `<span class="order-amt">${orderCalc.units}x</span> <span class="order-units">(${orderCalc.perUnit} ${esc(orderCalc.unitType)})</span>`
          : (orderAmt === 0 ? '<span class="to-order-zero">\u2014</span>' : '<span style="color:var(--text2);font-size:11px;">\u2014</span>');

        html += `<tr data-stock-key="${esc(key)}" data-needed="${amtNeeded}" data-unit="${esc(dbUnit)}">
          <td style="font-weight:500;cursor:pointer;text-decoration:underline dotted;text-underline-offset:3px;" onclick="openIngredientModal('${esc(ing.name)}')">${esc(ing.name)}</td>
          <td style="font-size:12px;">${ing.db && ing.db.category ? esc(ing.db.category) : '\u2014'}</td>
          <td>${renderStorageBadge(ing.db)}</td>
          <td>${codeDisplay}</td>
          <td><span class="order-amt">${amtNeeded.toLocaleString()}</span> <span class="order-units">${esc(dbUnit)}</span></td>
          <td>${stockInput}</td>
          <td class="to-order-cell">${toOrderDisplay}</td>
          <td>${orderUnits}</td>
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
  const orderedDishes = S.dishes.filter(d => d.orderFor);

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

  // Add dish ingredients
  orderedDishes.forEach(dish => {
    calcIngredientsFromRecipe(dish).forEach(ing => {
      addToMap(ing.name, toGrams(ing.amount, ing.unit), false, dish.name);
    });
  });

  // Add standard inventory for current location — try to merge with dish ingredient keys by fuzzy name
  const siItems = standardInventory[currentOrdersLoc || 'west'] || [];
  siItems.forEach(item => {
    if (!item.amount || item.amount <= 0) return;
    const db = lookupIngredient(item.name);
    const canonicalName = db ? db.name : item.name;
    // Find an existing key that matches this item
    const matchingKey = Object.keys(combined).find(k =>
      k === item.name.toLowerCase().trim() || k === canonicalName.toLowerCase().trim()
    );
    const nameToUse = matchingKey ? combined[matchingKey].name : canonicalName;
    addToMap(nameToUse, toGrams(item.amount, item.unit), true, null);
  });

  if (!Object.keys(combined).length) {
    return `<div class="empty">No items to order. Add items to Standard Inventory or flag dishes for ordering in the Week plan.</div>`;
  }

  const ingList = Object.values(combined).sort((a, b) => a.name.localeCompare(b.name)).map(ing => {
    const db = lookupIngredient(ing.name);
    return {
      ...ing,
      db,
      supplier: normalizeSupplier((db && db.source) || ''),
      orderCode: db ? db.orderCode : '',
      orderCalc: db ? calcOrderUnits(ing.totalGrams, db) : null,
    };
  });

  // Group by storage category (current building) instead of supplier
  const curLoc = currentOrdersLoc || 'west';
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

  html += `<div class="section-title" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
      <span>Combined Order &mdash; ${esc(curLoc === 'west' ? 'Sering West' : 'Sering Centraal')}</span>
      <span style="font-size:13px;font-weight:600;">${totalValue > 0 ? 'Estimated: \u20AC' + totalValue.toFixed(2) : ''}</span>
    </div>`;

  storageOrder.forEach(storageCat => {
    const items = byStorage[storageCat];
    const codesForCopy = items.filter(i => i.orderCode && !i.orderCode.startsWith('http')).map(i => i.orderCode);

    const catColor = getStorageColor(storageCat, curLoc);
    html += `<div class="storage-group" style="margin-bottom:16px;border-left:4px solid ${catColor};padding-left:10px;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
        <span class="storage-group-dot" style="background:${catColor};"></span>
        <span style="font-weight:600;font-size:14px;">${esc(storageCat)}</span>
        <span style="font-size:12px;color:var(--text2);">(${items.length} item${items.length !== 1 ? 's' : ''})</span>
        ${codesForCopy.length ? `<button class="copy-all-btn" onclick="copyCombinedOrderCodes('${esc(storageCat)}')">Copy all codes</button>` : ''}
      </div>
      <div style="overflow-x:auto;"><table class="ing-table">
      <thead><tr>
        <th>Ingredient</th>
        <th>Category</th>
        <th>Storage</th>
        <th>Order code</th>
        <th>Unit / Price</th>
        <th style="cursor:pointer;" title="Click a row to see breakdown">Total needed</th>
        <th>In stock</th>
        <th>To order</th>
        <th>Order units</th>
      </tr></thead><tbody>`;

    items.forEach(ing => {
      const key = ing.name.toLowerCase().trim();
      const fmt = formatGrams(ing.totalGrams);
      const isUrl = ing.orderCode && (ing.orderCode.startsWith('http') || ing.orderCode.startsWith('www'));

      let codeDisplay;
      if (!ing.db) codeDisplay = '<span style="color:var(--red);font-size:10px;opacity:.7;">not in DB</span>';
      else if (!ing.orderCode) codeDisplay = '<span style="color:var(--text2);font-size:11px;">no code</span>';
      else if (isUrl) codeDisplay = `<a href="${esc(ing.orderCode.startsWith('http') ? ing.orderCode : 'https://'+ing.orderCode)}" target="_blank" rel="noopener" style="font-size:11px;color:var(--blue);">Order link \u2197</a>`;
      else codeDisplay = `<span class="order-code">${esc(ing.orderCode)}</span>`;

      const unitPrice = ing.db ? (ing.db.orderUnit ? esc(ing.db.orderUnit) : '') + (ing.db.orderPrice ? ' \u00B7 \u20AC' + Number(ing.db.orderPrice).toFixed(2) : '') : '';

      // Stock
      const dbStock = getDbStockTotal(ing.db);
      const hasManualStock = combinedOrderStock[key] !== undefined;
      const stockVal = hasManualStock ? combinedOrderStock[key] : (dbStock > 0 ? dbStock : '');
      const stockLabel = (!hasManualStock && dbStock > 0) ? ' <span style="font-size:9px;color:var(--blue);vertical-align:super;">DB</span>' : '';
      const stockInput = `<input class="order-stock-input" type="number" min="0" step="1" value="${stockVal}" placeholder="0" oninput="updateCombinedOrderStock('${esc(key)}',this.value)" />${stockLabel}`;

      const effectiveStock = hasManualStock ? (parseFloat(combinedOrderStock[key]) || 0) : dbStock;
      const hasStockValue = hasManualStock || dbStock > 0;
      const toOrderGrams = Math.max(0, ing.totalGrams - effectiveStock);
      const toOrderDisplay = hasStockValue
        ? (toOrderGrams > 0
          ? `<span class="to-order-positive">${formatGrams(toOrderGrams).amount} ${formatGrams(toOrderGrams).unit}</span>`
          : `<span class="to-order-zero">\u2713 enough</span>`)
        : `<span style="color:var(--text2);font-size:11px;">enter stock \u2192</span>`;

      const orderAmtGrams = hasStockValue ? toOrderGrams : ing.totalGrams;
      const orderCalc = ing.db ? calcOrderUnits(orderAmtGrams, ing.db) : null;
      const orderUnitsDisplay = orderCalc && orderCalc.units > 0
        ? `<span class="order-amt">${orderCalc.units}x</span> <span class="order-units">(${orderCalc.perUnit} ${esc(orderCalc.unitType)})</span>`
        : (orderAmtGrams === 0 ? '<span class="to-order-zero">\u2014</span>' : '<span style="color:var(--text2);font-size:11px;">\u2014</span>');

      // Breakdown (shown on click)
      const parts = [];
      if (ing.standardGrams > 0) {
        const f = formatGrams(ing.standardGrams);
        parts.push(`<span class="combined-part combined-standard">${f.amount}${f.unit} standard</span>`);
      }
      if (ing.dishGrams > 0) {
        const f = formatGrams(ing.dishGrams);
        parts.push(`<span class="combined-part combined-dishes">${f.amount}${f.unit} ${esc(ing.dishes.join(', '))}</span>`);
      }
      const breakdownHtml = parts.length ? `<div class="breakdown-detail" style="display:none;font-size:11px;margin-top:2px;">${parts.join(' + ')}</div>` : '';

      const priceAlertIcon = (ing.db && ing.db.priceAlert) ? ' <span style="color:var(--red);font-size:11px;" title="Price increased">\u25B2</span>' : '';

      html += `<tr data-combined-key="${esc(key)}" data-needed="${ing.totalGrams}" data-dbname="${esc(ing.name)}">
        <td style="font-weight:500;cursor:pointer;text-decoration:underline dotted;text-underline-offset:3px;" onclick="openIngredientModal('${esc(ing.name)}')">${esc(ing.name)}${priceAlertIcon}</td>
        <td style="font-size:12px;">${ing.db && ing.db.category ? esc(ing.db.category) : '\u2014'}</td>
        <td>${renderStorageBadge(ing.db)}</td>
        <td>${codeDisplay}</td>
        <td style="font-size:12px;">${unitPrice}</td>
        <td style="cursor:pointer;" onclick="this.querySelector('.breakdown-detail')&&(this.querySelector('.breakdown-detail').style.display=this.querySelector('.breakdown-detail').style.display==='none'?'block':'none')">
          <span class="order-amt">${fmt.amount}</span> <span class="order-units">${fmt.unit}</span>
          ${breakdownHtml}
        </td>
        <td>${stockInput}</td>
        <td class="to-order-cell">${toOrderDisplay}</td>
        <td class="order-units-cell">${orderUnitsDisplay}</td>
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
  S.dishes.filter(d => d.orderFor).forEach(dish => {
    calcIngredientsFromRecipe(dish).forEach(ing => {
      const db = lookupIngredient(ing.name);
      if (db && db.orderCode && !db.orderCode.startsWith('http') && (db.source || '').toLowerCase().includes(supplier.toLowerCase())) {
        if (!items.includes(db.orderCode)) items.push(db.orderCode);
      }
    });
  });
  if (items.length) navigator.clipboard.writeText(items.join('\n')).then(() => toast(items.length + ' order codes copied'));
}

function copyDishOrderCodes(storageCat) {
  const curLoc = currentOrdersLoc || 'west';
  const items = new Set();
  S.dishes.filter(d => d.orderFor).forEach(dish => {
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
  (standardInventory[curLoc] || []).forEach(item => {
    const db = lookupIngredient(item.name);
    if (db && db.orderCode && !db.orderCode.startsWith('http')) {
      const cat = getStorageCategory(db, curLoc) || 'Unsorted';
      if (cat === storageCat) items.add(db.orderCode);
    }
  });
  const arr = [...items];
  if (arr.length) navigator.clipboard.writeText(arr.join('\n')).then(() => toast(arr.length + ' order codes copied'));
}

function copyCombinedOrderCodes(supplier) {
  const items = new Set();
  S.dishes.filter(d => d.orderFor).forEach(dish => {
    calcIngredientsFromRecipe(dish).forEach(ing => {
      const db = lookupIngredient(ing.name);
      if (db && db.orderCode && !db.orderCode.startsWith('http') && normalizeSupplier(db.source || '').toLowerCase().includes(supplier.toLowerCase())) {
        items.add(db.orderCode);
      }
    });
  });
  (standardInventory[currentOrdersLoc || 'west'] || []).forEach(item => {
    const db = lookupIngredient(item.name);
    if (db && db.orderCode && !db.orderCode.startsWith('http') && normalizeSupplier(db.source || '').toLowerCase().includes(supplier.toLowerCase())) {
      items.add(db.orderCode);
    }
  });
  const arr = [...items];
  if (arr.length) navigator.clipboard.writeText(arr.join('\n')).then(() => toast(arr.length + ' order codes copied'));
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

function updateCombinedOrderStock(key, val) {
  if (val === '' || val === null) {
    delete combinedOrderStock[key];
  } else {
    combinedOrderStock[key] = parseFloat(val) || 0;
  }

  // Persist to DB
  const db = lookupIngredient(key);
  if (db) persistIngredientStock(db.name, val);

  const row = document.querySelector(`[data-combined-key="${key}"]`);
  if (!row) return;
  const neededGrams = parseFloat(row.dataset.needed) || 0;
  const inStockGrams = parseFloat(val) || 0;
  const toOrderGrams = Math.max(0, neededGrams - inStockGrams);

  const toOrderEl = row.querySelector('.to-order-cell');
  if (toOrderEl) {
    if (val === '' || val === null || val === undefined) {
      toOrderEl.innerHTML = '<span style="color:var(--text2);font-size:11px;">enter stock \u2192</span>';
    } else if (toOrderGrams > 0) {
      const f = formatGrams(toOrderGrams);
      toOrderEl.innerHTML = `<span class="to-order-positive">${f.amount} ${esc(f.unit)}</span>`;
    } else {
      toOrderEl.innerHTML = '<span class="to-order-zero">\u2713 enough</span>';
    }
  }

  const orderUnitsEl = row.querySelector('.order-units-cell');
  if (orderUnitsEl) {
    const dbName = row.dataset.dbname || '';
    const dbLookup = dbName ? lookupIngredient(dbName) : null;
    const orderAmt = (val === '' || val === null || val === undefined) ? neededGrams : toOrderGrams;
    const orderCalc = dbLookup ? calcOrderUnits(orderAmt, dbLookup) : null;
    if (orderCalc && orderCalc.units > 0) {
      orderUnitsEl.innerHTML = `<span class="order-amt">${orderCalc.units}x</span> <span class="order-units">(${orderCalc.perUnit} ${esc(orderCalc.unitType)})</span>`;
    } else if (orderAmt === 0) {
      orderUnitsEl.innerHTML = '<span class="to-order-zero">\u2014</span>';
    } else {
      orderUnitsEl.innerHTML = '<span style="color:var(--text2);font-size:11px;">\u2014</span>';
    }
  }
}

function updateOrderStock(key, val) {
  if (val === '' || val === null) {
    delete orderInventory[key];
  } else {
    orderInventory[key] = parseFloat(val) || 0;
  }

  // Persist to DB
  const db = lookupIngredient(key);
  if (db) persistIngredientStock(db.name, val);

  const row = document.querySelector(`[data-stock-key="${key}"]`);
  if (!row) return;
  const needed = parseFloat(row.dataset.needed) || 0;
  const inStock = parseFloat(val) || 0;
  const toOrder = Math.max(0, needed - inStock);
  const toOrderEl = row.querySelector('.to-order-cell');
  const dbUnit = row.dataset.unit || 'g';
  if (toOrderEl) {
    if (val === '' || val === null || val === undefined) {
      toOrderEl.innerHTML = '<span style="color:var(--text2);font-size:11px;">enter stock \u2192</span>';
    } else if (toOrder > 0) {
      toOrderEl.innerHTML = `<span class="to-order-positive">${toOrder.toLocaleString()} ${esc(dbUnit)}</span>`;
    } else {
      toOrderEl.innerHTML = '<span class="to-order-zero">\u2713 enough</span>';
    }
  }
}

async function refreshAllRecipes() {
  const dishes = S.dishes.filter(d => d.orderFor && d.recipeSheetId);
  if (!dishes.length) { toast('No dishes with recipe sheets to refresh'); return; }
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

