// Unit tests for the pure drinks helpers (no DB): JSON normalization, BTW
// auto-set, per-(drink,location) stock aggregation, config merge, validation.

import {
  normalizeFormats, normalizeLocations, effectiveBtw, buildStockMap, mergeConfig,
  validateDrinkInput, DEFAULT_DRINK_CONFIG,
} from '../lib/drinks';

describe('normalizeFormats', () => {
  it('keeps an unset (null/empty) price as null — never coerces to 0', () => {
    const [f] = normalizeFormats([{ name: 'can', volumeMl: 330, price: { west: 3, centraal: null } }] as never);
    expect(f.price.west).toBe(3);
    expect(f.price.centraal).toBeNull();
  });
  it('treats empty-string price as null', () => {
    const [f] = normalizeFormats([{ name: 'glass', volumeMl: 120, price: { west: '' } }] as never);
    expect(f.price.west).toBeNull();
  });
  it('returns [] for non-array / garbage input', () => {
    expect(normalizeFormats(null as never)).toEqual([]);
    expect(normalizeFormats({} as never)).toEqual([]);
  });
  it('defaults missing volume to 0 and carries the glass through', () => {
    const [f] = normalizeFormats([{ name: 'shot', glass: 'Tumbler', price: {} }] as never);
    expect(f.volumeMl).toBe(0);
    expect(f.glass).toBe('Tumbler');
  });
});

describe('normalizeLocations', () => {
  it('keeps null par and defaults active to true', () => {
    const l = normalizeLocations({ west: { par: 16 }, centraal: { par: null, active: false } } as never);
    expect(l.west.par).toBe(16);
    expect(l.west.active).toBe(true);
    expect(l.centraal.par).toBeNull();
    expect(l.centraal.active).toBe(false);
  });
  // Regression: the active toggle once dropped `area` when rebuilding the
  // per-location object — area must survive a round trip through normalize.
  it('carries the home storage area through, treating empty/missing as unset', () => {
    const l = normalizeLocations({
      west: { par: 4, active: true, area: 'Keg Storage' },
      centraal: { par: 2, active: true, area: '' },
    } as never);
    expect(l.west.area).toBe('Keg Storage');
    expect(l.centraal.area).toBeUndefined();
  });
});

describe('effectiveBtw', () => {
  const cfg = DEFAULT_DRINK_CONFIG;
  it('auto = 21% for alcoholic (abv >= 0.5)', () => {
    expect(effectiveBtw(5, null, cfg)).toBe(21);
    expect(effectiveBtw(0.5, null, cfg)).toBe(21);
  });
  it('auto = 9% for non-alcoholic (abv < 0.5, incl 0.0% beer)', () => {
    expect(effectiveBtw(0.4, null, cfg)).toBe(9);
    expect(effectiveBtw(0, null, cfg)).toBe(9);
  });
  it('explicit override wins over the auto rule', () => {
    expect(effectiveBtw(5, 9, cfg)).toBe(9);
    expect(effectiveBtw(0, 21, cfg)).toBe(21);
  });
});

describe('buildStockMap', () => {
  it('builds { drinkId: { location: poolQty } } and treats null sum as 0', () => {
    const map = buildStockMap([
      { drinkId: 'a', location: 'west', _sum: { qty: 5 } },
      { drinkId: 'a', location: 'centraal', _sum: { qty: null } },
      { drinkId: 'b', location: 'west', _sum: { qty: 2.5 } },
    ]);
    expect(map.a.west).toBe(5);
    expect(map.a.centraal).toBe(0);
    expect(map.b.west).toBe(2.5);
  });
});

describe('mergeConfig', () => {
  it('fills every field from defaults when stored is empty', () => {
    const c = mergeConfig({});
    expect(c.labourRatePerMin).toBe(DEFAULT_DRINK_CONFIG.labourRatePerMin);
    expect(c.btwRule.alcoholic).toBe(21);
    expect(c.markupTargets.defaultMultiple).toBe(4.0);
  });
  it('preserves null per-category markup targets (reverse-engineered later)', () => {
    const c = mergeConfig({ markupTargets: { defaultMultiple: 4, beer: null, wine: 3.2 } });
    expect(c.markupTargets.beer).toBeNull();
    expect(c.markupTargets.wine).toBe(3.2);
  });
  it('overrides scalars that are present', () => {
    const c = mergeConfig({ labourRatePerMin: 0.27, demandNudgeThresholdPct: 30 });
    expect(c.labourRatePerMin).toBe(0.27);
    expect(c.demandNudgeThresholdPct).toBe(30);
  });
});

describe('validateDrinkInput', () => {
  it('throws on missing/invalid required fields', () => {
    expect(() => validateDrinkInput({}, true)).toThrow();
    expect(() => validateDrinkInput({ id: 'x', name: 'Beer', mode: 'bogus', category: 'beer' }, true)).toThrow();
    expect(() => validateDrinkInput({ id: 'x', name: 'Beer', mode: 'catalogue' }, true)).toThrow(); // no category
  });
  it('accepts a valid catalogue drink', () => {
    expect(() => validateDrinkInput({ id: 'drink-x', name: 'Pils', mode: 'catalogue', category: 'beer', abv: 5 }, true)).not.toThrow();
  });
  it('requires a valid id only when requireId is set', () => {
    expect(() => validateDrinkInput({ name: 'Pils', mode: 'catalogue', category: 'beer' }, false)).not.toThrow();
    expect(() => validateDrinkInput({ id: 'bad id!', name: 'Pils', mode: 'catalogue', category: 'beer' }, true)).toThrow();
  });
});
