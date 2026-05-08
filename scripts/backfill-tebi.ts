/**
 * Cleanup + backfill for any Tebi ledger. Discovers profit centers at
 * runtime from the supplied Bearer token + ledger, so it works for both:
 *   - Account 1 (info@testtafel.nl, ledger 723192) — West (always), and
 *     Centraal historically (2026-03-06 → 2026-04-09).
 *   - Account 2 (facturen@testtafel.nl, ledger 724466) — TestTafel +
 *     Centraal in their new home (2026-04-10 onwards).
 *
 * What this does, per date in [START, END]:
 *  1. DELETE existing ProductRevenue rows for the locations the script is
 *     touching (specified via DELETE_LOCATIONS, default centraal+testtafel
 *     since West is already correct from cron and we don't want to
 *     overwrite it).
 *  2. DELETE existing GuestHistory rows for the same locations + dates.
 *  3. Fetch product_top for each discovered PC with the supplied Bearer
 *     token.
 *  4. Apply formatProductRevenueFromTop — same reassignment rule as
 *     production cron (community-kitchen items at TestTafel PC →
 *     centraal). This is benign for Account 1 since its TestTafel PC has
 *     basically always been empty.
 *  5. Aggregate, upsert ProductRevenue.
 *  6. Derive guest counts, upsert GuestHistory.
 *
 * DailyRevenue is NOT touched — those values come from per-PC revenue
 * charts and are independently maintained by cron / manual sync.
 *
 * Usage:
 *   TEBI_BEARER_TOKEN='eyJ...' \
 *   TEBI_LEDGER_ID=724466 \
 *   BACKFILL_START=2026-04-10 BACKFILL_END=2026-05-08 \
 *   [DELETE_LOCATIONS=centraal,testtafel] \
 *   npx tsx scripts/backfill-tebi-account2.ts [--dry-run]
 *
 * Defaults: TEBI_LEDGER_ID = 724466, DELETE_LOCATIONS = centraal,testtafel.
 *
 * The TEBI_BEARER_TOKEN_2 env var is also accepted (legacy from when this
 * script was Account-2-specific) so existing recipes don't break.
 */

import { PrismaClient } from '@prisma/client';

const {
  formatProductRevenueFromTop,
  deriveGuestCountsFromProductRows,
  // MEAL_ITEM_TYPE,  // imported only for type ref if needed
} = require('./tebi-scraper.js') as {
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
  deriveGuestCountsFromProductRows: (rows: Array<Record<string, unknown>>) => Record<string, {
    lunch: number;
    dinner: number;
    staff: number;
    staff_lunch: number;
    staff_dinner: number;
  }>;
};

const TOKEN = process.env.TEBI_BEARER_TOKEN || process.env.TEBI_BEARER_TOKEN_2;
if (!TOKEN) {
  console.error('TEBI_BEARER_TOKEN (or TEBI_BEARER_TOKEN_2) not set');
  process.exit(1);
}

const DRY_RUN = process.argv.includes('--dry-run');
const BASE = 'https://live.tebi.co';
const LEDGER = process.env.TEBI_LEDGER_ID || '724466';

// Locations to wipe before backfilling. Defaults to centraal+testtafel —
// West is excluded so this script never accidentally clobbers Account 1's
// already-correct data when run against Account 1 to fill in the centraal
// gap.
const DELETE_LOCATIONS = (process.env.DELETE_LOCATIONS || 'centraal,testtafel')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Default: from new-account first activity to today.
const today = new Date();
const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
const START = process.env.BACKFILL_START || '2026-04-10';
const END = process.env.BACKFILL_END || todayStr;

const headers: Record<string, string> = {
  authorization: `Bearer ${TOKEN}`,
  accept: '*/*',
  'tebi-version-code': '1722000',
};

