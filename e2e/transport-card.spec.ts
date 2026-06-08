import { test, expect } from '@playwright/test';
import { loginAsDev } from './helpers';

test.describe('Transport card', () => {
  test('transport card is visible on West dashboard and mode toggle switches lean/bulk', async ({ page }) => {
    await loginAsDev(page);

    // The dashboard renders the transport card after loadPrepChecklist resolves.
    // Wait up to 10s for the card to appear in the DOM.
    const card = page.locator('[data-testid="transport-card"]');
    await expect(card).toBeVisible({ timeout: 10_000 });

    // The card always shows the Lean / Bulk-by-dish mode toggle on the West dashboard.
    const leanBtn = card.locator('[data-mode="lean"]');
    const bulkBtn = card.locator('[data-mode="bulk"]');
    await expect(leanBtn).toBeVisible();
    await expect(bulkBtn).toBeVisible();

    // Lean is the default active mode.
    await expect(leanBtn).toHaveClass(/active/);
    await expect(bulkBtn).not.toHaveClass(/active/);

    // Switch to bulk — this fires transport_card_mode_toggled and re-renders.
    await bulkBtn.click();
    // After re-render the card container is replaced; re-resolve through the testid.
    const cardAfter = page.locator('[data-testid="transport-card"]');
    await expect(cardAfter.locator('[data-mode="bulk"]')).toHaveClass(/active/, { timeout: 5_000 });
    await expect(cardAfter.locator('[data-mode="lean"]')).not.toHaveClass(/active/);
  });
});
