/**
 * Account-access request + director approval flow.
 *
 *   - routes/auth.ts: isEmailAllowed (env list UNION db-approved rows),
 *     recordAccessRequest (pending on first sight, no re-open of denied/revoked),
 *     POST /api/auth/request-access (self-service request).
 *   - routes/access.ts: director-gated GET /requests, GET /pending-count,
 *     POST /requests/:id/{approve,deny,revoke}.
 *
 * Dev-mode note: POST /api/auth/google short-circuits to a dev@local session
 * BEFORE the allowlist branch runs, so the env-deny path of /auth/google isn't
 * reachable via dev login. We therefore unit-test isEmailAllowed /
 * recordAccessRequest directly and exercise the HTTP surface for the admin
 * endpoints. dev@local is promoted to director (and an env allowlist entry is
 * seeded) by setting env vars BEFORE ../app loads; both are restored in afterAll
 * so the flags can't leak into other test files sharing the worker.
 */

const _origDirector = process.env.DIRECTOR_EMAILS;
const _origAllowed = process.env.ALLOWED_EMAILS;
process.env.DIRECTOR_EMAILS = 'dev@local';
process.env.ALLOWED_EMAILS = 'founder@sering.test';

try { require('dotenv').config(); } catch (_e) {}
const request = require('supertest');
const app = require('../app').default;
const { prisma } = require('../lib/db');
const { isEmailAllowed, recordAccessRequest } = require('../routes/auth');

const T = 'test-' + Date.now() + '-';

async function loginDirector(): Promise<string[]> {
  const res = await request(app).post('/api/auth/google').send({ idToken: 'dev' });
  expect(res.status).toBe(200);
  return res.headers['set-cookie'] as unknown as string[];
}

afterAll(async () => {
  // Clean up Training people auto-created by approvals (linked via personId) and
  // any explicit test people, then the access requests themselves.
  const reqs = await prisma.accessRequest.findMany({ where: { email: { startsWith: T } } });
  const personIds = reqs.map((r: { personId: string | null }) => r.personId).filter(Boolean) as string[];
  if (personIds.length) await prisma.person.deleteMany({ where: { id: { in: personIds } } });
  await prisma.person.deleteMany({ where: { id: { startsWith: T } } });
  await prisma.accessRequest.deleteMany({ where: { email: { startsWith: T } } });
  await prisma.accessRequest.deleteMany({ where: { email: 'requester@local' } });
  if (_origDirector === undefined) delete process.env.DIRECTOR_EMAILS; else process.env.DIRECTOR_EMAILS = _origDirector;
  if (_origAllowed === undefined) delete process.env.ALLOWED_EMAILS; else process.env.ALLOWED_EMAILS = _origAllowed;
  await prisma.$disconnect();
});

describe('isEmailAllowed — env list UNION db-approved', () => {
  it('true for an env-listed email (case-insensitive)', async () => {
    expect(await isEmailAllowed('founder@sering.test')).toBe(true);
    expect(await isEmailAllowed('FOUNDER@Sering.Test')).toBe(true);
  });

  it('false for an unknown email', async () => {
    expect(await isEmailAllowed(T + 'nobody@sering.test')).toBe(false);
  });

  it('tracks the db row status: approved grants, revoked removes', async () => {
    const email = T + 'union@sering.test';
    await prisma.accessRequest.create({ data: { id: T + 'union', email, name: 'Union', picture: null, status: 'approved' } });
    expect(await isEmailAllowed(email)).toBe(true);
    await prisma.accessRequest.update({ where: { email }, data: { status: 'revoked' } });
    expect(await isEmailAllowed(email)).toBe(false);
  });

  it('pending / denied rows do not grant access', async () => {
    const email = T + 'notyet@sering.test';
    await prisma.accessRequest.create({ data: { id: T + 'notyet', email, name: 'Not Yet', picture: null, status: 'pending' } });
    expect(await isEmailAllowed(email)).toBe(false);
    await prisma.accessRequest.update({ where: { email }, data: { status: 'denied' } });
    expect(await isEmailAllowed(email)).toBe(false);
  });
});

