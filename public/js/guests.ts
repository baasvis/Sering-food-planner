import { S, DAYS, MEALS, LOCATIONS } from './state';
import { scheduleSave, toast } from './utils';
import { getGuests, calcTotalGuests, getToday } from './core';
import { parseCSV, categorizeUploadedFiles, predictGuests, getVisibleDays, getMondayKeyForDate, localDateStr, renderDayNav } from './predictions';

// Window-indirect aliases (avoid circular deps)
const apiGet = (...args: any[]) => (window as any).apiGet?.(...args);
const apiPost = (...args: any[]) => (window as any).apiPost?.(...args);
const esc = (...args: any[]) => (window as any).esc?.(...args);
const scheduleNextWeeksSave = (...args: any[]) => (window as any).scheduleNextWeeksSave?.(...args);
const toastError = (...args: any[]) => (window as any).toastError?.(...args);

// ── GUESTS ────────────────────────────────────────────────

// Temporary state for CSV processing (only lives while page is open)
export let _pendingUpload = null; // { aggregated, deviceMap, stats } after CSV parse
export let _guestsDayOffset = 0;  // 0 = starting from today, +1 = starting from tomorrow, etc.

export function changeGuestDay(delta: any) {
  _guestsDayOffset = Math.max(-14, Math.min(14, _guestsDayOffset + delta));
  renderGuests();
}

export function renderGuests() {
  const locs = [{ key:'west', label:'Sering West' }, { key:'centraal', label:'Sering Centraal' }];
  const days = getVisibleDays(_guestsDayOffset);

  // Build header actions
  let actions = '';
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
      actions += `<span class="gt-hist-badge" title="Historical data: ${formatDateShort(sorted[0])} — ${formatDateShort(sorted[sorted.length-1])}, ${sorted.length} days">${sorted.length}d history</span>`;
    }
  }
  if (S.predictions) {
    actions += `<button class="btn btn-sm" onclick="applyPredictions()" style="font-size:12px;padding:5px 12px;">Apply predictions</button>`;
  }

  let html = renderDayNav(_guestsDayOffset, -14, 14, 'changeGuestDay', actions);

  // ── Location tables ─────────────────────────────────────
  html += `<div class="guests-grid">`;

  locs.forEach(loc => {
    let weekTotal = 0;
    days.forEach(d => {
      MEALS.forEach(meal => {
        weekTotal += getGuestForDay(loc.key, d)[meal] || 0;
      });
    });

    html += `<div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid var(--border);">
        <h3 style="font-size:14px;font-weight:600;margin:0;">${loc.label}</h3>
        <span style="font-size:12px;color:var(--text2);">Total: <strong>${weekTotal}</strong></span>
      </div>
      <div style="overflow-x:auto;">
      <table class="guest-table">
        <thead><tr>
          <th></th>
          ${days.map(d => {
            const shortDate = `${d.date.getDate()}/${d.date.getMonth()+1}`;
            return `<th class="${d.isToday ? 'gt-today' : ''} ${d.isPast ? 'gt-past' : ''}">${d.dayName}<span class="gt-date">${shortDate}</span></th>`;
          }).join('')}
          <th class="gt-total">Total</th>
        </tr></thead>
        <tbody>`;

    MEALS.forEach(meal => {
      let mealTotal = 0;
      html += `<tr><td>${meal.charAt(0).toUpperCase() + meal.slice(1)}</td>`;
      days.forEach(d => {
        const vals = getGuestForDay(loc.key, d);
        const v = vals[meal] || 0;
        mealTotal += v;
        const pred = S.predictions && S.predictions[loc.key] && S.predictions[loc.key][d.dayName]
          ? S.predictions[loc.key][d.dayName][meal] : null;

        const cellClass = d.isToday ? 'gt-today-cell' : d.isPast ? 'gt-past-cell' : '';

        // Determine the right onchange handler based on which week this day belongs to
        const dateKey = localDateStr(d.date);
        const onchange = d.isCurrentWeek
          ? `updateGuests('${loc.key}','${d.dayName}','${meal}',this.value)`
          : `updateGuestsNextWeek('${d.mondayKey}','${loc.key}','${d.dayName}','${meal}',this.value)`;

        // Staff count for this meal (staff_lunch or staff_dinner)
        const staffKey = meal === 'lunch' ? 'staff_lunch' : 'staff_dinner';
        const staffVal = getGuestForDay(loc.key, d)[staffKey] || 0;

        html += `<td class="${cellClass}">
          <input class="gt-input" type="number" min="0" value="${v}" onchange="${onchange}" />`;
        if (pred !== null && pred !== undefined) {
          const delta = v - pred;
          let deltaHtml = '';
          if (delta > 0) deltaHtml = `<span class="gt-pred-delta gt-pred-up">+${delta}</span>`;
          else if (delta < 0) deltaHtml = `<span class="gt-pred-delta gt-pred-down">${delta}</span>`;
          html += `<div class="gt-pred" title="Predicted from historical data">~${pred} ${deltaHtml}</div>`;
        }
        if (staffVal > 0) {
          html += `<div class="gt-staff" title="${staffVal} staff/volunteer meals included in total">${staffVal} staff</div>`;
        }
        html += `</td>`;
      });
      html += `<td class="gt-total-cell">${mealTotal}</td></tr>`;

      // Dishes row for this meal (current week days only have planned dishes)
      html += `<tr><td></td>`;
      days.forEach(d => {
        const k = `${loc.key}-${d.dayIdx}-${meal}`;
        const dishes = (d.isCurrentWeek ? S.planner[k] : null) || [];
        const cellClass = d.isToday ? 'gt-today-cell' : d.isPast ? 'gt-past-cell' : '';
        html += `<td class="${cellClass}" style="border-bottom:2px solid var(--border);padding-bottom:6px;">
          <div class="gt-dishes">${dishes.length ? dishes.map(di => `<span title="${esc(di.name)}">${esc(di.name.length > 14 ? di.name.slice(0,12) + '…' : di.name)}</span>`).join('') : '<span style="opacity:.3;">—</span>'}</div>
        </td>`;
      });
      html += `<td class="gt-total-cell" style="border-bottom:2px solid var(--border);"></td></tr>`;
    });

    // Daily totals row
    html += `<tr><td style="font-weight:600;">Daily</td>`;
    days.forEach(d => {
      let dayTotal = 0;
      const vals = getGuestForDay(loc.key, d);
      MEALS.forEach(meal => { dayTotal += vals[meal] || 0; });
      const cellClass = d.isToday ? 'gt-today-cell' : d.isPast ? 'gt-past-cell' : '';
      html += `<td class="gt-total-cell ${cellClass}">${dayTotal}</td>`;
    });
    html += `<td class="gt-total-cell" style="font-size:14px;">${weekTotal}</td></tr>`;

    html += `</tbody></table></div></div>`;
  });

  html += '</div>';
  html += renderUploadSection();

  document.getElementById('screen-guests').innerHTML = html;
  setupUploadHandlers();
}

