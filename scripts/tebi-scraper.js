#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Tebi Scraper — pulls revenue & sales data from Tebi POS via browser automation
//
// Usage:
//   node scripts/tebi-scraper.js                  # fetch yesterday's data
//   node scripts/tebi-scraper.js 2026-03-20       # fetch specific date
//   node scripts/tebi-scraper.js 2026-03-01 2026-03-25  # fetch date range
//
// Env vars required:
//   TEBI_EMAIL      — Tebi login email
//   TEBI_PASSWORD   — Tebi login password
//
// Optional:
//   TEBI_LEDGER_ID  — defaults to 723192
//   TEBI_HEADLESS   — "false" to see the browser (default: true)
// ─────────────────────────────────────────────────────────────────────────────

const { chromium } = require('playwright');

// ── Config ──────────────────────────────────────────────────────────────────

const TEBI_BASE = 'https://live.tebi.co';
const LEDGER_ID = process.env.TEBI_LEDGER_ID || '723192';
const HEADLESS = process.env.TEBI_HEADLESS !== 'false';

// Profit center UUIDs (discovered from Tebi backoffice network requests)
const PROFIT_CENTERS = {
  all:      '00000000-0000-0000-0000-000000000000',
  west:     null, // will be discovered during first run
  centraal: null,
  testtafel: null,
};

// Chart endpoints available on the Tebi insights API
const CHART_TYPES = [
  'revenue_overview_chart',
  'orders_chart',
  'number_of_sales_chart',
  'covers_count_chart',
  'average_sale_amount_chart',
  'average_spend_per_cover_chart',
];

// ── Helpers ─────────────────────────────────────────────────────────────────

function yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function nextDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d + 1);
  const yy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function log(msg) {
  console.log(`[tebi] ${msg}`);
}

function err(msg) {
  console.error(`[tebi] ERROR: ${msg}`);
}

// ── Login ───────────────────────────────────────────────────────────────────

async function login(page) {
  const email = process.env.TEBI_EMAIL;
  const password = process.env.TEBI_PASSWORD;

  if (!email || !password) {
    throw new Error('TEBI_EMAIL and TEBI_PASSWORD env vars are required');
  }

  log('Navigating to Tebi login...');
  await page.goto(`${TEBI_BASE}/backoffice/login`, { waitUntil: 'networkidle' });

  // Check if already logged in (redirected to dashboard or shows user name)
  if (page.url().includes('/dashboard') || page.url().includes('/ledgers/')) {
    log('Already logged in (session still valid)');
    return true;
  }

  // Wait for the login form to appear (Vue SPA, may take a moment)
  log('Waiting for login form...');

  // Tebi uses custom Vue input components — use label-based selectors
  const emailInput = await page.getByLabel('Email address').waitFor({ timeout: 10000 }).then(() => page.getByLabel('Email address')).catch(() => null);

  if (!emailInput) {
    const content = await page.textContent('body');
    if (content.includes('Sign out') || content.includes('Dashboard')) {
      log('Already logged in');
      return true;
    }
    throw new Error('Could not find login form. Page content: ' + content.substring(0, 200));
  }

  log('Filling login credentials...');
  await emailInput.fill(email);

  // Fill password using role selector (label matches both input and show/hide toggle)
  await page.getByRole('textbox', { name: 'Password' }).fill(password);

  // Click "Sign in" button
  await page.getByRole('button', { name: 'Sign in' }).click();

  // Wait for login to complete — either redirects away from /login or shows an error
  log('Submitting login...');
  await page.waitForTimeout(3000); // Give the SPA time to process

  // Check for error messages first
  const errorMsg = await page.textContent('[class*="error"], [role="alert"]').catch(() => '');
  if (errorMsg && errorMsg.includes('Wrong')) {
    throw new Error(`Login failed: ${errorMsg.trim()}`);
  }

  // Check if we're past the login page
  const currentUrl = page.url();
  const bodyText = await page.textContent('body').catch(() => '');
  if (currentUrl.includes('/login') && !bodyText.includes('Daan') && !bodyText.includes('Sign out')) {
    throw new Error('Login did not succeed. URL: ' + currentUrl);
  }

  log('Login successful!');
  return true;
}

// ── API Fetcher ─────────────────────────────────────────────────────────────

