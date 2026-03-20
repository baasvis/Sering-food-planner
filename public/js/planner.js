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

// ── LOCATION PLAN (West / Centraal) ─────────────────────
function renderLocationPlan(loc) {
  const typeGroups = [
    { key: 'Soup', label: 'Soups', cls: 'chip-soup' },
    { key: 'Main course', label: 'Mains', cls: 'chip-main' },
    { key: 'Dessert', label: 'Desserts', cls: 'chip-dessert' },
  ];

  // Calculate week dates
  const today = getToday();
  const todayDow = today.getDay();
  const mondayOff = todayDow === 0 ? -6 : 1 - todayDow;
  const monday = new Date(today); monday.setDate(today.getDate() + mondayOff);

  let html = `<div class="btn-row" style="margin-bottom:12px;">
    <button class="btn btn-primary" onclick="openNewDish()">+ New dish</button>
  </div>
  <div id="split-bar-area"></div>`;

  const otherLoc = loc === 'west' ? 'centraal' : 'west';
  const otherLabel = loc === 'west' ? 'Centraal' : 'West';

  typeGroups.forEach(tg => {
    const collapseKey = `${loc}-${tg.key}`;
    if (S.collapsedTypes[collapseKey] === undefined) S.collapsedTypes[collapseKey] = true;
    const isCollapsed = !!S.collapsedTypes[collapseKey];

    // Type section header — clickable to toggle dish list
    html += `<div class="type-section">`;
    html += `<div class="type-section-hdr" style="cursor:pointer;" onclick="toggleTypeCollapse('${collapseKey}')"><span class="type-dot ${tg.cls}"></span>${tg.label}<span class="collapse-arrow">${isCollapsed ? '&#9654;' : '&#9660;'}</span></div>`;

    // Calendar grid for this type
    html += `<div class="week-scroll"><div class="week-grid"><div></div>`;

    // Day headers with copy button
    DAYS.forEach((d, i) => {
      const isToday = i === (new Date().getDay() + 6) % 7;
      const dt = new Date(monday); dt.setDate(monday.getDate() + i);
      const dateStr = `${dt.getDate()}/${dt.getMonth()+1}`;
      html += `<div class="day-hdr${isToday ? ' today-hdr' : ''}">${d}<span class="gt-date">${dateStr}</span><button class="copy-day-btn" onclick="event.stopPropagation();copyDayToOther('${loc}',${i})" title="Copy all ${d} dishes to ${otherLabel}">&rarr; ${otherLabel}</button></div>`;
    });

    // Meal rows
    MEALS.forEach(meal => {
      const mealLabel = meal.charAt(0).toUpperCase() + meal.slice(1);
      html += `<div class="meal-lbl">${mealLabel}</div>`;
      for (let d = 0; d < 7; d++) {
        const gc = getGuests(loc, d, meal);
        const k = `${loc}-${d}-${meal}`;
        const slotDishes = (S.planner[k] || []).filter(dish => dish.type === tg.key);
        const isToday = d === (new Date().getDay() + 6) % 7;
        html += `<div class="slot${isToday ? ' today' : ''}" onclick="openAddDishTyped('${loc}',${d},'${meal}','${tg.key}')">`;
        slotDishes.forEach(dish => {
          const trClass = (dish.logistics || '').startsWith('Transport') ? ' chip-tr-border' : '';
          html += `<div class="dish-chip ${tg.cls}${trClass}"><span class="chip-nm">${esc(dish.name)}</span><span class="chip-x" onclick="event.stopPropagation();removeDishFromSlot('${dish.id}','${loc}',${d},'${meal}')">&#10005;</span></div>`;
        });
        html += `<div class="add-slot-btn" onclick="event.stopPropagation();openAddDishTyped('${loc}',${d},'${meal}','${tg.key}')">+</div></div>`;
      }
    });

    html += '</div></div>'; // close week-grid and week-scroll

    // Collapsible dish list below the grid
    const typeDishes = S.dishes.filter(d => d.type === tg.key && (d.services || []).some(s => s.loc === loc));
    if (typeDishes.length > 0 && !isCollapsed) {
      html += `<div class="type-dish-list">`;
      html += `<div class="dish-list-hdr">
        <span></span>
        <span>Dish</span>
        <span>Cook date</span>
        <span>Stock</span>
        <span>+/&minus;</span>
        <span>Location</span>
        <span>Order</span>
        <span></span>
      </div>`;
      html += renderDishListSplit(typeDishes);
      html += `</div>`;
    } else if (typeDishes.length > 0 && isCollapsed) {
      html += `<div style="font-size:11px;color:var(--text3);padding:4px 0;cursor:pointer;" onclick="toggleTypeCollapse('${collapseKey}')">${typeDishes.length} dish${typeDishes.length !== 1 ? 'es' : ''} — click to expand</div>`;
    }

    html += `</div>`; // close type-section
  });

  // Also show dishes with no services (unassigned) that match this location's logistics
  const locLabel = loc === 'west' ? 'Sering West' : 'Sering Centraal';
  const unassigned = S.dishes.filter(d => (d.services || []).length === 0 && (d.logistics === locLabel || d.logistics === 'Transport to ' + (loc === 'west' ? 'Sering West' : 'Sering Centraal')));
  if (unassigned.length > 0) {
    html += `<div class="type-section">`;
    html += `<div class="type-section-hdr" style="color:var(--text3);">Unassigned dishes at ${locLabel}</div>`;
    html += `<div class="dish-list-hdr">
      <span></span><span>Dish</span><span>Cook date</span><span>Stock</span><span>+/&minus;</span><span>Location</span><span>Order</span><span></span>
    </div>`;
    html += renderDishListSplit(unassigned);
    html += `</div>`;
  }

  document.getElementById('planner-content').innerHTML = html;
  renderSplitBar();
}

