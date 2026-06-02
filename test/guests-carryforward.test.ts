/**
 * Carry-forward of week-specific guest counts into the current week (2026-06 fix).
 *
 * The bug: a count entered for an upcoming week (stored in S.guestsNextWeeks under
 * that week's Monday key) was silently dropped the moment the week became *current*
 * — getGuests switched to the base weekday pattern (S.guests) and ignored the
 * entry. So "240 guests this Tuesday" entered last week reverted to the default 222
 * once the week arrived, and Fix My Menu under-planned with no signal.
 *
 * The fix: for the current week, getGuests prefers the carried-forward value if
 * present, else the base pattern. A manual edit clears the carried value (see
 * updateGuests), so an edit still wins. This suite locks the read precedence.
 */
import { getGuests } from '../public/js/core';
import { S } from '../public/js/state';

// Pin "today" to Tue 2026-06-02 → current week's Monday key is 2026-06-01.
beforeAll(() => { jest.useFakeTimers(); jest.setSystemTime(new Date('2026-06-02T12:00:00Z')); });
afterAll(() => { jest.useRealTimers(); });

beforeEach(() => {
  S.guests = { west: {}, centraal: { Tue: { lunch: 87, dinner: 222 } } } as any; // base weekday pattern
  S.guestsNextWeeks = {} as any;
  S.predictions = {} as any;
});

test('current week: a carried-forward value is used over the base pattern', () => {
  S.guestsNextWeeks = { '2026-06-01': { centraal: { Tue: { dinner: 240 } } } } as any;
  expect(getGuests('centraal', '2026-06-02', 'dinner')).toBe(240); // carried forward, not base 222
  expect(getGuests('centraal', '2026-06-02', 'lunch')).toBe(87);   // no carried value → base pattern
});

test('current week: with no carried value, the base pattern is used', () => {
  expect(getGuests('centraal', '2026-06-02', 'dinner')).toBe(222);
});

test('current week: a manual edit (base set + carried value cleared) wins', () => {
  // Mirrors updateGuests: it writes base and deletes the carried cell.
  S.guestsNextWeeks = { '2026-06-01': { centraal: { Tue: {} } } } as any; // dinner cleared
  (S.guests as any).centraal.Tue.dinner = 250;                            // the edit
  expect(getGuests('centraal', '2026-06-02', 'dinner')).toBe(250);
});

test('a FUTURE week still reads its own next-weeks entry (unchanged behavior)', () => {
  S.guestsNextWeeks = { '2026-06-08': { centraal: { Mon: { dinner: 300 } } } } as any;
  expect(getGuests('centraal', '2026-06-08', 'dinner')).toBe(300);
});
