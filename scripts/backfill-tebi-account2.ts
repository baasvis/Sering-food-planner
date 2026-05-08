/**
 * Cleanup + backfill for the new Tebi account (TestTafel + Centraal,
 * ledger 724466, facturen@testtafel.nl) covering the new-account era.
 *
 * What this does, per date in [START, END]:
 *  1. DELETE existing ProductRevenue rows for testtafel AND centraal
 *     (wipes both pre-reassignment stale rows and any partial sync rows
 *     so we don't leave orphans behind).
 *  2. DELETE existing GuestHistory rows for testtafel AND centraal.
 *  3. Fetch Account 2's product_top for each PC (TestTafel UUID
 *     00000000-...-0 and Centraal UUID 85194418-...) with the supplied
 *     Bearer token.
 *  4. Apply the production scraper's reassignment rule
 *     (`formatProductRevenueFromTop` from tebi-scraper.js) — community
 *     kitchen items rung up at TestTafel PC are reassigned to centraal.
 *  5. Aggregate by (date, location, meal, productName) and upsert into
 *     ProductRevenue.
 *  6. Derive per-meal guest counts and upsert into GuestHistory.
 *
 * West (account 1) is NOT touched — its data is already correct from cron.
 *
 * DailyRevenue is also NOT touched here — those values come from per-PC
 * revenue charts and are already populated by the cron / manual syncs.
 * Cleaning + recomputing them would double the API call count and isn't
 * what the user actually sees on the Guests page.
 *
 * Usage:
 *   TEBI_BEARER_TOKEN_2='eyJ...' \
 *   BACKFILL_START=2026-04-10 BACKFILL_END=2026-05-08 \
 *   npx tsx scripts/backfill-tebi-account2.ts [--dry-run]
 *
 * Defaults: START = 2026-04-10 (new-account first activity), END = today.
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

const TOKEN = process.env.TEBI_BEARER_TOKEN_2;
if (!TOKEN) {
  console.error('TEBI_BEARER_TOKEN_2 not set');
  process.exit(1);
}

const DRY_RUN = process.argv.includes('--dry-run');
const BASE = 'https://live.tebi.co';
const LEDGER = '724466';
const PROFIT_CENTERS: Record<string, string> = {
  testtafel: '00000000-0000-0000-0000-000000000000',
  centraal: '85194418-ab36-49a0-8161-9ae3a64576ba',
};

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

  console.log(`Backfill plan:`);
  console.log(`  Range:   ${START} → ${END} (${dates.length} days)`);
  console.log(`  Ledger:  ${LEDGER}`);
  console.log(`  PCs:     ${Object.keys(PROFIT_CENTERS).join(', ')}`);
  console.log(`  Mode:    ${DRY_RUN ? 'DRY RUN (no DB writes)' : 'WRITE'}`);
  console.log('');

  let totalProductRowsWritten = 0;
  let totalGuestRowsWritten = 0;
  let totalProductRowsDeleted = 0;
  let totalGuestRowsDeleted = 0;
  const summary: Array<{ date: string; centraalLunch: number; centraalDinner: number; centraalStaff: number; testtafelDinner: number }> = [];

  try {
    for (const date of dates) {
      // ── Step 1+2: clean existing testtafel + centraal rows for this date ──
      if (!DRY_RUN) {
        const prDel = await prisma.productRevenue.deleteMany({
          where: { date, location: { in: ['testtafel', 'centraal'] } },
        });
        const ghDel = await prisma.guestHistory.deleteMany({
          where: { date, location: { in: ['testtafel', 'centraal'] } },
        });
        totalProductRowsDeleted += prDel.count;
        totalGuestRowsDeleted += ghDel.count;
      }

      // ── Step 3: fetch product_top per PC ──
      const productTopByPc: Record<string, unknown> = {};
      for (const [name, uuid] of Object.entries(PROFIT_CENTERS)) {
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
