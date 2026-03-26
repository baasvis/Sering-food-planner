#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Tebi Sync Worker — runs the scraper and writes results to PostgreSQL
//
// Called as a child process from routes/finance.js
// Usage: node scripts/tebi-sync-worker.js <startDate> [endDate]
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { chromium } = require('playwright');

const prisma = new PrismaClient();

const TEBI_BASE = 'https://live.tebi.co';
const LEDGER_ID = process.env.TEBI_LEDGER_ID || '723192';

// Reuse scraper functions
const {
  login, fetchTebiAPI, fetchDayData, formatResults, formatProductRevenue,
  PROFIT_CENTERS, CHART_TYPES,
} = require('./tebi-scraper');

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
      err(`  Failed to upsert product: ${row.productName}: ${e.message}`);
    }
  }

  return count;
}

async function main() {
  const startDate = process.argv[2];
  const endDate = process.argv[3] || startDate;

  if (!startDate) {
    err('Usage: node tebi-sync-worker.js <startDate> [endDate]');
    process.exit(1);
  }

  log(`Syncing ${startDate} to ${endDate}`);

  const browser = await chromium.launch({
    headless: true,
    executablePath: chromium.executablePath(),
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await login(page);

    // Navigate to dashboard to establish context
    await page.goto(`${TEBI_BASE}/backoffice/ledgers/${LEDGER_ID}/dashboard`, {
      waitUntil: 'networkidle',
      timeout: 30000,
    });
    await page.waitForTimeout(3000);

    // Fetch data for each date
    const dates = dateRange(startDate, endDate);
    for (const date of dates) {
      log(`Fetching ${date}...`);
      const apiEndDate = nextDay(date);
      const rawData = await fetchDayData(page, date, apiEndDate);
      const summary = formatResults(rawData, date);

      // Upsert "all" row (totals)
      await upsertRevenue(date, 'all', {
        grossRevenue: summary.grossRevenue,
        netRevenue: summary.netRevenue,
        sales: summary.sales,
        covers: summary.covers,
        invoiceCount: summary.invoiceCount,
      });

      // Upsert per-location rows
      for (const [loc, data] of Object.entries(summary.locations)) {
        if (loc === 'all') continue;
        await upsertRevenue(date, loc, {
          grossRevenue: data.grossRevenue || 0,
          netRevenue: data.netRevenue || 0,
          sales: 0,
          covers: 0,
          invoiceCount: 0,
        });
      }

      // Upsert product-level revenue from invoice line items
      const productRows = formatProductRevenue(rawData.invoices, PROFIT_CENTERS);
      if (productRows.length > 0) {
        const prodCount = await upsertProductRevenue(productRows);
        log(`  Saved ${prodCount} product revenue rows for ${date}`);
      }

      log(`  Saved ${date}`);
    }

    log('Sync complete!');
  } catch (e) {
    err(e.message);
    await page.screenshot({ path: 'tebi-sync-error.png' }).catch(() => {});
    process.exit(1);
  } finally {
    await browser.close();
    await prisma.$disconnect();
  }
}

main();
