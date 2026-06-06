import { test, expect } from '@playwright/test';
import { loginAsDev, deleteDrinksByNamePrefix } from './helpers';

const PREFIX = 'e2e-stkdrink-';

test.describe('Drinks stocktake', () => {
  test.afterEach(async ({ page }) => {
    await deleteDrinksByNamePrefix(page, PREFIX);
  });

  test('overview groups by area and a count auto-saves', async ({ page }) => {
    await loginAsDev(page);

    // Seed a catalogue drink with a home area at West so it lands in a known
    // storage-area group (deterministic regardless of shared-DB drift).
    const name = `${PREFIX}${Date.now()}`;
    await page.evaluate(async (name) => {
      await fetch('/api/drinks', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: name, mode: 'catalogue', name, category: 'beer', subtype: '', abv: 5, btwRate: null,
          status: 'draft', sellable: true, supplier: '', orderUnit: 'crate', orderUnitMl: null, packNote: '',
          itemId: null, deposit: 0, costPrice: null, costNote: '', formats: [],
          locations: { west: { par: 5, active: true, area: 'Keg Storage' } }, info: {}, tebiProductNames: [],
        }),
      });
    }, name);
    await page.reload();

    await page.locator('.nav-btn[data-screen="drinks"]').click();
    await page.getByTestId('drinks-tab-stocktake').click();
    // Make sure we're on West (where the drink has its area).
    await page.locator('[data-testid="stk-loc-toggle"] .lc[data-loc="west"]').click();

    // The drink shows as an editable row with an In-stock field.
    const row = page.locator('tr[data-testid="stk-ov-row"]', { hasText: name });
    await expect(row).toBeVisible({ timeout: 10_000 });
    const input = row.locator('.stk-ov-input');
    await expect(input).toBeVisible();

    // Changing the count auto-saves — no Save button.
    await expect(page.getByTestId('stk-ov-save')).toHaveCount(0);
    const saveResp = page.waitForResponse(
      (r) => r.url().endsWith('/api/drinks/stock/bulk') && r.request().method() === 'POST', { timeout: 10_000 });
    await input.fill('3');
    await input.blur();
    const saved = await saveResp;
    expect(saved.ok()).toBe(true);
    expect((await saved.json()).saved).toBeGreaterThan(0);
  });
});
