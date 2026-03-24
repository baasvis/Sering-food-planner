// ── DISH LIST ─────────────────────────────────────────────
let dishSort = { col: 'default', dir: 'asc' };

function renderDishesOverview() {
  const f = S.filters;
  const filtered = S.batches.filter(d => {
    if (f.loc !== 'all') {
      const ml = d.location === f.loc;
      const sl = (d.services || []).some(s => s.loc === f.loc);
      if (!ml && !sl) return false;
    }
    if (f.storage !== 'all' && d.storage !== f.storage) return false;
    if (f.inTransit !== 'all') {
      const wantTransit = f.inTransit === 'true';
      if (!!d.inTransit !== wantTransit) return false;
    }
    return true;
  });

  // Sort
  const sorted = dishSort.col === 'default' ? filtered : [...filtered].sort((a, b) => {
    let va, vb;
    switch (dishSort.col) {
      case 'name': va = a.name.toLowerCase(); vb = b.name.toLowerCase(); break;
      case 'date':
        va = a.cookDate ? cookDateSortVal(a.cookDate) : '9999';
        vb = b.cookDate ? cookDateSortVal(b.cookDate) : '9999';
        break;
      case 'type': va = a.type || ''; vb = b.type || ''; break;
      case 'stock': va = a.stock || 0; vb = b.stock || 0; break;
      case 'diff':
        va = diffStr(a).diff; vb = diffStr(b).diff;
        break;
      default: va = 0; vb = 0;
    }
    if (va < vb) return dishSort.dir === 'asc' ? -1 : 1;
    if (va > vb) return dishSort.dir === 'asc' ? 1 : -1;
    return 0;
  });

  const arrow = (col) => dishSort.col === col ? (dishSort.dir === 'asc' ? ' ▲' : ' ▼') : '';
  const sCls = (col) => `sortable${dishSort.col === col ? ' active' : ''}`;

  const html = `
  <div class="btn-row" style="margin-bottom:12px;">
    <button class="btn btn-primary" onclick="openNewDish()">+ New batch</button>
  </div>
  <div class="filter-bar">
    <div style="display:flex;gap:4px;flex-wrap:wrap;">
      <button class="fc ${f.loc === 'all' ? 'on' : ''}" onclick="setFilter('loc','all')">All locations</button>
      <button class="fc ${f.loc === 'west' ? 'on' : ''}" onclick="setFilter('loc','west')">Sering West</button>
      <button class="fc ${f.loc === 'centraal' ? 'on' : ''}" onclick="setFilter('loc','centraal')">Sering Centraal</button>
    </div>
    <div class="filter-sep"></div>
    <div style="display:flex;gap:4px;flex-wrap:wrap;">
      <button class="fc ${f.storage === 'all' ? 'on' : ''}" onclick="setFilter('storage','all')">All storage</button>
      ${STORAGE.map(s => `<button class="fc ${f.storage === s ? 'on' : ''}" onclick="setFilter('storage','${s}')">${s}</button>`).join('')}
    </div>
    <div class="filter-sep"></div>
    <div style="display:flex;gap:4px;flex-wrap:wrap;">
      <button class="fc ${f.inTransit === 'all' ? 'on' : ''}" onclick="setFilter('inTransit','all')">All</button>
      <button class="fc ${f.inTransit === 'false' ? 'on' : ''}" onclick="setFilter('inTransit','false')">At location</button>
      <button class="fc ${f.inTransit === 'true' ? 'on' : ''}" onclick="setFilter('inTransit','true')">In transit</button>
    </div>
  </div>
  <div style="display:flex;gap:12px;font-size:10px;color:var(--text3);margin-bottom:8px;padding:4px 0;">
    <span><span style="display:inline-block;width:10px;height:10px;background:#BA7517;border-radius:2px;vertical-align:middle;margin-right:3px;"></span>At West</span>
    <span><span style="display:inline-block;width:10px;height:10px;background:#0F6E56;border-radius:2px;vertical-align:middle;margin-right:3px;"></span>At Centraal</span>
    <span><span style="display:inline-block;width:10px;height:10px;background:#97C459;border-radius:2px;vertical-align:middle;margin-right:3px;"></span>Transport → Centraal</span>
    <span><span style="display:inline-block;width:10px;height:10px;background:#EF9F27;border-radius:2px;vertical-align:middle;margin-right:3px;"></span>Transport → West</span>
  </div>
  <div id="split-bar-area"></div>
  <div style="display:flex;gap:8px;align-items:center;font-size:12px;color:var(--text2);margin-bottom:8px;">
    <span>${sorted.length} batch${sorted.length !== 1 ? 'es' : ''}</span>
    <span style="margin-left:auto;">Sort:</span>
    <button class="fc ${dishSort.col === 'name' ? 'on' : ''}" onclick="dishSortBy('name')">Name${arrow('name')}</button>
    <button class="fc ${dishSort.col === 'date' ? 'on' : ''}" onclick="dishSortBy('date')">Cook date${arrow('date')}</button>
    <button class="fc ${dishSort.col === 'stock' ? 'on' : ''}" onclick="dishSortBy('stock')">Stock${arrow('stock')}</button>
    <button class="fc ${dishSort.col === 'diff' ? 'on' : ''}" onclick="dishSortBy('diff')">+/-${arrow('diff')}</button>
  </div>
  ${sorted.length === 0 ? '<div class="empty">No batches match these filters</div>' : (dishSort.col !== 'default' ? sorted.map(d => renderBatchTile(d)).join('') : renderDishGroups(sorted))}`;

  document.getElementById('planner-content').innerHTML = html;
  renderSplitBar();
}