async function discoverProfitCenters(): Promise<Record<string, string>> {
  const r = await fetch(`${BASE}/api/insights/ledgers/${LEDGER}/insights/dashboards/main`, { headers });
  if (!r.ok) throw new Error(`dashboards/main: HTTP ${r.status}`);
  const dash = (await r.json()) as { chartGroups?: Array<{ charts?: Array<{ id?: string; name?: string }> }> };
  const out: Record<string, string> = {};
  for (const g of dash.chartGroups ?? []) {
    for (const c of g.charts ?? []) {
      if (c.id && c.id.startsWith('revenue_profit_center_')) {
        const uuid = c.id.replace('revenue_profit_center_', '');
        const label = (c.name ?? '').trim().toLowerCase();
        let key = label.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
        if (label.includes('west')) key = 'west';
        else if (label.includes('centraal')) key = 'centraal';
        else if (label.includes('testtafel') || label.includes('test')) key = 'testtafel';
        out[key] = uuid;
      }
    }
  }
  return out;
}

async function fetchProductTop(date: string, pcUuid: string): Promise<unknown> {
  // endDate is exclusive on Tebi's chart endpoints.
  const [y, m, d] = date.split('-').map(Number);
  const next = new Date(y, m - 1, d + 1);
  const endDate = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
  const filter = encodeURIComponent(JSON.stringify({ grouping: 'PROFIT_CENTER', value: pcUuid }));
  const url = `${BASE}/api/insights/ledgers/${LEDGER}/insights/data/charts/product_top?startDate=${date}&endDate=${endDate}&mock=false&limit=-1&filter=${filter}`;
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`product_top ${date} ${pcUuid}: HTTP ${r.status}`);
  return await r.json();
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

