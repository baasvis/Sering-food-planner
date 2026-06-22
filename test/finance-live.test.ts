import { classifyDayRows, cumulativeByHour, isoWeekDates, shiftDate, perMeal, cleanTargetsConfig, resolveTargetsForDay, type ProductRow } from '../lib/finance-live';

const row = (productName: string, type: string | null, qty: number, gross: number): ProductRow => ({ productName, type, qty, gross, net: gross / 1.09 });

describe('classifyDayRows', () => {
  it('splits food / drink / other / uncategorized and excludes tips + structural', () => {
    const s = classifyDayRows([
      row('TT menu', 'TT menu', 100, 4000),       // food + meal
      row('Soup', 'Soup', 20, 200),               // food + meal
      row('Huiswijn', 'TT wine', 30, 600),        // drink
      row('Cola', 'Frisdrank', 25, 75),           // drink (soft)
      row('Homemade AF', 'TT Homemade AF', 10, 40), // drink (AF)
      row('Space hire', 'TT Events / space rental', 1, 250), // other
      row('New thing', null, 5, 120),             // uncategorized
      row('Tip jar', 'TT tips', 1, 50),           // excluded (not a sale)
      row('Course 2', '<structural>', 100, 0),    // excluded (bookkeeping)
    ]);
    expect(s.foodGross).toBeCloseTo(4200);
    expect(s.drinkGross).toBeCloseTo(715);
    expect(s.otherGross).toBeCloseTo(250);
    expect(s.uncategorizedGross).toBeCloseTo(120);
    expect(s.gross).toBeCloseTo(4200 + 715 + 250 + 120); // tips + structural excluded
    expect(s.meals).toBe(120); // TT menu (100) + Soup (20); drinks/other/uncategorized not meals
  });

  it('AF drinks are NOT food', () => {
    const s = classifyDayRows([row('AF', 'TT bought AF', 3, 12)]);
    expect(s.drinkGross).toBeCloseTo(12);
    expect(s.foodGross).toBe(0);
  });

  it('uncategorized (null type) does not inflate food or meals', () => {
    const s = classifyDayRows([row('Mystery', null, 9, 99)]);
    expect(s.foodGross).toBe(0);
    expect(s.uncategorizedGross).toBeCloseTo(99);
    expect(s.meals).toBe(0);
  });

  it('event/space rental is "other", not food', () => {
    const s = classifyDayRows([row('Rental', 'TT Events / space rental', 1, 300)]);
    expect(s.otherGross).toBeCloseTo(300);
    expect(s.foodGross).toBe(0);
  });

  it('SR Event tokens stay a drink (token wins over event)', () => {
    const s = classifyDayRows([row('Tokens', 'SR Event tokens', 40, 200)]);
    expect(s.drinkGross).toBeCloseTo(200);
    expect(s.otherGross).toBe(0);
  });

  it('perMeal guards divide-by-zero', () => {
    expect(perMeal(100, 0)).toBeNull();
    expect(perMeal(300, 10)).toBe(30);
  });
});

describe('cumulativeByHour', () => {
  it('accumulates same-hour rows instead of overwriting', () => {
    const out = cumulativeByHour([{ hour: 12, gross: 100 }, { hour: 12, gross: 50 }, { hour: 13, gross: 30 }]);
    expect(out).toEqual([{ hour: 12, cum: 150 }, { hour: 13, cum: 180 }]);
  });
  it('returns [] for an empty day', () => {
    expect(cumulativeByHour([])).toEqual([]);
  });
});

describe('date helpers', () => {
  it('isoWeekDates returns Monday..Sunday', () => {
    const wk = isoWeekDates('2026-06-22'); // a Monday
    expect(wk[0]).toBe('2026-06-22');
    expect(wk[6]).toBe('2026-06-28');
    const wk2 = isoWeekDates('2026-06-25'); // a Thursday
    expect(wk2[0]).toBe('2026-06-22');
    expect(wk2[6]).toBe('2026-06-28');
  });
  it('shiftDate(-7) lands on the same weekday a week earlier', () => {
    expect(shiftDate('2026-06-22', -7)).toBe('2026-06-15');
  });
});

