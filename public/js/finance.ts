import { S, LOCATIONS, DAYS } from './state';
import { apiGet, apiPost, toast, toastError } from './utils';
import { esc } from './modal';
import { trackEvent } from './telemetry';

// ─────────────────────────────────────────────────────────────────────────────
// FINANCE — Revenue overview from Tebi POS
// ─────────────────────────────────────────────────────────────────────────────

export function getFinanceMonday(offset: any) {
  const d = new Date();
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday
  d.setDate(diff + (offset || 0) * 7);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function fmtDate(d: any) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function fmtDateShort(dateStr: any) {
  const [y, m, d] = dateStr.split('-');
  return `${d}/${m}`;
}

export function fmtEuro(n: any) {
  if (n == null || isNaN(n)) return '-';
  return '€' + Number(n).toLocaleString('nl-NL', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

export function fmtEuroFull(n: any) {
  if (n == null || isNaN(n)) return '-';
  return '€' + Number(n).toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export const SERVICE_PERIODS = [
  { key: 'all', label: 'All' },
  { key: 'morning', label: 'Morning' },
  { key: 'lunch', label: 'Lunch' },
  { key: 'afternoon', label: 'Afternoon' },
  { key: 'dinner', label: 'Dinner' },
  { key: 'bar', label: 'Bar' },
];

export const FINANCE_LOCATIONS = [
  { key: 'all', label: 'All locations' },
  { key: 'west', label: 'West' },
  { key: 'centraal', label: 'Centraal' },
  { key: 'testtafel', label: 'TestTafel' },
];

// ── Data loading ────────────────────────────────────────────────────────────

export async function loadFinanceData() {
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
  } catch (e: unknown) {
    console.error('Failed to load finance data:', e);
    S.financeData = [];
  }

  // Also load product data
  await loadFinanceProducts();
}

export async function loadFinanceProducts() {
  const monday = getFinanceMonday(S.financeWeekOffset);
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);

  let url = `/api/finance/products?start=${fmtDate(monday)}&end=${fmtDate(sunday)}`;
  if (S.financeProductLoc !== 'all') url += `&location=${S.financeProductLoc}`;
  if (S.financeProductMeal !== 'all') url += `&meal=${S.financeProductMeal}`;

  try {
    S.financeProducts = await apiGet(url);
  } catch (e: unknown) {
    console.error('Failed to load product data:', e);
    S.financeProducts = [];
  }
}

export async function checkSyncStatus() {
  try {
    const status = await apiGet('/api/finance/sync-status');
    S.financeSyncing = status.syncing;
    return status;
  } catch (e: unknown) {
    return { syncing: false };
  }
}

export async function triggerSync() {
  trackEvent('finance_sync');
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
          toastError(status.lastSyncError);
        } else {
          toast('Revenue synced from Tebi');
        }
      }
    }, 3000);

  } catch (e: unknown) {
    S.financeSyncing = false;
    toastError('Sync failed: ' + (e instanceof Error ? e.message : 'Unknown error'));
    renderFinance();
  }
}

// ── Render ───────────────────────────────────────────────────────────────────