const MEAL_FIELDS = ['lunch', 'dinner', 'staff', 'staff_lunch', 'staff_dinner'] as const;

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const dates = dateRange(START, END);
  const PROFIT_CENTERS = await discoverProfitCenters();

  console.log(`Backfill plan:`);
  console.log(`  Range:        ${START} → ${END} (${dates.length} days)`);
  console.log(`  Ledger:       ${LEDGER}`);
  console.log(`  Discovered PCs: ${Object.entries(PROFIT_CENTERS).map(([k, v]) => `${k}=${v.slice(0, 8)}…`).join(', ')}`);
  console.log(`  Wipe before write: ${DELETE_LOCATIONS.join(', ')}`);
  console.log(`  Mode:         ${DRY_RUN ? 'DRY RUN (no DB writes)' : 'WRITE'}`);
  console.log('');

  let totalProductRowsWritten = 0;
  let totalGuestRowsWritten = 0;
  let totalProductRowsDeleted = 0;
  let totalGuestRowsDeleted = 0;
  const summary: Array<{ date: string; centraalLunch: number; centraalDinner: number; centraalStaff: number; testtafelDinner: number }> = [];

  try {
    for (const date of dates) {
      // ── Step 1+2: clean existing rows for this date in target locations ──
      if (!DRY_RUN) {
        const prDel = await prisma.productRevenue.deleteMany({
          where: { date, location: { in: DELETE_LOCATIONS } },
        });
        const ghDel = await prisma.guestHistory.deleteMany({
          where: { date, location: { in: DELETE_LOCATIONS } },
        });
        totalProductRowsDeleted += prDel.count;
        totalGuestRowsDeleted += ghDel.count;
      }

      // ── Step 3: fetch product_top per PC ──
      // Only fetch PCs whose pre-reassignment location is one we're going
      // to write. Skipping un-touched-locations means we never overwrite
      // (e.g.) Account 1's West GuestHistory when the script's run scope
      // is just the centraal gap.
      const productTopByPc: Record<string, unknown> = {};
      for (const [name, uuid] of Object.entries(PROFIT_CENTERS)) {
        if (!DELETE_LOCATIONS.includes(name)) continue;
        try {
          productTopByPc[name] = await fetchProductTop(date, uuid);
        } catch (e) {
          console.error(`  ${date} ${name}: fetch failed — ${e instanceof Error ? e.message : e}`);
        }
      }

      // ── Step 4+5: build productRows (with reassignment) ──
      const productRows = formatProductRevenueFromTop(productTopByPc, date);

      // ── Step 6: derive guest counts ──
      const guestCounts = deriveGuestCountsFromProductRows(productRows);

      // Pretty-print summary line for this date
      const cen = guestCounts['centraal'] || { lunch: 0, dinner: 0, staff: 0, staff_lunch: 0, staff_dinner: 0 };
      const tt = guestCounts['testtafel'] || { lunch: 0, dinner: 0, staff: 0, staff_lunch: 0, staff_dinner: 0 };
      summary.push({
        date,
        centraalLunch: cen.lunch,
        centraalDinner: cen.dinner,
        centraalStaff: cen.staff,
        testtafelDinner: tt.dinner,
      });

      if (DRY_RUN) {
        console.log(
          `  ${date}: centraal=L${cen.lunch}/D${cen.dinner}/S${cen.staff}, testtafel=D${tt.dinner} (${productRows.length} product rows would write)`,
        );
        continue;
      }

      // ── Write ProductRevenue ──
      const now = new Date().toISOString();
      let prWritten = 0;
      for (const row of productRows) {
        try {
          await prisma.productRevenue.upsert({
            where: {
              date_location_meal_productName: {
                date: row.date,
                location: row.location,
                meal: row.meal,
                productName: row.productName,
              },
            },
            update: {
              productCategory: row.productCategory,
              quantity: row.quantity,
              grossRevenue: row.grossRevenue,
              netRevenue: row.netRevenue,
              syncedAt: now,
            },
            create: {
              date: row.date,
              location: row.location,
              meal: row.meal,
              productName: row.productName,
              productCategory: row.productCategory,
              quantity: row.quantity,
              grossRevenue: row.grossRevenue,
              netRevenue: row.netRevenue,
              syncedAt: now,
            },
          });
          prWritten++;
        } catch (e) {
          console.error(`  ${date} ${row.location}/${row.productName} upsert failed: ${e instanceof Error ? e.message : e}`);
        }
      }
      totalProductRowsWritten += prWritten;

      // ── Write GuestHistory ──
      let ghWritten = 0;
      for (const [location, counts] of Object.entries(guestCounts)) {
        for (const meal of MEAL_FIELDS) {
          const value = parseInt(String(counts[meal] ?? 0), 10) || 0;
          if (value <= 0) continue;
          try {
            await prisma.guestHistory.upsert({
              where: { location_meal_date: { location, meal, date } },
              update: { count: value },
              create: { location, meal, date, count: value },
            });
            ghWritten++;
          } catch (e) {
            console.error(`  ${date} ${location}/${meal} upsert failed: ${e instanceof Error ? e.message : e}`);
          }
        }
      }
      totalGuestRowsWritten += ghWritten;

      console.log(
        `  ${date}: deleted ${totalProductRowsDeleted - (totalProductRowsDeleted - 0)}/${totalGuestRowsDeleted - 0}, wrote PR=${prWritten} GH=${ghWritten}, centraal L${cen.lunch}/D${cen.dinner}/S${cen.staff} testtafel D${tt.dinner}`,
      );
    }

    console.log('');
    console.log('=== Summary ===');
    console.log(
      `${'DATE'.padEnd(12)} ${'centraal lunch'.padStart(15)} ${'centraal dinner'.padStart(16)} ${'centraal staff'.padStart(15)} ${'testtafel dinner'.padStart(17)}`,
    );
    for (const s of summary) {
      console.log(
        `${s.date.padEnd(12)} ${String(s.centraalLunch).padStart(15)} ${String(s.centraalDinner).padStart(16)} ${String(s.centraalStaff).padStart(15)} ${String(s.testtafelDinner).padStart(17)}`,
      );
    }
    console.log('');
    console.log(`Totals: ProductRevenue rows deleted=${totalProductRowsDeleted}, written=${totalProductRowsWritten}`);
    console.log(`        GuestHistory  rows deleted=${totalGuestRowsDeleted},  written=${totalGuestRowsWritten}`);
    if (DRY_RUN) console.log('(DRY RUN — no DB changes were made)');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
