import { test, expect, type Page } from '@playwright/test';
import { loginAsDev } from './helpers';

// Mirrors NAV_SCREENS in public/js/state.ts. The 'feedback-admin' screen is
// only accessible via deep-link in production but is part of the nav array,
// so it's included here.
const NAV_SCREENS = [
  'dashboard',
  'guests',
  'planner',
  'recipe-index',
  'orders',
  'finance',
  'feedback-admin',
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
});