async function fetchTebiAPI(page, endpoint) {
  const url = `${TEBI_BASE}${endpoint}`;

  // The Tebi SPA uses an auth token stored in memory (not cookies/localStorage).
  // We intercept an actual API request to grab the Authorization header,
  // then reuse it for our own requests.
  if (!fetchTebiAPI._authHeader) {
    // Intercept a real request the app makes to grab the auth header
    log('  Capturing auth token from app...');
    const [request] = await Promise.all([
      page.waitForRequest(req => req.url().includes('/api/') && req.url().includes('ledgers'), { timeout: 15000 }),
      page.reload({ waitUntil: 'networkidle' }),
    ]);
    const headers = request.headers();
    if (headers['authorization']) {
      fetchTebiAPI._authHeader = headers['authorization'];
      log('  Auth token captured!');
    } else {
      // Fallback: try cookie header
      fetchTebiAPI._cookie = headers['cookie'] || '';
      log('  Using cookie auth');
    }
  }

  // Make the request using the captured auth
  const fetchHeaders = {};
  if (fetchTebiAPI._authHeader) {
    fetchHeaders['authorization'] = fetchTebiAPI._authHeader;
  }
  if (fetchTebiAPI._cookie) {
    fetchHeaders['cookie'] = fetchTebiAPI._cookie;
  }

  const result = await page.evaluate(async ({ fetchUrl, headers }) => {
    try {
      const resp = await fetch(fetchUrl, { headers });
      if (!resp.ok) {
        return { error: true, status: resp.status, text: await resp.text() };
      }
      return { error: false, data: await resp.json() };
    } catch (e) {
      return { error: true, status: 0, text: e.message };
    }
  }, { fetchUrl: url, headers: fetchHeaders });

  if (result.error) {
    throw new Error(`API ${result.status}: ${result.text}`);
  }

  return result.data;
}
fetchTebiAPI._authHeader = null;
fetchTebiAPI._cookie = null;

// ── Discover Profit Centers ─────────────────────────────────────────────────

// Discover profit centers for the given ledger, populating the provided profitCenters object.
// Does NOT fall back to hardcoded UUIDs.
async function discoverProfitCenters(page, ledgerId, profitCenters) {
  log('Discovering profit centers...');

  await page.goto(`${TEBI_BASE}/backoffice/ledgers/${ledgerId}/dashboard?start=2026-03-26&end=2026-03-26`, {
    waitUntil: 'networkidle'
  });

  const dashboardMain = await fetchTebiAPI(page,
    `/api/insights/ledgers/${ledgerId}/insights/dashboards/main`
  );

  const profitCenterCharts = [];
  if (dashboardMain && Array.isArray(dashboardMain.groups)) {
    for (const group of dashboardMain.groups) {
      if (Array.isArray(group.charts)) {
        for (const chart of group.charts) {
          if (chart.chartType && chart.chartType.startsWith('revenue_profit_center_')) {
            const uuid = chart.chartType.replace('revenue_profit_center_', '');
            if (uuid !== profitCenters.all) {
              profitCenterCharts.push({ uuid, label: chart.label || chart.title || 'unknown' });
            }
          }
        }
      }
    }
  }

  for (const pc of profitCenterCharts) {
    const label = (pc.label || '').toLowerCase();
    if (label.includes('west')) {
      profitCenters.west = pc.uuid;
      log(`  Sering West = ${pc.uuid}`);
    } else if (label.includes('centraal')) {
      profitCenters.centraal = pc.uuid;
      log(`  Sering Centraal = ${pc.uuid}`);
    } else if (label.includes('test')) {
      profitCenters.testtafel = pc.uuid;
      log(`  TestTafel = ${pc.uuid}`);
    } else {
      log(`  Unknown profit center: "${pc.label}" = ${pc.uuid}`);
    }
  }

  return profitCenters;
}

// ── Fetch Revenue Data ──────────────────────────────────────────────────────

