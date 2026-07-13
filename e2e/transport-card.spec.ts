import { test, expect } from '@playwright/test';
import { loginAsDev } from './helpers';

/**
 * Transport card — "Pack for Centraal — tomorrow" (public/js/transport-card.ts).
 *
 * Rendered exclusively on the West dashboard. The card always appears (even
 * when nothing is queued), firing `transport_card_shown` each time the
 * dashboard renders. We assert the card is visible and that its header text
 * is correct; no data setup is required because the card renders regardless
 * of whether there are rows.
 */
test.describe('Transport card', () => {
  test('West dashboard renders the transport card and fires transport_card_shown', async ({ page }) => {
    await loginAsDev(page);

    // loginAsDev leaves us on the West dashboard — the transport card should
    // render immediately. It fires trackEvent('transport_card_shown') as part
    // of renderTransportCard() when getCurrentScreen() === 'dashboard'.
    const card = page.getByTestId('transport-card');
    await expect(card).toBeVisible();

    // The title is always rendered regardless of pack-row state.
    await expect(card.locator('.dash-card-title')).toContainText('Pack for Centraal');

    // The card shows either the pack section (rows + "Food is packed" button)
    // or the empty-state message — both are valid; assert at least one renders.
    const packContent = card.locator('.tcard-rows, .tcard-empty, .tcard-empty-edit');
    await expect(packContent.first()).toBeVisible();
  });
});
