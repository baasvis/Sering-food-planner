import { expect, type Page } from '@playwright/test';

/**
 * Performs the dev-mode login flow and selects the West location.
 *
 * Assumes:
 *   - GOOGLE_CLIENT_ID is unset on the server (so the dev-login button shows).
 *   - Browser context is fresh (no saved location → location chooser appears).
 *
 * Leaves the page on the dashboard with the nav fully built AND with the
 * initial data load complete. The wait-for-/api/data is critical: tests
 * that mutate state right after login otherwise hit a race where loadData
 * finishes mid-test, replaces S.batches/S.guests, and runs takeSnapshot —
 * silently dropping the test's local edit before the debounced save fires.
 */
export async function loginAsDev(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('#dev-login-btn').click();

  // loadData() awaits GET /api/data, then kicks off four background fetches
  // (guest-history, guests-next-weeks, ingredients, storage-config). Each
  // overwrites a slice of S when it returns. Set up listeners BEFORE the
  // click so we don't miss a fast-responding fetch — then await all of them
  // to make sure no late response wipes out a test's edit later.
  const waits = [
    page.waitForResponse((r) => r.url().endsWith('/api/data') && r.request().method() === 'GET', { timeout: 15_000 }),
    page.waitForResponse((r) => r.url().endsWith('/api/guests-next-weeks') && r.request().method() === 'GET', { timeout: 15_000 }),
    page.waitForResponse((r) => r.url().endsWith('/api/guest-history') && r.request().method() === 'GET', { timeout: 15_000 }),
  ];
  await page.getByRole('button', { name: 'Sering West' }).click();
  await Promise.all(waits);

  await expect(page.locator('.nav-btn[data-screen="dashboard"]')).toBeVisible();
}

/**
 * Deletes any batches created by e2e tests (name starts with the given prefix).
 * Runs in the page context so it inherits the auth cookie. Safe to call after
 * a test has failed mid-flow — best-effort cleanup.
 */
export async function deleteBatchesByNamePrefix(page: Page, prefix: string): Promise<void> {
  if (!page.url().startsWith('http')) return;
  await page.evaluate(async (p) => {
    const res = await fetch('/api/batches');
    if (!res.ok) return;
    const all = (await res.json()) as Array<{ id: string; name: string }>;
    const matches = all.filter((b) => b.name && b.name.startsWith(p));
    await Promise.all(
      matches.map((b) => fetch(`/api/batches/${b.id}`, { method: 'DELETE' })),
    );
  }, prefix);
}

/**
 * Deletes any recipes created by e2e tests (name starts with the given
 * prefix). Mirrors deleteBatchesByNamePrefix. Best-effort.
 */
export async function deleteRecipesByNamePrefix(page: Page, prefix: string): Promise<void> {
  if (!page.url().startsWith('http')) return;
  await page.evaluate(async (p) => {
    const res = await fetch('/api/recipes');
    if (!res.ok) return;
    const all = (await res.json()) as Array<{ id: string; name: string }>;
    const matches = all.filter((r) => r.name && r.name.startsWith(p));
    await Promise.all(
      matches.map((r) => fetch(`/api/recipes/${r.id}`, { method: 'DELETE' })),
    );
  }, prefix);
}
