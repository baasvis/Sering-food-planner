import { test, expect } from '@playwright/test';
import { loginAsDev, deleteBatchesByNamePrefix } from './helpers';

const TEST_BATCH_PREFIX = 'e2e-test-batch-';

test.describe('Batch creation', () => {
  // Best-effort cleanup — runs even if the test failed mid-flow, so orphan
  // batches don't accumulate in the test DB across runs.
  test.afterEach(async ({ page }) => {
    await deleteBatchesByNamePrefix(page, TEST_BATCH_PREFIX);
  });

  test('user creates a blank batch from the planner', async ({ page }) => {
    await loginAsDev(page);

    // Navigate to the planner screen (where the dish list + New batch button live).
    await page.locator('.nav-btn[data-screen="planner"]').click();

    // Wait for the planner sub-tab bar to render before clicking inside it —
    // initApp() is async, so the sub-tab bar appears slightly after the screen.
    await expect(page.locator('.sub-tab[data-tab="overview"]')).toBeVisible();

    // Open the "Add batch to menu" modal. Use getByRole — more reliable than
    // data-testid here because the button is re-rendered each sub-tab change
    // and ARIA name is stable.
    await page.getByRole('button', { name: /\+ New batch/ }).first().click();

    // Choose "Create blank batch" (skip recipe-search path — covered separately).
    await page.locator('[data-testid="new-batch-blank-btn"]').click();

    // Fill the form. Form input IDs (#nd-*) are stable selectors set by
    // openNewDishScratch() in dishes.ts.
    const batchName = `${TEST_BATCH_PREFIX}${Date.now()}`;
    await page.fill('#nd-name', batchName);
    await page.fill('#nd-stock', '5');

    await page.locator('[data-testid="new-batch-submit"]').click();

    // The default planner sub-tab is the week grid, which only shows batches
    // that have services assigned. Switch to the "Overview" sub-tab — that's
    // the dish-list view where unassigned batches appear.
    await page.locator('.sub-tab[data-tab="overview"]').click();

    // The new batch should appear in the dish list under its given name.
    const tile = page.locator('[data-testid="batch-tile"]').filter({ hasText: batchName });
    await expect(tile).toBeVisible();

    // saveNewDish() calls scheduleSave() (1.5s debounce) → POST /api/data/patch.
    // Waiting for the indicator to flip back to "Saved" proves the round-trip
    // completed and the batch is persisted in the DB.
    await expect(page.locator('#save-text')).toHaveText('Saved', { timeout: 10_000 });

    // Sanity-check the API agrees: the batch we just created is queryable.
    const apiBatches = await page.evaluate(async () => {
      const r = await fetch('/api/batches');
      return r.ok ? await r.json() : [];
    });
    const found = (apiBatches as Array<{ name: string }>).find((b) => b.name === batchName);
    expect(found).toBeTruthy();
  });
});
