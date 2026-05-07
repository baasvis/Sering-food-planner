import { PrismaClient } from '@prisma/client';

async function main(): Promise<void> {
  const p = new PrismaClient();
  try {
    const drCount = await p.dailyRevenue.count();
    const drByLoc = await p.dailyRevenue.groupBy({
      by: ['location'],
      _count: { _all: true },
      _max: { date: true, syncedAt: true },
      _min: { date: true },
    });
    const prCount = await p.productRevenue.count();
    const prByLoc = await p.productRevenue.groupBy({
      by: ['location'],
      _count: { _all: true },
      _max: { date: true, syncedAt: true },
      _min: { date: true },
    });
    const ghCount = await p.guestHistory.count();
    const ghByLoc = await p.guestHistory.groupBy({
      by: ['location'],
      _count: { _all: true },
      _max: { date: true },
    });

    console.log('=== ALL-TIME ===');
    console.log(`DailyRevenue total rows: ${drCount}`);
    for (const r of drByLoc) {
      console.log(
        `  ${r.location.padEnd(12)} rows=${r._count._all}  range=${r._min.date}..${r._max.date}  latestSync=${(r._max.syncedAt ?? '').slice(0, 19)}`,
      );
    }
    console.log('');
    console.log(`ProductRevenue total rows: ${prCount}`);
    for (const r of prByLoc) {
      console.log(
        `  ${r.location.padEnd(12)} rows=${r._count._all}  range=${r._min.date}..${r._max.date}`,
      );
    }
    console.log('');
    console.log(`GuestHistory total rows: ${ghCount}`);
    for (const r of ghByLoc) {
      console.log(`  ${r.location.padEnd(12)} rows=${r._count._all}  latestDate=${r._max.date}`);
    }
  } finally {
    await p.$disconnect();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
