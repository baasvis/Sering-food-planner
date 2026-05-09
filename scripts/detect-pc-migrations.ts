/**
 * Detect Tebi profit-center migrations.
 *
 * The 7-week silent breakage in spring 2026 had two roots: (1) a
 * UI/API drift that broke our scraper, and (2) Centraal + TestTafel
 * silently migrating from Account 1 (info@testtafel.nl, ledger
 * 723192) to Account 2 (facturen@testtafel.nl, ledger 724466) around
 * 2026-04-10, with our scraper still polling Account 1's now-dormant
 * PCs for weeks afterwards.
 *
 * This script catches the second class of failure. For each
 * (ledger, profit-center) pair, it walks the last N weeks of
 * `product_top` data and classifies activity:
 *
 *   HEALTHY              data in recent 2 weeks AND older weeks
 *   NEWLY_ACTIVE         data in recent 2 weeks but not older weeks
 *   MIGRATION_CANDIDATE  data in older weeks but NOT recent 2 weeks
 *                        ← this is the alert: PC was active, now silent
 *   ALWAYS_SILENT        no significant activity in the window
 *
 * Read-only. Exits 1 if any MIGRATION_CANDIDATE is detected, so the
 * caller (cron, CI, scheduled job) can react.
 *
 * Usage:
 *   TEBI_BEARER_TOKEN_1='eyJ...' TEBI_BEARER_TOKEN_2='eyJ...' \
 *     npx tsx scripts/detect-pc-migrations.ts [--weeks 8]
 *
 * Either token can be omitted if you only have one fresh; the script
 * just runs against whichever accounts are configured.
 */

const BASE = 'https://live.tebi.co';
const VERSION_CODE = '1722000';

const args = process.argv.slice(2);
const weeksFlagIdx = args.indexOf('--weeks');
const NUM_WEEKS =
  weeksFlagIdx >= 0 && args[weeksFlagIdx + 1] ? Math.max(4, parseInt(args[weeksFlagIdx + 1], 10) || 8) : 8;

// Activity thresholds. The defaults are deliberately permissive: a real
// PC ringing up real meals does hundreds of qty/week. Anything under
// these floors counts as "silent" — sub-floor noise might be a single
// staff sale or a test transaction, not actual service.
const RECENT_QTY_FLOOR = 10; // sum across the last 2 weeks
const OLDER_QTY_FLOOR = 50; // sum across the older weeks

interface AccountConfig {
  label: string;
  token: string;
  ledger: string;
}

interface ProfitCenter {
  uuid: string;
  name: string;
}

interface WeekActivity {
  start: string;
  end: string;
  qty: number;
  itemCount: number;
}

type Verdict = 'HEALTHY' | 'NEWLY_ACTIVE' | 'MIGRATION_CANDIDATE' | 'ALWAYS_SILENT';

interface PcReport {
  account: string;
  ledger: string;
  pcName: string;
  pcUuid: string;
  weeks: WeekActivity[];
  recentSum: number;
  olderSum: number;
  verdict: Verdict;
  reasoning: string;
}

const accounts: AccountConfig[] = [];
if (process.env.TEBI_BEARER_TOKEN_1) {
  accounts.push({
    label: 'Account 1',
    token: process.env.TEBI_BEARER_TOKEN_1,
    ledger: process.env.TEBI_LEDGER_ID_1 || '723192',
  });
}
if (process.env.TEBI_BEARER_TOKEN_2) {
  accounts.push({
    label: 'Account 2',
    token: process.env.TEBI_BEARER_TOKEN_2,
    ledger: process.env.TEBI_LEDGER_ID_2 || '724466',
  });
}
if (accounts.length === 0) {
  console.error('Set at least one of TEBI_BEARER_TOKEN_1 / TEBI_BEARER_TOKEN_2');
  process.exit(1);
}

function authHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: '*/*',
    'tebi-version-code': VERSION_CODE,
  };
}

