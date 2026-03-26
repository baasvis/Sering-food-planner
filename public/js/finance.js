// ─────────────────────────────────────────────────────────────────────────────
// FINANCE — Revenue overview from Tebi POS
// ─────────────────────────────────────────────────────────────────────────────

function getFinanceMonday(offset) {
  const d = new Date();
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday
  d.setDate(diff + (offset || 0) * 7);
  d.setHours(0, 0, 0, 0);
  return d;
}

function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmtDateShort(dateStr) {
  const [y, m, d] = dateStr.split('-');
  return `${d}/${m}`;
}

function fmtEuro(n) {
  if (n == null || isNaN(n)) return '-';
  return '€' + Number(n).toLocaleString('nl-NL', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function fmtEuroFull(n) {
  if (n == null || isNaN(n)) return '-';
  return '€' + Number(n).toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── Data loading ────────────────────────────────────────────────────────────

async function loadFinanceData() {
  const monday = getFinanceMonday(S.financeWeekOffset);
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);

  // Also load the full month for summary
  const monthStart = new Date(monday.getFullYear(), monday.getMonth(), 1);
  const monthEnd = new Date(monday.getFullYear(), monday.getMonth() + 1, 0);

  const start = fmtDate(monthStart < monday ? monthStart : monday);
  const end = fmtDate(monthEnd > sunday ? monthEnd : sunday);

  try {
    S.financeData = await apiGet(`/api/finance/revenue?start=${start}&end=${end}`);
  } catch (e) {
    console.error('Failed to load finance data:', e);
    S.financeData = [];
  }
}

async function checkSyncStatus() {
  try {
    const status = await apiGet('/api/finance/sync-status');
    S.financeSyncing = status.syncing;
    return status;
  } catch (e) {
    return { syncing: false };
  }
}

async function triggerSync() {
  if (S.financeSyncing) return;

  // Sync the last 7 days by default
  const end = new Date();
  end.setDate(end.getDate() - 1);
  const start = new Date(end);
  start.setDate(start.getDate() - 6);

  try {
    S.financeSyncing = true;
    renderFinance();
    await apiPost('/api/finance/sync', {
      startDate: fmtDate(start),
      endDate: fmtDate(end),
    });

    // Poll for completion
    const poll = setInterval(async () => {
      const status = await checkSyncStatus();
      if (!status.syncing) {
        clearInterval(poll);
        S.financeSyncing = false;
        await loadFinanceData();
        renderFinance();
        if (status.lastSyncError) {
          showToast(status.lastSyncError, 'error');
        } else {
          showToast('Revenue synced from Tebi');
        }
      }
    }, 3000);

  } catch (e) {
    S.financeSyncing = false;
    showToast('Sync failed: ' + e.message, 'error');
    renderFinance();
  }
}

// ── Render ───────────────────────────────────────────────────────────────────

async function renderFinance() {
  const el = document.getElementById('screen-finance');
  if (!el) return;

  // Load data if empty
  if (S.financeData.length === 0 && !S.financeSyncing) {
    await loadFinanceData();
  }

  const monday = getFinanceMonday(S.financeWeekOffset);
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);

  // Build week dates array
  const weekDates = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(d.getDate() + i);
    weekDates.push(fmtDate(d));
  }

  // Group data by date and location
  const byDateLoc = {};
  (S.financeData || []).forEach(row => {
    const key = `${row.date}|${row.location}`;
    byDateLoc[key] = row;
  });

  // Get "all" totals for week
  const weekTotals = weekDates.map(d => byDateLoc[`${d}|all`] || null);

  // Monthly totals
  const monthStart = new Date(monday.getFullYear(), monday.getMonth(), 1);
  const monthEnd = new Date(monday.getFullYear(), monday.getMonth() + 1, 0);
  let monthGross = 0, monthNet = 0, monthSales = 0, monthCovers = 0;
  (S.financeData || []).forEach(row => {
    if (row.location !== 'all') return;
    if (row.date >= fmtDate(monthStart) && row.date <= fmtDate(monthEnd)) {
      monthGross += row.grossRevenue || 0;
      monthNet += row.netRevenue || 0;
      monthSales += row.sales || 0;
      monthCovers += row.covers || 0;
    }
  });

  // Week gross total for bar chart scaling
  const weekGrossValues = weekTotals.map(t => (t && t.grossRevenue) || 0);
  const maxGross = Math.max(...weekGrossValues, 1);

  // Month name
  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const monthLabel = `${monthNames[monday.getMonth()]} ${monday.getFullYear()}`;

  // Location rows for the table
  const locations = ['west', 'centraal', 'testtafel'];
  const locLabels = { west: 'Sering West', centraal: 'Sering Centraal', testtafel: 'TestTafel' };

  const syncBtnText = S.financeSyncing
    ? '<span class="fin-spinner"></span> Syncing...'
    : 'Sync from Tebi';

  el.innerHTML = `
    <div class="fin-header">
      <div class="fin-week-nav">
        <button class="fin-nav-btn" onclick="changeFinanceWeek(-1)">&larr;</button>
        <span class="fin-week-label">
          ${fmtDateShort(weekDates[0])} — ${fmtDateShort(weekDates[6])}
        </span>
        <button class="fin-nav-btn" onclick="changeFinanceWeek(1)">&rarr;</button>
      </div>
      <button class="fin-sync-btn ${S.financeSyncing ? 'syncing' : ''}"
              onclick="triggerSync()" ${S.financeSyncing ? 'disabled' : ''}>
        ${syncBtnText}
      </button>
    </div>

    <div class="fin-month-summary">
      <h3>${monthLabel}</h3>
      <div class="fin-cards">
        <div class="fin-card">
          <div class="fin-card-label">Gross revenue</div>
          <div class="fin-card-value">${fmtEuroFull(monthGross)}</div>
        </div>
        <div class="fin-card">
          <div class="fin-card-label">Net revenue</div>
          <div class="fin-card-value">${fmtEuroFull(monthNet)}</div>
        </div>
        <div class="fin-card">
          <div class="fin-card-label">Sales</div>
          <div class="fin-card-value">${monthSales}</div>
        </div>
        <div class="fin-card">
          <div class="fin-card-label">Covers</div>
          <div class="fin-card-value">${monthCovers || '-'}</div>
        </div>
      </div>
    </div>

    <div class="fin-chart-section">
      <h3>Daily gross revenue</h3>
      <div class="fin-chart">
        ${weekDates.map((d, i) => {
          const val = weekGrossValues[i];
          const pct = Math.round((val / maxGross) * 100);
          const isToday = d === fmtDate(new Date());
          return `
            <div class="fin-bar-col">
              <div class="fin-bar-value">${val > 0 ? fmtEuro(val) : ''}</div>
              <div class="fin-bar-track">
                <div class="fin-bar ${isToday ? 'today' : ''}" style="height:${pct}%"></div>
              </div>
              <div class="fin-bar-label">${DAYS[i]}</div>
            </div>`;
        }).join('')}
      </div>
    </div>

    <div class="fin-table-section">
      <h3>Revenue by location</h3>
      <table class="fin-table">
        <thead>
          <tr>
            <th></th>
            ${weekDates.map((d, i) => `<th>${DAYS[i]}<br><small>${fmtDateShort(d)}</small></th>`).join('')}
            <th>Week</th>
          </tr>
        </thead>
        <tbody>
          ${locations.map(loc => {
            const cells = weekDates.map(d => {
              const row = byDateLoc[`${d}|${loc}`];
              return row && row.grossRevenue ? fmtEuro(row.grossRevenue) : '-';
            });
            const weekTotal = weekDates.reduce((sum, d) => {
              const row = byDateLoc[`${d}|${loc}`];
              return sum + ((row && row.grossRevenue) || 0);
            }, 0);
            return `
              <tr>
                <td class="fin-loc-label">${locLabels[loc] || loc}</td>
                ${cells.map(c => `<td>${c}</td>`).join('')}
                <td class="fin-week-total">${weekTotal > 0 ? fmtEuro(weekTotal) : '-'}</td>
              </tr>`;
          }).join('')}
          <tr class="fin-total-row">
            <td class="fin-loc-label"><strong>Total</strong></td>
            ${weekDates.map(d => {
              const row = byDateLoc[`${d}|all`];
              return `<td><strong>${row && row.grossRevenue ? fmtEuro(row.grossRevenue) : '-'}</strong></td>`;
            }).join('')}
            <td class="fin-week-total"><strong>${fmtEuro(weekGrossValues.reduce((a, b) => a + b, 0))}</strong></td>
          </tr>
        </tbody>
      </table>
    </div>

    ${S.financeData.length === 0 && !S.financeSyncing ? `
      <div class="fin-empty">
        No revenue data yet. Click <strong>Sync from Tebi</strong> to pull data.
      </div>
    ` : ''}
  `;
}

function changeFinanceWeek(delta) {
  S.financeWeekOffset += delta;
  loadFinanceData().then(() => renderFinance());
}