// ── TRANSPORT VIEW ───────────────────────────────────────
function renderTransportView() {
  const transportDishes = S.dishes.filter(d => (d.logistics || '').startsWith('Transport'));

  let html = `<div id="split-bar-area"></div>`;

  // ── Transport items (custom free-text items) ──
  html += `<div class="type-section">`;
  html += `<div class="type-section-hdr">Items to transport</div>`;
  html += `<div style="display:flex;gap:6px;margin-bottom:8px;">
    <input type="text" id="transport-item-input" placeholder="Add item to remember..." style="flex:1;font-size:13px;height:32px;border:1px solid var(--border2);border-radius:var(--radius);padding:0 10px;background:var(--bg);color:var(--text);" onkeydown="if(event.key==='Enter')addTransportItem()" />
    <button class="btn btn-primary" onclick="addTransportItem()" style="height:32px;">Add</button>
  </div>`;
  if ((S.transportItems || []).length > 0) {
    S.transportItems.forEach(item => {
      html += `<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);margin-bottom:4px;">
        <span style="flex:1;font-size:13px;">${esc(item.text)}</span>
        <button class="btn btn-sm" style="font-size:11px;color:var(--green);border-color:var(--green);" onclick="deliverTransportItem('${item.id}')">Delivered</button>
      </div>`;
    });
  } else {
    html += `<div style="font-size:12px;color:var(--text3);padding:4px 0;">No extra items</div>`;
  }
  html += `</div>`;

  // ── Dishes being transported ──
  if (transportDishes.length > 0) {
    html += `<div class="type-section">`;
    html += `<div class="type-section-hdr">Dishes in transport</div>`;
    html += `<div style="margin-bottom:8px;display:flex;gap:6px;">
      <button class="btn btn-sm" style="color:var(--green);border-color:var(--green);" onclick="markSelectedArrived()">Mark selected as arrived</button>
    </div>`;

    const today = getToday();
    const todayDow = today.getDay();
    const mondayOff = todayDow === 0 ? -6 : 1 - todayDow;
    const monday = new Date(today); monday.setDate(today.getDate() + mondayOff);

    // Collect dishes per day
    const byDay = {};
    const noDayDishes = [];
    transportDishes.forEach(d => {
      const days = new Set();
      (d.services || []).forEach(s => days.add(s.day));
      if (days.size === 0) { noDayDishes.push(d); return; }
      days.forEach(day => {
        if (!byDay[day]) byDay[day] = [];
        if (!byDay[day].find(x => x.id === d.id)) byDay[day].push(d);
      });
    });

    // Render per day
    DAYS.forEach((dayName, i) => {
      const dishes = byDay[i];
      if (!dishes || dishes.length === 0) return;
      const dt = new Date(monday); dt.setDate(monday.getDate() + i);
      const dateStr = `${dt.getDate()}/${dt.getMonth()+1}`;
      const isToday = i === (new Date().getDay() + 6) % 7;
      html += `<div class="type-section">`;
      html += `<div class="type-section-hdr"${isToday ? ' style="color:var(--blue);"' : ''}>${dayName} ${dateStr}</div>`;
      html += `<div class="dish-list-hdr">
        <span></span><span>Dish</span><span>Cook date</span><span>Stock</span><span>+/&minus;</span><span>Location</span><span>Order</span><span></span>
      </div>`;
      html += renderDishListSplit(dishes);
      html += `</div>`;
    });

    // Dishes with no day assigned
    if (noDayDishes.length > 0) {
      html += `<div class="type-section">`;
      html += `<div class="type-section-hdr" style="color:var(--text3);">No day assigned</div>`;
      html += `<div class="dish-list-hdr">
        <span></span><span>Dish</span><span>Cook date</span><span>Stock</span><span>+/&minus;</span><span>Location</span><span>Order</span><span></span>
      </div>`;
      html += renderDishListSplit(noDayDishes);
      html += `</div>`;
    }

    html += `</div>`; // close dishes in transport section
  } else {
    html += `<div class="empty" style="margin-top:12px;">No dishes marked for transport</div>`;
  }

  document.getElementById('planner-content').innerHTML = html;
  renderSplitBar();
}

