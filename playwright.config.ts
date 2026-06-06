import { defineConfig, devices } from '@playwright/test';

// ─────────────────────────────────────────────────────────────────────────────
// Production-DB guard (mirrors test/setup-env.ts)
// Playwright's webServer inherits this process's env, so we apply the same
// safety policy: prefer DATABASE_URL_TEST; refuse to run if DATABASE_URL
// points at a known production host.
// ─────────────────────────────────────────────────────────────────────────────
try { require('dotenv').config(); } catch (_e) { /* dotenv optional */ }

const PROD_HOST_FRAGMENTS = ['centerbeam.proxy.rlwy.net'];
const looksLikeProd = (url: string) => PROD_HOST_FRAGMENTS.some(f => url.includes(f));

const testUrl = process.env.DATABASE_URL_TEST;
const currentUrl = process.env.DATABASE_URL || '';

if (testUrl) {
  if (looksLikeProd(testUrl)) {
    console.error('[playwright] DATABASE_URL_TEST points at a production host — refusing to run.');
    process.exit(1);
  }
  process.env.DATABASE_URL = testUrl;
} else if (looksLikeProd(currentUrl)) {
  console.error(
    '[playwright] DATABASE_URL points at production and DATABASE_URL_TEST is not set.\n' +
    '  E2E tests would mutate live data via the dev-mode auth bypass.\n' +
    '  Set DATABASE_URL_TEST to a scratch database before running.',
  );
  process.exit(1);
} else if (!currentUrl) {
  console.error('[playwright] Neither DATABASE_URL nor DATABASE_URL_TEST is set.');
  process.exit(1);
}

const PORT = Number(process.env.E2E_PORT || 3000);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'npm run preview',
    url: BASE_URL,
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      DATABASE_URL: process.env.DATABASE_URL || '',
      // Force dev-mode auth (the in-app "Dev mode login" button) for tests.
      GOOGLE_CLIENT_ID: '',
      // Make the dev-mode user (dev@local) a staff-lead so the Competencies
      // admin view is reachable in e2e/competencies.spec.ts.
      STAFF_LEAD_EMAILS: 'dev@local',
      // Make the dev-mode user a director too, so the director-only screens
      // (Team / access review, and the Recipe-AI "AI helper" entry) build into
      // the nav and are reachable in e2e/navigation.spec.ts.
      DIRECTOR_EMAILS: 'dev@local',
      PORT: String(PORT),
      // The compiled server reads static files from dist/client/ when
      // NODE_ENV === 'production' (see app.ts). We're running the production
      // build via `npm run preview`, so this must match.
      NODE_ENV: 'production',
    },
  },
});
