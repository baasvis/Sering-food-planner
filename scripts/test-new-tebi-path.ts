/**
 * Integration test for the post-rewrite Tebi sync path.
 *
 * Bypasses Playwright (uses a Bearer token directly), fetches product_top
 * via direct HTTP, then exercises the EXACT same parsing + derivation
 * functions that the production sync worker will call:
 *   - formatProductRevenueFromTop (new product-top-based productRows)
 *   - deriveGuestCountsFromProductRows (per-meal counts for GuestHistory)
 *
 * Output is what the cron will write each night (minus the DB call).
 *
 * Usage: TEBI_BEARER_TOKEN='eyJ...' npx tsx scripts/test-new-tebi-path.ts
 */

const { formatProductRevenueFromTop, deriveGuestCountsFromProductRows } = require('./tebi-scraper.js') as {
  formatProductRevenueFromTop: (
    productTopByPc: Record<string, unknown>,
    date: string,
    options?: { forceLocation?: string | null },
  ) => Array<{
    date: string;
    location: string;
    meal: string;
    productName: string;
    productCategory: string;
    quantity: number;
    grossRevenue: number;
    netRevenue: number;
  }>;
  deriveGuestCountsFromProductRows: (rows: unknown[]) => Record<string, {
    lunch: number;
    dinner: number;
    staff: number;
    staff_lunch: number;
    staff_dinner: number;
  }>;
};

const TOKEN = process.env.TEBI_BEARER_TOKEN;
if (!TOKEN) {
  console.error('TEBI_BEARER_TOKEN not set');
  process.exit(1);
}

const BASE = 'https://live.tebi.co';
const LEDGER = process.env.TEBI_LEDGER_ID || '723192';
const PROFIT_CENTERS = {
  west: '00000000-0000-0000-0000-000000000000',
  centraal: '27c33042-47c1-4650-8e76-37c7bfef86dd',
  testtafel: 'a904a975-6bd2-413f-8e02-dc457b87a6e3',
};

const headers: Record<string, string> = {
  authorization: `Bearer ${TOKEN}`,
  accept: '*/*',
  'tebi-version-code': '1722000',
};

async function fetchProductTop(date: string, pcUuid: string): Promise<unknown> {
  const [y, m, d] = date.split('-').map(Number);
  const next = new Date(y, m - 1, d + 1);
  const endDate = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
  const filter = encodeURIComponent(JSON.stringify({ grouping: 'PROFIT_CENTER', value: pcUuid }));
  const url = `${BASE}/api/insights/ledgers/${LEDGER}/insights/data/charts/product_top?startDate=${date}&endDate=${endDate}&mock=false&limit=-1&filter=${filter}`;
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`product_top ${date} ${pcUuid}: HTTP ${r.status}`);
  return await r.json();
}

async function main(): Promise<void> {
  const dates = ['2026-04-30', '2026-05-01', '2026-05-04', '2026-05-05', '2026-05-06', '2026-05-07'];
  const allProductRows: ReturnType<typeof formatProductRevenueFromTop> = [];
  const allGuestCounts: Record<string, Record<string, { lunch: number; dinner: number; staff: number; staff_lunch: number; staff_dinner: number }>> = {};

  for (const date of dates) {
    // Fetch product_top for each PC into the shape `formatProductRevenueFromTop` expects
    const productTopByPc: Record<string, unknown> = {};
    for (const [name, uuid] of Object.entries(PROFIT_CENTERS)) {
      try {
        productTopByPc[name] = await fetchProductTop(date, uuid);
      } catch (e) {
        console.error(`  fetch failed: ${e instanceof Error ? e.message : e}`);
      }
    }

    // Run the EXACT pipeline the production worker will run
    const productRows = formatProductRevenueFromTop(productTopByPc, date);
    const guestCounts = deriveGuestCountsFromProductRows(productRows);
    allProductRows.push(...productRows);
    allGuestCounts[date] = guestCounts;
  }

  // Print summary (mirrors what the worker would log)
  console.log('=== Per-day GuestHistory rows (this is what gets written to the DB) ===');
  console.log('');
  console.log(`${'DATE'.padEnd(12)} ${'LOCATION'.padEnd(10)} ${'lunch'.padStart(6)} ${'dinner'.padStart(6)} ${'staff'.padStart(6)} ${'st_lunch'.padStart(8)} ${'st_dinner'.padStart(9)}`);
  for (const date of dates) {
    for (const [loc, c] of Object.entries(allGuestCounts[date])) {
      if (c.lunch === 0 && c.dinner === 0 && c.staff === 0) continue;
      console.log(
        `${date.padEnd(12)} ${loc.padEnd(10)} ${String(c.lunch).padStart(6)} ${String(c.dinner).padStart(6)} ${String(c.staff).padStart(6)} ${String(c.staff_lunch).padStart(8)} ${String(c.staff_dinner).padStart(9)}`,
      );
    }
  }

  console.log('');
  console.log(`=== ProductRevenue rows preview (${allProductRows.length} total across all dates) ===`);
  console.log('');
  // Sample top 12 by gross
  const top = [...allProductRows].sort((a, b) => b.grossRevenue - a.grossRevenue).slice(0, 12);
  console.log(`${'DATE'.padEnd(12)} ${'LOC'.padEnd(8)} ${'MEAL'.padEnd(8)} ${'PRODUCT'.padEnd(35)} ${'QTY'.padStart(6)} ${'GROSS'.padStart(9)}`);
  for (const r of top) {
    console.log(
      `${r.date.padEnd(12)} ${r.location.padEnd(8)} ${r.meal.padEnd(8)} ${r.productName.slice(0, 35).padEnd(35)} ${String(r.quantity).padStart(6)} €${r.grossRevenue.toFixed(2).padStart(8)}`,
    );
  }

  console.log('');
  console.log('=== Per-meal classification breakdown ===');
  const byMeal: Record<string, { rows: number; qty: number; gross: number }> = {};
  for (const r of allProductRows) {
    if (!byMeal[r.meal]) byMeal[r.meal] = { rows: 0, qty: 0, gross: 0 };
    byMeal[r.meal].rows += 1;
    byMeal[r.meal].qty += r.quantity;
    byMeal[r.meal].gross += r.grossRevenue;
  }
  for (const [meal, agg] of Object.entries(byMeal)) {
    console.log(`  ${meal.padEnd(8)} rows=${String(agg.rows).padStart(4)} qty=${String(Math.round(agg.qty)).padStart(5)} gross=€${agg.gross.toFixed(2).padStart(9)}`);
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
