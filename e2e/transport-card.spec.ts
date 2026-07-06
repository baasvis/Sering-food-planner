import { test, expect } from '@playwright/test';
import { loginAsDev } from './helpers';

test.describe('Transport card', () => {
  // The transport card lives on the West dashboard only — West→Centraal direction.
  // No data is created, so there is nothing to clean up.

  test('transport card is shown on the West dashboard', async ({ page }) => {
    await loginAsDev(page);

    // loginAsDev places us on the West dashboard after data loads. The
    // transport card renders in the left column of the dashboard for the West
    // location and fires trackEvent('transport_card_shown') in the process.
    const card = page.locator('[data-testid="transport-card"]');
    await expect(card).toBeVisible({ timeout: 10_000 });

    // Title is always present regardless of whether dishes are queued.
    await expect(card).toContainText('Pack for Centraal');

    // Both mode-toggle buttons (Lean / Bulk-by-dish) are rendered.
    await expect(card.locator('button[data-mode="lean"]')).toBeVisible();
    await expect(card.locator('button[data-mode="bulk"]')).toBeVisible();

    // With a clean staging DB there are no Centraal-bound batches — the card
    // shows an empty-state notice. Verify it rather than the cooked-rows path.
    await expect(card).toContainText('Nothing scheduled to leave for Centraal');
  });

  test('transport card is absent on the Centraal dashboard', async ({ page }) => {
    // The transport card must NOT render when the user has selected Centraal —
    // renderTransportCard() returns '' for non-West locations.
    await page.goto('/');
    await page.locator('#dev-login-btn').click();

    const waits = [
      page.waitForResponse((r) => r.url().endsWith('/api/data') && r.request().method() === 'GET', { timeout: 15_000 }),
      page.waitForResponse((r) => r.url().endsWith('/api/guests-next-weeks') && r.request().method() === 'GET', { timeout: 15_000 }),
      page.waitForResponse((r) => r.url().endsWith('/api/guest-history') && r.request().method() === 'GET', { timeout: 15_000 }),
    ];
    // Choose Centraal instead of West.
    await page.getByTestId('loc-choose-centraal').click();
    await Promise.all(waits);

    await expect(page.locator('.nav-btn[data-screen="dashboard"]')).toBeVisible();

    // The transport card container must not be in the DOM for Centraal.
    await expect(page.locator('[data-testid="transport-card"]')).toHaveCount(0);
  });
});
