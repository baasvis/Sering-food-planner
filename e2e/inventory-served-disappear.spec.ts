import { test, expect, type Page } from '@playwright/test';
import { loginAsDev } from './helpers';

/**
 * Regression e2e for the "batches disappear after Do inventory" fixes
 * (2026-05-16) — end to end through the real preview server + staging DB.
 *
 * Covers: the "Served" undo (Finding 1a), the honest confirmation dialog
 * (Finding 1b), and the can't-count-to-0 rule (Finding 1c).
 */

const PREFIX = 'e2e-inv-disappear-';

interface BatchSummary {
  id: string;
  name: string;
  inventory: Array<{ loc: string; storage: string; qty: number; cookDate: string }>;
}

/** Seed a cooked batch straight into the DB via POST /api/batches, then reload
 *  so the freshly-loaded S.batches (and its save snapshot) include it. */
async function seedCookedBatch(
  page: Page,
  opts: { name: string; cookDate: string; inventory: object[]; services?: object[] },
): Promise<string> {
  const id = await page.evaluate(async (o) => {
    const res = await fetch('/api/batches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: o.name,
        type: 'Soup',
        serving: 280,
        cookDate: o.cookDate,
        inventory: o.inventory,
        shipments: [],
        services: o.services || [],
        allergens: [],
        extraAllergens: [],
        orderFor: false,
        note: '',
        recipeId: null,
        actualIngredients: null,
        cookNotes: '',
        stockDeducted: false,
        generated: false,
      }),
    });
    const created = await res.json();
    return created.id as string;
  }, opts);

  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/data') && r.request().method() === 'GET'),
    page.reload(),
  ]);
  await expect(page.locator('.nav-btn[data-screen="dashboard"]')).toBeVisible();
  return id;
}

async function getBatch(page: Page, id: string): Promise<BatchSummary | undefined> {
  return page.evaluate(async (batchId) => {
    const r = await fetch('/api/batches');
    const all = (await r.json()) as BatchSummary[];
    return all.find((b) => b.id === batchId);
  }, id);
}

function cookDateToday(): string {
  const t = new Date();
  return `${String(t.getDate()).padStart(2, '0')}/${String(t.getMonth() + 1).padStart(2, '0')}/${t.getFullYear()}`;
}

test.describe('Do-inventory fixes', () => {
  test.afterEach(async ({ page }) => {
    // Best-effort cleanup: drain inventory (DELETE refuses while stock > 0) then delete.
    if (!page.url().startsWith('http')) return;
    await page.evaluate(async (prefix) => {
      const res = await fetch('/api/batches');
      if (!res.ok) return;
      const all = (await res.json()) as Array<{ id: string; name: string }>;
      for (const b of all.filter((x) => x.name && x.name.startsWith(prefix))) {
        await fetch(`/api/batches/${b.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ inventory: [], shipments: [] }),
        });
        await fetch(`/api/batches/${b.id}`, { method: 'DELETE' });
      }
    }, PREFIX);
  });

  test('Finding 1a/1b — "Served" can be undone; an undo keeps the batch in the DB', async ({ page }) => {
    await loginAsDev(page);
    const cookDate = cookDateToday();
    const name = `${PREFIX}undo-${Date.now()}`;
    const id = await seedCookedBatch(page, {
      name,
      cookDate,
      inventory: [{ loc: 'west', storage: 'Gastro', qty: 5, cookDate }],
    });

    await page.evaluate(() => (window as unknown as { openInventory: (l: string) => void }).openInventory('west'));
    await page.locator(`.inv-row[data-batch="${id}"] .inv-served-btn`).click();

    // Finding 1b — the confirmation is honest that the whole batch goes.
    await expect(page.locator('#modal-root')).toContainText('the whole batch will be removed');

    await page.getByRole('button', { name: 'Skip rating' }).click();

    // Finding 1a — an undo toast appears; clicking it restores the batch.
    const undoBtn = page.locator('#toast .toast-undo-btn');
    await expect(undoBtn).toBeVisible();
    await undoBtn.click();

    // The reopened inventory modal refreshes to show the restored batch...
    await expect(page.locator(`.inv-row[data-batch="${id}"]`)).toBeVisible();
    // ...and the batch never left the database (the deferred delete was cancelled).
    expect(await getBatch(page, id)).toBeTruthy();
  });

  test('"Served" with no undo archives the batch from the DB after the undo window', async ({ page }) => {
    await loginAsDev(page);
    const cookDate = cookDateToday();
    const future = new Date(Date.now() + 9 * 86_400_000);
    const futureIso = `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, '0')}-${String(future.getDate()).padStart(2, '0')}`;
    const name = `${PREFIX}archive-${Date.now()}`;
    const id = await seedCookedBatch(page, {
      name,
      cookDate,
      inventory: [{ loc: 'west', storage: 'Gastro', qty: 5, cookDate }],
      services: [{ loc: 'west', date: futureIso, meal: 'lunch' }],
    });

    await page.evaluate(() => (window as unknown as { openInventory: (l: string) => void }).openInventory('west'));
    await page.locator(`.inv-row[data-batch="${id}"] .inv-served-btn`).click();

    // Wait for the save that carries the deletion — it fires after the 5 s undo
    // window plus the save debounce, so allow generous time.
    const deletionSave = page.waitForResponse(
      (r) => r.url().endsWith('/api/data/patch') && r.request().method() === 'POST',
      { timeout: 20_000 },
    );
    await page.getByRole('button', { name: 'Skip rating' }).click();
    await deletionSave;

    // The undo window elapsed without an undo → the batch is gone from the DB.
    expect(await getBatch(page, id)).toBeUndefined();
  });

  test('Finding 1c — a quantity cannot be counted down to 0; the batch is untouched', async ({ page }) => {
    await loginAsDev(page);
    const cookDate = cookDateToday();
    const name = `${PREFIX}cantzero-${Date.now()}`;
    const id = await seedCookedBatch(page, {
      name,
      cookDate,
      inventory: [{ loc: 'west', storage: 'Gastro', qty: 5, cookDate }],
    });

    await page.evaluate(() => (window as unknown as { openInventory: (l: string) => void }).openInventory('west'));

    const qtyInput = page.locator(`.inv-row[data-batch="${id}"] input.inv-stock-input`);
    await expect(qtyInput).toBeVisible();
    await qtyInput.fill('0');
    await qtyInput.blur(); // onchange → updateLocScopedQty rejects the 0

    // The cook is told to use "Served" instead.
    await expect(page.locator('#toast')).toContainText('Served');
    // The row is still there (it re-rendered at its original value, not removed).
    await expect(page.locator(`.inv-row[data-batch="${id}"]`)).toHaveCount(1);

    // The database still holds the batch with its 5 L — nothing was zeroed.
    const after = await getBatch(page, id);
    expect(after).toBeTruthy();
    expect((after!.inventory || []).reduce((s, e) => s + (e.qty || 0), 0)).toBe(5);
  });
});
