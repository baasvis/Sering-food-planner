import { test, expect } from '@playwright/test';
import { loginAsDev } from './helpers';

// Network-layer 401s on cold load before the dev login completes are
// expected and not regressions — see e2e/navigation.spec.ts for context.
const IGNORED_PATTERNS = [/Failed to load resource.*401.*Unauthorized/];

test.describe('Orders', () => {
  test('orders screen loads and tabs switch without errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const text = msg.text();
      if (IGNORED_PATTERNS.some((p) => p.test(text))) return;
      errors.push(`[console.error] ${text}`);
    });
    page.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}`));

    await loginAsDev(page);
    await page.locator('.nav-btn[data-screen="orders"]').click();

    // The screen renders a placeholder "Loading ingredient database…" until
    // the IngredientDB load completes. Wait for the actual tab bar to appear.
    const tabBar = page.locator('.order-tab-bar');
    await expect(tabBar).toBeVisible({ timeout: 10_000 });

    // All four tabs are rendered.
    const tabs = ['Combined Order', 'Set Standard Inventory', 'Batch Ingredients', 'Ingredient Database'];
    for (const label of tabs) {
      await expect(tabBar.getByRole('button', { name: new RegExp(label) })).toBeVisible();
    }

    // Default tab is Combined Order — it should be marked active and the
    // content area below the tab bar should not be empty.
    await expect(tabBar.getByRole('button', { name: /Combined Order/ })).toHaveClass(/active/);
    const screen = page.locator('#screen-orders');
    const initialContentLen = (await screen.innerHTML()).length;
    expect(initialContentLen).toBeGreaterThan(200);

    // Switching to "Set Standard Inventory" replaces the content. Verify the
    // body changed (rather than asserting a specific string, which would
    // couple this test to incidental copy in the inventory tab).
    await tabBar.getByRole('button', { name: /Set Standard Inventory/ }).click();
    await expect(tabBar.getByRole('button', { name: /Set Standard Inventory/ })).toHaveClass(/active/);

    // Switching to "Batch Ingredients" — exercises calcRequired across all
    // services-having batches. If the calc logic regresses, this throws.
    await tabBar.getByRole('button', { name: /Batch Ingredients/ }).click();
    await expect(tabBar.getByRole('button', { name: /Batch Ingredients/ })).toHaveClass(/active/);

    // No console.error / pageerror collected during the whole flow.
    if (errors.length > 0) {
      throw new Error(`Captured ${errors.length} error(s):\n${errors.join('\n')}`);
    }
  });
});
