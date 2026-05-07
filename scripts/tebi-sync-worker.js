#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Tebi Sync Worker — runs the scraper for all configured accounts and writes
// results to PostgreSQL.
//
// One Tebi account can access multiple ledgers. Ledger 1 is always scraped;
// set TEBI_LEDGER_ID_2 to also scrape a second ledger (e.g. TestTafel + Centraal).
//   Required: TEBI_EMAIL + TEBI_PASSWORD
//   Ledger 1: TEBI_LEDGER_ID (default 723192 = De_Sering/West)
//   Ledger 2: TEBI_LEDGER_ID_2 (e.g. 724466 = TestTafel + Centraal, optional)
//   Optional: TEBI_FORCE_LOCATION=west to bypass profit center lookup on Ledger 1
//
// Usage: node scripts/tebi-sync-worker.js <startDate> [endDate]
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { chromium } = require('playwright');
const { runForAccount } = require('./tebi-scraper');

const prisma = new PrismaClient();

function log(msg) { console.log(`[sync] ${msg}`); }
function err(msg) { console.error(`[sync] ERROR: ${msg}`); }

function nextDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d + 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function dateRange(start, end) {
  const dates = [];
  let current = start;
  while (current <= end) {
    dates.push(current);
    current = nextDay(current);
  }
  return dates;
}

async function upsertRevenue(date, location, data) {
  const now = new Date().toISOString();
  await prisma.dailyRevenue.upsert({
    where: { date_location: { date, location } },
    update: {
      grossRevenue: data.grossRevenue || 0,
      netRevenue: data.netRevenue || 0,
      sales: data.sales || 0,
      covers: data.covers || 0,
      invoiceCount: data.invoiceCount || 0,
      syncedAt: now,
    },
    create: {
      date,
      location,
      grossRevenue: data.grossRevenue || 0,
      netRevenue: data.netRevenue || 0,
      sales: data.sales || 0,
      covers: data.covers || 0,
      invoiceCount: data.invoiceCount || 0,
      syncedAt: now,
    },
  });
}

async function upsertProductRevenue(rows) {
  if (!rows || rows.length === 0) return 0;
  const now = new Date().toISOString();
  let count = 0;
  for (const row of rows) {
    if (!row.date || !row.productName) continue;
    try {
      await prisma.productRevenue.upsert({
        where: {
          date_location_meal_productName: {
            date: row.date,
            location: row.location || 'unknown',
            meal: row.meal || 'other',
            productName: row.productName,
          },
        },
        update: {
          productCategory: row.productCategory || '',
          quantity: row.quantity || 0,
          grossRevenue: row.grossRevenue || 0,
          netRevenue: row.netRevenue || 0,
          syncedAt: now,
        },
        create: {
          date: row.date,
          location: row.location || 'unknown',
          meal: row.meal || 'other',
          productName: row.productName,
          productCategory: row.productCategory || '',
          quantity: row.quantity || 0,
          grossRevenue: row.grossRevenue || 0,
          netRevenue: row.netRevenue || 0,
          syncedAt: now,
        },
      });
      count++;
    } catch (e) {
      err(`  Failed to upsert product ${row.productName}: ${e.message}`);
    }
  }
  return count;
}

// Save results from one account run for a single date.
// Returns the number of rows actually written so the caller can detect a
// "completed but did nothing" run.
async function saveResults(date, summary, productRows, guestCounts) {
  let written = 0;

  // 'all' row — only written by Account 1 (West) to avoid double-counting totals
  if (summary.grossRevenue != null) {
    await upsertRevenue(date, 'all', {
      grossRevenue: summary.grossRevenue,
      netRevenue: summary.netRevenue,
      sales: summary.sales,
      covers: summary.covers,
      invoiceCount: summary.invoiceCount,
    });
    written++;
  }

  // Per-location rows from profit center data
  for (const [loc, data] of Object.entries(summary.locations || {})) {
    if (loc === 'all') continue;
    await upsertRevenue(date, loc, {
      grossRevenue: data.grossRevenue || 0,
      netRevenue: data.netRevenue || 0,
      sales: 0,
      covers: 0,
      invoiceCount: 0,
    });
    written++;
  }

  // Product-level rows
  if (productRows && productRows.length > 0) {
    const count = await upsertProductRevenue(productRows);
    log(`  Saved ${count} product rows for ${date}`);
    written += count;
  }

  // Guest counts — derived from product_top items (see tebi-scraper.js
  // `deriveGuestCountsFromProductRows`). Writing here means the food-planner
  // dashboard's GuestHistory now updates automatically every cron tick;
  // users no longer need to drag-drop CSV exports from Tebi.
  if (guestCounts && typeof guestCounts === 'object') {
    const guestRows = await upsertGuestHistory(date, guestCounts);
    if (guestRows > 0) {
      log(`  Saved ${guestRows} guest-history rows for ${date}`);
      written += guestRows;
    }
  }

  return written;
}

