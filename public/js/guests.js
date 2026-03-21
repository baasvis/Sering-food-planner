// ── GUESTS ────────────────────────────────────────────────

// Temporary state for CSV processing (only lives while page is open)
let _pendingUpload = null; // { aggregated, deviceMap, stats } after CSV parse
let _guestsWeekOffset = 0; // 0 = this week, 1 = next week, 2 = in two weeks

function renderGuests() {
  const locs = [{ key:'west', label:'Sering West' }, { key:'centraal', label:'Sering Centraal' }];
  const isCurrentWeek = _guestsWeekOffset === 0;

  // Calculate dates for the selected week
  const today = getToday();
  const todayDow = today.getDay(); // 0=Sun, 1=Mon...
  const mondayOffset = todayDow === 0 ? -6 : 1 - todayDow;
  const monday = new Date(today);
  monday.setDate(today.getDate() + mondayOffset + _guestsWeekOffset * 7);
  // Monday date key for storing future week data (e.g. "2026-03-23")
  // Use local date parts to avoid timezone shift from toISOString()
  const mondayKey = `${monday.getFullYear()}-${String(monday.getMonth()+1).padStart(2,'0')}-${String(monday.getDate()).padStart(2,'0')}`;
  const weekDates = DAYS.map((_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d;
  });
  const sunday = weekDates[6];
  const shortDate = d => `${d.getDate()}/${d.getMonth()+1}`;
  const weekLabel = _guestsWeekOffset === 0 ? 'This week'
    : _guestsWeekOffset === 1 ? 'Next week'
    : `In ${_guestsWeekOffset} weeks`;

  let html = '';

  // ── Week navigation header ─────────────────────────────
  html += `<div class="gt-header">
    <div class="gt-nav">
      <button class="gt-nav-btn" onclick="changeGuestWeek(-1)" ${_guestsWeekOffset <= 0 ? 'disabled' : ''} title="Previous week">&larr;</button>
      <div class="gt-week-label">
        <span class="gt-week-title">${weekLabel}</span>
        <span class="gt-week-dates">${shortDate(monday)} — ${shortDate(sunday)} ${monday.toLocaleDateString('en-GB', {month:'short', year:'numeric'})}</span>
      </div>
      <button class="gt-nav-btn" onclick="changeGuestWeek(1)" ${_guestsWeekOffset >= 2 ? 'disabled' : ''} title="Next week">&rarr;</button>
    </div>
    <div class="gt-header-actions">`;

  // History info (compact, inline)
  if (S.guestHistory && (S.guestHistory.west || S.guestHistory.centraal)) {
    const allDates = new Set();
    for (const loc of ['west', 'centraal']) {
      if (!S.guestHistory[loc]) continue;
      for (const meal of ['lunch', 'dinner', 'staff']) {
        if (S.guestHistory[loc][meal]) Object.keys(S.guestHistory[loc][meal]).forEach(d => allDates.add(d));
      }
    }
    const sorted = [...allDates].sort();
    if (sorted.length > 0) {
      html += `<span class="gt-hist-badge" title="Historical data: ${formatDateShort(sorted[0])} — ${formatDateShort(sorted[sorted.length-1])}, ${sorted.length} days">${sorted.length}d history</span>`;
    }
  }

  if (S.predictions) {
    html += `<button class="btn btn-sm" onclick="applyPredictions()" style="font-size:12px;padding:5px 12px;">Apply predictions</button>`;
  }
  html += `</div></div>`;

  // ── Location tables ─────────────────────────────────────
  html += `<div class="guests-grid">`;

  locs.forEach(loc => {
    let weekTotal = 0;
    DAYS.forEach(day => {
      MEALS.forEach(meal => {
        weekTotal += getGuestValue(loc.key, day, isCurrentWeek, mondayKey)[meal] || 0;
      });
    });

    html += `<div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid var(--border);">
        <h3 style="font-size:14px;font-weight:600;margin:0;">${loc.label}</h3>
        <span style="font-size:12px;color:var(--text2);">Week total: <strong>${weekTotal}</strong></span>
      </div>
      <div style="overflow-x:auto;">
      <table class="guest-table">
        <thead><tr>
          <th></th>
          ${DAYS.map((day, i) => {
            const isToday = weekDates[i].toDateString() === today.toDateString();
            const isPast = weekDates[i] < today && !isToday;
            return `<th class="${isToday ? 'gt-today' : ''} ${isPast ? 'gt-past' : ''}">${day}<span class="gt-date">${shortDate(weekDates[i])}</span></th>`;
          }).join('')}
          <th class="gt-total">Total</th>
        </tr></thead>
        <tbody>`;

    MEALS.forEach(meal => {
      let mealTotal = 0;
      html += `<tr><td>${meal.charAt(0).toUpperCase() + meal.slice(1)}</td>`;
      DAYS.forEach((day, i) => {
        const vals = getGuestValue(loc.key, day, isCurrentWeek, mondayKey);
        const v = vals[meal] || 0;
        mealTotal += v;
        const isToday = weekDates[i].toDateString() === today.toDateString();
        const isPast = weekDates[i] < today && !isToday;
        const pred = S.predictions && S.predictions[loc.key] && S.predictions[loc.key][day]
          ? S.predictions[loc.key][day][meal] : null;

        const cellClass = isToday ? 'gt-today-cell' : isPast ? 'gt-past-cell' : '';
        const onchange = isCurrentWeek
          ? `updateGuests('${loc.key}','${day}','${meal}',this.value)`
          : `updateGuestsNextWeek('${mondayKey}','${loc.key}','${day}','${meal}',this.value)`;

        html += `<td class="${cellClass}">
          <input class="gt-input" type="number" min="0" value="${v}" onchange="${onchange}" />`;
        if (pred !== null && pred !== undefined) {
          const delta = v - pred;
          let deltaHtml = '';
          if (delta > 0) deltaHtml = `<span class="gt-pred-delta gt-pred-up">+${delta}</span>`;
          else if (delta < 0) deltaHtml = `<span class="gt-pred-delta gt-pred-down">${delta}</span>`;
          html += `<div class="gt-pred" title="Predicted from historical data">~${pred} ${deltaHtml}</div>`;
        }
        html += `</td>`;
      });
      html += `<td class="gt-total-cell">${mealTotal}</td></tr>`;

      // Dishes row (only for current week — future weeks don't have dishes planned)
      if (isCurrentWeek) {
        html += `<tr><td></td>`;
        DAYS.forEach((day, i) => {
          const k = `${loc.key}-${i}-${meal}`;
          const dishes = S.planner[k] || [];
          const isToday = weekDates[i].toDateString() === today.toDateString();
          const isPast = weekDates[i] < today && !isToday;
          const cellClass = isToday ? 'gt-today-cell' : isPast ? 'gt-past-cell' : '';
          html += `<td class="${cellClass}" style="border-bottom:2px solid var(--border);padding-bottom:6px;">
            <div class="gt-dishes">${dishes.length ? dishes.map(d => `<span title="${esc(d.name)}">${esc(d.name.length > 14 ? d.name.slice(0,12) + '…' : d.name)}</span>`).join('') : '<span style="opacity:.3;">—</span>'}</div>
          </td>`;
        });
        html += `<td class="gt-total-cell" style="border-bottom:2px solid var(--border);"></td></tr>`;
      }
    });

    // Daily totals row
    html += `<tr><td style="font-weight:600;">Daily</td>`;
    DAYS.forEach((day, i) => {
      let dayTotal = 0;
      const vals = getGuestValue(loc.key, day, isCurrentWeek, mondayKey);
      MEALS.forEach(meal => { dayTotal += vals[meal] || 0; });
      const isToday = weekDates[i].toDateString() === today.toDateString();
      const isPast = weekDates[i] < today && !isToday;
      const cellClass = isToday ? 'gt-today-cell' : isPast ? 'gt-past-cell' : '';
      html += `<td class="gt-total-cell ${cellClass}">${dayTotal}</td>`;
    });
    html += `<td class="gt-total-cell" style="font-size:14px;">${weekTotal}</td></tr>`;

    html += `</tbody></table></div></div>`;
  });

  html += '</div>';

  // ── Upload section (below tables) ───────────────────────
  html += renderUploadSection();

  document.getElementById('screen-guests').innerHTML = html;
  setupUploadHandlers();
}

