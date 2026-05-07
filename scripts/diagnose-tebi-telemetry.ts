import { PrismaClient } from '@prisma/client';

async function main(): Promise<void> {
  const p = new PrismaClient();
  try {
    const since = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000); // 60 days
    const events = await p.telemetryEvent.findMany({
      where: {
        timestamp: { gte: since },
        OR: [
          { name: 'finance_sync_complete' },
          { name: 'finance_sync_failed' },
          { name: 'finance_sync_spawn_error' },
          { name: 'finance_sync_cancelled' },
        ],
      },
      orderBy: { timestamp: 'desc' },
      take: 60,
    });

    console.log(`=== Recent finance_sync_* telemetry (${events.length} events, last 60d) ===`);
    for (const e of events) {
      const d = (e.data as Record<string, unknown> | null) ?? {};
      const code = d.code ?? '-';
      const dur = d.durationMs ?? '-';
      const src = d.source ?? '-';
      const start = d.start ?? '-';
      const end = d.end ?? '-';
      console.log(
        `${e.timestamp.toISOString().slice(0, 19)}  ${e.name.padEnd(28)} src=${src} code=${code} dur=${dur}ms range=${start}..${end}`,
      );
      if (typeof d.stderrTail === 'string' && d.stderrTail.length > 0) {
        console.log(`  --- stderr tail ---`);
        console.log(
          d.stderrTail
            .split('\n')
            .slice(-30)
            .map((l: string) => `  ${l}`)
            .join('\n'),
        );
      }
      if (typeof d.stdoutTail === 'string' && d.stdoutTail.length > 0) {
        console.log(`  --- stdout tail ---`);
        console.log(
          d.stdoutTail
            .split('\n')
            .slice(-30)
            .map((l: string) => `  ${l}`)
            .join('\n'),
        );
      }
    }
  } finally {
    await p.$disconnect();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