function dishSortBy(col) {
  if (dishSort.col === col) {
    if (dishSort.dir === 'asc') dishSort.dir = 'desc';
    else { dishSort.col = 'default'; dishSort.dir = 'asc'; } // third click resets
  } else {
    dishSort.col = col;
    dishSort.dir = col === 'stock' || col === 'diff' ? 'desc' : 'asc';
  }
  rerenderCurrentView();
}

function cookDateSortVal(ddmmyyyy) {
  if (!ddmmyyyy) return '9999-99-99';
  const parts = ddmmyyyy.split('/');
  if (parts.length === 3) return parts[2] + '-' + parts[1] + '-' + parts[0];
  return ddmmyyyy;
}

function renderDishGroups(dishes) {
  const toCook = dishes.filter(d => !isBatchCooked(d) && d.storage !== 'Frozen');
  const cooked = dishes.filter(d => isBatchCooked(d) && d.storage !== 'Frozen');
  const frozen = dishes.filter(d => d.storage === 'Frozen');

  let html = '';

  if (toCook.length) {
    html += `<div class="dish-section-hdr"><div class="dish-section-dot" style="background:var(--amber);"></div>To cook <span class="dish-section-count">(${toCook.length})</span></div>`;
    html += toCook.map(d => renderBatchTile(d)).join('');
  }

  if (cooked.length) {
    html += `<div class="dish-section-hdr"><div class="dish-section-dot" style="background:var(--green);"></div>Cooked <span class="dish-section-count">(${cooked.length})</span></div>`;
    html += cooked.map(d => renderBatchTile(d)).join('');
  }

  if (frozen.length) {
    html += `<div class="dish-section-hdr"><div class="dish-section-dot" style="background:var(--blue);"></div>Frozen <span class="dish-section-count">(${frozen.length})</span></div>`;
    html += frozen.map(d => renderBatchTile(d)).join('');
  }

  return html;
}