// Get guest values for a specific visible day.
// Returns { lunch, dinner, staff_lunch, staff_dinner }.
// Staff counts come from predictions/history (not manually edited).
export function getGuestForDay(loc: any, dayInfo: any) {
  let base;
  if (dayInfo.isCurrentWeek) {
    base = { ...((S.guests[loc] || {})[dayInfo.dayName] || {}) };
  } else {
    const weekData = S.guestsNextWeeks[dayInfo.mondayKey];
    if (weekData && weekData[loc] && weekData[loc][dayInfo.dayName]) {
      base = { ...weekData[loc][dayInfo.dayName] };
    } else if (S.predictions && S.predictions[loc] && S.predictions[loc][dayInfo.dayName]) {
      base = { ...S.predictions[loc][dayInfo.dayName] };
    } else {
      base = {};
    }
  }
  // Overlay staff counts from predictions (they come from historical data, not manual input)
  if (S.predictions && S.predictions[loc] && S.predictions[loc][dayInfo.dayName]) {
    const pred = S.predictions[loc][dayInfo.dayName];
    if (pred.staff_lunch !== undefined) base.staff_lunch = pred.staff_lunch;
    if (pred.staff_dinner !== undefined) base.staff_dinner = pred.staff_dinner;
  }
  return base;
}

// ── Upload Section HTML ───────────────────────────────────
export function renderUploadSection() {
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

export function sumCatDays(n: any) { return n || 0; }

export function formatDateShort(dateStr: any) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' });
}

