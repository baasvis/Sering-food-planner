/**
 * End-to-end test: fetch per-day per-profit-center product data from Tebi,
 * map to lunch/dinner/staff meal counts, print a table.
 *
 * If the numbers look right, we wire this into the production sync.
 *
 * Usage:
 *   TEBI_BEARER_TOKEN='eyJ...' npx tsx scripts/tebi-derive-guests.ts
 *   TEBI_BEARER_TOKEN='...' TEBI_PROBE_START=2026-05-01 TEBI_PROBE_END=2026-05-07 npx tsx scripts/tebi-derive-guests.ts
 */

const TOKEN = process.env.TEBI_BEARER_TOKEN;
if (!TOKEN) {
  console.error('TEBI_BEARER_TOKEN not set');
  process.exit(1);
}

const BASE = 'https://live.tebi.co';
const LEDGER = process.env.TEBI_LEDGER_ID || '723192';
const START = process.env.TEBI_PROBE_START || '2026-04-30';
const END = process.env.TEBI_PROBE_END || '2026-05-07';

// Profit centers are discovered at runtime from dashboardMain. This makes
// the script work against any ledger (West / TestTafel+Centraal / future).

// Single source of truth for the meal-product allowlist lives in
// scripts/tebi-scraper.js — import it so this diagnostic stays in sync
// with the production pipeline. (If this file ever diverges, diagnostic
// numbers won't match what the cron actually writes.)
const { MEAL_ITEM_TYPE } = require('./tebi-scraper.js') as {
  MEAL_ITEM_TYPE: Record<string, 'lunch' | 'dinner' | 'staff'>;
};

interface ItemRow {
  itemName: string;
  itemId: string | null;
  quantity: number;
  grossRevenue: number;
}

interface ChartResponse {
  data: Array<{
    key: { groupedBy: Array<{ name: string; value: string; secondaryValue: string | null; id: string | null }> };
    metrics: Array<{ type: string; name: string; value: { currency: string; quantity: string } | string }>;
  }>;
  summary: Array<{ type: string; name: string; value: { currency: string; quantity: string } | string }>;
}

const headers: Record<string, string> = {
  authorization: `Bearer ${TOKEN}`,
  accept: '*/*',
  'accept-language': 'en-US',
  'tebi-version-code': '1722000',
};

async function discoverProfitCenters(ledgerId: string): Promise<Record<string, string>> {
  const r = await fetch(`${BASE}/api/insights/ledgers/${ledgerId}/insights/dashboards/main`, { headers });
  if (!r.ok) throw new Error(`dashboards/main: HTTP ${r.status}`);
  const dash = (await r.json()) as { chartGroups?: Array<{ charts?: Array<{ id?: string; name?: string }> }> };
  const out: Record<string, string> = {};
  for (const g of dash.chartGroups ?? []) {
    for (const c of g.charts ?? []) {
      if (c.id && c.id.startsWith('revenue_profit_center_')) {
        const uuid = c.id.replace('revenue_profit_center_', '');
        // Normalise label to lowercase + trim + first word for the key
        const label = (c.name ?? '').trim().toLowerCase();
        let key = label.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
        // Friendly aliases for the locations we know about, so output is
        // consistent across accounts.
        if (label.includes('west')) key = 'west';
        else if (label.includes('centraal')) key = 'centraal';
        else if (label.includes('testtafel') || label.includes('test')) key = 'testtafel';
        out[key] = uuid;
      }
    }
  }
  return out;
}

async function fetchProductTop(ledgerId: string, date: string, profitCenterUuid: string): Promise<ItemRow[]> {
  // endDate is exclusive, so for one day we pass next-day as endDate.
  const [y, m, d] = date.split('-').map(Number);
  const next = new Date(y, m - 1, d + 1);
  const endDate = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
  const filter = encodeURIComponent(JSON.stringify({ grouping: 'PROFIT_CENTER', value: profitCenterUuid }));
  const url = `${BASE}/api/insights/ledgers/${ledgerId}/insights/data/charts/product_top?startDate=${date}&endDate=${endDate}&mock=false&limit=-1&filter=${filter}`;
  const r = await fetch(url, { headers });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`product_top ${date} ${profitCenterUuid}: ${r.status} ${text.slice(0, 200)}`);
  }
  const body = (await r.json()) as ChartResponse;
  const rows: ItemRow[] = [];
  for (const entry of body.data ?? []) {
    const itemEntry = entry.key.groupedBy.find((g) => g.name === 'ITEM');
    if (!itemEntry) continue;
    const qtyMetric = entry.metrics.find((m) => m.name === 'TOTAL_PRODUCTS_SOLD');
    const grossMetric = entry.metrics.find((m) => m.name === 'GROSS_REVENUE');
    const qty = qtyMetric ? parseFloat(typeof qtyMetric.value === 'string' ? qtyMetric.value : '0') : 0;
    const gross = grossMetric && typeof grossMetric.value === 'object' ? parseFloat(grossMetric.value.quantity) : 0;
    rows.push({
      itemName: itemEntry.value,
      itemId: itemEntry.id,
      quantity: qty,
      grossRevenue: gross,
    });
  }
  return rows;
}

