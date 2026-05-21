/**
 * MAINTENANCE_MODE middleware (app.ts:117-145).
 *
 * When the env var is set, all write methods on /api/* return a 503 with the
 * shape { error: 'maintenance', message: '...' }. Reads, SSE, /api/auth, and
 * /api/telemetry stay open — the first three so cooks see current state and
 * Railway healthchecks pass, the last so the frontend can keep emitting
 * telemetry while the upgrade banner is up.
 *
 * Procedure (mirrors prisma/migrations/DEPLOY.md):
 *   1. Daan sets MAINTENANCE_MODE=1 in Railway env, triggers redeploy.
 *   2. Cooks see "save failed: maintenance" toast on any save.
 *   3. Daan runs the schema + data migrations.
 *   4. Daan unsets MAINTENANCE_MODE, redeploy clears the flag.
 *   5. Frontend's scheduleSave() retries (with backoff) drain naturally.
 */

try { require('dotenv').config(); } catch (_e) {}
const request = require('supertest');
const app = require('../app').default;
const { prisma } = require('../lib/db');

afterAll(async () => {
  await prisma.$disconnect();
});

describe('MAINTENANCE_MODE middleware', () => {
  // env restoration is done per-test below so a failure can't leak the flag
  // into subsequent test files.
  let originalFlag: string | undefined;
  beforeAll(() => { originalFlag = process.env.MAINTENANCE_MODE; });
  afterAll(() => {
    if (originalFlag === undefined) delete process.env.MAINTENANCE_MODE;
    else process.env.MAINTENANCE_MODE = originalFlag;
  });

  describe('with MAINTENANCE_MODE=1', () => {
    beforeEach(() => { process.env.MAINTENANCE_MODE = '1'; });
    afterEach(() => { delete process.env.MAINTENANCE_MODE; });

    it('GET /api/data still works (read-only is allowed)', async () => {
      // Login first since /api/data is auth-gated.
      const login = await request(app).post('/api/auth/google').send({ idToken: 'dev' });
      expect(login.status).toBe(200);
      const cookie = login.headers['set-cookie'];

      const res = await request(app).get('/api/data').set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.batches)).toBe(true);
    });

    it('POST /api/data/patch returns 503 with the maintenance payload', async () => {
      const login = await request(app).post('/api/auth/google').send({ idToken: 'dev' });
      const cookie = login.headers['set-cookie'];

      const res = await request(app)
        .post('/api/data/patch')
        .set('Cookie', cookie)
        .send({ batches: [] });
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('maintenance');
      expect(res.body.message).toMatch(/upgrading/i);
    });

    it('PATCH /api/batches/:id returns 503', async () => {
      const login = await request(app).post('/api/auth/google').send({ idToken: 'dev' });
      const cookie = login.headers['set-cookie'];

      const res = await request(app)
        .patch('/api/batches/nonexistent')
        .set('Cookie', cookie)
        .send({ name: 'should not be reached' });
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('maintenance');
    });

    it('DELETE /api/batches/:id returns 503', async () => {
      const login = await request(app).post('/api/auth/google').send({ idToken: 'dev' });
      const cookie = login.headers['set-cookie'];

      const res = await request(app).delete('/api/batches/nonexistent').set('Cookie', cookie);
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('maintenance');
    });

    it('GET /api/health still works (Railway healthcheck must pass)', async () => {
      const res = await request(app).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });

    it('POST /api/auth/google still works (mounted before the maintenance gate)', async () => {
      // Login must keep working so the cook running the smoke-test in the
      // deploy window can still sign in.
      const res = await request(app).post('/api/auth/google').send({ idToken: 'dev' });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it('POST /api/telemetry still works (mounted before the maintenance gate)', async () => {
      // The frontend keeps emitting telemetry while the banner is up — we
      // want visibility into the deploy window itself.
      const res = await request(app)
        .post('/api/telemetry')
        .send([{ source: 'frontend', type: 'feature_use', name: 'maintenance_banner_seen' }]);
      expect(res.status).toBe(200);
    });

    it.each(['true', 'yes', 'on'])('treats MAINTENANCE_MODE=%s as on', async (val) => {
      process.env.MAINTENANCE_MODE = val;
      const login = await request(app).post('/api/auth/google').send({ idToken: 'dev' });
      const cookie = login.headers['set-cookie'];
      const res = await request(app).post('/api/data/patch').set('Cookie', cookie).send({});
      expect(res.status).toBe(503);
    });
  });

  describe('with MAINTENANCE_MODE unset / "0" / "false"', () => {
    it.each([undefined, '0', 'false', ''])('lets writes through (flag = %s)', async (val) => {
      if (val === undefined) delete process.env.MAINTENANCE_MODE;
      else process.env.MAINTENANCE_MODE = val;

      const login = await request(app).post('/api/auth/google').send({ idToken: 'dev' });
      const cookie = login.headers['set-cookie'];

      const res = await request(app)
        .post('/api/data/patch')
        .set('Cookie', cookie)
        .send({}); // empty patch — endpoint accepts this as a no-op
      // Whatever the success/failure is, it must NOT be 503/maintenance.
      expect(res.status).not.toBe(503);
      if (res.body && res.body.error) {
        expect(res.body.error).not.toBe('maintenance');
      }
    });
  });
});
