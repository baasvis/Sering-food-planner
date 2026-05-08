/**
 * Probe to find when each Tebi setup started having data.
 *
 * Goal: identify the switchover date so we know what range to backfill.
 *  - Account 2 (facturen@testtafel.nl, ledger 724466): has TestTafel +
 *    Centraal as PCs. Probe going back to find earliest date with data.
 *
 * Usage: TEBI_BEARER_TOKEN_2='eyJ...' npx tsx scripts/probe-tebi-history.ts
 */

const TOKEN = process.env.TEBI_BEARER_TOKEN_2;
if (!TOKEN) {
  console.error('TEBI_BEARER_TOKEN_2 not set');
  process.exit(1);
}

const BASE = 'https://live.tebi.co';
const LEDGER = '724466';
const PC_TESTTAFEL = '00000000-0000-0000-0000-000000000000';
const PC_CENTRAAL = '85194418-ab36-49a0-8161-9ae3a64576ba';

const headers = {
  authorization: `Bearer ${TOKEN}`,
  accept: '*/*',
  'tebi-version-code': '1722000',
};

interface PcSummary {
  totalQty: number;
  totalGross: number;
  itemCount: number;
}

async function fetchProductTopRange(
  startDate: string,
  endDate: string,
  pcUuid: string,
): Promise<PcSummary | null> {
  const filter = encodeURIComponent(JSON.stringify({ grouping: 'PROFIT_CENTER', value: pcUuid }));
  const url = `${BASE}/api/insights/ledgers/${LEDGER}/insights/data/charts/product_top?startDate=${startDate}&endDate=${endDate}&mock=false&limit=-1&filter=${filter}`;
  const r = await fetch(url, { headers });
  if (!r.ok) return null;
  const body = (await r.json()) as { data?: Array<Record<string, unknown>> };
  if (!Array.isArray(body.data)) return null;
  let totalQty = 0;
  let totalGross = 0;
  for (const entry of body.data) {
    const metrics = entry.metrics as Array<Record<string, unknown>> | undefined;
    const qtyMetric = metrics?.find((m) => m.name === 'TOTAL_PRODUCTS_SOLD');
    const grossMetric = metrics?.find((m) => m.name === 'GROSS_REVENUE');
    if (qtyMetric) totalQty += parseFloat(String(qtyMetric.value)) || 0;
    if (grossMetric && typeof grossMetric.value === 'object') {
      totalGross += parseFloat((grossMetric.value as { quantity: string }).quantity) || 0;
    }
  }
  return { totalQty, totalGross, itemCount: body.data.length };
}

function nextDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const nx = new Date(y, m - 1, d + 1);
  return `${nx.getFullYear()}-${String(nx.getMonth() + 1).padStart(2, '0')}-${String(nx.getDate()).padStart(2, '0')}`;
}

async function main(): Promise<void> {
  // Probe in chunks: 1-week aggregates, going back from today to mid-2025.
  // Cheap (one API call per chunk per PC). Once we find the boundary, we can
  // narrow down to a specific day.

  const probes: Array<[string, string]> = [];
  // 14-week probes back from today
  const today = new Date();
  for (let weeksBack = 0; weeksBack < 26; weeksBack++) {
    const end = new Date(today);
    end.setDate(today.getDate() - weeksBack * 7);
    const start = new Date(end);
    start.setDate(end.getDate() - 7);
    const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    probes.push([fmt(start), fmt(end)]);
  }

  console.log(`Probing ${probes.length} weekly chunks for ledger 724466 PCs:`);
  console.log(`  TestTafel = ${PC_TESTTAFEL}`);
  console.log(`  Centraal  = ${PC_CENTRAAL}`);
  console.log('');

  console.log(`${'WEEK START'.padEnd(13)} ${'WEEK END'.padEnd(13)} ${'TestTafel'.padStart(20)} ${'Centraal'.padStart(20)}`);
  for (const [start, end] of probes) {
    const [tt, cn] = await Promise.all([
      fetchProductTopRange(start, end, PC_TESTTAFEL),
      fetchProductTopRange(start, end, PC_CENTRAAL),
    ]);
    const ttStr = tt ? `qty=${tt.totalQty} €${tt.totalGross.toFixed(0)} (${tt.itemCount} items)` : 'fetch err';
    const cnStr = cn ? `qty=${cn.totalQty} €${cn.totalGross.toFixed(0)} (${cn.itemCount} items)` : 'fetch err';
    console.log(`${start.padEnd(13)} ${end.padEnd(13)} ${ttStr.padStart(20)} ${cnStr.padStart(20)}`);
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