// ── Transport item functions ─────────────────────────────
function addTransportItem() {
  const input = document.getElementById('transport-item-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  S.transportItems.push({ id: newId(), text });
  input.value = '';
  scheduleSave();
  rerenderCurrentView();
}

function deliverTransportItem(id) {
  S.transportItems = S.transportItems.filter(i => i.id !== id);
  scheduleSave();
  rerenderCurrentView();
  toast('Item delivered');
}

function markSelectedArrived() {
  const selected = [...S.selected];
  if (selected.length === 0) { toast('Select dishes first using the checkboxes'); return; }
  let count = 0;
  selected.forEach(id => {
    const d = S.dishes.find(x => x.id === id);
    if (d && (d.logistics || '').startsWith('Transport')) {
      // "Transport to Sering West" → "Sering West", "Transport to Sering Centraal" → "Sering Centraal"
      d.logistics = d.logistics.replace('Transport to ', '');
      count++;
    }
  });
  S.selected.clear();
  if (count > 0) {
    scheduleSave();
    rerenderCurrentView();
    toast(`${count} dish${count > 1 ? 'es' : ''} marked as arrived`);
  }
}

// ── ADD DISH MODAL ───────────────────────────────────────
function removeDishFromSlot(dishId, loc, day, meal) {
  const dish = S.dishes.find(d => d.id === dishId);
  if (dish) { dish.services = (dish.services || []).filter(s => !(s.loc === loc && s.day === day && s.meal === meal)); }
  rebuildPlanner(); rerenderCurrentView(); scheduleSave();
}

function toggleTypeCollapse(key) {
  S.collapsedTypes[key] = !S.collapsedTypes[key];
  rerenderCurrentView();
}

function copyDayToOther(fromLoc, day) {
  const toLoc = fromLoc === 'west' ? 'centraal' : 'west';
  const toLabel = toLoc === 'west' ? 'Sering West' : 'Sering Centraal';
  let added = 0;
  MEALS.forEach(meal => {
    const k = `${fromLoc}-${day}-${meal}`;
    const dishes = S.planner[k] || [];
    dishes.forEach(dish => {
      const already = (dish.services || []).some(s => s.loc === toLoc && s.day === day && s.meal === meal);
      if (!already) {
        if (!dish.services) dish.services = [];
        dish.services.push({ loc: toLoc, day, meal });
        added++;
      }
    });
  });
  if (added > 0) {
    rebuildPlanner(); rerenderCurrentView(); scheduleSave();
    toast(`${added} dish${added > 1 ? 'es' : ''} copied to ${toLabel} ${DAYS[day]}`);
  } else {
    toast('All dishes already assigned there');
  }
}

function copySlotToOther(fromLoc, day, meal) {
  const toLoc = fromLoc === 'west' ? 'centraal' : 'west';
  const toLabel = toLoc === 'west' ? 'Sering West' : 'Sering Centraal';
  const k = `${fromLoc}-${day}-${meal}`;
  const dishes = S.planner[k] || [];
  if (!dishes.length) return;

  let added = 0;
  dishes.forEach(dish => {
    const already = (dish.services || []).some(s => s.loc === toLoc && s.day === day && s.meal === meal);
    if (!already) {
      if (!dish.services) dish.services = [];
      dish.services.push({ loc: toLoc, day, meal });
      added++;
    }
  });

  if (added > 0) {
    rebuildPlanner(); rerenderCurrentView(); scheduleSave();
    toast(`${added} dish${added > 1 ? 'es' : ''} copied to ${toLabel} ${DAYS[day]} ${meal}`);
  } else {
    toast('All dishes already assigned there');
  }
}

function openAddDishTyped(loc, day, meal, type) {
  const existing = (S.planner[`${loc}-${day}-${meal}`] || []).map(d => d.id);
  renderAddModal(loc, day, meal, existing, false, '', type);
}

function openAddDish(loc, day, meal) {
  const existing = (S.planner[`${loc}-${day}-${meal}`] || []).map(d => d.id);
  renderAddModal(loc, day, meal, existing, false, '', '');
}

function renderAddModal(loc, day, meal, existing, filterOn, searchQuery, typeFilter) {
  const locLabel = loc === 'west' ? 'Sering West' : 'Sering Centraal';
  let avail = S.dishes.filter(d => !existing.includes(d.id));
  if (typeFilter) avail = avail.filter(d => d.type === typeFilter);
  if (filterOn) avail = avail.filter(d => d.logistics === locLabel);
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    avail = avail.filter(d => d.name.toLowerCase().includes(q));
  }
  const typeLabel = typeFilter ? ` (${typeFilter === 'Main course' ? 'Mains' : typeFilter + 's'})` : '';

  // Existing dishes section
  const opts = avail.length === 0
    ? ''
    : avail.map(d => {
      const { diff, str, cls } = diffStr(d);
      const allAg = [...(d.allergens || []), ...(d.extraAllergens || [])];
      const agHtml = allAg.slice(0, 4).map(a => `<span class="allergen-pill">${esc(a)}</span>`).join('');
      const cookInfo = d.cookConfirmed ? 'Cooked' : d.cookDate ? 'Cook: ' + d.cookDate : '';
      const stockLoc = logisticsShort(d.logistics || 'Sering West');
      return `<div class="dish-opt" onclick="confirmAddDish('${d.id}','${loc}',${day},'${meal}')">
        <div style="flex:1;">
          <div><span style="font-weight:500;">${esc(d.name)}</span> ${typeBadge(d.type)} ${storageBadge(d.storage || 'Gastro')}</div>
          <div style="font-size:11px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:2px;">
            <span class="${cls}">${d.stock}L stock &middot; ${str}</span>
            <span class="${logisticsBadgeClass(d.logistics || 'Sering West')}" style="font-size:10px;">${stockLoc}</span>
            ${agHtml ? `<span>${agHtml}</span>` : ''}
            ${cookInfo ? `<span style="color:var(--text3);">${cookInfo}</span>` : ''}
          </div>
        </div>
      </div>`;
    }).join('');

  // Recipes from index section — exclude recipes already on the menu
  const activeDishRecipeIds = new Set(S.dishes.map(d => d.recipeSheetId).filter(Boolean));
  let recipes = S.recipeIndex.filter(r => !activeDishRecipeIds.has(r.recipeSheetId));
  if (typeFilter) recipes = recipes.filter(r => r.type === typeFilter);
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    recipes = recipes.filter(r => r.name.toLowerCase().includes(q));
  }
  const recipeOpts = recipes.slice(0, 15).map(r => {
    const ags = (r.allergens || []).slice(0, 3).map(a => `<span class="allergen-pill">${esc(a)}</span>`).join('');
    return `<div class="dish-opt" onclick="addRecipeToSlot('${r.id}','${loc}',${day},'${meal}')">
      <div style="flex:1;">
        <div><span style="font-weight:500;">${esc(r.name)}</span> ${typeBadge(r.type || 'Soup')}</div>
        <div style="font-size:11px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:2px;">
          ${ags}
          ${r.costPerServing ? `<span style="color:var(--text3);">${esc(r.costPerServing)}</span>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');

  const existingJson = JSON.stringify(existing).replace(/'/g, "\\'");
  const tfEsc = typeFilter ? typeFilter.replace(/'/g, "\\'") : '';
  const tf = `,'${tfEsc}'`;

  let listHtml = '';
  if (opts) {
    listHtml += `<div style="font-size:11px;font-weight:600;color:var(--text2);text-transform:uppercase;letter-spacing:.04em;padding:6px 10px;">On the menu</div>`;
    listHtml += opts;
  }
  if (recipeOpts) {
    listHtml += `<div style="font-size:11px;font-weight:600;color:var(--text2);text-transform:uppercase;letter-spacing:.04em;padding:6px 10px;${opts ? 'border-top:2px solid var(--border);margin-top:2px;' : ''}">From recipes</div>`;
    listHtml += recipeOpts;
  }
  if (!listHtml) {
    listHtml = `<div class="empty">No dishes or recipes available${typeLabel}${searchQuery ? ' matching "' + esc(searchQuery) + '"' : ''}</div>`;
  }

  showModal(`<h3>Add${typeLabel} to ${DAYS[day]} ${meal} &middot; ${locLabel}</h3>
    <input type="text" class="dish-search" id="planner-search" placeholder="Search dishes & recipes..." value="${esc(searchQuery)}"
      oninput="renderAddModal('${loc}',${day},'${meal}',${existingJson},${filterOn},this.value${tf})" />
    ${opts ? `<div class="filter-toggle-row" onclick="renderAddModal('${loc}',${day},'${meal}',${existingJson},${!filterOn},''${tf})">
      <div class="tbox${filterOn ? ' on' : ''}"><div class="tknob"></div></div>
      <span>Only show dishes at ${locLabel}</span>
    </div>` : ''}
    <div class="dish-opts-list" style="max-height:340px;">${listHtml}</div>
    <div class="modal-actions"><button class="btn" onclick="closeModal()">Close</button></div>`);
  const si = document.getElementById('planner-search');
  if (si) { si.focus(); si.setSelectionRange(si.value.length, si.value.length); }
}

function confirmAddDish(dishId, loc, day, meal) {
  const dish = S.dishes.find(d => d.id === dishId);
  if (dish) { if (!dish.services) dish.services = []; dish.services.push({ loc, day, meal }); }
  closeModal(); rebuildPlanner(); rerenderCurrentView(); scheduleSave();
  toast(`${dish.name} added to ${DAYS[day]} ${meal}`);
}

function addRecipeToSlot(recipeId, loc, day, meal) {
  const r = S.recipeIndex.find(x => x.id === recipeId);
  if (!r) return;
  const locLabel = loc === 'west' ? 'Sering West' : 'Sering Centraal';
  const newDish = {
    id: newId(),
    name: r.name,
    type: r.type || 'Soup',
    stock: 0,
    serving: r.servingSize || 280,
    storage: 'Gastro',
    logistics: locLabel,
    recipeSheetId: r.recipeSheetId || null,
    recipeVolume: r.recipeVolume || null,
    recipeIngredients: r.recipeIngredients ? [...r.recipeIngredients] : null,
    allergens: [...(r.allergens || [])],
    extraAllergens: [],
    orderFor: false,
    parentId: null,
    cookMode: 'day',
    cookDay: null,
    cookDate: null,
    cookConfirmed: false,
    services: [{ loc, day: parseInt(day), meal }],
    createdAt: new Date().toISOString(),
  };
  S.dishes.push(newDish);
  closeModal(); rebuildPlanner(); rerenderCurrentView(); scheduleSave();
  toast(`${r.name} added to ${DAYS[day]} ${meal}`);
}
