import { test, expect } from '@playwright/test';
import { loginAsDev } from './helpers';

const TEST_FEEDBACK_PREFIX = 'e2e-test-feedback-';

test.describe('Feedback submit', () => {
  // The /api/feedback API has no DELETE endpoint — only POST and PATCH for
  // marking processed. After the test, mark our feedback as processed so it
  // disappears from the unprocessed-feedback view, but the row stays in the
  // staging DB. Acceptable: feedback rows are tiny and staging isn't sacred.
  test.afterEach(async ({ page }) => {
    if (!page.url().startsWith('http')) return;
    await page.evaluate(async (prefix) => {
      const res = await fetch('/api/feedback');
      if (!res.ok) return;
      const all = (await res.json()) as Array<{ id: number; text: string }>;
      const matches = all.filter((f) => f.text && f.text.startsWith(prefix));
      await Promise.all(
        matches.map((f) =>
          fetch(`/api/feedback/${f.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ processed: true }),
          }),
        ),
      );
    }, TEST_FEEDBACK_PREFIX);
  });

  test('user submits feedback via the FAB', async ({ page }) => {
    await loginAsDev(page);

    // The feedback FAB only shows after login. Click to open the modal.
    await expect(page.locator('#feedback-fab')).toBeVisible();
    await page.locator('#feedback-fab').click();

    // The modal renders a "What kind of feedback?" form. Pick "New idea".
    await expect(page.locator('#ft-idea')).toBeVisible();
    await page.locator('#ft-idea').click();

    // Fill the textarea with a recognisable marker so afterEach can find it.
    const feedbackText = `${TEST_FEEDBACK_PREFIX}${Date.now()}-thanks for this app`;
    await page.fill('#feedback-text', feedbackText);

    // submitFeedback POSTs to /api/feedback. Capture the request to assert
    // the right payload made it across — proves end-to-end (form → state →
    // POST body → server).
    const postPromise = page.waitForRequest(
      (req) => req.url().endsWith('/api/feedback') && req.method() === 'POST',
      { timeout: 5_000 },
    );

    await page.locator('[data-testid="feedback-submit-btn"]').click();

    const req = await postPromise;
    const body = JSON.parse(req.postData() || '{}') as { text?: string; type?: string };
    expect(body.text).toBe(feedbackText);
    expect(body.type).toBe('idea');

    // submitFeedback closes the modal and shows a thank-you toast on success.
    await expect(page.locator('#toast')).toContainText('Thanks for the feedback', { timeout: 5_000 });

    // GET /api/feedback should return the row we just created.
    const found = await page.evaluate(async (text) => {
      const r = await fetch('/api/feedback');
      const all = (await r.json()) as Array<{ text: string }>;
      return all.some((f) => f.text === text);
    }, feedbackText);
    expect(found).toBe(true);
  });
});