function fmt(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

interface DashboardChart {
  id?: string;
  name?: string;
}
interface DashboardChartGroup {
  charts?: DashboardChart[];
}
interface DashboardMain {
  chartGroups?: DashboardChartGroup[];
  groups?: DashboardChartGroup[]; // legacy shape; kept tolerant
}

async function discoverProfitCenters(account: AccountConfig): Promise<ProfitCenter[]> {
  const url = `${BASE}/api/insights/ledgers/${account.ledger}/insights/dashboards/main`;
  const r = await fetch(url, { headers: authHeaders(account.token) });
  if (!r.ok) {
    throw new Error(`[${account.label}] dashboardMain fetch HTTP ${r.status} — token expired?`);
  }
  const body = (await r.json()) as DashboardMain;
  const groups = body.chartGroups || body.groups || [];
  const pcs: ProfitCenter[] = [];
  for (const group of groups) {
    for (const chart of group.charts || []) {
      if (chart.id?.startsWith('revenue_profit_center_')) {
        const uuid = chart.id.slice('revenue_profit_center_'.length);
        pcs.push({ uuid, name: chart.name || uuid });
      }
    }
  }
  return pcs;
}

async function fetchWeekActivity(
  account: AccountConfig,
  pc: ProfitCenter,
  start: string,
  end: string,
): Promise<WeekActivity> {
  const filter = encodeURIComponent(JSON.stringify({ grouping: 'PROFIT_CENTER', value: pc.uuid }));
  const url = `${BASE}/api/insights/ledgers/${account.ledger}/insights/data/charts/product_top?startDate=${start}&endDate=${end}&mock=false&limit=-1&filter=${filter}`;
  const r = await fetch(url, { headers: authHeaders(account.token) });
  if (!r.ok) return { start, end, qty: 0, itemCount: 0 };
  const body = (await r.json()) as { data?: Array<Record<string, unknown>> };
  if (!Array.isArray(body.data)) return { start, end, qty: 0, itemCount: 0 };
  let qty = 0;
  for (const entry of body.data) {
    const metrics = entry.metrics as Array<Record<string, unknown>> | undefined;
    const m = metrics?.find((mm) => mm.name === 'TOTAL_PRODUCTS_SOLD');
    if (m) qty += parseFloat(String(m.value)) || 0;
  }
  return { start, end, qty, itemCount: body.data.length };
}

function classify(weeks: WeekActivity[]): { verdict: Verdict; reasoning: string; recentSum: number; olderSum: number } {
  const recent = weeks.slice(-2);
  const older = weeks.slice(0, -2);
  const recentSum = recent.reduce((a, w) => a + w.qty, 0);
  const olderSum = older.reduce((a, w) => a + w.qty, 0);
  const recentActive = recentSum >= RECENT_QTY_FLOOR;
  const olderActive = olderSum >= OLDER_QTY_FLOOR;
  if (recentActive && olderActive) {
    return {
      verdict: 'HEALTHY',
      reasoning: `recent ${recentSum.toFixed(0)} qty, older ${olderSum.toFixed(0)} qty`,
      recentSum,
      olderSum,
    };
  }
  if (recentActive && !olderActive) {
    return {
      verdict: 'NEWLY_ACTIVE',
      reasoning: `recent ${recentSum.toFixed(0)} qty, older only ${olderSum.toFixed(0)} qty — newly online?`,
      recentSum,
      olderSum,
    };
  }
  if (!recentActive && olderActive) {
    return {
      verdict: 'MIGRATION_CANDIDATE',
      reasoning: `recent only ${recentSum.toFixed(0)} qty after older ${olderSum.toFixed(0)} qty — PC went silent`,
      recentSum,
      olderSum,
    };
  }
  return { verdict: 'ALWAYS_SILENT', reasoning: `no significant activity in ${weeks.length}-week window`, recentSum, olderSum };
}

function tagFor(verdict: Verdict): string {
  switch (verdict) {
    case 'HEALTHY':
      return '✓ HEALTHY';
    case 'NEWLY_ACTIVE':
      return '+ NEWLY_ACTIVE';
    case 'MIGRATION_CANDIDATE':
      return '! MIGRATION_CANDIDATE';
    case 'ALWAYS_SILENT':
      return '· ALWAYS_SILENT';
  }
}

async function main(): Promise<void> {
  // Build ranges: oldest week first, newest last. Each range is
  // [weekStart, weekEnd) — endDate is exclusive on Tebi's chart endpoint.
  const today = new Date();
  const ranges: Array<[string, string]> = [];
  for (let weekIdx = NUM_WEEKS - 1; weekIdx >= 0; weekIdx--) {
    const end = new Date(today);
    end.setDate(today.getDate() - weekIdx * 7);
    const start = new Date(end);
    start.setDate(end.getDate() - 7);
    ranges.push([fmt(start), fmt(end)]);
  }

  console.log(`PC migration detector — ${NUM_WEEKS}-week activity classification`);
  console.log(`  Window:    ${ranges[0][0]} → ${ranges[ranges.length - 1][1]}`);
  console.log(`  Accounts:  ${accounts.map((a) => `${a.label} (ledger ${a.ledger})`).join(', ')}`);
  console.log(
    `  Floors:    recent (last 2 weeks) qty ≥ ${RECENT_QTY_FLOOR}, older qty ≥ ${OLDER_QTY_FLOOR}`,
  );
  console.log('');

  const reports: PcReport[] = [];

  for (const account of accounts) {
    process.stdout.write(`Discovering PCs on ${account.label} (ledger ${account.ledger})… `);
    let pcs: ProfitCenter[];
    try {
      pcs = await discoverProfitCenters(account);
    } catch (e: unknown) {
      console.log('FAILED');
      console.error(`  ${e instanceof Error ? e.message : String(e)}`);
      console.error(`  → skipping this account`);
      continue;
    }
    console.log(`found ${pcs.length}`);
    for (const pc of pcs) {
      const shortUuid = pc.uuid.slice(0, 8);
      process.stderr.write(`    ${pc.name} (${shortUuid}…) `);
      const weeks: WeekActivity[] = [];
      for (const [start, end] of ranges) {
        weeks.push(await fetchWeekActivity(account, pc, start, end));
        process.stderr.write('.');
      }
      const { verdict, reasoning, recentSum, olderSum } = classify(weeks);
      process.stderr.write(` ${tagFor(verdict)}\n`);
      reports.push({
        account: account.label,
        ledger: account.ledger,
        pcName: pc.name,
        pcUuid: pc.uuid,
        weeks,
        recentSum,
        olderSum,
        verdict,
        reasoning,
      });
    }
  }

  if (reports.length === 0) {
    console.error('');
    console.error('No PCs queried. Did the token fetches all fail?');
    process.exit(1);
  }

  // ── Summary table ──
  console.log('');
  const weekLabels = ranges.map(([s]) => s.slice(5));
  const accountColW = Math.max(8, ...reports.map((r) => r.account.length));
  const pcColW = Math.max(4, ...reports.map((r) => r.pcName.length));
  const cellW = 6;

  const header = `${'ACCOUNT'.padEnd(accountColW)} ${'PC'.padEnd(pcColW)} ${weekLabels.map((w) => w.padStart(cellW)).join(' ')}  VERDICT`;
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const r of reports) {
    const cells = r.weeks
      .map((w) => (w.qty < 1 ? '·' : String(Math.round(w.qty))))
      .map((c) => c.padStart(cellW))
      .join(' ');
    console.log(`${r.account.padEnd(accountColW)} ${r.pcName.padEnd(pcColW)} ${cells}  ${tagFor(r.verdict)}`);
  }

  // ── Verdicts ──
  console.log('');
  console.log('Per-PC reasoning:');
  for (const r of reports) {
    console.log(`  [${r.account}] ${r.pcName.padEnd(pcColW)} → ${r.verdict.padEnd(20)} ${r.reasoning}`);
  }

  // ── Migration alert section ──
  const migrations = reports.filter((r) => r.verdict === 'MIGRATION_CANDIDATE');
  const newlyActive = reports.filter((r) => r.verdict === 'NEWLY_ACTIVE');

  console.log('');
  if (migrations.length === 0 && newlyActive.length === 0) {
    console.log('✓ No migration candidates and no newly-active PCs detected.');
    console.log('  All known PCs are either healthy or have always been silent.');
    return;
  }

  if (newlyActive.length > 0) {
    console.log(`+ ${newlyActive.length} newly-active PC(s) — likely a new location came online:`);
    for (const r of newlyActive) {
      console.log(`     [${r.account}, ledger ${r.ledger}] '${r.pcName}' (${r.pcUuid})`);
      console.log(`       → ${r.reasoning}`);
      console.log(`       → Confirm this PC is in MEAL_ITEM_TYPE coverage if it serves food.`);
    }
    console.log('');
  }

  if (migrations.length > 0) {
    console.log(`! ${migrations.length} migration candidate(s) — PC was active but is now silent:`);
    for (const r of migrations) {
      console.log(`     [${r.account}, ledger ${r.ledger}] '${r.pcName}' (${r.pcUuid})`);
      console.log(`       → ${r.reasoning}`);
      console.log(`       → Did this location move to another ledger? Check the other account.`);
    }
    console.log('');
    console.log('Exiting 1 so callers (cron, CI) can surface this.');
    process.exit(1);
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
