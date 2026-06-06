import { test, expect, type Page } from '@playwright/test';
import { loginAsDev } from './helpers';

// Mirrors NAV_SCREENS in public/js/state.ts. Keep this in sync when a screen is
// added there — drift previously left 'supplies' (Toppings & bread) and 'team'
// untested (audit TEST-2/TEST-7).
//
// 'team' is directorOnly: it only builds into the nav when the logged-in user
// is a director. The e2e webServer sets DIRECTOR_EMAILS=dev@local
// (playwright.config.ts) so the dev-mode user is a director and this screen is
// reachable here. 'feedback-admin' is deep-link-only in production but is part
// of the nav array, so it's included too.
const NAV_SCREENS = [
  'dashboard',
  'guests',
  'planner',
  'recipe-index',
  'orders',
  'drinks',
  'competencies',
  'supplies',
  'finance',
  'feedback-admin',
  'team',
] as const;

/**
 * Patterns the browser's network layer logs as console errors but which are
 * normal app behavior, not regressions:
 *
 * - 401 on /api/auth/me: fired by checkSession() on cold page load before
 *   the user has a session cookie. The app handles this and shows the login
 *   screen. The browser still logs the underlying 401 to the console.
 */
const IGNORED_ERROR_PATTERNS = [
  /Failed to load resource.*401.*Unauthorized/,
];

/**
 * Captures console.error messages and uncaught page errors during a test.
 * Returns a function that asserts no errors were collected — call it at the
 * end of the test to fail loudly if anything broke during navigation.
 */
function trackConsoleErrors(page: Page): () => void {
  const errors: string[] = [];
  const isIgnored = (text: string) => IGNORED_ERROR_PATTERNS.some((p) => p.test(text));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (isIgnored(text)) return;
    errors.push(`[console.error] ${text}`);
  });
  page.on('pageerror', (err) => {
    errors.push(`[pageerror] ${err.message}`);
  });
  return () => {
    if (errors.length > 0) {
      throw new Error(`Captured ${errors.length} console error(s):\n${errors.join('\n')}`);
    }
  };
}

test.describe('Navigation', () => {
  test('every nav screen renders without console errors', async ({ page }) => {
    const assertNoErrors = trackConsoleErrors(page);
    await loginAsDev(page);

    for (const screen of NAV_SCREENS) {
      await page.locator(`.nav-btn[data-screen="${screen}"]`).click();

      // Each screen container gets `.active` when shown; the others lose it.
      const container = page.locator(`#screen-${screen}`);
      await expect(container).toHaveClass(/active/);

      // Sanity check that the active container actually has content rendered
      // into it. Some screens render asynchronously after the click (e.g.
      // orders calls calcRequired() and finance fetches sync state), so we
      // give them a moment.
      await expect(container).not.toBeEmpty();
    }

    assertNoErrors();
  });

  // TEST-7: minimal smoke for the new write-flow screens. The loop above
  // already proves Supplies and Team navigate + render non-empty without
  // console errors; here we additionally assert each screen's own primary
  // control rendered, so a render that leaves a non-empty-but-broken container
  // still fails. Full interaction flows (create/prep/approve) are out of scope.
  test('Supplies screen renders its primary control', async ({ page }) => {
    const assertNoErrors = trackConsoleErrors(page);
    await loginAsDev(page);

    await page.locator('.nav-btn[data-screen="supplies"]').click();
    await expect(page.locator('#screen-supplies')).toHaveClass(/active/);
    // The "+ New item" button (data-testid="supplies-new") is the screen's core
    // affordance — its presence proves supplies.ts rendered, not just that the
    // container exists.
    await expect(page.getByTestId('supplies-new')).toBeVisible();

    assertNoErrors();
  });

  test('Team (director-only) screen renders without error', async ({ page }) => {
    const assertNoErrors = trackConsoleErrors(page);
    await loginAsDev(page);

    // Reachable only because the e2e dev user is a director (DIRECTOR_EMAILS in
    // playwright.config.ts). buildNav() builds the nav button + container.
    await page.locator('.nav-btn[data-screen="team"]').click();
    await expect(page.locator('#screen-team')).toHaveClass(/active/);
    await expect(page.locator('#screen-team')).not.toBeEmpty();

    assertNoErrors();
  });

  test('Recipe-AI (director-only) assistant opens without error', async ({ page }) => {
    const assertNoErrors = trackConsoleErrors(page);
    await loginAsDev(page);

    await page.locator('.nav-btn[data-screen="recipe-index"]').click();
    // The director-only "AI helper" entry on the recipes screen. Opening it
    // renders the recipe editor in AI mode (no Anthropic call happens until a
    // message is sent), so this is a safe render-without-error smoke.
    const aiBtn = page.getByTestId('recipe-ai-btn');
    await expect(aiBtn).toBeVisible();
    await aiBtn.click();
    // The editor modal renders into the shared modal container.
    await expect(page.locator('.modal-bg')).toBeVisible();
    await expect(page.locator('#re-name')).toBeVisible();

    assertNoErrors();
  });
});