// Get guest values for a day — from S.guests for current week, from guestsNextWeeks for future
function getGuestValue(loc, day, isCurrentWeek, mondayKey) {
  if (isCurrentWeek) {
    return ((S.guests[loc] || {})[day] || {});
  }
  // Future weeks: check saved values first, then fall back to predictions
  const weekData = S.guestsNextWeeks[mondayKey];
  if (weekData && weekData[loc] && weekData[loc][day]) {
    return weekData[loc][day];
  }
  // Fall back to predictions
  if (S.predictions && S.predictions[loc] && S.predictions[loc][day]) {
    return S.predictions[loc][day];
  }
  return {};
}

// ── Week Navigation ───────────────────────────────────────
function changeGuestWeek(delta) {
  _guestsWeekOffset = Math.max(0, Math.min(2, _guestsWeekOffset + delta));
  renderGuests();
}

// ── Upload Section HTML ───────────────────────────────────
function renderUploadSection() {
  let html = `<div class="card gt-upload-card" style="margin-top:24px;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
      <h3 style="font-size:14px;font-weight:600;margin:0;">Upload Tebi Data</h3>
      <span style="font-size:11px;color:var(--text3);">CSV exports from Tebi POS</span>
    </div>
    <div id="upload-zone" class="upload-zone">
      <div style="margin-bottom:4px;font-size:13px;">Drop weekly CSV files here</div>
      <div style="font-size:11px;color:var(--text3);margin-bottom:10px;">or click to select files</div>
      <input type="file" id="csv-file-input" accept=".csv" multiple style="display:none;" />
      <button class="btn btn-sm" onclick="document.getElementById('csv-file-input').click()" style="font-size:12px;">Choose files</button>
    </div>`;

  if (_pendingUpload) {
    const s = _pendingUpload.stats;
    html += `<div class="upload-stats" style="margin-top:12px;padding:12px;background:var(--bg2);border-radius:var(--radius);">
      <div style="font-size:13px;font-weight:600;margin-bottom:8px;">Processed ${s.totalMealRows} meal entries across ${s.daysCount} days</div>
      ${s.dateRange ? `<div style="margin-bottom:6px;">Date range: <strong>${formatDateShort(s.dateRange.from)}</strong> to <strong>${formatDateShort(s.dateRange.to)}</strong></div>` : ''}
      <div style="display:flex;gap:16px;flex-wrap:wrap;font-size:12px;margin-bottom:8px;">
        <span>West lunch: <strong>${sumCatDays(s.perCategory.westLunch)}</strong>d</span>
        <span>West dinner: <strong>${sumCatDays(s.perCategory.westDinner)}</strong>d</span>
        <span>West staff: <strong>${sumCatDays(s.perCategory.westStaff)}</strong>d</span>
        <span>Centraal lunch: <strong>${sumCatDays(s.perCategory.centraalLunch)}</strong>d</span>
        <span>Centraal dinner: <strong>${sumCatDays(s.perCategory.centraalDinner)}</strong>d</span>
        <span>Centraal staff: <strong>${sumCatDays(s.perCategory.centraalStaff)}</strong>d</span>
      </div>
      ${s.unmappedRows > 0 ? `<div style="color:var(--amber);font-size:11px;margin-bottom:8px;">${s.unmappedRows} rows skipped (register not identified as West or Centraal)</div>` : ''}
      <button class="btn btn-primary btn-sm" onclick="saveUploadedHistory()" style="font-size:12px;padding:6px 16px;">Save to history</button>
      <button class="btn btn-sm" onclick="_pendingUpload=null;renderGuests();" style="font-size:12px;padding:6px 12px;margin-left:8px;">Discard</button>
    </div>`;
  }

  html += `</div>`;
  return html;
}

