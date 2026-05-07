// Harness: load a fixture, run a solver, score the result.
//
// The trick: existing menu-fixer.ts pass functions read S.planner via
// rebuildPlanner() / calcRequired(). To run them headlessly, we install a
// fixture-derived S into the global namespace BEFORE invoking the solver,
// then restore it afterwards. Each fixture run gets a fresh sandbox.

import * as fs from 'fs';
import * as path from 'path';
import type { Batch } from '../../shared/types';
import type { Fixture, SolverFn, SolverResult, BenchRun, ScoreReport } from './types';
import { scoreSolution } from './score';

// ── DOM/window stubs (mirrors test/setup-dom-stubs.ts) ─────────────────────
// menu-fixer.ts is frontend code that imports from public/js/state.ts which
// touches localStorage. Same trick the test suite uses.

function ensureBrowserGlobals() {
  // Mirrors test/setup-dom-stubs.ts so the bench can import frontend modules
  // (which touch window.addEventListener at module load) without jsdom.
  const noop = () => {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;

  if (!g.localStorage) {
    const store: Record<string, string> = {};
    g.localStorage = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = String(v); },
      removeItem: (k: string) => { delete store[k]; },
      clear: () => { for (const k of Object.keys(store)) delete store[k]; },
    };
  }
  if (!g.document) {
    g.document = {
      addEventListener: noop,
      removeEventListener: noop,
      visibilityState: 'visible',
      hidden: false,
      referrer: '',
      title: '',
      body: { addEventListener: noop, appendChild: noop, removeChild: noop },
      documentElement: { classList: { add: noop, remove: noop, toggle: noop, contains: () => false } },
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => ({ style: {}, addEventListener: noop }),
      head: { appendChild: noop },
    };
  }
  if (!g.window) {
    g.window = {
      addEventListener: noop,
      removeEventListener: noop,
      location: { href: 'http://bench/', pathname: '/', search: '' },
      history: { pushState: noop, replaceState: noop, back: noop },
      matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
      setTimeout, clearTimeout, setInterval, clearInterval,
      confirm: () => true,
      alert: noop,
    };
  }
  if (!g.navigator) g.navigator = { userAgent: 'bench', sendBeacon: () => true };
  if (!g.EventSource) g.EventSource = class { close() {} addEventListener() {} };

  // Suppress module-load setInterval timers (telemetry's 30s flush) so the
  // process can exit cleanly.
  const realSetInterval = g.setInterval;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  g.setInterval = (fn: (...args: any[]) => void, ms: number, ...args: any[]) => {
    if (ms < 5 * 60_000) return 0;
    return realSetInterval(fn, ms, ...args);
  };
}

// ── Fixture loader ─────────────────────────────────────────────────────────

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

export function listFixtures(): string[] {
  if (!fs.existsSync(FIXTURES_DIR)) return [];
  return fs.readdirSync(FIXTURES_DIR)
    .filter(f => f.endsWith('.json'))
    .sort();
}

export function loadFixture(filename: string): Fixture {
  const full = path.join(FIXTURES_DIR, filename);
  const raw = fs.readFileSync(full, 'utf8');
  return JSON.parse(raw) as Fixture;
}

// ── Run a single solver ────────────────────────────────────────────────────

export async function runSolver(
  fixture: Fixture,
  solver: SolverFn,
  strategyName: string,
): Promise<BenchRun> {
  ensureBrowserGlobals();

  // Deep-clone batches so the solver can't pollute the fixture.
  const batches: Batch[] = JSON.parse(JSON.stringify(fixture.batches));

  // Capture timing with real Date in case the solver mocks it.
  const RealDate = Date;
  const start = RealDate.now();
  let result: SolverResult;
  try {
    result = solver({ fixture, batches });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      strategy: strategyName,
      fixture: fixture.name,
      durationMs: RealDate.now() - start,
      score: {
        total: -999999,
        breakdown: emptyBreakdown(),
        hardFails: [`Solver threw: ${msg}`],
        softViolations: [],
      },
    };
  }
  const durationMs = result.durationMs ?? (RealDate.now() - start);

  const score = scoreSolution(fixture, result.batches);

  return {
    strategy: strategyName,
    fixture: fixture.name,
    durationMs,
    score,
    stats: result.stats,
  };
}

