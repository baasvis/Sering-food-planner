import type { GuestDay, Meal, Location, ClosedServiceOverride } from '@shared/types';
import { S, DAYS, MEALS, LOCATIONS } from './state';
import { scheduleSave, toast, apiGet, apiPost, scheduleNextWeeksSave, toastError, saveClosedServices } from './utils';
import { getGuests, calcTotalGuests, getToday, isServiceClosed, previousOpenService, rolledInto, rolledFromMeal, rollWarning, rebuildPlanner } from './core';
import { parseCSV, categorizeUploadedFiles, predictGuests, getVisibleDays, getMondayKeyForDate, localDateStr, renderDayNav } from './predictions';
import { esc } from './modal';
import { registerRenderer } from './navigate';
import { trackEvent } from './telemetry';

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
    actions += `<button class="btn btn-sm" data-testid="apply-predictions-btn" onclick="applyPredictions()" style="font-size:12px;padding:5px 12px;">Apply predictions</button>`;
  }

  let html = renderDayNav(_guestsDayOffset, -14, 14, 'changeGuestDay', actions);

  // ── Location tables ─────────────────────────────────────
  html += `<div class="guests-grid">`;

  locs.forEach(loc => {
    let weekTotal = 0;
    days.forEach(d => {
      MEALS.forEach(meal => {
        weekTotal += effectiveCellGuests(loc.key, d, meal);
      });
    });

    html += `<div class="card guests-loc-card loc-${loc.key}">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid var(--border);">
        <h3 class="loc-accent-text" style="font-size:14px;margin:0;">${loc.label}</h3>
        <span style="font-size:12px;color:var(--text2);">Total: <strong class="loc-accent-text">${weekTotal}</strong></span>
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
        const iso = localDateStr(d.date);
        const vals = getGuestForDay(loc.key, d);
        const v = vals[meal] || 0;
        const closed = isServiceClosed(loc.key, iso, meal);
        const rolled = rolledInto(loc.key, iso, meal);
        // Effective total: a closed cell counts as 0; an open cell adds rolled-in demand.
        mealTotal += closed ? 0 : v + rolled;

        const pred = S.predictions && S.predictions[loc.key] && S.predictions[loc.key][d.dayName]
          ? S.predictions[loc.key][d.dayName][meal] : null;

        const cellClass = d.isToday ? 'gt-today-cell' : d.isPast ? 'gt-past-cell' : '';

        // Determine the right onchange handler based on which week this day belongs to
        const onchange = d.isCurrentWeek
          ? `updateGuests('${loc.key}','${d.dayName}','${meal}',this.value)`
          : `updateGuestsNextWeek('${d.mondayKey}','${loc.key}','${d.dayName}','${meal}',this.value)`;

        // Staff count for this meal (staff_lunch or staff_dinner)
        const staffKey = meal === 'lunch' ? 'staff_lunch' : 'staff_dinner';
        const staffVal = vals[staffKey] || 0;

        html += `<td class="${cellClass}${closed ? ' gt-closed-cell' : ''}">
          <input class="gt-input" type="number" min="0" value="${v}" onchange="${onchange}" />`;
        // Open/closed control — future cells only (closing a past service is moot).
        if (!d.isPast) html += renderStatusControl(loc.key, iso, d.dayName, meal, closed);
        if (closed) {
          const tgt = previousOpenService(loc.key, iso, meal);
          const tgtLabel = tgt ? tgt.meal.charAt(0).toUpperCase() + tgt.meal.slice(1) : null;
          html += `<div class="gt-closed-tag" title="Closed — its ${v} guests are cooked at ${tgtLabel || 'the previous open service'}">Closed${tgtLabel ? ` → ${tgtLabel}` : ''}</div>`;
        } else {
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
          if (rolled > 0) {
            // Name the source meal when it's unambiguous (e.g. a closed dinner →
            // lunch); fall back to a generic label when demand aggregates from
            // more than one source (e.g. a whole closed day rolling cross-day).
            const fromMeal = rolledFromMeal(loc.key, iso, meal);
            const srcLabel = fromMeal ? fromMeal.charAt(0).toUpperCase() + fromMeal.slice(1) : null;
            const rolledText = srcLabel ? `+${rolled} from ${srcLabel} (closed)` : `+${rolled} rolled in`;
            const rolledTitle = srcLabel
              ? `${rolled} guests rolled in from the closed ${srcLabel} service`
              : `${rolled} guests rolled in from closed service(s) at this location`;
            html += `<div class="gt-rolled" title="${rolledTitle}">${rolledText}</div>`;
            const warn = rollWarning(loc.key, iso, meal);
            if (warn && warn.reason === 'no-dish') {
              html += `<div class="gt-roll-warn" title="These rolled guests have no dish assigned here yet — add one or run Fix My Menu">no dish here</div>`;
            }
          }
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
      MEALS.forEach(meal => { dayTotal += effectiveCellGuests(loc.key, d, meal); });
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
    // Mirror core.ts getGuests: overlay any carried-forward week-specific value
    // (entered when this week was "next week") on top of the base weekday pattern,
    // so the grid shows what the planner will actually use.
    const wk = S.guestsNextWeeks[dayInfo.mondayKey];
    const pattern = (S.guests[loc] || {})[dayInfo.dayName] || {};
    base = (wk && wk[loc] && wk[loc][dayInfo.dayName])
      ? { ...pattern, ...wk[loc][dayInfo.dayName] }
      : { ...pattern };
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

// ── Closed-services controls (inline on the Guests screen) ──────────────────

// Effective guests for a Guests-screen cell: a closed slot counts as 0; an open
// slot adds anything rolled in from closed siblings (shares the demand roll-map
// via rolledInto, so the table foots to what the kitchen actually cooks).
function effectiveCellGuests(locKey: string, d: any, meal: string): number {
  const iso = localDateStr(d.date);
  if (isServiceClosed(locKey, iso, meal)) return 0;
  const raw = getGuestForDay(locKey, d)[meal] || 0;
  return raw + rolledInto(locKey, iso, meal);
}

// Per-cell open/closed control. Scope-explicit options so "Open" never silently
// cancels a standing weekly rule. The chosen value drives setServiceClosure().
function renderStatusControl(locKey: string, iso: string, dayName: string, meal: string, closed: boolean): string {
  const cfg = S.closedServices;
  const recClosed = !!(cfg && cfg.recurring && cfg.recurring[locKey]
    && (cfg.recurring[locKey][dayName] || []).indexOf(meal as Meal) !== -1);
  let opts: string;
  if (recClosed) {
    opts = `<option value="open-date">Open just this date</option>`
      + `<option value="open-recurring">Open — every ${dayName}</option>`
      + `<option value="closed-recurring" selected>Closed — every ${dayName}</option>`;
  } else if (closed) {
    opts = `<option value="open">Open</option>`
      + `<option value="closed-date" selected>Closed — this date</option>`
      + `<option value="closed-recurring">Closed — every ${dayName}</option>`;
  } else {
    opts = `<option value="open" selected>Open</option>`
      + `<option value="closed-date">Closed — this date</option>`
      + `<option value="closed-recurring">Closed — every ${dayName}</option>`;
  }
  return `<select class="gt-status${closed ? ' gt-status-closed' : ''}" title="Mark this service open or closed"`
    + ` onchange="setServiceClosure('${locKey}','${iso}','${dayName}','${meal}',this.value)">${opts}</select>`;
}

// Mutate S.closedServices for one service, then persist + rebuild + re-render.
// 'open' clears whatever currently closes the slot at its own scope; scope-explicit
// recurring/date variants are offered when a recurring rule is in effect.
export async function setServiceClosure(locKey: string, iso: string, dayName: string, meal: string, action: string): Promise<void> {
  if (!S.closedServices) S.closedServices = { recurring: {} };
  const cfg = S.closedServices;
  if (!cfg.recurring) cfg.recurring = {};
  const m = meal as Meal;

  const addRecurring = () => {
    if (!cfg.recurring[locKey]) cfg.recurring[locKey] = {};
    const arr = cfg.recurring[locKey][dayName] || [];
    if (arr.indexOf(m) === -1) arr.push(m);
    cfg.recurring[locKey][dayName] = arr;
  };
  const removeRecurring = () => {
    const byDay = cfg.recurring[locKey];
    if (!byDay || !byDay[dayName]) return;
    const next = (byDay[dayName] || []).filter(x => x !== m);
    if (next.length === 0) delete byDay[dayName];
    else byDay[dayName] = next;
    if (Object.keys(byDay).length === 0) delete cfg.recurring[locKey];
  };
  const findOverride = (): ClosedServiceOverride | undefined =>
    cfg.dates && cfg.dates[iso] ? cfg.dates[iso].find(o => o.loc === locKey) : undefined;
  const ensureOverride = (): ClosedServiceOverride => {
    if (!cfg.dates) cfg.dates = {};
    if (!cfg.dates[iso]) cfg.dates[iso] = [];
    let o = cfg.dates[iso].find(x => x.loc === locKey);
    if (!o) { o = { loc: locKey as Location }; cfg.dates[iso].push(o); }
    return o;
  };
  const clearOverrideMeal = () => {
    const o = findOverride();
    if (!o) return;
    if (o.closed) o.closed = o.closed.filter(x => x !== m);
    if (o.open) o.open = o.open.filter(x => x !== m);
  };
  const pruneDates = () => {
    if (!cfg.dates) return;
    if (cfg.dates[iso]) {
      cfg.dates[iso] = cfg.dates[iso].filter(o => (o.closed && o.closed.length) || (o.open && o.open.length));
      if (cfg.dates[iso].length === 0) delete cfg.dates[iso];
    }
    if (Object.keys(cfg.dates).length === 0) delete cfg.dates;
  };

  if (action === 'closed-recurring') {
    addRecurring();
    clearOverrideMeal();          // a one-off rule for this slot is now redundant
  } else if (action === 'closed-date') {
    const o = ensureOverride();
    o.closed = Array.from(new Set([...(o.closed || []), m]));
    o.open = (o.open || []).filter(x => x !== m);
  } else if (action === 'open-date') {
    const o = ensureOverride();   // open just this date despite a recurring closure
    o.open = Array.from(new Set([...(o.open || []), m]));
    o.closed = (o.closed || []).filter(x => x !== m);
  } else if (action === 'open-recurring') {
    removeRecurring();
    clearOverrideMeal();
  } else { // 'open' — clear whatever closes this slot at its own scope
    removeRecurring();
    clearOverrideMeal();
  }
  pruneDates();

  await saveClosedServices();
  rebuildPlanner();
  renderGuests();
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
  const input = document.getElementById('csv-file-input') as HTMLInputElement | null;
  if (!zone || !input) return;

  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragover'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('dragover');
    handleFiles(e.dataTransfer.files);
  });
  zone.addEventListener('click', e => {
    if ((e.target as Element).tagName !== 'BUTTON') input.click();
  });
  input.addEventListener('change', () => {
    if (input.files.length) handleFiles(input.files);
  });
}

export async function handleFiles(fileList: FileList) {
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
  trackEvent('predictions_apply');
  if (!S.predictions) return;
  const days = getVisibleDays(_guestsDayOffset);
  let clearedNextWeek = false;

  days.forEach(d => {
    for (const loc of ['west', 'centraal']) {
      if (!S.predictions[loc] || !S.predictions[loc][d.dayName]) continue;
      for (const meal of MEALS) {
        const pred = S.predictions[loc][d.dayName][meal];
        if (pred === undefined) continue;

        if (d.isCurrentWeek) {
          if (!S.guests[loc]) S.guests[loc] = {};
          if (!S.guests[loc][d.dayName]) S.guests[loc][d.dayName] = {} as GuestDay;
          S.guests[loc][d.dayName][meal] = pred;
          // Clear any carried-forward week-specific value shadowing the base pattern
          // (getGuests prefers it), so the applied prediction wins.
          const wk = S.guestsNextWeeks[d.mondayKey];
          if (wk && wk[loc] && wk[loc][d.dayName] && wk[loc][d.dayName][meal] !== undefined) {
            delete wk[loc][d.dayName][meal];
            clearedNextWeek = true;
          }
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
  if (hasNonCurrent || clearedNextWeek) scheduleNextWeeksSave();
  toast('Predictions applied — adjust for known events');
  renderGuests();
}

// ── Update Guest Count ────────────────────────────────────

// Before writing a user-entered value, materialize any predicted meals that
// were showing as fallbacks in the UI but had never been written. Without
// this, typing into (say) dinner would save { dinner: X } and the displayed
// prediction for lunch would silently be lost — both in the guests grid and
// in downstream planner calculations (core.ts:getGuests returns 0 for a
// missing meal on a future week). See user feedback 2026-04-17.
function seedMissingMealsFromPrediction(target: any, loc: any, day: any) {
  const pred = S.predictions && S.predictions[loc] && S.predictions[loc][day];
  if (!pred) return;
  for (const m of MEALS) {
    if (target[m] === undefined && pred[m] !== undefined) {
      target[m] = pred[m];
    }
  }
}

export function updateGuests(loc: any, day: any, meal: any, val: any) {
  if (!S.guests[loc]) S.guests[loc] = {};
  if (!S.guests[loc][day]) S.guests[loc][day] = {} as GuestDay;
  seedMissingMealsFromPrediction(S.guests[loc][day], loc, day);
  S.guests[loc][day][meal] = parseInt(val) || 0;
  // This handler only fires for the current week (the grid uses updateGuestsNextWeek
  // for other weeks). If a carried-forward week-specific value was shadowing the base
  // pattern (getGuests/getGuestForDay prefer it), clear it so this manual edit wins.
  const curMk = getMondayKeyForDate(getToday());
  const wk = S.guestsNextWeeks[curMk];
  if (wk && wk[loc] && wk[loc][day] && wk[loc][day][meal] !== undefined) {
    delete wk[loc][day][meal];
    scheduleNextWeeksSave();
  }
  scheduleSave();
  restoreFocusAfterRender(renderGuests);
}

export function updateGuestsNextWeek(mondayKey: any, loc: any, day: any, meal: any, val: any) {
  if (!S.guestsNextWeeks[mondayKey]) S.guestsNextWeeks[mondayKey] = {};
  if (!S.guestsNextWeeks[mondayKey][loc]) S.guestsNextWeeks[mondayKey][loc] = {};
  if (!S.guestsNextWeeks[mondayKey][loc][day]) S.guestsNextWeeks[mondayKey][loc][day] = {};
  seedMissingMealsFromPrediction(S.guestsNextWeeks[mondayKey][loc][day], loc, day);
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
      const row = (tables[tableIndex] as HTMLTableElement).rows[rowIndex];
      if (row && row.cells[cellIndex]) {
        const inp = row.cells[cellIndex].querySelector('input');
        if (inp) { inp.focus(); inp.select(); }
      }
    }
  }
}

// Self-register so navigate.ts can dispatch without importing every screen.
registerRenderer('guests', renderGuests);
