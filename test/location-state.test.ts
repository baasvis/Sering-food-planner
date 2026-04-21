/**
 * Unit tests for location persistence (setGlobalLocation / restoreGlobalLocation).
 *
 * Regression: on page reload the nav label showed the default 'west' even when
 * localStorage had 'centraal' saved, because bootstrap() called buildNav()
 * before restoreGlobalLocation(). Fix: restoreGlobalLocation() is now called
 * first in bootstrap() so buildNav() renders the correct label.
 */

// Provide a localStorage stub before importing the module under test.
// Jest runs in Node where localStorage is not defined.
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

import { S, setGlobalLocation, restoreGlobalLocation } from '../public/js/state';

beforeEach(() => {
  // Reset localStorage and state to default before each test
  localStorage.clear();
  S.currentLoc = 'west';
});

describe('setGlobalLocation', () => {
  it('updates S.currentLoc', () => {
    setGlobalLocation('centraal');
    expect(S.currentLoc).toBe('centraal');
  });

  it('persists to localStorage', () => {
    setGlobalLocation('centraal');
    expect(localStorage.getItem('sering-location')).toBe('centraal');
  });

  it('round-trips west', () => {
    setGlobalLocation('west');
    expect(S.currentLoc).toBe('west');
    expect(localStorage.getItem('sering-location')).toBe('west');
  });
});

describe('restoreGlobalLocation', () => {
  it('returns false and leaves currentLoc unchanged when nothing is saved', () => {
    S.currentLoc = 'west';
    expect(restoreGlobalLocation()).toBe(false);
    expect(S.currentLoc).toBe('west');
  });

  it('restores "centraal" from localStorage into S.currentLoc', () => {
    localStorage.setItem('sering-location', 'centraal');
    S.currentLoc = 'west'; // simulate default state before restore
    const restored = restoreGlobalLocation();
    expect(restored).toBe(true);
    expect(S.currentLoc).toBe('centraal');
  });

  it('restores "west" from localStorage', () => {
    localStorage.setItem('sering-location', 'west');
    S.currentLoc = 'centraal';
    expect(restoreGlobalLocation()).toBe(true);
    expect(S.currentLoc).toBe('west');
  });

  it('ignores invalid values in localStorage', () => {
    localStorage.setItem('sering-location', 'invalid-loc');
    S.currentLoc = 'west';
    expect(restoreGlobalLocation()).toBe(false);
    expect(S.currentLoc).toBe('west');
  });
});

describe('bootstrap label bug regression', () => {
  it('S.currentLoc matches the saved location before buildNav would run', () => {
    // Simulate: user last used centraal, then reloads.
    // Before the fix, buildNav() ran with S.currentLoc = 'west' (default).
    // After the fix, restoreGlobalLocation() runs first so S.currentLoc = 'centraal'.
    setGlobalLocation('centraal');    // saved on previous session
    S.currentLoc = 'west';           // reset to default (fresh module load)

    restoreGlobalLocation();          // this is now called before buildNav()

    expect(S.currentLoc).toBe('centraal'); // nav label would render correctly
  });
});
