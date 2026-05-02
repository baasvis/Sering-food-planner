import { test, expect } from '@playwright/test';
import { loginAsDev } from './helpers';

test.describe('Stocktake', () => {
  test('user opens the stocktake area picker from the orders screen', async ({ page }) => {
    await loginAsDev(page);

    // Orders → Combined Order tab is the default; that's where the
    // "Do stocktake" button lives.
    await page.locator('.nav-btn[data-screen="orders"]').click();

    // Wait for the orders tab bar to render (renderOrders gates on the
    // ingredient DB load; same pattern as e2e/orders.spec.ts).
    await expect(page.locator('.order-tab-bar')).toBeVisible({ timeout: 10_000 });

    // Click "Do stocktake" — startStocktake() emits trackEvent('stocktake_start')
    // and replaces the orders content with the area picker.
    await page.locator('[data-testid="stocktake-start-btn"]').click();

    // The area picker is identified by its h2 — proves startStocktake ran
    // and renderStocktakeAreaPicker rendered into #screen-orders.
    await expect(page.locator('#screen-orders').getByRole('heading', { name: /Stocktake/ })).toBeVisible();

    // At least one area button should render (storage config has defaults
    // even on a fresh staging DB).
    await expect(page.getByRole('button', { name: /→/ }).first()).toBeVisible();

    // Read-only — no cleanup needed. The stocktake state lives only in the
    // page module's memory until exitStocktake() runs or the page reloads.
  });
});
