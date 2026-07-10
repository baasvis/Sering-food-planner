/**
 * Sliding session renewal (feedback #471/#423/#369 — "I keep getting logged
 * off", cooks kicked out mid-stocktake exactly 7 days after login).
 *
 * routes/auth.ts#getSessionUser: an authenticated request on a session that
 * has burned >1 day of its 7-day TTL re-sets the cookie and extends the
 * row's expiresAt. A fresh session is left alone (max one renewal write per
 * session per day); an expired session still 401s.
 */

try { require('dotenv').config(); } catch (_e) {}
const request = require('supertest');
const app = require('../app').default;
const { prisma } = require('../lib/db');

const DAY_MS = 24 * 60 * 60 * 1000;

async function loginAndGetSessionId(): Promise<{ cookie: string[]; sessionId: string }> {
  const res = await request(app).post('/api/auth/google').send({ idToken: 'dev' });
  expect(res.status).toBe(200);
  const cookie = res.headers['set-cookie'] as unknown as string[];
  const match = cookie.join(';').match(/session=([0-9a-f]+)/);
  expect(match).toBeTruthy();
  return { cookie, sessionId: match![1] };
}

const createdSessionIds: string[] = [];

afterAll(async () => {
  if (createdSessionIds.length) {
    await prisma.session.deleteMany({ where: { id: { in: createdSessionIds } } });
  }
  await prisma.$disconnect();
});

describe('sliding session renewal', () => {
  it('renews a session that has burned >1 day of its TTL', async () => {
    const { cookie, sessionId } = await loginAndGetSessionId();
    createdSessionIds.push(sessionId);

    // Simulate a session 5 days into its 7-day life.
    const staleExpiry = new Date(Date.now() + 2 * DAY_MS);
    await prisma.session.update({ where: { id: sessionId }, data: { expiresAt: staleExpiry } });

    const res = await request(app).get('/api/auth/me').set('Cookie', cookie);
    expect(res.status).toBe(200);

    // Cookie re-set with the same session id (maxAge slides on the client).
    const setCookie = (res.headers['set-cookie'] || []) as string[];
    expect(setCookie.join(';')).toContain(`session=${sessionId}`);

    // Server-side expiry extended (the update is fire-and-forget; poll briefly).
    let row = await prisma.session.findUnique({ where: { id: sessionId } });
    for (let i = 0; i < 20 && row && row.expiresAt.getTime() <= staleExpiry.getTime(); i++) {
      await new Promise(r => setTimeout(r, 100));
      row = await prisma.session.findUnique({ where: { id: sessionId } });
    }
    expect(row).toBeTruthy();
    expect(row!.expiresAt.getTime()).toBeGreaterThan(staleExpiry.getTime());
    expect(row!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * DAY_MS);
  });

  it('leaves a fresh session alone', async () => {
    const { cookie, sessionId } = await loginAndGetSessionId();
    createdSessionIds.push(sessionId);

    const before = await prisma.session.findUnique({ where: { id: sessionId } });
    const res = await request(app).get('/api/auth/me').set('Cookie', cookie);
    expect(res.status).toBe(200);

    // No renewal: no session cookie in the response, expiresAt unchanged.
    const setCookie = (res.headers['set-cookie'] || []) as string[];
    expect(setCookie.join(';')).not.toContain('session=');
    const after = await prisma.session.findUnique({ where: { id: sessionId } });
    expect(after!.expiresAt.getTime()).toBe(before!.expiresAt.getTime());
  });

  it('still 401s an expired session (no resurrection via renewal)', async () => {
    const { cookie, sessionId } = await loginAndGetSessionId();
    createdSessionIds.push(sessionId);

    await prisma.session.update({
      where: { id: sessionId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const res = await request(app).get('/api/auth/me').set('Cookie', cookie);
    expect(res.status).toBe(401);
  });
});
