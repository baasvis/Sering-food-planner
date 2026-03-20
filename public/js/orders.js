// ── ORDER OVERVIEW ────────────────────────────────────────

// State
let orderInventory = {};        // in-stock amounts for dish ingredients (keyed by name lowercase)
let combinedOrderStock = {};   // in-stock amounts for combined order tab (grams, keyed by name lowercase)
let standardInventory = [];     // [{id, name, amount, unit}] — the weekly base order
let siLoaded = false;
let siLoadCalled = false;
let siSaveTimeout = null;
let currentOrdersTab = 'combined'; // 'combined' | 'standard' | 'dishes'
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
    <button class="order-tab-btn${currentOrdersTab === 'combined' ? ' active' : ''}" onclick="switchOrdersTab('combined')">Combined Order</button>
    <button class="order-tab-btn${currentOrdersTab === 'standard' ? ' active' : ''}" onclick="switchOrdersTab('standard')">Standard Inventory</button>
    <button class="order-tab-btn${currentOrdersTab === 'dishes' ? ' active' : ''}" onclick="switchOrdersTab('dishes')">Dish Ingredients</button>
  </div>`;

  let content;
  if (currentOrdersTab === 'standard') content = renderStandardInventoryTab();
  else if (currentOrdersTab === 'dishes') content = renderDishesTab();
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
