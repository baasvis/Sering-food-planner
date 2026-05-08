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

// Load .env when run standalone (e.g. `npx tsx scripts/tebi-scraper.js ...`).
// In production the worker (tebi-sync-worker.js) already calls dotenv.config()
// before requiring this module, so this is a no-op there. Locally it lets the
// scraper find TEBI_EMAIL / TEBI_PASSWORD without the user having to source
// the .env file by hand.
require('dotenv').config();

const { chromium } = require('playwright');

// ── Config ──────────────────────────────────────────────────────────────────

const TEBI_BASE = 'https://live.tebi.co';
const LEDGER_ID = process.env.TEBI_LEDGER_ID || '723192';
const HEADLESS = process.env.TEBI_HEADLESS !== 'false';

// Profit center UUIDs (discovered from Tebi backoffice dashboard JSON).
// As of 2026-05-07 there is no aggregate "all" profit center any more — the
// 00000000-...-0 UUID that used to be the aggregate is now Sering West, and
// the overall total is exposed via the unfiltered `revenue_overview_chart`
// instead.
const PROFIT_CENTERS = {
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
    const content = await page.textContent('body').catch(() => '') || '';
    // Around 2026-03-26 Tebi added a "Select location" intermediate page
    // between login and the ledger dashboard. When the session is still
    // valid, opening /backoffice/login lands on this picker instead of
    // showing the email/password form. Treat its body markers as
    // already-logged-in; the caller navigates to the ledger URL next,
    // which bypasses the picker.
    //
    // 2026-05-07: Tebi reworked the post-login UI again — the "Select
    // location" string no longer appears verbatim. Recognise the navbar
    // items ("Refer a friend", "Help & Support") that ONLY render once
    // logged in.
    if (
      content.includes('Sign out') ||
      content.includes('Dashboard') ||
      content.includes('Select location') ||
      content.includes('Refer a friend') ||
      content.includes('Help & Support')
    ) {
      log('Already logged in (post-login navbar marker detected)');
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

  // Check if we're past the login page. Vue SPA may keep the /login URL
  // briefly even after a successful submit, and Tebi's new flow lands on
  // a "Select location" page after login (URL may still read /login).
  // Trust body markers as well as the URL.
  //
  // 2026-05-07: Tebi reworked the post-login UI — "Select location" no
  // longer appears verbatim. Recognise navbar items ("Refer a friend",
  // "Help & Support") that ONLY render once logged in.
  const currentUrl = page.url();
  const bodyText = (await page.textContent('body').catch(() => '')) || '';
  const passedLogin =
    !currentUrl.includes('/login')
    || bodyText.includes('Sign out')
    || bodyText.includes('Dashboard')
    || bodyText.includes('Select location')
    || bodyText.includes('Refer a friend')
    || bodyText.includes('Help & Support');
  if (!passedLogin) {
    throw new Error('Login did not succeed. URL: ' + currentUrl + '. Body excerpt: ' + bodyText.slice(0, 200));
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

  // Log dashboard top-level shape so a Tebi response-shape change is visible
  // in the next cron's stdoutTail. Without this, a renamed `groups` key (or
  // a renamed chartType prefix) silently produces 0 profit centers and we'd
  // have no idea why per-location rows stopped reaching the DB.
  //
  // 2026-05-07: Tebi renamed the top-level `groups` field to `chartGroups`.
  // Reading either key keeps the scraper working through any future
  // partial revert and through old test fixtures.
  const dashboardKeys = dashboardMain && typeof dashboardMain === 'object'
    ? Object.keys(dashboardMain).join(',')
    : '(non-object)';
  const groups = dashboardMain && (Array.isArray(dashboardMain.chartGroups)
    ? dashboardMain.chartGroups
    : Array.isArray(dashboardMain.groups) ? dashboardMain.groups : null);
  const groupsCount = Array.isArray(groups) ? groups.length : -1;
  log(`  dashboard shape: keys=[${dashboardKeys}] chartGroups=${groupsCount}`);

  // Recursive walk for charts. Tebi moved the chart IDENTIFIER from
  // `chartType` to `id`, and `chartType` now means visualisation type
  // (BAR / LINE / LAYERED_BAR) and lives on every metric, not just charts.
  // Match by `id` starting with `revenue_profit_center_` instead.
  // Walking generically (rather than assuming a fixed nested path) keeps
  // discovery alive through any further shape drift inside chartGroups.
  const profitCenterCharts = [];
  const allChartIds = [];
  function walkForCharts(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const el of node) walkForCharts(el); return; }
    if (typeof node.id === 'string') {
      allChartIds.push(node.id);
      if (node.id.startsWith('revenue_profit_center_')) {
        const uuid = node.id.replace('revenue_profit_center_', '');
        profitCenterCharts.push({ uuid, label: node.name || node.label || node.title || 'unknown' });
      }
    }
    for (const v of Object.values(node)) {
      if (v && typeof v === 'object') walkForCharts(v);
    }
  }
  walkForCharts(dashboardMain);

  if (profitCenterCharts.length === 0) {
    log(`  ⚠ no revenue_profit_center_* charts found. ${allChartIds.length} ids found at any depth: ${allChartIds.slice(0, 20).join(', ')}${allChartIds.length > 20 ? ' …' : ''}`);
    // Dump (capped) JSON so we can see exactly what shape Tebi returns and
    // wire the walk to it. Cap is generous — dashboardMain is typically
    // under 30 KB, so the full structure usually fits.
    try {
      const dump = JSON.stringify(dashboardMain, null, 2);
      const capped = dump.length > 20000 ? dump.slice(0, 20000) + '\n... [truncated, total length ' + dump.length + ' chars]' : dump;
      log(`  --- dashboardMain JSON (for diagnostic) ---`);
      log(capped);
      log(`  --- end dashboardMain JSON ---`);
    } catch (_e) { /* ignore */ }
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

  // Final summary so absence is loud. With the original code, "couldn't find
  // Centraal" was inferred only by the absence of a `Sering Centraal = ...`
  // line, which is easy to miss in a long log.
  log(`  PC summary: west=${profitCenters.west ? 'yes' : 'NO'} centraal=${profitCenters.centraal ? 'yes' : 'NO'} testtafel=${profitCenters.testtafel ? 'yes' : 'NO'}`);

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

  // Per-PC product breakdown via the `product_top` chart with a JSON-encoded
  // PROFIT_CENTER filter. This replaces the old invoice-line-items path,
  // which broke around 2026-05-07 when Tebi stopped including line items in
  // the invoice list response. `product_top` returns per-item gross revenue
  // and total quantity for the date range, scoped to the filtered PC.
  // (Tebi can't be asked to also group by TIME_DAY, so we still fetch
  // per-day from the caller — this function fetches the whole range here.)
  results.productTopByPc = {};
  for (const [name, uuid] of Object.entries(profitCenters)) {
    if (!uuid) continue;
    try {
      const filter = encodeURIComponent(JSON.stringify({ grouping: 'PROFIT_CENTER', value: uuid }));
      const data = await fetchTebiAPI(page,
        `/api/insights/ledgers/${ledgerId}/insights/data/charts/product_top?startDate=${startDate}&endDate=${endDate}&mock=false&limit=-1&filter=${filter}`
      );
      results.productTopByPc[name] = data;
      const rowCount = Array.isArray(data && data.data) ? data.data.length : 0;
      log(`  ✓ product_top.${name} (${rowCount} items)`);
    } catch (e) {
      err(`  ✗ product_top.${name}: ${e.message}`);
    }
  }

  // Invoice list — still fetched for invoiceCount in DailyRevenue, but line
  // items are no longer present so we don't try to derive products from it
  // any more.
  try {
    const invoices = await fetchTebiAPI(page,
      `/api/invoicing/ledgers/${ledgerId}/sales/invoices?page=0&pageSize=500&startDate=${startDate}&endDate=${endDate}`
    );
    results.invoices = invoices;
    const invArr = Array.isArray(invoices?.data) ? invoices.data : Array.isArray(invoices?.content) ? invoices.content : null;
    log(`  ✓ invoices (${invArr ? invArr.length : '?'} records)`);
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

// ── Meal-product allowlist ──────────────────────────────────────────────────
//
// These exact item names represent guests served and feed the auto-update
// of `GuestHistory`. Items outside this list (drinks, snacks, "Lunch card"
// BULK PURCHASES — note "Lunch card" itself is a card-purchase event, not a
// guest, while "Lunch card guest" IS a guest) are still recorded in
// ProductRevenue but never count toward guests.
//
// Two product-name dialects exist as of 2026-05-08:
//   - West (Account #1, info@testtafel.nl, ledger 723192)
//     Item names without prefix: Lunch / Dinner donation / Stadspas Dinner /
//     Staff & volunteer meals.
//   - TestTafel + Centraal (Account #2, facturen@testtafel.nl, ledger 724466)
//     Item names with `DSC ` prefix (= "De Sering Community"): DSC Lunch /
//     DSC Dinner / DSC Stadspas Dinner / DSC staff & volunteer meals. Plus
//     TestTafel-only paid menus: "Single TestTafel Menu (3 course / 5 course)".
//
// Note on TestTafel courses (Bread (bundle), Amuse (Bundle), Course 1..3,
// Dessert 1..2): these are sub-components of the multi-course menu, NOT
// separate guest events. Don't add them — they'd double-count.
//
// If a future product rename shows up, add it here. The diagnostic scripts
// (diagnose-tebi-coverage, tebi-derive-guests) print "unmatched products"
// so you can spot what's escaping the allowlist.
const MEAL_ITEM_TYPE = {
  // Account #1 — West (info@testtafel.nl, ledger 723192)
  'Lunch':                          'lunch',
  'Lunch card guest':               'lunch',
  'Dinner donation':                'dinner',
  'Stadspas Dinner':                'dinner',
  'DSC Dinner':                     'dinner',
  'Staff & volunteer meals':        'staff',
  // Account #2 — TestTafel + Centraal (facturen@testtafel.nl, ledger 724466)
  'DSC Lunch':                      'lunch',
  'DSC Stadspas Dinner':            'dinner',
  'DSC staff & volunteer meals':    'staff',
  'Single TestTafel Menu (5 course)': 'dinner',
  'Single TestTafel Menu (3 course)': 'dinner',
};

// Round helper (2 dp)
function r2(n) { return Math.round((n || 0) * 100) / 100; }

// Approximate net from gross. Dutch low VAT rate (9%) covers most food &
// non-alcoholic. Drinks at Sering (alcohol) are 21% but we don't have item
// category here — set to a single rate and let the finance UI show this is
// an approximation. DailyRevenue.net comes from the overview chart's real
// NET_REVENUE metric so that's accurate; only ProductRevenue.net is the
// approximation.
function netFromGross(gross) { return r2(gross / 1.09); }

// ── Misattribution rule: TestTafel-PC community-kitchen items ──────────────
//
// At Sering's site, TestTafel and Centraal share a venue. TestTafel is the
// upscale evening dining experience (only opens 18:00+) selling exclusively
// the "Single TestTafel Menu" multi-course experience. Centraal is the
// community kitchen (DSC = "De Sering Community") serving lunch and
// community dinners.
//
// However, both register under one Tebi cash drawer with two profit
// centers, and staff sometimes forget to switch the POS to Centraal mode
// before ringing community-kitchen items. The result: DSC* / Lunch card /
// Stadspas items routinely show up under TestTafel's profit center, but
// they're actually Centraal customers.
//
// `resolveLocationForItem` corrects this for ProductRevenue + GuestHistory:
// any meal-y item rung up at TestTafel that isn't a Single TestTafel Menu
// is reassigned to centraal. Drinks at TestTafel (DSC pilsner, wine, etc.)
// stay at TestTafel — those are legitimate evening-service sales.
//
// Side effect: DailyRevenue per-PC totals (which come from Tebi's per-PC
// revenue_profit_center_<uuid> chart) reflect the as-rung-up location and
// will NOT match sum(ProductRevenue) for testtafel/centraal after this
// reassignment. Acceptable today — Finance UI primarily uses the 'all' row
// and per-product breakdown. If users start relying on per-PC revenue
// totals, recompute DailyRevenue from ProductRevenue sums instead.
function resolveLocationForItem(productName, pcLocation) {
  if (pcLocation !== 'testtafel') return pcLocation;
  // At TestTafel PC: Single TestTafel Menu items are genuine TestTafel sales.
  if (productName.startsWith('Single TestTafel Menu')) return 'testtafel';
  // Anything else that's a known meal item is a misattributed community
  // kitchen sale — should be Centraal.
  if (MEAL_ITEM_TYPE[productName]) return 'centraal';
  // Drinks / snacks / unknown items at TestTafel PC stay at TestTafel
  // (legitimate evening-service revenue).
  return 'testtafel';
}

// ── Product-level revenue (built from product_top per-PC data) ──────────────

// Build productRows from `productTopByPc`. Each PC's product_top response
// already carries items aggregated for the date range; we collapse to one
// row per (date, location, productName) with meal classified by item name.
//
// productTopByPc: { [locationName]: chartResponse }
// date: YYYY-MM-DD (single day — the scraper's per-day loop already iterates)
// Returns rows shaped for ProductRevenue table inserts.
//
// Location reassignment per `resolveLocationForItem` happens here, so
// downstream consumers (ProductRevenue, deriveGuestCountsFromProductRows
// → GuestHistory) all see the corrected location.
function formatProductRevenueFromTop(productTopByPc, date, options = {}) {
  const { forceLocation } = options;
  // Aggregate by (date, location, meal, productName) to handle the case
  // where the same item shows up at multiple PCs and gets reassigned to a
  // shared location (e.g. DSC Lunch at both TestTafel and Centraal both
  // → centraal). Without this, ProductRevenue.upsert with the unique key
  // would overwrite one with the other instead of summing.
  const agg = new Map();
  for (const [locName, chartData] of Object.entries(productTopByPc || {})) {
    if (!chartData || !Array.isArray(chartData.data)) continue;
    const pcLocation = forceLocation || locName;
    for (const entry of chartData.data) {
      const itemEntry = (entry.key && Array.isArray(entry.key.groupedBy))
        ? entry.key.groupedBy.find(g => g && g.name === 'ITEM')
        : null;
      if (!itemEntry) continue;
      const productName = itemEntry.value || 'Unknown';
      const qtyMetric = (entry.metrics || []).find(m => m && m.name === 'TOTAL_PRODUCTS_SOLD');
      const grossMetric = (entry.metrics || []).find(m => m && m.name === 'GROSS_REVENUE');
      const quantity = qtyMetric ? parseFloat(qtyMetric.value) || 0 : 0;
      const grossRevenue = grossMetric && typeof grossMetric.value === 'object'
        ? parseFloat(grossMetric.value.quantity) || 0
        : 0;
      if (quantity <= 0 && grossRevenue <= 0) continue;
      const meal = MEAL_ITEM_TYPE[productName] || 'other';
      const location = resolveLocationForItem(productName, pcLocation);
      const key = `${date}|${location}|${meal}|${productName}`;
      const existing = agg.get(key);
      if (existing) {
        existing.quantity += quantity;
        existing.grossRevenue += grossRevenue;
      } else {
        agg.set(key, {
          date,
          location,
          meal,
          productName,
          productCategory: '', // product_top doesn't carry category; left blank
          quantity,
          grossRevenue,
        });
      }
    }
  }
  return [...agg.values()].map(row => ({
    ...row,
    quantity: r2(row.quantity),
    grossRevenue: r2(row.grossRevenue),
    netRevenue: netFromGross(row.grossRevenue),
  }));
}

// Derive per-meal guest counts from a productRows array. Counts mirror the
// CSV path's logic: lunch + dinner totals INCLUDE the staff portion split
// 30/70 lunch/dinner (a default heuristic; we don't have per-hour data for
// staff meals from product_top).
function deriveGuestCountsFromProductRows(productRows) {
  const byLoc = {};
  for (const row of productRows) {
    const loc = row.location;
    const meal = MEAL_ITEM_TYPE[row.productName];
    if (!meal) continue;
    if (!byLoc[loc]) byLoc[loc] = { lunch: 0, dinner: 0, staff: 0, staff_lunch: 0, staff_dinner: 0 };
    if (meal === 'lunch') byLoc[loc].lunch += row.quantity;
    else if (meal === 'dinner') byLoc[loc].dinner += row.quantity;
    else if (meal === 'staff') byLoc[loc].staff += row.quantity;
  }
  for (const loc of Object.keys(byLoc)) {
    const c = byLoc[loc];
    c.staff_lunch = Math.round(c.staff * 0.3);
    c.staff_dinner = Math.round(c.staff * 0.7);
    c.lunch += c.staff_lunch;
    c.dinner += c.staff_dinner;
    // Round to ints (counts are people, not fractions)
    c.lunch = Math.round(c.lunch);
    c.dinner = Math.round(c.dinner);
    c.staff = Math.round(c.staff);
  }
  return byLoc;
}

// ── Legacy invoice line-item parser ─────────────────────────────────────────
// Kept around for fixture-based tests + as a documented dead path. Tebi
// stopped returning line items in the invoice list response on 2026-05-07,
// so production no longer relies on this. The new path is product_top
// (above) which Tebi guarantees as part of the back-office dashboard.
function formatProductRevenue(invoices, profitCenters, options = {}) {
  // Surface response-shape changes loudly. ProductRevenue silently went to
  // zero rows for ~7 weeks because Tebi's response shape changed and we had
  // no log telling us "the array we expected isn't there".
  //
  // 2026-05-07: Tebi renamed the invoice array from `content` to `data`.
  // Read either key (whichever is an array) so the scraper survives a
  // partial revert and old fixtures continue to parse.
  const invoiceArray = invoices && (Array.isArray(invoices.data)
    ? invoices.data
    : Array.isArray(invoices.content) ? invoices.content : null);
  if (!Array.isArray(invoiceArray)) {
    const keys = invoices && typeof invoices === 'object' ? Object.keys(invoices).join(',') : '(non-object)';
    log(`  ⚠ invoices.data / invoices.content missing or not an array. response keys=[${keys}]`);
    return [];
  }
  if (invoiceArray.length === 0) {
    log(`  invoice array is empty (no invoices for this date range).`);
    return [];
  }

  const { forceLocation } = options;

  // Build reverse map: profit center UUID → location name
  const pcToLoc = {};
  for (const [name, uuid] of Object.entries(profitCenters)) {
    if (uuid && name !== 'all') pcToLoc[uuid] = name;
  }

  // Aggregate: key = date|location|meal|productName|productCategory
  const agg = {};

  for (const invoice of invoiceArray) {
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

  // If we processed invoices but produced zero aggregated rows, the line-item
  // and total field names have likely drifted on Tebi's side. Log a sample
  // invoice's top-level keys (and the keys of the first nested array we see)
  // so the next cron's stdoutTail tells us exactly what to fix in the parser.
  if (Object.keys(agg).length === 0 && invoiceArray.length > 0) {
    const sample = invoiceArray[0];
    const sampleKeys = sample && typeof sample === 'object' ? Object.keys(sample).join(',') : '(non-object)';
    let nestedHint = '';
    if (sample && typeof sample === 'object') {
      for (const [k, v] of Object.entries(sample)) {
        if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'object') {
          nestedHint = ` first-array-key="${k}" first-element-keys=[${Object.keys(v[0]).join(',')}]`;
          break;
        }
      }
    }
    log(`  ⚠ formatProductRevenue: ${invoiceArray.length} invoices yielded 0 product rows. sample invoice keys=[${sampleKeys}]${nestedHint}`);
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
// Returns { summary, productRows, guestCounts } or throws on hard failure.
//
// `guestCounts` is { [locationName]: { lunch, dinner, staff, staff_lunch,
// staff_dinner } } and is the source for the GuestHistory auto-update done
// in tebi-sync-worker.js. `productRows` is built from product_top (no
// invoice line items as of 2026-05-07).
async function runForAccount(config, page, startDate, endDate) {
  const { email, password, ledgerId, forceLocation } = config;

  // Reset auth cache so Account 2 doesn't reuse Account 1's token
  fetchTebiAPI._authHeader = null;
  fetchTebiAPI._cookie = null;

  // Local profit centers — never leaks between account runs.
  // No 'all' sentinel any more — see comment on PROFIT_CENTERS at top.
  const profitCenters = { west: null, centraal: null, testtafel: null };

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
    // The day passed to formatProductRevenueFromTop is the row-key date —
    // the worker iterates per-day already, so startDate is the singular day.
    const productRows = formatProductRevenueFromTop(
      rawData.productTopByPc,
      startDate,
      { forceLocation },
    );
    const guestCounts = deriveGuestCountsFromProductRows(productRows);

    return { summary, productRows, guestCounts };
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
    const dumpArr = rawData.invoices && (Array.isArray(rawData.invoices.data)
      ? rawData.invoices.data
      : Array.isArray(rawData.invoices.content) ? rawData.invoices.content : null);
    if (dumpInvoices && dumpArr) {
      console.log('\n' + '='.repeat(60));
      console.log('INVOICE STRUCTURE (first 3 invoices)');
      console.log('='.repeat(60));
      const sample = dumpArr.slice(0, 3);
      console.log(JSON.stringify(sample, null, 2));
      console.log('='.repeat(60));
      console.log(`Total invoices: ${dumpArr.length}`);
      if (sample[0]) {
        console.log('Invoice keys:', Object.keys(sample[0]).join(', '));
        const items = sample[0].items || sample[0].lines || sample[0].lineItems || [];
        if (items.length > 0) {
          console.log('Line item keys:', Object.keys(items[0]).join(', '));
        }
      }
    }

    const forceLocation = process.env.TEBI_FORCE_LOCATION || null;
    // The new path: build per-product rows from product_top responses
    // (the previous invoice-line-items source went away when Tebi stripped
    // line items from /api/invoicing/.../invoices on 2026-05-07).
    const productRevenue = formatProductRevenueFromTop(
      rawData.productTopByPc,
      startDate,
      { forceLocation },
    );
    summary.productRevenue = productRevenue;
    summary.guestCounts = deriveGuestCountsFromProductRows(productRevenue);

    console.log('\n' + '='.repeat(60));
    console.log('PRODUCT REVENUE (from product_top, ' + productRevenue.length + ' rows)');
    console.log('='.repeat(60));
    console.log(JSON.stringify(productRevenue.slice(0, 12), null, 2));
    console.log('='.repeat(60));
    console.log('GUEST COUNTS (derived from meal-product allowlist)');
    console.log('='.repeat(60));
    console.log(JSON.stringify(summary.guestCounts, null, 2));
    console.log('='.repeat(60));

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

module.exports = {
  main,
  runForAccount,
  login,
  fetchTebiAPI,
  fetchDayData,
  formatResults,
  formatProductRevenue,           // legacy invoice-line-items path (kept for fixtures)
  formatProductRevenueFromTop,    // new product_top-based path
  deriveGuestCountsFromProductRows,
  classifyServicePeriod,
  sumMetric,
  MEAL_ITEM_TYPE,
  PROFIT_CENTERS,
  CHART_TYPES,
};