describe('cleanTargetsConfig', () => {
  it('keeps valid venue targets and bounds numbers', () => {
    const c = cleanTargetsConfig({ west: { foodPerMeal: 12.5, drinkPerMeal: 5, labourByDay: { Mon: 300, Tue: 280 } } });
    expect(c).toEqual({ west: { foodPerMeal: 12.5, drinkPerMeal: 5, labourByDay: { Mon: 300, Tue: 280 } } });
  });
  it('accepts 0 but rejects negative / NaN / Infinity / string / over-cap', () => {
    const c = cleanTargetsConfig({ west: { foodPerMeal: 0, drinkPerMeal: -1 }, centraal: { foodPerMeal: NaN, drinkPerMeal: Infinity }, testtafel: { foodPerMeal: '9' as unknown as number, drinkPerMeal: 99999 } });
    expect(c).toEqual({ west: { foodPerMeal: 0 } }); // -1, NaN, Infinity, '9', 99999(>1000) all dropped
  });
  it('drops unknown venues and non-weekday keys (allowlist → no prototype pollution)', () => {
    const c = cleanTargetsConfig({ bogus: { foodPerMeal: 5 }, west: { labourByDay: { Mon: 100, Funday: 50 } } });
    expect(c).toEqual({ west: { labourByDay: { Mon: 100 } } }); // 'bogus' venue + 'Funday' key dropped
    const polluted = cleanTargetsConfig(JSON.parse('{"west":{"labourByDay":{"__proto__":{"polluted":1},"Mon":7}}}'));
    expect(polluted).toEqual({ west: { labourByDay: { Mon: 7 } } });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined(); // prototype untouched
  });
  it('returns {} for null / array / string / non-object venue', () => {
    expect(cleanTargetsConfig(null)).toEqual({});
    expect(cleanTargetsConfig([1, 2])).toEqual({});
    expect(cleanTargetsConfig('nope')).toEqual({});
    expect(cleanTargetsConfig({ west: 5 })).toEqual({});
  });
});

describe('resolveTargetsForDay', () => {
  const cfg = cleanTargetsConfig({ west: { foodPerMeal: 12, drinkPerMeal: 4, labourByDay: { Mon: 300, Tue: 280, Sun: 150 } } });
  it('resolves the right weekday (Mon/Tue/Sun) for the venue', () => {
    expect(resolveTargetsForDay(cfg, 'west', '2026-06-22')).toEqual({ foodPerMeal: 12, drinkPerMeal: 4, labourToday: 300 }); // Mon
    expect(resolveTargetsForDay(cfg, 'west', '2026-06-23').labourToday).toBe(280); // Tue
    expect(resolveTargetsForDay(cfg, 'west', '2026-06-28').labourToday).toBe(150); // Sun
  });
  it('weekday stays correct across the Amsterdam DST boundary', () => {
    expect(resolveTargetsForDay(cfg, 'west', '2026-03-29').labourToday).toBe(150); // a Sunday
  });
  it('all-null for an unknown venue or a missing weekday target', () => {
    expect(resolveTargetsForDay(cfg, 'centraal', '2026-06-22')).toEqual({ foodPerMeal: null, drinkPerMeal: null, labourToday: null });
    expect(resolveTargetsForDay(cfg, 'west', '2026-06-24').labourToday).toBeNull(); // Wed (no target)
  });
  it('all-null when the config came from a malformed DB value', () => {
    expect(resolveTargetsForDay(cleanTargetsConfig(null), 'west', '2026-06-22')).toEqual({ foodPerMeal: null, drinkPerMeal: null, labourToday: null });
  });
});