// Upsert per-meal guest counts for a given date. `guestCountsByLoc` shape:
//   { [locationName]: { lunch, dinner, staff, staff_lunch, staff_dinner } }
// Only locations and meals with non-zero counts are written; zero rows
// would just clutter the table without changing the planner UI's display.
//
// Always writes (overwrites) — the auto-update is treated as authoritative
// for the dates it covers. If the user manually edits a count in the UI
// after the cron runs, the next cron run will overwrite it. We accept that
// tradeoff to keep behavior predictable; the CSV-upload path has the same
// overwrite semantics today.
async function upsertGuestHistory(date, guestCountsByLoc) {
  let count = 0;
  const MEAL_FIELDS = ['lunch', 'dinner', 'staff', 'staff_lunch', 'staff_dinner'];
  for (const [location, counts] of Object.entries(guestCountsByLoc)) {
    if (!counts || typeof counts !== 'object') continue;
    for (const meal of MEAL_FIELDS) {
      const value = parseInt(counts[meal] ?? 0, 10) || 0;
      if (value <= 0) continue; // skip zero rows
      try {
        await prisma.guestHistory.upsert({
          where: { location_meal_date: { location, meal, date } },
          update: { count: value },
          create: { location, meal, date, count: value },
        });
        count++;
      } catch (e) {
        err(`  Failed to upsert guest_history ${date}/${location}/${meal}: ${e.message}`);
      }
    }
  }
  return count;
}

async function runAccount(accountConfig, dates) {
  const { label } = accountConfig;
  log(`Starting ${label}...`);

  // chromium.launch() failures (missing browser binary on Railway, missing
  // system libraries) used to throw out of runAccount and get swallowed by
  // main()'s try/catch — letting the worker exit 0 with no rows written.
  // Surface them clearly in stderr so the parent helper's stderrTail
  // captures the real cause.
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  } catch (e) {
    err(`[${label}] chromium.launch failed: ${e.message}`);
    throw e;
  }
  const context = await browser.newContext();
  const page = await context.newPage();

  // Track WHAT shape of rows reached the DB, not just a count. This is what
  // distinguishes "scraper healthy" from "scraper writing only ledger-totals".
  // Without this breakdown the cron exits 0 the moment any row at all writes,
  // which let the silent partial-failure go unnoticed for ~7 weeks.
  const stats = { allRows: 0, perLocationRows: 0, productRows: 0, guestRows: 0, failedDates: 0 };
  try {
    for (const date of dates) {
      log(`[${label}] Fetching ${date}...`);
      const apiEndDate = nextDay(date);
      try {
        const { summary, productRows, guestCounts } = await runForAccount(accountConfig, page, date, apiEndDate);
        const allRowExpected = summary.grossRevenue != null ? 1 : 0;
        const perLocCount = Object.keys(summary.locations || {}).filter((k) => k !== 'all').length;
        const productCount = (productRows || []).length;
        // Count expected guest-history rows: only non-zero meal entries get
        // written, but for the stats accounting we count populated meals
        // across all locations. This is just a visibility metric — exit
        // logic does not depend on it.
        let guestRowCount = 0;
        for (const [, c] of Object.entries(guestCounts || {})) {
          for (const meal of ['lunch', 'dinner', 'staff', 'staff_lunch', 'staff_dinner']) {
            if ((parseInt(c?.[meal] ?? 0, 10) || 0) > 0) guestRowCount++;
          }
        }
        const wrote = await saveResults(date, summary, productRows, guestCounts);
        stats.allRows += allRowExpected;
        stats.perLocationRows += perLocCount;
        stats.productRows += productCount;
        stats.guestRows += guestRowCount;
        log(`[${label}] Saved ${date} (${wrote} rows: all=${allRowExpected} perLoc=${perLocCount} products=${productCount} guests=${guestRowCount})`);
      } catch (e) {
        stats.failedDates += 1;
        err(`[${label}] Failed for ${date}: ${e.message}`);
      }
    }
    log(`${label} complete (all=${stats.allRows} perLoc=${stats.perLocationRows} products=${stats.productRows} guests=${stats.guestRows} failedDates=${stats.failedDates})`);
  } finally {
    await browser.close();
  }
  return stats;
}

