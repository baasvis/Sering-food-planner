// ── ORDER OVERVIEW ────────────────────────────────────────

// In-stock amounts entered by cook (keyed by ingredient name lowercase)
let orderInventory = {};

function lookupIngredient(name) {
  if (!S.ingredientDb.length || !name) return null;
  const q = name.toLowerCase().trim();
  // Exact match first
  let match = S.ingredientDb.find(i => i.name.toLowerCase().trim() === q);
  if (match) return match;
  // Try without parenthetical qualifiers: "potato (slightly starchy)" matches "potato"
  // But prefer the other direction: recipe says "onion", DB has "onion (yellow)"
  match = S.ingredientDb.find(i => {
    const dn = i.name.toLowerCase().trim();
    // DB name starts with recipe name (e.g. DB:"Sunflower oil (1L)" matches recipe:"Sunflower oil")
    return dn.startsWith(q) || q.startsWith(dn);
  });
  if (match) return match;
  // Try matching the base name (before any parenthesis)
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

function renderOrders() {
  // If ingredient DB hasn't loaded yet, wait and retry
  if (!ingredientDbLoaded) {
    document.getElementById('screen-orders').innerHTML = '<div class="empty">Loading ingredient database...</div>';
    setTimeout(renderOrders, 500);
    return;
  }

  const orderedDishes = S.dishes.filter(d => d.orderFor);
  const shortfall = S.dishes.filter(d => d.stock < calcRequired(d) && calcRequired(d) > 0);

  // Combine ingredients across all ordered dishes
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

  // Enrich with ingredient DB data
  function normalizeSupplier(s) {
    if (!s) return 'Unknown';
    return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  }
  function toGrams(amount, unit) {
    const u = (unit || '').toLowerCase().replace(/'/g, '');
    if (u === 'kilos' || u === 'kilo' || u === 'kg') return amount * 1000;
    if (u === 'liters' || u === 'liter' || u === 'litres' || u === 'l') return amount * 1000;
    return amount;
  }
  const ingList = Object.values(combined).map(ing => {
    const db = lookupIngredient(ing.name);
    const amtInGrams = toGrams(ing.amount, ing.unit);
    return {
      ...ing,
      db,
      amountInGrams: amtInGrams,
      supplier: normalizeSupplier((db && db.source) || ing.source || ''),
      orderCode: db ? db.orderCode : '',
      orderType: db ? db.orderType : '',
      orderCalc: db ? calcOrderUnits(amtInGrams, db) : null,
      storageLocation: db ? db.storageLocation : '',
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  // Group by supplier
  const bySupplier = {};
  ingList.forEach(ing => {
    const s = ing.supplier;
    if (!bySupplier[s]) bySupplier[s] = [];
    bySupplier[s].push(ing);
  });
  // Sort suppliers: Hanos first, then alphabetical
  const supplierOrder = Object.keys(bySupplier).sort((a, b) => {
    if (a.toLowerCase().includes('hanos')) return -1;
    if (b.toLowerCase().includes('hanos')) return 1;
    return a.localeCompare(b);
  });

  let html = '';

  // Shortfall section
  html += `<div style="margin-bottom:20px;"><div class="section-title">Stock shortfall &mdash; needs cooking or restock</div>`;
  if (!shortfall.length) html += `<div class="empty" style="color:var(--green);">All dishes have sufficient stock</div>`;
  else html += shortfall.map(d => {
    const req = calcRequired(d); const { str } = diffStr(d);
    return `<div class="order-shortfall-row">
      <div style="font-weight:600;">${esc(d.name)} <span style="font-weight:400;color:var(--text2);font-size:12px;">&middot; ${d.logistics}</span></div>
      <div style="color:var(--red);font-weight:600;">${str}</div>
      <div style="font-size:12px;color:var(--text2);">need ${req}L</div>
    </div>`;
  }).join('');
  html += '</div>';

  // Ingredient order section
  const dishesWithSheets = orderedDishes.filter(d => d.recipeSheetId);
  html += `<div style="margin-bottom:20px;"><div class="section-title" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
    <span>Ingredient order (${orderedDishes.length} dish${orderedDishes.length !== 1 ? 'es' : ''} flagged)</span>
    <div style="display:flex;align-items:center;gap:8px;">
      <span style="font-weight:400;font-size:12px;color:var(--text2);">${orderedDishes.map(d => esc(d.name)).join(' · ')}</span>
      ${dishesWithSheets.length ? `<button class="copy-all-btn" onclick="refreshAllRecipes()">↻ Refresh recipe data</button>` : ''}
    </div>
  </div>`;

  if (!ingList.length) {
    if (orderedDishes.length === 0) {
      html += `<div class="empty">No dishes flagged for order. In Menu planner, click the order toggle on dishes you want to order ingredients for.</div>`;
    } else {
      html += `<div class="empty">Dishes are flagged but have no recipe data. Make sure they have a linked recipe sheet with ingredients.</div>`;
    }
  } else {
    // Render per supplier
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
          <th>Ingredient</th>
          <th>Amount needed</th>
          <th>Order code / link</th>
          <th>In stock</th>
          <th>To order</th>
          <th>Order units</th>
          <th>For dishes</th>
        </tr></thead><tbody>`;

      items.forEach(ing => {
        const key = ing.name.toLowerCase().trim();
        const isUrl = ing.orderCode && (ing.orderCode.startsWith('http') || ing.orderCode.startsWith('www'));
        const dbUnit = ing.unit || (ing.db && ing.db.unit) || 'g';
        const amtNeeded = Math.round(ing.amount);

        // Order code display
        let codeDisplay;
        if (!ing.db) {
          codeDisplay = '<span style="color:var(--red);font-size:10px;opacity:.7;">not in DB</span>';
        } else if (!ing.orderCode) {
          codeDisplay = '<span style="color:var(--text2);font-size:11px;">no code</span>';
        } else if (isUrl) {
          codeDisplay = `<a href="${esc(ing.orderCode.startsWith('http') ? ing.orderCode : 'https://'+ing.orderCode)}" target="_blank" rel="noopener" style="font-size:11px;color:var(--blue);">Order link ↗</a>`;
        } else {
          codeDisplay = `<span class="order-code" title="Click to select">${esc(ing.orderCode)}</span>`;
        }

        // In stock input
        const stockVal = orderInventory[key] !== undefined ? orderInventory[key] : '';
        const stockInput = `<input class="order-stock-input" type="number" min="0" step="1" value="${stockVal}" placeholder="0" oninput="updateOrderStock('${esc(key)}',this.value)" />`;

        // To order calculation
        const inStock = parseFloat(orderInventory[key]) || 0;
        const toOrder = Math.max(0, amtNeeded - inStock);
        const toOrderDisplay = orderInventory[key] !== undefined
          ? (toOrder > 0
            ? `<span class="to-order-positive">${toOrder.toLocaleString()} ${esc(dbUnit)}</span>`
            : `<span class="to-order-zero">✓ enough</span>`)
          : `<span style="color:var(--text2);font-size:11px;">enter stock →</span>`;

        // Order units (based on to-order amount, not total needed)
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
          <td style="font-size:11px;color:var(--text2);">${ing.dishes.map(n => esc(n.length > 20 ? n.slice(0,18) + '…' : n)).join(', ')}</td>
        </tr>`;
      });

      html += `</tbody></table></div></div>`;
    });
  }
  html += '</div>';

  // Show status only if there's a problem
  if (ingredientDbError || S.ingredientDb.length === 0) {
    html += `<div style="font-size:11px;color:var(--text2);margin-top:12px;padding:8px;border-top:1px solid var(--border);">
      ${ingredientDbError ? `<span style="color:var(--red);">Ingredient DB error: ${esc(ingredientDbError)}</span>` : ''}
      ${S.ingredientDb.length === 0 && !ingredientDbError ? 'Ingredient database is empty. <button class="btn btn-sm" onclick="loadIngredientDb().then(renderOrders)">Retry</button>' : ''}
    </div>`;
  }

  document.getElementById('screen-orders').innerHTML = html;
}

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
  if (items.length) {
    navigator.clipboard.writeText(items.join('\n')).then(() => toast(items.length + ' order codes copied'));
  }
}

function toggleOrderSection(key) { S.orderToggles[key] = !S.orderToggles[key]; renderOrders(); }

function updateOrderStock(key, val) {
  if (val === '' || val === null) {
    delete orderInventory[key];
  } else {
    orderInventory[key] = parseFloat(val) || 0;
  }
  // Update just the to-order and order-units cells without full re-render (to keep focus)
  // We do a lightweight re-render of the to-order cells
  const row = document.querySelector(`[data-stock-key="${key}"]`);
  if (!row) return;
  // Find the ingredient data to recalculate
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