export async function renderFinance() {
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
  const cancelBtn = S.financeSyncing
    ? '<button class="fin-cancel-btn" onclick="cancelSync()">Cancel</button>'
    : '';

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
      ${cancelBtn}
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
        ${weekDates.map((d: any, i: any) => {
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
            ${weekDates.map((d: any, i: any) => `<th>${DAYS[i]}<br><small>${fmtDateShort(d)}</small></th>`).join('')}
            <th>Week</th>
          </tr>
        </thead>
        <tbody>
          ${locations.map(loc => {
            const cells = weekDates.map(d => {
              const row = byDateLoc[`${d}|${loc}`];
              return row && row.grossRevenue ? fmtEuro(row.grossRevenue) : '-';
            });
            const weekTotal = weekDates.reduce((sum: any, d: any) => {
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
            <td class="fin-week-total"><strong>${fmtEuro(weekGrossValues.reduce((a: any, b: any) => a + b, 0))}</strong></td>
          </tr>
        </tbody>
      </table>
    </div>

    ${S.financeData.length === 0 && !S.financeSyncing ? `
      <div class="fin-empty">
        No revenue data yet. Click <strong>Sync from Tebi</strong> to pull data.
      </div>
    ` : ''}

    ${renderProductBreakdown()}
  `;
}

// ── Product Breakdown ────────────────────────────────────────────────────────

export function renderProductBreakdown() {
  const products = S.financeProducts || [];

  // Aggregate by category for the bar chart
  const catMap = {};
  let totalGross = 0;
  for (const row of products) {
    const cat = row.productCategory || 'Other';
    if (!catMap[cat]) catMap[cat] = { category: cat, gross: 0, net: 0, qty: 0 };
    catMap[cat].gross += row.grossRevenue || 0;
    catMap[cat].net += row.netRevenue || 0;
    catMap[cat].qty += row.quantity || 0;
    totalGross += row.grossRevenue || 0;
  }
  const categories = Object.values(catMap).sort((a: any, b: any) => b.gross - a.gross);
  const maxCatGross = categories.length > 0 ? categories[0].gross : 1;

  // Aggregate by product for the table (merge across dates)
  const prodMap = {};
  for (const row of products) {
    const key = row.productName;
    if (!prodMap[key]) {
      prodMap[key] = { name: row.productName, category: row.productCategory || '', gross: 0, net: 0, qty: 0 };
    }
    prodMap[key].gross += row.grossRevenue || 0;
    prodMap[key].net += row.netRevenue || 0;
    prodMap[key].qty += row.quantity || 0;
  }
  const productList = Object.values(prodMap).sort((a: any, b: any) => b.gross - a.gross);

  // Category bar colors (cycle through a palette)
  const catColors = ['#5b6abf', '#4CAF50', '#FF9800', '#E91E63', '#00BCD4', '#9C27B0', '#FF5722', '#607D8B', '#795548', '#8BC34A'];

  return `
    <div class="fin-products-section">
      <h3>Product breakdown</h3>

      <div class="fin-product-filters">
        <div class="fin-filter-group">
          <label>Service</label>
          <div class="fin-pill-group">
            ${SERVICE_PERIODS.map(p =>
              `<button class="fin-pill ${S.financeProductMeal === p.key ? 'active' : ''}"
                       onclick="setFinanceProductFilter('meal','${p.key}')">${p.label}</button>`
            ).join('')}
          </div>
        </div>
        <div class="fin-filter-group">
          <label>Location</label>
          <div class="fin-pill-group">
            ${FINANCE_LOCATIONS.map(l =>
              `<button class="fin-pill ${S.financeProductLoc === l.key ? 'active' : ''}"
                       onclick="setFinanceProductFilter('loc','${l.key}')">${l.label}</button>`
            ).join('')}
          </div>
        </div>
      </div>

      ${products.length === 0 ? `
        <div class="fin-empty" style="padding:1.5rem">No product data for this period. Sync from Tebi to pull invoice details.</div>
      ` : `
        <div class="fin-cat-chart">
          ${categories.map((c: any, i: any) => {
            const pct = Math.round((c.gross / maxCatGross) * 100);
            const color = catColors[i % catColors.length];
            const pctOfTotal = totalGross > 0 ? Math.round((c.gross / totalGross) * 100) : 0;
            return `
              <div class="fin-cat-row">
                <div class="fin-cat-label">${esc(c.category)}</div>
                <div class="fin-cat-bar-track">
                  <div class="fin-cat-bar" style="width:${pct}%;background:${color}"></div>
                </div>
                <div class="fin-cat-value">${fmtEuro(c.gross)} <span class="fin-cat-pct">${pctOfTotal}%</span></div>
              </div>`;
          }).join('')}
        </div>

        <div class="fin-product-table-wrap">
          <table class="fin-table fin-product-table">
            <thead>
              <tr>
                <th style="text-align:left">Product</th>
                <th style="text-align:left">Category</th>
                <th>Qty</th>
                <th>Gross</th>
                <th>%</th>
              </tr>
            </thead>
            <tbody>
              ${productList.slice(0, 50).map(p => {
                const pctOfTotal = totalGross > 0 ? ((p.gross / totalGross) * 100).toFixed(1) : '0';
                return `
                  <tr>
                    <td style="text-align:left">${esc(p.name)}</td>
                    <td style="text-align:left;color:#888">${esc(p.category)}</td>
                    <td>${Math.round(p.qty)}</td>
                    <td>${fmtEuro(p.gross)}</td>
                    <td>${pctOfTotal}%</td>
                  </tr>`;
              }).join('')}
            </tbody>
            ${productList.length > 0 ? `
              <tfoot>
                <tr class="fin-total-row">
                  <td style="text-align:left"><strong>Total</strong></td>
                  <td></td>
                  <td><strong>${Math.round(productList.reduce((s: any, p: any) => s + p.qty, 0))}</strong></td>
                  <td><strong>${fmtEuro(totalGross)}</strong></td>
                  <td><strong>100%</strong></td>
                </tr>
              </tfoot>
            ` : ''}
          </table>
        </div>
        ${productList.length > 50 ? `<div style="text-align:center;color:#888;padding:0.5rem">Showing top 50 of ${productList.length} products</div>` : ''}
      `}
    </div>
  `;
}

export async function setFinanceProductFilter(type: any, value: any) {
  if (type === 'meal') S.financeProductMeal = value;
  if (type === 'loc') S.financeProductLoc = value;
  await loadFinanceProducts();
  renderFinance();
}

export async function cancelSync() {
  try {
    await apiPost('/api/finance/sync-cancel', {});
    S.financeSyncing = false;
    renderFinance();
    toast('Sync cancelled');
  } catch (e: unknown) {
    toastError('Cancel failed: ' + (e instanceof Error ? e.message : 'Unknown error'));
  }
}

export function changeFinanceWeek(delta: any) {
  S.financeWeekOffset += delta;
  loadFinanceData().then(() => renderFinance());
}
