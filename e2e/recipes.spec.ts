import { test, expect } from '@playwright/test';
import { loginAsDev, deleteRecipesByNamePrefix } from './helpers';

const TEST_RECIPE_PREFIX = 'e2e-test-recipe-';

test.describe('Recipes', () => {
  test.afterEach(async ({ page }) => {
    await deleteRecipesByNamePrefix(page, TEST_RECIPE_PREFIX);
  });

  test('user creates a draft recipe from the recipe index', async ({ page }) => {
    await loginAsDev(page);
    await page.locator('.nav-btn[data-screen="recipe-index"]').click();

    // Open the multi-step recipe editor modal.
    await page.locator('[data-testid="recipe-create-btn"]').click();

    const recipeName = `${TEST_RECIPE_PREFIX}${Date.now()}`;
    // Set the name. The input has an inline onchange="reUpdateField('name', ...)"
    // that updates the editor state; fill alone won't fire it.
    await page.locator('#re-name').evaluate((el, val) => {
      const input = el as HTMLInputElement;
      input.value = val;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, recipeName);

    // Default values for type=Soup and servingSize=280 are set in the editor's
    // initial state, so the only required field we have to touch is the name.
    // "Save (incomplete)" lets us save without ingredients/prep/storage filled.
    const saveResponse = page.waitForResponse(
      (res) => res.url().endsWith('/api/recipes') && res.request().method() === 'POST',
      { timeout: 10_000 },
    );
    await page.locator('[data-testid="recipe-save-draft"]').click();
    const saved = await saveResponse;
    // POST /api/recipes returns 200 (default Express OK) — not the more REST-y
    // 201 Created. Both are fine; just match what the route actually returns.
    expect(saved.ok()).toBe(true);

    // Verify the saved recipe is queryable and has the right name.
    const created = await saved.json();
    expect(created.name).toBe(recipeName);
    expect(created.id).toBeTruthy();

    // GET round-trip — the recipe is in the index.
    const list = await page.evaluate(async () => {
      const r = await fetch('/api/recipes');
      return r.ok ? await r.json() : [];
    });
    const found = (list as Array<{ name: string }>).find((r) => r.name === recipeName);
    expect(found).toBeTruthy();
  });
});