function deleteBatch(id) {
  const d = S.batches.find(x => x.id === id);
  if (!d) return;
  if (isBatchCooked(d)) {
    toast('Cannot delete a cooked batch — serve it first');
    return;
  }
  S.batches = S.batches.filter(x => x.id !== id);
  S.expandedBatches.delete(id);
  S.selected.delete(id);
  rebuildPlanner();
  scheduleSave();
  rerenderCurrentView();
  toast(esc(d.name) + ' deleted');
}

function setFilter(group, val) { S.filters[group] = val; S.selected.clear(); rerenderCurrentView(); }
function toggleSelect(id) { if (S.selected.has(id)) S.selected.delete(id); else S.selected.add(id); rerenderCurrentView(); }

function calcRequiredForLoc(dish, loc) {
  let total = 0;
  (dish.services || []).forEach(svc => {
    if (svc.loc !== loc) return;
    const g = getGuests(svc.loc, svc.date, svc.meal);
    const k = `${svc.loc}-${svc.date}-${svc.meal}`;
    const peers = (S.planner[k] || []).filter(d => d.type === dish.type);
    const count = Math.max(peers.length, 1);
    total += (g / count) * ((dish.serving || 280) / 1000);
  });
  return Math.round(total * 10) / 10;
}

function renderSplitBar() {
  const area = document.getElementById('split-bar-area');
  if (!area || S.selected.size === 0) { if (area) area.innerHTML = ''; return; }
  const selD = [...S.selected].map(id => S.batches.find(d => d.id === id)).filter(Boolean);
  const names = selD.map(d => d.name).join(', ');
  const hasWest = selD.some(d => d.location === 'west' && !d.inTransit);
  const hasCentraal = selD.some(d => d.location === 'centraal' && !d.inTransit);

  // Calculate smart amounts for transport splits (capped at surplus)
  let smartCentraalAmt = 0;
  let smartWestAmt = 0;
  selD.forEach(d => {
    if (d.location === 'west' && !d.inTransit) {
      const neededHere = calcRequiredForLoc(d, 'west');
      const surplus = Math.max(0, d.stock - neededHere);
      const neededThere = calcRequiredForLoc(d, 'centraal');
      smartCentraalAmt += Math.min(neededThere, surplus);
    }
    if (d.location === 'centraal' && !d.inTransit) {
      const neededHere = calcRequiredForLoc(d, 'centraal');
      const surplus = Math.max(0, d.stock - neededHere);
      const neededThere = calcRequiredForLoc(d, 'west');
      smartWestAmt += Math.min(neededThere, surplus);
    }
  });
  smartCentraalAmt = Math.round(smartCentraalAmt * 10) / 10;
  smartWestAmt = Math.round(smartWestAmt * 10) / 10;

  area.innerHTML = `<div class="split-bar">
    <span class="sbar-title">Split stock</span>
    <span style="font-size:12px;color:var(--text2);flex:1;min-width:60px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(names)}</span>
    <label>Amount (L)</label><input type="number" id="sp-amt" min="0.1" step="0.5" value="10" style="width:68px;"/>
    <label>Storage</label><select id="sp-storage">${STORAGE.map(s => `<option>${s}</option>`).join('')}</select>
    <label>Location</label><select id="sp-location">${LOCATIONS.map(l => `<option value="${l}">${l === 'west' ? 'Sering West' : 'Sering Centraal'}</option>`).join('')}</select>
    <button class="btn btn-primary" onclick="doSplit(false)">Split off</button>
    ${hasWest ? `<button class="btn btn-purple" onclick="doTransportSplit('centraal',${smartCentraalAmt})">Split ${smartCentraalAmt}L &rarr; Centraal</button>` : ''}
    ${hasCentraal ? `<button class="btn btn-purple" onclick="doTransportSplit('west',${smartWestAmt})">Split ${smartWestAmt}L &rarr; West</button>` : ''}
    <button class="btn" onclick="S.selected.clear();rerenderCurrentView()">Cancel</button>
  </div>`;
}

