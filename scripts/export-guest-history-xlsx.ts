/**
 * Export GuestHistory as an Excel-compatible XLSX file (pivot table per
 * day). Open in Excel / Google Sheets / Numbers.
 *
 * Output: guest-history.xlsx in the project root.
 *
 * Usage:
 *   npx tsx scripts/export-guest-history-xlsx.ts                 # all-time
 *   FROM=2026-01-01 npx tsx scripts/export-guest-history-xlsx.ts # custom start
 *   FROM=2026-03-01 TO=2026-04-30 npx tsx scripts/export-guest-history-xlsx.ts
 */

import { PrismaClient } from '@prisma/client';
// xlsx is already a dep in package.json (CDN-hosted 0.20.3).
import * as XLSX from 'xlsx';

async function main(): Promise<void> {
  const p = new PrismaClient();
  try {
    const fromEnv = process.env.FROM;
    const toEnv = process.env.TO;
    const where: { date?: { gte?: string; lte?: string } } = {};
    if (fromEnv || toEnv) where.date = {};
    if (fromEnv) where.date!.gte = fromEnv;
    if (toEnv) where.date!.lte = toEnv;

    const rows = await p.guestHistory.findMany({
      where,
      orderBy: [{ date: 'asc' }, { location: 'asc' }, { meal: 'asc' }],
    });

    if (rows.length === 0) {
      console.error('No GuestHistory rows in window. Adjust FROM / TO.');
      process.exit(1);
    }

    // Pivot: date → "<location> <meal>" → count
    const byDate = new Map<string, Record<string, number>>();
    const allColumnKeys = new Set<string>();
    for (const r of rows) {
      const key = `${r.location} ${r.meal}`;
      allColumnKeys.add(key);
      if (!byDate.has(r.date)) byDate.set(r.date, {});
      byDate.get(r.date)![key] = r.count;
    }

    // Stable column order: West first, then Centraal, then TestTafel,
    // then anything else; within each location, lunch / dinner / staff /
    // staff_lunch / staff_dinner.
    const LOC_ORDER = ['west', 'centraal', 'testtafel'];
    const MEAL_ORDER = ['lunch', 'dinner', 'staff', 'staff_lunch', 'staff_dinner'];
    const columnKeys = [...allColumnKeys].sort((a, b) => {
      const [aLoc, aMeal] = a.split(' ');
      const [bLoc, bMeal] = b.split(' ');
      const aLi = LOC_ORDER.indexOf(aLoc);
      const bLi = LOC_ORDER.indexOf(bLoc);
      if (aLi !== bLi) return (aLi === -1 ? 99 : aLi) - (bLi === -1 ? 99 : bLi);
      const aMi = MEAL_ORDER.indexOf(aMeal);
      const bMi = MEAL_ORDER.indexOf(bMeal);
      return (aMi === -1 ? 99 : aMi) - (bMi === -1 ? 99 : bMi);
    });

    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const dateList = [...byDate.keys()].sort();

    // Build the AoA (array of arrays) for the worksheet.
    const header = ['Date', 'Day', ...columnKeys.map((k) => k.replace(/^./, (c) => c.toUpperCase()))];
    const sheetRows: Array<Array<string | number | null>> = [header];
    for (const date of dateList) {
      const d = new Date(date + 'T12:00:00');
      const dow = dayNames[d.getDay()];
      const row: Array<string | number | null> = [date, dow];
      const dr = byDate.get(date)!;
      for (const key of columnKeys) {
        const v = dr[key];
        row.push(v == null ? null : v);
      }
      sheetRows.push(row);
    }

    // Add a totals row at the bottom
    const totals: Array<string | number | null> = ['Total', ''];
    for (const key of columnKeys) {
      let sum = 0;
      for (const date of dateList) {
        sum += byDate.get(date)![key] ?? 0;
      }
      totals.push(sum);
    }
    sheetRows.push([]);
    sheetRows.push(totals);

    const ws = XLSX.utils.aoa_to_sheet(sheetRows);

    // Reasonable column widths
    const colWidths = [
      { wch: 12 }, // Date
      { wch: 5 }, // Day
      ...columnKeys.map(() => ({ wch: 10 })),
    ];
    (ws as { '!cols'?: unknown })['!cols'] = colWidths;
    // Freeze the header row + Date+Day columns so the spreadsheet stays
    // readable when scrolled.
    (ws as { '!freeze'?: unknown })['!freeze'] = { xSplit: 2, ySplit: 1 };

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'GuestHistory');

    const outPath = `${process.cwd()}\\guest-history.xlsx`;
    XLSX.writeFile(wb, outPath);

    console.log(`Wrote ${outPath}`);
    console.log(`  Date range: ${dateList[0]} → ${dateList[dateList.length - 1]} (${dateList.length} dates)`);
    console.log(`  Columns:    ${columnKeys.join(', ')}`);
    console.log(`  Rows:       ${rows.length}`);
    console.log('');
    console.log('Open with:');
    console.log(`  start ${outPath}     (Windows — opens in default Excel/Numbers/etc.)`);
    console.log('  Or just double-click the file in File Explorer.');
  } finally {
    await p.$disconnect();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
