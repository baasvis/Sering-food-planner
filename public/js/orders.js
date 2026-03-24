// ── ORDER OVERVIEW — main render, combined order, dishes tab, Hanos integration ──
// Depends on: orders-helpers.js (state + helpers), orders-inventory.js (standard inventory)

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
    const amtInGrams = toGrams(ing.amount, ing.unit);
    return {
      ...ing, db, amountInGrams: amtInGrams,
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
      <span>Ingredient order (${orderedDishes.length} batch${orderedDishes.length !== 1 ? 'es' : ''} flagged)</span>
      <div style="display:flex;align-items:center;gap:8px;">
        <span style="font-weight:400;font-size:12px;color:var(--text2);">${orderedDishes.map(d => esc(d.name)).join(' · ')}</span>
        ${dishesWithSheets.length ? `<button class="copy-all-btn" onclick="refreshAllRecipes()">↻ Refresh recipe data</button>` : ''}
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
          <th>Amount needed</th><th>In stock</th><th>To order</th><th>Order units</th><th>For batches</th>
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
        const hanosBtnBatch = (isHanosEnabled() && ing.orderCode && !isUrl && orderCalc && orderCalc.units > 0)
          ? ` <button class="hanos-btn" onclick="hanosAddSingle('${esc(ing.orderCode)}','${esc(ing.name)}')" title="Add to Hanos cart">🛒</button>`
          : '';
        const orderUnits = orderCalc && orderCalc.units > 0
          ? `<span class="order-amt">${orderCalc.units}x</span> <span class="order-units">(${orderCalc.perUnit} ${esc(orderCalc.unitType)})</span>${hanosBtnBatch}`
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

  if (combinedIncludeDishes) {
    orderedDishes.forEach(dish => {
      calcIngredientsFromRecipe(dish).forEach(ing => {
        addToMap(ing.name, toGrams(ing.amount, ing.unit), false, dish.name);
      });
    });
  }

  const siItems = standardInventory[currentOrdersLoc || 'west'] || [];
  siItems.forEach(item => {
    if (!item.amount || item.amount <= 0) return;
    const db = lookupIngredient(item.name);
    const canonicalName = db ? db.name : item.name;
    const unitGrams = db ? (db.unitRecalc || db.orderAmount || 0) : 0;
    const isLegacy = item.unit && item.unit !== 'units' && item.unit.toLowerCase() !== 'units';
    let amtGrams;
    if (isLegacy && unitGrams > 0) {
      amtGrams = toGrams(item.amount, item.unit);
    } else if (unitGrams > 0) {
      amtGrams = item.amount * unitGrams;
    } else {
      amtGrams = toGrams(item.amount, item.unit);
    }
    const matchingKey = Object.keys(combined).find(k =>
      k === item.name.toLowerCase().trim() || k === canonicalName.toLowerCase().trim()
    );
    const nameToUse = matchingKey ? combined[matchingKey].name : canonicalName;
    addToMap(nameToUse, amtGrams, true, null);
  });

  if (!Object.keys(combined).length) {
    return `<div class="empty">No items to order. Add items to Standard Inventory or flag batches for ordering in the Week plan.</div>`;
  }

  const ingList = Object.values(combined).sort((a, b) => a.name.localeCompare(b.name)).map(ing => {
    const db = lookupIngredient(ing.name);
    return {
      ...ing, db,
      supplier: normalizeSupplier((db && db.source) || ''),
      orderCode: db ? db.orderCode : '',
      orderCalc: db ? calcOrderUnits(ing.totalGrams, db) : null,
    };
  });

  const curLoc = currentOrdersLoc || 'west';
  const byStorage = {};
  ingList.forEach(ing => {
    const cat = getStorageCategory(ing.db, curLoc) || 'Unsorted';
    if (!byStorage[cat]) byStorage[cat] = [];
    byStorage[cat].push(ing);
  });
  const storageCatOrder = Object.keys(STORAGE_CATEGORIES);
  const storageOrder = [...storageCatOrder.filter(c => byStorage[c]), ...Object.keys(byStorage).filter(c => !storageCatOrder.includes(c))];

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
        <th>Ingredient</th><th>Category</th><th>Storage</th><th>Order code</th>
        <th>Unit / Price</th>
        <th style="cursor:pointer;" title="Click a row to see breakdown">Total needed</th>
        <th>In stock</th><th>To order</th><th>Order units</th>
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
      const hanosBtn = (isHanosEnabled() && ing.orderCode && !isUrl && orderCalc && orderCalc.units > 0)
        ? ` <button class="hanos-btn" onclick="hanosAddSingle('${esc(ing.orderCode)}','${esc(ing.name)}')" title="Add to Hanos cart">🛒</button>`
        : '';
      const isStukNoWeight = ing.db && ing.db.orderCode && (!ing.db.orderAmount || ing.db.orderAmount <= 0);
      let orderUnitsDisplay;
      if (orderCalc && orderCalc.units > 0) {
        orderUnitsDisplay = `<span class="order-amt">${orderCalc.units}x</span> <span class="order-units">(${orderCalc.perUnit} ${esc(orderCalc.unitType)})</span>${hanosBtn}`;
      } else if (isStukNoWeight && orderAmtGrams > 0) {
        orderUnitsDisplay = `<input class="order-stock-input gpstuk-input" type="number" min="1" step="1" placeholder="g/piece" title="Fill in grams per piece to calculate order units" onchange="saveGramsPerPiece('${esc(ing.db.id)}','${esc(key)}',this.value)" style="width:75px;" />`;
      } else if (orderAmtGrams === 0) {
        orderUnitsDisplay = '<span class="to-order-zero">\u2014</span>';
      } else {
        orderUnitsDisplay = '<span style="color:var(--text2);font-size:11px;">\u2014</span>';
      }

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
  S.batches.filter(d => d.orderFor).forEach(dish => {
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

function copyCombinedOrderCodes(supplier) {
  const items = new Set();
  S.batches.filter(d => d.orderFor).forEach(dish => {
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

// ── Hanos integration ────────────────────────────────────

async function checkHanosStatus() {
  if (hanosStatusChecked) return;
  hanosStatusChecked = true;
  try {
    const prev = hanosStatus.configured;
    hanosStatus = await apiGet('/api/hanos/status');
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

function collectHanosItems(storageCat) {
  const rows = document.querySelectorAll('.ing-table tr[data-combined-key]');
  const items = [];
  rows.forEach(row => {
    if (storageCat) {
      const group = row.closest('.storage-group');
      if (!group || !group.dataset.storageCat || group.dataset.storageCat !== storageCat) return;
    }
    const key = row.dataset.combinedKey;
    const dbName = row.dataset.dbname;
    const db = dbName ? lookupIngredient(dbName) : null;
    if (!db || !db.orderCode || db.orderCode.startsWith('http')) return;

    const neededGrams = parseFloat(row.dataset.needed) || 0;
    const dbStock = getDbStockTotal(db);
    const hasManual = combinedOrderStock[key] !== undefined;
    const effectiveStock = hasManual ? (parseFloat(combinedOrderStock[key]) || 0) : dbStock;
    const hasStockValue = hasManual || dbStock > 0;
    const toOrderGrams = hasStockValue ? Math.max(0, neededGrams - effectiveStock) : neededGrams;
    const calc = calcOrderUnits(toOrderGrams, db);
    if (!calc || calc.units <= 0) return;

    items.push({
      name: db.name, orderCode: db.orderCode, quantity: calc.units,
      unit: 'ST', unitLabel: db.orderUnit || '', price: db.orderPrice || 0,
    });
  });
  return items;
}

async function hanosAddSingle(orderCode, name) {
  const db = lookupIngredient(name);
  if (!db) return;

  const key = name.toLowerCase().trim();
  const row = document.querySelector(`[data-combined-key="${key}"]`);
  let quantity = 1;
  if (row) {
    const neededGrams = parseFloat(row.dataset.needed) || 0;
    const dbStock = getDbStockTotal(db);
    const hasManual = combinedOrderStock[key] !== undefined;
    const effectiveStock = hasManual ? (parseFloat(combinedOrderStock[key]) || 0) : dbStock;
    const hasStockValue = hasManual || dbStock > 0;
    const toOrderGrams = hasStockValue ? Math.max(0, neededGrams - effectiveStock) : neededGrams;
    const calc = calcOrderUnits(toOrderGrams, db);
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

function hanosConfirmBulk(storageCat) {
  const items = collectHanosItems(storageCat);
  if (!items.length) { toast('No items with order codes and quantities to send'); return; }
  showHanosConfirmModal(items, storageCat, 'combined');
}

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

    const amtNeeded = parseFloat(row.dataset.needed) || 0;
    const dbUnit = row.dataset.unit || 'g';
    const dbStock = getDbStockTotal(db);
    const hasManual = orderInventory[key] !== undefined;
    const effectiveStock = hasManual ? (parseFloat(orderInventory[key]) || 0) : dbStock;
    const hasStockValue = hasManual || dbStock > 0;
    const toOrder = hasStockValue ? Math.max(0, amtNeeded - effectiveStock) : amtNeeded;
    const orderAmtGrams = toGrams(toOrder, dbUnit);
    const calc = calcOrderUnits(orderAmtGrams, db);
    if (!calc || calc.units <= 0) return;

    items.push({
      name: db.name, orderCode: db.orderCode, quantity: calc.units,
      unit: 'ST', unitLabel: db.orderUnit || '', price: db.orderPrice || 0,
    });
  });
  return items;
}

function hanosConfirmBulkBatches(storageCat) {
  const items = collectHanosBatchItems(storageCat);
  if (!items.length) { toast('No items with order codes and quantities to send'); return; }
  showHanosConfirmModal(items, storageCat, 'batches');
}

function showHanosConfirmModal(items, storageCat, source) {
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
      if (resp.failed === 0) toast(`All ${resp.ok} items added to Hanos cart`);
      else { toast(`${resp.ok} added, ${resp.failed} failed`, true); console.warn('Hanos bulk results:', resp.results); }
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

  db.orderAmount = grams;
  db.unitRecalc = grams;

  try {
    await apiPost(`/api/ingredients/${ingredientId}`, { ...db, orderAmountGrams: grams });
    toast(`Saved ${grams}g per piece for ${db.name}`);
    renderOrders();
  } catch (e) {
    toast('Failed to save: ' + e.message, true);
  }
}

// ── Stock update helpers ─────────────────────────────────

function toggleOrderSection(key) { S.orderToggles[key] = !S.orderToggles[key]; renderOrders(); }

let _stockSaveTimeout = null;
function persistIngredientStock(ingredientName, amount) {
  const db = lookupIngredient(ingredientName);
  if (!db || !db.id) return;
  const loc = S.currentLoc || 'west';
  const amountNum = parseFloat(amount) || 0;

  if (!db.stock) db.stock = {};
  db.stock[loc] = { amount: amountNum, date: new Date().toISOString().slice(0, 10) };

  if (typeof ingredientDbFull !== 'undefined') {
    const full = ingredientDbFull.find(i => i.id === db.id);
    if (full) {
      if (!full.stock) full.stock = {};
      full.stock[loc] = { amount: amountNum, date: new Date().toISOString().slice(0, 10) };
    }
  }

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
  if (val === '' || val === null) delete combinedOrderStock[key];
  else combinedOrderStock[key] = parseFloat(val) || 0;

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
  if (val === '' || val === null) delete orderInventory[key];
  else orderInventory[key] = parseFloat(val) || 0;

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
