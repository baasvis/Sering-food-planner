import { test, expect } from '@playwright/test';
import { loginAsDev } from './helpers';

test.describe('Drinks stocktake', () => {
  test('count a supplier delivery and save updates stock', async ({ page }) => {
    await loginAsDev(page);
    await page.locator('.nav-btn[data-screen="drinks"]').click();
    await page.getByTestId('drinks-tab-stocktake').click();

    // By-supplier is the default mode — pick the first supplier.
    await page.getByTestId('stk-supplier').first().click();
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
