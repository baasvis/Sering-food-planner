/**
 * Backfill GuestHistoryMeta.flowDistribution from Tebi invoice timestamps.
 *
 * The dashboard's "guest flow chart" reads `flowDistribution` — normalised
 * per-5-minute arrival fractions per (location, meal, day-of-week) — and
 * draws a curve over the service window. Without this populated, the chart
 * falls back to a generic gaussian.
 *
 * What this does:
 *   1. For each date in [START, END]:
 *      - Fetch the invoice list from each configured ledger × PC (filtered
 *        per PC via the JSON-encoded filter param).
 *      - For each invoice, extract its created-time and classify:
 *           location = PC name, OR centraal if PC=testtafel and time<18:00
 *                      (TestTafel only operates 18:00+, so anything earlier
 *                       there is a misattributed Centraal sale).
 *           meal     = lunch (12:00-14:00) or dinner (18:00-21:00). Other
 *                      times are skipped — flow chart only covers meal
 *                      service periods.
 *   2. Group all time events by (location, meal, day-of-week) and bin to
 *      5-minute buckets.
 *   3. Normalise each (location, meal, day-of-week) so its bucket fractions
 *      sum to 1.
 *   4. Upsert into GuestHistoryMeta with key='flowDistribution'.
 *
 * Two-token mode lets the script combine events from BOTH Tebi accounts in
 * one run, which is necessary because flow distribution is a global merge —
 * if you ran ledger 1 then ledger 2 in two separate writes, the second
 * write would clobber the first.
 *
 * Usage:
 *   TEBI_BEARER_TOKEN_1='eyJ...' TEBI_LEDGER_ID_1=723192 \
 *   TEBI_BEARER_TOKEN_2='eyJ...' TEBI_LEDGER_ID_2=724466 \
 *   FLOW_START=2026-03-01 FLOW_END=2026-05-08 \
 *   npx tsx scripts/backfill-tebi-flow.ts [--dry-run]
 *
 * Either token can be omitted if you only have one account configured;
 * defaults: FLOW_START = 60 days ago, FLOW_END = today.
 */

import { PrismaClient } from '@prisma/client';

const BASE = 'https://live.tebi.co';
const DRY_RUN = process.argv.includes('--dry-run');

interface AccountConfig {
  label: string;
  token: string;
  ledger: string;
  // Default location to attribute this ledger's invoices to. The Tebi
  // invoice-list endpoint silently ignores the `filter` param (only the
  // chart endpoints honour JSON-encoded filters), so we can't separate
  // by PC at the invoice level. Attribute by ledger instead:
  //   Account 1 (723192) → west
  //   Account 2 (724466) → centraal (community kitchen owns most of the
  //     volume; TestTafel's rare upscale evenings get aggregated in too,
  //     which is acceptable for arrival-pattern flow charts).
  defaultLocation: string;
}

const accounts: AccountConfig[] = [];
if (process.env.TEBI_BEARER_TOKEN_1) {
  accounts.push({
    label: 'Account 1 (West)',
    token: process.env.TEBI_BEARER_TOKEN_1,
    ledger: process.env.TEBI_LEDGER_ID_1 || '723192',
    defaultLocation: 'west',
  });
}
if (process.env.TEBI_BEARER_TOKEN_2) {
  accounts.push({
    label: 'Account 2 (TestTafel + Centraal)',
    token: process.env.TEBI_BEARER_TOKEN_2,
    ledger: process.env.TEBI_LEDGER_ID_2 || '724466',
    defaultLocation: 'centraal',
  });
}
if (accounts.length === 0) {
  console.error('Set at least one of TEBI_BEARER_TOKEN_1 / TEBI_BEARER_TOKEN_2');
  process.exit(1);
}

// Default: last 60 days. Flow distribution is statistical, so a longer
// window is better — but each day = up to N invoice-list fetches, so we
// cap at 60 to keep the run under ~5 minutes.
const today = new Date();
const fmt = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const defaultStart = new Date(today);
defaultStart.setDate(today.getDate() - 60);
const START = process.env.FLOW_START || fmt(defaultStart);
const END = process.env.FLOW_END || fmt(today);