// ── Upload Handlers ───────────────────────────────────────
export function setupUploadHandlers() {
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

export async function handleFiles(fileList: any) {
  const files = Array.from(fileList).filter(f => f.name.endsWith('.csv'));
  if (files.length === 0) { toastError('No CSV files found'); return; }

  toast(`Processing ${files.length} file${files.length > 1 ? 's' : ''}...`);

  // Read all files with their filenames (needed for date extraction from ProfitCenter reports)
  const fileContents = [];
  const readPromises = files.map(file => new Promise((resolve: any, reject: any) => {
    const reader = new FileReader();
    reader.onload = () => { fileContents.push({ text: reader.result, filename: file.name }); resolve(); };
    reader.onerror = reject;
    reader.readAsText(file);
  }));

  try { await Promise.all(readPromises); }
  catch (e: unknown) { toastError('Error reading files: ' + (e instanceof Error ? e.message : 'Unknown error')); return; }

  const existingDeviceMap = (S.guestHistory && S.guestHistory.deviceMap) || {};
  const result = categorizeUploadedFiles(fileContents, existingDeviceMap);
  _pendingUpload = result;
  const formatLabels = (result.stats.formats || []).map(f =>
    f === 'tebi-orders' ? 'Tebi' : f === 'tebi-profitcenter' ? 'Tebi ProfitCenter' : f === 'lightspeed' ? 'Lightspeed' : f
  ).join(' + ');
  toast(`Processed ${result.stats.totalMealRows} meals across ${result.stats.daysCount} days (${formatLabels})`);
  renderGuests();
}

export async function saveUploadedHistory() {
  if (!_pendingUpload) return;
  try {
    await apiPost('/api/guest-history', {
      ..._pendingUpload.aggregated,
      deviceMap: _pendingUpload.deviceMap,
      flowDistribution: _pendingUpload.flowDistribution,
    });
    const data = await apiGet('/api/guest-history');
    S.guestHistory = data;
    if (data && (data.west || data.centraal)) S.predictions = predictGuests(data);
    if (data && data.flowDistribution) S.guestFlowDistribution = data.flowDistribution;
    _pendingUpload = null;
    toast('History saved — predictions updated');
    renderGuests();
  } catch (e: unknown) { toastError('Failed to save: ' + (e instanceof Error ? e.message : 'Unknown error')); }
}

// ── Apply Predictions ─────────────────────────────────────
export function applyPredictions() {
  if (!S.predictions) return;
  const days = getVisibleDays(_guestsDayOffset);

  days.forEach(d => {
    for (const loc of ['west', 'centraal']) {
      if (!S.predictions[loc] || !S.predictions[loc][d.dayName]) continue;
      for (const meal of MEALS) {
        const pred = S.predictions[loc][d.dayName][meal];
        if (pred === undefined) continue;

        if (d.isCurrentWeek) {
          if (!S.guests[loc]) S.guests[loc] = {};
          if (!S.guests[loc][d.dayName]) S.guests[loc][d.dayName] = {};
          S.guests[loc][d.dayName][meal] = pred;
        } else {
          if (!S.guestsNextWeeks[d.mondayKey]) S.guestsNextWeeks[d.mondayKey] = {};
          if (!S.guestsNextWeeks[d.mondayKey][loc]) S.guestsNextWeeks[d.mondayKey][loc] = {};
          if (!S.guestsNextWeeks[d.mondayKey][loc][d.dayName]) S.guestsNextWeeks[d.mondayKey][loc][d.dayName] = {};
          S.guestsNextWeeks[d.mondayKey][loc][d.dayName][meal] = pred;
        }
      }
    }
  });

  // Save whichever stores were touched
  scheduleSave();
  const hasNonCurrent = days.some(d => !d.isCurrentWeek);
  if (hasNonCurrent) scheduleNextWeeksSave();
  toast('Predictions applied — adjust for known events');
  renderGuests();
}

// ── Update Guest Count ────────────────────────────────────
export function updateGuests(loc: any, day: any, meal: any, val: any) {
  if (!S.guests[loc]) S.guests[loc] = {};
  if (!S.guests[loc][day]) S.guests[loc][day] = {};
  S.guests[loc][day][meal] = parseInt(val) || 0;
  scheduleSave();
  restoreFocusAfterRender(renderGuests);
}

export function updateGuestsNextWeek(mondayKey: any, loc: any, day: any, meal: any, val: any) {
  if (!S.guestsNextWeeks[mondayKey]) S.guestsNextWeeks[mondayKey] = {};
  if (!S.guestsNextWeeks[mondayKey][loc]) S.guestsNextWeeks[mondayKey][loc] = {};
  if (!S.guestsNextWeeks[mondayKey][loc][day]) S.guestsNextWeeks[mondayKey][loc][day] = {};
  S.guestsNextWeeks[mondayKey][loc][day][meal] = parseInt(val) || 0;
  scheduleNextWeeksSave();
  restoreFocusAfterRender(renderGuests);
}

// Re-render while keeping focus on the same input cell
export function restoreFocusAfterRender(renderFn: any) {
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
  renderFn();
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
