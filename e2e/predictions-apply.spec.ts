import { test, expect } from '@playwright/test';
import { loginAsDev } from './helpers';

const TEST_VALUE = 1234;

/**
 * applyPredictions reads S.predictions (populated by uploading a CSV of POS
 * data) and writes those numbers into S.guests / S.guestsNextWeeks. End-to-
 * end testing the CSV upload would need a Tebi/Lightspeed-format fixture
 * which is a separate piece of work — instead this test populates
 * S.predictions directly via page.evaluate (still real DOM/state, just
 * skipping the parse step) and verifies the apply transition end-to-end:
 * button appears, click fires the handler, future-week save POST contains
 * the predicted values, GET reflects them.
 */
test.describe('Predictions apply', () => {
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

  test('user applies predictions to a future-week guest table', async ({ page }) => {
    await loginAsDev(page);

    originalNextWeeks = await page.evaluate(async () => {
      const r = await fetch('/api/guests-next-weeks');
      return r.ok ? await r.json() : {};
    });

    // loginAsDev already awaited the initial /api/guests-next-weeks GET, so
    // navigating here is safe — no late response will clobber our edits.
    await page.locator('.nav-btn[data-screen="guests"]').click();
    await expect(page.locator('.guests-grid')).toBeVisible();

    // Move the day window forward 7 days so writes route to
    // scheduleNextWeeksSave (which we can snapshot/restore) instead of
    // scheduleSave (which mutates current-week production state).
    const nextDayBtn = page.locator('.gt-nav-btn').last();
    for (let i = 0; i < 7; i++) await nextDayBtn.click();

    // Populate S.predictions with a value the apply logic will route into
    // every day/meal cell, then call renderGuests so the "Apply predictions"
    // button (which only renders when S.predictions truthy) appears.
    await page.evaluate((val) => {
      const w = window as unknown as { S?: Record<string, unknown>; renderGuests?: () => void };
      const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
      const meals = ['lunch', 'dinner'];
      const mkLoc = () => Object.fromEntries(
        days.map((d) => [d, Object.fromEntries(meals.map((m) => [m, val]))]),
      );
      if (w.S) w.S.predictions = { west: mkLoc(), centraal: mkLoc() };
      w.renderGuests?.();
    }, TEST_VALUE);

    // Click Apply — applyPredictions iterates visible days and writes the
    // predicted value into S.guestsNextWeeks (since visible days are next
    // week), then schedules the next-weeks save (1.5s debounce).
    await page.locator('[data-testid="apply-predictions-btn"]').click();

    // Verify the POST body contains our test value (proves the round-trip:
    // S.predictions → applyPredictions → S.guestsNextWeeks → POST body).
    const postedReq = await page.waitForRequest(
      (req) => req.url().endsWith('/api/guests-next-weeks') && req.method() === 'POST',
      { timeout: 10_000 },
    );
    expect(postedReq.postData()).toContain(String(TEST_VALUE));

    // Save indicator flips back to "Saved" once the POST completes.
    await expect(page.locator('#save-text')).toHaveText('Saved', { timeout: 5_000 });

    // GET reflects the persisted value.
    const data = await page.evaluate(async () => {
      const r = await fetch('/api/guests-next-weeks');
      return r.ok ? await r.json() : {};
    });
    expect(JSON.stringify(data)).toContain(String(TEST_VALUE));
  });
});
