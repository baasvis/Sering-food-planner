/**
 * runner.ts — CLI to run all (or selected) solvers across all fixtures and
 * print a markdown comparison table. Optionally writes per-strategy JSON
 * results to bench/menu-fixer/results/.
 *
 * Usage:
 *   npx tsx bench/menu-fixer/runner.ts                    # all solvers
 *   npx tsx bench/menu-fixer/runner.ts current ilp        # specific solvers
 *   npx tsx bench/menu-fixer/runner.ts --baseline-only    # just current.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { listFixtures, loadFixture, runSolver, formatRunsTable, formatStrategyAverages } from './harness';
import type { BenchRun, SolverFn } from './types';

interface SolverEntry {
  name: string;
  description: string;
  load: () => SolverFn;
}

/**
 * Auto-discover all .ts files under solvers/. Each file MUST export a const
 * with the same name as the filename (e.g. solvers/ilp.ts → export const ilp).
 *
 * This avoids merge conflicts when multiple agents add solvers in parallel.
 */
function discoverSolvers(): SolverEntry[] {
  const dir = path.join(__dirname, 'solvers');
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.ts') && !f.startsWith('_'));
  const entries: SolverEntry[] = [];
  for (const f of files) {
    const name = f.replace(/\.ts$/, '');
    entries.push({
      name,
      description: '',
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      load: () => {
        const mod = require(`./solvers/${name}`);
        const fn = mod[name];
        if (!fn) throw new Error(`solvers/${name}.ts must export "${name}" as a SolverFn`);
        return fn;
      },
    });
  }
  return entries;
}

const SOLVERS: SolverEntry[] = discoverSolvers();

async function main() {
  const args = process.argv.slice(2);
  const baselineOnly = args.includes('--baseline-only');
  const filterNames = args.filter(a => !a.startsWith('--'));

  let solvers = SOLVERS;
  if (baselineOnly) solvers = solvers.filter(s => s.name === 'current');
  else if (filterNames.length > 0) solvers = solvers.filter(s => filterNames.includes(s.name));

  // Try to load each requested solver. If a parallel-agent solver file is
  // half-written or has a syntax error, we skip it rather than fail the
  // whole run — other strategies still get scored.
  const loaded: { name: string; fn: SolverFn; description: string }[] = [];
  for (const s of solvers) {
    try {
      const fn = s.load();
      loaded.push({ name: s.name, fn, description: s.description });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`  [skip] ${s.name}: ${msg.split('\n')[0]}`);
    }
  }

  if (loaded.length === 0) {
    console.error('No solvers loaded. Implement at least one in bench/menu-fixer/solvers/.');
    process.exit(1);
  }

  const fixtures = listFixtures();
  if (fixtures.length === 0) {
    console.error(`No fixtures in ${path.join(__dirname, 'fixtures')}. Run snapshot.ts first.`);
    process.exit(1);
  }

  console.log(`Running ${loaded.length} solvers × ${fixtures.length} fixtures = ${loaded.length * fixtures.length} runs\n`);

  const allRuns: BenchRun[] = [];
  for (const { name, fn } of loaded) {
    console.log(`── ${name} ──`);
    for (const fname of fixtures) {
      process.stdout.write(`  ${fname}… `);
      const fixture = loadFixture(fname);
      const run = await runSolver(fixture, fn, name);
      const tag = run.score.hardFails.length > 0 ? `INVALID(${run.score.hardFails.length}HF)` : run.score.total.toString();
      console.log(`${tag}  (${run.durationMs}ms)`);
      allRuns.push(run);
    }
    console.log('');
  }

  console.log('## Per-run scores\n');
  console.log(formatRunsTable(allRuns));
  console.log('\n## Strategy averages\n');
  console.log(formatStrategyAverages(allRuns));

  // Write JSON for downstream comparison
  const RESULTS_DIR = path.join(__dirname, 'results');
  if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const outFile = path.join(RESULTS_DIR, 'all-runs.json');
  fs.writeFileSync(outFile, JSON.stringify(allRuns, null, 2));
  console.log(`\nWrote ${outFile}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
