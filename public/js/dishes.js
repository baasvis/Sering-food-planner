// ── DISH LIST ─────────────────────────────────────────────
let dishSort = { col: 'default', dir: 'asc' };

function renderDishesOverview() {
  const f = S.filters;
  const filtered = S.dishes.filter(d => {
    if (f.loc !== 'all') {
      const ml = (f.loc === 'west' && (d.logistics === 'Sering West' || d.logistics === 'Transport to Sering Centraal')) || (f.loc === 'centraal' && (d.logistics === 'Sering Centraal' || d.logistics === 'Transport to Sering West'));
      const sl = (d.services || []).some(s => s.loc === f.loc);
      if (!ml && !sl) return false;
    }
    if (f.storage !== 'all' && d.storage !== f.storage) return false;
    if (f.logistics !== 'all' && d.logistics !== f.logistics) return false;
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
    <button class="btn btn-primary" onclick="openNewDish()">+ New dish</button>
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
      <button class="fc ${f.logistics === 'all' ? 'on' : ''}" onclick="setFilter('logistics','all')">All logistics</button>
      <button class="fc ${f.logistics === 'Sering West' ? 'on' : ''}" onclick="setFilter('logistics','Sering West')">At West</button>
      <button class="fc ${f.logistics === 'Transport to Sering Centraal' ? 'on' : ''}" onclick="setFilter('logistics','Transport to Sering Centraal')">&rarr; Centraal</button>
      <button class="fc ${f.logistics === 'Transport to Sering West' ? 'on' : ''}" onclick="setFilter('logistics','Transport to Sering West')">&rarr; West</button>
      <button class="fc ${f.logistics === 'Sering Centraal' ? 'on' : ''}" onclick="setFilter('logistics','Sering Centraal')">At Centraal</button>
    </div>
  </div>
  <div style="display:flex;gap:12px;font-size:10px;color:var(--text3);margin-bottom:8px;padding:4px 0;">
    <span><span style="display:inline-block;width:10px;height:10px;background:#BA7517;border-radius:2px;vertical-align:middle;margin-right:3px;"></span>At West</span>
    <span><span style="display:inline-block;width:10px;height:10px;background:#0F6E56;border-radius:2px;vertical-align:middle;margin-right:3px;"></span>At Centraal</span>
    <span><span style="display:inline-block;width:10px;height:10px;background:#97C459;border-radius:2px;vertical-align:middle;margin-right:3px;"></span>Transport → Centraal</span>
    <span><span style="display:inline-block;width:10px;height:10px;background:#EF9F27;border-radius:2px;vertical-align:middle;margin-right:3px;"></span>Transport → West</span>
  </div>
  <div id="split-bar-area"></div>
  <div class="dish-list-hdr">
    <span></span>
    <span class="${sCls('name')}" onclick="dishSortBy('name')">Dish${arrow('name')}</span>
    <span class="${sCls('date')}" onclick="dishSortBy('date')">Cook date${arrow('date')}</span>
    <span class="${sCls('stock')}" onclick="dishSortBy('stock')">Stock${arrow('stock')}</span>
    <span class="${sCls('diff')}" onclick="dishSortBy('diff')">+/&minus;${arrow('diff')}</span>
    <span>Location</span>
    <span>Order</span>
    <span></span>
  </div>
  <div style="font-size:12px;color:var(--text2);margin-bottom:8px;">${sorted.length} dish${sorted.length !== 1 ? 'es' : ''}${dishSort.col !== 'default' ? ` · sorted by ${dishSort.col}` : ''}</div>
  ${sorted.length === 0 ? '<div class="empty">No dishes match these filters</div>' : (dishSort.col !== 'default' ? sorted.map(d => renderDishRow(d)).join('') : renderDishGroups(sorted))}`;

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

function logisticsRowClass(l) {
  if (l === 'Sering West') return 'log-west';
  if (l === 'Sering Centraal') return 'log-centraal';
  if (l === 'Transport to Sering Centraal') return 'log-twc';
  if (l === 'Transport to Sering West') return 'log-tww';
  return 'log-west';
}

function renderDishGroups(dishes) {
  const toCook = dishes.filter(d => !d.cookConfirmed && d.storage !== 'Frozen');
  const cooked = dishes.filter(d => d.cookConfirmed && d.storage !== 'Frozen');
  const frozen = dishes.filter(d => d.storage === 'Frozen');

  let html = '';

  if (toCook.length) {
    html += `<div class="dish-section-hdr"><div class="dish-section-dot" style="background:var(--amber);"></div>To cook <span class="dish-section-count">(${toCook.length})</span></div>`;
    html += toCook.map(d => renderDishRow(d)).join('');
  }

  if (cooked.length) {
    html += `<div class="dish-section-hdr"><div class="dish-section-dot" style="background:var(--green);"></div>Cooked <span class="dish-section-count">(${cooked.length})</span></div>`;
    html += cooked.map(d => renderDishRow(d)).join('');
  }

  if (frozen.length) {
    html += `<div class="dish-section-hdr"><div class="dish-section-dot" style="background:var(--blue);"></div>Frozen <span class="dish-section-count">(${frozen.length})</span></div>`;
    html += frozen.map(d => renderDishRow(d)).join('');
  }

  return html;
}

function renderDishRow(d) {
  const req = calcRequired(d);
  const { diff, str, cls } = diffStr(d);
  const allAg = [...(d.allergens || []), ...(d.extraAllergens || [])];
  const svcLbls = (d.services || []).map(s => {
    const ml = s.meal === 'lunch' ? 'L' : 'D';
    const lc = s.loc === 'west' ? 'SW' : 'SC';
    return `<strong>${dateToDayName(s.date)}</strong> ${ml} ${lc}`;
  }).join(' · ');
  const isSel = S.selected.has(d.id);
  const isFrozen = d.storage === 'Frozen';
  const cookHtml = getCookCellHtml(d);
  const isStale = isDishStale(d);
  const logClass = logisticsRowClass(d.logistics || 'Sering West');
  return `<div class="dish-row ${logClass}${d.parentId ? ' split-child' : ''}${isSel ? ' selected' : ''}${isStale ? ' stale-row' : ''}${isFrozen ? ' frozen-row' : ''}">
    <div class="sel-box${isSel ? ' checked' : ''}" onclick="toggleSelect('${d.id}')"></div>
    <div>
      <input class="inline-edit inline-edit-name" value="${esc(d.name)}" onchange="inlineEdit('${d.id}','name',this.value)" onclick="event.stopPropagation();this.select()" />
      <div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;margin-top:2px;padding-left:6px;">
        <span class="${typeBadgeClass(d.type)}" style="cursor:pointer;" onclick="event.stopPropagation();cycleType('${d.id}')" title="Click to change">${d.type}</span>
        <span class="${storageBadgeClass(d.storage || 'Gastro')}" style="cursor:pointer;" onclick="event.stopPropagation();cycleStorage('${d.id}')" title="Click to change">${d.storage || 'Gastro'}</span>
        ${d.recipeSheetId ? `<a href="https://docs.google.com/spreadsheets/d/${esc(d.recipeSheetId)}/edit" target="_blank" rel="noopener" onclick="event.stopPropagation()" class="recipe-btn">Recipe &#8599;</a>` : ''}
        <div class="allergen-inline" id="ag-inline-${d.id}" style="display:inline-flex;">
          ${allAg.map(a => `<span class="allergen-pill" onclick="event.stopPropagation();inlineRemoveAllergen('${d.id}','${esc(a)}')" title="Click to remove">${esc(a)}</span>`).join('')}
          <button class="allergen-add-btn" onclick="event.stopPropagation();inlineAddAllergenStart('${d.id}')" title="Add allergen">+</button>
        </div>
        ${svcLbls ? `<span style="font-size:12px;color:var(--text);">${svcLbls}</span>` : '<span style="font-size:12px;font-weight:600;color:var(--red);">no day assigned</span>'}
      </div>
    </div>
    <div class="col-cook">${cookHtml}</div>
    <div class="col-stock"><input class="inline-edit inline-edit-stock${d.cookConfirmed ? '' : ' stock-locked'}" type="number" value="${d.stock || 0}" step="0.5" min="0" onchange="inlineEdit('${d.id}','stock',this.value)" onclick="event.stopPropagation();this.select()" ${d.cookConfirmed ? '' : 'disabled title="Cook this dish first to set stock"'} /></div>
    <div class="col-diff ${cls}" title="${calcRequiredBreakdown(d).join('&#10;') || 'No services assigned'}">${str}</div>
    <div class="col-logistics">
      <span class="${logisticsBadgeClass(d.logistics || 'Sering West')}" style="cursor:pointer;" onclick="event.stopPropagation();cycleLogistics('${d.id}')" title="Click to change">${logisticsShort(d.logistics || 'Sering West')}</span>
    </div>
    <div><button class="order-toggle-btn${d.orderFor ? ' on' : ''}" onclick="event.stopPropagation();toggleOrder('${d.id}')">${d.orderFor ? 'Order' : '—'}</button></div>
    <div><button class="served-btn" onclick="event.stopPropagation();openServedDialog('${d.id}')">Served</button></div>
    <div class="m-stock-row">
      <span style="font-size:12px;">Stock: <strong>${d.stock || 0}L</strong></span>
      <span class="${cls}" style="font-size:12px;" title="${calcRequiredBreakdown(d).join('&#10;') || 'No services assigned'}">${str}</span>
      <span class="${logisticsBadgeClass(d.logistics || 'Sering West')}" style="cursor:pointer;font-size:10px;" onclick="event.stopPropagation();cycleLogistics('${d.id}')">${logisticsShort(d.logistics || 'Sering West')}</span>
    </div>
  </div>`;
}

function inlineEdit(id, field, value) {
  const d = S.dishes.find(x => x.id === id);
  if (!d) return;
  if (field === 'name') { d.name = value.trim() || d.name; }
  else if (field === 'stock') { d.stock = parseFloat(value) || 0; }
  else if (field === 'logistics') { d.logistics = value; }
  rebuildPlanner();
  scheduleSave();
  // Re-render only the computed columns without full re-render (to keep focus)
  const row = document.querySelector(`.dish-row input[onchange*="'${id}','stock'"]`);
  if (row) {
    const rowEl = row.closest('.dish-row');
    const { str, cls } = diffStr(d);
    const diffEl = rowEl.querySelector('.col-diff');
    if (diffEl) { diffEl.textContent = str; diffEl.className = 'col-diff ' + cls; }
  }
}

function inlineRemoveAllergen(id, allergen) {
  const d = S.dishes.find(x => x.id === id);
  if (!d) return;
  d.allergens = (d.allergens || []).filter(a => a !== allergen);
  d.extraAllergens = (d.extraAllergens || []).filter(a => a !== allergen);
  scheduleSave();
  rerenderCurrentView();
}

function inlineAddAllergenStart(id) {
  const d = S.dishes.find(x => x.id === id);
  if (!d) return;
  const container = document.getElementById('ag-inline-' + id);
  if (!container || container.querySelector('.allergen-add-select')) return;
  const btn = container.querySelector('.allergen-add-btn');
  const allExisting = [...(d.allergens || []), ...(d.extraAllergens || [])];
  const available = ALLERGENS.filter(a => !allExisting.includes(a));
  const select = document.createElement('select');
  select.className = 'allergen-add-select allergen-add-input';
  select.style.width = '90px';
  select.innerHTML = '<option value="">pick...</option>'
    + available.map(a => `<option value="${a}">${a}</option>`).join('')
    + '<option value="__custom">Other...</option>';
  select.onchange = function() {
    if (this.value === '__custom') {
      this.remove();
      const input = document.createElement('input');
      input.className = 'allergen-add-input';
      input.placeholder = 'type...';
      input.onkeydown = function(e) {
        if (e.key === 'Enter') { inlineAddAllergenConfirm(id, this.value); }
        if (e.key === 'Escape') { rerenderCurrentView(); }
      };
      input.onblur = function() {
        if (this.value.trim()) inlineAddAllergenConfirm(id, this.value);
        else rerenderCurrentView();
      };
      container.insertBefore(input, btn);
      input.focus();
    } else if (this.value) {
      inlineAddAllergenConfirm(id, this.value);
    }
  };
  select.onblur = function() {
    if (!this.value) rerenderCurrentView();
  };
  container.insertBefore(select, btn);
  btn.style.display = 'none';
  select.focus();
}

function inlineAddAllergenConfirm(id, value) {
  const val = value.trim();
  if (!val) { rerenderCurrentView(); return; }
  const d = S.dishes.find(x => x.id === id);
  if (!d) return;
  if (!d.extraAllergens) d.extraAllergens = [];
  const allExisting = [...(d.allergens || []), ...d.extraAllergens];
  if (!allExisting.includes(val)) d.extraAllergens.push(val);
  scheduleSave();
  rerenderCurrentView();
}

// ── COOK DATE/DAY LOGIC ──────────────────────────────────
function getToday() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function dateToStr(d) {
  const dd = String(d.getDate()).padStart(2,'0');
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const yyyy = d.getFullYear();
  return dd+'/'+mm+'/'+yyyy;
}

function strToDate(s) {
  if (!s) return null;
  // handle dd/mm/yyyy
  const parts = s.split('/');
  if (parts.length === 3) return new Date(parseInt(parts[2]), parseInt(parts[1])-1, parseInt(parts[0]));
  // handle yyyy-mm-dd (legacy)
  return new Date(s);
}

function getCookDayOptions() {
  const today = getToday();
  const todayDow = (today.getDay() + 6) % 7; // 0=Mon
  const dayNames = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
  const opts = [];
  // This week: today through Sunday
  for (let i = todayDow; i < 7; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + (i - todayDow));
    const label = i === todayDow ? 'Today (' + dayNames[i] + ')' : dayNames[i];
    opts.push({ value: dateToStr(d), label });
  }
  // Next week: Monday through Sunday
  const daysUntilNextMon = 7 - todayDow;
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + daysUntilNextMon + i);
    opts.push({ value: dateToStr(d), label: 'Next ' + dayNames[i] });
  }
  return opts;
}

function isDishCooked(d) {
  if (!d.cookDate) return false;
  const cd = strToDate(d.cookDate);
  if (!cd) return false;
  return cd <= getToday() && d.cookConfirmed;
}

function isCookDayToday(d) {
  if (!d.cookDate) return false;
  const cd = strToDate(d.cookDate);
  if (!cd) return false;
  const today = getToday();
  return cd.getTime() === today.getTime() && !d.cookConfirmed;
}

function isDishStale(d) {
  if (!d.cookConfirmed || !d.cookDate) return false;
  if (d.storage === 'Frozen') return false;
  const cd = strToDate(d.cookDate);
  if (!cd) return false;
  const diff = (getToday() - cd) / (1000*60*60*24);
  return diff >= 3;
}

function daysSinceCooked(d) {
  if (!d.cookConfirmed || !d.cookDate) return 0;
  const cd = strToDate(d.cookDate);
  if (!cd) return 0;
  return Math.floor((getToday() - cd) / (1000*60*60*24));
}

function getCookCellHtml(d) {
  const opts = getCookDayOptions();

  // Already cooked (confirmed) — show date + stale warning + editable date
  if (d.cookConfirmed && d.cookDate) {
    const stale = isDishStale(d);
    const days = daysSinceCooked(d);
    let html = `<input type="date" class="cook-date-input" value="${cookDateToISO(d.cookDate)}" onchange="setCookDateDirect('${d.id}',this.value)" onclick="event.stopPropagation()" title="Change cooked date" />`;
    if (stale) {
      html += `<div class="cook-stale">${days}d ago — serve or freeze</div>`;
    }
    return html;
  }
  // Planned for today — show confirm button
  if (isCookDayToday(d)) {
    return `<button class="cook-today-btn" onclick="event.stopPropagation();confirmCooked('${d.id}')">Click to mark as cooked</button>`;
  }
  // Has a planned future day — show dropdown (with option to switch to date)
  if (d.cookDate && !d.cookConfirmed) {
    return `<select class="cook-select has-date" onchange="setCookDay('${d.id}',this.value)" onclick="event.stopPropagation()">
      <option value="">Select day/date</option>
      ${opts.map(o => `<option value="${o.value}"${d.cookDate === o.value ? ' selected' : ''}>${o.label}</option>`).join('')}
      <option value="__date">Pick a date...</option>
    </select>`;
  }
  // No plan yet — show dropdown with red warning style
  return `<select class="cook-select no-date" onchange="setCookDay('${d.id}',this.value)" onclick="event.stopPropagation()">
    <option value="">Select day/date</option>
    ${opts.map(o => `<option value="${o.value}">${o.label}</option>`).join('')}
    <option value="__date">Pick a date...</option>
  </select>`;
}

function cookDateToISO(ddmmyyyy) {
  if (!ddmmyyyy) return '';
  const parts = ddmmyyyy.split('/');
  if (parts.length === 3) return parts[2]+'-'+parts[1]+'-'+parts[0];
  return ddmmyyyy;
}

function isoToCookDate(iso) {
  if (!iso) return '';
  const parts = iso.split('-');
  if (parts.length === 3) return parts[2]+'/'+parts[1]+'/'+parts[0];
  return iso;
}

function setCookDay(id, value) {
  const d = S.dishes.find(x => x.id === id);
  if (!d) return;
  if (value === '__date') {
    // Replace the select with a date input
    const row = document.querySelector(`[onchange="setCookDay('${id}',this.value)"]`);
    if (row) {
      const input = document.createElement('input');
      input.type = 'date';
      input.className = 'cook-date-input';
      input.style.width = '100%';
      input.onchange = function() {
        setCookDateDirect(id, this.value);
      };
      input.onclick = function(e) { e.stopPropagation(); };
      row.replaceWith(input);
      input.focus();
      input.showPicker && input.showPicker();
    }
    return;
  }
  d.cookDate = value || null;
  d.cookConfirmed = false;
  d.cookMode = 'day';
  scheduleSave();
  rerenderCurrentView();
}

function setCookDateDirect(id, isoDate) {
  const d = S.dishes.find(x => x.id === id);
  if (!d) return;
  d.cookDate = isoToCookDate(isoDate);
  // If the date is today or in the past, mark as confirmed
  const picked = new Date(isoDate);
  const today = getToday();
  d.cookConfirmed = picked <= today;
  d.cookMode = 'date';
  // Auto-fill stock to required amount if just confirmed and stock was 0
  if (d.cookConfirmed && (!d.stock || d.stock === 0)) {
    d.stock = calcRequired(d);
  }
  scheduleSave();
  rerenderCurrentView();
  if (d.cookConfirmed) toast(esc(d.name) + ' marked as cooked — stock set to ' + d.stock + 'L');
}

function confirmCooked(id) {
  const d = S.dishes.find(x => x.id === id);
  if (!d) return;
  d.cookDate = dateToStr(getToday());
  d.cookConfirmed = true;
  // Auto-fill stock to required amount if stock was 0
  if (!d.stock || d.stock === 0) {
    d.stock = calcRequired(d);
  }
  scheduleSave();
  rerenderCurrentView();
  toast(esc(d.name) + ' marked as cooked — stock set to ' + d.stock + 'L');
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
  const selD = [...S.selected].map(id => S.dishes.find(d => d.id === id)).filter(Boolean);
  const names = selD.map(d => d.name).join(', ');
  const hasWest = selD.some(d => d.logistics === 'Sering West');
  const hasCentraal = selD.some(d => d.logistics === 'Sering Centraal');

  // Calculate smart amounts for transport splits (capped at surplus)
  let smartCentraalAmt = 0;
  let smartWestAmt = 0;
  selD.forEach(d => {
    if (d.logistics === 'Sering West') {
      const neededHere = calcRequiredForLoc(d, 'west');
      const surplus = Math.max(0, d.stock - neededHere);
      const neededThere = calcRequiredForLoc(d, 'centraal');
      smartCentraalAmt += Math.min(neededThere, surplus);
    }
    if (d.logistics === 'Sering Centraal') {
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
    <label>Logistics</label><select id="sp-logistics">${LOGISTICS.map(l => `<option>${l}</option>`).join('')}</select>
    <button class="btn btn-primary" onclick="doSplit(false)">Split off</button>
    ${hasWest ? `<button class="btn btn-purple" onclick="doTransportSplit('centraal',${smartCentraalAmt})">Split ${smartCentraalAmt}L &rarr; Centraal</button>` : ''}
    ${hasCentraal ? `<button class="btn btn-purple" onclick="doTransportSplit('west',${smartWestAmt})">Split ${smartWestAmt}L &rarr; West</button>` : ''}
    <button class="btn" onclick="S.selected.clear();rerenderCurrentView()">Cancel</button>
  </div>`;
}

function doSplit(isTransport, targetLoc, smartAmounts) {
  const manualAmt = parseFloat(document.getElementById('sp-amt').value);
  const defaultStorage = document.getElementById('sp-storage').value;
  const logistics = isTransport ? (targetLoc === 'centraal' ? 'Transport to Sering Centraal' : 'Transport to Sering West') : document.getElementById('sp-logistics').value;
  let errors = [];
  [...S.selected].forEach(id => {
    const d = S.dishes.find(x => x.id === id);
    if (!d) return;
    // Inherit storage from source dish (frozen stays frozen)
    const storage = isTransport ? (d.storage || defaultStorage) : defaultStorage;
    // Calculate how much is needed at the current location
    const currentLoc = d.logistics === 'Sering West' ? 'west' : 'centraal';
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
      if (surplus <= 0) { errors.push(`"${d.name}" needs all ${d.stock}L at ${d.logistics} (${neededHere}L required)`); return; }
      amt = surplus;
    }
    d.stock = Math.round((d.stock - amt) * 10) / 10;
    const targetLocName = targetLoc === 'centraal' ? 'centraal' : 'west';
    const newDish = {
      id: newId(), name: d.name, type: d.type, storage, logistics, stock: amt,
      serving: d.serving || 280, recipeSheetId: d.recipeSheetId,
      recipeVolume: d.recipeVolume,
      recipeIngredients: d.recipeIngredients ? [...d.recipeIngredients] : undefined,
      allergens: [...(d.allergens || [])], extraAllergens: [...(d.extraAllergens || [])],
      orderFor: false, parentId: d.id, cookDate: d.cookDate, cookMode: d.cookMode,
      cookDay: d.cookDay, cookConfirmed: d.cookConfirmed || false,
      services: isTransport ? ((d.services || []).filter(s => s.loc === targetLocName)) : []
    };
    if (isTransport) d.services = (d.services || []).filter(s => s.loc !== targetLocName);
    S.dishes.push(newDish);
  });
  if (errors.length) { alert('Cannot split: ' + errors.join(', ')); return; }
  S.selected.clear(); rebuildPlanner(); rerenderCurrentView(); scheduleSave();
  toast('Stock split created');
}
function doTransportSplit(tl, smartAmt) { doSplit(true, tl, true); }

// ── NEW DISH ──────────────────────────────────────────────
function openNewDish() {
  renderNewDishModal('');
}

function renderNewDishModal(searchQuery) {
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
    : `<div class="empty" style="padding:12px;">${S.recipeIndex.length === 0 ? 'No recipes in index yet. Add some in the Dish index tab.' : 'No recipes match "' + esc(searchQuery) + '"'}</div>`;

  showModal(`<h3>Add dish to menu</h3>
    <div style="font-size:12px;color:var(--text2);margin-bottom:10px;">Pick from your recipe index:</div>
    <input type="text" class="dish-search" placeholder="Search recipes..." value="${esc(searchQuery)}"
      oninput="renderNewDishModal(this.value)" autofocus />
    <div class="dish-opts-list" style="max-height:260px;">${recipeList}</div>
    <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border);">
      <div style="font-size:12px;color:var(--text2);margin-bottom:8px;">Or create from scratch:</div>
      <button class="btn" onclick="openNewDishScratch()">Create blank dish</button>
    </div>
    <div class="modal-actions"><button class="btn" onclick="closeModal()">Close</button></div>`);
}

function openNewDishScratch() {
  showModal(`<h3>New dish</h3>
    <div class="fr"><label>Name</label><input type="text" id="nd-name" placeholder="e.g. Mushroom soup" /></div>
    <div class="fr"><label>Type</label><select id="nd-type">
      <option>Soup</option><option>Main course</option><option>Dessert</option>
    </select></div>
    <div class="fr"><label>Stock (liters)</label><input type="number" id="nd-stock" value="0" step="0.5" min="0" /></div>
    <div class="fr"><label>Serving size (ml per guest)</label><input type="number" id="nd-serving" value="280" /></div>
    <div class="fr"><label>Storage state</label><select id="nd-storage">${STORAGE.map(s => `<option>${s}</option>`).join('')}</select></div>
    <div class="fr"><label>Location</label><select id="nd-logistics">${LOGISTICS.map(l => `<option>${l}</option>`).join('')}</select></div>
    <div class="fr"><label>Recipe Google Sheet ID (optional)</label>
      <input type="text" id="nd-sheetid" placeholder="Paste the sheet ID from the URL" />
      <div style="font-size:11px;color:var(--text2);margin-top:4px;">Found in the sheet URL: /spreadsheets/d/<strong>THIS_PART</strong>/edit</div>
    </div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveNewDish()">Create dish</button>
    </div>`);
}

async function saveNewDish() {
  const name = document.getElementById('nd-name').value.trim();
  if (!name) { alert('Please enter a dish name'); return; }
  const sheetId = document.getElementById('nd-sheetid').value.trim();
  const newDish = {
    id: newId(), name,
    type: document.getElementById('nd-type').value,
    stock: parseFloat(document.getElementById('nd-stock').value) || 0,
    serving: parseInt(document.getElementById('nd-serving').value) || 280,
    storage: document.getElementById('nd-storage').value,
    logistics: document.getElementById('nd-logistics').value,
    recipeSheetId: sheetId || null,
    allergens: [], extraAllergens: [], orderFor: false, parentId: null,
    cookMode: 'day', cookDay: null, cookDate: null, services: []
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
  S.dishes.push(newDish);
  closeModal(); rebuildPlanner(); rerenderCurrentView(); scheduleSave();
  toast(`"${name}" added`);
}

// ── EDIT DISH ─────────────────────────────────────────────
function openEditDish(id) {
  const d = S.dishes.find(x => x.id === id);
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
    <div class="fr"><label>Logistics</label><select id="ed-logistics">
      ${LOGISTICS.map(l => `<option${d.logistics === l ? ' selected' : ''}>${l}</option>`).join('')}
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
  const d = S.dishes.find(x => x.id === id); if (!d) return;
  d.cookMode = mode;
  document.getElementById('ct-day').classList.toggle('active', mode === 'day');
  document.getElementById('ct-date').classList.toggle('active', mode === 'date');
  document.getElementById('cook-input').innerHTML = mode === 'day'
    ? `<select id="ed-cookday">${['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(day => `<option${d.cookDay === day ? ' selected' : ''}>${day}</option>`).join('')}</select>`
    : `<input type="date" id="ed-cookdate" value="${d.cookDate || ''}" />`;
}

function addExtraAllergen(id) {
  const d = S.dishes.find(x => x.id === id); if (!d) return;
  const inp = document.getElementById('ag-new');
  const val = (inp.value || '').trim(); if (!val) return;
  if (!d.extraAllergens) d.extraAllergens = [];
  if (!d.extraAllergens.includes(val) && !(d.allergens || []).includes(val)) d.extraAllergens.push(val);
  inp.value = '';
  refreshAllergenTags(d);
}

function removeExtraAllergen(id, allergen) {
  const d = S.dishes.find(x => x.id === id); if (!d) return;
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
  const d = S.dishes.find(x => x.id === id); if (!d || !d.recipeSheetId) return;
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
  const d = S.dishes.find(x => x.id === id); if (!d) return;
  d.name = document.getElementById('ed-name').value;
  d.stock = parseFloat(document.getElementById('ed-stock').value) || 0;
  d.type = document.getElementById('ed-type').value;
  d.storage = document.getElementById('ed-storage').value;
  d.logistics = document.getElementById('ed-logistics').value;
  d.orderFor = document.getElementById('ed-order').value === 'true';
  if (d.cookMode === 'day') { const el = document.getElementById('ed-cookday'); if (el) d.cookDay = el.value || null; }
  else { const el = document.getElementById('ed-cookdate'); if (el) d.cookDate = el.value || null; }
  closeModal(); rebuildPlanner(); rerenderCurrentView(); scheduleSave();
  toast('Dish saved');
}

function deleteDish(id) {
  if (!confirm('Delete this dish? This cannot be undone.')) return;
  S.dishes = S.dishes.filter(d => d.id !== id);
  closeModal(); rebuildPlanner(); rerenderCurrentView(); scheduleSave();
  toast('Dish deleted');
}
