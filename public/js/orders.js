// ── ORDER OVERVIEW ────────────────────────────────────────

// State
let orderInventory = {};        // in-stock amounts for dish ingredients (keyed by name lowercase)
let combinedOrderStock = {};   // in-stock amounts for combined order tab (grams, keyed by name lowercase)
let standardInventory = [];     // [{id, name, amount, unit}] — the weekly base order
let siLoaded = false;
let siLoadCalled = false;
let siSaveTimeout = null;
let currentOrdersTab = 'combined'; // 'combined' | 'standard' | 'dishes' | 'ingredientDb'
let siSearchQuery = '';

// Ingredient DB editor state
let ingredientDbFull = [];       // full ingredient list from /api/ingredients/full
let ingredientDbFullLoaded = false;
let ingredientDbSearch = '';
let ingredientDbFilter = 'all';  // 'all' | 'active' | 'inactive' | category name
let ingredientDbSort = 'name';   // 'name' | 'supplier' | 'category'
let ingredientDbEditId = null;   // id of ingredient being edited inline
let supplierUploadData = null;   // parsed Hanos XLSX data for import

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

function calcOrderUnits(amountGrams, dbEntry) {
  if (!dbEntry || !dbEntry.orderAmount || dbEntry.orderAmount <= 0) return null;
  const unitGrams = dbEntry.unitRecalc || dbEntry.orderAmount;
  const units = Math.ceil(amountGrams / unitGrams);
  return { units, perUnit: dbEntry.orderAmount, unitType: dbEntry.actualUnit || dbEntry.unit || 'g' };
}

// ── Standard Inventory API ────────────────────────────────

async function loadStandardInventory() {
  try {
    const data = await apiGet('/api/standard-inventory');
    standardInventory = Array.isArray(data) ? data : [];
  } catch (e) {
    standardInventory = [];
  }
  siLoaded = true;
}

async function saveStandardInventory() {
  try {
    await apiPost('/api/standard-inventory', standardInventory);
  } catch (e) {
    toastError('Failed to save standard inventory');
  }
}

function debouncedSaveSI() {
  clearTimeout(siSaveTimeout);
  siSaveTimeout = setTimeout(saveStandardInventory, 800);
}

// ── Standard Inventory actions ────────────────────────────

function updateSiSearch(val) {
  siSearchQuery = val;
  // re-render only the suggestions part to avoid losing input focus
  const sugContainer = document.getElementById('si-suggestions');
  if (!sugContainer) return;
  const query = val.toLowerCase().trim();
  const addedNames = new Set(standardInventory.map(i => i.name.toLowerCase().trim()));
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
  const exists = standardInventory.find(i => i.name.toLowerCase().trim() === name.toLowerCase().trim());
  if (exists) return;
  standardInventory.push({ id: newId(), name, amount: 0, unit: unit || 'g' });
  siSearchQuery = '';
  saveStandardInventory();
  renderOrders();
}

function removeSiItem(idx) {
  standardInventory.splice(idx, 1);
  saveStandardInventory();
  renderOrders();
}

function updateSiAmount(idx, val) {
  if (standardInventory[idx]) {
    standardInventory[idx].amount = parseFloat(val) || 0;
    debouncedSaveSI();
  }
}

function updateSiUnit(idx, val) {
  if (standardInventory[idx]) {
    standardInventory[idx].unit = val;
    debouncedSaveSI();
  }
}

// ── Tab switching ─────────────────────────────────────────

function switchOrdersTab(tab) {
  currentOrdersTab = tab;
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

  document.getElementById('screen-orders').innerHTML = tabBar + content;
}

// ── Standard Inventory tab ────────────────────────────────

