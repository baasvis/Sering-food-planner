import { test, expect } from '@playwright/test';
import { loginAsDev, deleteBatchesByNamePrefix } from './helpers';

const TEST_BATCH_PREFIX = 'e2e-test-cooked-';

test.describe('Batch cooked transition', () => {
  test.afterEach(async ({ page }) => {
    // Cooked batches have stock > 0 so DELETE /api/batches/:id refuses. Reset
    // stock to 0 first, then delete.
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
    // Belt-and-braces: try the regular cleanup too.
    await deleteBatchesByNamePrefix(page, TEST_BATCH_PREFIX);
  });

  test('user marks a batch as cooked today', async ({ page }) => {
    await loginAsDev(page);
    await page.locator('.nav-btn[data-screen="planner"]').click();
    await expect(page.locator('.sub-tab[data-tab="overview"]')).toBeVisible();

    // ── Step 1: create the batch via the existing UI flow ──────────────────
    await page.getByRole('button', { name: /\+ New batch/ }).first().click();
    await page.locator('[data-testid="new-batch-blank-btn"]').click();
    const batchName = `${TEST_BATCH_PREFIX}${Date.now()}`;
    await page.fill('#nd-name', batchName);
    await page.fill('#nd-stock', '0');
    await page.locator('[data-testid="new-batch-submit"]').click();

    // ── Step 2: switch to Overview to see the dish list ────────────────────
    await page.locator('.sub-tab[data-tab="overview"]').click();
    const tile = page.locator('[data-testid="batch-tile"]').filter({ hasText: batchName });
    await expect(tile).toBeVisible();

    // ── Step 3: expand the tile so the cook controls render ────────────────
    await tile.locator('.batch-tile-compact').click();

    // ── Step 4: pick "Today" from the cook-day dropdown ────────────────────
    // Selecting an option triggers onchange → setCookDay → re-renders the
    // tile. After that, isCookDayToday(d) is true so the
    // "Today — mark as cooked" button appears.
    // The option's label is e.g. "Today (Saturday)" but its value is
    // dateToStr(today). selectOption needs a string, not a regex — look up
    // the value from the matching option.
    const cookSelect = tile.locator('[data-testid="cook-select"]');
    const todayValue = await cookSelect
      .locator('option')
      .filter({ hasText: /^Today/ })
      .first()
      .getAttribute('value');
    expect(todayValue).toBeTruthy();
    await cookSelect.selectOption(todayValue!);

    // ── Step 5: click the mark-as-cooked button ────────────────────────────
    await tile.locator('[data-testid="cook-today-btn"]').click();

    // confirmCooked() schedules a save (1.5s debounce) → POST /api/data/patch.
    await expect(page.locator('#save-text')).toHaveText('Saved', { timeout: 10_000 });

    // ── Step 6: verify the batch transitioned to cooked in the DB ──────────
    const created = await page.evaluate(async (name) => {
      const r = await fetch('/api/batches');
      const all = await r.json() as Array<{ id: string; name: string; cookDate: string | null; stock: number }>;
      return all.find((b) => b.name === name);
    }, batchName);
    expect(created).toBeTruthy();
    expect(created!.cookDate).toBeTruthy();
    // confirmCooked auto-fills stock from calcRequired when stock was 0.
    // calcRequired returns 0 when there are no services assigned, which is
    // our case — assert non-negative rather than > 0 to match real behavior.
    expect(created!.stock).toBeGreaterThanOrEqual(0);
  });
});
