import { test, expect } from '@playwright/test';
import { loginAsDev } from './helpers';

// The transport card ("Pack for Centraal") lives on the West dashboard only.
// It fires transport_card_shown on every render and transport_card_mode_toggled
// when the user switches between Lean and Bulk-by-dish pack modes.
// These events are the highest-frequency uncovered telemetry features (164 and
// 3 sessions respectively in the last 14 days).

test.describe('Transport card', () => {
  test('card renders on West dashboard and mode toggle switches between Lean and Bulk', async ({ page }) => {
    await loginAsDev(page);

    // loginAsDev selects "West" — the transport card only renders on the West
    // dashboard, so it must be visible after login.
    const card = page.locator('[data-testid="transport-card"]');
    await expect(card).toBeVisible({ timeout: 10_000 });

    // Card title includes the 🚚 icon and "Pack for Centraal" label.
    await expect(card.locator('.dash-card-title')).toContainText('Pack for Centraal');

    // The mode toggle is present with Lean active by default.
    const leanBtn = card.locator('.tcard-mode-btn[data-mode="lean"]');
    const bulkBtn = card.locator('.tcard-mode-btn[data-mode="bulk"]');
    await expect(leanBtn).toBeVisible();
    await expect(bulkBtn).toBeVisible();
    await expect(leanBtn).toHaveClass(/active/);
    await expect(bulkBtn).not.toHaveClass(/active/);

    // Switching to Bulk-by-dish fires transport_card_mode_toggled and
    // re-renders the card. The Bulk button should become active.
    await bulkBtn.click();
    // Wait for the re-render — the card title stays stable but the active
    // class flips. Give it a moment for rerenderCurrentView() to complete.
    await expect(bulkBtn).toHaveClass(/active/, { timeout: 5_000 });
    await expect(leanBtn).not.toHaveClass(/active/);

    // Switching back to Lean resets the mode.
    await leanBtn.click();
    await expect(leanBtn).toHaveClass(/active/, { timeout: 5_000 });
    await expect(bulkBtn).not.toHaveClass(/active/);

    // The card body shows either a pack list (if packable batches exist in the
    // staging DB) or the empty-state message — both are valid.
    const hasRows = await card.locator('.tcard-rows').count();
    const hasEmpty = await card.locator('.tcard-empty').count();
    expect(hasRows + hasEmpty).toBeGreaterThan(0);
  });
});