function renderStandardInventoryTab() {
  const UNITS = ['g', 'kg', 'L', 'mL', 'pieces', 'tbsp', 'tsp'];

  const itemsHtml = standardInventory.length === 0
    ? '<div class="empty">No items yet. Search above to add ingredients from the database.</div>'
    : `<table class="ing-table">
        <thead><tr>
          <th>Ingredient</th>
          <th>Amount / week</th>
          <th>Order code</th>
          <th>Supplier</th>
          <th></th>
        </tr></thead>
        <tbody>
          ${standardInventory.map((item, idx) => {
            const db = lookupIngredient(item.name);
            const supplier = db && db.source ? esc(db.source) : '<span style="color:var(--text3);">—</span>';
            const dbUnit = db && db.unit ? esc(db.unit) : (item.unit ? esc(item.unit) : 'g');
            const isUrl = db && db.orderCode && (db.orderCode.startsWith('http') || db.orderCode.startsWith('www'));
            let codeDisplay;
            if (!db) codeDisplay = '<span style="color:var(--red);font-size:10px;opacity:.7;">not in DB</span>';
            else if (!db.orderCode) codeDisplay = '<span style="color:var(--text3);font-size:11px;">—</span>';
            else if (isUrl) codeDisplay = `<a href="${esc(db.orderCode.startsWith('http') ? db.orderCode : 'https://'+db.orderCode)}" target="_blank" rel="noopener" style="font-size:11px;color:var(--blue);">Order link ↗</a>`;
            else codeDisplay = `<span class="order-code">${esc(db.orderCode)}</span>`;
            return `<tr>
              <td style="font-weight:500;">${esc(item.name)} <span style="font-size:11px;color:var(--text3);">${dbUnit}</span></td>
              <td><input class="order-stock-input" type="number" min="0" step="any" value="${item.amount > 0 ? item.amount : ''}" placeholder="0" oninput="updateSiAmount(${idx}, this.value)" /></td>
              <td>${codeDisplay}</td>
              <td style="font-size:12px;color:var(--text2);">${supplier}</td>
              <td><button class="btn btn-danger btn-sm" onclick="removeSiItem(${idx})">Remove</button></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`;

  return `
    <div>
      <div class="section-title">Standard Inventory &mdash; Weekly Base Order</div>
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

  const bySupplier = {};
  ingList.forEach(ing => {
    const s = ing.supplier;
    if (!bySupplier[s]) bySupplier[s] = [];
    bySupplier[s].push(ing);
  });
  const supplierOrder = Object.keys(bySupplier).sort((a, b) => {
    if (a.toLowerCase().includes('hanos')) return -1;
    if (b.toLowerCase().includes('hanos')) return 1;
    return a.localeCompare(b);
  });

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
    supplierOrder.forEach(supplier => {
      const items = bySupplier[supplier];
      const codesForCopy = items.filter(i => i.orderCode && !i.orderCode.startsWith('http')).map(i => i.orderCode);
      html += `<div style="margin-bottom:16px;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
          <span style="font-weight:600;font-size:14px;">${esc(supplier)}</span>
          <span style="font-size:12px;color:var(--text2);">(${items.length} item${items.length !== 1 ? 's' : ''})</span>
          ${codesForCopy.length ? `<button class="copy-all-btn" onclick="copyOrderCodes('${esc(supplier)}')">Copy all codes</button>` : ''}
        </div>
        <div style="overflow-x:auto;"><table class="ing-table">
        <thead><tr>
          <th>Ingredient</th><th>Amount needed</th><th>Order code / link</th>
          <th>In stock</th><th>To order</th><th>Order units</th><th>For dishes</th>
        </tr></thead><tbody>`;

      items.forEach(ing => {
        const key = ing.name.toLowerCase().trim();
        const isUrl = ing.orderCode && (ing.orderCode.startsWith('http') || ing.orderCode.startsWith('www'));
        const dbUnit = ing.unit || (ing.db && ing.db.unit) || 'g';
        const amtNeeded = Math.round(ing.amount);

        let codeDisplay;
        if (!ing.db) codeDisplay = '<span style="color:var(--red);font-size:10px;opacity:.7;">not in DB</span>';
        else if (!ing.orderCode) codeDisplay = '<span style="color:var(--text2);font-size:11px;">no code</span>';
        else if (isUrl) codeDisplay = `<a href="${esc(ing.orderCode.startsWith('http') ? ing.orderCode : 'https://'+ing.orderCode)}" target="_blank" rel="noopener" style="font-size:11px;color:var(--blue);">Order link ↗</a>`;
        else codeDisplay = `<span class="order-code" title="Click to select">${esc(ing.orderCode)}</span>`;

        const stockVal = orderInventory[key] !== undefined ? orderInventory[key] : '';
        const stockInput = `<input class="order-stock-input" type="number" min="0" step="1" value="${stockVal}" placeholder="0" oninput="updateOrderStock('${esc(key)}',this.value)" />`;

        const inStock = parseFloat(orderInventory[key]) || 0;
        const toOrder = Math.max(0, amtNeeded - inStock);
        const toOrderDisplay = orderInventory[key] !== undefined
          ? (toOrder > 0
            ? `<span class="to-order-positive">${toOrder.toLocaleString()} ${esc(dbUnit)}</span>`
            : `<span class="to-order-zero">✓ enough</span>`)
          : `<span style="color:var(--text2);font-size:11px;">enter stock →</span>`;

        const orderAmt = orderInventory[key] !== undefined ? toOrder : amtNeeded;
        const orderAmtGrams = toGrams(orderAmt, dbUnit);
        const orderCalc = ing.db ? calcOrderUnits(orderAmtGrams, ing.db) : null;
        const orderUnits = orderCalc && orderCalc.units > 0
          ? `<span class="order-amt">${orderCalc.units}x</span> <span class="order-units">(${orderCalc.perUnit} ${esc(orderCalc.unitType)})</span>`
          : (orderAmt === 0 ? '<span class="to-order-zero">—</span>' : '<span style="color:var(--text2);font-size:11px;">—</span>');

        html += `<tr data-stock-key="${esc(key)}" data-needed="${amtNeeded}" data-unit="${esc(dbUnit)}">
          <td style="font-weight:500;">${esc(ing.name)}</td>
          <td><span class="order-amt">${amtNeeded.toLocaleString()}</span> <span class="order-units">${esc(dbUnit)}</span></td>
          <td>${codeDisplay}</td>
          <td>${stockInput}</td>
          <td class="to-order-cell">${toOrderDisplay}</td>
          <td>${orderUnits}</td>
          <td style="font-size:11px;color:var(--text2);">${ing.dishes.map(n => esc(n.length > 20 ? n.slice(0,18)+'…' : n)).join(', ')}</td>
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

  // Add standard inventory — try to merge with dish ingredient keys by fuzzy name
  standardInventory.forEach(item => {
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

  const bySupplier = {};
  ingList.forEach(ing => {
    const s = ing.supplier;
    if (!bySupplier[s]) bySupplier[s] = [];
    bySupplier[s].push(ing);
  });
  const supplierOrder = Object.keys(bySupplier).sort((a, b) => {
    if (a.toLowerCase().includes('hanos')) return -1;
    if (b.toLowerCase().includes('hanos')) return 1;
    return a.localeCompare(b);
  });

  let html = `<div style="margin-bottom:20px;">
    <div class="section-title" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
      <span>Combined Order &mdash; Standard Inventory + Dish Ingredients</span>
      <span style="font-size:12px;color:var(--text2);font-weight:400;">
        <span style="color:var(--green);">&#9632;</span> standard &nbsp;
        <span style="color:var(--blue);">&#9632;</span> dishes
      </span>
    </div>`;

  supplierOrder.forEach(supplier => {
    const items = bySupplier[supplier];
    const codesForCopy = items.filter(i => i.orderCode && !i.orderCode.startsWith('http')).map(i => i.orderCode);

    html += `<div style="margin-bottom:16px;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
        <span style="font-weight:600;font-size:14px;">${esc(supplier)}</span>
        <span style="font-size:12px;color:var(--text2);">(${items.length} item${items.length !== 1 ? 's' : ''})</span>
        ${codesForCopy.length ? `<button class="copy-all-btn" onclick="copyCombinedOrderCodes('${esc(supplier)}')">Copy all codes</button>` : ''}
      </div>
      <div style="overflow-x:auto;"><table class="ing-table">
      <thead><tr>
        <th>Ingredient</th>
        <th>Total needed</th>
        <th>Breakdown</th>
        <th>Order code / link</th>
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
      else if (isUrl) codeDisplay = `<a href="${esc(ing.orderCode.startsWith('http') ? ing.orderCode : 'https://'+ing.orderCode)}" target="_blank" rel="noopener" style="font-size:11px;color:var(--blue);">Order link ↗</a>`;
      else codeDisplay = `<span class="order-code">${esc(ing.orderCode)}</span>`;

      // In stock + to order
      const stockVal = combinedOrderStock[key] !== undefined ? combinedOrderStock[key] : '';
      const stockInput = `<input class="order-stock-input" type="number" min="0" step="1" value="${stockVal}" placeholder="0" oninput="updateCombinedOrderStock('${esc(key)}',this.value)" />`;

      const inStockGrams = parseFloat(combinedOrderStock[key]) || 0;
      const toOrderGrams = Math.max(0, ing.totalGrams - inStockGrams);
      const toOrderDisplay = combinedOrderStock[key] !== undefined
        ? (toOrderGrams > 0
          ? `<span class="to-order-positive">${formatGrams(toOrderGrams).amount} ${formatGrams(toOrderGrams).unit}</span>`
          : `<span class="to-order-zero">✓ enough</span>`)
        : `<span style="color:var(--text2);font-size:11px;">enter stock →</span>`;

      // Order units based on stock-adjusted amount
      const orderAmtGrams = combinedOrderStock[key] !== undefined ? toOrderGrams : ing.totalGrams;
      const orderCalc = ing.db ? calcOrderUnits(orderAmtGrams, ing.db) : null;
      const orderUnitsDisplay = orderCalc && orderCalc.units > 0
        ? `<span class="order-amt">${orderCalc.units}x</span> <span class="order-units">(${orderCalc.perUnit} ${esc(orderCalc.unitType)})</span>`
        : (orderAmtGrams === 0 ? '<span class="to-order-zero">—</span>' : '<span style="color:var(--text2);font-size:11px;">—</span>');

      const parts = [];
      if (ing.standardGrams > 0) {
        const f = formatGrams(ing.standardGrams);
        parts.push(`<span class="combined-part combined-standard">${f.amount}${f.unit} standard</span>`);
      }
      if (ing.dishGrams > 0) {
        const f = formatGrams(ing.dishGrams);
        const dishNames = ing.dishes.map(n => n.length > 18 ? n.slice(0,16)+'…' : n).join(', ');
        parts.push(`<span class="combined-part combined-dishes" title="${esc(ing.dishes.join(', '))}">${f.amount}${f.unit} dishes</span>`);
      }

      html += `<tr data-combined-key="${esc(key)}" data-needed="${ing.totalGrams}" data-dbname="${esc(ing.name)}">
        <td style="font-weight:500;">${esc(ing.name)}</td>
        <td><span class="order-amt">${fmt.amount}</span> <span class="order-units">${fmt.unit}</span></td>
        <td>${parts.join(' + ')}</td>
        <td>${codeDisplay}</td>
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
  standardInventory.forEach(item => {
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

function updateCombinedOrderStock(key, val) {
  if (val === '' || val === null) {
    delete combinedOrderStock[key];
  } else {
    combinedOrderStock[key] = parseFloat(val) || 0;
  }
  const row = document.querySelector(`[data-combined-key="${key}"]`);
  if (!row) return;
  const neededGrams = parseFloat(row.dataset.needed) || 0;
  const inStockGrams = parseFloat(val) || 0;
  const toOrderGrams = Math.max(0, neededGrams - inStockGrams);

  // Update "To order" cell
  const toOrderEl = row.querySelector('.to-order-cell');
  if (toOrderEl) {
    if (val === '' || val === null || val === undefined) {
      toOrderEl.innerHTML = '<span style="color:var(--text2);font-size:11px;">enter stock →</span>';
    } else if (toOrderGrams > 0) {
      const f = formatGrams(toOrderGrams);
      toOrderEl.innerHTML = `<span class="to-order-positive">${f.amount} ${esc(f.unit)}</span>`;
    } else {
      toOrderEl.innerHTML = '<span class="to-order-zero">✓ enough</span>';
    }
  }

  // Update "Order units" cell
  const orderUnitsEl = row.querySelector('.order-units-cell');
  if (orderUnitsEl) {
    const dbName = row.dataset.dbname || '';
    const db = dbName ? lookupIngredient(dbName) : null;
    const orderAmt = (val === '' || val === null || val === undefined) ? neededGrams : toOrderGrams;
    const orderCalc = db ? calcOrderUnits(orderAmt, db) : null;
    if (orderCalc && orderCalc.units > 0) {
      orderUnitsEl.innerHTML = `<span class="order-amt">${orderCalc.units}x</span> <span class="order-units">(${orderCalc.perUnit} ${esc(orderCalc.unitType)})</span>`;
    } else if (orderAmt === 0) {
      orderUnitsEl.innerHTML = '<span class="to-order-zero">—</span>';
    } else {
      orderUnitsEl.innerHTML = '<span style="color:var(--text2);font-size:11px;">—</span>';
    }
  }
}

function updateOrderStock(key, val) {
  if (val === '' || val === null) {
    delete orderInventory[key];
  } else {
    orderInventory[key] = parseFloat(val) || 0;
  }
  const row = document.querySelector(`[data-stock-key="${key}"]`);
  if (!row) return;
  const needed = parseFloat(row.dataset.needed) || 0;
  const inStock = parseFloat(val) || 0;
  const toOrder = Math.max(0, needed - inStock);
  const toOrderEl = row.querySelector('.to-order-cell');
  const dbUnit = row.dataset.unit || 'g';
  if (toOrderEl) {
    if (val === '' || val === null || val === undefined) {
      toOrderEl.innerHTML = '<span style="color:var(--text2);font-size:11px;">enter stock →</span>';
    } else if (toOrder > 0) {
      toOrderEl.innerHTML = `<span class="to-order-positive">${toOrder.toLocaleString()} ${esc(dbUnit)}</span>`;
    } else {
      toOrderEl.innerHTML = '<span class="to-order-zero">✓ enough</span>';
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

// ── INGREDIENT DATABASE TAB ──────────────────────────────────

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
