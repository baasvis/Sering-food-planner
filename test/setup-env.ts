/**
 * Jest setupFiles entry — runs in each worker BEFORE test modules import
 * `../app` or `../lib/db`, so it has a chance to rewrite DATABASE_URL before
 * Prisma sees it.
 *
 * Policy:
 *   1. If DATABASE_URL_TEST is set, use it (regardless of what DATABASE_URL
 *      currently points to). This is the normal, safe path — point it at a
 *      local Postgres or a throwaway staging DB.
 *   2. Otherwise, refuse to run if DATABASE_URL looks like production. The
 *      planner is live in a community kitchen; a stray `npm test` against
 *      prod would delete real records via the afterAll cleanup block.
 *   3. Otherwise (DATABASE_URL set and not prod-like), allow it — covers the
 *      local-dev case where the developer is already on a scratch DB.
 */
try { require('dotenv').config(); } catch (_e) {}

// Any of these host fragments means "you're talking to prod — refuse":
const PROD_HOST_FRAGMENTS = [
  'centerbeam.proxy.rlwy.net',
];

const testUrl = process.env.DATABASE_URL_TEST;
const currentUrl = process.env.DATABASE_URL || '';

function looksLikeProd(url: string): boolean {
  return PROD_HOST_FRAGMENTS.some(frag => url.includes(frag));
}

if (testUrl) {
  if (looksLikeProd(testUrl)) {
    // eslint-disable-next-line no-console
    console.error(
      '[test/setup-env] DATABASE_URL_TEST points at a production host — refusing to run tests.',
    );
    process.exit(1);
  }
  process.env.DATABASE_URL = testUrl;
} else if (looksLikeProd(currentUrl)) {
  // eslint-disable-next-line no-console
  console.error(
    '[test/setup-env] DATABASE_URL points at production and DATABASE_URL_TEST is not set.\n' +
      '  Tests would mutate live data via the afterAll cleanup.\n' +
      '  Set DATABASE_URL_TEST to a scratch database before running `npm test`.',
  );
  process.exit(1);
} else if (!currentUrl) {
  // eslint-disable-next-line no-console
  console.error(
    '[test/setup-env] Neither DATABASE_URL nor DATABASE_URL_TEST is set — cannot run tests.',
  );
  process.exit(1);
}
