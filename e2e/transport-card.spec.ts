import { test, expect } from '@playwright/test';
import { loginAsDev } from './helpers';

test.describe('Transport card', () => {
  test('transport card renders on the West dashboard and mode toggle works', async ({ page }) => {
    await loginAsDev(page);
    // loginAsDev leaves the user on the dashboard at West location.
    // renderTransportCard() fires trackEvent('transport_card_shown') whenever
    // the dashboard is the visible screen.

    const card = page.locator('[data-testid="transport-card"]');
    await expect(card).toBeVisible();
    await expect(card).toContainText('Pack for Centraal');

    // The card always shows the readiness banner and mode toggle regardless of
    // whether any batches need shipping — verify the empty-state body too.
    await expect(card.locator('.tcard-mode-toggle')).toBeVisible();

    // Default mode is lean. Switching to bulk fires
    // trackEvent('transport_card_mode_toggled').
    await card.locator('button[data-mode="bulk"]').click();
    await expect(card.locator('button[data-mode="bulk"]')).toHaveClass(/active/);

    // Switch back to lean so the module-level _mode resets for the next test.
    await card.locator('button[data-mode="lean"]').click();
    await expect(card.locator('button[data-mode="lean"]')).toHaveClass(/active/);
  });
});
