/**
 * Unit tests for the location registry helpers (event-locations feature):
 *   - shared/location.ts: locName / shortLocName / isPermanentLocation /
 *     setLocationRegistry (registry-aware display resolution)
 *   - public/js/state.ts: activeEventLocations / allActiveLocations /
 *     isEventLoc / eventLocById
 *
 * The regression contract: with an EMPTY registry, locName must be
 * bit-identical to the old two-location ternary for 'west'/'centraal'.
 */

// Provide a localStorage stub before importing state (Jest runs in Node).
const store: Record<string, string> = {};
Object.defineProperty(global, 'localStorage', {
  value: {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { Object.keys(store).forEach(k => delete store[k]); },
  },
  writable: true,
});

import type { EventLocationDTO } from '../shared/types';
import {
  PERMANENT_LOCATIONS, RESERVED_LOCATION_KEYS,
  isPermanentLocation, locName, shortLocName,
  setLocationRegistry, getLocationRegistry,
} from '../shared/location';
import { S, activeEventLocations, allActiveLocations, isEventLoc, eventLocById } from '../public/js/state';

const evRow = (over: Partial<EventLocationDTO> = {}): EventLocationDTO => ({
  slug: 'ev-landjuweel-2026',
  name: 'Landjuweel 2026',
  startDate: '2026-07-20',
  endDate: '2026-07-30',
  hanosAccount: 'west',
  archived: false,
  createdAt: '2026-07-16T10:00:00.000Z',
  archivedAt: null,
  ...over,
});

beforeEach(() => {
  setLocationRegistry([]);
  S.eventLocations = [];
});

describe('constants', () => {
  it('PERMANENT_LOCATIONS is exactly west + centraal', () => {
    expect([...PERMANENT_LOCATIONS]).toEqual(['west', 'centraal']);
  });

  it('RESERVED_LOCATION_KEYS covers permanent keys and the Hub venue key', () => {
    expect(RESERVED_LOCATION_KEYS).toContain('west');
    expect(RESERVED_LOCATION_KEYS).toContain('centraal');
    expect(RESERVED_LOCATION_KEYS).toContain('testtafel');
  });
});

describe('isPermanentLocation', () => {
  it('accepts the two permanent keys', () => {
    expect(isPermanentLocation('west')).toBe(true);
    expect(isPermanentLocation('centraal')).toBe(true);
  });

  it('rejects event slugs and arbitrary strings', () => {
    expect(isPermanentLocation('ev-landjuweel-2026')).toBe(false);
    expect(isPermanentLocation('testtafel')).toBe(false);
    expect(isPermanentLocation('')).toBe(false);
  });
});

describe('locName', () => {
  it('is bit-identical to the legacy labels for west/centraal (empty registry)', () => {
    expect(locName('west')).toBe('Sering West');
    expect(locName('centraal')).toBe('Sering Centraal');
  });

  it('is bit-identical for west/centraal even with a populated registry', () => {
    setLocationRegistry([evRow()]);
    expect(locName('west')).toBe('Sering West');
    expect(locName('centraal')).toBe('Sering Centraal');
  });

  it('resolves an active event slug to its registry name', () => {
    setLocationRegistry([evRow()]);
    expect(locName('ev-landjuweel-2026')).toBe('Landjuweel 2026');
  });

  it('resolves an ARCHIVED event slug too (historical data keeps rendering)', () => {
    setLocationRegistry([evRow({ archived: true, archivedAt: '2026-08-01T00:00:00.000Z' })]);
    expect(locName('ev-landjuweel-2026')).toBe('Landjuweel 2026');
  });

  it('falls back to the raw key for unknown values (NOT "Sering Centraal")', () => {
    expect(locName('ev-unknown')).toBe('ev-unknown');
    expect(locName('mystery')).toBe('mystery');
  });
});

describe('shortLocName', () => {
  it('keeps the W/C letters for permanent locations', () => {
    expect(shortLocName('west')).toBe('W');
    expect(shortLocName('centraal')).toBe('C');
  });

  it('abbreviates a two-word event name by initials', () => {
    setLocationRegistry([evRow()]);
    expect(shortLocName('ev-landjuweel-2026')).toBe('L2');
  });

  it('abbreviates a one-word event name by its first two characters', () => {
    setLocationRegistry([evRow({ slug: 'ev-festival', name: 'Festival' })]);
    expect(shortLocName('ev-festival')).toBe('FE');
  });

  it('degrades to the de-prefixed slug for unknown keys', () => {
    expect(shortLocName('ev-mystery-fest')).toBe('MY');
  });
});

describe('setLocationRegistry / getLocationRegistry', () => {
  it('stores a defensive copy', () => {
    const rows = [evRow()];
    setLocationRegistry(rows);
    rows.push(evRow({ slug: 'ev-other', name: 'Other' }));
    expect(getLocationRegistry()).toHaveLength(1);
  });
});

describe('state registry helpers', () => {
  const active = evRow();
  const archived = evRow({ slug: 'ev-oldfest-2025', name: 'Oldfest 2025', archived: true, archivedAt: '2025-09-01T00:00:00.000Z' });

  it('default state has no event locations and allActiveLocations = permanent pair', () => {
    expect(activeEventLocations()).toEqual([]);
    expect(allActiveLocations()).toEqual(['west', 'centraal']);
  });

  it('activeEventLocations filters out archived rows', () => {
    S.eventLocations = [active, archived];
    expect(activeEventLocations().map(e => e.slug)).toEqual(['ev-landjuweel-2026']);
  });

  it('allActiveLocations appends active event slugs after the permanent pair', () => {
    S.eventLocations = [active, archived];
    expect(allActiveLocations()).toEqual(['west', 'centraal', 'ev-landjuweel-2026']);
  });

  it('isEventLoc is true for active AND archived slugs (guards must spare both)', () => {
    S.eventLocations = [active, archived];
    expect(isEventLoc('ev-landjuweel-2026')).toBe(true);
    expect(isEventLoc('ev-oldfest-2025')).toBe(true);
    expect(isEventLoc('west')).toBe(false);
    expect(isEventLoc('ev-nope')).toBe(false);
  });

  it('eventLocById returns the row or undefined', () => {
    S.eventLocations = [active];
    expect(eventLocById('ev-landjuweel-2026')?.name).toBe('Landjuweel 2026');
    expect(eventLocById('ev-nope')).toBeUndefined();
  });
});
