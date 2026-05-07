#!/usr/bin/env node
/**
 * diagnose-tebi-coverage.ts
 *
 * Read-only DB inspection of what the Tebi Playwright scraper has actually
 * captured for the last N days. Use this to verify that:
 *   - all configured ledgers are syncing on schedule (DailyRevenue.syncedAt
 *     freshness),
 *   - profit-center discovery is working for every location (no surprise
 *     `location = 'unknown'` rows),
 *   - per-meal product data exists for Centraal — i.e. the dedicated Tebi
 *     setup is actually being scraped under that label,
 *   - the meal-product allowlist (Lunch / DSC Dinner / Staff & volunteer
 *     meals / etc.) has hits — without these names matching exactly, no
 *     guests can be derived from ProductRevenue regardless of how many rows
 *     the scraper writes.
 *
 * No writes. Run against prod via DATABASE_URL_PROD or against any DB via
 * DATABASE_URL.
 *
 * Env:
 *   DATABASE_URL_PROD    read-only prod URL (preferred)
 *   DATABASE_URL         fallback
 *   TEBI_DIAG_DAYS       lookback window in days (default 14)
 *
 * Usage:
 *   DATABASE_URL_PROD="postgresql://..." npx tsx scripts/diagnose-tebi-coverage.ts
 */

import { PrismaClient } from '@prisma/client';

// Exact-match allowlist used by the CSV path (predictions.ts categorizers).
// Anything outside this list is invisible to the would-be guest-count step.
const MEAL_PRODUCT_NAMES = [
  'Lunch',
  'Lunch card guest',
  'Dinner donation',
  'Stadspas Dinner',
  'DSC Dinner',
  'Staff & volunteer meals',
];
const MEAL_PRODUCT_NAMES_LC = MEAL_PRODUCT_NAMES.map((s) => s.toLowerCase());
const EXPECTED_LOCATIONS = new Set(['west', 'centraal', 'all', 'unknown', 'testtafel']);

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function rpad(s: string | number, w: number): string {
  const v = String(s);
  return v.length >= w ? v : v + ' '.repeat(w - v.length);
}

function lpad(s: string | number, w: number): string {
  const v = String(s);
  return v.length >= w ? v : ' '.repeat(w - v.length) + v;
}

function header(title: string): void {
  console.log('');
  console.log('='.repeat(78));
  console.log(`  ${title}`);
  console.log('='.repeat(78));
}

