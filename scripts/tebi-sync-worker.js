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
async function saveResults(date, summary, productRows) {
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

  return written;
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

  let rowsWritten = 0;
  try {
    for (const date of dates) {
      log(`[${label}] Fetching ${date}...`);
      const apiEndDate = nextDay(date);
      try {
        const { summary, productRows } = await runForAccount(accountConfig, page, date, apiEndDate);
        const wrote = await saveResults(date, summary, productRows);
        rowsWritten += wrote;
        log(`[${label}] Saved ${date} (${wrote} rows)`);
      } catch (e) {
        // Log but continue to next date — one failed day doesn't abort the whole sync
        err(`[${label}] Failed for ${date}: ${e.message}`);
      }
    }
    log(`${label} complete (${rowsWritten} rows written)`);
  } finally {
    await browser.close();
  }
  return rowsWritten;
}

async function main() {
  const startDate = process.argv[2];
  const endDate = process.argv[3] || startDate;

  if (!startDate) {
    err('Usage: node tebi-sync-worker.js <startDate> [endDate]');
    process.exit(1);
  }

  // Build list of ledgers to scrape — same credentials, different ledger IDs
  const accounts = [];

  if (process.env.TEBI_EMAIL && process.env.TEBI_PASSWORD) {
    const email = process.env.TEBI_EMAIL;
    const password = process.env.TEBI_PASSWORD;

    accounts.push({
      label: 'Ledger 1 (De_Sering/West)',
      email,
      password,
      ledgerId: process.env.TEBI_LEDGER_ID || '723192',
      forceLocation: process.env.TEBI_FORCE_LOCATION || null,
    });

    if (process.env.TEBI_LEDGER_ID_2) {
      accounts.push({
        label: 'Ledger 2 (TestTafel + Centraal)',
        email,
        password,
        ledgerId: process.env.TEBI_LEDGER_ID_2,
        forceLocation: null,
      });
    }
  }

  if (accounts.length === 0) {
    err('No Tebi credentials configured. Set TEBI_EMAIL + TEBI_PASSWORD (and optionally TEBI_EMAIL_2 + TEBI_PASSWORD_2).');
    process.exit(1);
  }

  log(`Syncing ${startDate} to ${endDate} across ${accounts.length} account(s)`);
  const dates = dateRange(startDate, endDate);

  let totalRowsWritten = 0;
  let failedAccounts = 0;

  // Run accounts sequentially — avoids browser resource contention
  for (const account of accounts) {
    try {
      totalRowsWritten += await runAccount(account, dates);
    } catch (e) {
      // One account failing doesn't abort the other, but record it so we can
      // exit non-zero if every account died.
      failedAccounts++;
      err(`${account.label} failed entirely: ${e.message}\n${e.stack || ''}`);
    }
  }

  log(`All accounts synced (${totalRowsWritten} rows written across ${accounts.length} account(s), ${failedAccounts} failed)`);

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
}

main().catch(e => {
  err(e.message);
  process.exit(1);
}).finally(() => prisma.$disconnect());
