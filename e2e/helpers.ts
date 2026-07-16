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
  // The cooked-food inventory nag (planner.ts checkInventoryReminder) fires
  // on a clock deadline — after 13:45 / 20:15 local — once per fresh browser
  // context, and its overlay intercepts whatever the test clicks next. That
  // made any planner-touching spec fail when the suite ran in the afternoon
  // or evening (CI usually dodges it via timing + retries). Auto-dismiss it
  // whenever it appears so specs are independent of the wall clock.
  await page.addLocatorHandler(page.locator('.inv-reminder'), async () => {
    await page.locator('.inv-reminder').getByRole('button', { name: 'Later' }).click();
  });

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
  // Target the location-chooser button by testid: the top-bar switcher pill is
  // also a role=button named "Sering West", so a text match is now ambiguous.
  await page.getByTestId('loc-choose-west').click();
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

/**
 * Deletes any drinks created by e2e tests (name starts with the given prefix).
 * Mirrors deleteRecipesByNamePrefix. Best-effort cleanup.
 */
export async function deleteDrinksByNamePrefix(page: Page, prefix: string): Promise<void> {
  if (!page.url().startsWith('http')) return;
  await page.evaluate(async (p) => {
    const res = await fetch('/api/drinks?includeArchived=1');
    if (!res.ok) return;
    const all = (await res.json()) as Array<{ id: string; name: string }>;
    const matches = all.filter((d) => d.name && d.name.startsWith(p));
    await Promise.all(
      matches.map((d) => fetch(`/api/drinks/${d.id}`, { method: 'DELETE' })),
    );
  }, prefix);
}
