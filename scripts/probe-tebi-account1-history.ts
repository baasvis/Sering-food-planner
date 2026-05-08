/**
 * Probe Account #1 (info@testtafel.nl, ledger 723192) historical data on
 * its centraal + testtafel PCs. Goal: find out if the 2026-03-22 →
 * 2026-04-09 gap (between user's last CSV upload and the new account
 * coming online) is recoverable from Account 1's old PCs.
 *
 * Usage: TEBI_BEARER_TOKEN_1='eyJ...' npx tsx scripts/probe-tebi-account1-history.ts
 */

const TOKEN = process.env.TEBI_BEARER_TOKEN_1;
if (!TOKEN) {
  console.error('TEBI_BEARER_TOKEN_1 not set');
  process.exit(1);
}

const BASE = 'https://live.tebi.co';
const LEDGER = '723192';
// Account 1 PCs (different UUIDs from Account 2 — UUIDs scope per ledger).
const PC_WEST = '00000000-0000-0000-0000-000000000000';
const PC_CENTRAAL = '27c33042-47c1-4650-8e76-37c7bfef86dd';
const PC_TESTTAFEL = 'a904a975-6bd2-413f-8e02-dc457b87a6e3';

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

async function fetchProductTopRange(start: string, end: string, pcUuid: string): Promise<PcSummary | null> {
  const filter = encodeURIComponent(JSON.stringify({ grouping: 'PROFIT_CENTER', value: pcUuid }));
  const url = `${BASE}/api/insights/ledgers/${LEDGER}/insights/data/charts/product_top?startDate=${start}&endDate=${end}&mock=false&limit=-1&filter=${filter}`;
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

async function main(): Promise<void> {
  console.log('Account #1 (info@testtafel.nl, ledger 723192) historical probe');
  console.log(`  West      = ${PC_WEST}`);
  console.log(`  Centraal  = ${PC_CENTRAAL}`);
  console.log(`  TestTafel = ${PC_TESTTAFEL}`);
  console.log('');

  // 26 weekly chunks back from today
  const probes: Array<[string, string]> = [];
  const today = new Date();
  for (let weeksBack = 0; weeksBack < 26; weeksBack++) {
    const end = new Date(today);
    end.setDate(today.getDate() - weeksBack * 7);
    const start = new Date(end);
    start.setDate(end.getDate() - 7);
    const fmt = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    probes.push([fmt(start), fmt(end)]);
  }

  console.log(
    `${'WEEK START'.padEnd(13)} ${'WEEK END'.padEnd(13)} ${'West'.padStart(20)} ${'Centraal'.padStart(20)} ${'TestTafel'.padStart(20)}`,
  );
  for (const [start, end] of probes) {
    const [w, c, t] = await Promise.all([
      fetchProductTopRange(start, end, PC_WEST),
      fetchProductTopRange(start, end, PC_CENTRAAL),
      fetchProductTopRange(start, end, PC_TESTTAFEL),
    ]);
    const fmtSummary = (s: PcSummary | null) =>
      s ? `qty=${s.totalQty} €${s.totalGross.toFixed(0)} (${s.itemCount}i)` : 'fetch err';
    console.log(
      `${start.padEnd(13)} ${end.padEnd(13)} ${fmtSummary(w).padStart(20)} ${fmtSummary(c).padStart(20)} ${fmtSummary(t).padStart(20)}`,
    );
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