function emptyBreakdown() {
  return {
    slotsFilledPoints: 0,
    missedMatchPenalty: 0,
    leftoverSurplusPenalty: 0,
    overCapPenalty: 0,
    staleNotAssignedPenalty: 0,
    familyBudgetPenalty: 0,
    oldestFirstBonus: 0,
    varietyBonus: 0,
    slotsFilled: 0,
    slotsTotal: 0,
    missedMatches: 0,
    leftoverSurplusLiters: 0,
    overCapSlots: 0,
    staleNotAssignedLiters: 0,
    familyBudgetViolations: 0,
    oldestFirstHits: 0,
    varietySlots: 0,
  };
}

// ── Run a strategy across all fixtures ─────────────────────────────────────

export async function runStrategy(
  solver: SolverFn,
  strategyName: string,
  fixtureFilter?: (name: string) => boolean,
): Promise<BenchRun[]> {
  const fixtures = listFixtures().filter(f => !fixtureFilter || fixtureFilter(f));
  const runs: BenchRun[] = [];
  for (const fname of fixtures) {
    const fixture = loadFixture(fname);
    const run = await runSolver(fixture, solver, strategyName);
    runs.push(run);
  }
  return runs;
}

// ── Markdown report ────────────────────────────────────────────────────────

export function formatRunsTable(runs: BenchRun[]): string {
  const lines: string[] = [];
  lines.push('| Strategy | Fixture | Score | Filled | Missed | Surplus L | Over-cap | Stale L | HardFails | Time ms |');
  lines.push('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const r of runs) {
    const b = r.score.breakdown;
    const hf = r.score.hardFails.length;
    const fillPct = b.slotsTotal > 0 ? `${b.slotsFilled}/${b.slotsTotal}` : '-';
    lines.push(`| ${r.strategy} | ${r.fixture} | ${r.score.total} | ${fillPct} | ${b.missedMatches} | ${b.leftoverSurplusLiters.toFixed(1)} | ${b.overCapSlots} | ${b.staleNotAssignedLiters.toFixed(1)} | ${hf} | ${r.durationMs} |`);
  }
  return lines.join('\n');
}

export function formatStrategyAverages(runs: BenchRun[]): string {
  // Group by strategy, compute means
  const byStrat = new Map<string, BenchRun[]>();
  for (const r of runs) {
    const arr = byStrat.get(r.strategy) || [];
    arr.push(r);
    byStrat.set(r.strategy, arr);
  }
  const lines: string[] = [];
  lines.push('| Strategy | Mean Score | Mean Filled% | Mean Missed | Mean Surplus L | HardFails | Mean ms |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|');
  for (const [strat, list] of byStrat) {
    const meanScore = list.reduce((s, r) => s + r.score.total, 0) / list.length;
    const totalSlots = list.reduce((s, r) => s + r.score.breakdown.slotsTotal, 0);
    const totalFilled = list.reduce((s, r) => s + r.score.breakdown.slotsFilled, 0);
    const fillPct = totalSlots > 0 ? (totalFilled / totalSlots * 100) : 0;
    const meanMissed = list.reduce((s, r) => s + r.score.breakdown.missedMatches, 0) / list.length;
    const meanSurplus = list.reduce((s, r) => s + r.score.breakdown.leftoverSurplusLiters, 0) / list.length;
    const totalHardFails = list.reduce((s, r) => s + r.score.hardFails.length, 0);
    const meanMs = list.reduce((s, r) => s + r.durationMs, 0) / list.length;
    lines.push(`| ${strat} | ${meanScore.toFixed(0)} | ${fillPct.toFixed(0)}% | ${meanMissed.toFixed(1)} | ${meanSurplus.toFixed(1)} | ${totalHardFails} | ${meanMs.toFixed(0)} |`);
  }
  return lines.join('\n');
}
