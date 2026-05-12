import { test, expect } from '@playwright/test';
import { loginAsDev, deleteBatchesByNamePrefix } from './helpers';

const TEST_BATCH_PREFIX = 'e2e-test-delete-';

test.describe('Batch deletion', () => {
  test.afterEach(async ({ page }) => {
    await deleteBatchesByNamePrefix(page, TEST_BATCH_PREFIX);
  });

  test('user deletes a batch from the planner overview', async ({ page }) => {
    await loginAsDev(page);

    await page.locator('.nav-btn[data-screen="planner"]').click();
    await expect(page.locator('.sub-tab[data-tab="overview"]')).toBeVisible();

    // Create a blank batch — unified-batch model starts with empty inventory[]
    // so the DELETE guard is satisfied (totalQty + pending shipments = 0).
    await page.getByRole('button', { name: /\+ New batch/ }).first().click();
    await page.locator('[data-testid="new-batch-blank-btn"]').click();
    const batchName = `${TEST_BATCH_PREFIX}${Date.now()}`;
    await page.fill('#nd-name', batchName);
    await page.locator('[data-testid="new-batch-submit"]').click();

    // Switch to Overview tab and confirm the tile is present.
    await page.locator('.sub-tab[data-tab="overview"]').click();
    const tile = page.locator('[data-testid="batch-tile"]').filter({ hasText: batchName });
    await expect(tile).toBeVisible();

    // Wait for the creation save to land before deleting — avoids a race where
    // the undo timer's commit() fires a second PATCH before the creation PATCH.
    await expect(page.locator('#save-text')).toHaveText('Saved', { timeout: 10_000 });

    // Expand the tile so the action buttons are rendered.
    await tile.locator('.batch-tile-compact').click();

    // Arm a listener for the PATCH that the undo-timer commit will fire.
    // The deletion is optimistic: state updates immediately, but the DB write
    // only happens after the 5 s undo window expires + 1.5 s save debounce.
    const patchDone = page.waitForResponse(
      (r) => r.url().includes('/api/data/patch') && r.request().method() === 'POST',
      { timeout: 12_000 },
    );

    await tile.locator('[data-testid="batch-delete-btn"]').click();

    // Tile must vanish from the UI immediately (optimistic remove).
    await expect(tile).not.toBeVisible();

    // Wait for the background PATCH to complete so the DB agrees.
    const patchRes = await patchDone;
    expect(patchRes.ok()).toBe(true);

    // Belt-and-braces: confirm the batch is gone from the API.
    const found = await page.evaluate(async (name) => {
      const r = await fetch('/api/batches');
      const all = (await r.json()) as Array<{ id: string; name: string }>;
      return all.find((b) => b.name === name);
    }, batchName);
    expect(found).toBeUndefined();
  });
});
