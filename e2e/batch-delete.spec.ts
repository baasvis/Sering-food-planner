import { test, expect } from '@playwright/test';
import { loginAsDev, deleteBatchesByNamePrefix } from './helpers';

const TEST_BATCH_PREFIX = 'e2e-test-delete-';

test.describe('Batch deletion', () => {
  // Belt-and-braces: if the test fails before deletion, clean up leftovers.
  test.afterEach(async ({ page }) => {
    await deleteBatchesByNamePrefix(page, TEST_BATCH_PREFIX);
  });

  test('user deletes an uncooked batch from the overview', async ({ page }) => {
    await loginAsDev(page);

    await page.locator('.nav-btn[data-screen="planner"]').click();
    await expect(page.locator('.sub-tab[data-tab="overview"]')).toBeVisible();

    // ── Step 1: create a new blank batch via the UI ────────────────────────
    await page.getByRole('button', { name: /\+ New batch/ }).first().click();
    await page.locator('[data-testid="new-batch-blank-btn"]').click();
    const batchName = `${TEST_BATCH_PREFIX}${Date.now()}`;
    await page.fill('#nd-name', batchName);
    await page.fill('#nd-stock', '0');
    await page.locator('[data-testid="new-batch-submit"]').click();

    // ── Step 2: switch to the Overview sub-tab (dish list) ────────────────
    await page.locator('.sub-tab[data-tab="overview"]').click();
    const tile = page.locator('[data-testid="batch-tile"]').filter({ hasText: batchName });
    await expect(tile).toBeVisible();

    // ── Step 3: expand the tile so the action buttons render ──────────────
    await tile.locator('.batch-tile-compact').click();

    // ── Step 4: click Delete ───────────────────────────────────────────────
    await tile.locator('[data-testid="batch-delete-btn"]').click();

    // deleteBatch() removes the item from S.batches and re-renders synchronously.
    await expect(tile).not.toBeVisible();

    // ── Step 5: the deletion is committed via the undo/save pipeline.
    // Wait for the save indicator to confirm the round-trip to the DB.
    await expect(page.locator('#save-text')).toHaveText('Saved', { timeout: 10_000 });

    // ── Step 6: sanity-check the API no longer returns the batch ──────────
    const stillExists = await page.evaluate(async (name) => {
      const r = await fetch('/api/batches');
      if (!r.ok) return false;
      const all = (await r.json()) as Array<{ name: string }>;
      return all.some((b) => b.name === name);
    }, batchName);
    expect(stillExists).toBe(false);
  });
});
