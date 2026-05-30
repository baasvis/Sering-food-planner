import { test, expect } from '@playwright/test';

test.describe('Smoke', () => {
  test('dev login → location chooser → app shell', async ({ page }) => {
    await page.goto('/');

    // Login screen is the initial view.
    await expect(page.locator('#login-screen')).toBeVisible();

    // The dev-mode login button only renders when GOOGLE_CLIENT_ID is unset
    // (configured via playwright.config.ts webServer env).
    const devLoginBtn = page.locator('#dev-login-btn');
    await expect(devLoginBtn).toBeVisible();
    await devLoginBtn.click();

    // After login the login screen is hidden via inline style="display:none".
    await expect(page.locator('#login-screen')).toBeHidden();

    // Fresh browser context has no saved location, so the chooser appears.
    const chooser = page.locator('.location-chooser');
    await expect(chooser).toBeVisible();
    await page.getByTestId('loc-choose-west').click();

    // After selecting a location, buildNav() runs and populates the top bar
    // with a Dashboard nav button — proves the logged-in shell is rendering.
    await expect(page.locator('.nav-btn[data-screen="dashboard"]')).toBeVisible();
    await expect(page.locator('#bottom-nav')).toHaveClass(/active/);
  });
});
