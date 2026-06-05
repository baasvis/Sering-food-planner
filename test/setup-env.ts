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

// Pin TZ so date-arithmetic tests (e.g. transport-card's getReadiness
// "yesterday completion was 8pm UTC, today is 8am UTC") don't flake when
// a contributor runs the suite in a non-UTC zone. CI is typically UTC but
// local boxes vary. Set BEFORE the first `new Date()` is constructed by
// any imported module.
process.env.TZ = 'UTC';

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

// Cap the Prisma connection pool for tests. Jest runs many workers in parallel
// (≈ CPUs−1), each with its own Prisma client whose default pool is ~2*CPUs+1 —
// on a high-core machine that's hundreds of connections and a lot of concurrent
// query pressure against the shared test DB, which makes the suite flake. A
// small per-worker cap keeps total connections and load modest. Append only if
// the URL doesn't already specify one (so a developer can still override).
if (process.env.DATABASE_URL && !/[?&]connection_limit=/.test(process.env.DATABASE_URL)) {
  const u = process.env.DATABASE_URL;
  process.env.DATABASE_URL = u + (u.includes('?') ? '&' : '?') + 'connection_limit=8&pool_timeout=30';
}