interface GuestCounts {
  lunch: number;
  dinner: number;
  staff: number;
  staff_lunch: number;
  staff_dinner: number;
}

function deriveGuestCounts(items: ItemRow[]): GuestCounts {
  const counts: GuestCounts = { lunch: 0, dinner: 0, staff: 0, staff_lunch: 0, staff_dinner: 0 };
  for (const item of items) {
    const meal = MEAL_ITEM_TYPE[item.itemName];
    if (!meal) continue;
    if (meal === 'lunch') counts.lunch += item.quantity;
    else if (meal === 'dinner') counts.dinner += item.quantity;
    else if (meal === 'staff') {
      // No time-of-day breakdown available from product_top; default 30%
      // lunch / 70% dinner mirroring the typical Sering pattern (more
      // staff stay through dinner service). User can refine later.
      counts.staff += item.quantity;
      counts.staff_lunch += Math.round(item.quantity * 0.3);
      counts.staff_dinner += Math.round(item.quantity * 0.7);
    }
  }
  // The CSV path counts staff INSIDE the matching meal total (so lunch
  // includes staff_lunch). Mirror that so downstream consumers see the
  // same shape they're already using.
  counts.lunch += counts.staff_lunch;
  counts.dinner += counts.staff_dinner;
  return counts;
}

function dateRange(start: string, end: string): string[] {
  const out: string[] = [];
  const [sy, sm, sd] = start.split('-').map(Number);
  const [ey, em, ed] = end.split('-').map(Number);
  const cur = new Date(sy, sm - 1, sd);
  const stop = new Date(ey, em - 1, ed);
  while (cur <= stop) {
    out.push(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}-${String(cur.getDate()).padStart(2, '0')}`);
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

async function main(): Promise<void> {
  const dates = dateRange(START, END);
  console.log(`Discovering profit centers for ledger ${LEDGER}…`);
  const PROFIT_CENTERS = await discoverProfitCenters(LEDGER);
  console.log(`Found ${Object.keys(PROFIT_CENTERS).length} profit centers: ${Object.entries(PROFIT_CENTERS).map(([k, v]) => `${k}=${v.slice(0, 8)}…`).join(', ')}`);
  console.log(`Fetching product_top for ${dates.length} days × ${Object.keys(PROFIT_CENTERS).length} profit centers from ledger ${LEDGER}`);
  console.log(`Range: ${START} → ${END}`);
  console.log('');

  console.log(
    `${'DATE'.padEnd(12)} ${'LOCATION'.padEnd(10)} ${'lunch'.padStart(7)} ${'dinner'.padStart(7)} ${'staff'.padStart(7)}  matched-items`,
  );

  // Track unmatched items so the user can see what's NOT being counted.
  const unmatchedAgg = new Map<string, { qty: number; gross: number; days: number }>();

  for (const date of dates) {
    for (const [locKey, pcUuid] of Object.entries(PROFIT_CENTERS)) {
      try {
        const items = await fetchProductTop(LEDGER, date, pcUuid);
        const matched = items.filter((i) => MEAL_ITEM_TYPE[i.itemName]);
        const unmatched = items.filter((i) => !MEAL_ITEM_TYPE[i.itemName]);
        for (const u of unmatched) {
          const cur = unmatchedAgg.get(u.itemName) ?? { qty: 0, gross: 0, days: 0 };
          cur.qty += u.quantity;
          cur.gross += u.grossRevenue;
          cur.days += 1;
          unmatchedAgg.set(u.itemName, cur);
        }
        const counts = deriveGuestCounts(items);
        if (matched.length === 0 && counts.lunch === 0 && counts.dinner === 0) continue;
        const items_summary = matched.map((m) => `${m.itemName}=${m.quantity}`).join(', ');
        console.log(
          `${date.padEnd(12)} ${locKey.padEnd(10)} ${String(counts.lunch).padStart(7)} ${String(counts.dinner).padStart(7)} ${String(counts.staff).padStart(7)}  ${items_summary}`,
        );
      } catch (e) {
        console.log(`${date.padEnd(12)} ${locKey.padEnd(10)} ERROR: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  console.log('');
  console.log('Notes:');
  console.log(' - lunch / dinner totals INCLUDE the staff portion attributed to each meal (matches the CSV path).');
  console.log(' - staff column is total "Staff & volunteer meals" sold; we split it 30/70 lunch/dinner without time data.');
  console.log(' - rows where every meal count is zero are skipped (closed days / locations not used in this ledger).');

  // Top unmatched items — eyeball whether anything food-related is being missed.
  console.log('');
  console.log('Top unmatched items (NOT counted as meals — verify nothing important is missing):');
  const topUnmatched = [...unmatchedAgg.entries()]
    .sort((a, b) => b[1].qty - a[1].qty)
    .slice(0, 15);
  for (const [name, agg] of topUnmatched) {
    console.log(`  ${name.padEnd(45)} qty=${String(agg.qty).padStart(5)}  gross=€${agg.gross.toFixed(2).padStart(8)}  appeared on ${agg.days} (date,location) row(s)`);
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
