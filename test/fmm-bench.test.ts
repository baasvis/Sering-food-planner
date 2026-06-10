/**
 * Fix-My-Menu regression bench. Scores the live engine on the benchmark
 * objective (bench/menu-fixer/score.ts) across sliding-today fixtures derived
 * from a frozen real-data snapshot, so a scoring change is measured across
 * scenarios — not eyeballed on one week.
 *
 * Revived from the #47 solver bake-off (reverted in #53) and ported to the
 * unified-batch engine. The bake-off's conclusion still holds: solver choice
 * barely matters (+1.5–7.5%); what matters is the objective — chiefly "missed
 * matches" (a slot left empty when eligible food had spare capacity), the
 * failure mode behind the 2026-06 Monday-starvation bug. These assertions guard
 * against that class returning.
 *
 * To regenerate the fixture: `railway run npx tsx scripts/dump-fmm-data.ts`.
 */
import * as fs from 'fs';
import * as path from 'path';
import { S } from '../public/js/state';
import { loadFixtureIntoS, runFixMyMenu } from '../bench/menu-fixer/run-pipeline';
import { scoreSolution } from '../bench/menu-fixer/score';

const DUMP = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'bench', 'menu-fixer', 'fixtures', '2026-06-01-live.json'), 'utf8'));

// Realistic fixtures only: anchor today >= the cooked stock's cook dates, so no
// "stock exists before it was cooked" artifacts. Demand variants stress the
// surplus (low demand) and stockout (high demand) axes.
function scaleGuests(factor: number) {
  return () => {
    for (const loc of ['west', 'centraal'] as const) {
      const days = (S.guests as any)[loc] || {};
      for (const dn of Object.keys(days)) for (const meal of Object.keys(days[dn])) {
        days[dn][meal] = Math.round(days[dn][meal] * factor);
      }
    }
  };
}
const FIXTURES: { label: string; today: string; transform?: () => void }[] = [
  { label: 'mon-01/06', today: '2026-06-01' },
  { label: 'mon-lowdem', today: '2026-06-01', transform: scaleGuests(0.5) },
  { label: 'mon-highdem', today: '2026-06-01', transform: scaleGuests(1.4) },
  { label: 'tue-02/06', today: '2026-06-02' },
  { label: 'wed-03/06', today: '2026-06-03' },
];

beforeAll(() => jest.useFakeTimers());
afterAll(() => jest.useRealTimers());

describe('Fix-My-Menu bench (regression guard)', () => {
  const results: { label: string; score: number; fillPct: number; missed: number; surplus: number; emerg: number; hardFails: number }[] = [];

  beforeAll(() => {
    for (const f of FIXTURES) {
      const [y, m, d] = f.today.split('-').map(Number);
      jest.setSystemTime(new Date(y, m - 1, d, 8, 0, 0));
      loadFixtureIntoS(DUMP);
      if (f.transform) f.transform();
      const fb = runFixMyMenu();
      const sc = scoreSolution(f.today, S.batches);
      results.push({
        label: f.label, score: sc.total, fillPct: (sc.slotsFilled / sc.slotsTotal) * 100,
        missed: sc.missedMatches, surplus: sc.leftoverSurplusL, emerg: fb.emergencies, hardFails: sc.hardFails.length,
      });
    }
    // eslint-disable-next-line no-console
    console.log('\n===== Fix-My-Menu bench =====');
    for (const r of results) {
      // eslint-disable-next-line no-console
      console.log(`  ${r.label.padEnd(11)} score=${String(r.score).padStart(6)}  fill=${r.fillPct.toFixed(0)}%  missed=${r.missed}  surplusL=${r.surplus.toFixed(0)}  emerg=${r.emerg}`);
    }
  });

  test('no hard-fail solutions (in-slot dup / frozen auto-assigned)', () => {
    for (const r of results) expect(r.hardFails).toBe(0);
  });

  test('high slot-fill across all fixtures (>= 90%)', () => {
    for (const r of results) expect(r.fillPct).toBeGreaterThanOrEqual(90);
  });

  test('missed-matches stay low — guards the Monday-starvation regression', () => {
    // Pre-fix, the Monday fixture produced 4 missed matches (empty slots with
    // eligible stock). The soonness + tiered scoring drives this to <= 1.
    const mon = results.find(r => r.label === 'mon-01/06')!;
    expect(mon.missed).toBeLessThanOrEqual(1);
    const meanMissed = results.reduce((s, r) => s + r.missed, 0) / results.length;
    expect(meanMissed).toBeLessThanOrEqual(1.5);
  });

  test('mean objective score holds above the post-fix floor', () => {
    const mean = results.reduce((s, r) => s + r.score, 0) / results.length;
    // Current mean across the 5 fixtures is ~28.6k (deterministic: 34466 /
    // 30336 / 27764 / 29096 / 21301 — lifted from ~25.7k by the leftover-drain
    // + sibling-rebalance passes). 26500 keeps a ~7% cushion below the live
    // mean — tight enough to catch a real scoring regression (including losing
    // either new pass), loose enough to absorb minor fixture jitter.
    expect(mean).toBeGreaterThanOrEqual(26500);
  });
});