function doSplit(isTransport, targetLoc, smartAmounts) {
  const manualAmt = parseFloat(document.getElementById('sp-amt').value);
  const defaultStorage = document.getElementById('sp-storage').value;
  const splitLocation = isTransport ? targetLoc : document.getElementById('sp-location').value;
  const splitInTransit = isTransport ? true : false;
  let errors = [];
  [...S.selected].forEach(id => {
    const d = S.batches.find(x => x.id === id);
    if (!d) return;
    // Inherit storage from source dish (frozen stays frozen)
    const storage = isTransport ? (d.storage || defaultStorage) : defaultStorage;
    // Calculate how much is needed at the current location
    const currentLoc = d.location || 'west';
    const neededHere = calcRequiredForLoc(d, currentLoc);
    // Surplus = what can be split off (never more than stock minus local need)
    const surplus = Math.max(0, Math.round((d.stock - neededHere) * 10) / 10);
    // For transport splits, calculate per-dish amount based on target location needs
    let amt;
    if (isTransport && smartAmounts) {
      const targetLocKey = targetLoc === 'centraal' ? 'centraal' : 'west';
      amt = calcRequiredForLoc(d, targetLocKey);
      if (amt <= 0) { errors.push(`"${d.name}" has no services at ${targetLoc}`); return; }
    } else {
      amt = manualAmt;
    }
    if (!amt || amt <= 0) return;
    // Cap at surplus — can't split off more than what's not needed here
    if (amt > surplus) {
      if (surplus <= 0) { errors.push(`"${d.name}" needs all ${d.stock}L at ${d.location === 'centraal' ? 'Sering Centraal' : 'Sering West'} (${neededHere}L required)`); return; }
      amt = surplus;
    }
    d.stock = Math.round((d.stock - amt) * 10) / 10;
    const targetLocName = targetLoc === 'centraal' ? 'centraal' : 'west';
    const newDish = {
      id: newId(), name: d.name, type: d.type, storage, location: splitLocation, inTransit: splitInTransit, stock: amt,
      serving: d.serving || 280, recipeSheetId: d.recipeSheetId,
      recipeVolume: d.recipeVolume,
      recipeIngredients: d.recipeIngredients ? [...d.recipeIngredients] : undefined,
      allergens: [...(d.allergens || [])], extraAllergens: [...(d.extraAllergens || [])],
      orderFor: false, parentId: d.id, cookDate: d.cookDate,
      services: isTransport ? ((d.services || []).filter(s => s.loc === targetLocName)) : []
    };
    if (isTransport) d.services = (d.services || []).filter(s => s.loc !== targetLocName);
    S.batches.push(newDish);
  });
  if (errors.length) { alert('Cannot split: ' + errors.join(', ')); return; }
  S.selected.clear(); rebuildPlanner(); rerenderCurrentView(); scheduleSave();
  toast('Stock split created');
}
function doTransportSplit(tl, smartAmt) { doSplit(true, tl, true); }

// ── NEW DISH ──────────────────────────────────────────────
function openNewDish() {
  searchNewDishModal();
}

