import { test, expect } from '@playwright/test';
import { loginAsDev } from './helpers';

test.describe('Transport card', () => {
  test('transport card renders on West dashboard and mode toggle works', async ({ page }) => {
    await loginAsDev(page);

    // The dashboard is the default screen after login. The transport card is
    // West-only, and loginAsDev selects West, so it should appear immediately.
    const card = page.locator('[data-testid="transport-card"]');
    await expect(card).toBeVisible();

    // Card title is always present regardless of how many rows exist.
    await expect(card.locator('.dash-card-title')).toContainText('Pack for Centraal');

    // Mode toggle starts in Lean mode.
    const leanBtn = page.locator('[data-testid="transport-mode-lean"]');
    const bulkBtn = page.locator('[data-testid="transport-mode-bulk"]');
    await expect(leanBtn).toHaveClass(/active/);
    await expect(bulkBtn).not.toHaveClass(/active/);

    // Switch to Bulk-by-dish mode — fires transport_card_mode_toggled.
    await bulkBtn.click();
    await expect(bulkBtn).toHaveClass(/active/);
    await expect(leanBtn).not.toHaveClass(/active/);

    // Switch back to Lean.
    await leanBtn.click();
    await expect(leanBtn).toHaveClass(/active/);
    await expect(bulkBtn).not.toHaveClass(/active/);
  });
});
