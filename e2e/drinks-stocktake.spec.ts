import { test, expect } from '@playwright/test';
import { loginAsDev } from './helpers';

test.describe('Drinks stocktake', () => {
  test('start a stocktake by area and save updates stock', async ({ page }) => {
    await loginAsDev(page);
    await page.locator('.nav-btn[data-screen="drinks"]').click();
    await page.getByTestId('drinks-tab-stocktake').click();

    // The tab lands on the stock-list overview (like the ingredient list); the
    // count flow starts from the "Start stocktake" button.
    await expect(page.getByTestId('stk-start')).toBeVisible();
    await page.getByTestId('stk-start').click();

    // By storage area is the default mode — pick the first area.
    await page.getByTestId('stk-area').first().click();
    await expect(page.getByTestId('stk-rows')).toBeVisible();

    // Count the first drink, then save.
    const firstInput = page.locator('.stk-input').first();
    await expect(firstInput).toBeVisible();
    await firstInput.fill('7');

    const saveResp = page.waitForResponse(
      (r) => r.url().endsWith('/api/drinks/stock/bulk') && r.request().method() === 'POST',
      { timeout: 10_000 },
    );
    await page.getByTestId('stk-save').click();
    const saved = await saveResp;
    expect(saved.ok()).toBe(true);
    const body = await saved.json();
    expect(body.saved).toBeGreaterThan(0);
  });
});
