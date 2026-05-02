import { test, expect } from '@playwright/test';
import { loginAsDev } from './helpers';

const TEST_VALUE = 9876;

test.describe('Guests', () => {
  // The /api/guests-next-weeks endpoint replaces all next-weeks data on POST.
  // We snapshot the current state, run the test, then POST the snapshot back
  // so other tests (and casual staging-DB inspections) don't see test cruft.
  let originalNextWeeks: unknown = null;

  test.afterEach(async ({ page }) => {
    if (originalNextWeeks === null) return;
    if (!page.url().startsWith('http')) return;
    await page.evaluate(async (snapshot) => {
      await fetch('/api/guests-next-weeks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(snapshot),
      });
    }, originalNextWeeks);
    originalNextWeeks = null;
  });

  test('user edits a guest count for a future week and it persists', async ({ page }) => {
    await loginAsDev(page);

    // Snapshot current next-weeks state so we can restore it after the test.
    originalNextWeeks = await page.evaluate(async () => {
      const r = await fetch('/api/guests-next-weeks');
      return r.ok ? await r.json() : {};
    });

    await page.locator('.nav-btn[data-screen="guests"]').click();
    await expect(page.locator('.guests-grid')).toBeVisible();

    // Navigate the day window forward 7 days. With offset=7 the first visible
    // day is always in next week regardless of which weekday "today" is, so
    // edits route to scheduleNextWeeksSave (not the current-week save).
    const nextDayBtn = page.locator('.gt-nav-btn').last();
    for (let i = 0; i < 7; i++) await nextDayBtn.click();

    // First guest input = lunch / first visible day / Sering West (first card).
    // Set value + fire change in the page context. Playwright's fill() emits
    // input but not change, and the inline onchange="updateGuestsNextWeek(...)"
    // kicks off scheduleNextWeeksSave. Doing both atomically avoids the stale
    // element reference that the re-render from the change handler creates.
    const firstInput = page.locator('.gt-input').first();
    await firstInput.evaluate((el, val) => {
      const input = el as HTMLInputElement;
      input.value = val;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, String(TEST_VALUE));

    // scheduleNextWeeksSave debounces ~1.5s, then POSTs. Wait for that POST
    // and verify the body contains our test value — proves the round-trip
    // worked end-to-end (event handler → state → debounced save → wire).
    const postedReq = await page.waitForRequest(
      (req) => req.url().endsWith('/api/guests-next-weeks') && req.method() === 'POST',
      { timeout: 10_000 },
    );
    expect(postedReq.postData()).toContain(String(TEST_VALUE));

    // And the persisted GET reflects what was POSTed.
    await expect(page.locator('#save-text')).toHaveText('Saved', { timeout: 5_000 });
    const data = await page.evaluate(async () => {
      const r = await fetch('/api/guests-next-weeks');
      return r.ok ? await r.json() : {};
    });
    expect(JSON.stringify(data)).toContain(String(TEST_VALUE));
  });
});
