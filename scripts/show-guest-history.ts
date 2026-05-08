/**
 * Pretty-print GuestHistory as a per-date pivot table:
 *   DATE         | West lunch / dinner | Centraal lunch / dinner / staff | TestTafel dinner
 *
 * Usage:
 *   npx tsx scripts/show-guest-history.ts                 # last 60 days
 *   FROM=2026-03-01 npx tsx scripts/show-guest-history.ts # custom start
 */

import { PrismaClient } from '@prisma/client';

async function main(): Promise<void> {
  const p = new PrismaClient();
  try {
    const fromEnv = process.env.FROM;
    let from: string;
    if (fromEnv) {
      from = fromEnv;
    } else {
      const d = new Date();
      d.setDate(d.getDate() - 60);
      from = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    const rows = await p.guestHistory.findMany({
      where: { date: { gte: from } },
      orderBy: [{ date: 'desc' }, { location: 'asc' }, { meal: 'asc' }],
    });

    // Pivot: date → location → meal → count
    const byDate = new Map<string, Record<string, Record<string, number>>>();
    for (const r of rows) {
      if (!byDate.has(r.date)) byDate.set(r.date, {});
      const dateRec = byDate.get(r.date)!;
      if (!dateRec[r.location]) dateRec[r.location] = {};
      dateRec[r.location][r.meal] = r.count;
    }

    const dateList = [...byDate.keys()].sort().reverse();

    console.log(`GuestHistory (from ${from}, ${dateList.length} days)`);
    console.log('');
    console.log(
      `${'DATE'.padEnd(12)} ${'DOW'.padEnd(4)} | ${'W lunch'.padStart(7)} ${'W dinner'.padStart(8)} ${'W staff'.padStart(7)} | ${'C lunch'.padStart(7)} ${'C dinner'.padStart(8)} ${'C staff'.padStart(7)} | ${'TT dinner'.padStart(9)}`,
    );
    console.log('-'.repeat(110));

    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    let weekTotalsW = { lunch: 0, dinner: 0 };
    let weekTotalsC = { lunch: 0, dinner: 0 };
    let lastWeek = -1;

    for (const date of dateList) {
      const d = new Date(date + 'T12:00:00');
      const dow = dayNames[d.getDay()];

      // Insert a divider when crossing a week boundary (running newest first → Sunday boundary)
      const week = (() => {
        const tmp = new Date(d);
        tmp.setDate(tmp.getDate() - tmp.getDay());
        return tmp.getTime();
      })();
      if (lastWeek !== -1 && week !== lastWeek) {
        console.log('-'.repeat(110));
      }
      lastWeek = week;

      const dateRec = byDate.get(date) || {};
      const w = dateRec['west'] || {};
      const c = dateRec['centraal'] || {};
      const tt = dateRec['testtafel'] || {};

      const wL = w['lunch'] ?? 0;
      const wD = w['dinner'] ?? 0;
      const wS = w['staff'] ?? 0;
      const cL = c['lunch'] ?? 0;
      const cD = c['dinner'] ?? 0;
      const cS = c['staff'] ?? 0;
      const ttD = tt['dinner'] ?? 0;

      weekTotalsW.lunch += wL;
      weekTotalsW.dinner += wD;
      weekTotalsC.lunch += cL;
      weekTotalsC.dinner += cD;

      const fmt = (n: number) => (n === 0 ? '·' : String(n));
      console.log(
        `${date.padEnd(12)} ${dow.padEnd(4)} | ${fmt(wL).padStart(7)} ${fmt(wD).padStart(8)} ${fmt(wS).padStart(7)} | ${fmt(cL).padStart(7)} ${fmt(cD).padStart(8)} ${fmt(cS).padStart(7)} | ${fmt(ttD).padStart(9)}`,
      );
    }

    console.log('');
    console.log('Legend:');
    console.log('  · = no row in DB (kitchen closed, or not yet captured)');
    console.log('  W lunch / W dinner: West guests');
    console.log('  C lunch / C dinner / C staff: Sering Centraal community kitchen');
    console.log('  TT dinner: TestTafel (Single TestTafel Menu) guests on the upscale dinner nights');
    console.log('');
    console.log(`Total rows in window: ${rows.length}`);

    // Per-location summary
    const totalByLoc: Record<string, number> = {};
    for (const r of rows) {
      totalByLoc[r.location] = (totalByLoc[r.location] || 0) + r.count;
    }
    console.log('');
    console.log('Total guests in window:');
    for (const [loc, total] of Object.entries(totalByLoc).sort()) {
      console.log(`  ${loc.padEnd(12)} ${total}`);
    }
  } finally {
    await p.$disconnect();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