async function fetchDayData(page, ledgerId, profitCenters, startDate, endDate) {
  log(`Fetching data for ${startDate} → ${endDate}...`);

  const results = {};

  for (const chartType of CHART_TYPES) {
    try {
      const data = await fetchTebiAPI(page,
        `/api/insights/ledgers/${ledgerId}/insights/data/charts/${chartType}?startDate=${startDate}&endDate=${endDate}&mock=false&limit=-1`
      );
      results[chartType] = data;
      log(`  ✓ ${chartType}`);
    } catch (e) {
      err(`  ✗ ${chartType}: ${e.message}`);
    }
  }

  for (const [name, uuid] of Object.entries(profitCenters)) {
    if (!uuid) continue;
    try {
      const data = await fetchTebiAPI(page,
        `/api/insights/ledgers/${ledgerId}/insights/data/charts/revenue_profit_center_${uuid}?startDate=${startDate}&endDate=${endDate}&mock=false&limit=-1`
      );
      results[`revenue_${name}`] = data;
      log(`  ✓ revenue_${name}`);
    } catch (e) {
      err(`  ✗ revenue_${name}: ${e.message}`);
    }
  }

  try {
    const invoices = await fetchTebiAPI(page,
      `/api/invoicing/ledgers/${ledgerId}/sales/invoices?page=0&pageSize=500&startDate=${startDate}&endDate=${endDate}`
    );
    results.invoices = invoices;
    log(`  ✓ invoices (${Array.isArray(invoices?.content) ? invoices.content.length : '?'} records)`);
  } catch (e) {
    err(`  ✗ invoices: ${e.message}`);
  }

  return results;
}

// ── Service Period Classification ────────────────────────────────────────────

// Classify a timestamp into a service period
// morning: 06:00–12:00, lunch: 12:00–14:00, afternoon: 14:00–18:00,
// dinner: 18:00–21:00, bar: 21:00–06:00 (next day)
function classifyServicePeriod(timestamp) {
  if (!timestamp) return 'other';
  const d = new Date(timestamp);
  const hour = d.getHours();
  const minute = d.getMinutes();
  const time = hour * 60 + minute; // minutes since midnight

  if (time >= 6 * 60 && time < 12 * 60) return 'morning';
  if (time >= 12 * 60 && time < 14 * 60) return 'lunch';
  if (time >= 14 * 60 && time < 18 * 60) return 'afternoon';
  if (time >= 18 * 60 && time < 21 * 60) return 'dinner';
  return 'bar'; // 21:00–06:00
}

// ── Invoice Line-Item Parsing ────────────────────────────────────────────────

// Extract product-level revenue from invoice data.
// options.forceLocation: assign ALL invoices to this location (useful for accounts with one location)
function formatProductRevenue(invoices, profitCenters, options = {}) {
  if (!invoices || !Array.isArray(invoices.content)) return [];

  const { forceLocation } = options;

  // Build reverse map: profit center UUID → location name
  const pcToLoc = {};
  for (const [name, uuid] of Object.entries(profitCenters)) {
    if (uuid && name !== 'all') pcToLoc[uuid] = name;
  }

  // Aggregate: key = date|location|meal|productName|productCategory
  const agg = {};

  for (const invoice of invoices.content) {
    const timestamp = invoice.createdAt || invoice.date || invoice.closedAt || '';

    // Determine location: forced > profit center lookup > 'unknown'
    let location;
    if (forceLocation) {
      location = forceLocation;
    } else {
      const pcUuid = invoice.profitCenterId || invoice.profitCenter?.id || '';
      location = pcToLoc[pcUuid] || 'unknown';
    }

    const meal = classifyServicePeriod(timestamp);

    // Extract the date portion (YYYY-MM-DD)
    const invoiceDate = timestamp ? timestamp.slice(0, 10) : '';

    // Parse line items (Tebi calls them "items" or "lines")
    const items = invoice.items || invoice.lines || invoice.lineItems || [];
    for (const item of items) {
      const productName = item.productName || item.name || item.description || 'Unknown';
      const productCategory = item.productGroup || item.category || item.groupName || item.productGroupName || '';
      const quantity = parseFloat(item.quantity || item.count || 1) || 1;

      // Revenue: try various field names Tebi might use
      const grossAmount = parseFloat(
        item.totalGross || item.grossAmount || item.totalAmount ||
        item.total || item.amount || item.price || 0
      ) || 0;
      const netAmount = parseFloat(
        item.totalNet || item.netAmount || item.totalExclVat ||
        item.totalExcludingVat || 0
      ) || 0;

      const key = `${invoiceDate}|${location}|${meal}|${productName}|${productCategory}`;
      if (!agg[key]) {
        agg[key] = {
          date: invoiceDate,
          location,
          meal,
          productName,
          productCategory,
          quantity: 0,
          grossRevenue: 0,
          netRevenue: 0,
        };
      }
      agg[key].quantity += quantity;
      agg[key].grossRevenue += grossAmount;
      agg[key].netRevenue += netAmount;
    }

    // If invoice has no line items, record the invoice total as a single "Other" product
    if (items.length === 0) {
      const invoiceGross = parseFloat(invoice.totalGross || invoice.total || invoice.amount || 0) || 0;
      const invoiceNet = parseFloat(invoice.totalNet || invoice.totalExclVat || 0) || 0;
      if (invoiceGross > 0) {
        const key = `${invoiceDate}|${location}|${meal}|Invoice Total|Other`;
        if (!agg[key]) {
          agg[key] = {
            date: invoiceDate, location, meal,
            productName: 'Invoice Total', productCategory: 'Other',
            quantity: 0, grossRevenue: 0, netRevenue: 0,
          };
        }
        agg[key].quantity += 1;
        agg[key].grossRevenue += invoiceGross;
        agg[key].netRevenue += invoiceNet;
      }
    }
  }

  // Round all amounts
  return Object.values(agg).map(row => ({
    ...row,
    grossRevenue: Math.round(row.grossRevenue * 100) / 100,
    netRevenue: Math.round(row.netRevenue * 100) / 100,
    quantity: Math.round(row.quantity * 100) / 100,
  }));
}