function sumCatDays(n) { return n || 0; }

function formatDateShort(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' });
}

// ── Upload Handlers ───────────────────────────────────────
function setupUploadHandlers() {
  const zone = document.getElementById('upload-zone');
  const input = document.getElementById('csv-file-input');
  if (!zone || !input) return;

  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragover'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('dragover');
    handleFiles(e.dataTransfer.files);
  });
  zone.addEventListener('click', e => {
    if (e.target.tagName !== 'BUTTON') input.click();
  });
  input.addEventListener('change', () => {
    if (input.files.length) handleFiles(input.files);
  });
}

// Read multiple CSV files, parse them all, then categorize
async function handleFiles(fileList) {
  const files = Array.from(fileList).filter(f => f.name.endsWith('.csv'));
  if (files.length === 0) { toastError('No CSV files found'); return; }

  toast(`Processing ${files.length} file${files.length > 1 ? 's' : ''}...`);

  const allRows = [];
  const readPromises = files.map(file => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const rows = parseCSV(reader.result);
      allRows.push(...rows);
      resolve();
    };
    reader.onerror = reject;
    reader.readAsText(file);
  }));

  try {
    await Promise.all(readPromises);
  } catch (e) {
    toastError('Error reading files: ' + e.message);
    return;
  }

  const existingDeviceMap = (S.guestHistory && S.guestHistory.deviceMap) || {};
  const result = categorizeTebiData(allRows, existingDeviceMap);
  _pendingUpload = result;

  toast(`Processed ${result.stats.totalMealRows} meals across ${result.stats.daysCount} days`);
  renderGuests();
}