function searchNewDishModal() {
  const searchQuery = (document.getElementById('new-dish-search') || {}).value || '';
  let recipes = S.recipeIndex;
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    recipes = recipes.filter(r => r.name.toLowerCase().includes(q));
  }
  const recipeList = recipes.length > 0
    ? recipes.slice(0, 20).map(r => {
      const ags = (r.allergens||[]).slice(0,3).map(a => `<span class="allergen-pill">${esc(a)}</span>`).join('');
      return `<div class="dish-opt" onclick="addDishFromRecipe('${r.id}');closeModal();">
        <div><span style="font-weight:500;">${esc(r.name)}</span> ${typeBadge(r.type||'Soup')} ${ags}</div>
        <div style="font-size:11px;color:var(--text2);">${r.costPerServing || ''}</div>
      </div>`;
    }).join('')
    : `<div class="empty" style="padding:12px;">${S.recipeIndex.length === 0 ? 'No recipes in index yet. Add some in the Recipes tab.' : 'No recipes match "' + esc(searchQuery) + '"'}</div>`;

  // If modal already open, only update the list
  const existingList = document.getElementById('new-dish-list');
  if (existingList) {
    existingList.innerHTML = recipeList;
    return;
  }

  showModal(`<h3>Add batch to menu</h3>
    <div style="font-size:12px;color:var(--text2);margin-bottom:10px;">Pick from your recipe index:</div>
    <input type="text" class="dish-search" id="new-dish-search" placeholder="Search recipes..." value="${esc(searchQuery)}"
      oninput="searchNewDishModal()" autofocus />
    <div class="dish-opts-list" style="max-height:260px;" id="new-dish-list">${recipeList}</div>
    <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border);">
      <div style="font-size:12px;color:var(--text2);margin-bottom:8px;">Or create from scratch:</div>
      <button class="btn" onclick="openNewDishScratch()">Create blank batch</button>
    </div>
    <div class="modal-actions"><button class="btn" onclick="closeModal()">Close</button></div>`);
}

function openNewDishScratch() {
  showModal(`<h3>New batch</h3>
    <div class="fr"><label>Name</label><input type="text" id="nd-name" placeholder="e.g. Mushroom soup" /></div>
    <div class="fr"><label>Type</label><select id="nd-type">
      <option>Soup</option><option>Main course</option><option>Dessert</option>
    </select></div>
    <div class="fr"><label>Stock (liters)</label><input type="number" id="nd-stock" value="0" step="0.5" min="0" /></div>
    <div class="fr"><label>Serving size (ml per guest)</label><input type="number" id="nd-serving" value="280" /></div>
    <div class="fr"><label>Storage state</label><select id="nd-storage">${STORAGE.map(s => `<option>${s}</option>`).join('')}</select></div>
    <div class="fr"><label>Location</label><select id="nd-location">${LOCATIONS.map(l => `<option value="${l}">${l === 'west' ? 'Sering West' : 'Sering Centraal'}</option>`).join('')}</select></div>
    <div class="fr"><label>Recipe Google Sheet ID (optional)</label>
      <input type="text" id="nd-sheetid" placeholder="Paste the sheet ID from the URL" />
      <div style="font-size:11px;color:var(--text2);margin-top:4px;">Found in the sheet URL: /spreadsheets/d/<strong>THIS_PART</strong>/edit</div>
    </div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveNewDish()">Create batch</button>
    </div>`);
}

async function saveNewDish() {
  const name = document.getElementById('nd-name').value.trim();
  if (!name) { alert('Please enter a batch name'); return; }
  const sheetId = document.getElementById('nd-sheetid').value.trim();
  const newDish = {
    id: newId(), name,
    type: document.getElementById('nd-type').value,
    stock: parseFloat(document.getElementById('nd-stock').value) || 0,
    serving: parseInt(document.getElementById('nd-serving').value) || 280,
    storage: document.getElementById('nd-storage').value,
    location: document.getElementById('nd-location').value,
    inTransit: false,
    recipeSheetId: sheetId || null,
    allergens: [], extraAllergens: [], orderFor: false, parentId: null,
    cookDate: null, services: []
  };
  if (sheetId) {
    try {
      const recipe = await apiGet(`/api/recipe?sheetId=${sheetId}`);
      if (recipe.allergens) newDish.allergens = recipe.allergens;
      if (recipe.serving) newDish.serving = recipe.serving;
      if (recipe.recipeVolume) newDish.recipeVolume = recipe.recipeVolume;
      if (recipe.ingredients) newDish.recipeIngredients = recipe.ingredients;
      toast('Recipe data loaded from Google Sheet');
    } catch (e) { toastError('Could not fetch recipe: ' + e.message); }
  }
  S.batches.push(newDish);
  closeModal(); rebuildPlanner(); rerenderCurrentView(); scheduleSave();
  toast(`"${name}" added`);
}

