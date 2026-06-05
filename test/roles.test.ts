/**
 * Role-based page permissions.
 *   - routes/access.ts: GET/POST/PATCH/DELETE /api/access/roles (director-gated),
 *     PATCH /api/access/requests/:id/role, and approve assigning the default role.
 *   - routes/auth.ts: resolvePermissions(email) — role's map, or {} for no role.
 *
 * dev@local is promoted to director by setting DIRECTOR_EMAILS before ../app
 * loads (restored in afterAll). Tests run against the shared staging DB, so they
 * use test- prefixed names and restore the global default role they touch.
 */

const _origDirector = process.env.DIRECTOR_EMAILS;
process.env.DIRECTOR_EMAILS = 'dev@local';

try { require('dotenv').config(); } catch (_e) {}
const request = require('supertest');
const app = require('../app').default;
const { prisma } = require('../lib/db');
const { resolvePermissions } = require('../routes/auth');

const T = 'test-roles-' + Date.now() + '-';

async function loginDirector(): Promise<string[]> {
  const res = await request(app).post('/api/auth/google').send({ idToken: 'dev' });
  expect(res.status).toBe(200);
  return res.headers['set-cookie'] as unknown as string[];
}

afterAll(async () => {
  await prisma.accessRequest.deleteMany({ where: { email: { startsWith: T } } });
  await prisma.role.deleteMany({ where: { name: { startsWith: T } } });
  if (_origDirector === undefined) delete process.env.DIRECTOR_EMAILS; else process.env.DIRECTOR_EMAILS = _origDirector;
  await prisma.$disconnect();
});

describe('GET /api/access/roles', () => {
  it('403 without a director session', async () => {
    const res = await request(app).get('/api/access/roles');
    expect(res.status).toBe(403);
  });

  it('seeds defaults, marks one default, and excludes team from gateable screens', async () => {
    const cookie = await loginDirector();
    const res = await request(app).get('/api/access/roles').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.roles.length).toBeGreaterThanOrEqual(3);
    expect(res.body.roles.filter((r: { isDefault: boolean }) => r.isDefault).length).toBe(1);
    expect(res.body.screens).toContain('finance');
    expect(res.body.screens).not.toContain('team');
  });
});

describe('role create / update / default / delete', () => {
  it('creates a role with a complete, normalized matrix (default view)', async () => {
    const cookie = await loginDirector();
    const res = await request(app).post('/api/access/roles').set('Cookie', cookie).send({ name: T + 'Cook' });
    expect(res.status).toBe(200);
    const role = res.body.role;
    expect(role.permissions.finance).toBe('view');
    expect(role.permissions.planner).toBe('view');
    expect(Object.keys(role.permissions)).not.toContain('team');
  });

  it('400 without a name', async () => {
    const cookie = await loginDirector();
    const res = await request(app).post('/api/access/roles').set('Cookie', cookie).send({});
    expect(res.status).toBe(400);
  });

  it('PATCH updates individual screen levels', async () => {
    const cookie = await loginDirector();
    const created = await request(app).post('/api/access/roles').set('Cookie', cookie).send({ name: T + 'Matrix' });
    const id = created.body.role.id;
    const res = await request(app).patch(`/api/access/roles/${id}`).set('Cookie', cookie)
      .send({ permissions: { ...created.body.role.permissions, finance: 'hidden', planner: 'edit' } });
    expect(res.status).toBe(200);
    expect(res.body.role.permissions.finance).toBe('hidden');
    expect(res.body.role.permissions.planner).toBe('edit');
  });

  it('setting a role default leaves exactly one default (restored after)', async () => {
    const cookie = await loginDirector();
    const before = await request(app).get('/api/access/roles').set('Cookie', cookie);
    const origDefault = before.body.roles.find((r: { isDefault: boolean }) => r.isDefault)?.id;
    const created = await request(app).post('/api/access/roles').set('Cookie', cookie).send({ name: T + 'Default' });
    const id = created.body.role.id;
    const res = await request(app).patch(`/api/access/roles/${id}`).set('Cookie', cookie).send({ isDefault: true });
    expect(res.body.role.isDefault).toBe(true);
    const after = await request(app).get('/api/access/roles').set('Cookie', cookie);
    expect(after.body.roles.filter((r: { isDefault: boolean }) => r.isDefault).length).toBe(1);
    // restore the original default so we don't leave staging without one
    if (origDefault) await request(app).patch(`/api/access/roles/${origDefault}`).set('Cookie', cookie).send({ isDefault: true });
  });

  it('refuses to delete a role still in use (409), allows it once free', async () => {
    const cookie = await loginDirector();
    const created = await request(app).post('/api/access/roles').set('Cookie', cookie).send({ name: T + 'InUse' });
    const roleId = created.body.role.id;
    const email = T + 'member@sering.test';
    const reqRow = await prisma.accessRequest.create({ data: { id: T + 'mem', email, name: 'Member', firstName: 'Mem', lastName: 'Ber', picture: null, status: 'approved', roleId } });

    const blocked = await request(app).delete(`/api/access/roles/${roleId}`).set('Cookie', cookie);
    expect(blocked.status).toBe(409);

    await request(app).patch(`/api/access/requests/${reqRow.id}/role`).set('Cookie', cookie).send({ roleId: null });
    const ok = await request(app).delete(`/api/access/roles/${roleId}`).set('Cookie', cookie);
    expect(ok.status).toBe(200);
  });
});