// Save processed upload to server
async function saveUploadedHistory() {
  if (!_pendingUpload) return;

  try {
    const payload = {
      ..._pendingUpload.aggregated,
      deviceMap: _pendingUpload.deviceMap
    };
    await apiPost('/api/guest-history', payload);

    const data = await apiGet('/api/guest-history');
    S.guestHistory = data;
    if (data && (data.west || data.centraal)) {
      S.predictions = predictGuests(data);
    }

    _pendingUpload = null;
    toast('History saved — predictions updated');
    renderGuests();
  } catch (e) {
    toastError('Failed to save: ' + e.message);
  }
}

// ── Update Guest Count (future weeks) ─────────────────────
function updateGuestsNextWeek(mondayKey, loc, day, meal, val) {
  if (!S.guestsNextWeeks[mondayKey]) S.guestsNextWeeks[mondayKey] = {};
  if (!S.guestsNextWeeks[mondayKey][loc]) S.guestsNextWeeks[mondayKey][loc] = {};
  if (!S.guestsNextWeeks[mondayKey][loc][day]) S.guestsNextWeeks[mondayKey][loc][day] = {};
  S.guestsNextWeeks[mondayKey][loc][day][meal] = parseInt(val) || 0;
  scheduleNextWeeksSave();
  // Re-render with focus restore
  const active = document.activeElement;
  const wasInput = active && active.tagName === 'INPUT' && active.closest('.guest-table');
  let cellIndex, rowIndex, tableIndex;
  if (wasInput) {
    const td = active.closest('td');
    const tr = active.closest('tr');
    const table = active.closest('.guest-table');
    cellIndex = td ? td.cellIndex : -1;
    rowIndex = tr ? tr.rowIndex : -1;
    const tables = document.querySelectorAll('.guest-table');
    tableIndex = Array.from(tables).indexOf(table);
  }
  renderGuests();
  if (wasInput && tableIndex >= 0) {
    const tables = document.querySelectorAll('.guest-table');
    if (tables[tableIndex]) {
      const row = tables[tableIndex].rows[rowIndex];
      if (row && row.cells[cellIndex]) {
        const inp = row.cells[cellIndex].querySelector('input');
        if (inp) { inp.focus(); inp.select(); }
      }
    }
  }
}

