import { test, expect } from '@playwright/test';
import { loginAsDev } from './helpers';

/**
 * Transport card — the "Pack for Centraal — tomorrow" card on the West
 * dashboard (public/js/transport-card.ts).
 *
 * The card always renders on the West dashboard; it shows either the pack
 * rows (cooked batches with Centraal services) or an empty-state message.
 * The card fires transport_card_shown on every dashboard render and
 * transport_card_mode_toggled when the user switches between Lean and
 * Bulk-by-dish modes.
 *
 * The test DB may have any number of cooked batches so the spec asserts
 * structural presence rather than specific row content.
 */
test.describe('Transport card', () => {
  test('West dashboard shows the transport card with mode toggle', async ({ page }) => {
    await loginAsDev(page);

    // loginAsDev ends on the West dashboard — the transport card should
    // already be in the DOM. Event-pack cards use the same .tcard class but
    // have a data-event-pack attribute; exclude them to target the main card.
    const card = page.locator('.tcard:not([data-event-pack])');
    await expect(card).toBeVisible();

    // The card always has the title and the Lean / Bulk-by-dish toggle.
    await expect(card).toContainText('Pack for Centraal');
    const leanBtn = card.locator('[data-mode="lean"]');
    const bulkBtn = card.locator('[data-mode="bulk"]');
    await expect(leanBtn).toBeVisible();
    await expect(bulkBtn).toBeVisible();

    // Default mode is "lean" — the lean button should be active.
    await expect(leanBtn).toHaveClass(/active/);
    await expect(bulkBtn).not.toHaveClass(/active/);

    // Clicking "Bulk-by-dish" fires transport_card_mode_toggled and flips
    // the active state.
    await bulkBtn.click();
    await expect(bulkBtn).toHaveClass(/active/);
    await expect(leanBtn).not.toHaveClass(/active/);

    // Restore lean mode so the DB / other tests are unaffected (_mode is
    // module-local, reset by a fresh page context anyway, but be explicit).
    await leanBtn.click();
    await expect(leanBtn).toHaveClass(/active/);
  });
});