// ── Format Output ───────────────────────────────────────────────────────────

// Sum a metric from chart data (hourly buckets → daily total)
function sumMetric(chartData, metricName) {
  if (!chartData || !Array.isArray(chartData.data)) return null;
  let total = 0;
  for (const bucket of chartData.data) {
    if (!Array.isArray(bucket.metrics)) continue;
    for (const metric of bucket.metrics) {
      if (metric.name === metricName && metric.value) {
        const qty = metric.value.quantity || metric.value;
        total += parseFloat(qty) || 0;
      }
    }
  }
  return Math.round(total * 100) / 100;
}

function formatResults(results, startDate, profitCenters) {
  const summary = { date: startDate, locations: {} };

  for (const [name, uuid] of Object.entries(profitCenters)) {
    if (!uuid) continue;
    const revenueData = results[`revenue_${name}`];
    if (revenueData) {
      summary.locations[name] = {
        grossRevenue: sumMetric(revenueData, 'GROSS_REVENUE'),
        netRevenue: sumMetric(revenueData, 'NET_REVENUE'),
      };
    }
  }

  // Extract overview metrics
  summary.grossRevenue = sumMetric(results.revenue_overview_chart, 'GROSS_REVENUE');
  summary.netRevenue = sumMetric(results.revenue_overview_chart, 'NET_REVENUE');
  summary.orders = sumMetric(results.orders_chart, 'ORDERS');
  summary.sales = sumMetric(results.number_of_sales_chart, 'NUMBER_OF_SALES');
  summary.covers = sumMetric(results.covers_count_chart, 'COVERS_COUNT');
  summary.avgSale = sumMetric(results.average_sale_amount_chart, 'AVERAGE_SALE_AMOUNT');
  summary.avgPerCover = sumMetric(results.average_spend_per_cover_chart, 'AVERAGE_SPEND_PER_COVER');

  // Invoice count
  if (results.invoices && results.invoices.pagination) {
    summary.invoiceCount = results.invoices.pagination.totalResults;
  }

  return summary;
}

// ── Multi-account entry point ────────────────────────────────────────────────