// ── Apply Predictions ─────────────────────────────────────
function applyPredictions() {
  if (!S.predictions) return;
  const isCurrentWeek = _guestsWeekOffset === 0;

  if (isCurrentWeek) {
    for (const loc of ['west', 'centraal']) {
      if (!S.predictions[loc]) continue;
      if (!S.guests[loc]) S.guests[loc] = {};
      for (const day of DAYS) {
        if (!S.predictions[loc][day]) continue;
        if (!S.guests[loc][day]) S.guests[loc][day] = {};
        for (const meal of MEALS) {
          if (S.predictions[loc][day][meal] !== undefined) {
            S.guests[loc][day][meal] = S.predictions[loc][day][meal];
          }
        }
      }
    }
    scheduleSave();
  } else {
    // Calculate monday key for this offset
    const today = getToday();
    const todayDow = today.getDay();
    const mondayOff = todayDow === 0 ? -6 : 1 - todayDow;
    const mon = new Date(today);
    mon.setDate(today.getDate() + mondayOff + _guestsWeekOffset * 7);
    const mondayKey = `${mon.getFullYear()}-${String(mon.getMonth()+1).padStart(2,'0')}-${String(mon.getDate()).padStart(2,'0')}`;

    if (!S.guestsNextWeeks[mondayKey]) S.guestsNextWeeks[mondayKey] = {};
    for (const loc of ['west', 'centraal']) {
      if (!S.predictions[loc]) continue;
      if (!S.guestsNextWeeks[mondayKey][loc]) S.guestsNextWeeks[mondayKey][loc] = {};
      for (const day of DAYS) {
        if (!S.predictions[loc][day]) continue;
        if (!S.guestsNextWeeks[mondayKey][loc][day]) S.guestsNextWeeks[mondayKey][loc][day] = {};
        for (const meal of MEALS) {
          if (S.predictions[loc][day][meal] !== undefined) {
            S.guestsNextWeeks[mondayKey][loc][day][meal] = S.predictions[loc][day][meal];
          }
        }
      }
    }
    scheduleNextWeeksSave();
  }

  toast('Predictions applied — adjust for known events');
  renderGuests();
}

// ── Update Guest Count ────────────────────────────────────
function updateGuests(loc, day, meal, val) {
  if (!S.guests[loc]) S.guests[loc] = {};
  if (!S.guests[loc][day]) S.guests[loc][day] = {};
  S.guests[loc][day][meal] = parseInt(val) || 0;
  scheduleSave();
  const active = document.activeElement;
  const wasInput = active && active.tagName === 'INPUT' && active.closest('.guest-table');
  let cellIndex, rowIndex, tableIndex;
  if (wasInput) {
    const td = active.closest('td');
    const tr = active.closest('tr');
    const table = active.closest('.guest-table');
    cellIndex = td ? td.cellIndex : -1;
    rowIndex = tr ? tr.rowIndex : -1;
    const tables = document.querySelectorAll('.guest-table');
    tableIndex = Array.from(tables).indexOf(table);
  }
  renderGuests();
  if (wasInput && tableIndex >= 0) {
    const tables = document.querySelectorAll('.guest-table');
    if (tables[tableIndex]) {
      const row = tables[tableIndex].rows[rowIndex];
      if (row && row.cells[cellIndex]) {
        const inp = row.cells[cellIndex].querySelector('input');
        if (inp) { inp.focus(); inp.select(); }
      }
    }
  }
}
