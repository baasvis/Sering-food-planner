import { test, expect } from '@playwright/test';
import { loginAsDev } from './helpers';

test.describe('Transport card', () => {
  test('transport card is visible on the West dashboard and mode toggle works', async ({ page }) => {
    await loginAsDev(page);

    // The transport card renders on the West dashboard immediately after login.
    // Its presence proves transport_card_shown was fired (it trackEvents inside renderTransportCard).
    const card = page.locator('[data-testid="transport-card"]');
    await expect(card).toBeVisible({ timeout: 10_000 });

    // Lean mode is the default — the Lean button should carry the `active` class.
    const leanBtn = card.locator('[data-mode="lean"]');
    const bulkBtn = card.locator('[data-mode="bulk"]');
    await expect(leanBtn).toHaveClass(/active/);
    await expect(bulkBtn).not.toHaveClass(/active/);

    // Toggling to Bulk-by-dish fires transport_card_mode_toggled and re-renders.
    await bulkBtn.click();
    await expect(bulkBtn).toHaveClass(/active/, { timeout: 5_000 });
    await expect(leanBtn).not.toHaveClass(/active/);

    // Toggle back to Lean to leave the card in its default state.
    await leanBtn.click();
    await expect(leanBtn).toHaveClass(/active/, { timeout: 5_000 });
  });
});
