import { test, expect } from '@playwright/test';
import { loginAsDev, deleteDrinksByNamePrefix } from './helpers';

const PREFIX = 'e2e-drink-';

test.describe('Drinks catalogue', () => {
  test.afterEach(async ({ page }) => {
    await deleteDrinksByNamePrefix(page, PREFIX);
  });

  test('manager adds a catalogue drink and it appears in the list', async ({ page }) => {
    await loginAsDev(page);
    await page.locator('.nav-btn[data-screen="drinks"]').click();

    // Catalogue is the default sub-tab. "+ Add drink" first asks which kind;
    // choose "Bought drink" to reach the catalogue form.
    await page.getByTestId('drink-add-btn').click();
    await page.getByTestId('add-choose-catalogue').click();
    await expect(page.getByTestId('drink-form')).toBeVisible();

    const name = `${PREFIX}${Date.now()}`;
    await page.locator('#df-name').fill(name);
    await page.locator('#df-category').selectOption('beer');
    await page.locator('#df-abv').fill('5');

    const saveResp = page.waitForResponse(
      (r) => r.url().endsWith('/api/drinks') && r.request().method() === 'POST',
      { timeout: 10_000 },
    );
    await page.getByTestId('drink-save-btn').click();
    const saved = await saveResp;
    expect(saved.ok()).toBe(true);
    const created = await saved.json();
    expect(created.name).toBe(name);
    expect(created.mode).toBe('catalogue');

    // The new drink shows in the catalogue table.
    await expect(page.locator(`[data-testid="drink-row"]:has-text("${name}")`)).toBeVisible({ timeout: 10_000 });
  });

  test('catalogue search filters the table', async ({ page }) => {
    await loginAsDev(page);
    await page.locator('.nav-btn[data-screen="drinks"]').click();
    // Seed data has many beers; search narrows the table.
    await page.getByTestId('drinks-search').fill('Pilsner');
    await expect(page.locator('[data-testid="drink-row"]')).not.toHaveCount(0);
    const rows = page.locator('[data-testid="drink-row"]');
    await expect(rows.first()).toContainText(/Pils/i);
  });
});