const SERVICE_WINDOWS: Record<string, { start: number; end: number }> = {
  lunch: { start: 12 * 60, end: 14 * 60 },
  dinner: { start: 18 * 60, end: 21 * 60 },
};
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

interface TimeEvent {
  loc: string;
  meal: 'lunch' | 'dinner';
  date: string;
  minuteOfDay: number;
}

interface InvoiceRow {
  created?: string;
  closedTime?: string;
}

async function fetchInvoicesForLedger(
  account: AccountConfig,
  date: string,
): Promise<InvoiceRow[]> {
  // endDate is exclusive on Tebi's invoice endpoint
  const [y, m, d] = date.split('-').map(Number);
  const next = new Date(y, m - 1, d + 1);
  const endDate = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
  // No `filter` param — invoice list endpoint ignores it. Fetching the full
  // ledger's invoices for the day and attributing via account.defaultLocation.
  const url = `${BASE}/api/invoicing/ledgers/${account.ledger}/sales/invoices?page=0&pageSize=1000&startDate=${date}&endDate=${endDate}`;
  const r = await fetch(url, {
    headers: { authorization: `Bearer ${account.token}`, accept: '*/*', 'tebi-version-code': '1722000' },
  });
  if (!r.ok) {
    console.error(`  ${account.ledger} ${date}: HTTP ${r.status}`);
    return [];
  }
  const body = (await r.json()) as { data?: InvoiceRow[]; content?: InvoiceRow[] };
  return body.data || body.content || [];
}

function classifyMeal(minuteOfDay: number): 'lunch' | 'dinner' | null {
  if (minuteOfDay >= SERVICE_WINDOWS.lunch.start && minuteOfDay < SERVICE_WINDOWS.lunch.end) return 'lunch';
  if (minuteOfDay >= SERVICE_WINDOWS.dinner.start && minuteOfDay < SERVICE_WINDOWS.dinner.end) return 'dinner';
  return null;
}

function extractTimeEvents(invoices: InvoiceRow[], defaultLocation: string, date: string): TimeEvent[] {
  const events: TimeEvent[] = [];
  for (const inv of invoices) {
    const ts = inv.created || inv.closedTime;
    if (!ts) continue;
    const d = new Date(ts);
    const minuteOfDay = d.getHours() * 60 + d.getMinutes();
    const meal = classifyMeal(minuteOfDay);
    if (!meal) continue; // Out-of-service-window — skip for flow chart purposes.
    events.push({ loc: defaultLocation, meal, date, minuteOfDay });
  }
  return events;
}

interface FlowDistribution {
  [location: string]: {
    [meal: string]: {
      [dayOfWeek: string]: { [minuteBucket: string]: number };
    };
  };
}

function buildFlowDistribution(events: TimeEvent[]): FlowDistribution {
  // Group events by loc → meal → dow → bucket
  const raw: FlowDistribution = {};
  for (const ev of events) {
    const dow = DAY_NAMES[new Date(ev.date + 'T12:00:00').getDay()];
    const bucket = String(Math.floor(ev.minuteOfDay / 5) * 5);
    if (!raw[ev.loc]) raw[ev.loc] = {};
    if (!raw[ev.loc][ev.meal]) raw[ev.loc][ev.meal] = {};
    if (!raw[ev.loc][ev.meal][dow]) raw[ev.loc][ev.meal][dow] = {};
    raw[ev.loc][ev.meal][dow][bucket] = (raw[ev.loc][ev.meal][dow][bucket] || 0) + 1;
  }

  // Normalise each (loc, meal, dow) so its bucket fractions sum to 1.
  const dist: FlowDistribution = {};
  for (const loc of Object.keys(raw)) {
    dist[loc] = {};
    for (const meal of Object.keys(raw[loc])) {
      dist[loc][meal] = {};
      for (const dow of Object.keys(raw[loc][meal])) {
        const buckets = raw[loc][meal][dow];
        const total = Object.values(buckets).reduce((s, v) => s + v, 0);
        if (total === 0) continue;
        dist[loc][meal][dow] = {};
        for (const b of Object.keys(buckets)) {
          dist[loc][meal][dow][b] = Math.round((buckets[b] / total) * 10000) / 10000;
        }
      }
    }
  }
  return dist;
}