describe('recordAccessRequest', () => {
  it('creates a pending row for a brand-new email', async () => {
    const email = T + 'fresh@sering.test';
    const status = await recordAccessRequest({ email, name: 'Fresh Face', picture: null });
    expect(status).toBe('pending');
    const row = await prisma.accessRequest.findUnique({ where: { email } });
    expect(row.status).toBe('pending');
    expect(row.name).toBe('Fresh Face');
  });

  it('does not duplicate, and refreshes name/picture while still pending', async () => {
    const email = T + 'refresh@sering.test';
    await recordAccessRequest({ email, name: 'Old Name', picture: null });
    const status = await recordAccessRequest({ email, name: 'New Name', picture: 'https://x/p.png' });
    expect(status).toBe('pending');
    const rows = await prisma.accessRequest.findMany({ where: { email } });
    expect(rows.length).toBe(1);
    expect(rows[0].name).toBe('New Name');
    expect(rows[0].picture).toBe('https://x/p.png');
  });

  it('does NOT re-open a denied request (no spam-back-in)', async () => {
    const email = T + 'rejected@sering.test';
    await prisma.accessRequest.create({ data: { id: T + 'rej', email, name: 'Rejected', picture: null, status: 'denied' } });
    const status = await recordAccessRequest({ email, name: 'Trying Again', picture: null });
    expect(status).toBe('denied');
    const row = await prisma.accessRequest.findUnique({ where: { email } });
    expect(row.status).toBe('denied');
    expect(row.name).toBe('Rejected'); // not refreshed for a terminal row
  });
});

describe('GET /api/access/requests (director-gated)', () => {
  it('403 without a director session', async () => {
    const res = await request(app).get('/api/access/requests');
    expect(res.status).toBe(403);
  });

  it('200 for a director; returns requests array + read-only envEmails', async () => {
    const cookie = await loginDirector();
    const res = await request(app).get('/api/access/requests').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.requests)).toBe(true);
    expect(res.body.envEmails).toContain('founder@sering.test');
  });

  it('pending-count returns a number for a director', async () => {
    const cookie = await loginDirector();
    const res = await request(app).get('/api/access/pending-count').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(typeof res.body.count).toBe('number');
  });
});

describe('approve / deny / revoke', () => {
  it('approve flips status and grants access', async () => {
    const email = T + 'approveme@sering.test';
    const row = await prisma.accessRequest.create({ data: { id: T + 'app', email, name: 'Approve Me', picture: null, status: 'pending' } });
    expect(await isEmailAllowed(email)).toBe(false);

    const cookie = await loginDirector();
    const res = await request(app).post(`/api/access/requests/${row.id}/approve`).set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.request.status).toBe('approved');
    expect(res.body.request.decidedBy).toBe('dev@local');
    expect(await isEmailAllowed(email)).toBe(true);
  });

  it('revoke removes a previously-approved user', async () => {
    const email = T + 'revokeme@sering.test';
    const row = await prisma.accessRequest.create({ data: { id: T + 'rev', email, name: 'Revoke Me', picture: null, status: 'approved' } });
    expect(await isEmailAllowed(email)).toBe(true);

    const cookie = await loginDirector();
    const res = await request(app).post(`/api/access/requests/${row.id}/revoke`).set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.request.status).toBe('revoked');
    expect(await isEmailAllowed(email)).toBe(false);
  });

  it('deny keeps access closed', async () => {
    const email = T + 'denyme@sering.test';
    const row = await prisma.accessRequest.create({ data: { id: T + 'den', email, name: 'Deny Me', picture: null, status: 'pending' } });

    const cookie = await loginDirector();
    const res = await request(app).post(`/api/access/requests/${row.id}/deny`).set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.request.status).toBe('denied');
    expect(await isEmailAllowed(email)).toBe(false);
  });

  it('404 for an unknown request id', async () => {
    const cookie = await loginDirector();
    const res = await request(app).post('/api/access/requests/does-not-exist/approve').set('Cookie', cookie);
    expect(res.status).toBe(404);
  });

  it('403 without a director session', async () => {
    const res = await request(app).post('/api/access/requests/whatever/approve');
    expect(res.status).toBe(403);
  });
});

