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

  test('a live-sync re-render does not kick the user out of an active stocktake (feedback #471)', async ({ page }) => {
    await loginAsDev(page);

    await page.locator('.nav-btn[data-screen="orders"]').click();
    await expect(page.locator('.order-tab-bar')).toBeVisible({ timeout: 10_000 });
    await page.locator('[data-testid="stocktake-start-btn"]').click();
    await expect(page.locator('#screen-orders').getByRole('heading', { name: /Stocktake/ })).toBeVisible();

    // Simulate what an incoming SSE patch does: applyRemotePatch →
    // rerenderCurrentView → renderOrders. Before the #471 fix this replaced
    // the stocktake view with the order tabs (and a restart wiped all typed
    // counts). An empty-but-changed patch is enough to trigger the re-render.
    await page.evaluate(() => {
      (window as never as { rerenderCurrentView: () => void }).rerenderCurrentView();
    });

    // Still in the stocktake — the area picker heading survives the re-render.
    await expect(page.locator('#screen-orders').getByRole('heading', { name: /Stocktake/ })).toBeVisible();
    await expect(page.locator('.order-tab-bar')).toHaveCount(0);

    // Leaving via "Back to orders" restores the normal orders screen.
    await page.getByRole('button', { name: '← Back to orders' }).click();
    await expect(page.locator('.order-tab-bar')).toBeVisible();
  });
});