// ── EDIT DISH ─────────────────────────────────────────────
function openEditDish(id) {
  const d = S.batches.find(x => x.id === id);
  if (!d) return;
  const allAg = [...(d.allergens || []), ...(d.extraAllergens || [])];
  const agHtml = allAg.map(a => {
    const isBase = (d.allergens || []).includes(a);
    return `<div class="at-tag">${esc(a)}${isBase ? ` <span style="opacity:.4;font-size:9px;">base</span>` : ` <span class="at-rm" onclick="removeExtraAllergen('${id}','${esc(a)}')">&#215;</span>`}</div>`;
  }).join('');
  const cookModeDay = d.cookMode !== 'date';
  showModal(`<h3>Edit &mdash; ${esc(d.name)}</h3>
    <div class="fr"><label>Name</label><input type="text" id="ed-name" value="${esc(d.name)}" /></div>
    <div class="fr"><label>Stock (liters)</label><input type="number" id="ed-stock" value="${d.stock || 0}" step="0.5" min="0" /></div>
    <div class="fr"><label>Type</label><select id="ed-type">
      ${['Soup','Main course','Dessert'].map(t => `<option${d.type === t ? ' selected' : ''}>${t}</option>`).join('')}
    </select></div>
    <div class="fr"><label>Storage state</label><select id="ed-storage">
      ${STORAGE.map(s => `<option${d.storage === s ? ' selected' : ''}>${s}</option>`).join('')}
    </select></div>
    <div class="fr"><label>Location</label><select id="ed-location">
      ${LOCATIONS.map(l => `<option value="${l}"${d.location === l ? ' selected' : ''}>${l === 'west' ? 'Sering West' : 'Sering Centraal'}</option>`).join('')}
    </select></div>
    <div class="fr"><label>In transit?</label><select id="ed-intransit">
      <option value="false"${!d.inTransit ? ' selected' : ''}>No — at location</option>
      <option value="true"${d.inTransit ? ' selected' : ''}>Yes — in transport</option>
    </select></div>
    <div class="fr"><label>Cook date / day</label>
      <div class="cook-toggle">
        <button id="ct-day" class="${cookModeDay ? 'active' : ''}" onclick="setCookMode('${id}','day')">Plan a day</button>
        <button id="ct-date" class="${!cookModeDay ? 'active' : ''}" onclick="setCookMode('${id}','date')">Actual date</button>
      </div>
      <div id="cook-input">${cookModeDay
        ? `<select id="ed-cookday">${['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(day => `<option${d.cookDay === day ? ' selected' : ''}>${day}</option>`).join('')}</select>`
        : `<input type="date" id="ed-cookdate" value="${d.cookDate || ''}" />`}
      </div>
    </div>
    <div class="fr"><label>Allergens</label>
      <div class="allergen-tags" id="ag-tags">${agHtml || '<span style="font-size:12px;color:var(--text3);">none</span>'}</div>
      <div class="allergen-input-row">
        <input type="text" id="ag-new" placeholder="Add allergen&hellip;" onkeydown="if(event.key==='Enter')addExtraAllergen('${id}')" />
        <button class="btn btn-sm" onclick="addExtraAllergen('${id}')">Add</button>
      </div>
      <div class="modal-note">Allergens marked "base" come from the recipe sheet.</div>
    </div>
    <div class="fr"><label>Include in order list?</label>
      <select id="ed-order">
        <option value="true"${d.orderFor ? ' selected' : ''}>Yes &mdash; include in order list</option>
        <option value="false"${!d.orderFor ? ' selected' : ''}>No</option>
      </select>
    </div>
    ${d.recipeSheetId ? `<div class="modal-note">Recipe sheet linked. <button class="btn btn-sm" onclick="refreshRecipe('${id}')">Refresh from sheet</button></div>` : ''}
    <div class="modal-actions">
      <button class="btn btn-danger btn-sm" onclick="deleteDish('${id}')">Delete</button>
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveEditDish('${id}')">Save</button>
    </div>`);
}

function setCookMode(id, mode) {
  const d = S.batches.find(x => x.id === id); if (!d) return;
  d.cookMode = mode;
  document.getElementById('ct-day').classList.toggle('active', mode === 'day');
  document.getElementById('ct-date').classList.toggle('active', mode === 'date');
  document.getElementById('cook-input').innerHTML = mode === 'day'
    ? `<select id="ed-cookday">${['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(day => `<option${d.cookDay === day ? ' selected' : ''}>${day}</option>`).join('')}</select>`
    : `<input type="date" id="ed-cookdate" value="${d.cookDate || ''}" />`;
}

function addExtraAllergen(id) {
  const d = S.batches.find(x => x.id === id); if (!d) return;
  const inp = document.getElementById('ag-new');
  const val = (inp.value || '').trim(); if (!val) return;
  if (!d.extraAllergens) d.extraAllergens = [];
  if (!d.extraAllergens.includes(val) && !(d.allergens || []).includes(val)) d.extraAllergens.push(val);
  inp.value = '';
  refreshAllergenTags(d);
}

function removeExtraAllergen(id, allergen) {
  const d = S.batches.find(x => x.id === id); if (!d) return;
  d.extraAllergens = (d.extraAllergens || []).filter(a => a !== allergen);
  refreshAllergenTags(d);
}

function refreshAllergenTags(d) {
  const allAg = [...(d.allergens || []), ...(d.extraAllergens || [])];
  document.getElementById('ag-tags').innerHTML = allAg.map(a => {
    const isBase = (d.allergens || []).includes(a);
    return `<div class="at-tag">${esc(a)}${isBase ? ` <span style="opacity:.4;font-size:9px;">base</span>` : ` <span class="at-rm" onclick="removeExtraAllergen('${d.id}','${esc(a)}')">&#215;</span>`}</div>`;
  }).join('') || '<span style="font-size:12px;color:var(--text3);">none</span>';
}

async function refreshRecipe(id) {
  const d = S.batches.find(x => x.id === id); if (!d || !d.recipeSheetId) return;
  try {
    const recipe = await apiGet(`/api/recipe?sheetId=${d.recipeSheetId}`);
    if (recipe.allergens) d.allergens = recipe.allergens;
    if (recipe.recipeVolume) d.recipeVolume = recipe.recipeVolume;
    if (recipe.ingredients) d.recipeIngredients = recipe.ingredients;
    scheduleSave();
    closeModal(); openEditDish(id);
    toast('Recipe refreshed from Google Sheet');
  } catch (e) { toastError('Could not fetch recipe: ' + e.message); }
}

function saveEditDish(id) {
  const d = S.batches.find(x => x.id === id); if (!d) return;
  d.name = document.getElementById('ed-name').value;
  d.stock = parseFloat(document.getElementById('ed-stock').value) || 0;
  d.type = document.getElementById('ed-type').value;
  d.storage = document.getElementById('ed-storage').value;
  d.location = document.getElementById('ed-location').value;
  d.inTransit = document.getElementById('ed-intransit').value === 'true';
  d.orderFor = document.getElementById('ed-order').value === 'true';
  if (d.cookMode === 'day') { const el = document.getElementById('ed-cookday'); if (el) d.cookDay = el.value || null; }
  else { const el = document.getElementById('ed-cookdate'); if (el) d.cookDate = el.value || null; }
  closeModal(); rebuildPlanner(); rerenderCurrentView(); scheduleSave();
  toast('Batch saved');
}

function deleteDish(id) {
  if (!confirm('Delete this batch? This cannot be undone.')) return;
  S.batches = S.batches.filter(d => d.id !== id);
  closeModal(); rebuildPlanner(); rerenderCurrentView(); scheduleSave();
  toast('Batch deleted');
}
