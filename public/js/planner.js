// ── PLANNER ───────────────────────────────────────────────
function renderPlanner() {
  const loc = S.currentLoc;
  const typeGroups = [
    { key: 'Soup', label: 'Soups', cls: 'chip-soup' },
    { key: 'Main course', label: 'Mains', cls: 'chip-main' },
    { key: 'Dessert', label: 'Desserts', cls: 'chip-dessert' },
  ];
  let html = `<div class="loc-tabs">
    <button class="loc-btn ${loc === 'west' ? 'active' : ''}" onclick="setPlannerLoc('west')">Sering West</button>
    <button class="loc-btn ${loc === 'centraal' ? 'active' : ''}" onclick="setPlannerLoc('centraal')">Sering Centraal</button>
  </div>
  <div class="week-scroll"><div class="week-grid"><div></div>`;
  // Calculate week dates
  const today = getToday();
  const todayDow = today.getDay();
  const mondayOff = todayDow === 0 ? -6 : 1 - todayDow;
  const monday = new Date(today); monday.setDate(today.getDate() + mondayOff);
  DAYS.forEach((d, i) => {
    const isToday = i === (new Date().getDay() + 6) % 7;
    const dt = new Date(monday); dt.setDate(monday.getDate() + i);
    const dateStr = `${dt.getDate()}/${dt.getMonth()+1}`;
    html += `<div class="day-hdr${isToday ? ' today-hdr' : ''}">${d}<span class="gt-date">${dateStr}</span></div>`;
  });

  MEALS.forEach(meal => {
    const mealLabel = meal.charAt(0).toUpperCase() + meal.slice(1);
    // Meal header spanning the full row
    html += `<div class="meal-lbl">${mealLabel}</div>`;
    for (let d = 0; d < 7; d++) {
      const gc = getGuests(loc, d, meal);
      const k = `${loc}-${d}-${meal}`;
      const hasDishes = (S.planner[k] || []).length > 0;
      const otherLoc = loc === 'west' ? 'centraal' : 'west';
      const otherLabel = loc === 'west' ? 'Centraal' : 'West';
      const isToday = d === (new Date().getDay() + 6) % 7;
      html += `<div class="slot-header${isToday ? ' today' : ''}">
        <span style="font-size:10px;color:var(--text3);">${gc} guests</span>
        ${hasDishes ? `<button class="copy-slot-btn" onclick="copySlotToOther('${loc}',${d},'${meal}')" title="Copy to ${otherLabel}">→ ${otherLabel}</button>` : ''}
      </div>`;
    }

    // One row per dish type
    typeGroups.forEach(tg => {
      html += `<div class="type-lbl"><span class="type-dot ${tg.cls}"></span>${tg.label}</div>`;
      for (let d = 0; d < 7; d++) {
        const k = `${loc}-${d}-${meal}`;
        const slotDishes = (S.planner[k] || []).filter(dish => dish.type === tg.key);
        const isToday = d === (new Date().getDay() + 6) % 7;
        html += `<div class="slot${isToday ? ' today' : ''}" onclick="openAddDishTyped('${loc}',${d},'${meal}','${tg.key}')">`;
        slotDishes.forEach(dish => {
          const req = calcRequired(dish);
          const trClass = (dish.logistics || '').startsWith('Transport') ? ' chip-tr-border' : '';
          html += `<div class="dish-chip ${tg.cls}${trClass}"><span class="chip-nm">${esc(dish.name)}</span><span class="chip-x" onclick="event.stopPropagation();removeDishFromSlot('${dish.id}','${loc}',${d},'${meal}')">&#10005;</span></div>`;
          html += `<div class="chip-sub">${req}L req</div>`;
        });
        html += `<div class="add-slot-btn" onclick="event.stopPropagation();openAddDishTyped('${loc}',${d},'${meal}','${tg.key}')">+</div></div>`;
      }
    });

    // Spacer row between meals
    if (meal === 'lunch') {
      html += `<div class="meal-spacer"></div>`;
      for (let d = 0; d < 7; d++) html += `<div class="meal-spacer"></div>`;
    }
  });
  html += '</div></div>';
  document.getElementById('screen-planner').innerHTML = html;
}

