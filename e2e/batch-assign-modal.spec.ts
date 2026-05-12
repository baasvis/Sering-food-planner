import { test, expect } from '@playwright/test';
import { loginAsDev, deleteBatchesByNamePrefix } from './helpers';

const TEST_BATCH_PREFIX = 'e2e-test-assign-';

test.describe('Batch assign via modal', () => {
  test.afterEach(async ({ page }) => {
    // Cooked batches (non-empty inventory[] or pending shipments) can't be
    // deleted directly — drain both first.
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
            body: JSON.stringify({ inventory: [], shipments: [] }),
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

    // Create a Soup batch (type defaults to Soup; the new-batch modal no
    // longer has a stock field in the unified-batch model). isBatchCooked
    // now reads inventory + pending shipments, so we need to seed
    // inventory before the batch shows up in the "Cooked" tab of the
    // slot-assign modal.
    await page.getByRole('button', { name: /\+ New batch/ }).first().click();
    await page.locator('[data-testid="new-batch-blank-btn"]').click();
    const batchName = `${TEST_BATCH_PREFIX}${Date.now()}`;
    await page.fill('#nd-name', batchName);
    await page.locator('[data-testid="new-batch-submit"]').click();
    await expect(page.locator('#save-text')).toHaveText('Saved', { timeout: 10_000 });

    // Seed inventory by mutating S.batches in the browser context, then
    // re-rendering + scheduleSave. Doing this in-page (instead of a server
    // PATCH + page.reload()) avoids racing the reload against /api/data —
    // the SAVE round-trip still verifies the wire shape on the server side.
    await page.evaluate((name) => {
      const win = window as unknown as { S: { batches: Array<{
        id: string; name: string; cookDate: string | null;
        inventory: Array<{ loc: string; storage: string; qty: number; cookDate: string }>;
      }> }; rebuildPlanner: () => void; rerenderCurrentView: () => void; scheduleSave: () => void };
      const target = win.S.batches.find((b) => b.name === name);
      if (!target) throw new Error(`Batch ${name} not found in S.batches`);
      const today = new Date();
      const dd = String(today.getDate()).padStart(2, '0');
      const mm = String(today.getMonth() + 1).padStart(2, '0');
      const cookDate = `${dd}/${mm}/${today.getFullYear()}`;
      target.cookDate = cookDate;
      target.inventory = [{ loc: 'west', storage: 'Gastro', qty: 10, cookDate }];
      win.rebuildPlanner();
      win.rerenderCurrentView();
      win.scheduleSave();
    }, batchName);
    // Wait for the inventory-seed save to complete BEFORE opening the modal,
    // so the assign-modal's filter (which reads S.batches) sees the cooked
    // state and so the afterEach cleanup PATCH races nothing.
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
    // afterEach cleanup can PATCH inventory=[]/shipments=[] and DELETE
    // without a conflict.
    await expect(page.locator('#save-text')).toHaveText('Saved', { timeout: 10_000 });
  });
});
