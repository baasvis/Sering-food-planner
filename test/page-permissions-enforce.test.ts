/**
 * Server-side enforcement of role page-permissions — the "make view-only a real
 * lock" half. requireScreenEdit (auth.ts) gates the sensitive write-paths
 * (Finance sync, ingredient writes incl. supplier upload).
 *
 * This unit-tests the middleware directly with UNIQUE test emails rather than
 * over HTTP. The only dev-login identity is the shared `dev@local`, and the full
 * suite runs files in parallel against one staging DB — giving dev@local a
 * restrictive role would make other suites' writes (e.g. api.test.ts ingredient
 * tests) 403 mid-run. api.test.ts already proves the gate doesn't block a
 * full-access user; here we prove it blocks a view-only one.
 */

const _origDirector = process.env.DIRECTOR_EMAILS;
process.env.DIRECTOR_EMAILS = 'director-perm@sering.test';

try { require('dotenv').config(); } catch (_e) {}
const { prisma } = require('../lib/db');
const { requireScreenEdit, resolvePermissions } = require('../routes/auth');

const T = 'test-perm-' + Date.now() + '-';
const ROLE_ID = T + 'role';
const VIEW_EMAIL = T + 'viewer@sering.test';
const NOROLE_EMAIL = T + 'norole@sering.test';

const matrix = {
  dashboard: 'edit', guests: 'edit', planner: 'edit', 'recipe-index': 'edit', orders: 'view',
  competencies: 'edit', supplies: 'edit', finance: 'view', 'feedback-admin': 'edit',
};

beforeAll(async () => {
  await prisma.role.create({ data: { id: ROLE_ID, name: T + 'View', permissions: matrix, isDefault: false } });
  await prisma.accessRequest.create({ data: { id: T + 'v', email: VIEW_EMAIL, name: 'Viewer', status: 'approved', roleId: ROLE_ID } });
  await prisma.accessRequest.create({ data: { id: T + 'n', email: NOROLE_EMAIL, name: 'No Role', status: 'approved', roleId: null } });
});

afterAll(async () => {
  await prisma.accessRequest.deleteMany({ where: { email: { startsWith: T } } });
  await prisma.role.deleteMany({ where: { id: { startsWith: T } } });
  if (_origDirector === undefined) delete process.env.DIRECTOR_EMAILS; else process.env.DIRECTOR_EMAILS = _origDirector;
  await prisma.$disconnect();
});

// Invoke the middleware with a mock req/res/next; resolve with the outcome
// status (200 = passed via next(), otherwise the res.status() code).
function run(screenId: string, email: string | undefined): Promise<{ status: number }> {
  const mw = requireScreenEdit(screenId);
  return new Promise((resolve) => {
    let done = false;
    const finish = (status: number) => { if (!done) { done = true; resolve({ status }); } };
    const res = { status: (code: number) => ({ json: () => finish(code) }) };
    mw({ user: email ? { email } : undefined } as never, res as never, (() => finish(200)) as never);
  });
}

describe('requireScreenEdit — server-side view-only lock', () => {
  it('blocks a view-only-orders user (403)', async () => {
    expect((await run('orders', VIEW_EMAIL)).status).toBe(403);
  });
  it('blocks a view-only-finance user (403)', async () => {
    expect((await run('finance', VIEW_EMAIL)).status).toBe(403);
  });
  it('allows a screen the same user has edit on (planner)', async () => {
    expect((await run('planner', VIEW_EMAIL)).status).toBe(200);
  });
  it('allows a user with no role (full edit, legacy)', async () => {
    expect((await run('orders', NOROLE_EMAIL)).status).toBe(200);
  });
  it('allows a director regardless of role', async () => {
    expect((await run('orders', 'director-perm@sering.test')).status).toBe(200);
  });
  it('passes through when there is no user (dev-mode anonymous; prod requireAuth 401s earlier)', async () => {
    expect((await run('orders', undefined)).status).toBe(200);
  });
  it('resolvePermissions: role matrix for a role, {} for no role', async () => {
    expect((await resolvePermissions(VIEW_EMAIL)).orders).toBe('view');
    expect(await resolvePermissions(NOROLE_EMAIL)).toEqual({});
  });
});
