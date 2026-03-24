// ── WEEK PLAN (UNIFIED) ──────────────────────────────────

function renderWeekPlan() {
  const tab = S.plannerSubTab;
  const el = document.getElementById('screen-planner');
  const tabs = [
    { id: 'west', label: 'Sering West' },
    { id: 'centraal', label: 'Sering Centraal' },
    { id: 'transport', label: 'To Transport' },
    { id: 'caterings', label: 'Caterings' },
    { id: 'overview', label: 'Overview' },
  ];
  let html = `<div class="sub-tab-bar">`;
  tabs.forEach(t => {
    html += `<button class="sub-tab ${tab === t.id ? 'active' : ''}" data-tab="${t.id}" onclick="setPlannerSubTab('${t.id}')">${t.label}</button>`;
  });
  html += `</div><div id="planner-content"></div>`;
  el.innerHTML = html;
  renderPlannerSubTab();
}

function setPlannerSubTab(tab) {
  S.plannerSubTab = tab;
  document.querySelectorAll('.sub-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  renderPlannerSubTab();
}

function renderPlannerSubTab() {
  const tab = S.plannerSubTab;
  if (tab === 'west') renderLocationPlan('west');
  else if (tab === 'centraal') renderLocationPlan('centraal');
  else if (tab === 'transport') renderTransportView();
  else if (tab === 'caterings') renderCaterings();
  else if (tab === 'overview') renderDishesOverview();
}

// Dispatcher: called by dishes.js and core.js instead of old renderDishes()
function rerenderCurrentView() {
  const screen = document.querySelector('.screen.active');
  if (!screen) return;
  if (screen.id === 'screen-planner') renderPlannerSubTab();
  else if (screen.id === 'screen-dashboard') renderDashboard();
}

let _plannerDayOffset = 0;

function changePlannerDay(delta) {
  _plannerDayOffset = Math.max(-14, Math.min(14, _plannerDayOffset + delta));
  renderPlannerSubTab();
}

// ── LOCATION PLAN (West / Centraal) ─────────────────────
function renderLocationPlan(loc) {
  const typeGroups = [
    { key: 'Soup', label: 'Soups', cls: 'chip-soup' },
    { key: 'Main course', label: 'Mains', cls: 'chip-main' },
    { key: 'Dessert', label: 'Desserts', cls: 'chip-dessert' },
  ];

  const days = getVisibleDays(_plannerDayOffset);
  const assigning = S.assigningBatchId;
  const assignBatch = assigning ? S.batches.find(b => b.id === assigning) : null;

  const invBtn = getInventoryButton(loc);
  let html = renderDayNav(_plannerDayOffset, -14, 14, 'changePlannerDay', '');

  // Assign mode banner
  if (assignBatch) {
    html += `<div class="assign-banner">
      <span>Click a slot to assign <strong>${esc(assignBatch.name)}</strong></span>
      <button class="btn btn-sm" onclick="cancelAssignMode()">Cancel</button>
    </div>`;
  }

  html += `<div class="btn-row" style="margin-bottom:12px;display:flex;gap:8px;align-items:center;">
    <button class="btn btn-primary" onclick="openNewDish()">+ New batch</button>
    ${invBtn}
  </div>
  <div id="split-bar-area"></div>`;

  const otherLoc = loc === 'west' ? 'centraal' : 'west';
  const otherLabel = loc === 'west' ? 'Centraal' : 'West';

  typeGroups.forEach(tg => {
    // Type section header (no collapse — dish lists moved to batch pool)
    html += `<div class="type-section">`;
    html += `<div class="type-section-hdr"><span class="type-dot ${tg.cls}"></span>${tg.label}</div>`;

    // Calendar grid for this type
    html += `<div class="week-scroll"><div class="week-grid"><div></div>`;

    // Day headers with copy button
    days.forEach(d => {
      const dispDate = `${d.date.getDate()}/${d.date.getMonth()+1}`;
      const isoDate = dateToIso(d.date);
      html += `<div class="day-hdr${d.isToday ? ' today-hdr' : ''}${d.isPast ? ' past-hdr' : ''}">${d.dayName}<span class="gt-date">${dispDate}</span><button class="copy-day-btn" onclick="event.stopPropagation();copyDayToOther('${loc}','${isoDate}')" title="Copy all ${d.dayName} batches to ${otherLabel}">&rarr; ${otherLabel}</button></div>`;
    });

    // Meal rows
    MEALS.forEach(meal => {
      const mealLabel = meal.charAt(0).toUpperCase() + meal.slice(1);
      html += `<div class="meal-lbl">${mealLabel}</div>`;
      days.forEach(d => {
        const isoDate = dateToIso(d.date);
        const k = `${loc}-${isoDate}-${meal}`;
        const slotDishes = (S.planner[k] || []).filter(dish => dish.type === tg.key);
        const slotServed = isServicePast({loc, date: isoDate, meal});
        const assignTarget = assigning ? ' slot-assign-target' : '';
        const slotClick = assigning
          ? `assignBatchToSlot('${loc}','${isoDate}','${meal}')`
          : `openAddDishTyped('${loc}','${isoDate}','${meal}','${tg.key}')`;
        html += `<div class="slot${d.isToday ? ' today' : ''}${d.isPast ? ' past-slot' : ''}${assignTarget}" onclick="${slotClick}" ondragover="slotDragOver(event)" ondragleave="slotDragLeave(event)" ondrop="slotDrop(event,'${loc}','${isoDate}','${meal}')">`;
        slotDishes.forEach(dish => {
          const trClass = dish.inTransit ? ' chip-tr-border' : '';
          const servedClass = slotServed ? ' dish-chip-served' : '';
          html += `<div class="dish-chip ${tg.cls}${trClass}${servedClass}"><span class="chip-nm">${esc(dish.name)}</span>${servedClass ? '<span class="chip-served">✓</span>' : `<span class="chip-x" onclick="event.stopPropagation();removeDishFromSlot('${dish.id}','${loc}','${isoDate}','${meal}')">&#10005;</span>`}</div>`;
        });
        if (!assigning) {
          html += `<div class="add-slot-btn" onclick="event.stopPropagation();openAddDishTyped('${loc}','${isoDate}','${meal}','${tg.key}')">+</div>`;
        }
        html += `</div>`;
      });
    });

    html += '</div></div>'; // close week-grid and week-scroll

    // Per-type batch pool directly below this type's calendar
    html += renderTypeBatchPool(loc, tg.key, tg.label, tg.cls);

    html += `</div>`; // close type-section
  });

  // ── "Show all batches" collapsible section ──────────────
  html += renderShowAllBatches(loc);

  document.getElementById('planner-content').innerHTML = html;
  renderSplitBar();
}

// ── ADD DISH MODAL ───────────────────────────────────────
function removeDishFromSlot(dishId, loc, date, meal) {
  const dish = S.batches.find(d => d.id === dishId);
  if (dish) { dish.services = (dish.services || []).filter(s => !(s.loc === loc && s.date === date && s.meal === meal)); }
  rebuildPlanner(); rerenderCurrentView(); scheduleSave();
}

function toggleTypeCollapse(key) {
  S.collapsedTypes[key] = !S.collapsedTypes[key];
  rerenderCurrentView();
}

function copyDayToOther(fromLoc, date) {
  const toLoc = fromLoc === 'west' ? 'centraal' : 'west';
  const toLabel = toLoc === 'west' ? 'Sering West' : 'Sering Centraal';
  const dayName = dateToDayName(date);
  let added = 0;
  MEALS.forEach(meal => {
    const k = `${fromLoc}-${date}-${meal}`;
    const dishes = S.planner[k] || [];
    dishes.forEach(dish => {
      const already = (dish.services || []).some(s => s.loc === toLoc && s.date === date && s.meal === meal);
      if (!already) {
        if (!dish.services) dish.services = [];
        dish.services.push({ loc: toLoc, date, meal });
        added++;
      }
    });
  });
  if (added > 0) {
    rebuildPlanner(); rerenderCurrentView(); scheduleSave();
    toast(`${added} batch${added > 1 ? 'es' : ''} copied to ${toLabel} ${dayName}`);
  } else {
    toast('All batches already assigned there');
  }
}

function copySlotToOther(fromLoc, date, meal) {
  const toLoc = fromLoc === 'west' ? 'centraal' : 'west';
  const toLabel = toLoc === 'west' ? 'Sering West' : 'Sering Centraal';
  const k = `${fromLoc}-${date}-${meal}`;
  const dishes = S.planner[k] || [];
  if (!dishes.length) return;

  let added = 0;
  dishes.forEach(dish => {
    const already = (dish.services || []).some(s => s.loc === toLoc && s.date === date && s.meal === meal);
    if (!already) {
      if (!dish.services) dish.services = [];
      dish.services.push({ loc: toLoc, date, meal });
      added++;
    }
  });

  if (added > 0) {
    rebuildPlanner(); rerenderCurrentView(); scheduleSave();
    toast(`${added} batch${added > 1 ? 'es' : ''} copied to ${toLabel} ${dateToDayName(date)} ${meal}`);
  } else {
    toast('All batches already assigned there');
  }
}

function openAddDishTyped(loc, date, meal, type) {
  const existing = (S.planner[`${loc}-${date}-${meal}`] || []).map(d => d.id);
  renderAddModal(loc, date, meal, existing, '', type, 'cooked');
}

function openAddDish(loc, date, meal) {
  const existing = (S.planner[`${loc}-${date}-${meal}`] || []).map(d => d.id);
  renderAddModal(loc, date, meal, existing, '', '', 'cooked');
}

function renderAddModal(loc, date, meal, existing, searchQuery, typeFilter, tab, locFilter) {
  // Store modal state globally so onclick/oninput handlers can reference it
  // without embedding JSON in HTML attributes (which breaks on double quotes)
  if (!locFilter) locFilter = loc;
  S._addModalState = { loc, date, meal, existing, typeFilter, tab, locFilter };

  const locLabel = locFilter === 'west' ? 'Sering West' : 'Sering Centraal';
  const typeLabel = typeFilter ? ` (${typeFilter === 'Main course' ? 'Mains' : typeFilter + 's'})` : '';

  // Build filtered lists for counts and display
  let allAvail = S.batches.filter(d => !existing.includes(d.id));
  if (typeFilter) allAvail = allAvail.filter(d => d.type === typeFilter);

  const cookedDishes = allAvail.filter(d => isBatchCooked(d) && d.location === locFilter && !d.inTransit);
  const plannedDishes = sortByCookDate(allAvail.filter(d => !isBatchCooked(d) && (d.services || []).length > 0));
  const activeDishRecipeIds = new Set(S.batches.map(d => d.recipeSheetId).filter(Boolean));
  let allRecipes = S.recipeIndex.filter(r => !activeDishRecipeIds.has(r.recipeSheetId));
  if (typeFilter) allRecipes = allRecipes.filter(r => r.type === typeFilter);

  // Apply search filter
  let filteredCooked = cookedDishes;
  let filteredPlanned = plannedDishes;
  let filteredRecipes = allRecipes;
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    filteredCooked = cookedDishes.filter(d => d.name.toLowerCase().includes(q));
    filteredPlanned = plannedDishes.filter(d => d.name.toLowerCase().includes(q));
    filteredRecipes = allRecipes.filter(r => r.name.toLowerCase().includes(q));
  }

  // Render dish options helper
  const renderDishOpts = (dishes) => dishes.map(d => {
    const { diff, str, cls } = diffStr(d);
    const allAg = [...(d.allergens || []), ...(d.extraAllergens || [])];
    const agHtml = allAg.slice(0, 4).map(a => `<span class="allergen-pill">${esc(a)}</span>`).join('');
    const cookInfo = isBatchCooked(d) ? 'Cooked' : d.cookDate ? 'Cook: ' + d.cookDate : '';
    const stockLoc = logisticsShort(d);
    return `<div class="dish-opt" onclick="confirmAddDish('${d.id}','${loc}','${date}','${meal}')">
      <div style="flex:1;">
        <div><span style="font-weight:500;">${esc(d.name)}</span> ${typeBadge(d.type)} ${storageBadge(d.storage || 'Gastro')}</div>
        <div style="font-size:11px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:2px;">
          <span class="${cls}">${d.stock}L stock &middot; ${str}</span>
          <span class="${logisticsBadgeClass(d)}" style="font-size:10px;">${stockLoc}</span>
          ${agHtml ? `<span>${agHtml}</span>` : ''}
          ${cookInfo ? `<span style="color:var(--text3);">${cookInfo}</span>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');

  // Render recipe options helper
  const renderRecipeOpts = (recipes) => recipes.slice(0, 20).map(r => {
    const ags = (r.allergens || []).slice(0, 3).map(a => `<span class="allergen-pill">${esc(a)}</span>`).join('');
    return `<div class="dish-opt" onclick="addRecipeToSlot('${r.id}','${loc}','${date}','${meal}')">
      <div style="flex:1;">
        <div><span style="font-weight:500;">${esc(r.name)}</span> ${typeBadge(r.type || 'Soup')}</div>
        <div style="font-size:11px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:2px;">
          ${ags}
          ${r.costPerServing ? `<span style="color:var(--text3);">${esc(r.costPerServing)}</span>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');

  // Build list content based on active tab
  let listHtml = '';
  if (tab === 'cooked') {
    listHtml = filteredCooked.length > 0 ? renderDishOpts(filteredCooked)
      : `<div class="empty">No cooked batches at ${locLabel}${typeLabel}${searchQuery ? ' matching "' + esc(searchQuery) + '"' : ''}</div>`;
  } else if (tab === 'planned') {
    listHtml = filteredPlanned.length > 0 ? renderDishOpts(filteredPlanned)
      : `<div class="empty">No planned batches${typeLabel}${searchQuery ? ' matching "' + esc(searchQuery) + '"' : ''}</div>`;
  } else {
    listHtml = filteredRecipes.length > 0 ? renderRecipeOpts(filteredRecipes)
      : `<div class="empty">No recipes available${typeLabel}${searchQuery ? ' matching "' + esc(searchQuery) + '"' : ''}</div>`;
  }

  // Tab bar
  const tabs = [
    { id: 'cooked', label: 'Cooked', count: filteredCooked.length },
    { id: 'planned', label: 'Planned', count: filteredPlanned.length },
    { id: 'recipes', label: 'Recipes', count: filteredRecipes.length },
  ];
  const tabBarHtml = tabs.map(t =>
    `<button class="sub-tab ${tab === t.id ? 'active' : ''}" onclick="event.stopPropagation();switchAddModalTab('${t.id}')">${t.label} <span style="opacity:.6;font-size:11px;">${t.count}</span></button>`
  ).join('');

  // Location toggle
  const slotLocLabel = loc === 'west' ? 'Sering West' : 'Sering Centraal';
  const locToggleHtml = `<div class="order-loc-bar" style="margin-bottom:10px;" id="add-modal-loc-toggle">
    <button class="order-loc-btn${locFilter === 'west' ? ' active' : ''}" onclick="switchAddModalLoc('west')">Sering West</button>
    <button class="order-loc-btn${locFilter === 'centraal' ? ' active' : ''}" onclick="switchAddModalLoc('centraal')">Sering Centraal</button>
  </div>`;

  // If the modal is already open, only update the dynamic parts
  const existingModal = document.getElementById('add-modal-tabs');
  if (existingModal) {
    document.getElementById('add-modal-loc-toggle').outerHTML = locToggleHtml;
    existingModal.innerHTML = tabBarHtml;
    document.getElementById('add-modal-list').innerHTML = listHtml;
    return;
  }

  // First open — render the full modal
  const dayName = dateToDayName(date);
  showModal(`<h3>Add${typeLabel} to ${dayName} ${meal} &middot; ${slotLocLabel}</h3>
    <input type="text" class="dish-search" id="planner-search" placeholder="Search..." value="${esc(searchQuery)}"
      oninput="searchAddModal()" />
    ${locToggleHtml}
    <div class="sub-tab-bar" style="margin-bottom:10px;" id="add-modal-tabs">${tabBarHtml}</div>
    <div class="dish-opts-list" style="max-height:340px;" id="add-modal-list">${listHtml}</div>
    <div class="modal-actions">
      <button class="btn" style="background:var(--blue);color:white;" onclick="addPlaceholderDish()">+ Placeholder</button>
      <button class="btn" onclick="closeModal()">Close</button>
    </div>`);
  const si = document.getElementById('planner-search');
  if (si) si.focus();
}

function updateAddModal(loc, date, meal, existing, typeFilter, tab) {
  const searchQuery = (document.getElementById('planner-search') || {}).value || '';
  const locFilter = S._addModalState ? S._addModalState.locFilter : loc;
  renderAddModal(loc, date, meal, existing, searchQuery, typeFilter, tab, locFilter);
}

function switchAddModalTab(tab) {
  const s = S._addModalState;
  if (!s) return;
  s.tab = tab;
  const searchQuery = (document.getElementById('planner-search') || {}).value || '';
  renderAddModal(s.loc, s.date, s.meal, s.existing, searchQuery, s.typeFilter, tab, s.locFilter);
}

function switchAddModalLoc(newLoc) {
  const s = S._addModalState;
  if (!s) return;
  s.locFilter = newLoc;
  const searchQuery = (document.getElementById('planner-search') || {}).value || '';
  renderAddModal(s.loc, s.date, s.meal, s.existing, searchQuery, s.typeFilter, s.tab, newLoc);
}

function searchAddModal() {
  const s = S._addModalState;
  if (!s) return;
  const searchQuery = (document.getElementById('planner-search') || {}).value || '';
  renderAddModal(s.loc, s.date, s.meal, s.existing, searchQuery, s.typeFilter, s.tab, s.locFilter);
}

function confirmAddDish(dishId, loc, date, meal) {
  const dish = S.batches.find(d => d.id === dishId);
  if (dish) { if (!dish.services) dish.services = []; dish.services.push({ loc, date, meal }); }
  closeModal(); rebuildPlanner(); rerenderCurrentView(); scheduleSave();
  toast(`${dish.name} added to ${dateToDayName(date)} ${meal}`);
}

function addRecipeToSlot(recipeId, loc, date, meal) {
  const r = S.recipeIndex.find(x => x.id === recipeId);
  if (!r) return;
  const newDish = {
    id: newId(),
    name: r.name,
    type: r.type || 'Soup',
    stock: 0,
    serving: r.servingSize || 280,
    storage: 'Gastro',
    location: loc,
    inTransit: false,
    recipeSheetId: r.recipeSheetId || null,
    recipeVolume: r.recipeVolume || null,
    recipeIngredients: r.recipeIngredients ? [...r.recipeIngredients] : null,
    allergens: [...(r.allergens || [])],
    extraAllergens: [],
    orderFor: false,
    parentId: null,
    cookDate: null,
    services: [{ loc, date, meal }],
    createdAt: new Date().toISOString(),
  };
  S.batches.push(newDish);
  closeModal(); rebuildPlanner(); rerenderCurrentView(); scheduleSave();
  toast(`${r.name} added to ${dateToDayName(date)} ${meal}`);
}

function addPlaceholderDish() {
  const s = S._addModalState;
  if (!s) return;
  const { loc, date, meal, typeFilter } = s;
  const dayName = dateToDayName(date);
  const type = typeFilter || 'Soup';
  const typeLabel = type === 'Main course' ? 'Main' : type;
  const name = `${dayName} ${typeLabel}`;

  const newDish = {
    id: newId(),
    name,
    type,
    stock: 0,
    serving: 280,
    storage: 'Gastro',
    location: loc,
    inTransit: false,
    allergens: [],
    extraAllergens: [],
    orderFor: false,
    parentId: null,
    cookDate: null,
    services: [{ loc, date, meal }],
    createdAt: new Date().toISOString(),
  };
  S.batches.push(newDish);
  closeModal(); rebuildPlanner(); rerenderCurrentView(); scheduleSave();
  toast(`Placeholder "${name}" added to ${dayName} ${meal}`);
}

// ── REPLACE BATCH ────────────────────────────────────────

function openReplaceBatch(batchId) {
  const old = S.batches.find(d => d.id === batchId);
  if (!old) return;
  if (isBatchCooked(old)) { toast('Cannot replace a cooked batch'); return; }
  if (!(old.services || []).length) { toast('Batch has no services to transfer'); return; }

  S._replaceState = { oldBatchId: batchId, searchQuery: '', tab: 'batches' };
  renderReplaceModal();
}

function renderReplaceModal() {
  const rs = S._replaceState;
  if (!rs) return;
  const old = S.batches.find(d => d.id === rs.oldBatchId);
  if (!old) return;

  // Show which services will be transferred
  const svcLabels = (old.services || []).map(s =>
    `${dateToDayName(s.date)} ${s.meal}`
  ).join(', ');

  // Candidates: same type, not the old batch, not cooked
  let candidates = S.batches.filter(d =>
    d.id !== old.id && d.type === old.type && !isBatchCooked(d)
  );
  // Recipes not already active
  const activeDishRecipeIds = new Set(S.batches.map(d => d.recipeSheetId).filter(Boolean));
  let recipes = S.recipeIndex.filter(r =>
    !activeDishRecipeIds.has(r.recipeSheetId) && (r.type || 'Soup') === old.type
  );

  // Apply search
  if (rs.searchQuery) {
    const q = rs.searchQuery.toLowerCase();
    candidates = candidates.filter(d => d.name.toLowerCase().includes(q));
    recipes = recipes.filter(r => r.name.toLowerCase().includes(q));
  }

  // Render batch options
  const renderBatchOpts = (batches) => batches.map(d => {
    const allAg = [...(d.allergens || []), ...(d.extraAllergens || [])];
    const agHtml = allAg.slice(0, 4).map(a => `<span class="allergen-pill">${esc(a)}</span>`).join('');
    const cookInfo = d.cookDate ? 'Cook: ' + d.cookDate : '';
    const svcCount = (d.services || []).length;
    const svcNote = svcCount > 0 ? `${svcCount} service${svcCount > 1 ? 's' : ''}` : 'Unassigned';
    return `<div class="dish-opt" onclick="confirmReplaceBatch('${d.id}')">
      <div style="flex:1;">
        <div><span style="font-weight:500;">${esc(d.name)}</span> ${storageBadge(d.storage || 'Gastro')}</div>
        <div style="font-size:11px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:2px;">
          <span style="color:var(--text3);">${svcNote}</span>
          ${agHtml ? `<span>${agHtml}</span>` : ''}
          ${cookInfo ? `<span style="color:var(--text3);">${cookInfo}</span>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');

  const renderRecipeOpts = (recs) => recs.slice(0, 20).map(r => {
    const ags = (r.allergens || []).slice(0, 3).map(a => `<span class="allergen-pill">${esc(a)}</span>`).join('');
    return `<div class="dish-opt" onclick="replaceWithRecipe('${r.id}')">
      <div style="flex:1;">
        <div><span style="font-weight:500;">${esc(r.name)}</span></div>
        <div style="font-size:11px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:2px;">
          ${ags}
          ${r.costPerServing ? `<span style="color:var(--text3);">${esc(r.costPerServing)}</span>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');

  // Tabs
  const tabs = [
    { id: 'batches', label: 'Batches', count: candidates.length },
    { id: 'recipes', label: 'Recipes', count: recipes.length },
  ];
  const tabBarHtml = tabs.map(t =>
    `<button class="sub-tab ${rs.tab === t.id ? 'active' : ''}" onclick="event.stopPropagation();switchReplaceTab('${t.id}')">${t.label} <span style="opacity:.6;font-size:11px;">${t.count}</span></button>`
  ).join('');

  let listHtml = '';
  if (rs.tab === 'batches') {
    listHtml = candidates.length > 0 ? renderBatchOpts(candidates)
      : `<div class="empty">No uncooked ${old.type.toLowerCase()} batches available${rs.searchQuery ? ' matching "' + esc(rs.searchQuery) + '"' : ''}</div>`;
  } else {
    listHtml = recipes.length > 0 ? renderRecipeOpts(recipes)
      : `<div class="empty">No recipes available${rs.searchQuery ? ' matching "' + esc(rs.searchQuery) + '"' : ''}</div>`;
  }

  // If modal already open, update in place
  const existingTabs = document.getElementById('replace-modal-tabs');
  if (existingTabs) {
    existingTabs.innerHTML = tabBarHtml;
    document.getElementById('replace-modal-list').innerHTML = listHtml;
    return;
  }

  const typeLabel = old.type === 'Main course' ? 'main' : old.type.toLowerCase();
  showModal(`<h3>Replace ${esc(old.name)}</h3>
    <div style="font-size:13px;color:var(--text3);margin-bottom:10px;">Assigned to: ${svcLabels}</div>
    <input type="text" class="dish-search" id="replace-search" placeholder="Search ${typeLabel}s..." value="${esc(rs.searchQuery)}"
      oninput="searchReplaceModal()" />
    <div class="sub-tab-bar" style="margin-bottom:10px;" id="replace-modal-tabs">${tabBarHtml}</div>
    <div class="dish-opts-list" style="max-height:340px;" id="replace-modal-list">${listHtml}</div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
    </div>`);
  const si = document.getElementById('replace-search');
  if (si) si.focus();
}

function switchReplaceTab(tab) {
  const rs = S._replaceState;
  if (!rs) return;
  rs.tab = tab;
  rs.searchQuery = (document.getElementById('replace-search') || {}).value || '';
  renderReplaceModal();
}

function searchReplaceModal() {
  const rs = S._replaceState;
  if (!rs) return;
  rs.searchQuery = (document.getElementById('replace-search') || {}).value || '';
  renderReplaceModal();
}

function confirmReplaceBatch(newBatchId) {
  const rs = S._replaceState;
  if (!rs) return;
  const old = S.batches.find(d => d.id === rs.oldBatchId);
  const replacement = S.batches.find(d => d.id === newBatchId);
  if (!old || !replacement) return;

  // Transfer services, deduplicating
  const existing = replacement.services || [];
  (old.services || []).forEach(svc => {
    const dup = existing.some(e => e.loc === svc.loc && e.date === svc.date && e.meal === svc.meal);
    if (!dup) existing.push(svc);
  });
  replacement.services = existing;

  // Delete old batch
  const oldName = old.name;
  S.batches = S.batches.filter(d => d.id !== old.id);
  if (!S.deletedBatches) S.deletedBatches = [];
  S.deletedBatches.push(old.id);

  closeModal();
  rebuildPlanner();
  rerenderCurrentView();
  scheduleSave();
  toast(`Replaced ${oldName} with ${replacement.name}`);
}

function replaceWithRecipe(recipeId) {
  const rs = S._replaceState;
  if (!rs) return;
  const old = S.batches.find(d => d.id === rs.oldBatchId);
  const r = S.recipeIndex.find(x => x.id === recipeId);
  if (!old || !r) return;

  // Create new batch from recipe with old batch's services
  const newBatch = {
    id: newId(),
    name: r.name,
    type: r.type || 'Soup',
    stock: 0,
    serving: r.servingSize || 280,
    storage: 'Gastro',
    location: old.location,
    inTransit: false,
    recipeSheetId: r.recipeSheetId || null,
    recipeVolume: r.recipeVolume || null,
    recipeIngredients: r.recipeIngredients ? [...r.recipeIngredients] : null,
    allergens: [...(r.allergens || [])],
    extraAllergens: [],
    orderFor: false,
    parentId: null,
    cookDate: null,
    note: '',
    services: [...(old.services || [])],
    createdAt: new Date().toISOString(),
  };
  S.batches.push(newBatch);

  // Delete old batch
  const oldName = old.name;
  S.batches = S.batches.filter(d => d.id !== old.id);
  if (!S.deletedBatches) S.deletedBatches = [];
  S.deletedBatches.push(old.id);

  closeModal();
  rebuildPlanner();
  rerenderCurrentView();
  scheduleSave();
  toast(`Replaced ${oldName} with ${r.name}`);
}

// ── INVENTORY ────────────────────────────────────────────
// getAmsterdamNow() is defined in core.js (shared with isServicePast)

function getInventoryState(loc) {
  const now = getAmsterdamNow();
  const h = now.getHours(), m = now.getMinutes();
  const mins = h * 60 + m;
  const lunchDeadline = 13 * 60 + 45; // 13:45
  const dinnerDeadline = 20 * 60 + 15; // 20:15
  const todayStr = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  const inv = S.inventoryDone[loc] || {};
  const lunchDone = inv.lunch === todayStr;
  const dinnerDone = inv.dinner === todayStr;

  // Determine current window
  if (!lunchDone && mins < lunchDeadline) {
    // Before lunch deadline, lunch not done
    return { window: 'lunch', label: 'Do inventory — 13:45', done: false, urgent: mins >= lunchDeadline - 60 };
  }
  if (!lunchDone && mins >= lunchDeadline && mins < dinnerDeadline) {
    // Past lunch deadline, lunch not done
    return { window: 'lunch', label: 'DO INVENTORY', done: false, urgent: true };
  }
  if (lunchDone && mins < dinnerDeadline) {
    // Lunch done, before dinner deadline
    const urgent = mins >= dinnerDeadline - 60;
    return { window: 'dinner', label: dinnerDone ? 'Inventory done' : 'Do inventory — 20:15', done: dinnerDone, urgent: !dinnerDone && urgent };
  }
  if (!dinnerDone && mins >= dinnerDeadline) {
    // Past dinner deadline, dinner not done
    return { window: 'dinner', label: 'DO INVENTORY', done: false, urgent: true };
  }
  // Both done
  return { window: 'done', label: 'Inventory done', done: true, urgent: false };
}

function getInventoryButton(loc) {
  const st = getInventoryState(loc);
  if (st.done && st.window === 'done') {
    return `<button class="btn inv-btn inv-done" disabled>&#10003; Inventory done</button>`;
  }
  const cls = st.urgent ? 'inv-btn inv-urgent' : 'inv-btn';
  return `<button class="btn ${cls}" onclick="openInventory('${loc}')">${st.label}</button>`;
}

function openInventory(loc) {
  const locLabel = loc === 'west' ? 'Sering West' : 'Sering Centraal';
  const dishes = S.batches.filter(d => {
    if (!isBatchCooked(d)) return false; // Only cooked batches need inventory
    return d.location === loc; // Only show batches physically at this location
  });

  if (dishes.length === 0) {
    toast('No cooked batches at ' + locLabel);
    return;
  }

  let html = `<h3>Inventory — ${locLabel}</h3>`;
  html += `<div style="font-size:12px;color:var(--text2);margin-bottom:12px;">Update stock for each batch, or mark as served.</div>`;
  html += `<div class="inv-list">`;

  const sorted = [...dishes].sort((a, b) => {
    const typeOrder = { 'Soup': 0, 'Main course': 1, 'Dessert': 2 };
    return (typeOrder[a.type] || 0) - (typeOrder[b.type] || 0);
  });

  let lastType = '';
  sorted.forEach(d => {
    if (d.type !== lastType) {
      lastType = d.type;
      html += `<div style="font-size:11px;font-weight:600;text-transform:uppercase;color:var(--text2);padding:8px 0 4px;border-bottom:1px solid var(--border);">${d.type}</div>`;
    }
    const { str, cls } = diffStr(d);
    html += `<div class="inv-row" id="inv-row-${d.id}">
      <div class="inv-name">
        <span style="font-weight:500;">${esc(d.name)}</span>
        ${storageBadge(d.storage || 'Gastro')}
        <span class="${cls}" style="font-size:11px;">${str}</span>
      </div>
      <div class="inv-controls">
        <label style="font-size:11px;color:var(--text2);">Current stock</label>
        <input type="number" class="inv-stock-input" id="inv-stock-${d.id}" value="${d.stock || 0}" step="0.5" min="0" onchange="updateInventoryStock('${d.id}',this.value)" />
        <span style="display:inline-block;width:1px;height:24px;background:var(--border);margin:0 6px;vertical-align:middle;"></span>
        <button class="btn btn-sm inv-served-btn" style="background:var(--red);color:#fff;border-color:var(--red);" onclick="openServedFromInventory('${d.id}','${loc}')">Served</button>
      </div>
    </div>`;
  });

  html += `</div>`;
  html += `<div class="modal-actions">
    <button class="btn" onclick="S._inventoryLoc=null;closeModal()">Cancel</button>
    <button class="btn btn-primary" onclick="finishInventory('${loc}')">Finish inventory</button>
  </div>`;

  showModal(html);
  // Widen the modal for inventory
  const modal = document.querySelector('.modal');
  if (modal) modal.style.width = '560px';
}

function updateInventoryStock(id, value) {
  const d = S.batches.find(x => x.id === id);
  if (!d) return;
  d.stock = parseFloat(value) || 0;
  scheduleSave();
}

function openServedFromInventory(id, loc) {
  // Store that we came from inventory so we can reopen it
  S._inventoryLoc = loc;
  openServedDialog(id);
}

function finishInventory(loc) {
  const now = getAmsterdamNow();
  const todayStr = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  const st = getInventoryState(loc);
  if (!S.inventoryDone[loc]) S.inventoryDone[loc] = {};
  S.inventoryDone[loc][st.window] = todayStr;
  S._inventoryLoc = null;
  closeModal();
  rebuildPlanner();
  rerenderCurrentView();
  scheduleSave();
  toast('Inventory complete!');
}