async function main() {
  const startDate = process.argv[2];
  const endDate = process.argv[3] || startDate;

  if (!startDate) {
    err('Usage: node tebi-sync-worker.js <startDate> [endDate]');
    process.exit(1);
  }

  // Build list of ledgers to scrape.
  //
  // Two-account layout (current as of 2026-04-26):
  //   Ledger 1 (Sering West, default 723192) — TEBI_EMAIL  / TEBI_PASSWORD
  //   Ledger 2 (TestTafel + Centraal, 724466) — TEBI_EMAIL_2 / TEBI_PASSWORD_2
  //
  // For backward compatibility with the original single-account setup, if
  // TEBI_LEDGER_ID_2 is set but the _2 credentials are not, fall back to
  // the primary credentials. This keeps existing single-account
  // installations working without env-var churn.
  const accounts = [];

  if (process.env.TEBI_EMAIL && process.env.TEBI_PASSWORD) {
    accounts.push({
      label: 'Ledger 1 (De_Sering/West)',
      email: process.env.TEBI_EMAIL,
      password: process.env.TEBI_PASSWORD,
      ledgerId: process.env.TEBI_LEDGER_ID || '723192',
      forceLocation: process.env.TEBI_FORCE_LOCATION || null,
    });

    if (process.env.TEBI_LEDGER_ID_2) {
      const email2 = process.env.TEBI_EMAIL_2 || process.env.TEBI_EMAIL;
      const pass2 = process.env.TEBI_PASSWORD_2 || process.env.TEBI_PASSWORD;
      const usingFallback = !process.env.TEBI_EMAIL_2 || !process.env.TEBI_PASSWORD_2;
      accounts.push({
        label: usingFallback
          ? 'Ledger 2 (TestTafel + Centraal) [fallback creds]'
          : 'Ledger 2 (TestTafel + Centraal)',
        email: email2,
        password: pass2,
        ledgerId: process.env.TEBI_LEDGER_ID_2,
        forceLocation: null,
      });
      if (usingFallback) {
        log('Ledger 2 is using primary TEBI_EMAIL/PASSWORD as fallback. Set TEBI_EMAIL_2 + TEBI_PASSWORD_2 if Ledger 2 has its own account.');
      }
    }
  }

  if (accounts.length === 0) {
    err('No Tebi credentials configured. Set TEBI_EMAIL + TEBI_PASSWORD (and optionally TEBI_EMAIL_2 + TEBI_PASSWORD_2 for the second account).');
    process.exit(1);
  }

  log(`Syncing ${startDate} to ${endDate} across ${accounts.length} account(s)`);
  const dates = dateRange(startDate, endDate);

  const totals = { allRows: 0, perLocationRows: 0, productRows: 0, guestRows: 0, failedDates: 0 };
  let failedAccounts = 0;

  // Run accounts sequentially — avoids browser resource contention
  for (const account of accounts) {
    try {
      const stats = await runAccount(account, dates);
      totals.allRows += stats.allRows;
      totals.perLocationRows += stats.perLocationRows;
      totals.productRows += stats.productRows;
      totals.guestRows += stats.guestRows;
      totals.failedDates += stats.failedDates;
    } catch (e) {
      // One account failing doesn't abort the other, but record it so we can
      // exit non-zero if every account died.
      failedAccounts++;
      err(`${account.label} failed entirely: ${e.message}\n${e.stack || ''}`);
    }
  }

  const totalRowsWritten = totals.allRows + totals.perLocationRows + totals.productRows + totals.guestRows;
  log(`All accounts synced (allRows=${totals.allRows} perLocationRows=${totals.perLocationRows} productRows=${totals.productRows} guestRows=${totals.guestRows} failedDates=${totals.failedDates}, ${failedAccounts}/${accounts.length} accounts failed entirely)`);

  // The worker used to exit 0 even when zero rows had been written, because
  // every per-date and per-account failure was caught and logged. That made
  // observability lie: routes/finance.ts saw exit code 0, emitted a
  // `finance_sync_complete` event, and the actual breakage stayed silent for
  // 31 days. If the run accomplished nothing, exit non-zero so the parent
  // helper's stderrTail captures the cause.
  if (totalRowsWritten === 0) {
    err('No rows were written for any account/date — treating as failure.');
    process.exit(1);
  }
  if (failedAccounts === accounts.length) {
    err('Every account failed — treating as failure.');
    process.exit(1);
  }
  // Detect the silent-partial-failure mode that hid the breakage for 7 weeks:
  // ledger-aggregate ('all') rows reached the DB but per-location and product
  // scraping silently returned empty across every account/date. If even a
  // single 'all' row succeeded then auth + the overview chart endpoint work,
  // so it's not a top-level outage — but the per-profit-center and invoicing
  // endpoints have drifted and need attention.
  if (totals.allRows > 0 && totals.perLocationRows === 0 && totals.productRows === 0) {
    err('Wrote ledger-aggregate rows but ZERO per-location and ZERO product rows across all accounts — per-profit-center and/or invoicing scraping is broken. Treating as failure.');
    process.exit(1);
  }
}

main().catch(e => {
  err(e.message);
  process.exit(1);
}).finally(() => prisma.$disconnect());
