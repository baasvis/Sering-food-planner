// ── BATCH TILE RENDERING ─────────────────────────────────
// Extracted from dishes.js — renders individual batch tiles
// Used by dishes.js, planner.js, and core.js

function logisticsRowClass(d) {
  const loc = d.location || 'west';
  if (d.inTransit) return loc === 'centraal' ? 'log-twc' : 'log-tww';
  return loc === 'centraal' ? 'log-centraal' : 'log-west';
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
  return isBatchCooked(d);
}

function isCookDayToday(d) {
  if (!d.cookDate) return false;
  const cd = strToDate(d.cookDate);
  if (!cd) return false;
  const today = getToday();
  return cd.getTime() === today.getTime() && !isBatchCooked(d);
}

function isDishStale(d) {
  if (!isBatchCooked(d) || !d.cookDate) return false;
  if (d.storage === 'Frozen') return false;
  const cd = strToDate(d.cookDate);
  if (!cd) return false;
  const diff = (getToday() - cd) / (1000*60*60*24);
  return diff >= 3;
}

function daysSinceCooked(d) {
  if (!isBatchCooked(d) || !d.cookDate) return 0;
  const cd = strToDate(d.cookDate);
  if (!cd) return 0;
  return Math.floor((getToday() - cd) / (1000*60*60*24));
}

// Short cook date label for the compact batch tile row
function batchCookLabel(d) {
  if (isBatchCooked(d) && d.cookDate) {
    // Already cooked — show "Cooked DD/M"
    const iso = cookDateToISO(d.cookDate);
    const dt = new Date(iso);
    if (!isNaN(dt)) {
      const stale = isDishStale(d);
      return `<span class="cook-label cooked${stale ? ' stale' : ''}" onclick="event.stopPropagation();tileEditCookDate('${d.id}')" title="Click to change cook date">${dt.getDate()}/${dt.getMonth()+1}</span>`;
    }
    return '';
  }
  if (d.cookDate) {
    // Planned cook date — show "Cook DD/M"
    const iso = cookDateToISO(d.cookDate);
    const dt = new Date(iso);
    if (!isNaN(dt)) {
      return `<span class="cook-label planned" onclick="event.stopPropagation();tileEditCookDate('${d.id}')" title="Click to change cook date">${dt.getDate()}/${dt.getMonth()+1}</span>`;
    }
  }
  // No cook date set
  return `<span class="cook-label none" onclick="event.stopPropagation();tileEditCookDate('${d.id}')" title="Click to set cook date">no date</span>`;
}

// Inline date picker triggered from tile cook label
function tileEditCookDate(id) {
  const d = S.batches.find(x => x.id === id);
  if (!d) return;
  // Create a temporary hidden date input, trigger it
  const existing = document.getElementById('tile-cook-picker');
  if (existing) existing.remove();
  const inp = document.createElement('input');
  inp.type = 'date';
  inp.id = 'tile-cook-picker';
  inp.style.cssText = 'position:fixed;top:-100px;left:-100px;opacity:0;';
  inp.value = d.cookDate ? cookDateToISO(d.cookDate) : '';
  inp.onchange = function() {
    setCookDateDirect(id, this.value);
    this.remove();
  };
  inp.onblur = function() { setTimeout(() => this.remove(), 200); };
  document.body.appendChild(inp);
  inp.showPicker ? inp.showPicker() : inp.click();
}