describe('user role assignment + resolvePermissions', () => {
  it('assigning a role drives resolvePermissions; clearing it returns {}', async () => {
    const cookie = await loginDirector();
    const created = await request(app).post('/api/access/roles').set('Cookie', cookie).send({ name: T + 'Resolve' });
    const roleId = created.body.role.id;
    await request(app).patch(`/api/access/roles/${roleId}`).set('Cookie', cookie)
      .send({ permissions: { ...created.body.role.permissions, finance: 'hidden', orders: 'edit' } });

    const email = T + 'resolve@sering.test';
    const reqRow = await prisma.accessRequest.create({ data: { id: T + 'res', email, name: 'Res', firstName: 'Re', lastName: 'Solve', picture: null, status: 'approved' } });

    expect(await resolvePermissions(email)).toEqual({}); // no role yet

    await request(app).patch(`/api/access/requests/${reqRow.id}/role`).set('Cookie', cookie).send({ roleId });
    const perms = await resolvePermissions(email);
    expect(perms.finance).toBe('hidden');
    expect(perms.orders).toBe('edit');

    await request(app).patch(`/api/access/requests/${reqRow.id}/role`).set('Cookie', cookie).send({ roleId: null });
    expect(await resolvePermissions(email)).toEqual({});
  });

  it('approving a request assigns the default role', async () => {
    const cookie = await loginDirector();
    // ensure roles are seeded and grab the current default id
    const rolesRes = await request(app).get('/api/access/roles').set('Cookie', cookie);
    const defaultId = rolesRes.body.roles.find((r: { isDefault: boolean }) => r.isDefault)?.id;
    expect(defaultId).toBeTruthy();

    const email = T + 'approve@sering.test';
    const reqRow = await prisma.accessRequest.create({ data: { id: T + 'app', email, name: 'App Rover', firstName: 'App', lastName: 'Rover', picture: null, status: 'pending' } });
    const res = await request(app).post(`/api/access/requests/${reqRow.id}/approve`).set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.request.roleId).toBe(defaultId);

    // clean up the auto-created Training person
    const after = await prisma.accessRequest.findUnique({ where: { id: reqRow.id } });
    if (after?.personId) await prisma.person.deleteMany({ where: { id: after.personId } });
  });

  it('approve honors an explicitly chosen role', async () => {
    const cookie = await loginDirector();
    const rolesRes = await request(app).get('/api/access/roles').set('Cookie', cookie);
    const chosen = rolesRes.body.roles.find((r: { isDefault: boolean }) => !r.isDefault) || rolesRes.body.roles[0];
    const email = T + 'approverole@sering.test';
    const reqRow = await prisma.accessRequest.create({ data: { id: T + 'apr', email, name: 'Approve Role', firstName: 'Ap', lastName: 'Role', picture: null, status: 'pending' } });
    const res = await request(app).post(`/api/access/requests/${reqRow.id}/approve`).set('Cookie', cookie).send({ roleId: chosen.id });
    expect(res.status).toBe(200);
    expect(res.body.request.roleId).toBe(chosen.id);
    const after = await prisma.accessRequest.findUnique({ where: { id: reqRow.id } });
    if (after?.personId) await prisma.person.deleteMany({ where: { id: after.personId } });
  });
});