function dateRange(start: string, end: string): string[] {
  const out: string[] = [];
  const [sy, sm, sd] = start.split('-').map(Number);
  const [ey, em, ed] = end.split('-').map(Number);
  const cur = new Date(sy, sm - 1, sd);
  const stop = new Date(ey, em - 1, ed);
  while (cur <= stop) {
    out.push(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}-${String(cur.getDate()).padStart(2, '0')}`);
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

async function main(): Promise<void> {
  const dates = dateRange(START, END);
  console.log(`Flow-distribution backfill`);
  console.log(`  Range:    ${START} → ${END} (${dates.length} days)`);
  console.log(`  Accounts: ${accounts.map((a) => `${a.label} (ledger ${a.ledger})`).join(', ')}`);
  console.log(`  Mode:     ${DRY_RUN ? 'DRY RUN' : 'WRITE'}`);
  console.log('');

  const allEvents: TimeEvent[] = [];

  for (const account of accounts) {
    console.log(`[${account.label}] fetching invoices for ledger ${account.ledger} → location='${account.defaultLocation}'`);
    for (const date of dates) {
      const invoices = await fetchInvoicesForLedger(account, date);
      const events = extractTimeEvents(invoices, account.defaultLocation, date);
      allEvents.push(...events);
      if (events.length > 0) {
        process.stderr.write(`[${account.label}] ${date}: ${events.length} events (${invoices.length} invoices)\n`);
      }
    }
  }

  console.log('');
  console.log(`Collected ${allEvents.length} time events.`);
  if (allEvents.length === 0) {
    console.log('Nothing to write — no invoices in the window matched a meal service period.');
    return;
  }

  const dist = buildFlowDistribution(allEvents);

  // Show summary of what the distribution covers
  console.log('');
  console.log('Distribution summary:');
  for (const loc of Object.keys(dist).sort()) {
    for (const meal of Object.keys(dist[loc]).sort()) {
      const dows = Object.keys(dist[loc][meal]).sort();
      const totalEvents = allEvents.filter((e) => e.loc === loc && e.meal === meal).length;
      console.log(`  ${loc.padEnd(12)} ${meal.padEnd(8)} ${dows.length} days-of-week (${dows.join(', ')}), ${totalEvents} events`);
    }
  }

  if (DRY_RUN) {
    console.log('');
    console.log('(DRY RUN — distribution NOT written to GuestHistoryMeta)');
    console.log('First 200 chars of computed JSON:');
    console.log('  ' + JSON.stringify(dist).slice(0, 200) + '…');
    return;
  }

  // ── Upsert into GuestHistoryMeta with location-level merge ──
  // We MERGE rather than overwrite: when this script runs with only one
  // account's token (e.g. Account 1 expires while Account 2 is fresh), we
  // shouldn't clobber the other location's existing distribution. Top-level
  // keys are locations ('west' / 'centraal' / 'testtafel'), so a shallow
  // merge does the right thing — new computations replace their location's
  // entry, untouched locations stay intact.
  const prisma = new PrismaClient();
  try {
    const existingRow = await prisma.guestHistoryMeta.findUnique({
      where: { key: 'flowDistribution' },
    });
    let existing: FlowDistribution = {};
    if (existingRow) {
      try {
        existing = JSON.parse(existingRow.value) as FlowDistribution;
      } catch {
        console.warn('  Existing flowDistribution row was not valid JSON — replacing.');
      }
    }
    const merged: FlowDistribution = { ...existing };
    for (const loc of Object.keys(dist)) {
      merged[loc] = dist[loc];
    }
    const json = JSON.stringify(merged);
    await prisma.guestHistoryMeta.upsert({
      where: { key: 'flowDistribution' },
      update: { value: json },
      create: { key: 'flowDistribution', value: json },
    });
    console.log('');
    console.log(
      `Wrote GuestHistoryMeta.flowDistribution (${json.length} chars). Locations now in distribution: ${Object.keys(merged).sort().join(', ')}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