function getCookCellHtml(d) {
  const opts = getCookDayOptions();

  // Already cooked (stock > 0) — show date + stale warning + editable date
  if (isBatchCooked(d) && d.cookDate) {
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
  if (d.cookDate && !isBatchCooked(d)) {
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
  const d = S.batches.find(x => x.id === id);
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
  scheduleSave();
  rerenderCurrentView();
}

function setCookDateDirect(id, isoDate) {
  const d = S.batches.find(x => x.id === id);
  if (!d) return;
  d.cookDate = isoToCookDate(isoDate);
  // If the date is today or in the past and stock is 0, auto-fill stock
  const picked = new Date(isoDate);
  const today = getToday();
  if (picked <= today && (!d.stock || d.stock === 0)) {
    d.stock = calcRequired(d);
    toast(esc(d.name) + ' marked as cooked — stock set to ' + d.stock + 'L');
  }
  scheduleSave();
  rerenderCurrentView();
}

function confirmCooked(id) {
  const d = S.batches.find(x => x.id === id);
  if (!d) return;
  d.cookDate = dateToStr(getToday());
  // Auto-fill stock to required amount if stock was 0
  if (!d.stock || d.stock === 0) {
    d.stock = calcRequired(d);
  }
  scheduleSave();
  rerenderCurrentView();
  toast(esc(d.name) + ' marked as cooked — stock set to ' + d.stock + 'L');
}

// ── BATCH TILE (compact/expand) ──────────────────────────
function toggleBatchExpand(id) {
  if (S.expandedBatches.has(id)) S.expandedBatches.delete(id);
  else S.expandedBatches.add(id);
  rerenderCurrentView();
}

function renderBatchTile(d, showAssign) {
  const { str, cls } = diffStr(d);
  const isExpanded = S.expandedBatches.has(d.id);
  const isSel = S.selected.has(d.id);
  const isStale = isDishStale(d);
  const isAssigning = S.assigningBatchId === d.id;
  const locCls = d.location === 'centraal' ? 'loc-centraal' : 'loc-west';
  const transitCls = d.inTransit ? ' in-transit' : '';
  const frozenCls = d.storage === 'Frozen' ? ' frozen-row' : '';
  const staleCls = isStale ? ' stale-row' : '';
  const selCls = isSel ? ' selected' : '';
  const splitCls = d.parentId ? ' split-child' : '';
  const assignCls = isAssigning ? ' assigning' : '';
  const expandCls = isExpanded ? ' expanded' : '';

  // Compact row
  let html = `<div class="batch-tile ${locCls}${transitCls}${frozenCls}${staleCls}${selCls}${splitCls}${assignCls}${expandCls}" data-id="${d.id}" draggable="true" ondragstart="batchDragStart(event,'${d.id}')" ondragend="batchDragEnd(event)">
    <div class="batch-tile-compact" onclick="toggleBatchExpand('${d.id}')">
      <div class="sel-box${isSel ? ' checked' : ''}" onclick="event.stopPropagation();toggleSelect('${d.id}')"></div>
      <span class="batch-type-dot batch-type-${(d.type||'Soup').toLowerCase().replace(/ /g,'-')}"></span>
      <span class="batch-tile-name">${esc(d.name)}</span>
      <span class="batch-tile-cook">${batchCookLabel(d)}</span>
      <span class="batch-tile-stock ${cls}">${d.stock || 0}L <small>${str}</small></span>
      <span class="batch-tile-logistics ${logisticsBadgeClass(d)}" style="font-size:10px;">${logisticsShort(d)}</span>
      ${d.inTransit ? '<span class="batch-transit-badge">In transit</span>' : ''}
      ${showAssign && !S.assigningBatchId ? `<button class="batch-assign-btn" onclick="event.stopPropagation();startAssignMode('${d.id}')">Assign</button>` : ''}
      <span class="batch-expand-arrow">${isExpanded ? '▾' : '▸'}</span>
    </div>`;

  // Expanded detail panel
  if (isExpanded) {
    const allAg = [...(d.allergens || []), ...(d.extraAllergens || [])];
    const svcLbls = (d.services || []).map(s => {
      const ml = s.meal === 'lunch' ? 'L' : 'D';
      const lc = s.loc === 'west' ? 'SW' : 'SC';
      const past = isServicePast(s) ? ' served' : '';
      return `<span class="batch-svc-label${past}"><strong>${dateToDayName(s.date)}</strong> ${ml} ${lc}</span>`;
    }).join(' ');
    const cookHtml = getCookCellHtml(d);
    const breakdown = calcRequiredBreakdown(d);

    html += `<div class="batch-tile-expanded">
      <div class="batch-detail-grid">
        <div class="batch-detail-section">
          <label>Name</label>
          <input class="inline-edit" value="${esc(d.name)}" onchange="inlineEdit('${d.id}','name',this.value)" onclick="event.stopPropagation();this.select()" />
        </div>
        <div class="batch-detail-section">
          <label>Stock</label>
          <div style="display:flex;align-items:center;gap:6px;">
            <input class="inline-edit" type="number" value="${d.stock || 0}" step="0.5" min="0" style="width:70px;" onchange="inlineEdit('${d.id}','stock',this.value)" onclick="event.stopPropagation();this.select()" />
            <span style="color:var(--text2);">L</span>
            <span class="${cls}" style="font-weight:600;">${str}</span>
          </div>
          ${breakdown.length ? `<div class="batch-breakdown">${breakdown.map(l => `<div>${l}</div>`).join('')}</div>` : ''}
        </div>
        <div class="batch-detail-section">
          <label>Cook date</label>
          ${cookHtml}
        </div>
        <div class="batch-detail-section">
          <label>Type</label>
          <span class="${typeBadgeClass(d.type)}" style="cursor:pointer;" onclick="event.stopPropagation();cycleType('${d.id}')">${d.type}</span>
        </div>
        <div class="batch-detail-section">
          <label>Storage</label>
          <span class="${storageBadgeClass(d.storage || 'Gastro')}" style="cursor:pointer;" onclick="event.stopPropagation();cycleStorage('${d.id}')">${d.storage || 'Gastro'}</span>
        </div>
        <div class="batch-detail-section">
          <label>Location</label>
          <span class="${logisticsBadgeClass(d)}" style="cursor:pointer;" onclick="event.stopPropagation();cycleLocation('${d.id}')">${logisticsShort(d)}</span>
        </div>
        <div class="batch-detail-section">
          <label>Serving</label>
          <span>${d.serving || 280} ml/guest</span>
        </div>
        ${d.recipeSheetId ? `<div class="batch-detail-section"><label>Recipe</label><a href="https://docs.google.com/spreadsheets/d/${esc(d.recipeSheetId)}/edit" target="_blank" rel="noopener" class="recipe-btn" onclick="event.stopPropagation()">Open recipe &#8599;</a></div>` : ''}
        <div class="batch-detail-section">
          <label>Services</label>
          <div>${svcLbls || '<span style="color:var(--red);font-weight:600;">No services assigned</span>'}</div>
        </div>
        <div class="batch-detail-section">
          <label>Allergens</label>
          <div class="allergen-inline">
            ${allAg.map(a => `<span class="allergen-pill" onclick="event.stopPropagation();inlineRemoveAllergen('${d.id}','${esc(a)}')" title="Click to remove">${esc(a)}</span>`).join('')}
            <button class="allergen-add-btn" onclick="event.stopPropagation();inlineAddAllergenStart('${d.id}')">+</button>
          </div>
        </div>
        ${d.note !== undefined ? `<div class="batch-detail-section"><label>Note</label><input class="inline-edit" value="${esc(d.note || '')}" placeholder="Add a note..." onchange="inlineEdit('${d.id}','note',this.value)" onclick="event.stopPropagation()" /></div>` : ''}
      </div>
      <div class="batch-tile-actions">
        <button class="order-toggle-btn${d.orderFor ? ' on' : ''}" onclick="event.stopPropagation();toggleOrder('${d.id}')">${d.orderFor ? 'Order' : '—'}</button>
        ${isBatchCooked(d)
          ? `<button class="served-btn" onclick="event.stopPropagation();openServedDialog('${d.id}')">Served</button>`
          : `${(d.services || []).length > 0 ? `<button class="btn btn-sm" style="background:var(--blue);color:white;" onclick="event.stopPropagation();openReplaceBatch('${d.id}')">Replace</button>` : ''}
             <button class="btn btn-sm btn-danger" onclick="event.stopPropagation();deleteBatch('${d.id}')">Delete</button>`
        }
      </div>
    </div>`;
  }

  html += '</div>';
  return html;
}

// ── INLINE EDITING ON TILES ──────────────────────────────
function inlineEdit(id, field, value) {
  const d = S.batches.find(x => x.id === id);
  if (!d) return;
  if (field === 'name') { d.name = value.trim() || d.name; }
  else if (field === 'stock') {
    d.stock = parseFloat(value) || 0;
    // Auto-set cook date when stock first entered
    if (d.stock > 0 && !d.cookDate) d.cookDate = dateToStr(getToday());
  }
  else if (field === 'location') { d.location = value; d.inTransit = false; }
  else if (field === 'note') { d.note = value; }
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
  const d = S.batches.find(x => x.id === id);
  if (!d) return;
  d.allergens = (d.allergens || []).filter(a => a !== allergen);
  d.extraAllergens = (d.extraAllergens || []).filter(a => a !== allergen);
  scheduleSave();
  rerenderCurrentView();
}

function inlineAddAllergenStart(id) {
  const d = S.batches.find(x => x.id === id);
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
  const d = S.batches.find(x => x.id === id);
  if (!d) return;
  if (!d.extraAllergens) d.extraAllergens = [];
  const allExisting = [...(d.allergens || []), ...d.extraAllergens];
  if (!allExisting.includes(val)) d.extraAllergens.push(val);
  scheduleSave();
  rerenderCurrentView();
}
