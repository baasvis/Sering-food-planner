import { eur2, eur0, pctDelta, deltaChip, targetChip, sparkline, renderWeekStrip } from '../public/js/finance-format';

describe('eur formatters', () => {
  it('eur2 fixed 2dp; eur0 rounds; both handle null/NaN', () => {
    expect(eur2(12.5)).toBe('€12.50');
    expect(eur0(50.4)).toBe('€50');
    expect(eur0(50.6)).toBe('€51');
    expect(eur2(null)).toBe('–');
    expect(eur0(NaN)).toBe('–');
  });
});

describe('pctDelta', () => {
  it('computes % change', () => { expect(pctDelta(120, 100)).toBe(20); expect(pctDelta(80, 100)).toBe(-20); });
  it('guards prev===0 and nulls', () => { expect(pctDelta(100, 0)).toBeNull(); expect(pctDelta(null, 100)).toBeNull(); expect(pctDelta(100, null)).toBeNull(); });
});

describe('deltaChip', () => {
  it('up = good, down = bad, flat = neutral (default goodIsUp)', () => {
    expect(deltaChip(12)).toContain('fin-chip-good'); expect(deltaChip(12)).toContain('↑ 12%');
    expect(deltaChip(-12)).toContain('fin-chip-bad'); expect(deltaChip(-12)).toContain('↓ 12%');
    expect(deltaChip(0)).toContain('fin-chip-neutral'); expect(deltaChip(0)).toContain('→');
  });
  it('null = neutral placeholder', () => { expect(deltaChip(null)).toContain('fin-chip-neutral'); });
  it('goodIsUp=false flips direction', () => { expect(deltaChip(10, false)).toContain('fin-chip-bad'); expect(deltaChip(-10, false)).toContain('fin-chip-good'); });
});

describe('targetChip', () => {
  it('no target → empty; actual null → neutral', () => { expect(targetChip(10, null)).toBe(''); expect(targetChip(null, 10)).toContain('fin-chip-neutral'); });
  it('at/above target good, below bad (higher spend is better)', () => {
    expect(targetChip(12, 10)).toContain('fin-chip-good'); expect(targetChip(12, 10)).toContain('✓');
    expect(targetChip(8, 10)).toContain('fin-chip-bad'); expect(targetChip(8, 10)).toContain('↓');
  });
});

describe('sparkline', () => {
  it('empty → empty-state div', () => { expect(sparkline([], [])).toContain('fin-spark-empty'); });
  it('single point → svg, no NaN (maxH===minH guard)', () => {
    const s = sparkline([{ hour: 12, cum: 100 }], []);
    expect(s).toContain('<svg'); expect(s).not.toContain('NaN');
  });
  it('multi point → exactly two paths, no NaN', () => {
    const s = sparkline([{ hour: 11, cum: 50 }, { hour: 12, cum: 120 }], [{ hour: 11, cum: 40 }, { hour: 12, cum: 90 }]);
    expect((s.match(/<path/g) || []).length).toBe(2); expect(s).not.toContain('NaN');
  });
});

describe('renderWeekStrip', () => {
  it('always 7 cells (pads short / empty arrays)', () => {
    expect((renderWeekStrip([{ date: '2026-06-22', gross: 100 }]).match(/fin-wk-cell/g) || []).length).toBe(7);
    expect((renderWeekStrip([]).match(/fin-wk-cell/g) || []).length).toBe(7);
  });
  it('only >0 days are filled; no NaN heights', () => {
    const s = renderWeekStrip([{ date: 'a', gross: 100 }, { date: 'b', gross: 0 }]);
    expect((s.match(/fin-wk-bar filled/g) || []).length).toBe(1);
    expect(renderWeekStrip([{ date: 'a', gross: 0 }])).not.toContain('NaN');
  });
});