describe('POST /api/auth/request-access (self-service, dev path)', () => {
  it('records a pending request with the supplied first/last name', async () => {
    // Clean slate: requester@local is a fixed dev-path email that may carry an
    // approved/denied status from a prior preview/run on the shared staging DB.
    await prisma.accessRequest.deleteMany({ where: { email: 'requester@local' } });
    const res = await request(app).post('/api/auth/request-access').send({ idToken: 'dev', firstName: 'Sven', lastName: 'Bakker' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending');
    expect(res.body.message).toMatch(/access request/i);
    const row = await prisma.accessRequest.findUnique({ where: { email: 'requester@local' } });
    expect(row).not.toBeNull();
    expect(row.firstName).toBe('Sven');
    expect(row.lastName).toBe('Bakker');
    expect(row.name).toBe('Sven Bakker');
  });

  it('400 without an idToken', async () => {
    const res = await request(app).post('/api/auth/request-access').send({ firstName: 'A', lastName: 'B' });
    expect(res.status).toBe(400);
  });

  it('400 when first/last name is missing', async () => {
    const res = await request(app).post('/api/auth/request-access').send({ idToken: 'dev' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('name_required');
  });
});

describe('rename + Training-person link', () => {
  it('PATCH /requests/:id updates first/last name and display name', async () => {
    const email = T + 'rename@sering.test';
    const row = await prisma.accessRequest.create({ data: { id: T + 'rn', email, name: 'Old Name', firstName: 'Old', lastName: 'Name', picture: null, status: 'pending' } });
    const cookie = await loginDirector();
    const res = await request(app).patch(`/api/access/requests/${row.id}`).set('Cookie', cookie).send({ firstName: 'New', lastName: 'Naam' });
    expect(res.status).toBe(200);
    expect(res.body.request.firstName).toBe('New');
    expect(res.body.request.name).toBe('New Naam');
  });

  it('PATCH rejects a missing last name', async () => {
    const email = T + 'rename2@sering.test';
    const row = await prisma.accessRequest.create({ data: { id: T + 'rn2', email, name: 'X Y', firstName: 'X', lastName: 'Y', picture: null, status: 'pending' } });
    const cookie = await loginDirector();
    const res = await request(app).patch(`/api/access/requests/${row.id}`).set('Cookie', cookie).send({ firstName: 'OnlyFirst' });
    expect(res.status).toBe(400);
  });

  it('approve creates + links a Training person, and rename keeps it in sync', async () => {
    const email = T + 'trainee@sering.test';
    const row = await prisma.accessRequest.create({ data: { id: T + 'tr', email, name: 'Trainee Person', firstName: 'Trainee', lastName: 'Person', picture: null, status: 'pending' } });
    const cookie = await loginDirector();

    const appr = await request(app).post(`/api/access/requests/${row.id}/approve`).set('Cookie', cookie);
    expect(appr.status).toBe(200);
    const personId = appr.body.request.personId;
    expect(personId).toBeTruthy();
    const person = await prisma.person.findUnique({ where: { id: personId } });
    expect(person.name).toBe('Trainee Person');

    const ren = await request(app).patch(`/api/access/requests/${row.id}`).set('Cookie', cookie).send({ firstName: 'Trainee', lastName: 'Renamed' });
    expect(ren.status).toBe(200);
    const synced = await prisma.person.findUnique({ where: { id: personId } });
    expect(synced.name).toBe('Trainee Renamed');
  });

  it('approving dedups onto an existing person with the same name', async () => {
    const existing = await prisma.person.create({ data: { id: T + 'pexist', name: 'Dedup Match', location: 'centraal' } });
    const email = T + 'dedup@sering.test';
    const row = await prisma.accessRequest.create({ data: { id: T + 'dd', email, name: 'Dedup Match', firstName: 'Dedup', lastName: 'Match', picture: null, status: 'pending' } });
    const cookie = await loginDirector();
    const appr = await request(app).post(`/api/access/requests/${row.id}/approve`).set('Cookie', cookie);
    expect(appr.status).toBe(200);
    expect(appr.body.request.personId).toBe(existing.id);
  });

  it('re-approving a revoked user restores access (Approve anyway)', async () => {
    const email = T + 'reapprove@sering.test';
    const row = await prisma.accessRequest.create({ data: { id: T + 're', email, name: 'Re Approve', firstName: 'Re', lastName: 'Approve', picture: null, status: 'revoked' } });
    expect(await isEmailAllowed(email)).toBe(false);
    const cookie = await loginDirector();
    const res = await request(app).post(`/api/access/requests/${row.id}/approve`).set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.request.status).toBe('approved');
    expect(res.body.request.personId).toBeTruthy();
    expect(await isEmailAllowed(email)).toBe(true);
  });
});
