import { test, expect } from '@playwright/test';
import { loginAsDev, deleteBatchesByNamePrefix } from './helpers';

const TEST_BATCH_PREFIX = 'e2e-test-pin-';

/**
 * Chip pin (📌) — locks one batch↔service assignment against Fix My Menu's
 * redistribution (public/js/planner.ts toggleServicePin + stripFutureServices
 * pin contract). This spec covers the UI path: the ghosted pin on a planner
 * chip toggles to pinned, fires the toast, and the flag persists to the
 * server inside the batch's services JSON.
 */
test.describe('Pin dish to service', () => {
  test.afterEach(async ({ page }) => {
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

  test('pin a chip, see it pinned, flag persists to the server', async ({ page }) => {
    await loginAsDev(page);

    await page.locator('.nav-btn[data-screen="planner"]').click();
    await expect(page.locator('.sub-tab[data-tab="overview"]')).toBeVisible();

    // Create a Soup batch via the new-batch modal.
    await page.getByRole('button', { name: /\+ New batch/ }).first().click();
    await page.locator('[data-testid="new-batch-blank-btn"]').click();
    const batchName = `${TEST_BATCH_PREFIX}${Date.now()}`;
    await page.fill('#nd-name', batchName);
    await page.locator('[data-testid="new-batch-submit"]').click();
    await expect(page.locator('#save-text')).toHaveText('Saved', { timeout: 10_000 });

    // Seed cooked stock + a service on tomorrow's West lunch directly in-page
    // (the assign-modal flow is covered by batch-assign-modal.spec.ts).
    await page.evaluate((name) => {
      const win = window as unknown as { S: { batches: Array<{
        id: string; name: string; cookDate: string | null;
        inventory: Array<{ loc: string; storage: string; qty: number; cookDate: string }>;
        services: Array<{ loc: string; date: string; meal: string; pinned?: boolean }>;
      }> }; rebuildPlanner: () => void; rerenderCurrentView: () => void; scheduleSave: () => void };
      const target = win.S.batches.find((b) => b.name === name);
      if (!target) throw new Error(`Batch ${name} not found in S.batches`);
      const today = new Date();
      const dd = String(today.getDate()).padStart(2, '0');
      const mm = String(today.getMonth() + 1).padStart(2, '0');
      const cookDate = `${dd}/${mm}/${today.getFullYear()}`;
      const tomorrow = new Date(today);
      tomorrow.setDate(today.getDate() + 1);
      const iso = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;
      target.cookDate = cookDate;
      target.inventory = [{ loc: 'west', storage: 'Gastro', qty: 10, cookDate }];
      target.services = [{ loc: 'west', date: iso, meal: 'lunch' }];
      win.rebuildPlanner();
      win.rerenderCurrentView();
      win.scheduleSave();
    }, batchName);
    await expect(page.locator('#save-text')).toHaveText('Saved', { timeout: 10_000 });

    // The chip renders on the West week grid with a ghosted (unpinned) pin.
    // The planner defaults to the user's location tab (West); set it
    // programmatically rather than clicking the sub-tab, which is redundant
    // when already active and was flaky in this spec.
    await page.evaluate(() => (window as unknown as { setPlannerSubTab: (t: string) => void }).setPlannerSubTab('west'));
    const chip = page.locator('.dish-chip').filter({ hasText: batchName }).first();
    await expect(chip).toBeVisible();
    const pin = chip.locator('[data-testid="chip-pin"]');
    await expect(pin).not.toHaveClass(/chip-pinned/);

    // Toggle the pin — fires trackEvent('service_pin_toggle') + toast.
    await pin.click();
    await expect(page.locator('#toast')).toContainText('Pinned', { timeout: 5_000 });
    await expect(
      page.locator('.dish-chip').filter({ hasText: batchName }).first().locator('[data-testid="chip-pin"]'),
    ).toHaveClass(/chip-pinned/);

    // The flag round-trips to the server inside the services JSON.
    await expect(page.locator('#save-text')).toHaveText('Saved', { timeout: 10_000 });
    const persisted = await page.evaluate(async (name) => {
      const res = await fetch('/api/batches');
      const all = (await res.json()) as Array<{ name: string; services: Array<{ pinned?: boolean }> }>;
      const b = all.find((x) => x.name === name);
      return b?.services?.[0]?.pinned === true;
    }, batchName);
    expect(persisted).toBe(true);
  });
});
