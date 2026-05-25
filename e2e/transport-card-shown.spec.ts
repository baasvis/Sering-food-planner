import { test, expect } from '@playwright/test';
import { loginAsDev } from './helpers';

// transport_card_shown fires when renderTransportCard() runs while the dashboard
// is the active screen (West location only). 184 sessions in the last 14 days;
// previously uncovered.
test.describe('Transport card', () => {
  test('transport card is visible on the West dashboard', async ({ page }) => {
    await loginAsDev(page);

    // loginAsDev lands on the dashboard as West — transport card renders here.
    const card = page.locator('[data-testid="transport-card"]');
    await expect(card).toBeVisible({ timeout: 10_000 });

    // The card title should include the pack-for-Centraal heading.
    await expect(card).toContainText('Pack for Centraal');

    // The lean/bulk mode toggle is always present.
    const modeToggle = card.locator('[role="group"][aria-label="Pack mode"]');
    await expect(modeToggle).toBeVisible();
    await expect(modeToggle.locator('[data-mode="lean"]')).toBeVisible();
    await expect(modeToggle.locator('[data-mode="bulk"]')).toBeVisible();

    // Default mode is lean.
    await expect(modeToggle.locator('[data-mode="lean"]')).toHaveClass(/active/);
  });

  test('switching to bulk mode re-renders the transport card', async ({ page }) => {
    await loginAsDev(page);

    const card = page.locator('[data-testid="transport-card"]');
    await expect(card).toBeVisible({ timeout: 10_000 });

    const modeToggle = card.locator('[role="group"][aria-label="Pack mode"]');
    const bulkBtn = modeToggle.locator('[data-mode="bulk"]');
    const leanBtn = modeToggle.locator('[data-mode="lean"]');

    // Switch to bulk — fires transport_card_mode_toggled.
    await bulkBtn.click();
    await expect(bulkBtn).toHaveClass(/active/);
    await expect(leanBtn).not.toHaveClass(/active/);

    // Switch back to lean.
    await leanBtn.click();
    await expect(leanBtn).toHaveClass(/active/);
    await expect(bulkBtn).not.toHaveClass(/active/);
  });
});
