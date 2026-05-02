import { test, expect } from '@playwright/test';
import { loginAsDev, deleteBatchesByNamePrefix } from './helpers';

const TEST_BATCH_PREFIX = 'e2e-test-assign-';

test.describe('Batch assign via modal', () => {
  test.afterEach(async ({ page }) => {
    // Batches with stock > 0 cannot be deleted directly — zero stock first.
    if (page.url().startsWith('http')) {
      await page.evaluate(async (prefix) => {
        const res = await fetch('/api/batches');
        if (!res.ok) return;
        const all = (await res.json()) as Array<{ id: string; name: string }>;
        const matches = all.filter((b) => b.name && b.name.startsWith(prefix));
        for (const b of matches) {
          await fetch(`/api/batches/${b.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ stock: 0 }),
          });
          await fetch(`/api/batches/${b.id}`, { method: 'DELETE' });
        }
      }, TEST_BATCH_PREFIX);
    }
    await deleteBatchesByNamePrefix(page, TEST_BATCH_PREFIX);
  });

  test('user assigns an existing batch to a planner slot via the add-to-slot modal', async ({ page }) => {
    await loginAsDev(page);

    // Navigate to the planner screen.
    await page.locator('.nav-btn[data-screen="planner"]').click();
    await expect(page.locator('.sub-tab[data-tab="overview"]')).toBeVisible();

    // Create a Soup batch with stock=10 so it appears in the "Cooked" tab of
    // the slot-assign modal (isBatchCooked checks stock > 0).
    await page.getByRole('button', { name: /\+ New batch/ }).first().click();
    await page.locator('[data-testid="new-batch-blank-btn"]').click();
    const batchName = `${TEST_BATCH_PREFIX}${Date.now()}`;
    await page.fill('#nd-name', batchName);
    // Type defaults to "Soup"; leave it. Stock > 0 makes isBatchCooked() true.
    await page.fill('#nd-stock', '10');
    await page.locator('[data-testid="new-batch-submit"]').click();

    // Wait for the save debounce to flush so the batch is in the DB before
    // the slot-assign round-trip.
    await expect(page.locator('#save-text')).toHaveText('Saved', { timeout: 10_000 });

    // Switch to the West week-grid sub-tab where the slot add buttons live.
    await page.locator('.sub-tab[data-tab="west"]').click();

    // Click the first slot "+" button (Soup section, first visible day).
    // openAddDishTyped() opens the modal filtered to the Soup type.
    await page.locator('[data-testid="slot-add-btn"]').first().click();

    // The modal opens on the "Cooked" tab by default. Type the batch name
    // into the search box to surface it immediately (avoids scrolling).
    await expect(page.locator('#planner-search')).toBeVisible();
    await page.fill('#planner-search', batchName);

    // The matching dish option should appear. Click it — this calls
    // confirmAddDish() which emits trackEvent('batch_assign_modal') and
    // pushes a service entry into the batch's services array.
    await expect(page.locator('[data-testid="dish-opt"]').filter({ hasText: batchName })).toBeVisible({ timeout: 5_000 });
    await page.locator('[data-testid="dish-opt"]').filter({ hasText: batchName }).first().click();

    // confirmAddDish() closes the modal and shows a toast with the batch name.
    await expect(page.locator('#toast')).toContainText(batchName, { timeout: 5_000 });

    // The save debounce (1.5 s) fires after the assign; wait for it so the
    // afterEach cleanup can PATCH stock=0 and DELETE without a conflict.
    await expect(page.locator('#save-text')).toHaveText('Saved', { timeout: 10_000 });
  });
});
