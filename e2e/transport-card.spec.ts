import { test, expect } from '@playwright/test';
import { loginAsDev } from './helpers';

test.describe('Transport card', () => {
  test('transport card renders on the West dashboard with mode toggle', async ({ page }) => {
    // loginAsDev selects West location and waits for the initial data load.
    // renderTransportCard() fires trackEvent('transport_card_shown') whenever
    // the card is on screen, so navigating to the West dashboard is enough
    // to cover the feature — the card always renders (empty-state or with rows).
    await loginAsDev(page);

    const card = page.getByTestId('transport-card');
    await expect(card).toBeVisible();

    // The card title names the destination.
    await expect(card.locator('.dash-card-title')).toContainText('Pack for Centraal');

    // The Lean / Bulk-by-dish mode toggle must always be present.
    const leanBtn = card.locator('.tcard-mode-btn[data-mode="lean"]');
    const bulkBtn = card.locator('.tcard-mode-btn[data-mode="bulk"]');
    await expect(leanBtn).toBeVisible();
    await expect(bulkBtn).toBeVisible();

    // "Lean" is the default active mode.
    await expect(leanBtn).toHaveClass(/active/);
    await expect(bulkBtn).not.toHaveClass(/active/);
  });
});
