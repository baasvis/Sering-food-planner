import { test, expect } from '@playwright/test';
import { loginAsDev } from './helpers';

/**
 * Alarm board — the live issue counter on the West week-plan header
 * (public/js/alarm-board.ts). The counter renders next to the reserve
 * control on the West sub-tab only, and clicking it opens the grouped
 * issues modal (shared with the Fix-My-Menu results modal machinery).
 *
 * Runs against the shared test DB, so the actual issue count is
 * unpredictable — the spec asserts both states render coherently rather
 * than pinning a number.
 */
test.describe('Alarm board', () => {
  test('West planner shows the issue counter; clicking opens the issues modal', async ({ page }) => {
    await loginAsDev(page);

    await page.locator('.nav-btn[data-screen="planner"]').click();
    await expect(page.locator('#screen-planner')).toHaveClass(/active/);

    // Default sub-tab is the chosen location (West), where the counter lives.
    const counter = page.getByTestId('alarm-counter');
    await expect(counter).toBeVisible();
    await expect(counter).toHaveText(/issue|No issues/);

    await counter.click();
    const modal = page.locator('.modal-content.fix-menu-results');
    await expect(modal).toBeVisible();
    await expect(modal.locator('h2')).toHaveText(/Planning issues/);
    // Body is either the grouped warning list or the all-clear line.
    await expect(modal.locator('.fix-menu-warnings-hdr, .fix-menu-clean')).toBeVisible();

    await modal.getByRole('button', { name: 'Got it' }).click();
    await expect(modal).toBeHidden();
  });
});