function setPlannerLoc(loc) { S.currentLoc = loc; rebuildPlanner(); renderPlanner(); }

function removeDishFromSlot(dishId, loc, day, meal) {
  const dish = S.dishes.find(d => d.id === dishId);
  if (dish) { dish.services = (dish.services || []).filter(s => !(s.loc === loc && s.day === day && s.meal === meal)); }
  rebuildPlanner(); renderPlanner(); scheduleSave();
}

function copySlotToOther(fromLoc, day, meal) {
  const toLoc = fromLoc === 'west' ? 'centraal' : 'west';
  const toLabel = toLoc === 'west' ? 'Sering West' : 'Sering Centraal';
  const k = `${fromLoc}-${day}-${meal}`;
  const dishes = S.planner[k] || [];
  if (!dishes.length) return;

  let added = 0;
  dishes.forEach(dish => {
    // Check if this dish is already assigned to the target slot
    const already = (dish.services || []).some(s => s.loc === toLoc && s.day === day && s.meal === meal);
    if (!already) {
      if (!dish.services) dish.services = [];
      dish.services.push({ loc: toLoc, day, meal });
      added++;
    }
  });

  if (added > 0) {
    rebuildPlanner(); renderPlanner(); scheduleSave();
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
  const opts = avail.length === 0
    ? `<div class="empty">No dishes available${typeLabel}${filterOn ? ' at this location' : ''}${searchQuery ? ' matching "' + esc(searchQuery) + '"' : ''}</div>`
    : avail.map(d => {
      const { diff, str, cls } = diffStr(d);
      return `<div class="dish-opt" onclick="confirmAddDish('${d.id}','${loc}',${day},'${meal}')">
        <div><span style="font-weight:500;">${esc(d.name)}</span> ${typeBadge(d.type)}</div>
        <div style="font-size:12px;" class="${cls}">${d.stock}L stock &middot; ${str}</div>
      </div>`;
    }).join('');
  const existingJson = JSON.stringify(existing).replace(/'/g, "\\'");
  const tfEsc = typeFilter ? typeFilter.replace(/'/g, "\\'") : '';
  const tf = `,'${tfEsc}'`;
  showModal(`<h3>Add${typeLabel} to ${DAYS[day]} ${meal} &middot; ${locLabel}</h3>
    <input type="text" class="dish-search" id="planner-search" placeholder="Search dishes..." value="${esc(searchQuery)}"
      oninput="renderAddModal('${loc}',${day},'${meal}',${existingJson},${filterOn},this.value${tf})" />
    <div class="filter-toggle-row" onclick="renderAddModal('${loc}',${day},'${meal}',${existingJson},${!filterOn},''${tf})">
      <div class="tbox${filterOn ? ' on' : ''}"><div class="tknob"></div></div>
      <span>Only show dishes at ${locLabel}</span>
    </div>
    <div class="dish-opts-list">${opts || '<div class="empty">No dishes yet. Add some in Menu planner.</div>'}</div>
    <div class="modal-actions"><button class="btn" onclick="closeModal()">Close</button></div>`);
  // Restore focus and cursor position to search input
  const si = document.getElementById('planner-search');
  if (si) { si.focus(); si.setSelectionRange(si.value.length, si.value.length); }
}

function confirmAddDish(dishId, loc, day, meal) {
  const dish = S.dishes.find(d => d.id === dishId);
  if (dish) { if (!dish.services) dish.services = []; dish.services.push({ loc, day, meal }); }
  closeModal(); rebuildPlanner(); renderPlanner(); scheduleSave();
  toast(`${dish.name} added to ${DAYS[day]} ${meal}`);
}
