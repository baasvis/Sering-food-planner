// ── STANDARD INVENTORY — API + tab render + actions ──

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
  list.push({ id: newId(), name, amount: 0, unit: 'units' });
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

function updateSiAmount(idx, val, isOrderUnits) {
  const loc = currentOrdersLoc || 'west';
  const list = standardInventory[loc] || [];
  if (list[idx]) {
    list[idx].amount = parseFloat(val) || 0;
    if (isOrderUnits) list[idx].unit = 'units';
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

// ── Standard Inventory tab render ─────────────────────────

function renderStandardInventoryTab() {
  const curLoc = currentOrdersLoc || 'west';
  const siItems = standardInventory[curLoc] || [];

  const ingList = siItems.map((item, idx) => {
    const db = lookupIngredient(item.name);
    const unitGrams = db ? (db.unitRecalc || db.orderAmount || 0) : 0;
    const isLegacy = item.unit && item.unit !== 'units' && item.unit.toLowerCase() !== 'units';
    let orderUnits, amtGrams;
    if (isLegacy && unitGrams > 0) {
      amtGrams = toGrams(item.amount || 0, item.unit);
      orderUnits = Math.ceil(amtGrams / unitGrams);
    } else {
      orderUnits = item.amount || 0;
      amtGrams = orderUnits * unitGrams;
    }
    return {
      ...item, idx, db, orderUnits, unitGrams, amountInGrams: amtGrams,
      supplier: normalizeSupplier((db && db.source) || ''),
      orderCode: db ? db.orderCode : '',
    };
  });

  let totalValue = 0;
  ingList.forEach(ing => {
    if (ing.db && ing.db.orderPrice && ing.orderUnits > 0) totalValue += ing.orderUnits * ing.db.orderPrice;
  });

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
          <th>Ingredient</th><th>Category</th><th>Storage</th><th>Order code</th>
          <th>Unit / Price</th><th>Order units / week</th><th>Total weight</th><th></th>
        </tr></thead><tbody>`;

      items.forEach(ing => {
        const db = ing.db;
        const isUrl = ing.orderCode && (ing.orderCode.startsWith('http') || ing.orderCode.startsWith('www'));
        let codeDisplay;
        if (!db) codeDisplay = '<span style="color:var(--red);font-size:10px;opacity:.7;">not in DB</span>';
        else if (!ing.orderCode) codeDisplay = '<span style="color:var(--text2);font-size:11px;">\u2014</span>';
        else if (isUrl) codeDisplay = `<a href="${esc(ing.orderCode.startsWith('http') ? ing.orderCode : 'https://'+ing.orderCode)}" target="_blank" rel="noopener" style="font-size:11px;color:var(--blue);">Order link \u2197</a>`;
        else codeDisplay = `<span class="order-code">${esc(ing.orderCode)}</span>`;

        const orderUnitLabel = db && db.orderUnit ? esc(db.orderUnit) : '';
        const unitPrice = db ? (orderUnitLabel || 'unit') + (db.orderPrice ? ' \u00B7 \u20AC' + Number(db.orderPrice).toFixed(2) : '') : '';

        const totalWeightDisplay = ing.amountInGrams > 0
          ? `<span class="order-units">${formatGrams(ing.amountInGrams).amount} ${formatGrams(ing.amountInGrams).unit}</span>`
          : (ing.orderUnits > 0 && !ing.unitGrams ? '<span style="color:var(--text2);font-size:10px;">no weight/unit</span>' : '<span style="color:var(--text2);font-size:11px;">\u2014</span>');

        itemsHtml += `<tr>
          <td style="font-weight:500;cursor:pointer;text-decoration:underline dotted;text-underline-offset:3px;" onclick="openIngredientModal('${esc(ing.name)}')">${esc(ing.name)}</td>
          <td style="font-size:12px;">${db && db.category ? esc(db.category) : '\u2014'}</td>
          <td>${renderStorageBadge(db)}</td>
          <td>${codeDisplay}</td>
          <td style="font-size:12px;">${unitPrice}</td>
          <td style="white-space:nowrap;">
            <input class="order-stock-input" type="number" min="0" step="1" value="${ing.orderUnits > 0 ? ing.orderUnits : ''}" placeholder="0" style="width:55px;" oninput="updateSiAmount(${ing.idx}, this.value, true)" />
            <span class="order-units" style="margin-left:2px;">x ${orderUnitLabel || 'units'}</span>
          </td>
          <td>${totalWeightDisplay}</td>
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
