import { test, expect } from '@playwright/test';
import { loginAsDev } from './helpers';

test.describe('Transport card', () => {
  test('transport card is visible on the West dashboard', async ({ page }) => {
    await loginAsDev(page);

    // loginAsDev selects West — the transport card only renders for West.
    // Arriving on the dashboard fires trackEvent('transport_card_shown').
    const card = page.locator('[data-testid="transport-card"]');
    await expect(card).toBeVisible();

    // The mode toggle is always present regardless of whether rows are shown.
    await expect(page.locator('[data-testid="transport-mode-lean"]')).toBeVisible();
    await expect(page.locator('[data-testid="transport-mode-bulk"]')).toBeVisible();

    // Lean is the default active mode.
    await expect(page.locator('[data-testid="transport-mode-lean"]')).toHaveClass(/active/);
    await expect(page.locator('[data-testid="transport-mode-bulk"]')).not.toHaveClass(/active/);
  });

  test('mode toggle switches between lean and bulk', async ({ page }) => {
    await loginAsDev(page);

    // Switch to bulk mode — fires trackEvent('transport_card_mode_toggled').
    await page.locator('[data-testid="transport-mode-bulk"]').click();

    // After the re-render the bulk button should be active.
    await expect(page.locator('[data-testid="transport-mode-bulk"]')).toHaveClass(/active/);
    await expect(page.locator('[data-testid="transport-mode-lean"]')).not.toHaveClass(/active/);

    // The card remains on screen and fires transport_card_shown again.
    await expect(page.locator('[data-testid="transport-card"]')).toBeVisible();

    // Switch back to lean.
    await page.locator('[data-testid="transport-mode-lean"]').click();
    await expect(page.locator('[data-testid="transport-mode-lean"]')).toHaveClass(/active/);
  });
});