// Run a full scrape for one account. Isolated: resets auth cache, uses local
// profitCenters object so two accounts never share state.
// config: { email, password, ledgerId, forceLocation? }
// Returns { summary, productRows } or throws on hard failure.
async function runForAccount(config, page, startDate, endDate) {
  const { email, password, ledgerId, forceLocation } = config;

  // Reset auth cache so Account 2 doesn't reuse Account 1's token
  fetchTebiAPI._authHeader = null;
  fetchTebiAPI._cookie = null;

  // Local profit centers — never leaks between account runs
  const profitCenters = { all: '00000000-0000-0000-0000-000000000000', west: null, centraal: null, testtafel: null };

  // Override env vars for the login call (login() reads from process.env)
  const origEmail = process.env.TEBI_EMAIL;
  const origPass  = process.env.TEBI_PASSWORD;
  process.env.TEBI_EMAIL    = email;
  process.env.TEBI_PASSWORD = password;

  try {
    await login(page);

    await page.goto(`${TEBI_BASE}/backoffice/ledgers/${ledgerId}/dashboard`, {
      waitUntil: 'networkidle', timeout: 30000,
    });
    await page.waitForTimeout(3000);

    await discoverProfitCenters(page, ledgerId, profitCenters);

    const rawData = await fetchDayData(page, ledgerId, profitCenters, startDate, endDate);
    const summary = formatResults(rawData, startDate, profitCenters);
    const productRows = formatProductRevenue(rawData.invoices, profitCenters, { forceLocation });

    return { summary, productRows };
  } finally {
    process.env.TEBI_EMAIL    = origEmail;
    process.env.TEBI_PASSWORD = origPass;
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const flags = process.argv.slice(2).filter(a => a.startsWith('--'));
  const startDate = args[0] || yesterday();
  const endDate = args[1] ? nextDay(args[1]) : nextDay(startDate);
  const showRaw = flags.includes('--raw');
  const dumpInvoices = flags.includes('--dump-invoices');

  log(`Tebi Scraper — fetching ${startDate} to ${endDate}`);
  log(`Ledger: ${LEDGER_ID}, Headless: ${HEADLESS}`);

  const browser = await chromium.launch({
    headless: HEADLESS,
    executablePath: chromium.executablePath(),
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // Step 1: Login
    await login(page);

    // Step 2: Navigate to backoffice dashboard to establish ledger context + cookies
    log('Navigating to dashboard...');
    await page.goto(`${TEBI_BASE}/backoffice/ledgers/${LEDGER_ID}/dashboard`, {
      waitUntil: 'networkidle',
      timeout: 30000,
    });
    // Wait for the dashboard to actually render (Vue SPA)
    await page.waitForTimeout(3000);
    log('Dashboard loaded: ' + page.url());

    // Step 3: Discover profit centers
    await discoverProfitCenters(page, LEDGER_ID, PROFIT_CENTERS);

    // Step 4: Fetch data
    const rawData = await fetchDayData(page, LEDGER_ID, PROFIT_CENTERS, startDate, endDate);

    // Step 5: Format and output
    const summary = formatResults(rawData, startDate, PROFIT_CENTERS);

    console.log('\n' + '='.repeat(60));
    console.log('TEBI DATA SUMMARY');
    console.log('='.repeat(60));
    console.log(JSON.stringify(summary, null, 2));
    console.log('='.repeat(60));

    // Dump invoice structure for discovery
    if (dumpInvoices && rawData.invoices && Array.isArray(rawData.invoices.content)) {
      console.log('\n' + '='.repeat(60));
      console.log('INVOICE STRUCTURE (first 3 invoices)');
      console.log('='.repeat(60));
      const sample = rawData.invoices.content.slice(0, 3);
      console.log(JSON.stringify(sample, null, 2));
      console.log('='.repeat(60));
      console.log(`Total invoices: ${rawData.invoices.content.length}`);
      if (sample[0]) {
        console.log('Invoice keys:', Object.keys(sample[0]).join(', '));
        const items = sample[0].items || sample[0].lines || sample[0].lineItems || [];
        if (items.length > 0) {
          console.log('Line item keys:', Object.keys(items[0]).join(', '));
        }
      }
    }

    const forceLocation = process.env.TEBI_FORCE_LOCATION || null;
    const productRevenue = formatProductRevenue(rawData.invoices, PROFIT_CENTERS, { forceLocation });
    summary.productRevenue = productRevenue;

    // Also output raw data for debugging
    if (showRaw) {
      console.log('\nRAW DATA:');
      console.log(JSON.stringify(rawData, null, 2));
    }

    return { summary, rawData };

  } catch (e) {
    err(e.message);
    // Take a screenshot for debugging
    await page.screenshot({ path: 'tebi-error.png' }).catch(() => {});
    log('Screenshot saved to tebi-error.png');
    process.exit(1);

  } finally {
    await browser.close();
  }
}

// Run if called directly
if (require.main === module) {
  main().catch(e => {
    err(e.message);
    process.exit(1);
  });
}

module.exports = { main, runForAccount, login, fetchTebiAPI, fetchDayData, formatResults, formatProductRevenue, classifyServicePeriod, sumMetric, PROFIT_CENTERS, CHART_TYPES };