interface PerLocationSummary {
  location: string;
  prRows: number;
  prDays: number;
  drRows: number;
  drDays: number;
  latestDate: string | null;
  latestSync: string | null;
  allowlistRows: number;
  allowlistQty: number;
}

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL_PROD ?? process.env.DATABASE_URL ?? '';
  if (!dbUrl) {
    console.error('No database URL set (DATABASE_URL_PROD or DATABASE_URL).');
    process.exit(1);
  }
  const days = Number(process.env.TEBI_DIAG_DAYS ?? 14);
  const fromDate = isoDaysAgo(days - 1); // inclusive of today
  const toDate = isoToday();

  let host = 'unknown';
  try {
    host = new URL(dbUrl.replace(/^postgresql:/, 'http:')).host;
  } catch {
    /* ignore parse failures */
  }

  const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });

  try {
    console.log('Tebi coverage diagnostic');
    console.log(`  database host:   ${host}`);
    console.log(`  window:          ${fromDate} → ${toDate} (${days} days inclusive)`);
    console.log(`  meal allowlist:  ${MEAL_PRODUCT_NAMES.join(', ')}`);

    // ── Pull everything we need in one place ──
    const [drAll, drWindow, prByLoc, prByLocMeal, prByLocProd, allowedRows, distinctLocs] =
      await Promise.all([
        prisma.dailyRevenue.groupBy({
          by: ['location'],
          _max: { syncedAt: true, date: true },
          _count: { _all: true },
        }),
        prisma.dailyRevenue.findMany({
          where: { date: { gte: fromDate } },
          orderBy: [{ date: 'desc' }, { location: 'asc' }],
        }),
        prisma.productRevenue.groupBy({
          by: ['location'],
          where: { date: { gte: fromDate } },
          _count: { _all: true },
          _sum: { quantity: true, grossRevenue: true },
        }),
        prisma.productRevenue.groupBy({
          by: ['location', 'meal'],
          where: { date: { gte: fromDate } },
          _count: { _all: true },
          _sum: { quantity: true },
        }),
        prisma.productRevenue.groupBy({
          by: ['location', 'productName'],
          where: { date: { gte: fromDate } },
          _count: { _all: true },
          _sum: { quantity: true },
        }),
        prisma.productRevenue.findMany({
          where: { date: { gte: fromDate }, productName: { in: MEAL_PRODUCT_NAMES } },
          orderBy: [{ date: 'desc' }, { location: 'asc' }, { meal: 'asc' }],
        }),
        prisma.productRevenue.findMany({
          where: { date: { gte: fromDate } },
          select: { location: true },
          distinct: ['location'],
        }),
      ]);

    // Per-location aggregate (PR rows in window)
    const prRowsByLoc = new Map<string, { rows: number; qty: number }>();
    for (const r of prByLoc) {
      prRowsByLoc.set(r.location, {
        rows: r._count._all,
        qty: r._sum.quantity ?? 0,
      });
    }

    // Distinct PR days per location
    const prDaysByLoc = new Map<string, Set<string>>();
    for (const r of allowedRows) {
      // build alongside
    }
    const allPrRows = await prisma.productRevenue.findMany({
      where: { date: { gte: fromDate } },
      select: { location: true, date: true },
    });
    for (const r of allPrRows) {
      if (!prDaysByLoc.has(r.location)) prDaysByLoc.set(r.location, new Set());
      prDaysByLoc.get(r.location)!.add(r.date);
    }

    // Allowlist hits per location
    const allowlistByLoc = new Map<string, { rows: number; qty: number }>();
    for (const r of allowedRows) {
      const cur = allowlistByLoc.get(r.location) ?? { rows: 0, qty: 0 };
      cur.rows += 1;
      cur.qty += r.quantity;
      allowlistByLoc.set(r.location, cur);
    }

    // DR per location summary
    const drRowsByLoc = new Map<string, { rows: number; days: Set<string>; latestDate: string; latestSync: string }>();
    for (const r of drWindow) {
      const cur = drRowsByLoc.get(r.location) ?? {
        rows: 0,
        days: new Set<string>(),
        latestDate: '',
        latestSync: '',
      };
      cur.rows += 1;
      cur.days.add(r.date);
      if (r.date > cur.latestDate) cur.latestDate = r.date;
      if (r.syncedAt > cur.latestSync) cur.latestSync = r.syncedAt;
      drRowsByLoc.set(r.location, cur);
    }

    // ── Section 1: headline per-location summary ──
    header('1. Headline — coverage per location (last window)');
    const allLocs = new Set<string>([
      ...drRowsByLoc.keys(),
      ...prRowsByLoc.keys(),
      ...prDaysByLoc.keys(),
    ]);
    const summaries: PerLocationSummary[] = [];
    for (const loc of allLocs) {
      const dr = drRowsByLoc.get(loc);
      const prRows = prRowsByLoc.get(loc)?.rows ?? 0;
      const prDays = prDaysByLoc.get(loc)?.size ?? 0;
      const allow = allowlistByLoc.get(loc) ?? { rows: 0, qty: 0 };
      summaries.push({
        location: loc,
        prRows,
        prDays,
        drRows: dr?.rows ?? 0,
        drDays: dr?.days.size ?? 0,
        latestDate: dr?.latestDate || null,
        latestSync: dr?.latestSync || null,
        allowlistRows: allow.rows,
        allowlistQty: allow.qty,
      });
    }
    summaries.sort((a, b) => a.location.localeCompare(b.location));

    console.log(
      `  ${rpad('LOCATION', 12)}${rpad('LATEST DR', 12)}${rpad('DR DAYS', 9)}${rpad('PR ROWS', 9)}${rpad('PR DAYS', 9)}${rpad('ALLOW ROWS', 11)}${rpad('ALLOW QTY', 10)}LATEST SYNC`,
    );
    for (const s of summaries) {
      console.log(
        `  ${rpad(s.location, 12)}${rpad(s.latestDate ?? '-', 12)}${lpad(`${s.drDays}/${days}`, 7)}  ${lpad(s.prRows, 7)}  ${lpad(`${s.prDays}/${days}`, 7)}  ${lpad(s.allowlistRows, 9)}  ${lpad(s.allowlistQty.toFixed(0), 8)}  ${(s.latestSync ?? '-').slice(0, 19)}`,
      );
    }

    // Centraal-specific verdict (the question that prompted this script)
    const cen = summaries.find((s) => s.location === 'centraal');
    console.log('');
    console.log('  → CENTRAAL VERDICT:');
    if (!cen || cen.prRows === 0) {
      console.log('     ✗ NO ProductRevenue rows for location=centraal in window.');
      console.log('       Check: profit-center discovery, label match, ledger config.');
    } else {
      console.log(`     ✓ ${cen.prRows} ProductRevenue rows over ${cen.prDays} of ${days} days.`);
      if (cen.allowlistRows === 0) {
        console.log(`     ✗ but 0 allowlist matches — products under "centraal" use names`);
        console.log(`       outside [${MEAL_PRODUCT_NAMES.join(', ')}].`);
        console.log(`       See section 6 below for what's actually being scraped.`);
      } else {
        console.log(
          `     ✓ ${cen.allowlistRows} allowlist matches summing to ${cen.allowlistQty.toFixed(0)} units.`,
        );
        console.log('       (these are the would-be lunch+dinner+staff guest counts.)');
      }
    }

    // ── Section 2: DailyRevenue, full table for window ──
    header(`2. DailyRevenue rows (${fromDate}+)`);
    if (drWindow.length === 0) {
      console.log('  (no rows)');
    } else {
      console.log(
        `  ${rpad('DATE', 12)}${rpad('LOCATION', 12)}${lpad('GROSS', 10)}  ${lpad('COVERS', 8)}  ${lpad('SALES', 8)}  ${lpad('INVOICES', 9)}  SYNCED`,
      );
      for (const r of drWindow) {
        console.log(
          `  ${rpad(r.date, 12)}${rpad(r.location, 12)}${lpad(r.grossRevenue.toFixed(2), 10)}  ${lpad(r.covers, 8)}  ${lpad(r.sales, 8)}  ${lpad(r.invoiceCount, 9)}  ${r.syncedAt.slice(0, 19)}`,
        );
      }
    }

    // ── Section 3: ProductRevenue per (location, service period) ──
    header(`3. ProductRevenue by service period`);
    if (prByLocMeal.length === 0) {
      console.log('  (no rows)');
    } else {
      console.log(
        `  ${rpad('LOCATION', 14)}${rpad('SERVICE PERIOD', 16)}${lpad('ROWS', 8)}  ${lpad('SUM(QTY)', 12)}`,
      );
      const sorted = [...prByLocMeal].sort(
        (a, b) => a.location.localeCompare(b.location) || a.meal.localeCompare(b.meal),
      );
      for (const r of sorted) {
        console.log(
          `  ${rpad(r.location, 14)}${rpad(r.meal, 16)}${lpad(r._count._all, 8)}  ${lpad((r._sum.quantity ?? 0).toFixed(0), 12)}`,
        );
      }
    }

    // ── Section 4: meal-product allowlist matches ──
    header(`4. Meal-product allowlist matches — would-be guest counts`);
    if (allowedRows.length === 0) {
      console.log('  ✗ NO MATCHES.');
      console.log(
        '    Either no rows scraped, or product names have drifted from the CSV-path allowlist.',
      );
      console.log('    Check section 5 below to see what product names exist.');
    } else {
      const byKey = new Map<
        string,
        { date: string; location: string; meal: string; qty: number; products: Set<string> }
      >();
      for (const r of allowedRows) {
        const key = `${r.date}|${r.location}|${r.meal}`;
        const existing = byKey.get(key);
        if (existing) {
          existing.qty += r.quantity;
          existing.products.add(r.productName);
        } else {
          byKey.set(key, {
            date: r.date,
            location: r.location,
            meal: r.meal,
            qty: r.quantity,
            products: new Set([r.productName]),
          });
        }
      }
      const rows = [...byKey.values()].sort(
        (a, b) =>
          b.date.localeCompare(a.date) ||
          a.location.localeCompare(b.location) ||
          a.meal.localeCompare(b.meal),
      );
      console.log(
        `  ${rpad('DATE', 12)}${rpad('LOCATION', 12)}${rpad('PERIOD', 12)}${lpad('GUESTS', 8)}  PRODUCTS`,
      );
      for (const r of rows) {
        console.log(
          `  ${rpad(r.date, 12)}${rpad(r.location, 12)}${rpad(r.meal, 12)}${lpad(r.qty.toFixed(0), 8)}  ${[...r.products].join(', ')}`,
        );
      }
    }

    // ── Section 5: top products per location (eyeball for renames) ──
    header(`5. Top 30 products per location by quantity`);
    const byLocation = new Map<string, typeof prByLocProd>();
    for (const r of prByLocProd) {
      if (!byLocation.has(r.location)) byLocation.set(r.location, []);
      byLocation.get(r.location)!.push(r);
    }
    const sortedLocs = [...byLocation.keys()].sort();
    for (const loc of sortedLocs) {
      console.log('');
      console.log(`  --- ${loc} ---`);
      const sorted = byLocation
        .get(loc)!
        .sort((a, b) => (b._sum.quantity ?? 0) - (a._sum.quantity ?? 0))
        .slice(0, 30);
      console.log(`  ${rpad('PRODUCT', 42)}${lpad('QTY', 10)}  ${lpad('ROWS', 6)}  ALLOWLIST?`);
      for (const r of sorted) {
        const inAllowlist = MEAL_PRODUCT_NAMES.includes(r.productName)
          ? '★ exact'
          : MEAL_PRODUCT_NAMES_LC.includes(r.productName.toLowerCase())
            ? '~ case-drift'
            : '';
        console.log(
          `  ${rpad(r.productName.slice(0, 42), 42)}${lpad((r._sum.quantity ?? 0).toFixed(0), 10)}  ${lpad(r._count._all, 6)}  ${inAllowlist}`,
        );
      }
    }

    // ── Section 6: sanity checks ──
    header('6. Sanity checks');
    const unknownDr = drWindow.filter((r) => r.location === 'unknown').length;
    const unknownPr = await prisma.productRevenue.count({
      where: { date: { gte: fromDate }, location: 'unknown' },
    });
    console.log(`  DailyRevenue rows with location='unknown' (window):    ${unknownDr}`);
    console.log(`  ProductRevenue rows with location='unknown' (window):  ${unknownPr}`);
    if (unknownDr > 0 || unknownPr > 0) {
      console.log(
        `  ⚠ profit-center discovery missed these — check the label match in discoverProfitCenters().`,
      );
    }

    const locStrings = distinctLocs.map((r) => r.location).sort();
    console.log(`  Distinct ProductRevenue locations: ${locStrings.join(', ') || '(none)'}`);
    const unexpected = locStrings.filter((l) => !EXPECTED_LOCATIONS.has(l));
    if (unexpected.length > 0) {
      console.log(`  ⚠ unexpected location strings: ${unexpected.join(', ')}`);
    }

    // All-time DR snapshot for context
    console.log('');
    console.log('  All-time DailyRevenue counts per location:');
    for (const r of drAll) {
      console.log(
        `    ${rpad(r.location, 12)} rows=${lpad(r._count._all, 6)}  latest=${r._max.date ?? '-'}  syncedAt=${(r._max.syncedAt ?? '-').slice(0, 19)}`,
      );
    }

    console.log('');
    console.log('Done.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
