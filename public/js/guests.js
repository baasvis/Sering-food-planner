// ── GUESTS ────────────────────────────────────────────────
function renderGuests() {
  const locs = [{ key:'west', label:'Sering West' }, { key:'centraal', label:'Sering Centraal' }];

  // Calculate dates for this week (Mon-Sun)
  const today = getToday();
  const todayDow = today.getDay(); // 0=Sun, 1=Mon...
  const mondayOffset = todayDow === 0 ? -6 : 1 - todayDow;
  const monday = new Date(today);
  monday.setDate(today.getDate() + mondayOffset);
  const weekDates = DAYS.map((_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d;
  });
  const shortDate = d => `${d.getDate()}/${d.getMonth()+1}`;

  let html = `<div style="margin-bottom:16px;"><span style="font-size:16px;font-weight:600;">Expected guests this week</span>
    <span style="font-size:12px;color:var(--text2);margin-left:8px;">Edit the numbers below. Totals update automatically.</span>
  </div><div class="guests-grid">`;

  locs.forEach(loc => {
    // Weekly total
    let weekTotal = 0;
    DAYS.forEach(day => {
      MEALS.forEach(meal => {
        weekTotal += ((S.guests[loc.key] || {})[day] || {})[meal] || 0;
      });
    });

    html += `<div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid var(--border);">
        <h3 style="font-size:14px;font-weight:600;margin:0;">${loc.label}</h3>
        <span style="font-size:12px;color:var(--text2);">Week total: <strong>${weekTotal}</strong> servings</span>
      </div>
      <div style="overflow-x:auto;">
      <table class="guest-table">
        <thead><tr>
          <th></th>
          ${DAYS.map((day, i) => {
            const isToday = weekDates[i].toDateString() === today.toDateString();
            return `<th style="${isToday ? 'color:var(--blue);' : ''}">${day}<span class="gt-date">${shortDate(weekDates[i])}</span></th>`;
          }).join('')}
          <th class="gt-total">Total</th>
        </tr></thead>
        <tbody>`;

    MEALS.forEach(meal => {
      let mealTotal = 0;
      html += `<tr><td>${meal.charAt(0).toUpperCase() + meal.slice(1)}</td>`;
      DAYS.forEach((day, i) => {
        const v = ((S.guests[loc.key] || {})[day] || {})[meal] || 0;
        mealTotal += v;
        const isToday = weekDates[i].toDateString() === today.toDateString();
        html += `<td style="${isToday ? 'background:var(--blue-bg);' : ''}">
          <input class="gt-input" type="number" min="0" value="${v}" onchange="updateGuests('${loc.key}','${day}','${meal}',this.value)" />
        </td>`;
      });
      html += `<td class="gt-total-cell">${mealTotal}</td></tr>`;

      // Dishes row for this meal
      html += `<tr><td></td>`;
      DAYS.forEach((day, i) => {
        const k = `${loc.key}-${i}-${meal}`;
        const dishes = S.planner[k] || [];
        const isToday = weekDates[i].toDateString() === today.toDateString();
        html += `<td style="border-bottom:2px solid var(--border);padding-bottom:6px;${isToday ? 'background:var(--blue-bg);' : ''}">
          <div class="gt-dishes">${dishes.length ? dishes.map(d => `<span title="${esc(d.name)}">${esc(d.name.length > 14 ? d.name.slice(0,12) + '…' : d.name)}</span>`).join('') : '<span style="opacity:.3;">—</span>'}</div>
        </td>`;
      });
      // Daily totals column - show sum for this meal
      html += `<td class="gt-total-cell" style="border-bottom:2px solid var(--border);"></td></tr>`;
    });

    // Daily totals row
    html += `<tr><td style="font-weight:600;">Daily</td>`;
    DAYS.forEach((day, i) => {
      let dayTotal = 0;
      MEALS.forEach(meal => { dayTotal += ((S.guests[loc.key] || {})[day] || {})[meal] || 0; });
      const isToday = weekDates[i].toDateString() === today.toDateString();
      html += `<td class="gt-total-cell" style="${isToday ? 'background:var(--blue-bg);' : ''}">${dayTotal}</td>`;
    });
    html += `<td class="gt-total-cell" style="font-size:14px;">${weekTotal}</td></tr>`;

    html += `</tbody></table></div></div>`;
  });

  html += '</div>';
  document.getElementById('screen-guests').innerHTML = html;
}

function updateGuests(loc, day, meal, val) {
  if (!S.guests[loc]) S.guests[loc] = {};
  if (!S.guests[loc][day]) S.guests[loc][day] = {};
  S.guests[loc][day][meal] = parseInt(val) || 0;
  scheduleSave();
  // Re-render to update totals, then restore focus
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
