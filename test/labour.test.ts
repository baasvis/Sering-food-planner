import { parseHm, shiftLengthMin, shiftElapsedMin, blendedRate, orgForNotionVenue, computeLabour, type PlannedShift } from '../lib/labour';

describe('parseHm', () => {
  it('parses HH:MM', () => { expect(parseHm('09:00')).toBe(540); expect(parseHm('00:30')).toBe(30); expect(parseHm('23:59')).toBe(1439); });
  it('rejects junk', () => { expect(parseHm('9am')).toBeNull(); expect(parseHm('24:00')).toBeNull(); expect(parseHm('12:60')).toBeNull(); expect(parseHm('')).toBeNull(); expect(parseHm(null)).toBeNull(); });
});

describe('shift length + elapsed (midnight crossing)', () => {
  it('normal shift', () => { expect(shiftLengthMin(540, 1020)).toBe(480); }); // 09:00-17:00 = 8h
  it('crosses midnight', () => { expect(shiftLengthMin(960, 30)).toBe(510); }); // 16:00-00:30 = 8.5h
  it('elapsed before/during/after', () => {
    expect(shiftElapsedMin(540, 1020, 480)).toBe(0);   // before start
    expect(shiftElapsedMin(540, 1020, 720)).toBe(180); // 3h in
    expect(shiftElapsedMin(540, 1020, 1200)).toBe(480); // after end → full
  });
  it('elapsed across midnight', () => {
    expect(shiftElapsedMin(960, 30, 1320)).toBe(360);  // 22:00, 6h into a 16:00 start
    expect(shiftElapsedMin(960, 30, 100000)).toBe(510); // day complete → full
  });
});

describe('blendedRate', () => {
  it('Σtotal / Σhours', () => { expect(blendedRate([{ hours: 10, total: 150 }, { hours: 30, total: 450 }])).toBe(15); });
  it('null when no hours', () => { expect(blendedRate([])).toBeNull(); expect(blendedRate([{ hours: 0, total: 0 }])).toBeNull(); });
});

describe('orgForNotionVenue', () => {
  it('maps venues', () => {
    expect(orgForNotionVenue('Sering West')).toBe('west');
    expect(orgForNotionVenue('West-Event')).toBe('west');
    expect(orgForNotionVenue('Catering')).toBe('west');
    expect(orgForNotionVenue('Sering Centraal')).toBe('centraal');
    expect(orgForNotionVenue('TestTafel')).toBe('testtafel');
    expect(orgForNotionVenue('Other')).toBeNull();
    expect(orgForNotionVenue('')).toBeNull();
    expect(orgForNotionVenue(undefined)).toBeNull();
  });
});

describe('computeLabour', () => {
  const shifts: PlannedShift[] = [
    { org: 'west', role: 'cook', person: 'A', startMin: 540, endMin: 1020 },  // 09:00-17:00 (8h)
    { org: 'west', role: 'FOH', person: 'B', startMin: 960, endMin: 30 },     // 16:00-00:30 (8.5h)
  ];
  it('planned + elapsed + cost + pct + headcount at 18:00 (1080)', () => {
    const l = computeLabour(shifts, 15, 1080, 2000);
    expect(l.plannedHours).toBe(16.5);              // 8 + 8.5
    expect(l.plannedCost).toBe(247.5);              // 16.5 × 15
    expect(l.hoursSoFar).toBe(10);                  // cook 8h done + FOH 2h in = 10h
    expect(l.costSoFar).toBe(150);                  // 10 × 15
    expect(l.pctOfRevenue).toBe(7.5);               // 150 / 2000
    expect(l.headcountOn).toBe(1);                  // only FOH still on at 18:00
    expect(l.shiftCount).toBe(2);
  });
  it('null cost/pct when no blended rate', () => {
    const l = computeLabour(shifts, null, 1080, 2000);
    expect(l.plannedCost).toBeNull();
    expect(l.costSoFar).toBeNull();
    expect(l.pctOfRevenue).toBeNull();
    expect(l.plannedHours).toBe(16.5); // hours still computed
  });
  it('pct null when no revenue yet', () => {
    expect(computeLabour(shifts, 15, 1080, 0).pctOfRevenue).toBeNull();
  });
});
